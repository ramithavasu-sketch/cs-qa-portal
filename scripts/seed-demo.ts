// Loads the FICTIONAL demo dataset into a *development* Supabase project.
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... SUPABASE_ANON_KEY=... npx tsx scripts/seed-demo.ts
// Never run against production: every record is flagged is_demo=true, demo users use
// the @demo.csqa.test domain, and scripts/purge-demo.sql removes them again.
import { createClient } from '@supabase/supabase-js';
import { generateDemoSeed, DEMO_PASSWORD } from '../src/demo/generate';

const url = process.env.SUPABASE_URL!, service = process.env.SUPABASE_SERVICE_ROLE_KEY!, anon = process.env.SUPABASE_ANON_KEY!;
if (!url || !service || !anon) throw new Error('Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY');
if (process.env.CONFIRM_DEV_PROJECT !== 'yes') throw new Error('Set CONFIRM_DEV_PROJECT=yes to confirm this is a development project');
const admin = createClient(url, service, { auth: { persistSession: false } });
const seed = generateDemoSeed();
const ok = <T,>(r: { data: T; error: { message: string } | null }): NonNullable<T> => { if (r.error) throw new Error(r.error.message); return r.data as NonNullable<T>; };

// 1. people & teams (ids preserved so the evaluation rows line up)
ok(await admin.from('employees').upsert(seed.employees.map((e) => ({ id: e.id, email: e.email, full_name: e.full_name, role: e.role, status: e.status, is_demo: true })), { onConflict: 'email' }));
ok(await admin.from('teams').upsert(seed.teams.map((t) => ({ ...t, is_demo: true })), { onConflict: 'name' }));
for (const e of seed.employees.filter((x) => x.team_id)) ok(await admin.from('employees').update({ team_id: e.team_id }).eq('id', e.id));
// 2. auth users (linked to employees by the on_auth_user_created trigger)
for (const e of seed.employees) {
  const r = await admin.auth.admin.createUser({ email: e.email, password: DEMO_PASSWORD, email_confirm: true });
  if (r.error && !/already/i.test(r.error.message)) throw r.error;
}
// 3. evaluations through the validated import RPC
const lead = (camId: string) => { const t = seed.teams.find((x) => x.id === seed.employees.find((e) => e.id === camId)?.team_id); return seed.employees.find((e) => e.id === t?.lead_id)?.full_name ?? null; };
const rows = seed.evaluations.map((e, i) => {
  const p = seed.periods.find((x) => x.id === e.period_id)!;
  const cam = seed.employees.find((x) => x.id === e.cam_id)!;
  return { row_number: i + 2, task_link: e.task_link, task_id: e.task_id, cam_email: cam.email, cam_name: cam.full_name, lead_name: lead(cam.id),
    evaluator_email: e.evaluator_email, evaluator_name: e.evaluator_name, task_type: e.task_type, request_from: e.request_from, task_loaded_date: e.task_loaded_date,
    audited_at: e.audited_at, period: { label: p.label, short_label: p.short_label, year: p.year, week: p.week_number, start: p.start_date, end: p.end_date },
    task_seq: e.task_seq, connection_id: e.connection_id, screenshot_url: null, autofail: e.autofail, fcr: e.fcr, score: e.original_score, feedback: e.feedback,
    scores: e.scores.map((s) => ({ parameter_id: s.parameter_id, earned: s.earned })) };
});
let batch_id: string | null = null;
for (let i = 0; i < rows.length; i += 400) {
  const r = ok(await admin.rpc('import_evaluations', { p_payload: { batch_id, source: 'seed', file_name: 'demo seed', publish_new_periods: false, is_demo: true, rows: rows.slice(i, i + 400) } })) as { batch_id: string; inserted: number; rejected: number };
  batch_id = r.batch_id; console.log(`imported ${r.inserted}, rejected ${r.rejected}`);
}
// 4. publish all but the in-progress week
for (const p of seed.periods.filter((x) => x.status === 'published')) {
  ok(await admin.from('reporting_periods').update({ status: 'published', published_at: p.published_at, is_demo: true }).eq('label', p.label));
}
// 5. sample appeals, created through the real RPCs as each actor
const as = async (email: string) => { const c = createClient(url, anon, { auth: { persistSession: false } }); const s = await c.auth.signInWithPassword({ email, password: DEMO_PASSWORD }); if (s.error) throw s.error; return c; };
const { data: evs } = await admin.from('v_evaluations_effective').select('id, cam_email, score, autofail, period_id').eq('is_demo', true).lt('score', 100).eq('autofail', false);
const lastWeek = seed.periods.filter((p) => p.status === 'published').pop()!;
const { data: lw } = await admin.from('reporting_periods').select('id').eq('label', lastWeek.label).single();
const target = (evs ?? []).filter((e) => e.period_id === lw!.id);
const qaEmail = seed.employees.find((e) => e.role === 'super_admin')!.email;
const leadEmail = (camEmail: string) => { const c = seed.employees.find((e) => e.email === camEmail)!; const t = seed.teams.find((x) => x.id === c.team_id)!; return seed.employees.find((e) => e.id === t.lead_id)!.email; };
const deducted = async (evalId: string) => ((await admin.from('evaluation_scores').select('parameter_id, earned, max_score').eq('evaluation_id', evalId)).data ?? []).filter((s) => Number(s.earned) < Number(s.max_score)).map((s) => s.parameter_id);
const scenarios = ['pending_lead', 'forwarded', 'approved', 'partial', 'rejected', 'need_info'] as const;
for (const [i, sc] of scenarios.entries()) {
  const e = target[i]; if (!e) break;
  const params = await deducted(e.id);
  const cam = await as(e.cam_email);
  const appealId = ok(await cam.rpc('submit_appeal', { p_evaluation_id: e.id, p_reason: 'Demo appeal: the task notes show this step was completed as required.', p_items: params.slice(0, sc === 'partial' ? 2 : 1).map((p) => ({ parameter_id: p })), p_as_draft: false })) as string;
  if (sc === 'pending_lead') continue;
  const ld = await as(leadEmail(e.cam_email));
  ok(await ld.rpc('lead_review_appeal', { p_appeal: appealId, p_recommendation: sc === 'rejected' ? 'recommend_rejection' : 'recommend_approval', p_comment: 'Reviewed the task notes (demo).', p_internal_note: null }));
  if (sc === 'forwarded') continue;
  const qa = await as(qaEmail);
  if (sc === 'need_info') { ok(await qa.rpc('qa_request_info', { p_appeal: appealId, p_from: 'cam', p_comment: 'Please share timestamps (demo).' })); continue; }
  const { data: items } = await admin.from('appeal_items').select('id, parameter_id').eq('appeal_id', appealId);
  const max = async (pid: string) => Number((await admin.from('evaluation_scores').select('max_score').eq('evaluation_id', e.id).eq('parameter_id', pid).single()).data!.max_score);
  const decisions = [];
  for (const [k, it] of (items ?? []).entries()) {
    const approve = sc === 'approved' || (sc === 'partial' && k === 0);
    decisions.push(approve ? { item_id: it.id, decision: 'approved', revised_score: await max(it.parameter_id) } : { item_id: it.id, decision: 'rejected' });
  }
  ok(await qa.rpc('qa_decide_appeal', { p_appeal: appealId, p_decisions: decisions, p_resolution: 'Demo decision recorded by QA.', p_extra_adjustments: [] }));
}
console.log('Demo data loaded. Sign in with any @demo.csqa.test account, password', DEMO_PASSWORD);
