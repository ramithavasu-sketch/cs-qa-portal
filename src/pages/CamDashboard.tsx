import { useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { useApp, useRef_ } from '../app/context';
import { useScopeData } from '../app/useScope';
import { PageHeader } from '../components/Layout';
import { PeriodPicker, usePeriodSelection } from '../components/PeriodPicker';
import { Card, EmptyState, ErrorBox, Kpi, Loading, ScoreBadge, StatusBadge, Table, td, th, Variance } from '../components/ui';
import { TrendChart } from '../components/charts';
import { DownloadMenu, EvaluationsTable, InsightsPanel, ParameterAnalysis } from '../components/shared';
import { band, BAND_LABEL, buildInsights, fmtDate, fmtPct, isOpenAppeal, summarize, variance, weeklyTrend } from '../lib/metrics';
import { buildReport } from '../lib/report';

export default function CamDashboard() {
  const { camId: routeCam } = useParams();
  const { me } = useApp();
  const ref = useRef_();
  const camId = routeCam ?? me!.id;
  const cam = ref.employees.find((e) => e.id === camId) ?? (camId === me!.id ? me! : null);
  const [sel, setSel, periods] = usePeriodSelection();
  const data = useScopeData(sel, [camId]);
  const s = ref.settings;

  const cur = summarize(data.cur);
  const prev = summarize(data.prev);
  const v = variance(cur.avg, prev.avg);
  const trend = useMemo(() => weeklyTrend(data.history, data.historyWeeks), [data.history, data.historyWeeks]);
  const insights = useMemo(() => buildInsights(data.cur, data.prev, data.history, data.historyWeeks, ref.parameters, ref.taskTypeNames, s),
    [data.cur, data.prev, data.history, data.historyWeeks, ref.parameters, ref.taskTypeNames, s]);
  const curIds = new Set(data.cur.map((e) => e.id));
  const periodAppeals = data.appeals.filter((a) => curIds.has(a.evaluation_id));
  const appealedIds = new Set(data.appeals.filter((a) => a.status !== 'closed').map((a) => a.evaluation_id));
  const isSelf = camId === me!.id;
  const periodWord = sel.mode === 'week' ? 'Week' : sel.mode === 'month' ? 'Month' : sel.mode === 'quarter' ? 'Quarter' : 'Period';
  const b = band(cur.avg, s);

  if (!cam) return <EmptyState title="CAM not found" body="This CAM is not in your reporting scope." />;

  return (
    <div className="flex flex-col gap-5">
      {!isSelf && <Link to="/" className="inline-flex items-center gap-1 text-[13px] text-brand hover:underline"><ArrowLeft className="h-4 w-4" />Back to dashboard</Link>}
      <PageHeader
        title={isSelf ? 'My QA Performance' : cam.full_name}
        subtitle={<>{isSelf ? `${me!.team_name ?? 'No team'}${me!.lead_name ? ` · Team Lead: ${me!.lead_name}` : ''}` : cam.email} · Showing <strong>{sel.label}</strong></>}
        actions={<>
          <PeriodPicker sel={sel} onChange={setSel} periods={periods} />
          <DownloadMenu build={() => buildReport({ kind: 'cam', subject: cam.full_name, sel, cur: data.cur, prev: data.prev, history: data.history, historyWeeks: data.historyWeeks,
            appeals: data.appeals, parameters: ref.parameters, settings: s, taskTypeNames: ref.taskTypeNames, generatedBy: me!.full_name })} />
        </>}
      />
      <ErrorBox error={data.error} />
      {data.loading ? <Loading /> : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Kpi label={`Current ${periodWord} QA Score`} term="Average QA Score" value={fmtPct(cur.avg)}
              tone={b === 'green' ? 'good' : b === 'amber' ? 'warn' : b === 'red' ? 'bad' : 'neutral'}
              sub={cur.avg === null ? 'No evaluations in this period' : `${BAND_LABEL[b]} · target ${s.qa_target.score}%`} />
            <Kpi label={`Previous ${periodWord} Score`} value={fmtPct(prev.avg)} sub={sel.previousLabel} />
            <Kpi label="Score Variance" term="Score Variance" value={<Variance value={v} />} sub="percentage points vs previous" />
            <Kpi label="Tasks Audited" value={cur.tasks} sub={`${prev.tasks} in previous period`} />
            <Kpi label="Autofails" term="Autofails" value={cur.autofails} tone={cur.autofails ? 'bad' : 'neutral'} sub={cur.tasks ? `${cur.autofailRate?.toFixed(2)}% of tasks · limit < ${s.qa_target.autofail_rate_max}%` : '—'} />
            <Kpi label="Appeals Submitted" value={periodAppeals.filter((a) => a.status !== 'draft').length} sub="on tasks in this period" />
            <Kpi label="Appeals Pending" value={data.appeals.filter(isOpenAppeal).length} sub="all periods" tone={data.appeals.some((a) => a.status === 'returned_to_cam' || (a.status === 'pending_additional_info' && a.info_requested_from === 'cam')) ? 'warn' : 'neutral'} />
            <Kpi label="Appeals Resolved" value={data.appeals.filter((a) => ['approved', 'partially_approved', 'rejected'].includes(a.status)).length} sub="all periods" />
          </div>
          {data.appeals.some((a) => a.status === 'returned_to_cam' || (a.status === 'pending_additional_info' && a.info_requested_from === 'cam')) && isSelf && (
            <div className="rounded-lg border border-warn/40 bg-warn-soft px-4 py-3 text-[13.5px] text-warn">
              Action needed: an appeal is waiting for more information from you. <Link className="font-semibold underline" to="/appeals">Open appeals</Link>
            </div>
          )}

          <div className="grid gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            <Card title="Weekly performance trend" subtitle={`Weekly average vs ${s.qa_target.score}% target. Selected period is highlighted. Weeks without audits show “No Data”.`}>
              <TrendChart points={trend} settings={s} selectedIds={sel.current.map((p) => p.id)} />
            </Card>
            <Card title="Summary by task type" subtitle={sel.label}>
              {data.cur.length === 0 ? <p className="text-[13px] text-muted">No QA evaluations are available for this reporting period.</p> : (
                <Table>
                  <thead><tr><th className={th}>Task type</th><th className={th + ' text-right'}>Tasks</th><th className={th + ' text-right'}>Average</th><th className={th + ' text-right'}>Autofails</th><th className={th + ' text-right'}>FCR</th></tr></thead>
                  <tbody>
                    {ref.taskTypes.map((t) => {
                      const x = summarize(data.cur.filter((e) => e.task_type === t.code));
                      if (!x.tasks) return null;
                      return (<tr key={t.code}><td className={td}>{t.name}</td><td className={td + ' text-right tnum'}>{x.tasks}</td><td className={td + ' text-right'}><ScoreBadge score={x.avg} settings={s} /></td>
                        <td className={td + ' text-right tnum'}>{x.autofails}</td><td className={td + ' text-right tnum'}>{fmtPct(x.fcrRate, 0)}</td></tr>);
                    })}
                    <tr className="font-semibold"><td className={td}>All</td><td className={td + ' text-right tnum'}>{cur.tasks}</td><td className={td + ' text-right'}><ScoreBadge score={cur.avg} settings={s} /></td>
                      <td className={td + ' text-right tnum'}>{cur.autofails}</td><td className={td + ' text-right tnum'}>{fmtPct(cur.fcrRate, 0)}</td></tr>
                  </tbody>
                </Table>
              )}
            </Card>
          </div>

          <Card title="Parameter-level performance" subtitle="Which parameters contributed to the score, compared with the previous period.">
            <ParameterAnalysis cur={data.cur} prev={data.prev} parameters={ref.parameters} taskTypeNames={ref.taskTypeNames} settings={s} />
          </Card>

          <Card title="Strengths and improvement areas" subtitle={`${sel.label} compared with ${sel.previousLabel}`}>
            {data.cur.length ? <InsightsPanel insights={insights} /> : <p className="text-[13px] text-muted">No QA evaluations are available for this reporting period.</p>}
          </Card>

          <Card title="Task-level audit results" subtitle="Open a task to see every parameter, the QA feedback and to raise an appeal." pad={false}>
            <EvaluationsTable evals={data.cur} settings={s} appealedIds={appealedIds} />
          </Card>

          {periodAppeals.length > 0 && (
            <Card title="Appeals on this period’s tasks" pad={false}>
              <Table>
                <thead><tr><th className={th}>Reference</th><th className={th}>Task</th><th className={th}>Disputed</th><th className={th}>Status</th><th className={th}>Submitted</th></tr></thead>
                <tbody>{periodAppeals.map((a) => (
                  <tr key={a.id}><td className={td}><Link to={`/appeals/${a.id}`} className="font-mono text-[12.5px] text-brand hover:underline">{a.reference}</Link></td>
                    <td className={td + ' font-mono text-[12px]'}>{a.task_id.slice(0, 8)}</td><td className={td}>{a.parameters_label}</td>
                    <td className={td}><StatusBadge status={a.status} overdue={a.overdue} /></td><td className={td + ' text-muted'}>{fmtDate(a.submitted_at)}</td></tr>
                ))}</tbody>
              </Table>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
