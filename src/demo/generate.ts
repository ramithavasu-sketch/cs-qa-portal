// Deterministic FICTIONAL demo dataset. No real employee or performance data.
// Weeks are anchored to the date the demo is opened so the appeal windows stay live.
import { PARAMETERS, TASK_TYPES, DEFAULT_SETTINGS, type TaskTypeCode } from '../../supabase/functions/_shared/rubric';
import { formatWeekLabel } from '../../supabase/functions/_shared/mapper';
import type { Employee, Parameter, Period, PortalSettings, TaskType, Team } from '../lib/types';

export interface RawEvaluation {
  id: string; task_id: string; task_link: string; cam_id: string; evaluator_id: string | null; evaluator_email: string | null;
  evaluator_name: string | null; task_type: string; request_from: string | null; task_loaded_date: string | null;
  audited_at: string; period_id: string; task_seq: string | null; connection_id: string | null; screenshot_url: string | null;
  autofail: boolean; fcr: 'Yes' | 'No' | null; original_score: number; feedback: string | null; lead_name_at_audit: string | null;
  scores: { id: string; parameter_id: string; earned: number | null; max_score: number; remarks: string | null }[];
}

export interface DemoSeed {
  employees: Employee[]; teams: Team[]; taskTypes: TaskType[]; parameters: Parameter[]; settings: PortalSettings;
  periods: Period[]; evaluations: RawEvaluation[]; passwords: Record<string, string>;
}

// Mulberry32 PRNG — same data on every load.
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const uuidFrom = (r: () => number) =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const v = Math.floor(r() * 16);
    return (c === 'x' ? v : (v & 0x3) | 0x8).toString(16);
  });
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);

const DOMAIN = 'demo.csqa.test';
export const DEMO_PASSWORD = 'Demo@2026';

const QA_TEAM = [
  { name: 'Maya Raman', email: `maya.raman@${DOMAIN}` },
  { name: 'Theo Grant', email: `theo.grant@${DOMAIN}` },
];
const LEADS = [
  { name: 'Daniel Brooks', team: 'Team Harbor' },
  { name: 'Kavya Menon', team: 'Team Summit' },
  { name: 'Omar Haddad', team: 'Team Meridian' },
];
const CAMS: { name: string; team: number; skill: number; trend: number; af: number }[] = [
  { name: 'Ava Thompson', team: 0, skill: 0.035, trend: -0.002, af: 0.012 },
  { name: 'Rohan Iyer', team: 0, skill: 0.07, trend: 0.004, af: 0.02 },
  { name: 'Lena Fischer', team: 0, skill: 0.02, trend: 0, af: 0.004 },
  { name: 'Marcus Webb', team: 0, skill: 0.11, trend: -0.004, af: 0.035 },
  { name: 'Nisha Pillai', team: 1, skill: 0.045, trend: 0.003, af: 0.01 },
  { name: 'Ethan Clarke', team: 1, skill: 0.09, trend: 0.006, af: 0.025 },
  { name: 'Sofia Alvarez', team: 1, skill: 0.03, trend: -0.003, af: 0.006 },
  { name: 'Jonah Kim', team: 1, skill: 0.06, trend: 0, af: 0.015 },
  { name: 'Priya Natarajan', team: 2, skill: 0.025, trend: 0.001, af: 0.004 },
  { name: 'Liam O’Connor', team: 2, skill: 0.08, trend: -0.005, af: 0.03 },
  { name: 'Zara Hussain', team: 2, skill: 0.05, trend: 0.002, af: 0.012 },
  { name: 'Noah Bennett', team: 2, skill: 0.1, trend: 0.007, af: 0.02 },
];
const emailOf = (name: string) => `${name.toLowerCase().replace(/[’']/g, '').replace(/\s+/g, '.')}@${DOMAIN}`;

// Fictional, generic feedback phrases (not taken from real audits).
const POSITIVE: Record<TaskTypeCode, string[]> = {
  ER: [
    'handled the script update accurately and confirmed the change with the client in a clear follow-up email.',
    'resolved the request completely and documented every change made to the account.',
    'responded well within the handling time and kept the client informed of each step.',
    'wrote a well-structured email with a descriptive subject line and clear next steps.',
  ],
  CHAT: [
    'greeted the client promptly and used their name throughout the chat.',
    'set clear expectations before placing the chat on hold and returned on time.',
    'resolved the query within the chat and sent a confirmation email afterwards.',
  ],
  IB_CALL: [
    'maintained a warm, confident tone and paraphrased the caller’s concern before acting.',
    'showed good call control, using verbal bridges to avoid dead air.',
    'built rapport naturally and affirmed the caller’s concern early in the call.',
  ],
  INTERNAL: ['completed the internal request accurately and documented it clearly.'],
};
const NEGATIVE: Record<string, string[]> = {
  'Query Resolution': ['the resolution was incomplete — the requested change was only partly applied.', 'the client’s second question was not addressed in the reply.'],
  'OB Call / Follow-up': ['no follow-up call was attempted within the client’s business hours.', 'the task due date was not updated while awaiting the client’s reply.'],
  'Average Task-Handled Time': ['action was taken after the 30-minute window without a documented reason.', 'the task was updated well after the chat ended; close and document within the same window.'],
  'Required Documentation': ['the task notes did not describe the script change in enough detail.', 'the task link was missing from the Form Creator update.'],
  'Documentation': ['the task notes did not capture the caller’s request in full.'],
  'Email Structure': ['the email had typos and no clear closing confirming the action taken.', 'the subject line was generic; please make it descriptive.'],
  'Email Structure / Follow-up': ['the follow-up email to the client after the call was not sent.'],
  'Checklist': ['OB Call was entered as “NA” in the checklist; it must be Yes or No with a reason.', 'the Next Steps field in the checklist was left blank.'],
  'Hold & Response Time': ['the first response took longer than a minute and the hold sequence was not used.'],
  'Professionalism / Communication / Personalization': ['several one-word replies were used without context.', 'the client was not addressed by name during the chat.'],
  'Tone of Voice': ['the tone sounded flat through most of the call; aim for a livelier delivery.'],
  'Call Control / Accountability': ['there was dead air of over 45 seconds without a verbal bridge.'],
  'Acknowledgement / Active Listening': ['the caller had to repeat their request; paraphrase to confirm understanding.'],
  'Empathy & Affirmation': ['affirmation was missed when the caller expressed frustration.'],
  'Personalization & Rapport Building': ['the caller was not addressed by name during the call.'],
};
const AUTOFAIL_REASONS = [
  'Autofail: the script change was not saved in Form Creator, so the old message continued to play.',
  'Autofail: incorrect information was sent to the client about the call-forwarding setup.',
  'Autofail: the task was reassigned to a peer without intimation or a documented reason.',
];

const TYPE_MIX: [TaskTypeCode, number][] = [['ER', 0.6], ['IB_CALL', 0.21], ['CHAT', 0.17], ['INTERNAL', 0.02]];

export function currentWeekStart(today: Date, weekStartDow: number): Date {
  // weekStartDow: 1 = Monday ... 7 = Sunday (ISO). Default 4 = Thursday (current audit form weeks).
  const d = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
  const isoDow = ((d.getUTCDay() + 6) % 7) + 1;
  return addDays(d, -((isoDow - weekStartDow + 7) % 7));
}
function isoWeekNumber(d: Date) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return { week: Math.ceil(((t.getTime() - y0.getTime()) / 86400000 + 1) / 7), year: t.getUTCFullYear() };
}

export function generateDemoSeed(today = new Date(), weeks = 12): DemoSeed {
  const r = rng(20260929);
  const settings = structuredClone(DEFAULT_SETTINGS);
  const employees: Employee[] = [];
  const teams: Team[] = [];
  const passwords: Record<string, string> = {};

  for (const q of QA_TEAM) {
    employees.push({ id: uuidFrom(r), email: q.email, full_name: q.name, role: 'super_admin', status: 'active', team_id: null, is_demo: true });
  }
  LEADS.forEach((l) => {
    const lead: Employee = { id: uuidFrom(r), email: emailOf(l.name), full_name: l.name, role: 'admin', status: 'active', team_id: null, is_demo: true };
    employees.push(lead);
    teams.push({ id: uuidFrom(r), name: l.team, lead_id: lead.id });
  });
  const camEmps = CAMS.map((c) => {
    const e: Employee = { id: uuidFrom(r), email: emailOf(c.name), full_name: c.name, role: 'user', status: 'active', team_id: teams[c.team].id, is_demo: true };
    employees.push(e);
    return e;
  });
  for (const e of employees) passwords[e.email] = DEMO_PASSWORD;

  const taskTypes: TaskType[] = TASK_TYPES.map((t) => ({ code: t.code, name: t.name, source_label: t.sourceLabel, feedback_column: t.feedbackColumn, fcr_column: t.fcrColumn, sort_order: t.sortOrder, active: true }));
  const parameters: Parameter[] = PARAMETERS.map((p) => ({ id: p.id, task_type: p.taskType, name: p.name, section: p.section, max_score: p.maxScore, sort_order: p.sortOrder, source_column: p.sourceColumn, active: true }));

  // Periods: `weeks` published weeks ending with last week, plus the in-progress week (draft).
  const thisWeek = currentWeekStart(today, settings.reporting.week_start_dow);
  const periods: Period[] = [];
  for (let i = weeks; i >= 0; i--) {
    const start = addDays(thisWeek, -7 * i);
    const end = addDays(start, 6);
    const { week, year } = isoWeekNumber(start);
    const draft = i === 0;
    periods.push({
      id: uuidFrom(r), label: formatWeekLabel(week, year, iso(start), iso(end)), short_label: `WK-${week}`, year, week_number: week,
      start_date: iso(start), end_date: iso(end), status: draft ? 'draft' : 'published',
      // Published the Monday after the week closed (the most recent one ~1 day before "today")
      published_at: draft ? null : (i === 1 ? new Date(today.getTime() - 86400000).toISOString() : addDays(end, 5).toISOString()),
      auto_publish_at: null,
    });
  }

  const evaluations: RawEvaluation[] = [];
  const paramsByType = (code: string) => parameters.filter((p) => p.task_type === code);
  periods.forEach((period, wi) => {
    const isDraft = period.status === 'draft';
    camEmps.forEach((cam, ci) => {
      const prof = CAMS[ci];
      const n = isDraft ? 3 + Math.floor(r() * 3) : 6 + Math.floor(r() * 5);
      // Skip a week occasionally (leave/training) to demonstrate "No Data".
      if (!isDraft && r() < 0.04) return;
      for (let k = 0; k < n; k++) {
        let x = r(); let type: TaskTypeCode = 'ER';
        for (const [t, w] of TYPE_MIX) { if (x < w) { type = t; break; } x -= w; }
        const deductP = Math.max(0.005, prof.skill + prof.trend * (wi - weeks / 2) * 2);
        const autofail = r() < prof.af;
        const evaluator = employees[Math.floor(r() * QA_TEAM.length)];
        const scores = paramsByType(type).map((p) => {
          const miss = autofail ? true : r() < deductP * (p.name === 'Query Resolution' ? 0.5 : 1);
          return { id: uuidFrom(r), parameter_id: p.id, earned: autofail ? 0 : miss ? 0 : p.max_score, max_score: p.max_score, remarks: null };
        });
        const total = autofail ? 0 : scores.reduce((a, s) => a + (s.earned ?? 0), 0);
        const first = cam.full_name.split(' ')[0];
        const missed = scores.filter((s) => (s.earned ?? 0) < s.max_score).map((s) => parameters.find((p) => p.id === s.parameter_id)!.name);
        let feedback: string;
        if (autofail) feedback = `${first}, ${AUTOFAIL_REASONS[Math.floor(r() * AUTOFAIL_REASONS.length)].replace('Autofail: t', 'this task was marked as an autofail because t')}`;
        else if (missed.length === 0) feedback = `${first}, you ${POSITIVE[type][Math.floor(r() * POSITIVE[type].length)]}`;
        else {
          const neg = missed.map((m) => { const arr = NEGATIVE[m] ?? ['this parameter was not met.']; return arr[Math.floor(r() * arr.length)]; });
          feedback = `${first}, ${POSITIVE[type][Math.floor(r() * POSITIVE[type].length)].replace(/^./, (c) => 'you ' + c)} However, ${neg.join(' Also, ')}`;
        }
        const loaded = addDays(new Date(period.start_date + 'T00:00:00Z'), Math.floor(r() * 7));
        const audited = addDays(loaded, 1 + Math.floor(r() * 3));
        audited.setUTCHours(4 + Math.floor(r() * 12), Math.floor(r() * 60));
        const taskUuid = uuidFrom(r);
        evaluations.push({
          id: uuidFrom(r), task_id: taskUuid, task_link: `https://ds.example.invalid/crm#task/${taskUuid}`, cam_id: cam.id,
          evaluator_id: evaluator.id, evaluator_email: evaluator.email, evaluator_name: evaluator.full_name.split(' ')[0],
          task_type: type, request_from: r() < 0.72 ? 'Client' : 'Agent', task_loaded_date: iso(loaded), audited_at: audited.toISOString(),
          period_id: period.id, task_seq: `Task ${k + 1}`, connection_id: type === 'IB_CALL' ? uuidFrom(r) : null, screenshot_url: null,
          autofail, fcr: autofail || r() < 0.05 ? 'No' : 'Yes', original_score: total, feedback, lead_name_at_audit: null, scores,
        });
      }
    });
  });

  return { employees, teams, taskTypes, parameters, settings, periods, evaluations, passwords };
}
