import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Repo } from './repo';
import type {
  Appeal, AppealDetail, AuditLog, Employee, Evaluation, ImportBatch, ImportRejection, Me, NotificationRow,
  Parameter, Period, PortalSettings, ScoreAdjustment, ScoreRow, TaskType, Team,
} from '../lib/types';
import { DEFAULT_SETTINGS } from '../../supabase/functions/_shared/rubric';

const PAGE = 1000;
const CHUNK = 150; // ids per IN() filter keeps URLs short

function unwrap<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data as T;
}

async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const rows = unwrap(await build(from, from + PAGE - 1));
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

/** Runs async jobs with at most `n` in flight (keeps the browser and the database comfortable). */
async function pool<T>(jobs: (() => Promise<T>)[], n = 6): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, async () => {
    while (next < jobs.length) { const i = next++; out[i] = await jobs[i](); }
  }));
  return out;
}

const chunks = <T,>(arr: T[], n: number) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

/** Edge Functions answer errors as JSON { error }; supabase-js only says "non-2xx status code". Show the real reason. */
async function fnErrorMessage(error: { message: string; context?: unknown }): Promise<string> {
  const res = error.context as Response | undefined;
  try {
    if (res && typeof res.json === 'function') {
      const body = await res.clone().json() as { error?: string };
      if (body?.error) return body.error;
    }
  } catch { /* not JSON */ }
  return error.message;
}

export class SupabaseRepo implements Repo {
  readonly mode = 'supabase' as const;
  private sb: SupabaseClient;

  constructor(url: string, anonKey: string) {
    // Only the public anon key is used in the browser. Every row is protected by RLS.
    this.sb = createClient(url, anonKey, { auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
  }

  // ---------------------------------------------------------------- auth
  async currentUser(): Promise<Me | null> {
    const { data } = await this.sb.auth.getUser();
    if (!data.user) return null;
    const emp = unwrap(await this.sb.from('employees').select('*').eq('auth_user_id', data.user.id).maybeSingle()) as Employee | null;
    if (!emp || emp.status !== 'active') return null;
    let team_name: string | null = null;
    let lead_name: string | null = null;
    if (emp.team_id) {
      const t = unwrap(await this.sb.from('teams').select('name, lead_id').eq('id', emp.team_id).maybeSingle()) as { name: string; lead_id: string | null } | null;
      team_name = t?.name ?? null;
      if (t?.lead_id) {
        const l = unwrap(await this.sb.from('employees').select('full_name').eq('id', t.lead_id).maybeSingle()) as { full_name: string } | null;
        lead_name = l?.full_name ?? null;
      }
    }
    if (!team_name && emp.role !== 'user') {
      // Team Leads are linked through teams.lead_id rather than their own team_id.
      const led = unwrap(await this.sb.from('teams').select('name').eq('lead_id', emp.id)) as { name: string }[];
      team_name = led.map((t) => t.name).join(', ') || null;
    }
    return { ...emp, team_name, lead_name, must_change_password: data.user.user_metadata?.must_change_password === true };
  }
  async signIn(email: string, password: string): Promise<Me> { this.invalidate();
    const { error } = await this.sb.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
    if (error) throw new Error(error.message === 'Invalid login credentials' ? 'Incorrect email or password.' : error.message);
    const me = await this.currentUser();
    if (!me) {
      await this.sb.auth.signOut();
      throw new Error('Your login is not linked to an active portal account. Please contact the QA team.');
    }
    return me;
  }
  async signOut() { this.invalidate(); await this.sb.auth.signOut(); }
  async requestPasswordReset(email: string) {
    // Server decides how the email is sent (from the QA owner's Gmail via the sheet script, or Supabase).
    const redirect_to = `${window.location.origin}${window.location.pathname}`;
    const { data, error } = await this.sb.functions.invoke('password-reset', { body: { email: email.trim().toLowerCase(), redirect_to } });
    if (error) throw new Error(await fnErrorMessage(error));
    if (data?.error) throw new Error(data.error);
  }
  async verifyEmailLink(tokenHash: string, type: 'invite' | 'recovery') {
    const { error } = await this.sb.auth.verifyOtp({ token_hash: tokenHash, type });
    if (error) throw new Error(/expired|invalid/i.test(error.message) ? 'This link has expired or was already used. Ask the QA team for a new one, or use “Forgot password?”.' : error.message);
  }
  async updatePassword(password: string) {
    const { error } = await this.sb.auth.updateUser({ password, data: { must_change_password: false } });
    if (error) throw new Error(error.message);
  }
  onAuthEvent(cb: (e: 'SIGNED_IN' | 'SIGNED_OUT' | 'PASSWORD_RECOVERY') => void) {
    const { data } = this.sb.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'PASSWORD_RECOVERY') cb(event);
    });
    return () => data.subscription.unsubscribe();
  }

  // ---------------------------------------------------------------- reference
  async getSettings(): Promise<PortalSettings> {
    const rows = unwrap(await this.sb.from('settings').select('key, value')) as { key: string; value: unknown }[];
    const s = structuredClone(DEFAULT_SETTINGS) as unknown as Record<string, unknown>;
    for (const r of rows) s[r.key] = { ...(s[r.key] as object), ...(r.value as object) };
    return s as unknown as PortalSettings;
  }
  async getTaskTypes() { return unwrap(await this.sb.from('task_types').select('*').order('sort_order')) as TaskType[]; }
  async getParameters() {
    const rows = unwrap(await this.sb.from('evaluation_parameters').select('*').order('task_type').order('sort_order')) as Parameter[];
    return rows.map((p) => ({ ...p, max_score: Number(p.max_score) }));
  }
  async getPeriods() { return fetchAll<Period>((a, b) => this.sb.from('reporting_periods').select('*').order('start_date').range(a, b)); }
  async getTeams() { return unwrap(await this.sb.from('teams').select('id, name, lead_id').order('name')) as Team[]; }
  async getEmployees() { return fetchAll<Employee>((a, b) => this.sb.from('employees').select('*').order('full_name').range(a, b)); }

  // ---------------------------------------------------------------- evaluations
  private async attachScores(evals: Omit<Evaluation, 'scores'>[]): Promise<Evaluation[]> {
    const byEval = new Map<string, ScoreRow[]>();
    const parts = await pool(chunks(evals.map((e) => e.id), CHUNK).map((ids) => () =>
      fetchAll<ScoreRow>((a, b) => this.sb.from('v_evaluation_scores_effective').select('*').in('evaluation_id', ids).range(a, b))));
    for (const rows of parts) {
      for (const r of rows) {
        const x = { ...r, max_score: Number(r.max_score), earned: r.earned === null ? null : Number(r.earned), original_earned: r.original_earned === null ? null : Number(r.original_earned) };
        byEval.set(r.evaluation_id, [...(byEval.get(r.evaluation_id) ?? []), x]);
      }
    }
    return evals.map((e) => ({
      ...e, score: Number(e.score), original_score: Number(e.original_score),
      scores: (byEval.get(e.id) ?? []).sort((a, b) => a.sort_order - b.sort_order),
    }));
  }
  // Weeks already loaded are kept for a few minutes, so switching weeks only fetches what is new.
  // Any change made through the portal clears the cache (see invalidate()).
  private evalCache = new Map<string, { at: number; rows: Evaluation[] }>();
  private invalidate() { this.evalCache.clear(); }
  async getEvaluations(filter: { periodIds?: string[]; camIds?: string[] }) {
    if (!filter.periodIds) return this.loadEvaluations(filter);
    const camKey = filter.camIds ? [...filter.camIds].sort().join(',') : '*';
    const fresh = Date.now() - 5 * 60_000;
    const out: Evaluation[] = []; const missing: string[] = [];
    for (const pid of filter.periodIds) {
      const c = this.evalCache.get(`${pid}|${camKey}`);
      if (c && c.at > fresh) out.push(...c.rows); else missing.push(pid);
    }
    if (missing.length) {
      const rows = await this.loadEvaluations({ periodIds: missing, camIds: filter.camIds });
      const byPeriod = new Map<string, Evaluation[]>(missing.map((p) => [p, []]));
      for (const r of rows) byPeriod.get(r.period_id)?.push(r);
      const at = Date.now();
      for (const [pid, list] of byPeriod) this.evalCache.set(`${pid}|${camKey}`, { at, rows: list });
      out.push(...rows);
    }
    return out.sort((a, b) => b.audited_at.localeCompare(a.audited_at));
  }
  private async loadEvaluations(filter: { periodIds?: string[]; camIds?: string[] }) {
    // a few weeks per request, several requests at once
    const groups = filter.periodIds ? chunks(filter.periodIds, 3) : [null];
    const parts = await pool(groups.map((pc) => () => fetchAll<Omit<Evaluation, 'scores'>>((a, b) => {
      let q = this.sb.from('v_evaluations_effective').select('*').order('audited_at', { ascending: false });
      if (pc) q = q.in('period_id', pc);
      if (filter.camIds) q = q.in('cam_id', filter.camIds);
      return q.range(a, b);
    })), 4);
    return this.attachScores(parts.flat());
  }
  async getEvaluation(id: string) {
    const row = unwrap(await this.sb.from('v_evaluations_effective').select('*').eq('id', id).maybeSingle()) as Omit<Evaluation, 'scores'> | null;
    if (!row) return null;
    return (await this.attachScores([row]))[0];
  }
  async getAdjustments(evaluationId: string) {
    const rows = unwrap(await this.sb.from('score_adjustments').select('*').eq('evaluation_id', evaluationId).order('created_at')) as ScoreAdjustment[];
    return rows.map((r) => ({ ...r, original_value: Number(r.original_value), revised_value: Number(r.revised_value) }));
  }
  async getAppealDeadline(evaluationId: string) {
    return unwrap(await this.sb.rpc('appeal_deadline', { p_evaluation: evaluationId })) as string | null;
  }

  // ---------------------------------------------------------------- appeals
  async listAppeals(filter: { statuses?: Appeal['status'][]; camId?: string; leadId?: string; evaluationId?: string } = {}) {
    const rows = await fetchAll<Appeal>((a, b) => {
      let q = this.sb.from('v_appeals').select('*').order('created_at', { ascending: false });
      if (filter.statuses) q = q.in('status', filter.statuses);
      if (filter.camId) q = q.eq('cam_id', filter.camId);
      if (filter.leadId) q = q.eq('lead_id', filter.leadId);
      if (filter.evaluationId) q = q.eq('evaluation_id', filter.evaluationId);
      return q.range(a, b);
    });
    // parameter labels for list views
    const ids = rows.map((r) => r.id);
    const labels = new Map<string, string[]>();
    const keys = new Map<string, string[]>();
    const params = new Map((await this.getParameters()).map((p) => [p.id, p.name]));
    for (const c of chunks(ids, CHUNK)) {
      const items = unwrap(await this.sb.from('appeal_items').select('appeal_id, parameter_id, is_autofail').in('appeal_id', c)) as { appeal_id: string; parameter_id: string | null; is_autofail: boolean }[];
      for (const it of items) {
        labels.set(it.appeal_id, [...(labels.get(it.appeal_id) ?? []), it.is_autofail ? 'Autofail' : params.get(it.parameter_id!) ?? '?']);
        keys.set(it.appeal_id, [...(keys.get(it.appeal_id) ?? []), it.is_autofail ? 'AF' : it.parameter_id!]);
      }
    }
    return rows.map((r) => ({ ...r, original_score: Number(r.original_score), days_in_status: Number(r.days_in_status),
      item_count: labels.get(r.id)?.length ?? 0, parameters_label: (labels.get(r.id) ?? []).join(', '), disputed_keys: keys.get(r.id) ?? [] }));
  }
  async getAppeal(id: string): Promise<AppealDetail | null> {
    const appeal = unwrap(await this.sb.from('v_appeals').select('*').eq('id', id).maybeSingle()) as Appeal | null;
    if (!appeal) return null;
    const [items, events, evidence, evaluation, staff] = await Promise.all([
      this.sb.from('appeal_items').select('*').eq('appeal_id', id),
      this.sb.from('appeal_events').select('*').eq('appeal_id', id).order('created_at'),
      this.sb.from('appeal_evidence').select('*').eq('appeal_id', id).order('created_at'),
      this.getEvaluation(appeal.evaluation_id),
      this.sb.from('employees').select('id, full_name'),
    ]);
    const names = new Map((unwrap(staff) as { id: string; full_name: string }[]).map((e) => [e.id, e.full_name]));
    return {
      appeal,
      items: (unwrap(items) as AppealDetail['items']).map((i) => ({ ...i, original_score: i.original_score === null ? null : Number(i.original_score),
        requested_score: i.requested_score === null ? null : Number(i.requested_score), revised_score: i.revised_score === null ? null : Number(i.revised_score) })),
      events: (unwrap(events) as AppealDetail['events']).map((e) => ({ ...e, actor_name: e.actor_id ? names.get(e.actor_id) ?? null : null })),
      evidence: unwrap(evidence) as AppealDetail['evidence'],
      evaluation,
    };
  }
  private async rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T> {
    this.invalidate();
    const { data, error } = await this.sb.rpc(fn, args);
    if (error) throw new Error(error.message);
    return data as T;
  }
  submitAppeal(evaluationId: string, reason: string, items: unknown[], asDraft = false) {
    return this.rpc<string>('submit_appeal', { p_evaluation_id: evaluationId, p_reason: reason, p_items: items, p_as_draft: asDraft });
  }
  async submitDraftAppeal(appealId: string) { await this.rpc('submit_draft_appeal', { p_appeal: appealId }); }
  async updateDraftAppeal(appealId: string, reason: string, items: unknown[]) { await this.rpc('update_draft_appeal', { p_appeal: appealId, p_reason: reason, p_items: items }); }
  async shareAppealComment(eventId: string) { await this.rpc('share_appeal_comment', { p_event: eventId }); }
  async leadReviewAppeal(appealId: string, rec: string, comment: string, internalNote?: string) {
    await this.rpc('lead_review_appeal', { p_appeal: appealId, p_recommendation: rec, p_comment: comment, p_internal_note: internalNote ?? null });
  }
  async respondToAppealRequest(appealId: string, response: string) { await this.rpc('respond_to_appeal_request', { p_appeal: appealId, p_response: response }); }
  async addAppealComment(appealId: string, comment: string, internal: boolean) { await this.rpc('add_appeal_comment', { p_appeal: appealId, p_comment: comment, p_internal: internal }); }
  async qaRequestInfo(appealId: string, from: 'cam' | 'lead', comment: string) { await this.rpc('qa_request_info', { p_appeal: appealId, p_from: from, p_comment: comment }); }
  qaDecideAppeal(appealId: string, decisions: unknown[], resolution: string, extra: unknown[] = []) {
    return this.rpc<string>('qa_decide_appeal', { p_appeal: appealId, p_decisions: decisions, p_resolution: resolution, p_extra_adjustments: extra });
  }
  async qaReopenAppeal(appealId: string, reason: string) { await this.rpc('qa_reopen_appeal', { p_appeal: appealId, p_reason: reason }); }
  async closeAppeal(appealId: string, reason: string) { await this.rpc('close_appeal', { p_appeal: appealId, p_reason: reason }); }
  async grantResubmission(evaluationId: string, parameterId: string | null, isAutofail: boolean, reason: string) {
    await this.rpc('grant_appeal_resubmission', { p_evaluation: evaluationId, p_parameter: parameterId, p_is_autofail: isAutofail, p_reason: reason });
  }
  async uploadEvidence(appealId: string, file: File) {
    const safe = file.name.replace(/[^\w.-]+/g, '_').slice(-80);
    const path = `${appealId}/${crypto.randomUUID()}-${safe}`;
    const up = await this.sb.storage.from('appeal-evidence').upload(path, file, { contentType: file.type, upsert: false });
    if (up.error) throw new Error(up.error.message);
    await this.rpc('register_appeal_evidence', { p_appeal: appealId, p_path: path, p_file_name: file.name, p_mime: file.type, p_size: file.size });
  }
  async evidenceUrl(storagePath: string) {
    const { data, error } = await this.sb.storage.from('appeal-evidence').createSignedUrl(storagePath, 60);
    if (error) throw new Error(error.message);
    return data.signedUrl;
  }

  // ---------------------------------------------------------------- admin
  async adminAdjustScore(evaluationId: string, parameterId: string | null, revised: number, reason: string) {
    await this.rpc('admin_adjust_score', { p_evaluation: evaluationId, p_parameter: parameterId, p_revised: revised, p_reason: reason });
  }
  async setPeriodStatus(periodId: string, status: 'draft' | 'published') { await this.rpc('set_period_status', { p_period: periodId, p_status: status }); }
  async upsertPeriod(p: Partial<Period> & { label: string; start_date: string; end_date: string }) { this.invalidate();
    unwrap(await this.sb.from('reporting_periods').upsert({ ...p }, { onConflict: 'label' }).select());
  }
  async updateSetting(key: string, value: unknown) {
    unwrap(await this.sb.from('settings').upsert({ key, value, updated_at: new Date().toISOString() }).select());
  }
  async updateParameter(id: string, patch: Partial<Parameter>) { this.invalidate(); unwrap(await this.sb.from('evaluation_parameters').update(patch).eq('id', id).select()); }
  async createParameter(p: Omit<Parameter, 'id'>) { unwrap(await this.sb.from('evaluation_parameters').insert(p).select()); }
  async upsertEmployee(e: Partial<Employee> & { email: string; full_name: string }) { this.invalidate();
    const row = { ...e, email: e.email.trim().toLowerCase() };
    unwrap(await (e.id ? this.sb.from('employees').update(row).eq('id', e.id).select() : this.sb.from('employees').insert(row).select()));
    // also block/unblock the login itself (bans the auth user and revokes sessions)
    if (e.id && e.status && e.auth_user_id) {
      const { error } = await this.sb.functions.invoke('admin-users', { body: { action: e.status === 'active' ? 'reactivate' : 'deactivate', employee_id: e.id } });
      if (error) throw new Error(await fnErrorMessage(error));
    }
  }
  async inviteUser(employeeId: string) {
    const { data, error } = await this.sb.functions.invoke('admin-users', { body: { action: 'invite', employee_id: employeeId, redirect_to: `${window.location.origin}${window.location.pathname}` } });
    if (error) throw new Error(await fnErrorMessage(error));
    if (data?.error) throw new Error(data.error);
  }
  async setUserPassword(employeeId: string, password: string) {
    const { data, error } = await this.sb.functions.invoke('admin-users', { body: { action: 'set_password', employee_id: employeeId, password } });
    if (error) throw new Error(await fnErrorMessage(error));
    if (data?.error) throw new Error(data.error);
  }
  async upsertTeam(t: Partial<Team> & { name: string }) { this.invalidate();
    unwrap(await (t.id ? this.sb.from('teams').update({ name: t.name, lead_id: t.lead_id ?? null }).eq('id', t.id).select()
      : this.sb.from('teams').insert({ name: t.name, lead_id: t.lead_id ?? null }).select()));
  }
  async deleteTeam(id: string) { this.invalidate(); unwrap(await this.sb.from('teams').delete().eq('id', id).select()); }
  async importEvaluations(rows: unknown[], meta: { source: string; file_name: string; publish_new_periods: boolean }, onProgress?: (d: number, t: number) => void) { this.invalidate();
    let batch_id: string | null = null;
    const total = { total: 0, inserted: 0, duplicates: 0, rejected: 0 };
    const parts = chunks(rows, 400);
    for (let i = 0; i < parts.length; i++) {
      type R = { batch_id: string; total: number; inserted: number; duplicates: number; rejected: number };
      const r: R = await this.rpc<R>('import_evaluations', {
        p_payload: { ...meta, batch_id, rows: parts[i] },
      });
      batch_id = r.batch_id;
      total.total += r.total; total.inserted += r.inserted; total.duplicates += r.duplicates; total.rejected += r.rejected;
      onProgress?.(Math.min(rows.length, (i + 1) * 400), rows.length);
    }
    return { batch_id: batch_id ?? '', ...total };
  }
  async syncGoogleSheet(scope: 'live' | 'all') { this.invalidate();
    const { data, error } = await this.sb.functions.invoke('sheets-sync', { body: { scope } });
    if (error) throw new Error(await fnErrorMessage(error));
    if (data?.error) throw new Error(data.error);
    return (data?.results ?? []) as import('../lib/types').SheetSyncResult[];
  }
  async listImportBatches() { return unwrap(await this.sb.from('import_batches').select('*').order('created_at', { ascending: false }).limit(50)) as ImportBatch[]; }
  async listImportRejections(batchId: string) {
    return unwrap(await this.sb.from('import_rejections').select('row_number, reason').eq('batch_id', batchId).order('row_number').limit(2000)) as ImportRejection[];
  }
  async listAuditLogs(opts: { limit: number; offset: number; table?: string; action?: string; actorId?: string; from?: string; to?: string; record?: string }) {
    let q = this.sb.from('audit_logs').select('*').order('created_at', { ascending: false }).range(opts.offset, opts.offset + opts.limit - 1);
    if (opts.table) q = q.eq('table_name', opts.table);
    if (opts.action) q = q.eq('action', opts.action);
    if (opts.actorId) q = q.eq('actor_id', opts.actorId);
    if (opts.from) q = q.gte('created_at', opts.from + 'T00:00:00');
    if (opts.to) q = q.lte('created_at', opts.to + 'T23:59:59.999');
    if (opts.record) q = q.eq('record_id', opts.record.trim());
    const rows = unwrap(await q) as AuditLog[];
    const names = new Map((await this.getEmployees()).map((e) => [e.id, e.full_name]));
    return rows.map((r) => ({ ...r, actor_name: r.actor_id ? names.get(r.actor_id) ?? null : 'System' }));
  }

  // ---------------------------------------------------------------- weekly emails & mapping
  async weeklyEmailPreview(periodId: string) {
    return this.rpc<import('../lib/types').WeeklyEmailRow[]>('weekly_email_preview', { p_period: periodId });
  }
  async sendWeeklyEmails(periodId: string, camIds: string[] | null, resend: boolean) {
    const q = await this.rpc<{ queued: number; skipped: number; no_email: number }>('queue_weekly_report_emails', { p_period: periodId, p_cam_ids: camIds, p_resend: resend });
    let sent = 0, failed = 0; let failures: { to: string; error: string }[] = [];
    const notif = unwrap(await this.sb.from('settings').select('value').eq('key', 'notifications').maybeSingle()) as { value?: { mail_route?: string } } | null;
    if (notif?.value?.mail_route === 'sheet') return { ...q, sent, failed, failures, via_sheet: true };
    if (q.queued > 0) {
      // deliver immediately (the send-email function also runs on a schedule as a retry)
      const { data, error } = await this.sb.functions.invoke('send-email', { body: { kind: 'weekly_report' } });
      if (error) throw new Error(`Emails were queued but could not be sent yet: ${await fnErrorMessage(error)}`);
      sent = data?.sent ?? 0; failed = data?.failed ?? 0; failures = data?.failures ?? [];
    }
    return { ...q, sent, failed, failures };
  }
  async importTeamMapping(rows: import('../lib/types').TeamMappingRow[]) {
    return this.rpc<import('../lib/types').TeamMappingResult>('import_team_mapping', { p_rows: rows });
  }

  async historicalCams() { return this.rpc<import('../lib/types').HistoricalCam[]>('historical_cams', {}); }
  async mergeEmployee(fromId: string, intoId: string) { return this.rpc<{ moved: number }>('merge_employee', { p_from: fromId, p_into: intoId }); }

  // ---------------------------------------------------------------- feedback sessions
  async listFeedbackCycles() {
    return unwrap(await this.sb.from('feedback_cycles').select('*').order('number', { ascending: false })) as import('../lib/types').FeedbackCycle[];
  }
  async listFeedbackSessions(cycleId?: string) {
    const { data, error } = await this.sb.rpc('list_feedback_sessions', { p_cycle: cycleId ?? null });
    if (error) throw new Error(error.message);
    return (data ?? []) as import('../lib/types').FeedbackSession[];
  }
  async markFeedbackBooked(sessionId: string, when: string) { await this.rpc('mark_feedback_booked', { p_session: sessionId, p_when: when }); }
  async updateFeedbackSession(sessionId: string, patch: { providerId?: string; status?: import('../lib/types').FeedbackStatus }) {
    await this.rpc('update_feedback_session', { p_session: sessionId, p_provider: patch.providerId ?? null, p_status: patch.status ?? null });
  }
  async buildFeedbackCycle(number: number, periodIds: string[], bookBy: string | null) {
    return this.rpc<string>('build_feedback_cycle', { p_number: number, p_period_ids: periodIds, p_book_by: bookBy });
  }
  async updateFeedbackCycle(cycleId: string, bookBy: string | null) { await this.rpc('update_feedback_cycle', { p_cycle: cycleId, p_book_by: bookBy }); }
  async listFeedbackResponses() {
    return fetchAll<import('../lib/types').FeedbackResponse>((a, b) => this.sb.from('feedback_responses').select('*').order('submitted_at', { ascending: false }).range(a, b));
  }

  // ---------------------------------------------------------------- notifications
  async listNotifications() {
    return unwrap(await this.sb.from('notifications').select('*').order('created_at', { ascending: false }).limit(100)) as NotificationRow[];
  }
  async logExport(info: { scope: string; period: string; format: string }) {
    try { await this.sb.rpc('log_report_export', { p_scope: info.scope, p_period: info.period, p_format: info.format }); } catch { /* best effort */ }
  }
  async markNotificationsRead(ids?: string[]) { await this.rpc('mark_notifications_read', { p_ids: ids ?? null }); }
}
