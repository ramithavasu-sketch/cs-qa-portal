// Google version, server side: runs google/Code.js in a simulated Apps Script runtime with the real
// sheet exports (kept in this sandbox only) and checks access rules, the appeal workflow, emails,
// scheduled jobs, storage and limits. No names or scores are printed.
import { createGas } from './gas-sim.mjs';
import { existsSync } from 'node:fs';

const LIVE = '/home/claude/research/live.csv', A2022 = '/home/claude/research/archive2022.csv';
if (!existsSync(LIVE)) { console.log('skipped: real sheet exports are not available here'); process.exit(0); }
// Real sheet IDs come from the environment (they are not kept in the public source).
const LIVE_ID = process.env.VITE_LIVE_SHEET_ID ?? 'live-sheet-id', LIVE_GID = process.env.VITE_LIVE_SHEET_GID ?? '0', ARCHIVE_ID = process.env.VITE_ARCHIVE_SHEET_ID ?? 'archive-sheet-id';
const OWNER = 'qa.owner@example.com';
const SHEETS = {
  [LIVE_ID]: [{ gid: Number(LIVE_GID), title: 'Form Responses 1', csv: LIVE }],
  [ARCHIVE_ID]: [{ gid: 11, title: 'Archived Data 2022', csv: A2022 }],
};
let fails = 0;
const ok = (c, m) => { if (c) console.log('ok  ', m); else { fails++; console.log('FAIL', m); } };
const throws = (fn, re, m) => { try { fn(); ok(false, `${m} (no error)`); } catch (e) { ok(!re || re.test(e.message), `${m} — "${e.message.slice(0, 90)}"`); } };
const t0 = Date.now();

const gas = createGas({ owner: OWNER, sheets: SHEETS });
gas.as(OWNER);

// ---------- first run
ok(gas.call('whoami').me?.role === 'super_admin', 'owner becomes the first Super Admin on first visit');
gas.as('someone.else@example.com');
ok(gas.call('whoami').me === null, 'a colleague who was not added gets no access');
throws(() => gas.call('getEvaluations', {}), /Not authorised/, 'colleague not added cannot read audits');
gas.as('outsider@gmail.com');
ok(gas.call('whoami').me === null, 'account outside the company domain gets no access');
gas.as('');
ok(gas.call('whoami').me === null && gas.call('whoami').email === null, 'no Google identity → no access');
gas.as(OWNER);

// ---------- sync
let t = Date.now();
const live = gas.call('syncGoogleSheet', ['live'])[0];
ok(live.inserted === 11594 && live.rejected === 11 && !live.error, `live sheet: ${live.inserted} audits loaded in ${Date.now() - t} ms (11 rejected by validation)`);
t = Date.now();
const arch = gas.call('syncGoogleSheet', ['archive-1'])[0];
ok(arch.inserted === 7220 && !arch.error, `2022 archive: ${arch.inserted} audits loaded in ${Date.now() - t} ms`);
const again = gas.call('syncGoogleSheet', ['live'])[0];
ok(again.inserted === 0 && again.duplicates === 11594, 'syncing again adds nothing (no duplicates)');
const miss = gas.call('syncGoogleSheet', ['archive-2'])[0];
ok(/cannot open|not found/.test(miss.error ?? ''), 'a sheet the owner can’t open gives a clear message');
const periods = gas.call('getPeriods').sort((a, b) => a.start_date.localeCompare(b.start_date));
const drafts = periods.filter((p) => p.status === 'draft');
ok(drafts.length >= 1 && drafts.length <= 2, `first sync publishes past weeks; the last ${drafts.length} week(s) stay drafts for QA`);
const parts = JSON.parse(gas.props.get('CSQA_PARTS'));
ok(parts.includes('core') && parts.includes('evals-2026') && parts.includes('evals-2022'), `data stored as ${parts.length} files in the private Drive folder (${Math.round(gas.dataSize() / 1024)} KB compressed)`);

// ---------- people: pick a real team with at least 2 CAMs, give its Lead a test email
const emps = gas.call('getEmployees'), teams = gas.call('getTeams');
const team = teams.find((tm) => emps.filter((e) => e.team_id === tm.id && e.role === 'user' && e.status === 'active').length >= 2);
const lead = emps.find((e) => e.id === team.lead_id);
gas.call('upsertEmployee', { ...lead, email: 'test.lead@example.com' });
const LEAD = 'test.lead@example.com';
const pub = periods.filter((p) => p.status === 'published');
const recent = pub.slice(-6).map((p) => p.id);
const allRecent = gas.call('getEvaluations', { periodIds: recent });
const camIds = [...new Set(allRecent.filter((e) => e.team_id === team.id).map((e) => e.cam_id))];
const cam = emps.find((e) => e.id === camIds[0]); const other = emps.find((e) => e.id === camIds[1]);
const outsiderCam = emps.find((e) => e.role === 'user' && e.status === 'active' && e.team_id && e.team_id !== team.id && allRecent.some((x) => x.cam_id === e.id));
const CAM = cam.email;
throws(() => gas.call('upsertEmployee', { email: 'x@example.com', full_name: 'X', role: 'bogus' }), /valid role/, 'invalid role is refused');
throws(() => gas.call('upsertEmployee', { ...emps.find((e) => e.email === OWNER), role: 'user' }), /own Super Admin/, 'you can’t accidentally remove your own Super Admin access');

// ---------- CAM isolation
gas.as(CAM);
ok(gas.call('whoami').me?.id === cam.id, 'CAM is recognised from their Google account');
const mine = gas.call('getEvaluations', {});
ok(mine.length > 0 && mine.every((e) => e.cam_id === cam.id), `CAM sees only their own audits (${mine.length})`);
ok(mine.every((e) => e.period_status === 'published'), 'CAM sees only published weeks');
ok(gas.call('getPeriods').every((p) => p.status === 'published'), 'CAM does not see draft weeks');
const otherEval = allRecent.find((e) => e.cam_id === other.id);
ok(gas.call('getEvaluation', otherEval.id) === null, 'CAM cannot open a teammate’s audit by id');
ok(gas.call('getEvaluations', { camIds: [other.id], periodIds: recent }).length === 0, 'CAM asking for a teammate’s audits gets nothing');
ok(!gas.call('getEmployees').some((e) => e.role === 'user' && e.id !== cam.id), 'CAM cannot list other CAMs');
for (const m of ['listAuditLogs', 'listImportBatches', 'weeklyEmailPreview', 'historicalCams', 'automationStatus'])
  throws(() => gas.call(m, m === 'listAuditLogs' ? { limit: 5, offset: 0 } : recent[0]), /Only QA|Not authorised/, `CAM cannot call ${m}`);
throws(() => gas.call('upsertEmployee', { ...cam, role: 'super_admin' }), /Only QA/, 'CAM cannot make themselves Super Admin');
throws(() => gas.call('adminAdjustScore', mine[0].id, null, 1, 'trying to change my own score'), /Only QA/, 'CAM cannot change a score');
throws(() => gas.call('syncGoogleSheet', 'all'), /Only QA/, 'CAM cannot sync sheets');
throws(() => gas.call('importSetup', { kind: 'csqa-setup', version: 1, employees: [], teams: [] }), /Only QA|not a CS QA/, 'CAM cannot load a setup file');
throws(() => gas.call('serverActAs', OWNER), /Unknown action/, 'server-only functions cannot be called from the browser');
throws(() => gas.call('serverBootstrapOwner', CAM), /Unknown action/, 'cannot re-run owner setup from the browser');
throws(() => gas.call('constructor'), /Unknown action/, 'arbitrary properties cannot be called');
throws(() => gas.call('installAutomation'), /Only QA/, 'CAM cannot install scheduled jobs');
throws(() => gas.api([{ m: 'markNotificationsRead', a: [] }, { m: 'markNotificationsRead', a: [] }]) && null, /on its own/, 'two changes in one request are refused');
ok((() => { try { gas.rawApi('{"calls":[{"m":"getSettings","a":[]},{"m":"upsertTeam","a":[{"name":"x"}]}]}'); return false; } catch (e) { return /on its own/.test(e.message); } })(), 'a change bundled with reads is refused');

// ---------- Lead isolation
gas.as(LEAD);
const leadView = gas.call('getEvaluations', { periodIds: recent });
ok(leadView.length > 0 && leadView.every((e) => e.team_id === team.id), `Lead sees only their team (${new Set(leadView.map((e) => e.cam_id)).size} CAMs)`);
ok(gas.call('getEvaluation', allRecent.find((e) => e.cam_id === outsiderCam.id).id) === null, 'Lead cannot open another team’s audit');
throws(() => gas.call('adminAdjustScore', leadView[0].id, null, 1, 'lead trying to change a score'), /Only QA/, 'Lead cannot change scores');
throws(() => gas.call('setPeriodStatus', recent[0], 'draft'), /Only QA/, 'Lead cannot unpublish weeks');

// ---------- appeal workflow + notification emails
gas.as(OWNER);
gas.call('updateSetting', 'notifications', { ...gas.call('getSettings').notifications, email_enabled: true });
const target = mine.find((e) => e.scores.some((s) => s.earned !== null && s.earned < s.max_score) && !e.autofail) ?? mine[0];
const param = target.scores.find((s) => s.earned !== null && s.earned < s.max_score);
gas.as(CAM);
const deadline = gas.call('getAppealDeadline', target.id);
let appealId = null;
if (!deadline || Date.parse(deadline) < Date.now()) {
  gas.as(OWNER); gas.call('grantResubmission', target.id, param.parameter_id, false, 'test: reopen the window for this audit'); gas.as(CAM);
}
const mails0 = gas.mails.length;
appealId = gas.call('submitAppeal', target.id, 'The customer confirmed the details, see the chat transcript.', [{ parameter_id: param.parameter_id, is_autofail: false, requested_score: param.max_score, justification: 'Full marks deserved' }]);
ok(!!appealId, 'CAM submits an appeal');
const leadMail = gas.mails.slice(mails0).find((m) => m.to === LEAD);
ok(!!leadMail && /appeal/i.test(leadMail.subject), 'Lead gets an email about the new appeal');
ok(leadMail && !leadMail.htmlBody.includes(String(target.score)) && !leadMail.htmlBody.includes(target.feedback?.slice(0, 20) || '§§'), 'the email has no score or feedback in it');
ok(leadMail && leadMail.htmlBody.includes('?p=%2Fappeals%2F'), 'the email links straight to the appeal');
throws(() => gas.call('qaDecideAppeal', appealId, [], 'x'), /Only QA|not authorised|Not authorised/i, 'CAM cannot decide their own appeal');
gas.as(OWNER);
throws(() => gas.call('qaDecideAppeal', appealId, [{ item_id: 'x', decision: 'approved', revised_score: 1, comment: 'x' }], 'deciding before the Lead'), /Lead|status|pending/i, 'QA cannot decide before the Lead has reviewed (no bypass)');
const vBefore = gas.props.get('CSQA_V_core');
try { gas.call('qaDecideAppeal', appealId, [], 'x'); } catch { /* expected */ }
ok(gas.props.get('CSQA_V_core') === vBefore, 'a refused change saves nothing');
gas.as(LEAD);
gas.call('leadReviewAppeal', appealId, 'support', 'I listened to the call; the CAM is right.', 'internal: coach on tone anyway');
gas.as(OWNER);
const det = gas.call('getAppeal', appealId);
ok(det.appeal.status === 'pending_qa_review', 'Lead forwards to QA');
gas.call('qaDecideAppeal', appealId, det.items.map((i) => ({ item_id: i.id, decision: 'approved', revised_score: param.max_score, comment: 'Verified.' })), 'Approved after review.');
gas.as(CAM);
const after = gas.call('getEvaluation', target.id);
ok(after.original_score === target.original_score, 'original score is kept unchanged');
ok(after.scores.find((s) => s.parameter_id === param.parameter_id).earned === param.max_score && after.adjusted, 'approved change shows as a separate adjustment');
const camDet = gas.call('getAppeal', appealId);
ok(!camDet.events.some((e) => e.visibility === 'internal'), 'CAM never sees the Lead’s internal note');
ok(gas.mails.some((m) => m.to === CAM && /decision/i.test(m.subject)), 'CAM is emailed when QA decides');
gas.as(other.email);
ok(gas.call('getAppeal', appealId) === null, 'a teammate cannot open the appeal');

// ---------- evidence in Drive
gas.as(CAM);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64');
const id2 = gas.call('submitAppeal', mine.find((e) => e.id !== target.id).id, 'Second appeal to test evidence upload.', [{ parameter_id: mine.find((e) => e.id !== target.id).scores.find((s) => s.earned !== null).parameter_id, is_autofail: false, requested_score: null, justification: 'See screenshot' }], true);
gas.call('uploadEvidenceData', id2, { name: 'shot.png', type: 'image/png', size: png.length, base64: png.toString('base64') });
throws(() => gas.call('uploadEvidenceData', id2, { name: 'x.exe', type: 'application/x-msdownload', size: 10, base64: 'AAAA' }), /not allowed/, 'unsafe file types are refused');
throws(() => gas.call('uploadEvidenceData', id2, { name: 'big.png', type: 'image/png', size: 10, base64: 'A'.repeat(4000) }), /does not match/, 'a file bigger than it claims is refused');
const ev = gas.call('getAppeal', id2).evidence[0];
ok(gas.call('evidenceUrl', ev.storage_path) === 'data:image/png;base64,' + png.toString('base64'), 'evidence is stored in Drive and can be opened by the CAM');
gas.as(other.email);
throws(() => gas.call('evidenceUrl', ev.storage_path), /Not authorised/, 'a teammate cannot open the evidence');

// ---------- weekly report emails
gas.as(OWNER);
const draft = gas.call('getPeriods').filter((p) => p.status === 'draft').pop();
throws(() => gas.call('sendWeeklyEmails', draft.id, null, false), /Publish/, 'weekly emails need a published week');
gas.call('setPeriodStatus', draft.id, 'published');
const preview = gas.call('weeklyEmailPreview', draft.id);
const n0 = gas.mails.length;
const res = gas.call('sendWeeklyEmails', draft.id, [cam.id, other.id].filter((x) => preview.some((r) => r.cam_id === x)), false);
const sent = gas.mails.slice(n0);
ok(res.sent === sent.length && sent.length >= 1 && res.failed === 0, `weekly report emails sent from Gmail (${sent.length})`);
ok(sent.every((m) => m.cc && m.cc.includes(LEAD)), 'each report email CCs the CAM’s Lead');
ok(sent.every((m) => sent.filter((x) => x !== m).every((x) => !m.htmlBody.includes(emps.find((e) => e.email === x.to).full_name))), 'no email mentions another CAM');
ok(sent.every((m) => m.htmlBody.includes('script.google.com') && m.htmlBody.includes('?p=')), 'report link opens the portal web app');
ok(gas.call('weeklyEmailPreview', draft.id).filter((r) => r.last_status === 'sent').length === sent.length, 'sent status is recorded');
const res2 = gas.call('sendWeeklyEmails', draft.id, null, false);
ok(res2.skipped >= sent.length, 'already-sent CAMs are skipped unless you choose to resend');

// ---------- invite
const n1 = gas.mails.length;
gas.call('inviteUser', other.id);
const inv = gas.mails[n1];
ok(inv && inv.to === other.email && /access/i.test(inv.subject) && /Google account/.test(inv.htmlBody), 'invite email tells them to sign in with Google');
throws(() => gas.call('inviteUser', gas.call('getEmployees').find((e) => e.email.endsWith('@lead-email-needed.invalid')).id), /email/, 'no invite to a placeholder email');

// ---------- scheduled jobs
ok(gas.call('automationStatus').installed === false, 'automatic jobs are off until turned on');
gas.call('installAutomation'); gas.call('installAutomation');
ok(gas.triggers.length === 1 && gas.triggers[0].minutes === 30, 'turning them on creates exactly one 30-minute job');
const d2 = gas.call('getPeriods').filter((p) => p.status === 'draft').pop();
if (d2) gas.call('upsertPeriod', { ...d2, auto_publish_at: new Date(Date.now() - 60000).toISOString() });
gas.runJobs();
const st = gas.call('automationStatus');
ok(!!st.last_run && /audit/.test(st.last_result), `scheduled job ran: “${st.last_result.replace(/\d+ new/, 'N new')}”`);
if (d2) ok(gas.call('getPeriods').find((p) => p.id === d2.id).status === 'published', 'a week with a publish time is published by the job');

// ---------- storage survives a cold start
gas.cache.clear();
const cold = Date.now(); const again2 = gas.call('getEvaluation', target.id);
ok(again2.adjusted && again2.score === after.score, `after the cache is cleared everything reloads from Drive (${Date.now() - cold} ms)`);
ok(gas.call('listAuditLogs', { limit: 500, offset: 0 }).some((l) => l.action === 'appeal_status'), 'audit log records the changes');

// ---------- setup file: only before audits, owner stays Super Admin
throws(() => gas.call('importSetup', { kind: 'csqa-setup', version: 1, employees: [], teams: [] }), /before syncing/, 'setup file cannot overwrite a portal that already has audits');
const fresh = createGas({ owner: OWNER, sheets: SHEETS });
fresh.as(OWNER); fresh.call('whoami');
fresh.call('importSetup', { kind: 'csqa-setup', version: 1, exported_at: new Date().toISOString(), employees: [
  { id: 'a1', email: OWNER, full_name: 'QA Owner', role: 'user', status: 'inactive', team_id: null },
  { id: 'l1', email: 'lead.one@example.com', full_name: 'Lead One', role: 'admin', status: 'active', team_id: null },
  { id: 'c1', email: 'cam.one@example.com', full_name: 'Cam One', role: 'user', status: 'active', team_id: 't1' }],
  teams: [{ id: 't1', name: 'Team One', lead_id: 'l1' }], settings: null, taskTypes: [], parameters: [], aliases: {}, historical: [] });
ok(fresh.call('whoami').me?.role === 'super_admin', 'loading a setup file keeps you a Super Admin');
fresh.as('cam.one@example.com');
ok(fresh.call('whoami').me?.team_name === 'Team One', 'people and teams from the setup file can sign in with Google');

// ---------- web page
const page = gas.doGet();
ok(page.file === 'index' && page.title === 'CS QA Portal', 'web app serves the portal page');

console.log(`\n${fails ? `${fails} FAILED` : 'all passed'} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
process.exitCode = fails ? 1 : 0;
