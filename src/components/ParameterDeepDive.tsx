import { Fragment, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { useAsync, useRef_ } from '../app/context';
import { repo } from '../data';
import { Card, EmptyState, ErrorBox, Kpi, Loading, ScoreBadge, Table, td, th, Variance } from './ui';
import { TrendChart } from './charts';
import { fmtPct, parameterStats, summarize, variance, weeklyTrend, type ParamStat, type PeriodSelection } from '../lib/metrics';
import type { Evaluation, Period } from '../lib/types';

const gapTone = (g: number | null) => (g === null ? '' : g <= -5 ? 'text-bad font-semibold' : g < 0 ? 'text-warn' : 'text-good');

/**
 * One CAM in the selected period: every parameter against the comparison group
 * (all CAMs for QA, the Lead's team for a Lead), biggest gaps first, and every
 * task where points were lost.
 */
export function CamDeepDive({ camName, cur, prev, sel, compareLabel }: {
  camName: string; cur: Evaluation[]; prev: Evaluation[]; sel: PeriodSelection; compareLabel: string | null;
}) {
  const ref = useRef_();
  const s = ref.settings;
  const ids = sel.current.map((p) => p.id);
  const group = useAsync(() => (compareLabel && ids.length ? repo.getEvaluations({ periodIds: ids }) : Promise.resolve([] as Evaluation[])), [compareLabel, ids.join(',')]);
  const [showAll, setShowAll] = useState(false);

  const mine = useMemo(() => parameterStats(cur, ref.parameters, ref.taskTypeNames).filter((x) => x.evaluated > 0), [cur, ref]);
  const before = useMemo(() => new Map(parameterStats(prev, ref.parameters, ref.taskTypeNames).map((x) => [x.parameter.id, x])), [prev, ref]);
  const others = useMemo(() => new Map(parameterStats(group.data ?? [], ref.parameters, ref.taskTypeNames).map((x) => [x.parameter.id, x])), [group.data, ref]);
  const S = summarize(cur), P = summarize(prev), G = summarize(group.data ?? []);
  const rows = mine.map((m) => {
    const o = others.get(m.parameter.id);
    const gap = compareLabel && o?.evaluated ? variance(m.pct, o.pct) : null;
    return { m, o, gap, prevPct: before.get(m.parameter.id)?.evaluated ? before.get(m.parameter.id)!.pct : null };
  }).sort((a, b) => (a.gap ?? (a.m.pct ?? 0) - 100) - (b.gap ?? (b.m.pct ?? 0) - 100));
  const focus = rows.filter((r) => (r.gap !== null ? r.gap <= -5 : (r.m.pct ?? 100) < s.thresholds.amber) && r.m.deductions > 0).slice(0, 3);
  const strengths = [...rows].reverse().filter((r) => (r.m.pct ?? 0) >= s.thresholds.green && r.m.deductions === 0).slice(0, 3);
  const lost = cur.flatMap((e) => (e.autofail ? [] : e.scores.filter((x) => x.earned !== null && Number(x.earned) < Number(x.max_score)).map((x) => ({ e, x }))))
    .sort((a, b) => (Number(b.x.max_score) - Number(b.x.earned)) - (Number(a.x.max_score) - Number(a.x.earned)));
  const pointsLost = lost.reduce((a, l) => a + Number(l.x.max_score) - Number(l.x.earned), 0);
  const types = Object.keys(ref.taskTypeNames).filter((t) => cur.some((e) => e.task_type === t));

  if (!cur.length) return <Card title={`Deep dive · ${camName}`}><EmptyState title="No audits for this CAM in the selected period." /></Card>;
  return (
    <Card title={`Deep dive · ${camName}`} subtitle={<>{sel.label}{compareLabel ? <> · compared with <strong>{compareLabel}</strong> in the same period</> : null}</>}>
      <ErrorBox error={group.error} />
      <div className="flex flex-col gap-5">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <Kpi label="Tasks audited" value={S.tasks} sub={`${P.tasks} in ${sel.previousLabel}`} />
          <Kpi label="Average QA score" value={fmtPct(S.avg)} sub={<>vs previous <Variance value={variance(S.avg, P.avg)} /></>} />
          {compareLabel && <Kpi label={`${compareLabel} average`} value={group.loading ? '…' : fmtPct(G.avg)} sub={group.loading ? '' : <>gap <span className={gapTone(variance(S.avg, G.avg))}>{variance(S.avg, G.avg) === null ? '—' : `${variance(S.avg, G.avg)! > 0 ? '+' : ''}${variance(S.avg, G.avg)} pts`}</span></>} />}
          <Kpi label="Autofails" value={S.autofails} tone={S.autofails ? 'bad' : 'good'} sub={S.autofailRate === null ? '—' : `${S.autofailRate}% of tasks`} />
          <Kpi label="Points lost" value={pointsLost} sub={`on ${lost.length} parameter check(s)`} />
        </div>

        {(focus.length > 0 || strengths.length > 0) && (
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-lg border border-bad/30 bg-bad-soft/40 p-3">
              <div className="mb-1 text-[13px] font-semibold text-bad">Focus areas</div>
              {focus.length ? <ul className="flex flex-col gap-1 text-[13px]">{focus.map((r) => (
                <li key={r.m.parameter.id}><strong>{r.m.parameter.name}</strong> <span className="text-muted">({r.m.taskTypeName})</span>: {fmtPct(r.m.pct)}
                  {r.gap !== null && <> — <span className={gapTone(r.gap)}>{r.gap} pts</span> vs {compareLabel}</>}, {r.m.deductions} deduction(s)</li>))}</ul>
                : <p className="text-[13px] text-muted">No parameter is clearly below {compareLabel ?? 'target'}.</p>}
            </div>
            <div className="rounded-lg border border-good/30 bg-good-soft/40 p-3">
              <div className="mb-1 text-[13px] font-semibold text-good">Strengths</div>
              {strengths.length ? <ul className="flex flex-col gap-1 text-[13px]">{strengths.map((r) => (
                <li key={r.m.parameter.id}><strong>{r.m.parameter.name}</strong> <span className="text-muted">({r.m.taskTypeName})</span>: {fmtPct(r.m.pct)} on {r.m.evaluated} check(s), no deductions</li>))}</ul>
                : <p className="text-[13px] text-muted">No parameter at {s.thresholds.green}%+ without deductions yet.</p>}
            </div>
          </div>
        )}

        <div>
          <div className="mb-2 text-[13.5px] font-semibold">Every parameter, weakest first</div>
          <Table>
            <thead><tr><th className={th}>Task type</th><th className={th}>Parameter</th><th className={th + ' text-right'}>CAM</th>
              {compareLabel && <><th className={th + ' text-right'}>{compareLabel}</th><th className={th + ' text-right'}>Gap</th></>}
              <th className={th + ' text-right'}>Previous</th><th className={th + ' text-right'}>Change</th><th className={th + ' text-right'}>Checks</th><th className={th + ' text-right'}>Deductions</th><th className={th + ' text-right'}>Points lost</th></tr></thead>
            <tbody>{rows.map(({ m, o, gap, prevPct }) => (
              <tr key={m.parameter.id}>
                <td className={td + ' text-[12.5px] text-muted'}>{m.taskTypeName}</td>
                <td className={td + ' font-medium'}>{m.parameter.name}</td>
                <td className={td + ' text-right'}><ScoreBadge score={m.pct} settings={s} /></td>
                {compareLabel && <><td className={td + ' text-right tnum text-muted'}>{group.loading ? '…' : o?.evaluated ? fmtPct(o.pct) : '—'}</td>
                  <td className={td + ' text-right tnum ' + gapTone(gap)}>{gap === null ? '—' : `${gap > 0 ? '+' : ''}${gap}`}</td></>}
                <td className={td + ' text-right tnum text-muted'}>{prevPct === null ? '—' : fmtPct(prevPct)}</td>
                <td className={td + ' text-right'}><Variance value={variance(m.pct, prevPct)} /></td>
                <td className={td + ' text-right tnum'}>{m.evaluated}</td>
                <td className={td + ' text-right tnum'}>{m.deductions ? <span className="font-semibold text-bad">{m.deductions}</span> : 0}</td>
                <td className={td + ' text-right tnum'}>{m.pointsLost || 0}</td>
              </tr>
            ))}</tbody>
          </Table>
        </div>

        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
          <div>
            <div className="mb-2 text-[13.5px] font-semibold">By task type</div>
            <Table>
              <thead><tr><th className={th}>Task type</th><th className={th + ' text-right'}>Tasks</th><th className={th + ' text-right'}>CAM avg</th>{compareLabel && <th className={th + ' text-right'}>{compareLabel}</th>}<th className={th + ' text-right'}>Autofails</th></tr></thead>
              <tbody>{types.map((t) => {
                const x = summarize(cur.filter((e) => e.task_type === t));
                const g = summarize((group.data ?? []).filter((e) => e.task_type === t));
                return <tr key={t}><td className={td}>{ref.taskTypeNames[t]}</td><td className={td + ' text-right tnum'}>{x.tasks}</td><td className={td + ' text-right'}><ScoreBadge score={x.avg} settings={s} /></td>
                  {compareLabel && <td className={td + ' text-right tnum text-muted'}>{group.loading ? '…' : fmtPct(g.avg)}</td>}<td className={td + ' text-right tnum'}>{x.autofails}</td></tr>;
              })}</tbody>
            </Table>
          </div>
          <div>
            <div className="mb-2 text-[13.5px] font-semibold">Where points were lost ({lost.length})</div>
            {lost.length === 0 ? <p className="text-[13px] text-muted">No deductions in this period.</p> : (<>
              <Table>
                <thead><tr><th className={th}>Task</th><th className={th}>Parameter</th><th className={th + ' text-right'}>Score</th><th className={th}>QA remarks / feedback</th></tr></thead>
                <tbody>{(showAll ? lost : lost.slice(0, 10)).map(({ e, x }) => (
                  <tr key={x.id}>
                    <td className={td + ' whitespace-nowrap'}><Link to={`/evaluations/${e.id}`} className="font-mono text-[12px] text-brand hover:underline">{e.task_id.slice(0, 8)}</Link>
                      <div className="text-[11.5px] text-muted">{e.period_short_label} · {e.task_type_name}</div></td>
                    <td className={td + ' text-[13px]'}>{x.parameter_name}</td>
                    <td className={td + ' text-right tnum text-bad'}>{x.earned}/{x.max_score}</td>
                    <td className={td + ' max-w-[420px] whitespace-pre-wrap text-[12.5px] text-muted'}>{x.remarks || e.feedback || '—'}</td>
                  </tr>
                ))}</tbody>
              </Table>
              {lost.length > 10 && <button className="mt-2 text-[12.5px] font-medium text-brand hover:underline" onClick={() => setShowAll(!showAll)}>{showAll ? 'Show fewer' : `Show all ${lost.length}`}</button>}
            </>)}
          </div>
        </div>
      </div>
    </Card>
  );
}

/** Pick any weeks and see every parameter side by side, with the change from the first to the last week. */
export function WeekCompare({ camIds, scopeLabel, periods }: { camIds?: string[]; scopeLabel: string; periods: Period[] }) {
  const ref = useRef_();
  const s = ref.settings;
  const choices = useMemo(() => [...periods].sort((a, b) => b.start_date.localeCompare(a.start_date)).slice(0, 26), [periods]);
  const [picked, setPicked] = useState<string[]>(() => choices.slice(0, 4).map((p) => p.id));
  const weeks = choices.filter((p) => picked.includes(p.id)).sort((a, b) => a.start_date.localeCompare(b.start_date));
  const data = useAsync(() => (weeks.length ? repo.getEvaluations({ periodIds: weeks.map((w) => w.id), camIds }) : Promise.resolve([] as Evaluation[])), [weeks.map((w) => w.id).join(','), camIds?.join(',') ?? '']);
  const all = data.data ?? [];
  const types = Object.keys(ref.taskTypeNames).filter((t) => all.some((e) => e.task_type === t));
  const [type, setType] = useState('');
  const activeType = types.includes(type) ? type : types[0];
  const perWeek = useMemo(() => weeks.map((w) => new Map(parameterStats(all.filter((e) => e.period_id === w.id), ref.parameters, ref.taskTypeNames).map((x) => [x.parameter.id, x]))), [all, weeks, ref]);
  const params = ref.parameters.filter((p) => p.task_type === activeType && perWeek.some((m) => (m.get(p.id)?.evaluated ?? 0) > 0)).sort((a, b) => a.sort_order - b.sort_order);
  const sections = [...new Set(params.map((p) => p.section ?? ''))];
  const sums = weeks.map((w) => summarize(all.filter((e) => e.period_id === w.id && (!activeType || e.task_type === activeType))));
  const overall = weeks.map((w) => summarize(all.filter((e) => e.period_id === w.id)));
  const toggle = (id: string) => setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : picked.length >= 8 ? picked : [...picked, id]);
  const pctOf = (st: ParamStat | undefined) => (st?.evaluated ? st.pct : null);

  return (
    <Card title="Compare weeks" subtitle={<>{scopeLabel} · pick 2–8 weeks to see every parameter side by side</>}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-1.5">{choices.map((p) => (
          <button key={p.id} onClick={() => toggle(p.id)} aria-pressed={picked.includes(p.id)}
            className={clsx('rounded-full border px-2.5 py-1 text-[12.5px] font-medium', picked.includes(p.id) ? 'border-brand bg-brand-soft text-brand' : 'border-line text-muted hover:text-ink')}>
            {p.short_label}{p.status !== 'published' ? ' (draft)' : ''}</button>
        ))}</div>
        <ErrorBox error={data.error} />
        {weeks.length < 2 ? <p className="text-[13px] text-muted">Choose at least two weeks.</p> : data.loading ? <Loading /> : !all.length ? <EmptyState title="No audits in the chosen weeks." /> : (<>
          <TrendChart points={weeklyTrend(all, weeks)} settings={s} height={200} />
          <div className="flex flex-wrap gap-2">{types.map((t) => (
            <button key={t} onClick={() => setType(t)} className={clsx('rounded-full border px-3 py-1 text-[13px] font-medium', t === activeType ? 'border-brand bg-brand-soft text-brand' : 'border-line text-muted hover:text-ink')}>
              {ref.taskTypeNames[t]}</button>))}</div>
          <Table>
            <thead><tr><th className={th}>Parameter</th>{weeks.map((w) => <th key={w.id} className={th + ' text-right'}>{w.short_label}</th>)}<th className={th + ' text-right'}>Change {weeks[0].short_label} → {weeks[weeks.length - 1].short_label}</th></tr></thead>
            <tbody>
              <tr className="bg-sunken/40"><td className={td + ' font-semibold'}>Tasks audited (all types)</td>{overall.map((x, i) => <td key={i} className={td + ' text-right tnum'}>{x.tasks}</td>)}<td className={td} /></tr>
              <tr className="bg-sunken/40"><td className={td + ' font-semibold'}>Average QA score (all types)</td>{overall.map((x, i) => <td key={i} className={td + ' text-right'}><ScoreBadge score={x.avg} settings={s} /></td>)}
                <td className={td + ' text-right'}><Variance value={variance(overall[overall.length - 1].avg, overall[0].avg)} /></td></tr>
              <tr className="bg-sunken/40"><td className={td + ' font-semibold'}>Autofails (all types)</td>{overall.map((x, i) => <td key={i} className={td + ' text-right tnum'}>{x.autofails}</td>)}<td className={td} /></tr>
              <tr className="bg-sunken/40"><td className={td + ' font-semibold'}>{ref.taskTypeNames[activeType]} tasks · average</td>{sums.map((x, i) => <td key={i} className={td + ' text-right tnum text-[12.5px]'}>{x.tasks} · {fmtPct(x.avg, 1)}</td>)}
                <td className={td + ' text-right'}><Variance value={variance(sums[sums.length - 1].avg, sums[0].avg)} /></td></tr>
              {sections.map((sec) => (
                <Fragment key={sec}>
                  {sec && <tr><td colSpan={weeks.length + 2} className="bg-sunken px-3 py-1.5 text-[11.5px] font-semibold uppercase tracking-wide text-muted">{sec}</td></tr>}
                  {params.filter((p) => (p.section ?? '') === sec).map((p) => {
                    const vals = perWeek.map((m) => pctOf(m.get(p.id)));
                    const first = vals.find((v) => v !== null) ?? null;
                    const last = [...vals].reverse().find((v) => v !== null) ?? null;
                    return (
                      <tr key={p.id}><td className={td + ' font-medium'}>{p.name}</td>
                        {vals.map((v, i) => <td key={i} className={td + ' text-right'}>{v === null ? <span className="text-faint">—</span> : <ScoreBadge score={v} settings={s} />}
                          {(perWeek[i].get(p.id)?.deductions ?? 0) > 0 && <div className="text-[11px] text-bad">{perWeek[i].get(p.id)!.deductions} ded.</div>}</td>)}
                        <td className={td + ' text-right'}><Variance value={variance(last, first)} /></td></tr>
                    );
                  })}
                </Fragment>
              ))}
            </tbody>
          </Table>
          <p className="text-[12px] text-muted">Parameter % excludes autofailed tasks, the same as the table above. "ded." = number of checks with points deducted that week.</p>
        </>)}
      </div>
    </Card>
  );
}
