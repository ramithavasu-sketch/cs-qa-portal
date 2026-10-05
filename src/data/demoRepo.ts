// In-browser demo backend. Holds FICTIONAL data only and mirrors the access rules
// and workflow checks implemented in Postgres (RLS + RPCs) so the demo behaves like
// production. State is kept per-viewer in localStorage (best effort).
import type { Repo } from './repo';
import type {
  Appeal, AppealDetail, AppealEvent, AppealItem, AppealStatus, AuditLog, Employee, Evaluation, Evidence,
  ExtraAdjustmentInput, ImportBatch, ImportRejection, LeadRecommendation, Me, NotificationRow, Parameter, Period,
  PortalSettings, QaDecisionInput, Role, ScoreAdjustment, SubmitAppealItem, TaskType, Team, WeeklyEmailRow, TeamMappingRow, TeamMappingResult,
} from '../lib/types';
import { renderReportEmail } from '../lib/email';
import { generateDemoSeed, DEMO_PASSWORD, type RawEvaluation } from '../demo/generate';
import type { ImportRow } from '../../supabase/functions/_shared/mapper';

interface Grant { id: string; evaluation_id: string; parameter_id: string | null; is_autofail: boolean; used_at: string | null }
interface RawAppeal {
  id: string; reference: string; evaluation_id: string; cam_id: string; lead_id: string | null; status: AppealStatus; reason: string;
  info_requested_from: 'cam' | 'lead' | null; info_due_at: string | null; lead_recommendation: LeadRecommendation | null;
  submitted_at: string | null; forwarded_at: string | null; decided_at: string | null; decided_by: string | null;
  resolution_note: string | null; status_changed_at: string; created_at: string;
}
interface EvidenceBlob extends Evidence { data_url: string }
interface State {
  version: number; createdAt: string;
  employees: Employee[]; teams: Team[]; taskTypes: TaskType[]; parameters: Parameter[]; settings: PortalSettings; periods: Period[];
  evaluations: RawEvaluation[]; adjustments: ScoreAdjustment[]; appeals: RawAppeal[]; items: AppealItem[]; events: AppealEvent[];
  evidence: EvidenceBlob[]; grants: Grant[]; notifications: (NotificationRow & { recipient_id: string })[]; audit: AuditLog[];
  batches: ImportBatch[]; rejections: (ImportRejection & { batch_id: string })[]; refSeq: number; auditSeq: number; passwords: Record<string, string>;
  weeklyEmails: { period_id: string; cam_id: string; to: string; cc: string | null; subject: string; status: 'sent'; queued_at: string }[];
}

const KEY = 'csqa-demo-state-v4';
const SESSION_KEY = 'csqa-demo-session';

const FINAL: AppealStatus[] = ['approved', 'partially_approved', 'rejected', 'closed'];
const ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'];

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Math.random().toString(36).slice(2) + Date.now());
const nowIso = () => new Date().toISOString();
const delay = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const clone = <T,>(x: T): T => structuredClone(x);
class AuthError extends Error {}

function addBusinessDays(from: Date, days: number) {
  const d = new Date(from);
  let added = 0;
  while (added < days) { d.setDate(d.getDate() + 1); const w = d.getDay(); if (w !== 0 && w !== 6) added++; }
  return d;
}

export class DemoRepo implements Repo {
  readonly mode = 'demo' as const;
  private s!: State;
  private meId: string | null = null;
  private listeners = new Set<(e: 'SIGNED_IN' | 'SIGNED_OUT' | 'PASSWORD_RECOVERY') => void>();

  constructor() {
    this.load();
    try { this.meId = sessionStorage.getItem(SESSION_KEY); } catch { this.meId = null; }
  }

  // ------------------------------------------------------------------ state
  private load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const st = JSON.parse(raw) as State;
        // regenerate if the stored demo is older than 6 days (keeps weeks current)
        if (st.version === 4 && Date.now() - Date.parse(st.createdAt) < 6 * 86400000) { this.s = st; return; }
      }
    } catch { /* storage unavailable */ }
    this.reset();
  }
  private save() {
    try { localStorage.setItem(KEY, JSON.stringify(this.s)); } catch { /* quota or disabled: keep in memory */ }
  }
  reset() {
    const seed = generateDemoSeed();
    this.s = {
      version: 4, createdAt: nowIso(), weeklyEmails: [], employees: seed.employees, teams: seed.teams, taskTypes: seed.taskTypes, parameters: seed.parameters,
      settings: seed.settings, periods: seed.periods, evaluations: seed.evaluations, adjustments: [], appeals: [], items: [], events: [],
      evidence: [], grants: [], notifications: [], audit: [], batches: [], rejections: [], refSeq: 1001, auditSeq: 1, passwords: seed.passwords,
    };
    this.seedAppeals();
    this.save();
  }
  resetDemo() { this.reset(); }

  /** Creates the six sample appeal cases by running the real workflow as each actor. */
  private seedAppeals() {
    const saveMe = this.meId;
    const s = this.s;
    const published = s.periods.filter((p) => p.status === 'published').sort((a, b) => a.start_date.localeCompare(b.start_date));
    const lastWeek = published[published.length - 1];
    const byEmail = (name: string) => s.employees.find((e) => e.full_name === name)!;
    const qa = s.employees.find((e) => e.role === 'super_admin')!;
    const pick = (camName: string, pred: (e: RawEvaluation) => boolean) =>
      s.evaluations.find((e) => e.cam_id === byEmail(camName).id && e.period_id === lastWeek.id && pred(e));
    const deducted = (e: RawEvaluation) => !e.autofail && e.scores.some((x) => (x.earned ?? 0) < x.max_score);
    const firstDeducted = (e: RawEvaluation, n = 1) => e.scores.filter((x) => (x.earned ?? 0) < x.max_score).slice(0, n).map((x) => x.parameter_id);
    const act = (emp: Employee, fn: () => void) => { this.meId = emp.id; try { fn(); } catch (err) { console.warn('demo seed step failed', err); } };
    const lead = (camName: string) => s.employees.find((e) => e.id === s.teams.find((t) => t.id === byEmail(camName).team_id)!.lead_id)!;
    const ensureDeducted = (camName: string, n: number) => {
      let e = pick(camName, (x) => deducted(x) && x.scores.filter((y) => (y.earned ?? 0) < y.max_score).length >= n);
      if (!e) {
        e = pick(camName, (x) => !x.autofail)!;
        e.scores.slice(0, n).forEach((x) => { x.earned = 0; });
        e.original_score = e.scores.reduce((a, x) => a + (x.earned ?? 0), 0);
        e.feedback = (e.feedback ?? '') + ' Points were deducted on the first scored parameters.';
      }
      return e;
    };
    const run = (fn: () => void) => { try { fn(); } catch (err) { console.warn(err); } };

    run(() => { // 1. Pending Lead review
      const e = ensureDeducted('Ava Thompson', 1);
      act(byEmail('Ava Thompson'), () => this.submitAppealSync(e.id, 'The checklist was fully completed in the task notes at 10:42 IST — the screenshot shows the OB Call field as “Yes”.', [{ parameter_id: firstDeducted(e)[0], requested_score: null }]));
    });
    run(() => { // 2. Forwarded to QA
      const e = ensureDeducted('Rohan Iyer', 1);
      act(byEmail('Rohan Iyer'), () => this.submitAppealSync(e.id, 'Action was taken within the interruptible 3-hour window because the request arrived during a live call. Task notes show the timeline.', [{ parameter_id: firstDeducted(e)[0] }]));
      const a = s.appeals[s.appeals.length - 1];
      act(lead('Rohan Iyer'), () => this.leadReviewSync(a.id, 'recommend_approval', 'I checked the call log — the AR was interruptible, so the 3-hour window applies.', 'Rohan has been consistent on ATT recently.'));
    });
    run(() => { // 3. Approved with adjustment
      const e = ensureDeducted('Nisha Pillai', 1);
      act(byEmail('Nisha Pillai'), () => this.submitAppealSync(e.id, 'The required documentation was added to the parent task, which is linked in the task notes. Please review the parent task.', [{ parameter_id: firstDeducted(e)[0] }]));
      const a = s.appeals[s.appeals.length - 1];
      act(lead('Nisha Pillai'), () => this.leadReviewSync(a.id, 'recommend_approval', 'Documentation exists on the parent task as described.'));
      const it = s.items.filter((i) => i.appeal_id === a.id);
      act(qa, () => this.qaDecideSync(a.id, it.map((i) => ({ item_id: i.id, decision: 'approved', revised_score: this.paramMax(e.id, i.parameter_id!), reason: 'Documentation verified on the parent task.' })), 'Appeal approved — documentation was present on the linked parent task. Score updated.'));
    });
    run(() => { // 4. Partially approved (two parameters)
      const e = ensureDeducted('Marcus Webb', 2);
      const ps = firstDeducted(e, 2);
      act(byEmail('Marcus Webb'), () => this.submitAppealSync(e.id, 'The follow-up was completed by email within business hours and the email structure followed the approved template for this client.', ps.map((p) => ({ parameter_id: p }))));
      const a = s.appeals[s.appeals.length - 1];
      act(lead('Marcus Webb'), () => this.leadReviewSync(a.id, 'recommend_approval', 'First point is valid; second one is borderline.'));
      const it = s.items.filter((i) => i.appeal_id === a.id);
      act(qa, () => this.qaDecideSync(a.id, it.map((i, idx) => idx === 0
        ? { item_id: i.id, decision: 'approved', revised_score: this.paramMax(e.id, i.parameter_id!), reason: 'Follow-up email confirmed in the task history.' }
        : { item_id: i.id, decision: 'rejected', reason: 'The template was not applied; closing line and signature were missing.' }),
        'Partially approved: first deduction reverted, second deduction upheld as per guidelines.'));
    });
    run(() => { // 5. Rejected
      const e = ensureDeducted('Liam O’Connor', 1);
      act(byEmail('Liam O’Connor'), () => this.submitAppealSync(e.id, 'I believe the query was resolved because the client did not reply again after my email.', [{ parameter_id: firstDeducted(e)[0] }]));
      const a = s.appeals[s.appeals.length - 1];
      act(lead('Liam O’Connor'), () => this.leadReviewSync(a.id, 'recommend_rejection', 'The client did raise a second question that was not answered.'));
      const it = s.items.filter((i) => i.appeal_id === a.id);
      act(qa, () => this.qaDecideSync(a.id, it.map((i) => ({ item_id: i.id, decision: 'rejected', reason: 'The second request in the email was not addressed.' })), 'Rejected — the original deduction stands; the second request was not addressed in the reply.'));
    });
    run(() => { // 6. QA requested additional information
      const e = ensureDeducted('Ethan Clarke', 1);
      act(byEmail('Ethan Clarke'), () => this.submitAppealSync(e.id, 'The hold sequence was used — permission, time frame and reason were all given before placing the chat on hold.', [{ parameter_id: firstDeducted(e)[0] }]));
      const a = s.appeals[s.appeals.length - 1];
      act(lead('Ethan Clarke'), () => this.leadReviewSync(a.id, 'recommend_approval', 'Agree with the CAM based on the transcript excerpt shared.'));
      act(qa, () => this.qaRequestInfoSync(a.id, 'cam', 'Please share the exact chat timestamps for the hold request and return.'));
    });
    run(() => { // 7. Returned to CAM by Lead
      const e = ensureDeducted('Jonah Kim', 1);
      act(byEmail('Jonah Kim'), () => this.submitAppealSync(e.id, 'The OB call was attempted but the client did not pick up, so the follow-up email was sent instead.', [{ parameter_id: firstDeducted(e)[0] }]));
      const a = s.appeals[s.appeals.length - 1];
      act(lead('Jonah Kim'), () => this.leadReviewSync(a.id, 'request_more_info', 'Please attach the call log showing the OB attempt time.'));
    });
    // age a couple of statuses so SLA flags show
    const first = s.appeals[0];
    if (first) first.status_changed_at = new Date(Date.now() - 3.2 * 86400000).toISOString();
    s.notifications.forEach((n) => { if (Math.random() < 0.3) n.read_at = nowIso(); });
    this.meId = saveMe;
  }

  // ------------------------------------------------------------------ identity & visibility (mirrors SQL helpers)
  private me(): Employee {
    const e = this.s.employees.find((x) => x.id === this.meId && x.status === 'active');
    if (!e) throw new AuthError('Not authorised: no active portal account for this login');
    return e;
  }
  private meOrNull() { return this.s.employees.find((x) => x.id === this.meId && x.status === 'active') ?? null; }
  private isSuper() { return this.meOrNull()?.role === 'super_admin'; }
  private isLeadOf(camId: string) {
    const me = this.meOrNull();
    if (!me || me.role !== 'admin') return false;
    const cam = this.s.employees.find((e) => e.id === camId);
    const team = cam?.team_id ? this.s.teams.find((t) => t.id === cam.team_id) : undefined;
    return team?.lead_id === me.id;
  }
  private canViewCam(camId: string) { return this.isSuper() || camId === this.meId || this.isLeadOf(camId); }
  private published(periodId: string) { return this.s.periods.find((p) => p.id === periodId)?.status === 'published'; }
  private canViewEval(e: RawEvaluation) { return this.isSuper() || (this.canViewCam(e.cam_id) && this.published(e.period_id)); }
  private canViewAppeal(a: RawAppeal) {
    const me = this.meOrNull();
    if (!me) return false;
    return me.role === 'super_admin' || a.cam_id === me.id || (me.role === 'admin' && (a.lead_id === me.id || this.isLeadOf(a.cam_id)));
  }
  private require(cond: boolean, msg: string) { if (!cond) throw new Error(msg); }

  // ------------------------------------------------------------------ effective scores (mirrors v_evaluations_effective)
  private latestAdj(evalId: string, kind: 'parameter' | 'autofail', paramId: string | null) {
    const list = this.s.adjustments.filter((a) => a.evaluation_id === evalId && a.kind === kind && (kind === 'autofail' || a.parameter_id === paramId));
    return list.length ? list[list.length - 1] : null;
  }
  private effParam(evalId: string, paramId: string): number | null {
    const a = this.latestAdj(evalId, 'parameter', paramId);
    if (a) return a.revised_value;
    return this.s.evaluations.find((e) => e.id === evalId)?.scores.find((x) => x.parameter_id === paramId)?.earned ?? null;
  }
  private effAutofail(evalId: string) {
    const a = this.latestAdj(evalId, 'autofail', null);
    return a ? a.revised_value === 1 : !!this.s.evaluations.find((e) => e.id === evalId)?.autofail;
  }
  private paramMax(evalId: string, paramId: string) {
    return this.s.evaluations.find((e) => e.id === evalId)!.scores.find((x) => x.parameter_id === paramId)!.max_score;
  }
  private toEvaluation(e: RawEvaluation): Evaluation {
    const s = this.s;
    const p = s.periods.find((x) => x.id === e.period_id)!;
    const cam = s.employees.find((x) => x.id === e.cam_id)!;
    const team = cam.team_id ? s.teams.find((t) => t.id === cam.team_id) : undefined;
    const lead = team?.lead_id ? s.employees.find((x) => x.id === team.lead_id) : undefined;
    const tt = s.taskTypes.find((t) => t.code === e.task_type)!;
    const scores = e.scores.map((sc) => {
      const par = s.parameters.find((x) => x.id === sc.parameter_id)!;
      const adj = this.latestAdj(e.id, 'parameter', sc.parameter_id);
      return { id: sc.id, evaluation_id: e.id, parameter_id: sc.parameter_id, parameter_name: par.name, section: par.section, sort_order: par.sort_order,
        max_score: sc.max_score, original_earned: sc.earned, earned: adj ? adj.revised_value : sc.earned, adjusted: !!adj, remarks: sc.remarks };
    }).sort((a, b) => a.sort_order - b.sort_order);
    const afAdj = this.latestAdj(e.id, 'autofail', null);
    const autofail = afAdj ? afAdj.revised_value === 1 : e.autofail;
    const adjCount = scores.filter((x) => x.adjusted).length;
    const applicable = scores.filter((x) => x.earned !== null);
    const maxSum = applicable.reduce((a, x) => a + x.max_score, 0);
    const sum = applicable.reduce((a, x) => a + (x.earned ?? 0), 0);
    const score = !afAdj && adjCount === 0 ? e.original_score : autofail ? 0 : maxSum > 0 ? Math.round((10000 * sum) / maxSum) / 100 : e.original_score;
    return {
      id: e.id, task_id: e.task_id, task_link: e.task_link, cam_id: e.cam_id, evaluator_id: e.evaluator_id, evaluator_email: e.evaluator_email,
      evaluator_name: e.evaluator_name, task_type: e.task_type, task_type_name: tt.name, request_from: e.request_from, task_loaded_date: e.task_loaded_date,
      audited_at: e.audited_at, period_id: e.period_id, period_label: p.label, period_short_label: p.short_label, period_start: p.start_date,
      period_end: p.end_date, period_status: p.status, published_at: p.published_at, task_seq: e.task_seq, connection_id: e.connection_id,
      screenshot_url: e.screenshot_url, fcr: e.fcr, feedback: e.feedback, cam_name: cam.full_name, cam_email: cam.email, team_id: cam.team_id,
      team_name: team?.name ?? null, lead_id: team?.lead_id ?? null, lead_name: lead?.full_name ?? null, original_autofail: e.autofail,
      original_score: e.original_score, autofail, score, adjusted: !!afAdj || adjCount > 0, scores,
    };
  }

  // ------------------------------------------------------------------ helpers mirroring SQL functions
  private notify(recipient: string | null, type: string, title: string, message: string, link: string | null, appealId: string | null) {
    if (!recipient) return;
    const emp = this.s.employees.find((e) => e.id === recipient);
    if (!emp || emp.status !== 'active') return;
    if (this.s.settings.notifications.in_app?.[type] === false) return;
    this.s.notifications.unshift({ id: uid(), recipient_id: recipient, type, title, message, link, appeal_id: appealId, read_at: null, created_at: nowIso() });
  }
  private notifySupers(type: string, title: string, message: string, link: string, appealId: string) {
    this.s.employees.filter((e) => e.role === 'super_admin' && e.status === 'active').forEach((e) => this.notify(e.id, type, title, message, link, appealId));
  }
  private event(appealId: string, action: string, comment: string | null, visibility: 'shared' | 'internal', from: AppealStatus | null, to: AppealStatus | null, rec: LeadRecommendation | null = null) {
    const me = this.me();
    this.s.events.push({ id: uid(), appeal_id: appealId, actor_id: me.id, actor_role: me.role, action, recommendation: rec,
      comment: comment?.trim() || null, visibility, from_status: from, to_status: to, created_at: nowIso() });
  }
  private setStatus(a: RawAppeal, st: AppealStatus) {
    const prev = a.status;
    a.status = st; a.status_changed_at = nowIso();
    this.log('appeal_status', 'appeals', a.id, { status: prev }, { status: st, reference: a.reference });
  }
  private log(action: string, table: string | null, record: string | null, previous: unknown, next: unknown, reason: string | null = null) {
    this.s.audit.unshift({ id: this.s.auditSeq++, actor_id: this.meOrNull()?.id ?? null, action, table_name: table, record_id: record,
      previous: previous ?? null, new_value: next ?? null, reason, created_at: nowIso() });
  }
  private addAdjustment(adj: Omit<ScoreAdjustment, 'id' | 'created_at'>) {
    this.require(adj.reason.trim().length >= 5, 'A reason is required');
    const row: ScoreAdjustment = { ...adj, id: uid(), created_at: nowIso() };
    this.s.adjustments.push(row);
    this.log('score_adjusted', 'evaluations', adj.evaluation_id, { kind: adj.kind, parameter_id: adj.parameter_id, value: adj.original_value },
      { kind: adj.kind, parameter_id: adj.parameter_id, value: adj.revised_value, appeal_id: adj.appeal_id }, adj.reason);
  }
  private deadline(e: RawEvaluation): Date | null {
    const p = this.s.periods.find((x) => x.id === e.period_id);
    if (!p || p.status !== 'published' || !p.published_at) return null;
    const w = this.s.settings.appeal_window;
    const base = new Date(p.published_at);
    return w.business_days ? addBusinessDays(base, w.days) : new Date(base.getTime() + w.days * 86400000);
  }
  private findAppeal(id: string) {
    const a = this.s.appeals.find((x) => x.id === id);
    this.require(!!a, 'Appeal not found');
    return a!;
  }

  // ------------------------------------------------------------------ auth
  async currentUser(): Promise<Me | null> {
    await delay(10);
    const e = this.meOrNull();
    return e ? this.toMe(e) : null;
  }
  private toMe(e: Employee): Me {
    const team = e.team_id ? this.s.teams.find((t) => t.id === e.team_id) : undefined;
    const lead = team?.lead_id ? this.s.employees.find((x) => x.id === team.lead_id) : undefined;
    return { ...clone(e), team_name: team?.name ?? null, lead_name: lead?.full_name ?? null };
  }
  async signIn(email: string, password: string) {
    await delay(250);
    const e = this.s.employees.find((x) => x.email === email.trim().toLowerCase());
    if (!e || (this.s.passwords[e.email] ?? DEMO_PASSWORD) !== password) throw new Error('Incorrect email or password.');
    if (e.status !== 'active') throw new Error('Your login is not linked to an active portal account. Please contact the QA team.');
    this.meId = e.id;
    try { sessionStorage.setItem(SESSION_KEY, e.id); } catch { /* ignore */ }
    this.listeners.forEach((l) => l('SIGNED_IN'));
    return this.toMe(e);
  }
  async signOut() {
    this.meId = null;
    try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
    this.listeners.forEach((l) => l('SIGNED_OUT'));
  }
  async requestPasswordReset() { await delay(300); }
  async updatePassword(password: string) {
    const me = this.me();
    this.require(password.length >= 10, 'Password must be at least 10 characters');
    this.s.passwords[me.email] = password; this.save();
  }
  onAuthEvent(cb: (e: 'SIGNED_IN' | 'SIGNED_OUT' | 'PASSWORD_RECOVERY') => void) { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; }

  // ------------------------------------------------------------------ reference
  async getSettings() { await delay(5); this.me(); return clone(this.s.settings); }
  async getTaskTypes() { this.me(); return clone(this.s.taskTypes); }
  async getParameters() { this.me(); return clone(this.s.parameters); }
  async getPeriods() { this.me(); return clone(this.s.periods.filter((p) => this.isSuper() || p.status === 'published')); }
  async getTeams() { this.me(); return clone(this.s.teams); }
  async getEmployees() {
    this.me();
    return clone(this.s.employees.filter((e) => this.isSuper() || e.id === this.meId || this.isLeadOf(e.id) || e.role !== 'user'));
  }

  // ------------------------------------------------------------------ evaluations
  async getEvaluations(filter: { periodIds?: string[]; camIds?: string[] }) {
    await delay(40);
    this.me();
    const pid = filter.periodIds ? new Set(filter.periodIds) : null;
    const cid = filter.camIds ? new Set(filter.camIds) : null;
    return this.s.evaluations
      .filter((e) => this.canViewEval(e) && (!pid || pid.has(e.period_id)) && (!cid || cid.has(e.cam_id)))
      .map((e) => this.toEvaluation(e))
      .sort((a, b) => b.audited_at.localeCompare(a.audited_at));
  }
  async getEvaluation(id: string) {
    this.me();
    const e = this.s.evaluations.find((x) => x.id === id);
    return e && this.canViewEval(e) ? this.toEvaluation(e) : null;
  }
  async getAdjustments(evaluationId: string) {
    const e = this.s.evaluations.find((x) => x.id === evaluationId);
    if (!e || !this.canViewEval(e)) return [];
    return clone(this.s.adjustments.filter((a) => a.evaluation_id === evaluationId))
      .map((a) => ({ ...a, approved_by_name: this.s.employees.find((x) => x.id === a.approved_by)?.full_name ?? null }));
  }
  async getAppealDeadline(evaluationId: string) {
    const e = this.s.evaluations.find((x) => x.id === evaluationId);
    if (!e || !this.canViewEval(e)) return null;
    return this.deadline(e)?.toISOString() ?? null;
  }

  // ------------------------------------------------------------------ appeals (read)
  private toAppeal(a: RawAppeal): Appeal {
    const e = this.s.evaluations.find((x) => x.id === a.evaluation_id)!;
    const p = this.s.periods.find((x) => x.id === e.period_id)!;
    const cam = this.s.employees.find((x) => x.id === a.cam_id)!;
    const lead = a.lead_id ? this.s.employees.find((x) => x.id === a.lead_id) : undefined;
    const items = this.s.items.filter((i) => i.appeal_id === a.id);
    const days = Math.max(0, (Date.now() - Date.parse(a.status_changed_at)) / 86400000);
    const sla = this.s.settings.sla;
    const overdue = a.status === 'pending_lead_review' ? days > sla.lead_review_days
      : a.status === 'pending_qa_review' ? days > sla.qa_review_days
      : (a.status === 'returned_to_cam' || a.status === 'pending_additional_info') ? !!a.info_due_at && Date.now() > Date.parse(a.info_due_at) : false;
    return { ...clone(a), task_id: e.task_id, task_link: e.task_link, task_type: e.task_type, period_id: e.period_id, period_label: p.label,
      period_short_label: p.short_label, audited_at: e.audited_at, evaluator_name: e.evaluator_name, original_score: e.original_score,
      cam_name: cam.full_name, cam_email: cam.email, lead_name: lead?.full_name ?? null, days_in_status: Math.round(days * 10) / 10, overdue,
      item_count: items.length,
      parameters_label: items.map((i) => (i.is_autofail ? 'Autofail' : this.s.parameters.find((p2) => p2.id === i.parameter_id)?.name ?? '?')).join(', ') };
  }
  async listAppeals(filter: { statuses?: AppealStatus[]; camId?: string; leadId?: string; evaluationId?: string } = {}) {
    await delay(30);
    this.me();
    return this.s.appeals.filter((a) => this.canViewAppeal(a)
      && (!filter.statuses || filter.statuses.includes(a.status)) && (!filter.camId || a.cam_id === filter.camId)
      && (!filter.leadId || a.lead_id === filter.leadId) && (!filter.evaluationId || a.evaluation_id === filter.evaluationId))
      .map((a) => this.toAppeal(a)).sort((x, y) => y.created_at.localeCompare(x.created_at));
  }
  async getAppeal(id: string): Promise<AppealDetail | null> {
    await delay(30);
    const me = this.me();
    const a = this.s.appeals.find((x) => x.id === id);
    if (!a || !this.canViewAppeal(a)) return null;
    const names = new Map(this.s.employees.map((e) => [e.id, e.full_name]));
    const e = this.s.evaluations.find((x) => x.id === a.evaluation_id)!;
    return {
      appeal: this.toAppeal(a),
      items: clone(this.s.items.filter((i) => i.appeal_id === id)),
      events: clone(this.s.events.filter((ev) => ev.appeal_id === id && (ev.visibility === 'shared' || me.role !== 'user')))
        .map((ev) => ({ ...ev, actor_name: ev.actor_id ? names.get(ev.actor_id) ?? null : null })),
      evidence: this.s.evidence.filter((x) => x.appeal_id === id).map(({ data_url: _d, ...rest }) => { void _d; return clone(rest); }),
      evaluation: this.toEvaluation(e),
    };
  }

  // ------------------------------------------------------------------ appeals (write) — mirror SQL RPCs
  private submitAppealSync(evaluationId: string, reason: string, items: SubmitAppealItem[], asDraft = false): string {
    const me = this.me();
    const ev = this.s.evaluations.find((x) => x.id === evaluationId);
    if (!ev || ev.cam_id !== me.id) throw new Error('You can only appeal your own evaluations');
    this.require(this.published(ev.period_id), 'This evaluation has not been published yet');
    const dl = this.deadline(ev);
    if (!dl || Date.now() > dl.getTime()) throw new Error(`The appeal window for this evaluation closed on ${dl?.toDateString() ?? '—'}`);
    this.require(!!reason && reason.trim().length >= 20, 'Please give a detailed reason for the appeal (at least 20 characters)');
    this.require(items.length > 0, 'Select at least one disputed parameter');
    const team = me.team_id ? this.s.teams.find((t) => t.id === me.team_id) : undefined;
    this.require(!!team?.lead_id, 'No Team Lead is assigned to your team. Please contact the QA team.');
    const limit = this.s.settings.appeal_window.max_appeals_per_cam_per_period;
    if (limit !== null && limit !== undefined && !asDraft) {
      const count = this.s.appeals.filter((a) => a.cam_id === me.id && !['draft', 'closed'].includes(a.status)
        && this.s.evaluations.find((x) => x.id === a.evaluation_id)?.period_id === ev.period_id).length;
      this.require(count < limit, `You have reached the maximum of ${limit} appeal(s) for this audit week`);
    }
    const seen = new Set<string>();
    const prepared: AppealItem[] = [];
    const appealId = uid();
    for (const it of items) {
      const isAf = !!it.is_autofail;
      const key = isAf ? 'AF' : it.parameter_id ?? '';
      this.require(!seen.has(key), 'The same parameter was selected twice');
      seen.add(key);
      let orig: number | null; let max: number;
      if (isAf) {
        this.require(this.effAutofail(ev.id), 'This evaluation is not marked as an autofail');
        orig = 1; max = 1;
      } else {
        const sc = ev.scores.find((x) => x.parameter_id === it.parameter_id);
        this.require(!!sc, `Parameter ${it.parameter_id ?? '(missing)'} is not part of this evaluation`);
        max = sc!.max_score; orig = this.effParam(ev.id, it.parameter_id!);
        if (it.requested_score !== null && it.requested_score !== undefined) this.require(it.requested_score >= 0 && it.requested_score <= max, `Requested score must be between 0 and ${max}`);
      }
      const clash = this.s.items.some((ai) => {
        const a = this.s.appeals.find((x) => x.id === ai.appeal_id)!;
        return a.evaluation_id === ev.id && (a.status !== 'closed' || !!a.decided_at) && ai.is_autofail === isAf && (ai.parameter_id ?? null) === (isAf ? null : it.parameter_id ?? null);
      });
      if (clash) {
        const g = this.s.grants.find((x) => x.evaluation_id === ev.id && !x.used_at && x.is_autofail === isAf && (x.parameter_id ?? null) === (isAf ? null : it.parameter_id ?? null));
        this.require(!!g, 'An appeal for this task and parameter already exists');
        g!.used_at = nowIso();
      }
      prepared.push({ id: uid(), appeal_id: appealId, parameter_id: isAf ? null : it.parameter_id!, is_autofail: isAf, original_score: orig,
        requested_score: isAf ? 0 : it.requested_score ?? null, decision: 'pending', revised_score: null, decision_reason: null, decided_by: null, decided_at: null });
    }
    const ref = `APL-${new Date().getFullYear()}-${String(this.s.refSeq++).padStart(5, '0')}`;
    const status: AppealStatus = asDraft ? 'draft' : 'pending_lead_review';
    this.s.appeals.push({ id: appealId, reference: ref, evaluation_id: ev.id, cam_id: me.id, lead_id: team!.lead_id, status, reason: reason.trim(),
      info_requested_from: null, info_due_at: null, lead_recommendation: null, submitted_at: asDraft ? null : nowIso(), forwarded_at: null,
      decided_at: null, decided_by: null, resolution_note: null, status_changed_at: nowIso(), created_at: nowIso() });
    this.s.items.push(...prepared);
    this.event(appealId, asDraft ? 'draft_saved' : 'submitted', null, 'shared', null, status);
    if (!asDraft) this.notify(team!.lead_id, 'appeal_submitted', `New appeal ${ref} awaiting your review`, `Appeal ${ref} for task ${ev.task_id} is pending Lead review.`, `/appeals/${appealId}`, appealId);
    return appealId;
  }
  async submitAppeal(evaluationId: string, reason: string, items: SubmitAppealItem[], asDraft = false) {
    await delay(); const id = this.submitAppealSync(evaluationId, reason, items, asDraft); this.save(); return id;
  }
  async submitDraftAppeal(appealId: string) {
    await delay();
    const me = this.me(); const a = this.findAppeal(appealId);
    this.require(a.cam_id === me.id, 'Not authorised');
    this.require(a.status === 'draft', 'Only drafts can be submitted');
    const ev = this.s.evaluations.find((x) => x.id === a.evaluation_id)!;
    const dl = this.deadline(ev);
    this.require(!!dl && Date.now() <= dl.getTime(), 'The appeal window has closed');
    const team = me.team_id ? this.s.teams.find((t) => t.id === me.team_id) : undefined;
    this.require(!!team?.lead_id, 'No Team Lead is assigned to your team. Please contact the QA team.');
    a.lead_id = team!.lead_id; a.submitted_at = nowIso();
    this.setStatus(a, 'pending_lead_review');
    this.event(a.id, 'submitted', null, 'shared', 'draft', 'pending_lead_review');
    this.notify(a.lead_id, 'appeal_submitted', `New appeal ${a.reference} awaiting your review`, `Appeal ${a.reference} is pending Lead review.`, `/appeals/${a.id}`, a.id);
    this.save();
  }
  private leadReviewSync(appealId: string, rec: LeadRecommendation, comment: string, internalNote?: string) {
    const me = this.me(); const a = this.findAppeal(appealId);
    this.require(me.role === 'admin' && (a.lead_id === me.id || this.isLeadOf(a.cam_id)), 'Only the CAM\'s Team Lead can review this appeal');
    this.require(a.status === 'pending_lead_review', `This appeal is not awaiting Lead review (current status: ${a.status})`);
    this.require(!!comment && comment.trim().length >= 5, 'Please add a comment for your recommendation');
    if (internalNote?.trim()) this.event(a.id, 'comment', internalNote, 'internal', null, null);
    if (rec === 'request_more_info') {
      a.info_requested_from = 'cam'; a.info_due_at = addBusinessDays(new Date(), this.s.settings.sla.clarification_days).toISOString();
      this.setStatus(a, 'returned_to_cam');
      this.event(a.id, 'lead_returned', comment, 'shared', 'pending_lead_review', 'returned_to_cam', rec);
      this.notify(a.cam_id, 'appeal_returned', `Appeal ${a.reference} returned for clarification`, `Your Team Lead has requested more information on appeal ${a.reference}.`, `/appeals/${a.id}`, a.id);
    } else {
      a.lead_recommendation = rec; a.forwarded_at = nowIso(); a.info_requested_from = null; a.info_due_at = null;
      this.setStatus(a, 'pending_qa_review');
      this.event(a.id, 'lead_forwarded', comment, 'shared', 'pending_lead_review', 'pending_qa_review', rec);
      this.notifySupers('appeal_forwarded', `Appeal ${a.reference} forwarded to QA`, `Appeal ${a.reference} has been reviewed by the Team Lead and is pending QA review.`, `/appeals/${a.id}`, a.id);
      this.notify(a.cam_id, 'appeal_forwarded', `Appeal ${a.reference} forwarded to QA`, `Your appeal ${a.reference} has been reviewed by your Team Lead and forwarded to QA.`, `/appeals/${a.id}`, a.id);
    }
  }
  async leadReviewAppeal(appealId: string, rec: LeadRecommendation, comment: string, internalNote?: string) {
    await delay(); this.leadReviewSync(appealId, rec, comment, internalNote); this.save();
  }
  async respondToAppealRequest(appealId: string, response: string) {
    await delay();
    const me = this.me(); const a = this.findAppeal(appealId);
    this.require(!!response && response.trim().length >= 5, 'Please enter a response');
    if (a.status === 'returned_to_cam') {
      this.require(a.cam_id === me.id, 'Only the CAM can respond');
      a.info_requested_from = null; a.info_due_at = null;
      this.setStatus(a, 'pending_lead_review');
      this.event(a.id, 'cam_responded', response, 'shared', 'returned_to_cam', 'pending_lead_review');
      this.notify(a.lead_id, 'appeal_submitted', `CAM responded on appeal ${a.reference}`, `The CAM has provided the requested information for appeal ${a.reference}.`, `/appeals/${a.id}`, a.id);
    } else if (a.status === 'pending_additional_info') {
      const okCam = a.info_requested_from === 'cam' && a.cam_id === me.id;
      const okLead = a.info_requested_from === 'lead' && me.role === 'admin' && (a.lead_id === me.id || this.isLeadOf(a.cam_id));
      this.require(okCam || okLead, 'You are not the person QA requested information from');
      a.info_requested_from = null; a.info_due_at = null;
      this.setStatus(a, 'pending_qa_review');
      this.event(a.id, me.id === a.cam_id ? 'cam_responded' : 'lead_responded', response, 'shared', 'pending_additional_info', 'pending_qa_review');
      this.notifySupers('appeal_forwarded', `Response received on appeal ${a.reference}`, `Requested information has been provided for appeal ${a.reference}.`, `/appeals/${a.id}`, a.id);
    } else throw new Error('No information has been requested on this appeal');
    this.save();
  }
  async addAppealComment(appealId: string, comment: string, internal: boolean) {
    await delay();
    const me = this.me(); const a = this.findAppeal(appealId);
    this.require(this.canViewAppeal(a), 'Not authorised');
    this.require(!(internal && me.role === 'user'), 'CAMs cannot add internal comments');
    this.require(!!comment && comment.trim().length >= 2, 'Comment is empty');
    this.event(a.id, 'comment', comment, internal ? 'internal' : 'shared', null, null);
    this.save();
  }
  private qaRequestInfoSync(appealId: string, from: 'cam' | 'lead', comment: string) {
    const me = this.me(); const a = this.findAppeal(appealId);
    this.require(me.role === 'super_admin', 'Only QA can request information');
    this.require(a.status === 'pending_qa_review', 'Appeal is not pending QA review');
    this.require(!!comment && comment.trim().length >= 5, 'Please describe the information needed');
    a.info_requested_from = from; a.info_due_at = addBusinessDays(new Date(), this.s.settings.sla.clarification_days).toISOString();
    this.setStatus(a, 'pending_additional_info');
    this.event(a.id, 'qa_requested_info', comment, 'shared', 'pending_qa_review', 'pending_additional_info');
    this.notify(from === 'cam' ? a.cam_id : a.lead_id, 'appeal_info_requested', `QA requested information on appeal ${a.reference}`, `QA needs additional information to decide appeal ${a.reference}.`, `/appeals/${a.id}`, a.id);
  }
  async qaRequestInfo(appealId: string, from: 'cam' | 'lead', comment: string) { await delay(); this.qaRequestInfoSync(appealId, from, comment); this.save(); }
  private qaDecideSync(appealId: string, decisions: QaDecisionInput[], resolution: string, extra: ExtraAdjustmentInput[] = []): AppealStatus {
    const me = this.me(); const a = this.findAppeal(appealId);
    this.require(me.role === 'super_admin', 'Only QA can decide appeals');
    this.require(a.status === 'pending_qa_review', `Appeal must be forwarded by the Team Lead before QA can decide (current status: ${a.status})`);
    this.require(!!resolution && resolution.trim().length >= 10, 'Resolution remarks are required (at least 10 characters)');
    const items = this.s.items.filter((i) => i.appeal_id === a.id);
    this.require(decisions.length === items.length, 'A decision is required for every disputed parameter');
    const ev = this.s.evaluations.find((x) => x.id === a.evaluation_id)!;
    // validate first (atomic like a DB transaction)
    for (const d of decisions) {
      const it = items.find((i) => i.id === d.item_id);
      this.require(!!it, 'Decision refers to an item that is not part of this appeal');
      this.require(d.decision === 'approved' || d.decision === 'rejected', 'Decision must be approved or rejected');
      if (d.decision === 'approved' && !it!.is_autofail) {
        const max = this.paramMax(ev.id, it!.parameter_id!);
        this.require(d.revised_score !== null && d.revised_score !== undefined && d.revised_score >= 0 && d.revised_score <= max, `Approved items need a revised score between 0 and ${max}`);
        this.require(this.effParam(ev.id, it!.parameter_id!) !== d.revised_score, 'Revised score equals the current score; reject the item instead');
      }
    }
    const approved = decisions.filter((d) => d.decision === 'approved').length;
    if (extra.length) {
      this.require(approved > 0, 'Additional score changes are only allowed when at least one item is approved');
      for (const x of extra) {
        const sc = ev.scores.find((y) => y.parameter_id === x.parameter_id);
        this.require(!!sc, 'Parameter is not part of this evaluation');
        this.require(x.revised_score >= 0 && x.revised_score <= sc!.max_score, `Revised score must be between 0 and ${sc!.max_score}`);
        this.require((x.reason ?? '').trim().length >= 5, 'A reason is required for each additional score change');
      }
    }
    for (const d of decisions) {
      const it = items.find((i) => i.id === d.item_id)!;
      const reason = d.reason?.trim() || resolution.trim();
      if (d.decision === 'approved') {
        if (it.is_autofail) {
          if (this.effAutofail(ev.id)) this.addAdjustment({ evaluation_id: ev.id, kind: 'autofail', parameter_id: null, original_value: 1, revised_value: 0, reason, appeal_id: a.id, approved_by: me.id });
        } else {
          this.addAdjustment({ evaluation_id: ev.id, kind: 'parameter', parameter_id: it.parameter_id, original_value: this.effParam(ev.id, it.parameter_id!) ?? 0,
            revised_value: d.revised_score!, reason, appeal_id: a.id, approved_by: me.id });
        }
        it.revised_score = it.is_autofail ? 0 : d.revised_score!;
      } else {
        const hadAdj = this.s.adjustments.some((x) => x.appeal_id === a.id && (it.is_autofail ? x.kind === 'autofail' : x.parameter_id === it.parameter_id));
        if (hadAdj) {
          if (it.is_autofail && !this.effAutofail(ev.id)) this.addAdjustment({ evaluation_id: ev.id, kind: 'autofail', parameter_id: null, original_value: 0, revised_value: 1, reason: 'Appeal re-decided: ' + resolution.trim(), appeal_id: a.id, approved_by: me.id });
          else if (!it.is_autofail && this.effParam(ev.id, it.parameter_id!) !== it.original_score)
            this.addAdjustment({ evaluation_id: ev.id, kind: 'parameter', parameter_id: it.parameter_id, original_value: this.effParam(ev.id, it.parameter_id!) ?? 0, revised_value: it.original_score ?? 0, reason: 'Appeal re-decided: ' + resolution.trim(), appeal_id: a.id, approved_by: me.id });
        }
        it.revised_score = null;
      }
      it.decision = d.decision; it.decision_reason = reason; it.decided_by = me.id; it.decided_at = nowIso();
    }
    for (const x of extra) {
      this.addAdjustment({ evaluation_id: ev.id, kind: 'parameter', parameter_id: x.parameter_id, original_value: this.effParam(ev.id, x.parameter_id) ?? 0, revised_value: x.revised_score, reason: x.reason.trim(), appeal_id: a.id, approved_by: me.id });
    }
    const rejected = decisions.length - approved;
    const final: AppealStatus = rejected === 0 ? 'approved' : approved === 0 ? 'rejected' : 'partially_approved';
    a.decided_at = nowIso(); a.decided_by = me.id; a.resolution_note = resolution.trim(); a.info_requested_from = null; a.info_due_at = null;
    this.setStatus(a, final);
    this.event(a.id, 'qa_decided', resolution, 'shared', 'pending_qa_review', final);
    const label = final.replace('_', ' ');
    this.notify(a.cam_id, 'appeal_decided', `Decision on appeal ${a.reference}`, `QA has made a final decision on appeal ${a.reference} (${label}).`, `/appeals/${a.id}`, a.id);
    this.notify(a.lead_id, 'appeal_decided', `Decision on appeal ${a.reference}`, `QA has made a final decision on appeal ${a.reference} (${label}).`, `/appeals/${a.id}`, a.id);
    if (approved > 0) this.notify(a.cam_id, 'score_changed', `Score updated for task ${ev.task_id.slice(0, 8)}`, `A finalized score was changed following appeal ${a.reference}.`, `/evaluations/${ev.id}`, a.id);
    return final;
  }
  async qaDecideAppeal(appealId: string, decisions: QaDecisionInput[], resolution: string, extra: ExtraAdjustmentInput[] = []) {
    await delay(); const r = this.qaDecideSync(appealId, decisions, resolution, extra); this.save(); return r;
  }
  async qaReopenAppeal(appealId: string, reason: string) {
    await delay();
    const me = this.me(); const a = this.findAppeal(appealId);
    this.require(me.role === 'super_admin', 'Only QA can reopen appeals');
    this.require(FINAL.includes(a.status), 'Only decided or closed appeals can be reopened');
    this.require(!(a.status === 'closed' && !a.forwarded_at), 'This appeal was withdrawn before Lead review and cannot be reopened by QA');
    this.require(!!reason && reason.trim().length >= 10, 'A reason is required to reopen');
    const from = a.status;
    this.s.items.filter((i) => i.appeal_id === a.id).forEach((i) => { i.decision = 'pending'; });
    this.setStatus(a, 'pending_qa_review');
    this.event(a.id, 'qa_reopened', reason, 'shared', from, 'pending_qa_review');
    this.notify(a.cam_id, 'appeal_reopened', `Appeal ${a.reference} reopened`, `QA has reopened appeal ${a.reference} for further review.`, `/appeals/${a.id}`, a.id);
    this.notify(a.lead_id, 'appeal_reopened', `Appeal ${a.reference} reopened`, `QA has reopened appeal ${a.reference} for further review.`, `/appeals/${a.id}`, a.id);
    this.save();
  }
  async closeAppeal(appealId: string, reason: string) {
    await delay();
    const me = this.me(); const a = this.findAppeal(appealId);
    if (me.role === 'super_admin') this.require(a.status !== 'closed', 'Appeal is already closed');
    else if (a.cam_id === me.id) this.require(['draft', 'pending_lead_review', 'returned_to_cam'].includes(a.status), 'You can only withdraw an appeal before it is forwarded to QA');
    else throw new Error('Not authorised');
    this.require(!!reason && reason.trim().length >= 3, 'Please give a reason');
    const from = a.status;
    this.setStatus(a, 'closed');
    this.event(a.id, 'closed', reason, 'shared', from, 'closed');
    if (me.id !== a.cam_id) this.notify(a.cam_id, 'appeal_decided', `Appeal ${a.reference} closed`, `Appeal ${a.reference} has been closed.`, `/appeals/${a.id}`, a.id);
    this.save();
  }
  async grantResubmission(evaluationId: string, parameterId: string | null, isAutofail: boolean, reason: string) {
    await delay();
    const me = this.me();
    this.require(me.role === 'super_admin', 'Only QA can grant resubmissions');
    this.require(!!reason && reason.trim().length >= 5, 'A reason is required');
    const g = { id: uid(), evaluation_id: evaluationId, parameter_id: isAutofail ? null : parameterId, is_autofail: isAutofail, used_at: null };
    this.s.grants.push(g);
    this.log('insert', 'appeal_resubmission_grants', g.id, null, { ...g, reason });
    this.save();
  }
  async uploadEvidence(appealId: string, file: File) {
    const a = this.findAppeal(appealId);
    this.require(this.canViewAppeal(a), 'Not authorised');
    this.require(!FINAL.includes(a.status), 'Evidence can only be added while the appeal is open');
    this.require(ALLOWED_MIME.includes(file.type), `File type ${file.type || 'unknown'} is not allowed`);
    this.require(file.size > 0 && file.size <= 10 * 1024 * 1024, 'Files must be 10 MB or smaller');
    this.require(file.size <= 1.5 * 1024 * 1024, 'Demo mode stores files in your browser: please use files under 1.5 MB');
    const data_url = await new Promise<string>((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.onerror = () => rej(fr.error); fr.readAsDataURL(file); });
    const me = this.me();
    this.s.evidence.push({ id: uid(), appeal_id: a.id, storage_path: `${a.id}/${uid()}-${file.name}`, file_name: file.name, mime_type: file.type, size_bytes: file.size, uploaded_by: me.id, created_at: nowIso(), data_url });
    this.event(a.id, 'evidence_added', `Attached ${file.name}`, 'shared', null, null);
    this.save();
  }
  async evidenceUrl(storagePath: string) {
    const ev = this.s.evidence.find((x) => x.storage_path === storagePath);
    const a = ev ? this.s.appeals.find((x) => x.id === ev.appeal_id) : undefined;
    this.require(!!ev && !!a && this.canViewAppeal(a!), 'Not authorised');
    return ev!.data_url;
  }

  // ------------------------------------------------------------------ admin
  private requireSuper(msg = 'Only QA Super Admins can do this') { this.require(this.me().role === 'super_admin', msg); }
  async adminAdjustScore(evaluationId: string, parameterId: string | null, revised: number, reason: string) {
    await delay();
    this.requireSuper('Only QA Super Admins can change finalized scores');
    this.require(!!reason && reason.trim().length >= 10, 'A reason (min 10 characters) is required');
    const ev = this.s.evaluations.find((x) => x.id === evaluationId);
    this.require(!!ev, 'Evaluation not found');
    const me = this.me();
    if (parameterId === null) {
      this.require(revised === 0 || revised === 1, 'Autofail value must be 0 (no) or 1 (yes)');
      const cur = this.effAutofail(ev!.id) ? 1 : 0;
      this.require(cur !== revised, 'No change');
      this.addAdjustment({ evaluation_id: ev!.id, kind: 'autofail', parameter_id: null, original_value: cur, revised_value: revised, reason: reason.trim(), appeal_id: null, approved_by: me.id });
    } else {
      const sc = ev!.scores.find((x) => x.parameter_id === parameterId);
      this.require(!!sc, 'Parameter is not part of this evaluation');
      this.require(revised >= 0 && revised <= sc!.max_score, `Score must be between 0 and ${sc!.max_score}`);
      const cur = this.effParam(ev!.id, parameterId);
      this.require(cur !== revised, 'No change');
      this.addAdjustment({ evaluation_id: ev!.id, kind: 'parameter', parameter_id: parameterId, original_value: cur ?? 0, revised_value: revised, reason: reason.trim(), appeal_id: null, approved_by: me.id });
    }
    this.notify(ev!.cam_id, 'score_changed', `Score updated for task ${ev!.task_id.slice(0, 8)}`, 'QA updated a finalized score on one of your evaluations.', `/evaluations/${ev!.id}`, null);
    this.save();
  }
  async setPeriodStatus(periodId: string, status: 'draft' | 'published') {
    await delay();
    this.requireSuper('Only QA can publish reports');
    const p = this.s.periods.find((x) => x.id === periodId)!;
    const prev = clone(p);
    const becamePublished = status === 'published' && p.status !== 'published';
    p.status = status;
    if (status === 'published' && !p.published_at) p.published_at = nowIso();
    this.log('update', 'reporting_periods', p.id, prev, clone(p));
    if (becamePublished) {
      const cams = new Set(this.s.evaluations.filter((e) => e.period_id === p.id).map((e) => e.cam_id));
      cams.forEach((c) => this.notify(c, 'report_published', `Your QA report for ${p.short_label} is available`, `Your weekly CS QA report for ${p.label} has been published.`, `/dashboard?period=${p.id}`, null));
    }
    this.save();
  }
  async upsertPeriod(p: Partial<Period> & { label: string; start_date: string; end_date: string }) {
    await delay();
    this.requireSuper();
    this.require(p.end_date >= p.start_date, 'End date must be on or after start date');
    const existing = this.s.periods.find((x) => x.id === p.id || x.label === p.label);
    if (existing) { const prev = clone(existing); Object.assign(existing, p); this.log('update', 'reporting_periods', existing.id, prev, clone(existing)); }
    else {
      const row: Period = { id: uid(), short_label: p.short_label ?? p.label.split(' ')[0], year: Number(p.start_date.slice(0, 4)), week_number: p.week_number ?? 0,
        status: 'draft', published_at: null, auto_publish_at: p.auto_publish_at ?? null, ...p } as Period;
      this.s.periods.push(row); this.log('insert', 'reporting_periods', row.id, null, row);
    }
    this.save();
  }
  async updateSetting<K extends keyof PortalSettings>(key: K, value: PortalSettings[K]) {
    await delay();
    this.requireSuper();
    const prev = clone(this.s.settings[key]);
    this.s.settings[key] = clone(value);
    this.log('update', 'settings', key, { key, value: prev }, { key, value });
    this.save();
  }
  async updateParameter(id: string, patch: Partial<Parameter>) {
    await delay();
    this.requireSuper();
    const p = this.s.parameters.find((x) => x.id === id)!;
    if (patch.max_score !== undefined) this.require(patch.max_score > 0, 'Maximum score must be greater than 0');
    const prev = clone(p); Object.assign(p, patch);
    this.log('update', 'evaluation_parameters', id, prev, clone(p));
    this.save();
  }
  async createParameter(p: Omit<Parameter, 'id'>) {
    await delay();
    this.requireSuper();
    this.require(p.max_score > 0, 'Maximum score must be greater than 0');
    this.require(!this.s.parameters.some((x) => x.task_type === p.task_type && x.name.toLowerCase() === p.name.toLowerCase()), 'A parameter with this name already exists for the task type');
    const row = { ...p, id: uid() };
    this.s.parameters.push(row); this.log('insert', 'evaluation_parameters', row.id, null, row); this.save();
  }
  async upsertEmployee(e: Partial<Employee> & { email: string; full_name: string; role: Role }) {
    await delay();
    this.requireSuper();
    const email = e.email.trim().toLowerCase();
    this.require(/^[^@\s]+@[^@\s]+$/.test(email), 'Enter a valid email address');
    const dupe = this.s.employees.find((x) => x.email === email && x.id !== e.id);
    this.require(!dupe, 'An account with this email already exists');
    if (e.id) {
      const row = this.s.employees.find((x) => x.id === e.id)!;
      const prev = clone(row); Object.assign(row, { ...e, email });
      this.log('update', 'employees', row.id, prev, clone(row));
    } else {
      const row: Employee = { id: uid(), status: 'active', team_id: null, ...e, email, is_demo: true };
      this.s.employees.push(row); this.s.passwords[email] = DEMO_PASSWORD;
      this.log('insert', 'employees', row.id, null, row);
    }
    this.save();
  }
  async inviteUser(employeeId: string) {
    await delay(300);
    this.requireSuper();
    const e = this.s.employees.find((x) => x.id === employeeId)!;
    this.log('invite', 'employees', e.id, null, { email: e.email, note: 'Demo mode: no email is sent. Password is ' + DEMO_PASSWORD });
    this.save();
  }
  async upsertTeam(t: Partial<Team> & { name: string }) {
    await delay();
    this.requireSuper();
    this.require(t.name.trim().length > 1, 'Team name is required');
    this.require(!this.s.teams.some((x) => x.name.toLowerCase() === t.name.trim().toLowerCase() && x.id !== t.id), 'A team with this name already exists');
    if (t.lead_id) this.require(this.s.employees.find((x) => x.id === t.lead_id)?.role === 'admin', 'The Team Lead must have the Admin role');
    if (t.id) { const row = this.s.teams.find((x) => x.id === t.id)!; const prev = clone(row); Object.assign(row, { name: t.name.trim(), lead_id: t.lead_id ?? null }); this.log('update', 'teams', row.id, prev, clone(row)); }
    else { const row = { id: uid(), name: t.name.trim(), lead_id: t.lead_id ?? null }; this.s.teams.push(row); this.log('insert', 'teams', row.id, null, row); }
    this.save();
  }
  async deleteTeam(id: string) {
    await delay();
    this.requireSuper();
    this.require(!this.s.employees.some((e) => e.team_id === id), 'Move the CAMs to another team before deleting this team');
    const row = this.s.teams.find((x) => x.id === id);
    this.s.teams = this.s.teams.filter((x) => x.id !== id);
    this.log('delete', 'teams', id, row, null);
    this.save();
  }
  async importEvaluations(rows: ImportRow[], meta: { source: 'csv' | 'xlsx' | 'google_sheets'; file_name: string; publish_new_periods: boolean }, onProgress?: (d: number, t: number) => void) {
    this.requireSuper('Only QA Super Admins can import evaluations');
    const me = this.me();
    const batch: ImportBatch = { id: uid(), source: meta.source, file_name: meta.file_name, uploaded_by: me.id, total_rows: 0, inserted: 0, duplicates: 0, rejected: 0, created_at: nowIso() };
    this.s.batches.unshift(batch);
    const reject = (row_number: number, reason: string) => { batch.rejected++; this.s.rejections.push({ batch_id: batch.id, row_number, reason }); };
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      batch.total_rows++;
      const params = this.s.parameters.filter((p) => p.task_type === r.task_type && p.active);
      if (!this.s.taskTypes.some((t) => t.code === r.task_type)) { reject(r.row_number, 'Unknown task type'); continue; }
      const missing = params.filter((p) => !r.scores.some((x) => x.parameter_id === p.id)).length;
      if (missing) { reject(r.row_number, `${missing} scoring parameter(s) missing for this task type`); continue; }
      let cam = this.s.employees.find((e) => e.email === r.cam_email.toLowerCase());
      if (!cam) {
        cam = { id: uid(), email: r.cam_email.toLowerCase(), full_name: r.cam_name ?? r.cam_email, role: 'user', status: 'active', team_id: null, is_demo: true };
        this.s.employees.push(cam); this.s.passwords[cam.email] = DEMO_PASSWORD;
      }
      if (r.lead_name && !cam.team_id) {
        const t = this.s.teams.find((x) => this.s.employees.find((e) => e.id === x.lead_id)?.full_name.toLowerCase() === r.lead_name!.trim().toLowerCase());
        if (t) cam.team_id = t.id;
      }
      let period = this.s.periods.find((p) => p.label === r.period.label);
      if (!period) {
        period = { id: uid(), label: r.period.label, short_label: r.period.short_label, year: r.period.year, week_number: r.period.week, start_date: r.period.start,
          end_date: r.period.end, status: meta.publish_new_periods ? 'published' : 'draft', published_at: meta.publish_new_periods ? nowIso() : null, auto_publish_at: null };
        this.s.periods.push(period);
      }
      if (this.s.evaluations.some((e) => e.task_link === r.task_link && e.cam_id === cam!.id && e.period_id === period!.id)) { batch.duplicates++; continue; }
      const evaluator = r.evaluator_email ? this.s.employees.find((e) => e.email === r.evaluator_email) : undefined;
      this.s.evaluations.push({
        id: uid(), task_id: r.task_id, task_link: r.task_link, cam_id: cam.id, evaluator_id: evaluator?.id ?? null, evaluator_email: r.evaluator_email,
        evaluator_name: r.evaluator_name, task_type: r.task_type, request_from: r.request_from, task_loaded_date: r.task_loaded_date, audited_at: r.audited_at,
        period_id: period.id, task_seq: r.task_seq, connection_id: r.connection_id, screenshot_url: r.screenshot_url, autofail: r.autofail, fcr: r.fcr,
        original_score: r.score, feedback: r.feedback, lead_name_at_audit: r.lead_name,
        scores: r.scores.map((x) => ({ id: uid(), parameter_id: x.parameter_id, earned: x.earned, max_score: params.find((p) => p.id === x.parameter_id)!.max_score, remarks: null })),
      });
      batch.inserted++;
      if (i % 200 === 0) { onProgress?.(i, rows.length); await delay(1); }
    }
    onProgress?.(rows.length, rows.length);
    this.log('import', 'import_batches', batch.id, null, { rows: batch.total_rows, inserted: batch.inserted, duplicates: batch.duplicates, rejected: batch.rejected });
    this.save();
    return { batch_id: batch.id, total: batch.total_rows, inserted: batch.inserted, duplicates: batch.duplicates, rejected: batch.rejected };
  }
  async syncGoogleSheet(): Promise<never> {
    throw new Error('Google Sheets sync needs the sheets-sync Edge Function and a service account. It is not available in the demo — use CSV/XLSX upload instead.');
  }
  async listImportBatches() { this.requireSuper(); return clone(this.s.batches); }
  async listImportRejections(batchId: string) { this.requireSuper(); return this.s.rejections.filter((r) => r.batch_id === batchId).map(({ row_number, reason }) => ({ row_number, reason })); }
  async listAuditLogs(opts: { limit: number; offset: number; table?: string; action?: string }) {
    this.requireSuper();
    const names = new Map(this.s.employees.map((e) => [e.id, e.full_name]));
    return this.s.audit.filter((a) => (!opts.table || a.table_name === opts.table) && (!opts.action || a.action === opts.action))
      .slice(opts.offset, opts.offset + opts.limit).map((a) => ({ ...clone(a), actor_name: a.actor_id ? names.get(a.actor_id) ?? null : 'System' }));
  }

  // ------------------------------------------------------------------ weekly report emails & team mapping
  async weeklyEmailPreview(periodId: string): Promise<WeeklyEmailRow[]> {
    await delay(40);
    this.requireSuper('Only QA can send weekly report emails');
    const cams = [...new Set(this.s.evaluations.filter((e) => e.period_id === periodId).map((e) => e.cam_id))];
    return cams.map((id) => {
      const c = this.s.employees.find((e) => e.id === id)!;
      const t = this.s.teams.find((x) => x.id === c.team_id);
      const l = t?.lead_id ? this.s.employees.find((e) => e.id === t.lead_id) : undefined;
      const last = this.s.weeklyEmails.filter((w) => w.period_id === periodId && w.cam_id === id).pop();
      return { cam_id: id, cam_name: c.full_name, cam_email: c.email, cam_active: c.status === 'active', lead_name: l?.full_name ?? null,
        lead_email: l?.status === 'active' ? l.email : null, tasks: this.s.evaluations.filter((e) => e.period_id === periodId && e.cam_id === id).length,
        last_status: last?.status ?? null, last_sent_at: last?.queued_at ?? null, last_error: null, last_queued_at: last?.queued_at ?? null };
    }).sort((a, b) => a.cam_name.localeCompare(b.cam_name));
  }
  async sendWeeklyEmails(periodId: string, camIds: string[] | null, resend: boolean) {
    await delay(400);
    this.requireSuper('Only QA can send weekly report emails');
    const p = this.s.periods.find((x) => x.id === periodId)!;
    this.require(p.status === 'published', `Publish ${p.short_label} before emailing CAMs — the report link would show nothing yet`);
    const rows = (await this.weeklyEmailPreview(periodId)).filter((r) => !camIds || camIds.includes(r.cam_id));
    let queued = 0, skipped = 0, no_email = 0;
    const cfg = this.s.settings.report_email;
    for (const r of rows) {
      if (!r.cam_active || !r.cam_email) { no_email++; continue; }
      if (!resend && r.last_status) { skipped++; continue; }
      const { subject } = renderReportEmail(this.s.settings, p, r.cam_name);
      const cc = [cfg.cc_lead ? r.lead_email : null, cfg.extra_cc.trim() || null].filter(Boolean).join(', ') || null;
      this.s.weeklyEmails.push({ period_id: periodId, cam_id: r.cam_id, to: r.cam_email, cc, subject, status: 'sent', queued_at: nowIso() });
      queued++;
    }
    this.log('weekly_emails_queued', 'reporting_periods', periodId, null, { week: p.short_label, queued, skipped_already_sent: skipped, no_email, note: 'Demo mode: no email is delivered' });
    this.save();
    return { queued, skipped, no_email, sent: queued, failed: 0, failures: [] };
  }
  async importTeamMapping(rows: TeamMappingRow[]): Promise<TeamMappingResult> {
    await delay(100);
    this.requireSuper('Only QA Super Admins can import the team mapping');
    const res: TeamMappingResult = { rows: 0, new_leads: 0, new_teams: 0, new_cams: 0, reassigned: 0, rejected: 0, errors: [] };
    const valid = (e?: string) => !!e && /^[^@\s]+@[^@\s]+$/.test(e);
    for (const r of rows) {
      res.rows++;
      if (!valid(r.cam_email) || !valid(r.lead_email)) { res.rejected++; res.errors.push({ row: res.rows, reason: 'CAM email and Lead email are required' }); continue; }
      let lead = this.s.employees.find((e) => e.email === r.lead_email.trim().toLowerCase());
      if (!lead) { lead = { id: uid(), email: r.lead_email.trim().toLowerCase(), full_name: r.lead_name?.trim() || r.lead_email.split('@')[0], role: 'admin', status: 'active', team_id: null, is_demo: true }; this.s.employees.push(lead); this.s.passwords[lead.email] = DEMO_PASSWORD; res.new_leads++; }
      else if (lead.role === 'user') lead.role = 'admin';
      const tname = r.team?.trim() || `Team ${lead.full_name}`;
      let team = this.s.teams.find((t) => t.name.toLowerCase() === tname.toLowerCase());
      if (!team) { team = { id: uid(), name: tname, lead_id: lead.id }; this.s.teams.push(team); res.new_teams++; } else team.lead_id = lead.id;
      let cam = this.s.employees.find((e) => e.email === r.cam_email.trim().toLowerCase());
      if (!cam) { cam = { id: uid(), email: r.cam_email.trim().toLowerCase(), full_name: r.cam_name?.trim() || r.cam_email.split('@')[0], role: 'user', status: 'active', team_id: team.id, is_demo: true }; this.s.employees.push(cam); this.s.passwords[cam.email] = DEMO_PASSWORD; res.new_cams++; }
      else if (cam.team_id !== team.id) { cam.team_id = team.id; res.reassigned++; }
    }
    this.log('import', 'teams', null, null, res);
    this.save();
    return res;
  }

  // ------------------------------------------------------------------ notifications
  async listNotifications() {
    const me = this.meOrNull();
    if (!me) return [];
    return clone(this.s.notifications.filter((n) => n.recipient_id === me.id).slice(0, 100)).map(({ recipient_id: _r, ...n }) => { void _r; return n; });
  }
  async markNotificationsRead(ids?: string[]) {
    const me = this.me();
    this.s.notifications.forEach((n) => { if (n.recipient_id === me.id && !n.read_at && (!ids || ids.includes(n.id))) n.read_at = nowIso(); });
    this.save();
  }

  // demo helpers
  demoAccounts() {
    return this.s.employees.filter((e) => e.status === 'active').map((e) => ({ email: e.email, name: e.full_name, role: e.role,
      team: this.s.teams.find((t) => t.id === e.team_id)?.name ?? (e.role === 'admin' ? this.s.teams.find((t) => t.lead_id === e.id)?.name ?? '' : '') }));
  }
}
