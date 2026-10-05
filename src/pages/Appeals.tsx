import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { useApp, useAsync, useRef_ } from '../app/context';
import { repo } from '../data';
import { PageHeader } from '../components/Layout';
import { Button, Card, EmptyState, ErrorBox, Loading, Pagination, Pill, ScoreBadge, StatusBadge, Tabs, Table, td, th, inputCls, inputBase } from '../components/ui';
import { APPEAL_STATUS_LABEL, fmtDate } from '../lib/metrics';
import type { Appeal, AppealStatus } from '../lib/types';

type TabDef = { value: string; label: string; statuses?: AppealStatus[] };
const TABS: Record<'user' | 'admin' | 'super_admin', TabDef[]> = {
  user: [
    { value: 'open', label: 'In progress', statuses: ['draft', 'pending_lead_review', 'returned_to_cam', 'pending_qa_review', 'pending_additional_info'] },
    { value: 'done', label: 'Decided', statuses: ['approved', 'partially_approved', 'rejected', 'closed'] },
    { value: 'all', label: 'All my appeals' },
  ],
  admin: [
    { value: 'mine', label: 'Awaiting my review', statuses: ['pending_lead_review'] },
    { value: 'cam', label: 'Returned to CAM', statuses: ['returned_to_cam'] },
    { value: 'qa', label: 'With QA', statuses: ['pending_qa_review', 'pending_additional_info'] },
    { value: 'done', label: 'Decided', statuses: ['approved', 'partially_approved', 'rejected', 'closed'] },
    { value: 'all', label: 'All team appeals' },
  ],
  super_admin: [
    { value: 'qa', label: 'Awaiting QA review', statuses: ['pending_qa_review'] },
    { value: 'info', label: 'Awaiting information', statuses: ['pending_additional_info'] },
    { value: 'lead', label: 'With Team Leads', statuses: ['pending_lead_review', 'returned_to_cam'] },
    { value: 'done', label: 'Decided', statuses: ['approved', 'partially_approved', 'rejected', 'closed'] },
    { value: 'all', label: 'All appeals' },
  ],
};

export function AppealsPage() {
  const { me } = useApp();
  const ref = useRef_();
  const tabs = TABS[me!.role];
  const [tab, setTab] = useState(tabs[0].value);
  const all = useAsync(() => repo.listAppeals(), []);
  const [f, setF] = useState({ week: '', cam: '', lead: '', type: '', param: '', status: '', from: '', to: '', overdue: false });
  const [page, setPage] = useState(1);
  const def = tabs.find((t) => t.value === tab)!;
  const list = useMemo(() => (all.data ?? []).filter((a) => (!def.statuses || def.statuses.includes(a.status))
    && (!f.week || a.period_id === f.week) && (!f.cam || a.cam_id === f.cam) && (!f.lead || a.lead_id === f.lead) && (!f.type || a.task_type === f.type)
    && (!f.param || (a.parameters_label ?? '').includes(f.param)) && (!f.status || a.status === f.status) && (!f.overdue || a.overdue)
    && (!f.from || (a.submitted_at ?? a.created_at).slice(0, 10) >= f.from) && (!f.to || (a.submitted_at ?? a.created_at).slice(0, 10) <= f.to)), [all.data, def, f]);
  const count = (t: TabDef) => (all.data ?? []).filter((a) => !t.statuses || t.statuses.includes(a.status)).length;
  const weeks = [...new Map((all.data ?? []).map((a) => [a.period_id, a.period_short_label])).entries()];
  const cams = [...new Map((all.data ?? []).map((a) => [a.cam_id, a.cam_name])).entries()];
  const leads = [...new Map((all.data ?? []).filter((a) => a.lead_id).map((a) => [a.lead_id!, a.lead_name ?? '?'])).entries()];
  const paramNames = [...new Set(ref.parameters.map((p) => p.name)), 'Autofail'];
  const pages = Math.max(1, Math.ceil(list.length / 20));
  const title = me!.role === 'user' ? 'My Appeals' : me!.role === 'admin' ? 'Team Appeal Review Queue' : 'QA Appeal Review Queue';
  const subtitle = me!.role === 'user' ? 'Appeals go to your Team Lead first, then to QA for the final decision.'
    : me!.role === 'admin' ? 'Review your CAMs’ appeals and forward them to QA with a recommendation.'
      : 'Final decisions on appeals forwarded by Team Leads.';
  const set = (k: keyof typeof f, v: string | boolean) => { setF((x) => ({ ...x, [k]: v })); setPage(1); };

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={title} subtitle={subtitle} actions={me!.role === 'user' && <Link to="/appeals/new"><Button><Plus className="h-4 w-4" />New appeal</Button></Link>} />
      <Tabs value={tab} onChange={(v) => { setTab(v); setPage(1); }} tabs={tabs.map((t) => ({ value: t.value, label: <>{t.label} <span className="tnum text-faint">({count(t)})</span></> }))} />
      <div className="flex flex-wrap items-end gap-3">
        <Sel id="af-week" label="Audit week" value={f.week} onChange={(v) => set('week', v)} options={weeks} />
        {me!.role !== 'user' && <Sel id="af-cam" label="CAM" value={f.cam} onChange={(v) => set('cam', v)} options={cams} />}
        {me!.role === 'super_admin' && <Sel id="af-lead" label="Team Lead" value={f.lead} onChange={(v) => set('lead', v)} options={leads} />}
        <Sel id="af-type" label="Task type" value={f.type} onChange={(v) => set('type', v)} options={ref.taskTypes.map((t) => [t.code, t.name])} />
        <Sel id="af-param" label="Disputed parameter" value={f.param} onChange={(v) => set('param', v)} options={paramNames.map((n) => [n, n])} />
        <Sel id="af-status" label="Status" value={f.status} onChange={(v) => set('status', v)} options={(Object.keys(APPEAL_STATUS_LABEL) as AppealStatus[]).map((k) => [k, APPEAL_STATUS_LABEL[k]])} />
        <div className="flex flex-col gap-1"><label htmlFor="af-from" className="text-[12px] font-medium text-muted">Submitted from</label><input id="af-from" type="date" className={inputCls} value={f.from} onChange={(e) => set('from', e.target.value)} /></div>
        <div className="flex flex-col gap-1"><label htmlFor="af-to" className="text-[12px] font-medium text-muted">to</label><input id="af-to" type="date" className={inputCls} value={f.to} onChange={(e) => set('to', e.target.value)} /></div>
        <label className="flex h-9 items-center gap-2 text-[13px]" htmlFor="af-overdue"><input id="af-overdue" type="checkbox" checked={f.overdue} onChange={(e) => set('overdue', e.target.checked)} />Overdue only</label>
      </div>
      <ErrorBox error={all.error} />
      {all.loading ? <Loading /> : list.length === 0 ? <EmptyState title="No appeals here" body={me!.role === 'user' ? 'You can raise an appeal from any published task evaluation within the appeal window.' : 'Nothing matches this view.'} /> : (
        <Card pad={false}>
          <AppealTable rows={list.slice((page - 1) * 20, page * 20)} role={me!.role} />
          <Pagination page={page} pages={pages} onPage={setPage} />
        </Card>
      )}
    </div>
  );
}

function Sel({ id, label, value, onChange, options }: { id: string; label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <div className="flex flex-col gap-1"><label htmlFor={id} className="text-[12px] font-medium text-muted">{label}</label>
      <select id={id} className={inputBase + ' w-auto max-w-[220px]'} value={value} onChange={(e) => onChange(e.target.value)}><option value="">All</option>{options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
  );
}

export function AppealTable({ rows, role }: { rows: Appeal[]; role: string }) {
  const nav = useNavigate();
  return (
    <Table>
      <thead><tr><th className={th}>Reference</th>{role !== 'user' && <th className={th}>CAM</th>}{role === 'super_admin' && <th className={th}>Team Lead</th>}
        <th className={th}>Week</th><th className={th}>Task</th><th className={th}>Disputed</th><th className={th}>Lead recommendation</th><th className={th}>Status</th>
        <th className={th + ' text-right'}>Days in status</th><th className={th}>Submitted</th></tr></thead>
      <tbody>{rows.map((a) => (
        <tr key={a.id} className="cursor-pointer hover:bg-sunken/60" onClick={() => nav(`/appeals/${a.id}`)}>
          <td className={td}><Link onClick={(e) => e.stopPropagation()} to={`/appeals/${a.id}`} className="font-mono text-[12.5px] font-medium text-brand hover:underline">{a.reference}</Link></td>
          {role !== 'user' && <td className={td + ' whitespace-nowrap font-medium'}>{a.cam_name}</td>}
          {role === 'super_admin' && <td className={td + ' whitespace-nowrap text-muted'}>{a.lead_name ?? '—'}</td>}
          <td className={td}>{a.period_short_label}</td>
          <td className={td + ' whitespace-nowrap'}><span className="font-mono text-[12px]">{a.task_id.slice(0, 8)}</span></td>
          <td className={td}>{a.parameters_label}</td>
          <td className={td + ' whitespace-nowrap text-[12.5px]'}>{a.lead_recommendation ? <Pill tone={a.lead_recommendation === 'recommend_approval' ? 'good' : a.lead_recommendation === 'recommend_rejection' ? 'bad' : 'warn'}>{a.lead_recommendation === 'recommend_approval' ? 'Approve' : a.lead_recommendation === 'recommend_rejection' ? 'Reject' : 'More info'}</Pill> : <span className="text-faint">—</span>}</td>
          <td className={td}><StatusBadge status={a.status} overdue={a.overdue} /></td>
          <td className={td + ' text-right tnum'}>{a.days_in_status.toFixed(1)}</td>
          <td className={td + ' whitespace-nowrap text-muted'}>{fmtDate(a.submitted_at ?? a.created_at)}</td>
        </tr>
      ))}</tbody>
    </Table>
  );
}

/** CAM: choose which task to appeal (only published tasks inside the appeal window). */
export function NewAppealPage() {
  const { me } = useApp();
  const ref = useRef_();
  const recent = ref.publishedPeriods.slice(-3).map((p) => p.id);
  const evals = useAsync(() => repo.getEvaluations({ periodIds: recent, camIds: [me!.id] }), [recent.join(',')]);
  const deadlines = useAsync(async () => {
    const out: Record<string, string | null> = {};
    for (const e of evals.data ?? []) out[e.id] = await repo.getAppealDeadline(e.id);
    return out;
  }, [evals.data]);
  const open = (evals.data ?? []).filter((e) => deadlines.data?.[e.id] && Date.now() <= Date.parse(deadlines.data[e.id]!));
  const sorted = [...open].sort((a, b) => a.score - b.score);
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="New appeal" subtitle={`Choose the audited task you want to appeal. Appeals are accepted for ${ref.settings.appeal_window.days} ${ref.settings.appeal_window.business_days ? 'business' : 'calendar'} days after the weekly report is published.`} />
      {evals.loading || deadlines.loading ? <Loading /> : sorted.length === 0 ? <EmptyState title="No tasks are open for appeal" body="Either the appeal window has closed for your recent weeks, or no tasks were audited." /> : (
        <Card pad={false}>
          <Table>
            <thead><tr><th className={th}>Week</th><th className={th}>Task type</th><th className={th}>Task</th><th className={th + ' text-right'}>Score</th><th className={th}>Deductions</th><th className={th}>Appeal by</th><th className={th}></th></tr></thead>
            <tbody>{sorted.map((e) => (
              <tr key={e.id}>
                <td className={td}>{e.period_short_label}</td><td className={td}>{e.task_type_name}</td><td className={td + ' font-mono text-[12px]'}>{e.task_id.slice(0, 8)}</td>
                <td className={td + ' text-right'}><ScoreBadge score={e.score} settings={ref.settings} /></td>
                <td className={td + ' text-[12.5px]'}>{e.autofail ? 'Autofail' : e.scores.filter((s) => s.earned !== null && s.earned < s.max_score).map((s) => s.parameter_name).join(', ') || 'None'}</td>
                <td className={td + ' text-muted whitespace-nowrap'}>{fmtDate(deadlines.data?.[e.id] ?? null)}</td>
                <td className={td}><Link to={`/evaluations/${e.id}`} className="font-medium text-brand hover:underline">Review &amp; appeal</Link></td>
              </tr>
            ))}</tbody>
          </Table>
        </Card>
      )}
    </div>
  );
}
