// Pure calculation layer shared by every dashboard, report and export so the
// numbers are identical everywhere. Definitions are shown in the UI (METRIC_DEFINITIONS).
import type { Appeal, Employee, Evaluation, Parameter, Period, PortalSettings, Team } from './types';

export const METRIC_DEFINITIONS: Record<string, string> = {
  'QA Score': 'Task score = sum of earned parameter points ÷ sum of applicable maximum points × 100 (parameters marked NA are excluded). An autofail sets the task score to 0. Scores reflect approved appeal adjustments; the original score is kept in the audit history.',
  'Average QA Score': 'Mean of the task scores of all tasks audited in the selected period (each task counts once).',
  'Score Variance': 'Current-period average minus comparison-period average, in percentage points (pp). 88% → 92% is +4.00 pp, not +4%.',
  'Autofails': 'Number of audited tasks marked Auto-Fail. Counted separately from point deductions.',
  'Autofail Rate': 'Autofails ÷ tasks audited.',
  'FCR Rate': 'Tasks with First Contact Resolution = Yes ÷ tasks where FCR was recorded. FCR does not affect the task score.',
  'Parameter %': 'Points earned ÷ maximum points for that parameter across the tasks where it was evaluated. Autofailed tasks are excluded so parameter results reflect scored work.',
  'Deduction': 'A parameter scored below its maximum on a task.',
  'Repeat error': 'The same parameter was deducted in consecutive audit weeks (SOP: 2 weeks = flag, 3 weeks = coaching with Team Lead).',
  'Period': 'Weeks are the QA audit weeks (e.g. WK-38). A week belongs to the month/quarter in which it starts. The comparison period is the immediately preceding period of the same length.',
  'No Data': 'No evaluations exist for that period. It is never treated as a zero score.',
  'Tasks Audited': 'Number of tasks evaluated by QA in the selected period (after filters).',
  'CAMs Evaluated': 'CAMs with at least one audited task in the selected period.',
  'Meeting Target': 'CAMs whose average QA score for the period is at or above the configured QA target.',
  'Needs Attention': 'CAMs with at least one audited task whose average is below the amber threshold, who had an autofail, or whose average dropped by 5 pp or more.',
  'Appeals': 'Appeals submitted (drafts excluded). Pending = still with the Team Lead, QA or awaiting information. Resolved = approved, partially approved, rejected or closed.',
  'Final Rating': 'Policy rating for the period, separate from the raw average: Meets standard = average at or above the QA target and autofail rate within the allowed maximum; Needs improvement = average in the amber band, or on target but over the autofail limit; otherwise Below standard.',
  'Score Band': 'Colours compare a score with the configured QA standards: green = on target (≥ green threshold), amber = needs attention, red = below target. The score itself is always shown.',
};

/**
 * Policy-based final rating for a period, kept separate from the raw average score:
 * "Meets standard" needs the average at or above the QA target AND the autofail rate
 * within the allowed maximum; "Needs improvement" is an average in the amber band (or
 * on target but over the autofail limit); otherwise "Below standard".
 */
export type Rating = 'meets' | 'improve' | 'below' | 'none';
export const RATING_LABEL: Record<Rating, string> = { meets: 'Meets standard', improve: 'Needs improvement', below: 'Below standard', none: 'No Data' };
export function finalRating(s: { avg: number | null; autofailRate: number | null }, st: PortalSettings): Rating {
  if (s.avg === null) return 'none';
  const afOk = (s.autofailRate ?? 0) <= st.qa_target.autofail_rate_max;
  if (s.avg >= st.qa_target.score && afOk) return 'meets';
  if (s.avg >= st.thresholds.amber) return 'improve';
  return 'below';
}

/**
 * People whose QA results are reported: CAMs, plus Team Leads who are themselves members of a
 * team (e.g. the Leads in the Senior Manager's team). QA Super Admins are never included.
 */
export const isReportee = (e: Employee) => e.role === 'user' || (e.role === 'admin' && !!e.team_id);

export type Band = 'green' | 'amber' | 'red' | 'none';
export function band(score: number | null | undefined, s: PortalSettings): Band {
  if (score === null || score === undefined || Number.isNaN(score)) return 'none';
  if (score >= s.thresholds.green) return 'green';
  if (score >= s.thresholds.amber) return 'amber';
  return 'red';
}
export const BAND_LABEL: Record<Band, string> = { green: 'On target', amber: 'Needs attention', red: 'Below target', none: 'No data' };

const round2 = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// Period selection
// ---------------------------------------------------------------------------
export type PeriodMode = 'week' | 'month' | 'quarter' | 'custom';
export interface PeriodSelection {
  mode: PeriodMode;
  current: Period[];
  previous: Period[];
  label: string;
  previousLabel: string;
  anchor: string; // period id | 'YYYY-MM' | 'YYYY-Qn' | 'from..to'
}

const byStart = (a: Period, b: Period) => a.start_date.localeCompare(b.start_date);
const monthKey = (d: string) => d.slice(0, 7);
const quarterKey = (d: string) => `${d.slice(0, 4)}-Q${Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1}`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const monthLabel = (k: string) => `${MONTHS[Number(k.slice(5, 7)) - 1]} ${k.slice(0, 4)}`;
const prevMonth = (k: string) => {
  const y = Number(k.slice(0, 4)); const m = Number(k.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};
const prevQuarter = (k: string) => {
  const y = Number(k.slice(0, 4)); const q = Number(k.slice(6));
  return q === 1 ? `${y - 1}-Q4` : `${y}-Q${q - 1}`;
};

export function monthOptions(periods: Period[]) {
  return [...new Set(periods.map((p) => monthKey(p.start_date)))].sort().reverse();
}
export function quarterOptions(periods: Period[]) {
  return [...new Set(periods.map((p) => quarterKey(p.start_date)))].sort().reverse();
}

export function buildSelection(allPeriods: Period[], mode: PeriodMode, anchor?: string): PeriodSelection {
  const periods = [...allPeriods].sort(byStart);
  const last = periods[periods.length - 1];
  if (!last) return { mode, current: [], previous: [], label: 'No periods', previousLabel: '—', anchor: '' };
  if (mode === 'week') {
    const idx = Math.max(0, anchor ? periods.findIndex((p) => p.id === anchor) : periods.length - 1);
    const cur = periods[idx === -1 ? periods.length - 1 : idx];
    const prev = periods[periods.indexOf(cur) - 1];
    return { mode, current: [cur], previous: prev ? [prev] : [], label: cur.short_label + ' · ' + fmtRange(cur.start_date, cur.end_date),
      previousLabel: prev ? prev.short_label : 'No previous week', anchor: cur.id };
  }
  if (mode === 'month') {
    const k = anchor && /^\d{4}-\d{2}$/.test(anchor) ? anchor : monthKey(last.start_date);
    const pk = prevMonth(k);
    return { mode, current: periods.filter((p) => monthKey(p.start_date) === k), previous: periods.filter((p) => monthKey(p.start_date) === pk),
      label: monthLabel(k), previousLabel: monthLabel(pk), anchor: k };
  }
  if (mode === 'quarter') {
    const k = anchor && /^\d{4}-Q[1-4]$/.test(anchor) ? anchor : quarterKey(last.start_date);
    const pk = prevQuarter(k);
    return { mode, current: periods.filter((p) => quarterKey(p.start_date) === k), previous: periods.filter((p) => quarterKey(p.start_date) === pk),
      label: k.replace('-', ' '), previousLabel: pk.replace('-', ' '), anchor: k };
  }
  // custom: 'YYYY-MM-DD..YYYY-MM-DD' — weeks starting inside the range
  const [from, to] = (anchor ?? '').split('..');
  const f = from || periods[Math.max(0, periods.length - 4)].start_date;
  const t = to || last.end_date;
  const cur = periods.filter((p) => p.start_date >= f && p.start_date <= t);
  const firstIdx = cur.length ? periods.indexOf(cur[0]) : periods.length;
  const prev = periods.slice(Math.max(0, firstIdx - cur.length), firstIdx);
  return { mode, current: cur, previous: prev, label: fmtRange(f, t), previousLabel: prev.length ? `Previous ${prev.length} week(s)` : 'No previous period', anchor: `${f}..${t}` };
}

export function fmtDate(d: string | null | undefined) {
  if (!d) return '—';
  const x = new Date(d.length === 10 ? d + 'T00:00:00' : d);
  return `${String(x.getDate()).padStart(2, '0')} ${MONTHS[x.getMonth()]} ${x.getFullYear()}`;
}
export function fmtDateTime(d: string | null | undefined) {
  if (!d) return '—';
  const x = new Date(d);
  return `${fmtDate(d)}, ${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}`;
}
export function fmtRange(a: string, b: string) {
  return `${fmtDate(a).slice(0, 6)} – ${fmtDate(b)}`;
}
export const fmtPct = (n: number | null | undefined, digits = 2) => (n === null || n === undefined ? 'No Data' : `${n.toFixed(digits)}%`);
export const fmtPp = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(n).toFixed(2)} pp`);

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------
export interface Summary {
  tasks: number; avg: number | null; autofails: number; autofailRate: number | null;
  fcrYes: number; fcrTotal: number; fcrRate: number | null; adjusted: number;
}
export function summarize(evals: Evaluation[]): Summary {
  const tasks = evals.length;
  const sum = evals.reduce((a, e) => a + Number(e.score), 0);
  const autofails = evals.filter((e) => e.autofail).length;
  const fcrRec = evals.filter((e) => e.fcr);
  const fcrYes = fcrRec.filter((e) => e.fcr === 'Yes').length;
  return {
    tasks,
    avg: tasks ? round2(sum / tasks) : null,
    autofails,
    autofailRate: tasks ? round2((100 * autofails) / tasks) : null,
    fcrYes, fcrTotal: fcrRec.length,
    fcrRate: fcrRec.length ? round2((100 * fcrYes) / fcrRec.length) : null,
    adjusted: evals.filter((e) => e.adjusted).length,
  };
}
export const variance = (cur: number | null, prev: number | null) => (cur === null || prev === null ? null : round2(cur - prev));

export const inPeriods = (evals: Evaluation[], periods: Period[]) => {
  const ids = new Set(periods.map((p) => p.id));
  return evals.filter((e) => ids.has(e.period_id));
};

export interface TrendPoint { periodId: string; label: string; avg: number | null; tasks: number; autofails: number; start: string }
export function weeklyTrend(evals: Evaluation[], periods: Period[]): TrendPoint[] {
  return [...periods].sort(byStart).map((p) => {
    const s = summarize(evals.filter((e) => e.period_id === p.id));
    return { periodId: p.id, label: p.short_label, avg: s.avg, tasks: s.tasks, autofails: s.autofails, start: p.start_date };
  });
}

/** Month-by-month trend; a week belongs to the month in which it starts (same rule as period selection). */
export function monthlyTrend(evals: Evaluation[], periods: Period[]): TrendPoint[] {
  const keys = [...new Set([...periods].sort(byStart).map((p) => monthKey(p.start_date)))];
  return keys.map((k) => {
    const ids = new Set(periods.filter((p) => monthKey(p.start_date) === k).map((p) => p.id));
    const s = summarize(evals.filter((e) => ids.has(e.period_id)));
    return { periodId: k, label: monthLabel(k), avg: s.avg, tasks: s.tasks, autofails: s.autofails, start: k + '-01' };
  });
}
export const periodMonthKeys = (periods: Period[]) => [...new Set(periods.map((p) => monthKey(p.start_date)))];

// ---------------------------------------------------------------------------
// Parameter analysis
// ---------------------------------------------------------------------------
export interface FeedbackRef { evaluationId: string; taskId: string; periodLabel: string; auditedAt: string; earned: number | null; max: number; feedback: string | null; remarks: string | null; deducted: boolean }
export interface ParamStat {
  parameter: Parameter; taskTypeName: string; evaluated: number; deductions: number; earned: number; max: number;
  pct: number | null; pointsLost: number; refs: FeedbackRef[];
}
export function parameterStats(evals: Evaluation[], parameters: Parameter[], taskTypeNames: Record<string, string>): ParamStat[] {
  const map = new Map<string, ParamStat>();
  for (const p of parameters) {
    map.set(p.id, { parameter: p, taskTypeName: taskTypeNames[p.task_type] ?? p.task_type, evaluated: 0, deductions: 0, earned: 0, max: 0, pct: null, pointsLost: 0, refs: [] });
  }
  for (const e of evals) {
    if (e.autofail) continue;
    for (const s of e.scores) {
      const st = map.get(s.parameter_id);
      if (!st || s.earned === null) continue;
      st.evaluated += 1;
      st.earned += Number(s.earned);
      st.max += Number(s.max_score);
      const deducted = Number(s.earned) < Number(s.max_score);
      if (deducted) {
        st.deductions += 1;
        st.pointsLost += Number(s.max_score) - Number(s.earned);
      }
      st.refs.push({ evaluationId: e.id, taskId: e.task_id, periodLabel: e.period_short_label, auditedAt: e.audited_at, earned: s.earned, max: s.max_score, feedback: e.feedback, remarks: s.remarks, deducted });
    }
  }
  for (const st of map.values()) st.pct = st.max ? round2((100 * st.earned) / st.max) : null;
  return [...map.values()];
}

// ---------------------------------------------------------------------------
// Strengths / improvement areas (rule-based; every statement is derived from
// recorded scores — no generated coaching text).
// ---------------------------------------------------------------------------
export interface InsightItem { stat: ParamStat; detail: string; delta?: number | null; streak?: number }
export interface Insights {
  strengths: InsightItem[]; improvements: InsightItem[]; recurring: InsightItem[];
  positive: InsightItem[]; declining: InsightItem[]; focus: InsightItem[];
}

/** Consecutive audit weeks (ending with the latest week in `weeks`) in which the parameter was deducted. */
export function deductionStreak(paramId: string, evals: Evaluation[], weeks: Period[]): number {
  const sorted = [...weeks].sort(byStart).reverse();
  let streak = 0;
  for (const w of sorted) {
    const we = evals.filter((e) => e.period_id === w.id && !e.autofail);
    const evaluated = we.some((e) => e.scores.some((s) => s.parameter_id === paramId && s.earned !== null));
    if (!evaluated) break;
    const deducted = we.some((e) => e.scores.some((s) => s.parameter_id === paramId && s.earned !== null && Number(s.earned) < Number(s.max_score)));
    if (!deducted) break;
    streak += 1;
  }
  return streak;
}

export function buildInsights(
  cur: Evaluation[], prev: Evaluation[], history: Evaluation[], historyWeeks: Period[],
  parameters: Parameter[], taskTypeNames: Record<string, string>, settings: PortalSettings,
): Insights {
  const target = settings.qa_target.score;
  const c = parameterStats(cur, parameters, taskTypeNames).filter((s) => s.evaluated > 0);
  const pmap = new Map(parameterStats(prev, parameters, taskTypeNames).map((s) => [s.parameter.id, s]));
  const name = (s: ParamStat) => `${s.parameter.name} (${s.taskTypeName})`;
  void name;

  const strengths = c.filter((s) => (s.pct ?? 0) >= target && s.deductions === 0)
    .sort((a, b) => b.evaluated - a.evaluated)
    .map((s) => ({ stat: s, detail: `Full marks on all ${s.evaluated} evaluated task${s.evaluated === 1 ? '' : 's'}.` }));

  const improvements = c.filter((s) => s.deductions > 0)
    .sort((a, b) => b.pointsLost - a.pointsLost)
    .map((s) => ({ stat: s, detail: `${s.deductions} deduction${s.deductions === 1 ? '' : 's'} in ${s.evaluated} evaluated task${s.evaluated === 1 ? '' : 's'} · ${s.pointsLost} point${s.pointsLost === 1 ? '' : 's'} lost · ${fmtPct(s.pct)}${(s.pct ?? 100) < target ? ` (target ${target}%)` : ''}` }));

  const recurring: InsightItem[] = [];
  for (const s of c) {
    const streak = deductionStreak(s.parameter.id, history, historyWeeks);
    if (s.deductions >= 2 || streak >= 2) {
      const bits: string[] = [];
      if (s.deductions >= 2) bits.push(`deducted on ${s.deductions} tasks this period`);
      if (streak >= 2) bits.push(`deducted ${streak} audit weeks in a row${streak >= 3 ? ' — coaching session with Team Lead required by SOP' : ' — repeat error flag'}`);
      recurring.push({ stat: s, streak, detail: bits.join('; ') + '.' });
    }
  }
  recurring.sort((a, b) => (b.streak ?? 0) - (a.streak ?? 0) || b.stat.deductions - a.stat.deductions);

  const positive: InsightItem[] = [];
  const declining: InsightItem[] = [];
  for (const s of c) {
    const p = pmap.get(s.parameter.id);
    if (!p || !p.evaluated || s.pct === null || p.pct === null) continue;
    const d = round2(s.pct - p.pct);
    if (d >= 1) positive.push({ stat: s, delta: d, detail: `${fmtPct(p.pct)} → ${fmtPct(s.pct)} (${fmtPp(d)})` });
    if (d <= -1) declining.push({ stat: s, delta: d, detail: `${fmtPct(p.pct)} → ${fmtPct(s.pct)} (${fmtPp(d)})` });
  }
  positive.sort((a, b) => (b.delta ?? 0) - (a.delta ?? 0));
  declining.sort((a, b) => (a.delta ?? 0) - (b.delta ?? 0));

  // Focus: repeat errors first, then biggest point loss, max 3.
  const focus: InsightItem[] = [];
  const seen = new Set<string>();
  for (const r of recurring) if (focus.length < 3 && !seen.has(r.stat.parameter.id)) { focus.push(r); seen.add(r.stat.parameter.id); }
  for (const i of improvements) if (focus.length < 3 && !seen.has(i.stat.parameter.id)) { focus.push(i); seen.add(i.stat.parameter.id); }
  return { strengths, improvements, recurring, positive, declining, focus };
}

// ---------------------------------------------------------------------------
// CAM comparison rows (QA master table / Lead team table)
// ---------------------------------------------------------------------------
export interface CamRow {
  cam: Employee; teamName: string; leadName: string; tasks: number; avg: number | null; prevAvg: number | null;
  variance: number | null; autofails: number; appeals: number; appealsOpen: number; appealSummary: string;
  trend: (number | null)[]; meetsTarget: boolean; needsAttention: boolean; attentionReasons: string[];
}

const OPEN: Appeal['status'][] = ['draft', 'pending_lead_review', 'returned_to_cam', 'pending_qa_review', 'pending_additional_info'];
export const isOpenAppeal = (a: Appeal) => OPEN.includes(a.status);
/** Submitted and still in review (drafts excluded). */
export const isPendingAppeal = (a: Appeal) => a.status !== 'draft' && OPEN.includes(a.status);
export const isResolvedAppeal = (a: Appeal) => ['approved', 'partially_approved', 'rejected', 'closed'].includes(a.status);

export function camRows(
  cams: Employee[], teams: Team[], employees: Employee[], cur: Evaluation[], prev: Evaluation[],
  history: Evaluation[], historyWeeks: Period[], appeals: Appeal[], settings: PortalSettings,
): CamRow[] {
  const teamById = new Map(teams.map((t) => [t.id, t]));
  const empById = new Map(employees.map((e) => [e.id, e]));
  const curIds = new Set(cur.map((e) => e.id));
  const weeks = [...historyWeeks].sort(byStart).slice(-6);
  return cams.map((cam) => {
    const ce = cur.filter((e) => e.cam_id === cam.id);
    const pe = prev.filter((e) => e.cam_id === cam.id);
    const s = summarize(ce);
    const ps = summarize(pe);
    const team = cam.team_id ? teamById.get(cam.team_id) : undefined;
    const lead = team?.lead_id ? empById.get(team.lead_id) : undefined;
    const ap = appeals.filter((a) => a.cam_id === cam.id && curIds.has(a.evaluation_id));
    const open = ap.filter(isOpenAppeal).length;
    const reasons: string[] = [];
    if (s.avg !== null && s.avg < settings.thresholds.amber) reasons.push('Average below ' + settings.thresholds.amber + '%');
    if (s.autofails > 0) reasons.push(`${s.autofails} autofail${s.autofails > 1 ? 's' : ''}`);
    const v = variance(s.avg, ps.avg);
    if (v !== null && v <= -5) reasons.push(`Dropped ${fmtPp(v)}`);
    return {
      cam, teamName: team?.name ?? '—', leadName: lead?.full_name ?? '—', tasks: s.tasks, avg: s.avg, prevAvg: ps.avg,
      variance: v, autofails: s.autofails, appeals: ap.length, appealsOpen: open,
      appealSummary: ap.length === 0 ? 'None' : open ? `${open} open / ${ap.length}` : `${ap.length} resolved`,
      trend: weeks.map((w) => summarize(history.filter((e) => e.cam_id === cam.id && e.period_id === w.id)).avg),
      meetsTarget: s.avg !== null && s.avg >= settings.qa_target.score,
      needsAttention: s.tasks > 0 && reasons.length > 0,
      attentionReasons: reasons,
    };
  });
}

/** Client-side estimate of the appeal deadline (the server re-checks it on submit). */
export function appealDeadlineOf(publishedAt: string | null, s: PortalSettings, fixedClose?: string | null): Date | null {
  if (fixedClose) return new Date(fixedClose);
  if (!publishedAt) return null;
  const w = s.appeal_window;
  let d = new Date(publishedAt);
  if (!w.business_days) d = new Date(d.getTime() + w.days * 86400000);
  else { let added = 0; while (added < w.days) { d.setDate(d.getDate() + 1); if (d.getDay() !== 0 && d.getDay() !== 6) added += 1; } }
  return w.end_of_day ? endOfDayIn(d, s.reporting.timezone) : d;
}
/** 23:59:59 on the same calendar date as `d`, in time zone `tz` (mirrors the SQL appeal_deadline). */
export function endOfDayIn(d: Date, tz: string): Date {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(d).map((p) => [p.type, p.value]));
  const guess = new Date(`${parts.year}-${parts.month}-${parts.day}T23:59:59Z`);
  // shift by the zone's offset at that moment
  const asTz = new Date(guess.toLocaleString('en-US', { timeZone: tz || 'UTC' }));
  const asUtc = new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' }));
  return new Date(guess.getTime() - (asTz.getTime() - asUtc.getTime()));
}
export const appealWindowOpen = (e: Evaluation, s: PortalSettings, periods: Period[] = []) => {
  const fixed = periods.find((p) => p.id === e.period_id)?.appeal_closes_at ?? null;
  const d = e.period_status === 'published' ? appealDeadlineOf(e.published_at, s, fixed) : null;
  return !!d && Date.now() <= d.getTime();
};

export const APPEAL_STATUS_LABEL: Record<Appeal['status'], string> = {
  draft: 'Draft',
  pending_lead_review: 'Pending Lead Review',
  returned_to_cam: 'Returned to CAM',
  pending_qa_review: 'Pending QA Review',
  pending_additional_info: 'Pending Additional Information',
  approved: 'Approved',
  partially_approved: 'Partially Approved',
  rejected: 'Rejected',
  closed: 'Closed',
};
export const RECOMMENDATION_LABEL = {
  recommend_approval: 'Recommend Approval',
  recommend_rejection: 'Recommend Rejection',
  request_more_info: 'Request More Information',
} as const;
