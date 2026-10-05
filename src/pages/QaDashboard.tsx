import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useApp, useRef_ } from '../app/context';
import { useScopeData } from '../app/useScope';
import { PageHeader } from '../components/Layout';
import { PeriodPicker, usePeriodSelection } from '../components/PeriodPicker';
import { Card, ErrorBox, Kpi, Loading, ScoreBadge, StatusBadge, Tabs, Table, td, th, Variance, inputCls, inputBase } from '../components/ui';
import { TrendChart } from '../components/charts';
import { CamTable } from '../components/CamTable';
import { DownloadMenu, ParameterAnalysis } from '../components/shared';
import { APPEAL_STATUS_LABEL, band, camRows, fmtDate, fmtPct, isOpenAppeal, summarize, variance, weeklyTrend } from '../lib/metrics';
import { buildReport } from '../lib/report';
import type { AppealStatus } from '../lib/types';

type View = 'org' | 'lead' | 'cam';

export default function QaDashboard() {
  const { me } = useApp();
  const ref = useRef_();
  const s = ref.settings;
  const nav = useNavigate();
  const [sel, setSel, periods] = usePeriodSelection(true);
  const [view, setView] = useState<View>('org');
  const [leadId, setLeadId] = useState('');
  const [taskType, setTaskType] = useState('');
  const [autofail, setAutofail] = useState<'' | 'yes' | 'no'>('');
  const [minScore, setMinScore] = useState('');
  const [maxScore, setMaxScore] = useState('');
  const [appealStatus, setAppealStatus] = useState<'' | AppealStatus>('');
  const [camPick, setCamPick] = useState('');
  const data = useScopeData(sel);

  const leads = ref.employees.filter((e) => e.role === 'admin');
  const teamOfLead = (id: string) => ref.teams.filter((t) => t.lead_id === id).map((t) => t.id);
  const allCams = ref.employees.filter((e) => e.role === 'user');
  const cams = allCams.filter((c) => !leadId || (c.team_id && teamOfLead(leadId).includes(c.team_id)));
  const camSet = new Set(cams.map((c) => c.id));
  const evFilter = (list: typeof data.cur) => list.filter((e) => camSet.has(e.cam_id) && (!taskType || e.task_type === taskType)
    && (!autofail || (autofail === 'yes') === e.autofail));
  const cur = useMemo(() => evFilter(data.cur), [data.cur, leadId, taskType, autofail]); // eslint-disable-line react-hooks/exhaustive-deps
  const prev = useMemo(() => evFilter(data.prev), [data.prev, leadId, taskType, autofail]); // eslint-disable-line react-hooks/exhaustive-deps
  const history = useMemo(() => evFilter(data.history), [data.history, leadId, taskType, autofail]); // eslint-disable-line react-hooks/exhaustive-deps
  const S = summarize(cur); const P = summarize(prev);
  const appeals = data.appeals.filter((a) => camSet.has(a.cam_id));
  const rowsAll = useMemo(() => camRows(cams, ref.teams, ref.employees, cur, prev, history, data.historyWeeks, appeals, s), [cams, cur, prev, history, appeals]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = rowsAll.filter((r) => (r.tasks > 0 || r.prevAvg !== null)
    && (!minScore || (r.avg ?? -1) >= Number(minScore)) && (!maxScore || (r.avg ?? 101) <= Number(maxScore))
    && (!appealStatus || appeals.some((a) => a.cam_id === r.cam.id && a.status === appealStatus)));
  const active = rowsAll.filter((r) => r.tasks > 0);
  const draftSelected = sel.current.some((p) => p.status === 'draft');

  const leadRows = leads.map((l) => {
    const t = teamOfLead(l.id);
    const ids = new Set(allCams.filter((c) => c.team_id && t.includes(c.team_id)).map((c) => c.id));
    const a = summarize(cur.filter((e) => ids.has(e.cam_id))); const b = summarize(prev.filter((e) => ids.has(e.cam_id)));
    return { lead: l, teams: ref.teams.filter((x) => t.includes(x.id)).map((x) => x.name).join(', '), cams: ids.size, a, b,
      open: appeals.filter((x) => ids.has(x.cam_id) && isOpenAppeal(x)).length, meets: rowsAll.filter((r) => ids.has(r.cam.id) && r.meetsTarget).length };
  });

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="QA Master Dashboard" subtitle={<>Organisation-wide CS QA performance · Showing <strong>{sel.label}</strong>{draftSelected && <span className="ml-2 rounded bg-warn-soft px-1.5 py-0.5 text-[12px] font-semibold text-warn">Includes an unpublished week (visible to QA only)</span>}</>}
        actions={<>
          <PeriodPicker sel={sel} onChange={setSel} periods={periods} />
          <DownloadMenu label="Download Consolidated" build={() => buildReport({ kind: 'org', subject: leadId ? `Team Lead: ${leads.find((l) => l.id === leadId)?.full_name}` : 'All teams', sel, cur, prev, history,
            historyWeeks: data.historyWeeks, appeals, parameters: ref.parameters, settings: s, taskTypeNames: ref.taskTypeNames, generatedBy: me!.full_name, cams, teams: ref.teams, employees: ref.employees })} />
        </>} />

      <Card pad={false}>
        <div className="flex flex-wrap items-end gap-3 p-3">
          <Filter id="f-lead" label="Team Lead"><select id="f-lead" className={inputCls} value={leadId} onChange={(e) => setLeadId(e.target.value)}><option value="">All Team Leads</option>{leads.map((l) => <option key={l.id} value={l.id}>{l.full_name}</option>)}</select></Filter>
          <Filter id="f-type" label="Task type"><select id="f-type" className={inputCls} value={taskType} onChange={(e) => setTaskType(e.target.value)}><option value="">All task types</option>{ref.taskTypes.map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}</select></Filter>
          <Filter id="f-af" label="Autofail"><select id="f-af" className={inputCls} value={autofail} onChange={(e) => setAutofail(e.target.value as '' | 'yes' | 'no')}><option value="">Any</option><option value="yes">Autofail only</option><option value="no">Exclude autofails</option></select></Filter>
          <Filter id="f-min" label="CAM average from (%)"><input id="f-min" type="number" min={0} max={100} className={inputBase + ' w-24'} value={minScore} onChange={(e) => setMinScore(e.target.value)} /></Filter>
          <Filter id="f-max" label="to (%)"><input id="f-max" type="number" min={0} max={100} className={inputBase + ' w-24'} value={maxScore} onChange={(e) => setMaxScore(e.target.value)} /></Filter>
          <Filter id="f-appeal" label="Appeal status"><select id="f-appeal" className={inputCls} value={appealStatus} onChange={(e) => setAppealStatus(e.target.value as '' | AppealStatus)}><option value="">Any</option>{(Object.keys(APPEAL_STATUS_LABEL) as AppealStatus[]).map((k) => <option key={k} value={k}>{APPEAL_STATUS_LABEL[k]}</option>)}</select></Filter>
          <Filter id="f-cam" label="Open CAM"><select id="f-cam" className={inputCls} value={camPick} onChange={(e) => { setCamPick(e.target.value); if (e.target.value) nav(`/cams/${e.target.value}`); }}><option value="">Choose a CAM…</option>{allCams.map((c) => <option key={c.id} value={c.id}>{c.full_name}</option>)}</select></Filter>
        </div>
      </Card>
      <ErrorBox error={data.error} />
      {data.loading ? <Loading /> : (<>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <Kpi label="CAMs Evaluated" value={active.length} sub={`of ${cams.length} active CAMs`} />
          <Kpi label="Tasks Audited" value={S.tasks} sub={`${P.tasks} previous`} />
          <Kpi label="Overall QA Score" term="Average QA Score" value={fmtPct(S.avg)} tone={band(S.avg, s) === 'green' ? 'good' : band(S.avg, s) === 'amber' ? 'warn' : band(S.avg, s) === 'red' ? 'bad' : 'neutral'} sub={<Variance value={variance(S.avg, P.avg)} />} />
          <Kpi label="Total Autofails" value={S.autofails} tone={S.autofails ? 'bad' : 'neutral'} sub={S.autofailRate === null ? '—' : `${S.autofailRate.toFixed(2)}% of tasks`} />
          <Kpi label="Appeals Received" value={appeals.filter((a) => cur.some((e) => e.id === a.evaluation_id) && a.status !== 'draft').length} sub="on this period’s tasks" />
          <Kpi label="Awaiting Lead Review" value={appeals.filter((a) => a.status === 'pending_lead_review').length} sub={`${appeals.filter((a) => a.status === 'pending_lead_review' && a.overdue).length} overdue`} />
          <Kpi label="Awaiting QA Review" value={appeals.filter((a) => a.status === 'pending_qa_review').length} tone={appeals.some((a) => a.status === 'pending_qa_review' && a.overdue) ? 'bad' : 'neutral'} sub={`${appeals.filter((a) => a.status === 'pending_additional_info').length} awaiting info`} />
          <Kpi label="Appeals Resolved" value={appeals.filter((a) => ['approved', 'partially_approved', 'rejected'].includes(a.status)).length} sub="all periods" />
          <Kpi label="CAMs Meeting Target" value={`${active.filter((r) => r.meetsTarget).length}/${active.length}`} tone="good" sub={`≥ ${s.qa_target.score}%`} />
          <Kpi label="Need QA Attention" value={active.filter((r) => r.needsAttention).length} tone={active.some((r) => r.needsAttention) ? 'warn' : 'neutral'} sub={`< ${s.thresholds.amber}%, autofail or −5 pp`} />
        </div>

        <Tabs value={view} onChange={setView} tabs={[{ value: 'org', label: 'Organisation view' }, { value: 'lead', label: 'By Team Lead' }, { value: 'cam', label: 'Individual CAMs' }]} />

        {view === 'org' && (
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            <Card title="Weekly trend (all filtered CAMs)"><TrendChart points={weeklyTrend(history, data.historyWeeks)} settings={s} selectedIds={sel.current.map((p) => p.id)} /></Card>
            <Card title="Appeals awaiting QA decision" actions={<Link to="/appeals" className="text-[13px] font-medium text-brand hover:underline">Open queue</Link>}>
              {appeals.filter((a) => a.status === 'pending_qa_review').length === 0 ? <p className="text-[13px] text-muted">Nothing waiting for QA.</p> : (
                <ul className="flex flex-col divide-y divide-line">
                  {appeals.filter((a) => a.status === 'pending_qa_review').slice(0, 6).map((a) => (
                    <li key={a.id} className="py-2">
                      <Link to={`/appeals/${a.id}`} className="flex flex-wrap items-center justify-between gap-2 hover:text-brand">
                        <span><span className="font-mono text-[12.5px]">{a.reference}</span> · {a.cam_name}</span><StatusBadge status={a.status} overdue={a.overdue} />
                      </Link>
                      <div className="text-[12px] text-muted">{a.parameters_label} · forwarded {fmtDate(a.forwarded_at)}</div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <div className="xl:col-span-2">
              <Card title="Consolidated CAM performance" subtitle="Sort any column. Click a CAM for their detailed dashboard." pad={false}><CamTable rows={rows} settings={s} /></Card>
            </div>
            <div className="xl:col-span-2">
              <Card title="Parameter performance (organisation)"><ParameterAnalysis cur={cur} prev={prev} parameters={ref.parameters} taskTypeNames={ref.taskTypeNames} settings={s} /></Card>
            </div>
          </div>
        )}
        {view === 'lead' && (
          <Card title="Team Lead comparison" pad={false}>
            <Table>
              <thead><tr><th className={th}>Team Lead</th><th className={th}>Team(s)</th><th className={th + ' text-right'}>CAMs</th><th className={th + ' text-right'}>Tasks</th>
                <th className={th + ' text-right'}>Average</th><th className={th + ' text-right'}>Previous</th><th className={th + ' text-right'}>Variance</th><th className={th + ' text-right'}>Autofails</th>
                <th className={th + ' text-right'}>Meeting target</th><th className={th + ' text-right'}>Open appeals</th></tr></thead>
              <tbody>{leadRows.map((r) => (
                <tr key={r.lead.id} className="cursor-pointer hover:bg-sunken/60" onClick={() => { setLeadId(r.lead.id); setView('cam'); }}>
                  <td className={td + ' font-medium'}>{r.lead.full_name}</td><td className={td + ' text-muted'}>{r.teams || '—'}</td><td className={td + ' text-right tnum'}>{r.cams}</td>
                  <td className={td + ' text-right tnum'}>{r.a.tasks}</td><td className={td + ' text-right'}><ScoreBadge score={r.a.avg} settings={s} /></td>
                  <td className={td + ' text-right tnum text-muted'}>{fmtPct(r.b.avg)}</td><td className={td + ' text-right'}><Variance value={variance(r.a.avg, r.b.avg)} /></td>
                  <td className={td + ' text-right tnum'}>{r.a.autofails}</td><td className={td + ' text-right tnum'}>{r.meets}</td><td className={td + ' text-right tnum'}>{r.open}</td>
                </tr>))}</tbody>
            </Table>
          </Card>
        )}
        {view === 'cam' && (
          <Card title="Consolidated CAM performance" subtitle="Sort any column. Click a CAM for their detailed dashboard." pad={false}>
            <CamTable rows={rows} settings={s} />
          </Card>
        )}
      </>)}
    </div>
  );
}

function Filter({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return <div className="flex min-w-[140px] flex-col gap-1"><label htmlFor={id} className="text-[12px] font-medium text-muted">{label}</label>{children}</div>;
}
