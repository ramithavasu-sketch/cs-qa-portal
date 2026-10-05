import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { buildSelection, fmtRange, monthLabel, monthOptions, quarterOptions, type PeriodMode, type PeriodSelection } from '../lib/metrics';
import { inputBase } from './ui';
import { useRef_ } from '../app/context';
import type { Period } from '../lib/types';

/** Period selection lives in the URL (?mode=week&period=<id>) so views are linkable. */
export function usePeriodSelection(includeDrafts = false): [PeriodSelection, (mode: PeriodMode, anchor?: string) => void, Period[]] {
  const ref = useRef_();
  const [sp, setSp] = useSearchParams();
  const periods = includeDrafts ? ref.periods : ref.publishedPeriods;
  const mode = (sp.get('mode') as PeriodMode) || 'week';
  const lastPublished = ref.publishedPeriods[ref.publishedPeriods.length - 1];
  // default to the latest *published* week even when QA can also see drafts
  const anchor = sp.get('period') ?? (mode === 'week' ? lastPublished?.id : undefined);
  const sel = useMemo(() => buildSelection(periods, mode, anchor), [periods, mode, anchor]);
  const set = (m: PeriodMode, a?: string) => {
    const next = new URLSearchParams(sp);
    next.set('mode', m);
    if (a) next.set('period', a); else next.delete('period');
    setSp(next, { replace: true });
  };
  return [sel, set, periods];
}

export function PeriodPicker({ sel, onChange, periods }: { sel: PeriodSelection; onChange: (m: PeriodMode, a?: string) => void; periods: Period[] }) {
  const sorted = [...periods].sort((a, b) => b.start_date.localeCompare(a.start_date));
  const [from, to] = sel.mode === 'custom' ? sel.anchor.split('..') : ['', ''];
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="sr-only" htmlFor="period-mode">Reporting period type</label>
      <select id="period-mode" className={inputBase + ' w-auto'} value={sel.mode} onChange={(e) => onChange(e.target.value as PeriodMode)}>
        <option value="week">Week</option>
        <option value="month">Month</option>
        <option value="quarter">Quarter</option>
        <option value="custom">Custom range</option>
      </select>
      {sel.mode === 'week' && (
        <>
          <label className="sr-only" htmlFor="period-week">Audit week</label>
          <select id="period-week" className={inputBase + ' w-auto max-w-[260px]'} value={sel.anchor} onChange={(e) => onChange('week', e.target.value)}>
            {sorted.map((p) => <option key={p.id} value={p.id}>{p.short_label} · {fmtRange(p.start_date, p.end_date)}{p.status === 'draft' ? ' (draft)' : ''}</option>)}
          </select>
        </>
      )}
      {sel.mode === 'month' && (
        <select aria-label="Month" id="period-month" className={inputBase + ' w-auto'} value={sel.anchor} onChange={(e) => onChange('month', e.target.value)}>
          {monthOptions(periods).map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
        </select>
      )}
      {sel.mode === 'quarter' && (
        <select aria-label="Quarter" id="period-quarter" className={inputBase + ' w-auto'} value={sel.anchor} onChange={(e) => onChange('quarter', e.target.value)}>
          {quarterOptions(periods).map((q) => <option key={q} value={q}>{q.replace('-', ' ')}</option>)}
        </select>
      )}
      {sel.mode === 'custom' && (
        <>
          <label className="sr-only" htmlFor="period-from">Start date</label>
          <input id="period-from" type="date" className={inputBase + ' w-auto'} value={from} max={to} onChange={(e) => onChange('custom', `${e.target.value}..${to}`)} />
          <span className="text-muted">to</span>
          <label className="sr-only" htmlFor="period-to">End date</label>
          <input id="period-to" type="date" className={inputBase + ' w-auto'} value={to} min={from} onChange={(e) => onChange('custom', `${from}..${e.target.value}`)} />
        </>
      )}
      <span className="text-[12px] text-muted">vs {sel.previousLabel}</span>
    </div>
  );
}
