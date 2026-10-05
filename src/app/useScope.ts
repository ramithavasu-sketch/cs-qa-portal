import { useMemo } from 'react';
import { repo } from '../data';
import { useAsync, useRef_ } from './context';
import { inPeriods, type PeriodSelection } from '../lib/metrics';
import type { Appeal, Evaluation, Period } from '../lib/types';

export interface ScopeData {
  loading: boolean; error: unknown;
  all: Evaluation[];          // current + previous + history window
  cur: Evaluation[]; prev: Evaluation[];
  history: Evaluation[]; historyWeeks: Period[];
  appeals: Appeal[];
}

/**
 * Loads evaluations for the selected period, the comparison period and a trend
 * window (up to 12 weeks ending at the selection). Row visibility is enforced by
 * the backend; `camIds` only narrows further.
 */
export function useScopeData(sel: PeriodSelection, camIds?: string[], trendWeeks = 12): ScopeData {
  const ref = useRef_();
  const periods = ref.periods;
  const endStart = sel.current.length ? sel.current[sel.current.length - 1].start_date : '9999';
  const historyWeeks = useMemo(() => {
    const upto = periods.filter((p) => p.start_date <= endStart && (p.status === 'published' || sel.current.some((c) => c.id === p.id)));
    return upto.slice(-Math.max(trendWeeks, sel.current.length + sel.previous.length));
  }, [periods, endStart, trendWeeks, sel]);
  const ids = useMemo(() => [...new Set([...historyWeeks, ...sel.current, ...sel.previous].map((p) => p.id))], [historyWeeks, sel]);
  const camKey = camIds?.join(',') ?? '';
  const evals = useAsync(() => (ids.length ? repo.getEvaluations({ periodIds: ids, camIds }) : Promise.resolve([])), [ids.join(','), camKey]);
  const appeals = useAsync(() => repo.listAppeals(camIds?.length === 1 ? { camId: camIds[0] } : {}), [camKey]);
  const all = evals.data ?? [];
  return {
    loading: evals.loading || appeals.loading,
    error: evals.error || appeals.error,
    all,
    cur: inPeriods(all, sel.current),
    prev: inPeriods(all, sel.previous),
    history: inPeriods(all, historyWeeks),
    historyWeeks,
    appeals: appeals.data ?? [],
  };
}
