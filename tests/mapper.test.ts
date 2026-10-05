import { describe, expect, it } from 'vitest';
import { mapAuditRows, parseWeekLabel, parseUsDate, formatWeekLabel } from '../supabase/functions/_shared/mapper';
import { TASK_TYPES, PARAMETERS } from '../supabase/functions/_shared/rubric';

const tt = TASK_TYPES.map((t) => ({ code: t.code, source_label: t.sourceLabel, feedback_column: t.feedbackColumn, fcr_column: t.fcrColumn }));
const ps = PARAMETERS.map((p) => ({ id: p.id, task_type: p.taskType, name: p.name, max_score: p.maxScore, source_column: p.sourceColumn, active: p.active !== false, rubric_version: p.rubricVersion ?? 'current', source_aliases: p.aliases ?? [] }));
const erRow = (over: Record<string, string> = {}) => ({
  Timestamp: '9/28/2026 12:24:19', 'Email Address': 'qa.person@x.co', Score: '85', 'QA Week': 'WK-39 : 2026 (09/24- 09/30)',
  'DS Task Link': 'https://my.distributedsource.com/crm#task/21956210-397d-4fdb-a50b-72822bbe434c', 'CAM Name': 'first.last@x.co',
  'Task Loaded Date': '9/25/2026', 'Task Count': 'Task 1', 'Request from?': 'Client', 'Auto-Fail': 'No', 'Task Type': 'Email Request (Client, Agent)',
  ' [First Contact Resolution (ER)]': 'Yes', ' [Query resolution (ER) [30]]': '30', ' [OB call/Follow-up (ER) [15]]': '0',
  ' [Average Task-Handled Time (ER) [15]]': '15', ' [Required Documentation (ER) [10]]': '10', ' [Email Structure (ER) [20]]': '20',
  ' [Checklist (ER) [10]]': '10', 'Feedback (ER)': 'Good job.', 'QA Person': 'Someone', 'Lead Name': 'A Lead', ...over,
});

describe('week labels', () => {
  it('parses the audit form label', () => {
    expect(parseWeekLabel('WK-39 : 2026 (09/24- 09/30)')).toEqual({ label: 'WK-39 : 2026 (09/24- 09/30)', short_label: 'WK-39', year: 2026, week: 39, start: '2026-09-24', end: '2026-09-30' });
    expect(parseWeekLabel('WK-2 : 2026 (01/05 - 01/11)')?.start).toBe('2026-01-05');
  });
  it('handles year roll-over', () => {
    const p = parseWeekLabel('WK-1 : 2024 (12/29 - 01/04)')!;
    expect(p.start).toBe('2023-12-29'); expect(p.end).toBe('2024-01-04');
  });
  it('rejects malformed labels', () => { expect(parseWeekLabel('Week 39')).toBeNull(); });
  it('formats labels like the form', () => { expect(formatWeekLabel(39, 2026, '2026-09-24', '2026-09-30')).toBe('WK-39 : 2026 (09/24- 09/30)'); });
});

describe('dates', () => {
  it('parses US timestamps with timezone', () => { expect(parseUsDate('9/28/2026 12:05:50', true, '+05:30')).toBe('2026-09-28T06:35:50.000Z'); });
  it('parses dates', () => { expect(parseUsDate('9/5/2026', false)).toBe('2026-09-05'); });
  it('parses sheet serials', () => { expect(parseUsDate('46293', false)).toBe('2026-09-28'); });
});

describe('mapAuditRows', () => {
  it('maps a valid ER row', () => {
    const r = mapAuditRows([erRow()], tt, ps);
    expect(r.rejections).toEqual([]);
    const row = r.rows[0];
    expect(row.task_type).toBe('ER'); expect(row.score).toBe(85); expect(row.cam_email).toBe('first.last@x.co'); expect(row.cam_name).toBe('First Last');
    expect(row.task_id).toBe('21956210-397d-4fdb-a50b-72822bbe434c'); expect(row.fcr).toBe('Yes');
    expect(row.scores).toHaveLength(6); expect(row.scores.find((s) => s.earned === 0)).toBeTruthy();
  });
  it('rejects score/rubric mismatch', () => {
    const r = mapAuditRows([erRow({ Score: '100' })], tt, ps);
    expect(r.rows).toHaveLength(0); expect(r.rejections[0].reason).toMatch(/does not match/);
  });
  it('rejects scores above the parameter maximum', () => {
    const r = mapAuditRows([erRow({ ' [OB call/Follow-up (ER) [15]]': '20', Score: '105' })], tt, ps);
    expect(r.rejections[0].reason).toMatch(/Score missing|exceeds max/);
  });
  it('treats NA as not applicable and scores on applicable points', () => {
    const r = mapAuditRows([erRow({ ' [OB call/Follow-up (ER) [15]]': 'NA', Score: '100' })], tt, ps);
    expect(r.rejections).toEqual([]); expect(r.rows[0].scores.find((s) => s.earned === null)).toBeTruthy();
  });
  it('requires autofail rows to score 0', () => {
    expect(mapAuditRows([erRow({ 'Auto-Fail': 'Yes' })], tt, ps).rejections[0].reason).toMatch(/Auto-Fail/);
    const ok = mapAuditRows([erRow({ 'Auto-Fail': 'Yes', Score: '0' })], tt, ps);
    expect(ok.rows[0].autofail).toBe(true);
  });
  it('flags duplicates within the file', () => {
    const r = mapAuditRows([erRow(), erRow()], tt, ps);
    expect(r.rows).toHaveLength(1); expect(r.duplicates).toHaveLength(1);
  });
  it('reports missing required columns', () => {
    expect(mapAuditRows([{ Foo: '1' }], tt, ps).missingColumns.length).toBeGreaterThan(0);
  });
  it('accepts name-only CAMs from archived years (resolved on the server)', () => {
    const r = mapAuditRows([erRow({ 'CAM Name': 'Akanksha R' })], tt, ps);
    expect(r.rows[0].cam_email).toBe(''); expect(r.rows[0].cam_name).toBe('Akanksha R');
    expect(mapAuditRows([erRow({ 'CAM Name': '' })], tt, ps).rejections[0].reason).toMatch(/empty/);
  });
  it('scores archived Chat audits with the 2022–23 rubric', () => {
    const old = { Timestamp: '7/1/2022 10:00:00', 'Email Address': 'qa@x.co', Score: '85', 'QA Week': 'WK-27 : 2022 (06/26 - 07/02)',
      'DS Task Link': 'https://ds/crm#task/11111111-1111-4111-8111-111111111111', 'CAM Name': 'Pranoy', 'Auto-Fail': 'No', 'Task Type': 'Chat Request',
      ' [Query resolution (Chat) [30]]': '30', ' [OB call/Follow-up (Chat) [15]]': '0', ' [Required Documentation (Chat) [10]]': '10', ' [Hold & Response Time (Chat) [10]]': '10',
      ' [Personalization (Chat) [10]]': '10', ' [Professionalism/Communication (Chat) [15]]': '15', ' [Checklist (Chat) [10]]': '10', 'Feedback (Chat)': 'ok' };
    const r = mapAuditRows([old], tt, ps);
    expect(r.rejections).toEqual([]);
    expect(r.rows[0].scores.map((x) => x.parameter_id)).toEqual(PARAMETERS.filter((p) => p.taskType === 'CHAT' && p.rubricVersion === '2022-23').map((p) => p.id));
  });
  it('matches renamed headers loosely', () => {
    const row = erRow(); const renamed: Record<string, string> = {};
    for (const [k, v] of Object.entries(row)) renamed[k.replace(/^ /, '').replace('  ', ' ')] = v;
    expect(mapAuditRows([renamed], tt, ps).rows).toHaveLength(1);
  });
});
