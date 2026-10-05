import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, ExternalLink, ChevronDown } from 'lucide-react';
import clsx from 'clsx';
import { Button, Card, EmptyState, Modal, Pill, ScoreBadge, Table, td, th, InfoTip, Variance, useToast, Pagination } from './ui';
import { ParameterBars } from './charts';
import { fmtDate, fmtPct, parameterStats, variance, type Insights, type ParamStat } from '../lib/metrics';
import { downloadReport, type ReportModel } from '../lib/report';
import { isDemo } from '../data';
import type { Evaluation, Parameter, PortalSettings } from '../lib/types';

export function DownloadMenu({ build, label = 'Download Report' }: { build: () => ReportModel | null; label?: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();
  const go = async (f: 'pdf' | 'xlsx' | 'csv') => {
    const m = build();
    if (!m) return;
    setBusy(f);
    try {
      await downloadReport(m, f);
      toast(isDemo ? `${f.toUpperCase()} report generated. If no file appears, your viewer blocks downloads (the hosted demo sandbox does); the deployed portal downloads normally.` : `${f.toUpperCase()} report downloaded.`, isDemo ? 'info' : 'good');
    } catch (e) { toast(e instanceof Error ? e.message : String(e), 'bad'); } finally { setBusy(null); setOpen(false); }
  };
  return (
    <div className="relative">
      <Button onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} loading={!!busy}><Download className="h-4 w-4" />{label}<ChevronDown className="h-3.5 w-3.5" /></Button>
      {open && (
        <div role="menu" className="absolute right-0 top-10 z-30 w-64 rounded-lg border border-line bg-surface p-1 shadow-xl">
          {([['pdf', 'PDF report', 'Formatted report for sharing or records'], ['xlsx', 'Excel workbook', 'Summary, parameters, task details, appeals'], ['csv', 'CSV (task rows)', 'Raw task-level data']] as const).map(([f, t, d]) => (
            <button key={f} role="menuitem" onClick={() => go(f)} className="block w-full rounded px-3 py-2 text-left hover:bg-sunken">
              <div className="text-[13px] font-medium">{t}</div><div className="text-[12px] text-muted">{d}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Parameter-level table + bar chart per task type, with drill-down to the related tasks. */
export function ParameterAnalysis({ cur, prev, parameters, taskTypeNames, settings }: {
  cur: Evaluation[]; prev: Evaluation[]; parameters: Parameter[]; taskTypeNames: Record<string, string>; settings: PortalSettings;
}) {
  const stats = useMemo(() => parameterStats(cur, parameters, taskTypeNames), [cur, parameters, taskTypeNames]);
  const prevStats = useMemo(() => new Map(parameterStats(prev, parameters, taskTypeNames).map((s) => [s.parameter.id, s])), [prev, parameters, taskTypeNames]);
  const types = Object.keys(taskTypeNames).filter((t) => stats.some((s) => s.parameter.task_type === t && s.evaluated > 0));
  const [type, setType] = useState<string>(types[0] ?? 'ER');
  const [drill, setDrill] = useState<ParamStat | null>(null);
  const activeType = types.includes(type) ? type : types[0];
  const list = stats.filter((s) => s.parameter.task_type === activeType && s.parameter.active).sort((a, b) => a.parameter.sort_order - b.parameter.sort_order);
  const typeTasks = cur.filter((e) => e.task_type === activeType);
  if (!types.length) return <EmptyState title="No QA evaluations are available for this reporting period." body="Parameter results appear once tasks are audited and the week is published." />;
  const sections = [...new Set(list.map((s) => s.parameter.section ?? ''))];
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {types.map((t) => (
          <button key={t} onClick={() => setType(t)} className={clsx('rounded-full border px-3 py-1 text-[13px] font-medium',
            t === activeType ? 'border-brand bg-brand-soft text-brand' : 'border-line text-muted hover:text-ink')}>
            {taskTypeNames[t]} <span className="tnum text-faint">({cur.filter((e) => e.task_type === t).length})</span>
          </button>
        ))}
        <span className="ml-auto flex items-center gap-1 text-[12px] text-muted">How % is calculated <InfoTip term="Parameter %" /></span>
      </div>
      <div className="grid gap-4 2xl:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
        <div className="min-w-0">
          <ParameterBars stats={list} settings={settings} onSelect={setDrill} />
          <p className="mt-1 text-[12px] text-muted">{typeTasks.length} {taskTypeNames[activeType]} task(s) · {typeTasks.filter((e) => e.autofail).length} autofail(s) excluded from parameter %. Dashed line = {settings.qa_target.score}% target. Click a bar for tasks.</p>
        </div>
        <Table>
          <thead><tr>
            <th className={th}>Parameter</th><th className={th + ' text-right'}>Max</th><th className={th + ' text-right'}>Earned</th>
            <th className={th + ' text-right'}>% Achieved</th><th className={th + ' text-right'}>Previous</th><th className={th + ' text-right'}>Variance</th>
            <th className={th + ' text-right'}>Evaluated</th><th className={th + ' text-right'}>Deductions</th><th className={th}></th>
          </tr></thead>
          <tbody>
            {sections.map((sec) => (
              <FragmentRows key={sec} section={sec} colSpan={9}>
                {list.filter((s) => (s.parameter.section ?? '') === sec).map((s) => {
                  const p = prevStats.get(s.parameter.id);
                  return (
                    <tr key={s.parameter.id} className="hover:bg-sunken/50">
                      <td className={td + ' font-medium'}>{s.parameter.name}</td>
                      <td className={td + ' text-right tnum'}>{s.parameter.max_score}</td>
                      <td className={td + ' text-right tnum'}>{s.evaluated ? `${s.earned}/${s.max}` : '—'}</td>
                      <td className={td + ' text-right'}>{s.evaluated ? <ScoreBadge score={s.pct} settings={settings} /> : <span className="text-faint">No Data</span>}</td>
                      <td className={td + ' text-right tnum text-muted'}>{p?.evaluated ? fmtPct(p.pct) : 'No Data'}</td>
                      <td className={td + ' text-right'}><Variance value={p?.evaluated && s.evaluated ? variance(s.pct, p.pct) : null} /></td>
                      <td className={td + ' text-right tnum'}>{s.evaluated}</td>
                      <td className={td + ' text-right tnum'}>{s.deductions ? <span className="font-semibold text-bad">{s.deductions}</span> : 0}</td>
                      <td className={td}>{s.deductions > 0 && <button className="text-[12.5px] text-brand hover:underline" onClick={() => setDrill(s)}>View tasks</button>}</td>
                    </tr>
                  );
                })}
              </FragmentRows>
            ))}
          </tbody>
        </Table>
      </div>
      <Modal open={!!drill} onClose={() => setDrill(null)} title={drill ? `${drill.parameter.name} · ${drill.taskTypeName}` : ''} wide>
        {drill && (
          <div className="flex flex-col gap-3">
            <p className="text-[13px] text-muted">{drill.deductions} deduction(s) across {drill.evaluated} evaluated task(s). QA feedback is shown exactly as recorded.</p>
            {drill.refs.length === 0 && <p className="text-[13px]">No deductions on this parameter in the selected period.</p>}
            {drill.refs.map((r) => (
              <div key={r.evaluationId} className="rounded border border-line p-3">
                <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
                  <Pill>{r.periodLabel}</Pill><span className="text-muted">{fmtDate(r.auditedAt)}</span>
                  <span className="font-mono text-[12px]">{r.taskId.slice(0, 8)}</span>
                  <span className="font-semibold text-bad tnum">{r.earned}/{r.max}</span>
                  <Link to={`/evaluations/${r.evaluationId}`} className="ml-auto text-brand hover:underline">Open evaluation</Link>
                </div>
                {r.feedback && <p className="mt-2 text-[13px]"><span className="eyebrow mr-1">QA feedback</span>{r.feedback}</p>}
              </div>
            ))}
          </div>
        )}
      </Modal>
    </div>
  );
}
function FragmentRows({ section, colSpan, children }: { section: string; colSpan: number; children: React.ReactNode }) {
  return (<>{section && <tr><td colSpan={colSpan} className="bg-sunken/40 px-3 py-1.5 text-[11.5px] font-semibold uppercase tracking-wide text-muted">{section}</td></tr>}{children}</>);
}

export function InsightsPanel({ insights }: { insights: Insights }) {
  const blocks: { key: keyof Insights; title: string; empty: string; tone: 'good' | 'warn' | 'bad' | 'info' | 'brand' }[] = [
    { key: 'focus', title: 'Recommended focus for next audit period', empty: 'Nothing flagged — keep doing what you’re doing.', tone: 'brand' },
    { key: 'improvements', title: 'Improvement areas', empty: 'No points lost in this period.', tone: 'warn' },
    { key: 'recurring', title: 'Recurring findings', empty: 'No repeated deductions.', tone: 'bad' },
    { key: 'strengths', title: 'Strengths', empty: 'Strengths appear once parameters are met on every evaluated task.', tone: 'good' },
    { key: 'positive', title: 'Positive trends', empty: 'No parameter improved by 1 pp or more.', tone: 'good' },
    { key: 'declining', title: 'Declining trends', empty: 'No parameter declined by 1 pp or more.', tone: 'bad' },
  ];
  return (
    <div className="flex flex-col gap-3">
      <p className="rounded bg-sunken px-3 py-2 text-[12.5px] text-muted">
        <strong className="text-ink">Automated summary.</strong> Generated by fixed rules from your recorded scores (no AI, no invented findings). The official coaching is the QA feedback on each task.
      </p>
      <div className="grid gap-3 md:grid-cols-2">
        {blocks.map((b) => {
          const items = insights[b.key].slice(0, b.key === 'focus' ? 3 : 6);
          return (
            <div key={b.key} className={clsx('rounded-lg border border-line p-3', b.key === 'focus' && 'md:col-span-2 border-brand/40 bg-brand-soft/30')}>
              <div className="mb-2 flex items-center gap-2"><Pill tone={b.tone}>{items.length}</Pill><h3 className="text-[13.5px] font-semibold">{b.title}</h3></div>
              {items.length === 0 ? <p className="text-[12.5px] text-muted">{b.empty}</p> : (
                <ul className="flex flex-col gap-1.5">
                  {items.map((i) => (
                    <li key={i.stat.parameter.id} className="text-[13px]">
                      <span className="font-medium">{i.stat.parameter.name}</span> <span className="text-faint">· {i.stat.taskTypeName}</span>
                      <div className="text-[12.5px] text-muted">{i.detail}</div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function EvaluationsTable({ evals, settings, showCam = false, pageSize = 15, appealedIds }: { evals: Evaluation[]; settings: PortalSettings; showCam?: boolean; pageSize?: number; appealedIds?: Set<string> }) {
  const [page, setPage] = useState(1);
  const pages = Math.max(1, Math.ceil(evals.length / pageSize));
  const rows = evals.slice((page - 1) * pageSize, page * pageSize);
  if (!evals.length) return <EmptyState title="No QA evaluations are available for this reporting period." />;
  return (
    <>
      <Table>
        <thead><tr>
          <th className={th}>Week</th><th className={th}>Audited</th>{showCam && <th className={th}>CAM</th>}<th className={th}>Task type</th>
          <th className={th}>Task</th><th className={th + ' text-right'}>Score</th><th className={th}>Deductions</th><th className={th}>QA feedback</th><th className={th}></th>
        </tr></thead>
        <tbody>
          {rows.map((e) => {
            const ded = e.scores.filter((s) => s.earned !== null && s.earned < s.max_score);
            return (
              <tr key={e.id} className="hover:bg-sunken/50">
                <td className={td + ' whitespace-nowrap'}>{e.period_short_label}</td>
                <td className={td + ' whitespace-nowrap text-muted'}>{fmtDate(e.audited_at)}</td>
                {showCam && <td className={td + ' whitespace-nowrap font-medium'}>{e.cam_name}</td>}
                <td className={td + ' whitespace-nowrap'}>{e.task_type_name}{e.request_from ? <span className="text-faint"> · {e.request_from}</span> : null}</td>
                <td className={td}><a href={e.task_link} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 font-mono text-[12px] text-brand hover:underline">{e.task_id.slice(0, 8)}<ExternalLink className="h-3 w-3" /></a></td>
                <td className={td + ' text-right whitespace-nowrap'}>
                  <ScoreBadge score={e.score} settings={settings} />
                  {e.autofail && <div className="mt-0.5"><Pill tone="bad">Autofail</Pill></div>}
                  {e.adjusted && <div className="mt-0.5 text-[11px] text-muted">was {fmtPct(e.original_score, 0)}</div>}
                </td>
                <td className={td + ' text-[12.5px]'}>{e.autofail ? <span className="text-bad">Autofail</span> : ded.length ? ded.map((d) => `${d.parameter_name} (${d.earned}/${d.max_score})`).join(', ') : <span className="text-faint">None</span>}</td>
                <td className={td + ' max-w-[360px] text-[12.5px] text-muted'}><span className="line-clamp-2">{e.feedback ?? '—'}</span></td>
                <td className={td + ' whitespace-nowrap'}>
                  <Link to={`/evaluations/${e.id}`} className="text-[12.5px] font-medium text-brand hover:underline">Details</Link>
                  {appealedIds?.has(e.id) && <div className="text-[11px] text-muted">Appealed</div>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </Table>
      <Pagination page={page} pages={pages} onPage={setPage} />
    </>
  );
}

export function Section({ title, subtitle, actions, children }: { title: string; subtitle?: string; actions?: React.ReactNode; children: React.ReactNode }) {
  return <Card title={title} subtitle={subtitle} actions={actions}>{children}</Card>;
}
