import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useApp, useRef_ } from '../app/context';
import { useScopeData } from '../app/useScope';
import { PageHeader } from '../components/Layout';
import { PeriodPicker, usePeriodSelection } from '../components/PeriodPicker';
import { Card, EmptyState, ErrorBox, Kpi, Loading, ScoreBadge, StatusBadge, Table, td, th, Variance } from '../components/ui';
import { TrendSwitch } from '../components/charts';
import { CamTable } from '../components/CamTable';
import { DownloadMenu, ParameterAnalysis } from '../components/shared';
import { isReportee, band, camRows, fmtDate, fmtPct, summarize, variance } from '../lib/metrics';
import { buildReport } from '../lib/report';

export default function LeadDashboard() {
  const { me } = useApp();
  const ref = useRef_();
  const s = ref.settings;
  const [sel, setSel, periods] = usePeriodSelection();
  const myTeams = ref.teams.filter((t) => t.lead_id === me!.id);
  const cams = ref.employees.filter((e) => e.id !== me!.id && isReportee(e) && e.team_id && myTeams.some((t) => t.id === e.team_id));
  const data = useScopeData(sel, undefined, 26);
  const cur = summarize(data.cur);
  const prev = summarize(data.prev);
  const rows = useMemo(() => camRows(cams, ref.teams, ref.employees, data.cur, data.prev, data.history, data.historyWeeks, data.appeals, s),
    [cams, ref.teams, ref.employees, data, s]);
  const queue = data.appeals.filter((a) => a.status === 'pending_lead_review');
  const waitingQa = data.appeals.filter((a) => a.status === 'pending_qa_review' || a.status === 'pending_additional_info');
  const active = rows.filter((r) => r.tasks > 0);

  if (!myTeams.length) return <EmptyState title="No team assigned" body="You are not set as the Team Lead of any team yet. Ask the QA team to assign your CAMs." />;
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Team Performance" subtitle={<>{myTeams.map((t) => t.name).join(', ')} · {cams.length} CAMs · Showing <strong>{sel.label}</strong></>}
        actions={<>
          <PeriodPicker sel={sel} onChange={setSel} periods={periods} />
          <DownloadMenu label="Download Team Report" empty={!data.loading && data.cur.length === 0} build={() => buildReport({ kind: 'team', subject: myTeams.map((t) => t.name).join(', '), sel, cur: data.cur, prev: data.prev,
            history: data.history, historyWeeks: data.historyWeeks, appeals: data.appeals, parameters: ref.parameters, settings: s, taskTypeNames: ref.taskTypeNames,
            generatedBy: me!.full_name, cams, teams: ref.teams, employees: ref.employees })} />
        </>} />
      <ErrorBox error={data.error} />
      {data.loading ? <Loading /> : (<>
        {data.cur.length === 0 && <EmptyState title="No QA evaluations are available for this reporting period." body="Choose another week or period above." />}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Kpi label="Team QA Score" term="Average QA Score" value={fmtPct(cur.avg)} tone={band(cur.avg, s) === 'green' ? 'good' : band(cur.avg, s) === 'amber' ? 'warn' : band(cur.avg, s) === 'red' ? 'bad' : 'neutral'} sub={`Previous ${fmtPct(prev.avg)}`} />
          <Kpi label="Score Variance" term="Score Variance" value={<Variance value={variance(cur.avg, prev.avg)} />} sub={`vs ${sel.previousLabel}`} />
          <Kpi label="Tasks Audited" term="Tasks Audited" value={cur.tasks} sub={`${active.length} of ${cams.length} CAMs audited`} />
          <Kpi label="Autofails" term="Autofails" value={cur.autofails} tone={cur.autofails ? 'bad' : 'neutral'} sub={cur.autofailRate === null ? '—' : `${cur.autofailRate.toFixed(2)}% of tasks`} />
          <Kpi label="CAMs Meeting Target" term="Meeting Target" value={`${active.filter((r) => r.meetsTarget).length}/${active.length}`} sub={`Target ${s.qa_target.score}%`} />
          <Kpi label="Appeals Awaiting You" value={queue.length} tone={queue.some((a) => a.overdue) ? 'bad' : queue.length ? 'warn' : 'neutral'} sub={`${waitingQa.length} with QA`} />
        </div>

        <div className="grid gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <Card title="Team performance trend" subtitle="Average of all audited tasks for your CAMs, by week or by month.">
            <TrendSwitch history={data.history} weeks={data.historyWeeks} selected={sel.current} settings={s} />
          </Card>
          <Card title="Appeals awaiting your review" subtitle="CAM appeals come to you before QA." actions={<Link to="/appeals" className="text-[13px] font-medium text-brand hover:underline">Open queue</Link>}>
            {queue.length === 0 ? <p className="text-[13px] text-muted">No appeals are waiting for your review.</p> : (
              <ul className="flex flex-col divide-y divide-line">
                {queue.slice(0, 6).map((a) => (
                  <li key={a.id} className="py-2">
                    <Link to={`/appeals/${a.id}`} className="flex flex-wrap items-center justify-between gap-2 hover:text-brand">
                      <span><span className="font-mono text-[12.5px]">{a.reference}</span> · <span className="font-medium">{a.cam_name}</span></span>
                      <StatusBadge status={a.status} overdue={a.overdue} />
                    </Link>
                    <div className="text-[12px] text-muted">{a.parameters_label} · submitted {fmtDate(a.submitted_at)} · {a.days_in_status} day(s) waiting</div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <Card title="CAM comparison" subtitle="Click a CAM for their full dashboard, task feedback and trends." pad={false}>
          <CamTable rows={rows} settings={s} showLead={myTeams.length > 1} />
        </Card>

        <Card title="Team parameter performance" subtitle="Where the team is losing points this period.">
          <ParameterAnalysis cur={data.cur} prev={data.prev} parameters={ref.parameters} taskTypeNames={ref.taskTypeNames} settings={s} />
        </Card>

        <Card title="Task type mix" pad={false}>
          <Table>
            <thead><tr><th className={th}>Task type</th><th className={th + ' text-right'}>Tasks</th><th className={th + ' text-right'}>Average</th><th className={th + ' text-right'}>Previous</th><th className={th + ' text-right'}>Autofails</th></tr></thead>
            <tbody>{ref.taskTypes.map((t) => {
              const a = summarize(data.cur.filter((e) => e.task_type === t.code)); const b = summarize(data.prev.filter((e) => e.task_type === t.code));
              if (!a.tasks && !b.tasks) return null;
              return <tr key={t.code}><td className={td}>{t.name}</td><td className={td + ' text-right tnum'}>{a.tasks}</td><td className={td + ' text-right'}><ScoreBadge score={a.avg} settings={s} /></td><td className={td + ' text-right tnum text-muted'}>{fmtPct(b.avg)}</td><td className={td + ' text-right tnum'}>{a.autofails}</td></tr>;
            })}
            {!data.cur.length && !data.prev.length && <tr><td colSpan={5} className="px-3 py-6 text-center text-muted">No QA evaluations are available for this reporting period.</td></tr>}</tbody>
          </Table>
        </Card>
      </>)}
    </div>
  );
}
