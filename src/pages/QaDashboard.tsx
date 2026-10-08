import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp, useRef_ } from '../app/context';
import { useScopeData } from '../app/useScope';
import { PageHeader } from '../components/Layout';
import { PeriodPicker, usePeriodSelection } from '../components/PeriodPicker';
import { Card, EmptyState, ErrorBox, Kpi, Loading, ScoreBadge, StatusBadge, Tabs, Table, td, th, Variance, inputCls, inputBase } from '../components/ui';
import { TrendSwitch } from '../components/charts';
import CamDashboard from './CamDashboard';
import { CamTable } from '../components/CamTable';
import { DownloadMenu, ParameterAnalysis } from '../components/shared';
import { isReportee, APPEAL_STATUS_LABEL, band, camRows, fmtDate, fmtPct, isOpenAppeal, isPendingAppeal, isResolvedAppeal, summarize, variance } from '../lib/metrics';
import { buildReport } from '../lib/report';
import type { AppealStatus } from '../lib/types';

type View = 'org' | 'lead' | 'cam';

export default function QaDashboard() {
  const { me } = useApp();
  const ref = useRef_();
  const s = ref.settings;
  const [sel, setSel, periods] = usePeriodSelection(true);
  const [view, setView] = useState<View>('org');
  const [leadId, setLeadId] = useState('');
  const [taskType, setTaskType] = useState('');
  const [autofail, setAutofail] = useState<'' | 'yes' | 'no'>('');
  const [minScore, setMinScore] = useState('');
  const [maxScore, setMaxScore] = useState('');
  const [appealStatus, setAppealStatus] = useState<'' | AppealStatus>('');
  const [camPick, setCamPick] = useState('');
  const [category, setCategory] = useState('');
  const data = useScopeData(sel, undefined, 26);
  // Evaluation categories = parameter sections (e.g. IB Call Soft Skills / Technical Skills), without rubric-version suffixes.
  const catOf = (sec: string | null) => (sec ?? '').split(' · ')[0];
  const categories = [...new Set(ref.parameters.filter((p) => p.active && p.section).map((p) => catOf(p.section)))].sort();
  const catTypes = new Set(ref.parameters.filter((p) => category && catOf(p.section) === category).map((p) => p.task_type));
  const catParams = category ? ref.parameters.filter((p) => catOf(p.section) === category) : ref.parameters;

  const leads = ref.employees.filter((e) => e.role === 'admin');
  const teamOfLead = (id: string) => ref.teams.filter((t) => t.lead_id === id).map((t) => t.id);
  const allCams = ref.employees.filter(isReportee);
  const cams = allCams.filter((c) => (!leadId || (c.team_id && teamOfLead(leadId).includes(c.team_id))) && (!camPick || c.id === camPick));
  const camSet = new Set(cams.map((c) => c.id));
  const evFilter = (list: typeof data.cur) => list.filter((e) => camSet.has(e.cam_id) && (!taskType || e.task_type === taskType)
    && (!autofail || (autofail === 'yes') === e.autofail) && (!category || catTypes.has(e.task_type)));
  const deps = [leadId, taskType, autofail, camPick, category];
  const cur = useMemo(() => evFilter(data.cur), [data.cur, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  const prev = useMemo(() => evFilter(data.prev), [data.prev, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  const history = useMemo(() => evFilter(data.history), [data.history, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  const S = summarize(cur); const P = summarize(prev);
  // Appeals in scope: same CAMs, and (like the table) only on tasks of the selected period.
  const allAppeals = data.appeals.filter((a) => camSet.has(a.cam_id) && (!taskType || a.task_type === taskType));
  const curIds = new Set(cur.map((e) => e.id));
  const appeals = allAppeals.filter((a) => curIds.has(a.evaluation_id));
  const rowsAll = useMemo(() => camRows(cams, ref.teams, ref.employees, cur, prev, history, data.historyWeeks, appeals, s), [cams, cur, prev, history, appeals]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = rowsAll.filter((r) => (r.tasks > 0 || r.prevAvg !== null)
    && (!minScore || (r.avg ?? -1) >= Number(minScore)) && (!maxScore || (r.avg ?? 101) <= Number(maxScore))
    && (!appealStatus || appeals.some((a) => a.cam_id === r.cam.id && a.status === appealStatus)));
  const queue = allAppeals.filter((a) => a.status === 'pending_qa_review');
  const active = rowsAll.filter((r) => r.tasks > 0);
  const draftSelected = sel.current.some((p) => p.status === 'draft');

  const leadRows = leads.map((l) => {
    const t = teamOfLead(l.id);
    const ids = new Set(allCams.filter((c) => c.team_id && t.includes(c.team_id)).map((c) => c.id));
    const a = summarize(cur.filter((e) => ids.has(e.cam_id))); const b = summarize(prev.filter((e) => ids.has(e.cam_id)));
    return { lead: l, teams: ref.teams.filter((x) => t.includes(x.id)).map((x) => x.name).join(', '), cams: ids.size, a, b,
      open: allAppeals.filter((x) => ids.has(x.cam_id) && isOpenAppeal(x) && x.status !== 'draft').length, meets: rowsAll.filter((r) => ids.has(r.cam.id) && r.meetsTarget).length };
  });

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="QA Master Dashboard" subtitle={<>Organisation-wide CS QA performance · Showing <strong>{sel.label}</strong>{draftSelected && <span className="ml-2 rounded bg-warn-soft px-1.5 py-0.5 text-[12px] font-semibold text-warn">Includes an unpublished week (visible to QA only)</span>}</>}
        actions={<>
          <PeriodPicker sel={sel} onChange={setSel} periods={periods} />
          <DownloadMenu label="Download Consolidated" empty={!data.loading && cur.length === 0} build={() => buildReport({ kind: 'org', subject: leadId ? `Team Lead: ${leads.find((l) => l.id === leadId)?.full_name}` : 'All teams', sel, cur, prev, history,
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
          <Filter id="f-cam" label="CAM name"><select id="f-cam" className={inputCls} value={camPick} onChange={(e) => { setCamPick(e.target.value); if (e.target.value) setView('cam'); }}><option value="">All CAMs</option>{allCams.filter((c) => !leadId || (c.team_id && teamOfLead(leadId).includes(c.team_id))).sort((a, b) => a.full_name.localeCompare(b.full_name)).map((c) => <option key={c.id} value={c.id}>{c.full_name}</option>)}</select></Filter>
          {categories.length > 0 && <Filter id="f-cat" label="Evaluation category"><select id="f-cat" className={inputCls} value={category} onChange={(e) => setCategory(e.target.value)}><option value="">All categories</option>{categories.map((c) => <option key={c} value={c}>{c}</option>)}</select></Filter>}
        </div>
      </Card>
      <ErrorBox error={data.error} />
      {data.loading ? <Loading /> : (<>
        {cur.length === 0 && <EmptyState title="No QA evaluations are available for this reporting period." body="Change the period or clear some filters." />}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <Kpi label="CAMs Evaluated" term="CAMs Evaluated" value={active.length} sub={`of ${cams.filter((c) => c.status === 'active').length} active CAMs`} />
          <Kpi label="Tasks Audited" term="Tasks Audited" value={S.tasks} sub={`${P.tasks} previous`} />
          <Kpi label="Overall QA Score" term="Average QA Score" value={fmtPct(S.avg)} tone={band(S.avg, s) === 'green' ? 'good' : band(S.avg, s) === 'amber' ? 'warn' : band(S.avg, s) === 'red' ? 'bad' : 'neutral'} sub={<Variance value={variance(S.avg, P.avg)} />} />
          <Kpi label="Total Autofails" term="Autofails" value={S.autofails} tone={S.autofails ? 'bad' : 'neutral'} sub={S.autofailRate === null ? '—' : `${S.autofailRate.toFixed(2)}% of tasks`} />
          <Kpi label="Appeals Received" term="Appeals" value={appeals.filter((a) => a.status !== 'draft').length} sub={`on this period’s tasks · ${appeals.filter(isPendingAppeal).length} pending`} />
          <Kpi label="Awaiting Lead Review" term="Appeals" value={appeals.filter((a) => a.status === 'pending_lead_review').length} sub={`this period · ${allAppeals.filter((a) => a.status === 'pending_lead_review').length} across all weeks (${allAppeals.filter((a) => a.status === 'pending_lead_review' && a.overdue).length} overdue)`} />
          <Kpi label="Awaiting QA Review" term="Appeals" value={appeals.filter((a) => a.status === 'pending_qa_review').length} tone={queue.some((a) => a.overdue) ? 'bad' : 'neutral'} sub={`this period · ${queue.length} in QA queue (${queue.filter((a) => a.overdue).length} overdue)`} />
          <Kpi label="Appeals Resolved" term="Appeals" value={appeals.filter(isResolvedAppeal).length} sub={`this period · ${allAppeals.filter(isResolvedAppeal).length} across all weeks`} />
          <Kpi label="CAMs Meeting Target" term="Meeting Target" value={`${active.filter((r) => r.meetsTarget).length}/${active.length}`} tone="good" sub={`≥ ${s.qa_target.score}%`} />
          <Kpi label="Need QA Attention" term="Needs Attention" value={active.filter((r) => r.needsAttention).length} tone={active.some((r) => r.needsAttention) ? 'warn' : 'neutral'} sub={`< ${s.thresholds.amber}%, autofail or −5 pp`} />
        </div>

        <Tabs value={view} onChange={setView} tabs={[{ value: 'org', label: 'Organisation view' }, { value: 'lead', label: 'By Team Lead' }, { value: 'cam', label: 'Individual CAMs' }]} />

        {view === 'org' && (
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            <Card title="Performance trend (all filtered CAMs)"><TrendSwitch history={history} weeks={data.historyWeeks} selected={sel.current} settings={s} /></Card>
            <Card title="Appeals awaiting QA decision" subtitle="All weeks" actions={<Link to="/appeals" className="text-[13px] font-medium text-brand hover:underline">Open queue</Link>}>
              {queue.length === 0 ? <p className="text-[13px] text-muted">Nothing waiting for QA.</p> : (
                <ul className="flex flex-col divide-y divide-line">
                  {queue.slice(0, 6).map((a) => (
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
              <Card title={`Parameter performance (organisation)${category ? ` · ${category}` : ''}`}><ParameterAnalysis cur={cur} prev={prev} parameters={catParams} taskTypeNames={ref.taskTypeNames} settings={s} /></Card>
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
                <tr key={r.lead.id} className="cursor-pointer hover:bg-sunken/60" onClick={() => { setLeadId(r.lead.id); setView('org'); }}>
                  <td className={td + ' font-medium'}>{r.lead.full_name}</td><td className={td + ' text-muted'}>{r.teams || '—'}</td><td className={td + ' text-right tnum'}>{r.cams}</td>
                  <td className={td + ' text-right tnum'}>{r.a.tasks}</td><td className={td + ' text-right'}><ScoreBadge score={r.a.avg} settings={s} /></td>
                  <td className={td + ' text-right'}>{r.b.avg === null ? <span className="text-muted">No Data</span> : <span className="tnum text-muted">{fmtPct(r.b.avg)}</span>}</td><td className={td + ' text-right'}><Variance value={variance(r.a.avg, r.b.avg)} /></td>
                  <td className={td + ' text-right tnum'}>{r.a.autofails}</td><td className={td + ' text-right tnum'}>{r.meets}</td><td className={td + ' text-right tnum'}>{r.open}</td>
                </tr>))}</tbody>
            </Table>
          </Card>
        )}
        {view === 'cam' && (camPick ? (
          <div className="rounded-lg border border-line bg-bg p-4">
            <CamDashboard camId={camPick} embedded />
          </div>
        ) : (
          <Card title="Individual CAM view" subtitle="Choose a CAM to see their full dashboard here, or pick one from the table.">
            <div className="flex flex-col gap-3">
              <label htmlFor="f-cam-view" className="text-[13px] font-medium">CAM</label>
              <select id="f-cam-view" className={inputCls + ' max-w-sm'} value={camPick} onChange={(e) => setCamPick(e.target.value)}><option value="">Choose a CAM…</option>{cams.map((c) => <option key={c.id} value={c.id}>{c.full_name}</option>)}</select>
            </div>
          </Card>
        ))}
      </>)}
    </div>
  );
}

function Filter({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return <div className="flex min-w-[140px] flex-col gap-1"><label htmlFor={id} className="text-[12px] font-medium text-muted">{label}</label>{children}</div>;
}
