import { describe, expect, it } from 'vitest';
import { summarize, variance, fmtPp, band, buildSelection, parameterStats, deductionStreak, weeklyTrend } from '../src/lib/metrics';
import { DEFAULT_SETTINGS } from '../supabase/functions/_shared/rubric';
import type { Evaluation, Period, Parameter } from '../src/lib/types';

const P = (i: number, start: string, end: string): Period => ({ id: 'p' + i, label: 'WK-' + i, short_label: 'WK-' + i, year: 2026, week_number: i, start_date: start, end_date: end, status: 'published', published_at: null, auto_publish_at: null });
const periods = [P(35, '2026-08-27', '2026-09-02'), P(36, '2026-09-03', '2026-09-09'), P(37, '2026-09-10', '2026-09-16'), P(38, '2026-09-17', '2026-09-23')];
const param: Parameter = { id: 'x', task_type: 'ER', name: 'Checklist', section: null, max_score: 10, sort_order: 1, source_column: null, active: true };
const ev = (id: string, period: string, score: number, earned: number | null, af = false, fcr: 'Yes' | 'No' | null = 'Yes'): Evaluation => ({
  id, period_id: period, score, autofail: af, fcr, scores: [{ id: id + 's', evaluation_id: id, parameter_id: 'x', parameter_name: 'Checklist', section: null, sort_order: 1, max_score: 10, original_earned: earned, earned, adjusted: false, remarks: null }],
} as unknown as Evaluation);

describe('summaries', () => {
  it('averages task scores and counts autofails', () => {
    const s = summarize([ev('a', 'p38', 100, 10), ev('b', 'p38', 90, 0), ev('c', 'p38', 0, 0, true, 'No')]);
    expect(s.avg).toBe(63.33); expect(s.autofails).toBe(1); expect(s.fcrRate).toBe(66.67);
  });
  it('returns null (No Data) rather than zero for empty periods', () => { expect(summarize([]).avg).toBeNull(); });
  it('variance is in percentage points', () => {
    expect(variance(92, 88)).toBe(4); expect(fmtPp(4)).toBe('+4.00 pp'); expect(fmtPp(-1.5)).toBe('−1.50 pp'); expect(variance(null, 88)).toBeNull();
  });
  it('bands follow configured thresholds', () => {
    expect(band(95, DEFAULT_SETTINGS)).toBe('green'); expect(band(90, DEFAULT_SETTINGS)).toBe('amber'); expect(band(80, DEFAULT_SETTINGS)).toBe('red'); expect(band(null, DEFAULT_SETTINGS)).toBe('none');
  });
});

describe('period selection', () => {
  it('week vs previous week', () => {
    const s = buildSelection(periods, 'week', 'p38');
    expect(s.current.map((p) => p.id)).toEqual(['p38']); expect(s.previous.map((p) => p.id)).toEqual(['p37']);
  });
  it('month assigns weeks by start date', () => {
    const s = buildSelection(periods, 'month', '2026-09');
    expect(s.current.map((p) => p.id)).toEqual(['p36', 'p37', 'p38']); expect(s.previous.map((p) => p.id)).toEqual(['p35']);
  });
  it('custom range compares with the preceding equal-length window', () => {
    const s = buildSelection(periods, 'custom', '2026-09-10..2026-09-23');
    expect(s.current.map((p) => p.id)).toEqual(['p37', 'p38']); expect(s.previous.map((p) => p.id)).toEqual(['p35', 'p36']);
  });
});

describe('parameters and repeat errors', () => {
  it('excludes autofails and NA from parameter %', () => {
    const [st] = parameterStats([ev('a', 'p38', 100, 10), ev('b', 'p38', 90, 0), ev('c', 'p38', 0, 0, true), ev('d', 'p38', 100, null)], [param], { ER: 'Email Request' });
    expect(st.evaluated).toBe(2); expect(st.pct).toBe(50); expect(st.deductions).toBe(1);
  });
  it('counts consecutive deducted weeks', () => {
    const evals = [ev('a', 'p36', 90, 0), ev('b', 'p37', 90, 0), ev('c', 'p38', 90, 0), ev('d', 'p35', 100, 10)];
    expect(deductionStreak('x', evals, periods)).toBe(3);
    expect(deductionStreak('x', [ev('c', 'p38', 90, 0), ev('b', 'p37', 100, 10)], periods)).toBe(1);
  });
  it('trend shows null (No Data) for weeks without audits', () => {
    const t = weeklyTrend([ev('a', 'p38', 90, 0)], periods);
    expect(t.map((x) => x.avg)).toEqual([null, null, null, 90]);
  });
});
