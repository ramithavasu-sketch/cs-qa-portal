import { describe, expect, it } from 'vitest';
import { DemoRepo } from '../src/data/demoRepo';
import { DEMO_PASSWORD } from '../src/demo/generate';

describe('demo backend mirrors production access rules', async () => {
  const r = new DemoRepo();
  const accounts = r.demoAccounts();
  const cam = accounts.find((a) => a.role === 'user')!;
  const qa = accounts.find((a) => a.role === 'super_admin')!;

  it('CAM sees only own evaluations and no draft weeks', async () => {
    const me = await r.signIn(cam.email, DEMO_PASSWORD);
    const evals = await r.getEvaluations({});
    expect(evals.length).toBeGreaterThan(0);
    expect(evals.every((e) => e.cam_id === me.id && e.period_status === 'published')).toBe(true);
    expect((await r.getEmployees()).filter((e) => e.role === 'user').map((e) => e.id)).toEqual([me.id]);
    await expect(r.listAuditLogs({ limit: 5, offset: 0 })).rejects.toThrow();
  });
  it('seeded appeals cover every required state', async () => {
    await r.signIn(qa.email, DEMO_PASSWORD);
    const st = new Set((await r.listAppeals()).map((a) => a.status));
    for (const s of ['pending_lead_review', 'pending_qa_review', 'approved', 'partially_approved', 'rejected', 'pending_additional_info', 'returned_to_cam']) expect(st.has(s as never)).toBe(true);
  });
  it('QA cannot decide an appeal still awaiting Lead review', async () => {
    await r.signIn(qa.email, DEMO_PASSWORD);
    const a = (await r.listAppeals({ statuses: ['pending_lead_review'] }))[0];
    const d = await r.getAppeal(a.id);
    await expect(r.qaDecideAppeal(a.id, d!.items.map((i) => ({ item_id: i.id, decision: 'rejected' })), 'Trying to skip the lead')).rejects.toThrow(/forwarded by the Team Lead/);
  });
  it('approved appeals recalculate the score and keep the original', async () => {
    await r.signIn(qa.email, DEMO_PASSWORD);
    const a = (await r.listAppeals({ statuses: ['approved'] }))[0];
    const e = await r.getEvaluation(a.evaluation_id);
    expect(e!.adjusted).toBe(true);
    expect(e!.score).toBeGreaterThan(e!.original_score);
    expect((await r.getAdjustments(e!.id)).length).toBeGreaterThan(0);
  });
});
