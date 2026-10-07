import { useMemo, useState } from 'react';
import { useApp, useAsync, useRef_ } from '../app/context';
import { repo, isDemo } from '../data';
import { PageHeader } from '../components/Layout';
import { Button, Card, EmptyState, ErrorBox, Field, Loading, ScoreBadge, Tabs, Table, td, th, Variance, inputCls, inputBase, useToast, Pill } from '../components/ui';
import { buildSelection, fmtDate, fmtRange, isOpenAppeal, monthLabel, monthOptions, quarterOptions, summarize, variance, type PeriodMode } from '../lib/metrics';
import { buildReport, downloadReport } from '../lib/report';
import type { Appeal, Evaluation, Employee } from '../lib/types';

/** Scope options the current user may report on (CAM: self; Lead: team or one CAM; QA: org, lead team, or CAM). */
function useScopes() {
  const { me } = useApp();
  const ref = useRef_();
  return useMemo(() => {
    const out: { key: string; label: string; kind: 'cam' | 'team' | 'org'; cams: Employee[] }[] = [];
    const camsOfLead = (lid: string) => ref.employees.filter((e) => e.role === 'user' && e.team_id && ref.teams.some((t) => t.id === e.team_id && t.lead_id === lid));
    if (me!.role === 'user') out.push({ key: me!.id, label: `${me!.full_name} (me)`, kind: 'cam', cams: [me! as Employee] });
    if (me!.role === 'admin') {
      out.push({ key: 'team', label: 'My whole team', kind: 'team', cams: camsOfLead(me!.id) });
      camsOfLead(me!.id).forEach((c) => out.push({ key: c.id, label: c.full_name, kind: 'cam', cams: [c] }));
    }
    if (me!.role === 'super_admin') {
      out.push({ key: 'org', label: 'All teams (organisation)', kind: 'org', cams: ref.employees.filter((e) => e.role === 'user') });
      ref.employees.filter((e) => e.role === 'admin').forEach((l) => out.push({ key: 'lead:' + l.id, label: `Team of ${l.full_name}`, kind: 'team', cams: camsOfLead(l.id) }));
      ref.employees.filter((e) => e.role === 'user').forEach((c) => out.push({ key: c.id, label: c.full_name, kind: 'cam', cams: [c] }));
    }
    return out;
  }, [me, ref]);
}

function useScopeEvaluations(camIds: string[] | undefined, weeks: number) {
  const ref = useRef_();
  const periods = useMemo(() => ref.publishedPeriods.slice(-weeks), [ref.publishedPeriods, weeks]);
  const ev = useAsync(() => repo.getEvaluations({ periodIds: periods.map((p) => p.id), camIds }), [periods.map((p) => p.id).join(','), camIds?.join(',')]);
  const ap = useAsync(() => repo.listAppeals(camIds?.length === 1 ? { camId: camIds[0] } : {}), [camIds?.join(',')]);
  return { periods, evals: ev.data ?? [], appeals: ap.data ?? [], loading: ev.loading || ap.loading, error: ev.error || ap.error };
}

export function ReportsPage() {
  const { me } = useApp();
  const ref = useRef_();
  const scopes = useScopes();
  const [scopeKey, setScopeKey] = useState(scopes[0]?.key ?? '');
  const scope = scopes.find((s) => s.key === scopeKey) ?? scopes[0];
  const [tab, setTab] = useState<'week' | 'month' | 'quarter'>('week');
  const camIds = scope.kind === 'org' ? undefined : scope.cams.map((c) => c.id);
  // 60 weeks: a year of history plus the quarter before it, so every row can show its variance.
  const d = useScopeEvaluations(camIds, 60);
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  const dl = async (mode: PeriodMode, anchor: string, format: 'pdf' | 'xlsx' | 'csv') => {
    setBusy(`${anchor}-${format}`);
    try {
      const sel = buildSelection(d.periods, mode, anchor);
      const ids = (xs: { id: string }[]) => new Set(xs.map((x) => x.id));
      const ci = ids(sel.current); const pi = ids(sel.previous);
      const upto = d.periods.filter((p) => p.start_date <= (sel.current[sel.current.length - 1]?.start_date ?? ''));
      const hw = upto.slice(-12); const hi = ids(hw);
      const m = buildReport({ kind: scope.kind, subject: scope.kind === 'cam' ? scope.cams[0].full_name : scope.label, sel,
        cur: d.evals.filter((e) => ci.has(e.period_id)), prev: d.evals.filter((e) => pi.has(e.period_id)), history: d.evals.filter((e) => hi.has(e.period_id)),
        historyWeeks: hw, appeals: d.appeals, parameters: ref.parameters, settings: ref.settings, taskTypeNames: ref.taskTypeNames, generatedBy: me!.full_name,
        cams: scope.kind === 'cam' ? undefined : scope.cams, teams: ref.teams, employees: ref.employees });
      await downloadReport(m, format);
      void repo.logExport({ scope: scope.label, period: sel.label, format });
      toast(isDemo ? `${format.toUpperCase()} generated. The hosted demo sandbox may block the download; the deployed portal saves it normally.` : `${format.toUpperCase()} downloaded.`, isDemo ? 'info' : 'good');
    } catch (x) { toast(x instanceof Error ? x.message : String(x), 'bad'); } finally { setBusy(null); }
  };

  const weekRows = [...d.periods].reverse().map((p, i, arr) => {
    const cur = d.evals.filter((e) => e.period_id === p.id);
    const prev = arr[i + 1] ? d.evals.filter((e) => e.period_id === arr[i + 1].id) : [];
    return { key: p.id, label: p.short_label, range: fmtRange(p.start_date, p.end_date), published: p.published_at, cur, s: summarize(cur), ps: summarize(prev) };
  });
  const months = monthOptions(d.periods).map((m, i, arr) => {
    const inM = (k: string) => new Set(d.periods.filter((p) => p.start_date.slice(0, 7) === k).map((p) => p.id));
    const cur = d.evals.filter((e) => inM(m).has(e.period_id));
    const prev = arr[i + 1] ? d.evals.filter((e) => inM(arr[i + 1]).has(e.period_id)) : [];
    return { key: m, label: monthLabel(m), range: `${inM(m).size} audit week(s)`, published: null as string | null, cur, s: summarize(cur), ps: summarize(prev) };
  });
  const quarters = quarterOptions(d.periods).map((q, i, arr) => {
    const inQ = (k: string) => new Set(buildSelection(d.periods, 'quarter', k).current.map((p) => p.id));
    const cur = d.evals.filter((e) => inQ(q).has(e.period_id));
    const prev = arr[i + 1] ? d.evals.filter((e) => inQ(arr[i + 1]).has(e.period_id)) : [];
    return { key: q, label: q.replace('-', ' '), range: `${inQ(q).size} audit week(s)`, published: null as string | null, cur, s: summarize(cur), ps: summarize(prev) };
  });
  const rows = tab === 'week' ? weekRows : tab === 'month' ? months : quarters;
  const appealText = (evs: Evaluation[], ap: Appeal[]) => {
    const ids = new Set(evs.map((e) => e.id));
    const list = ap.filter((a) => ids.has(a.evaluation_id));
    if (!list.length) return <span className="text-faint">None</span>;
    const open = list.filter(isOpenAppeal).length;
    return open ? <Pill tone="info">{open} open / {list.length}</Pill> : <span className="text-muted">{list.length} resolved</span>;
  };

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Report History" subtitle={<>Each audit week becomes a report automatically when QA publishes it. Nothing to adjust by hand — pick a row and download. For any other date range use <a href="#/downloads" className="text-brand hover:underline">Download Reports</a>.</>}
        actions={scopes.length > 1 && (<div className="flex items-center gap-2"><label htmlFor="rep-scope" className="text-[13px] text-muted">Report for</label>
          <select id="rep-scope" className={inputBase + ' w-auto max-w-[280px]'} value={scope.key} onChange={(e) => setScopeKey(e.target.value)}>{scopes.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select></div>)} />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'week', label: 'Weekly reports' }, { value: 'month', label: 'Monthly summaries' }, { value: 'quarter', label: 'Quarterly summaries' }]} />
      <ErrorBox error={d.error} />
      {d.loading ? <Loading /> : rows.length === 0 ? <EmptyState title="No QA evaluations are available for this reporting period." body="Reports appear here as soon as QA publishes an audit week." /> : (
        <Card pad={false}>
          <Table>
            <thead><tr><th className={th}>Audit period</th><th className={th + ' text-right'}>Tasks audited</th><th className={th + ' text-right'}>Average score</th><th className={th + ' text-right'}>Variance</th>
              <th className={th + ' text-right'}>Autofails</th><th className={th}>Appeals</th>{tab === 'week' && <th className={th}>Published</th>}<th className={th}>Download</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.key}>
                <td className={td}><div className="font-medium">{r.label}</div><div className="text-[12px] text-muted">{r.range}</div></td>
                <td className={td + ' text-right tnum'}>{r.s.tasks}</td>
                <td className={td + ' text-right'}>{r.s.tasks ? <ScoreBadge score={r.s.avg} settings={ref.settings} /> : <span className="text-faint">No Data</span>}</td>
                <td className={td + ' text-right'}><Variance value={variance(r.s.avg, r.ps.avg)} /></td>
                <td className={td + ' text-right tnum'}>{r.s.autofails}</td>
                <td className={td}>{appealText(r.cur, d.appeals)}</td>
                {tab === 'week' && <td className={td + ' whitespace-nowrap text-muted'}>{fmtDate(r.published)}</td>}
                <td className={td}><div className="flex gap-1">{(['pdf', 'xlsx', 'csv'] as const).map((f) => (
                  <Button key={f} size="sm" variant="secondary" disabled={!r.s.tasks} loading={busy === `${r.key}-${f}`} onClick={() => dl(tab, r.key, f)}>{f.toUpperCase()}</Button>
                ))}</div></td>
              </tr>
            ))}</tbody>
          </Table>
        </Card>
      )}
    </div>
  );
}

export function DownloadsPage() {
  const { me } = useApp();
  const ref = useRef_();
  const scopes = useScopes();
  const toast = useToast();
  const [scopeKey, setScopeKey] = useState(scopes[0]?.key ?? '');
  const [mode, setMode] = useState<PeriodMode>('week');
  const [anchor, setAnchor] = useState<string>(ref.publishedPeriods[ref.publishedPeriods.length - 1]?.id ?? '');
  const [from, setFrom] = useState(ref.publishedPeriods[Math.max(0, ref.publishedPeriods.length - 4)]?.start_date ?? '');
  const [to, setTo] = useState(ref.publishedPeriods[ref.publishedPeriods.length - 1]?.end_date ?? '');
  const [format, setFormat] = useState<'pdf' | 'xlsx' | 'csv'>('pdf');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const scope = scopes.find((s) => s.key === scopeKey) ?? scopes[0];
  const [drafts, setDrafts] = useState(false);
  const periods = me!.role === 'super_admin' && drafts ? ref.periods : ref.publishedPeriods;
  const sel = buildSelection(periods, mode, mode === 'custom' ? `${from}..${to}` : mode === 'week' ? anchor : mode === 'month' ? (monthOptions(periods).includes(anchor) ? anchor : undefined) : (quarterOptions(periods).includes(anchor) ? anchor : undefined));
  const go = async () => {
    setBusy(true); setErr(null);
    try {
      const upto = periods.filter((p) => p.start_date <= (sel.current[sel.current.length - 1]?.start_date ?? ''));
      const hw = upto.slice(-12);
      const ids = [...new Set([...sel.current, ...sel.previous, ...hw].map((p) => p.id))];
      const camIds = scope.kind === 'org' ? undefined : scope.cams.map((c) => c.id);
      const [evals, appeals] = await Promise.all([repo.getEvaluations({ periodIds: ids, camIds }), repo.listAppeals(camIds?.length === 1 ? { camId: camIds[0] } : {})]);
      const inSet = (xs: { id: string }[]) => { const s = new Set(xs.map((x) => x.id)); return evals.filter((e) => s.has(e.period_id)); };
      const m = buildReport({ kind: scope.kind, subject: scope.kind === 'cam' ? scope.cams[0].full_name : scope.label, sel, cur: inSet(sel.current), prev: inSet(sel.previous),
        history: inSet(hw), historyWeeks: hw, appeals, parameters: ref.parameters, settings: ref.settings, taskTypeNames: ref.taskTypeNames, generatedBy: me!.full_name,
        cams: scope.kind === 'cam' ? undefined : scope.cams, teams: ref.teams, employees: ref.employees });
      if (!m.evaluations.length) throw new Error('No QA evaluations are available for this reporting period.');
      await downloadReport(m, format);
      void repo.logExport({ scope: scope.label, period: sel.label, format });
      toast(isDemo ? 'Report generated. The hosted demo sandbox may block the download; the deployed portal saves it normally.' : 'Report downloaded.', isDemo ? 'info' : 'good');
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Download Reports" subtitle="Build a report for any period you have access to. Files only ever contain data you can see in the portal." />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card title="Report options">
          <div className="flex flex-col gap-4">
            <Field label="Report for" htmlFor="dl-scope"><select id="dl-scope" className={inputCls} value={scope.key} onChange={(e) => setScopeKey(e.target.value)}>{scopes.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select></Field>
            {me!.role === 'super_admin' && <label htmlFor="dl-drafts" className="flex items-center gap-2 text-[13px]"><input id="dl-drafts" type="checkbox" checked={drafts} onChange={(e) => setDrafts(e.target.checked)} />Include unpublished (draft) weeks — QA only</label>}
            <Field label="Period type" htmlFor="dl-mode"><select id="dl-mode" className={inputCls} value={mode} onChange={(e) => { const m = e.target.value as PeriodMode; setMode(m); setAnchor(m === 'week' ? periods[periods.length - 1]?.id ?? '' : m === 'month' ? monthOptions(periods)[0] : quarterOptions(periods)[0]); }}>
              <option value="week">Weekly</option><option value="month">Monthly</option><option value="quarter">Quarterly</option><option value="custom">Custom date range</option></select></Field>
            {mode === 'week' && <Field label="Audit week" htmlFor="dl-week"><select id="dl-week" className={inputCls} value={anchor} onChange={(e) => setAnchor(e.target.value)}>{[...periods].reverse().map((p) => <option key={p.id} value={p.id}>{p.short_label} · {fmtRange(p.start_date, p.end_date)}{p.status === 'draft' ? ' (draft)' : ''}</option>)}</select></Field>}
            {mode === 'month' && <Field label="Month" htmlFor="dl-month"><select id="dl-month" className={inputCls} value={anchor} onChange={(e) => setAnchor(e.target.value)}>{monthOptions(periods).map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}</select></Field>}
            {mode === 'quarter' && <Field label="Quarter" htmlFor="dl-q"><select id="dl-q" className={inputCls} value={anchor} onChange={(e) => setAnchor(e.target.value)}>{quarterOptions(periods).map((q) => <option key={q} value={q}>{q.replace('-', ' ')}</option>)}</select></Field>}
            {mode === 'custom' && <div className="grid grid-cols-2 gap-3">
              <Field label="Start date" htmlFor="dl-from"><input id="dl-from" type="date" className={inputCls} value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
              <Field label="End date" htmlFor="dl-to"><input id="dl-to" type="date" className={inputCls} value={to} onChange={(e) => setTo(e.target.value)} /></Field></div>}
            <fieldset><legend className="mb-1.5 text-[13px] font-medium">Format</legend>
              <div className="flex flex-col gap-1.5 text-[13px]">
                {([['pdf', 'PDF', 'Formatted report with KPIs, trend, parameters, strengths, task feedback and appeals'], ['xlsx', 'Excel (.xlsx)', 'Separate sheets: Summary, CAM Summary, Parameters, Task Details, Appeals'], ['csv', 'CSV', 'Report summary header, then one row per audited task with every parameter score']] as const).map(([v, l, h]) => (
                  <label key={v} htmlFor={`fmt-${v}`} className="flex items-start gap-2"><input id={`fmt-${v}`} type="radio" name="fmt" checked={format === v} onChange={() => setFormat(v)} className="mt-1" /><span><span className="font-medium">{l}</span><span className="block text-[12px] text-muted">{h}</span></span></label>
                ))}
              </div></fieldset>
            <ErrorBox error={err} />
            <Button loading={busy} onClick={go}>Download report</Button>
          </div>
        </Card>
        <Card title="What’s included">
          <ul className="flex list-disc flex-col gap-1.5 pl-5 text-[13px] text-muted">
            <li>Report title, subject, audit period, comparison period, generation date and confidentiality notice</li>
            <li>Tasks audited, average QA score, previous-period score and variance in percentage points</li>
            <li>Autofail count and FCR rate</li>
            <li>Weekly trend for up to 12 weeks (weeks without audits show “No Data”)</li>
            <li>Parameter-level scores for each task type</li>
            <li>Individual reports: strengths, improvement areas, recurring findings and recommended focus</li>
            <li>Team / consolidated reports: CAM comparison table</li>
            <li>Task-level audit details with QA feedback, and the appeals on those tasks</li>
          </ul>
          <p className="mt-3 text-[12.5px] text-muted">Selected: <strong className="text-ink">{scope.label}</strong> · {sel.label} (vs {sel.previousLabel})</p>
        </Card>
      </div>
    </div>
  );
}
