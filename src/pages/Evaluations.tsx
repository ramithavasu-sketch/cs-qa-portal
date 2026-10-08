import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ExternalLink, Scale } from 'lucide-react';
import { useApp, useAsync, useRef_ } from '../app/context';
import { useScopeData } from '../app/useScope';
import { repo } from '../data';
import { PageHeader } from '../components/Layout';
import { PeriodPicker, usePeriodSelection } from '../components/PeriodPicker';
import { Button, Card, EmptyState, ErrorBox, Field, Loading, Modal, Pill, ScoreBadge, StatusBadge, Table, td, th, inputCls, inputBase, textareaCls, useToast } from '../components/ui';
import { EvaluationsTable } from '../components/shared';
import { isQaRole, appealWindowOpen, fmtDate, fmtDateTime, fmtPct } from '../lib/metrics';
import type { AppealItem, Evaluation } from '../lib/types';

// ------------------------------------------------------------------ list
export function EvaluationsPage() {
  const { me } = useApp();
  const ref = useRef_();
  const [sel, setSel, periods] = usePeriodSelection(isQaRole(me!.role));
  const data = useScopeData(sel);
  const [type, setType] = useState('');
  const [cam, setCam] = useState('');
  const [only, setOnly] = useState<'' | 'deducted' | 'autofail' | 'adjusted'>('');
  const [q, setQ] = useState('');
  const rows = data.cur.filter((e) => (!type || e.task_type === type) && (!cam || e.cam_id === cam)
    && (!only || (only === 'autofail' ? e.autofail : only === 'adjusted' ? e.adjusted : e.score < 100))
    && (!q || e.task_id.includes(q.toLowerCase()) || (e.feedback ?? '').toLowerCase().includes(q.toLowerCase())));
  const camsInScope = [...new Map(data.cur.map((e) => [e.cam_id, e.cam_name])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const appealed = new Set(data.appeals.filter((a) => a.status !== 'closed').map((a) => a.evaluation_id));
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Task Evaluations" subtitle={me!.role === 'user' ? 'Every audited task, its parameters and QA feedback.' : 'Task-level audit records within your access.'}
        actions={<PeriodPicker sel={sel} onChange={setSel} periods={periods} />} />
      <Card pad={false}>
        <div className="flex flex-wrap items-end gap-3 p-3">
          <div className="flex flex-col gap-1"><label htmlFor="ev-type" className="text-[12px] font-medium text-muted">Task type</label>
            <select id="ev-type" className={inputCls} value={type} onChange={(e) => setType(e.target.value)}><option value="">All</option>{ref.taskTypes.map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}</select></div>
          {me!.role !== 'user' && <div className="flex flex-col gap-1"><label htmlFor="ev-cam" className="text-[12px] font-medium text-muted">CAM</label>
            <select id="ev-cam" className={inputCls} value={cam} onChange={(e) => setCam(e.target.value)}><option value="">All CAMs</option>{camsInScope.map(([id, n]) => <option key={id} value={id}>{n}</option>)}</select></div>}
          <div className="flex flex-col gap-1"><label htmlFor="ev-only" className="text-[12px] font-medium text-muted">Show</label>
            <select id="ev-only" className={inputCls} value={only} onChange={(e) => setOnly(e.target.value as typeof only)}><option value="">All tasks</option><option value="deducted">Below 100</option><option value="autofail">Autofails</option><option value="adjusted">Adjusted after appeal</option></select></div>
          <div className="flex flex-col gap-1"><label htmlFor="ev-q" className="text-[12px] font-medium text-muted">Search task ID or feedback</label>
            <input id="ev-q" className={inputBase + ' w-64'} value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <span className="ml-auto text-[12.5px] text-muted tnum">{rows.length} task(s)</span>
        </div>
      </Card>
      <ErrorBox error={data.error} />
      {data.loading ? <Loading /> : <Card pad={false}><EvaluationsTable evals={rows} settings={ref.settings} showCam={me!.role !== 'user'} pageSize={25} appealedIds={appealed} canAppeal={me!.role === 'user' ? (e) => appealWindowOpen(e, ref.settings, ref.periods) : undefined} /></Card>}
    </div>
  );
}

// ------------------------------------------------------------------ detail
export function EvaluationDetailPage() {
  const { id } = useParams();
  const { me, bump } = useApp();
  const ref = useRef_();
  const s = ref.settings;
  const ev = useAsync(() => repo.getEvaluation(id!), [id]);
  const adj = useAsync(() => repo.getAdjustments(id!), [id]);
  const deadline = useAsync(() => repo.getAppealDeadline(id!), [id]);
  const appeals = useAsync(() => repo.listAppeals({ evaluationId: id }), [id]);
  // ?appeal=1[&param=<parameter id>|AF] opens the appeal form directly (links from task lists and the Appeals page)
  const [sp, setSp] = useSearchParams();
  const [appealOpen, setAppealOpenState] = useState(sp.get('appeal') === '1');
  const [preselect, setPreselect] = useState<string | null>(sp.get('param'));
  const setAppealOpen = (open: boolean, param: string | null = null) => {
    setAppealOpenState(open); setPreselect(param);
    if (!open && sp.has('appeal')) { const n = new URLSearchParams(sp); n.delete('appeal'); n.delete('param'); setSp(n, { replace: true }); }
  };
  const [adjustOpen, setAdjustOpen] = useState(false);
  if (ev.loading) return <Loading />;
  if (!ev.data) return <EmptyState title="Evaluation not available" body="It may not exist, may not be published yet, or is outside your access." action={<Link to="/evaluations" className="text-brand">Back to evaluations</Link>} />;
  const e = ev.data;
  const isOwner = e.cam_id === me!.id;
  const windowOpen = !!deadline.data && Date.now() <= Date.parse(deadline.data);
  const sections = [...new Set(e.scores.map((x) => x.section ?? ''))];
  const paramName = (pid: string | null) => (pid ? ref.parameters.find((p) => p.id === pid)?.name ?? '?' : 'Autofail');
  const canAppeal = isOwner && windowOpen;
  const activeAppealKeys = new Set((appeals.data ?? []).filter((a) => a.status !== 'closed').flatMap((a) => a.disputed_keys ?? []));
  return (
    <div className="flex flex-col gap-5">
      <Link to="/evaluations" className="inline-flex items-center gap-1 text-[13px] text-brand hover:underline"><ArrowLeft className="h-4 w-4" />All evaluations</Link>
      <PageHeader title={`${e.task_type_name} evaluation`} subtitle={<>{e.cam_name} · {e.period_label} · audited {fmtDateTime(e.audited_at)}</>}
        actions={<>
          {isOwner && <Button disabled={!windowOpen} title={windowOpen ? '' : 'The appeal window has closed'} onClick={() => setAppealOpen(true)}><Scale className="h-4 w-4" />Raise Appeal</Button>}
          {isQaRole(me!.role) && <Button variant="secondary" onClick={() => setAdjustOpen(true)}>Correct score</Button>}
        </>} />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Card title="Scores by parameter" subtitle="Earned score against the maximum for each parameter in this task type." pad={false}>
          <Table>
            <thead><tr><th className={th}>Parameter</th><th className={th + ' text-right'}>Max</th><th className={th + ' text-right'}>Earned</th><th className={th}>Result</th>{isOwner && <th className={th}><span className="sr-only">Appeal</span></th>}</tr></thead>
            <tbody>
              {sections.map((sec) => (<FragmentBlock key={sec} sec={sec}>
                {e.scores.filter((x) => (x.section ?? '') === sec).map((x) => (
                  <tr key={x.id}>
                    <td className={td}><span className="font-medium">{x.parameter_name}</span>{x.remarks && <div className="mt-0.5 text-[12px] text-muted"><span className="eyebrow mr-1">QA remark</span>{x.remarks}</div>}</td>
                    <td className={td + ' text-right tnum'}>{x.max_score}</td>
                    <td className={td + ' text-right tnum'}>
                      {x.earned === null ? 'NA' : x.earned}
                      {x.adjusted && <div className="text-[11px] text-muted">original {x.original_earned ?? 'NA'}</div>}
                    </td>
                    <td className={td}>{x.earned === null ? <Pill>Not applicable</Pill> : e.autofail ? <Pill tone="bad">Autofail</Pill> : x.earned < x.max_score ? <Pill tone="bad">Deducted {x.max_score - x.earned}</Pill> : <Pill tone="good">Met</Pill>}{x.adjusted && <span className="ml-1"><Pill tone="info">Adjusted</Pill></span>}</td>
                    {isOwner && <td className={td + ' whitespace-nowrap'}>
                      {x.earned !== null && (activeAppealKeys.has(x.parameter_id) ? <span className="text-[12px] text-muted">Appealed</span>
                        : canAppeal && <button className="text-[12.5px] font-medium text-brand hover:underline" onClick={() => setAppealOpen(true, x.parameter_id)}>Appeal this</button>)}
                    </td>}
                  </tr>
                ))}
              </FragmentBlock>))}
              <tr className="font-semibold"><td className={td}>Task score</td><td className={td + ' text-right tnum'}>100</td><td className={td + ' text-right'}><ScoreBadge score={e.score} settings={s} /></td>
                <td className={td}>{e.autofail ? <Pill tone="bad">Autofail — score 0</Pill> : null}{e.adjusted && <span className="ml-1 text-[12px] font-normal text-muted">original {fmtPct(e.original_score, 0)}{e.original_autofail && !e.autofail ? ' (autofail overturned)' : ''}</span>}</td>
                {isOwner && <td className={td}>{e.autofail && canAppeal && !activeAppealKeys.has('AF') && <button className="text-[12.5px] font-medium text-brand hover:underline" onClick={() => setAppealOpen(true, 'AF')}>Appeal autofail</button>}</td>}</tr>
            </tbody>
          </Table>
        </Card>
        <div className="flex flex-col gap-5">
          <Card title="Task details">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13px]">
              <dt className="text-muted">Task ID</dt><dd className="font-mono text-[12.5px] break-all">{e.task_id}</dd>
              <dt className="text-muted">Task link</dt><dd><a href={e.task_link} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-brand hover:underline">Open in DS<ExternalLink className="h-3 w-3" /></a></dd>
              <dt className="text-muted">Task type</dt><dd>{e.task_type_name}{e.request_from ? ` · ${e.request_from}` : ''}</dd>
              <dt className="text-muted">Task loaded</dt><dd>{fmtDate(e.task_loaded_date)}</dd>
              <dt className="text-muted">Audit week</dt><dd>{e.period_label}</dd>
              <dt className="text-muted">QA evaluator</dt><dd>{e.evaluator_name ?? '—'}</dd>
              <dt className="text-muted">FCR</dt><dd>{e.fcr ?? '—'} <span className="text-[12px] text-faint">(not scored)</span></dd>
              {e.connection_id && <><dt className="text-muted">Connection ID</dt><dd className="font-mono text-[12px] break-all">{e.connection_id}</dd></>}
              {e.screenshot_url && <><dt className="text-muted">Screenshot</dt><dd><a className="text-brand hover:underline" href={e.screenshot_url} target="_blank" rel="noreferrer noopener">View</a></dd></>}
              <dt className="text-muted">Appeal deadline</dt><dd>{deadline.data ? <>{fmtDateTime(deadline.data)} {windowOpen ? <Pill tone="info">Open</Pill> : <Pill>Closed</Pill>}</> : '—'}</dd>
            </dl>
          </Card>
          <Card title="Official QA feedback"><p className="whitespace-pre-wrap text-[13.5px] leading-relaxed">{e.feedback ?? 'No feedback recorded.'}</p></Card>
        </div>
      </div>
      {(appeals.data?.length ?? 0) > 0 && (
        <Card title="Appeals on this task" pad={false}>
          <Table><thead><tr><th className={th}>Reference</th><th className={th}>Disputed</th><th className={th}>Status</th><th className={th}>Submitted</th></tr></thead>
            <tbody>{appeals.data!.map((a) => <tr key={a.id}><td className={td}><Link className="font-mono text-[12.5px] text-brand hover:underline" to={`/appeals/${a.id}`}>{a.reference}</Link></td><td className={td}>{a.parameters_label}</td><td className={td}><StatusBadge status={a.status} overdue={a.overdue} /></td><td className={td + ' text-muted'}>{fmtDate(a.submitted_at)}</td></tr>)}</tbody></Table>
        </Card>
      )}
      {(adj.data?.length ?? 0) > 0 && (
        <Card title="Score change history" subtitle="Original values are never overwritten. Each change is recorded with its reason and approver." pad={false}>
          <Table><thead><tr><th className={th}>When</th><th className={th}>What</th><th className={th + ' text-right'}>From</th><th className={th + ' text-right'}>To</th><th className={th}>Reason</th><th className={th}>Source</th></tr></thead>
            <tbody>{adj.data!.map((a) => <tr key={a.id}><td className={td + ' whitespace-nowrap text-muted'}>{fmtDateTime(a.created_at)}</td><td className={td}>{paramName(a.parameter_id)}</td>
              <td className={td + ' text-right tnum'}>{a.kind === 'autofail' ? (a.original_value ? 'Yes' : 'No') : a.original_value}</td><td className={td + ' text-right tnum'}>{a.kind === 'autofail' ? (a.revised_value ? 'Yes' : 'No') : a.revised_value}</td>
              <td className={td}>{a.reason}</td><td className={td}>{a.appeal_id ? <Link to={`/appeals/${a.appeal_id}`} className="text-brand hover:underline">Appeal</Link> : 'QA correction'}{a.approved_by_name ? ` · ${a.approved_by_name}` : ''}</td></tr>)}</tbody></Table>
        </Card>
      )}
      {isOwner && appealOpen && <AppealForm open onClose={() => setAppealOpen(false)} evaluation={e} deadline={deadline.data} preselect={preselect} onDone={() => bump()} />}
      {isQaRole(me!.role) && <AdjustScoreModal open={adjustOpen} onClose={() => setAdjustOpen(false)} evaluation={e} onDone={() => bump()} />}
    </div>
  );
}
function FragmentBlock({ sec, children }: { sec: string; children: React.ReactNode }) {
  return <>{sec && <tr><td colSpan={5} className="bg-sunken/40 px-3 py-1.5 text-[11.5px] font-semibold uppercase tracking-wide text-muted">{sec}</td></tr>}{children}</>;
}

// ------------------------------------------------------------------ appeal form
/**
 * Raise a new appeal, or edit a draft (pass `draft`). Evidence is uploaded while the
 * appeal is still a draft and only then submitted, so a failed upload never leaves a
 * submitted appeal without its files.
 */
export function AppealForm({ open, onClose, evaluation: e, deadline, onDone, preselect, draft }: {
  open: boolean; onClose: () => void; evaluation: Evaluation; deadline: string | null; onDone: () => void;
  preselect?: string | null; draft?: { id: string; reference: string; reason: string; items: AppealItem[] };
}) {
  const { me } = useApp();
  const ref = useRef_();
  const nav = useNavigate();
  const toast = useToast();
  const [picked, setPicked] = useState<Record<string, { on: boolean; requested: string }>>(() => {
    if (draft) return Object.fromEntries(draft.items.map((i) => [i.is_autofail ? 'AF' : i.parameter_id!, { on: true, requested: i.requested_score === null || i.is_autofail ? '' : String(i.requested_score) }]));
    return preselect ? { [preselect]: { on: true, requested: '' } } : {};
  });
  const [reason, setReason] = useState(draft?.reason ?? '');
  // parameters already under an open appeal on this task (the server enforces this too)
  const others = useAsync(() => repo.listAppeals({ evaluationId: e.id }), [e.id]);
  const blocked = new Set((others.data ?? []).filter((a) => a.status !== 'closed' && a.id !== draft?.id).flatMap((a) => a.disputed_keys ?? []));
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const options = useMemo(() => [
    ...(e.autofail ? [{ key: 'AF', label: 'Autofail decision', max: 1, earned: 1 as number | null, remarks: null as string | null, criteria: null as string | null }] : []),
    ...e.scores.filter((x) => x.earned !== null).map((x) => ({ key: x.parameter_id, label: x.parameter_name, max: x.max_score, earned: x.earned,
      remarks: x.remarks, criteria: ref.parameters.find((p) => p.id === x.parameter_id)?.criteria ?? null })),
  ], [e, ref.parameters]);
  const selected = options.filter((o) => picked[o.key]?.on);
  const submit = async (asDraft: boolean) => {
    setErr(null);
    if (!selected.length) return setErr(new Error('Select at least one disputed parameter.'));
    if (reason.trim().length < 20) return setErr(new Error('Please explain the reason in detail (at least 20 characters).'));
    for (const f of files) if (f.size > 10 * 1024 * 1024) return setErr(new Error(`${f.name} is larger than 10 MB.`));
    setBusy(true);
    const items = selected.map((o) => o.key === 'AF' ? { is_autofail: true } : {
      parameter_id: o.key, requested_score: picked[o.key].requested === '' ? null : Number(picked[o.key].requested) });
    let id = draft?.id ?? null;
    try {
      if (id) await repo.updateDraftAppeal(id, reason, items);
      else id = await repo.submitAppeal(e.id, reason, items, true);
    } catch (x) { setErr(x); setBusy(false); return; }
    try {
      for (const f of files) await repo.uploadEvidence(id, f);
    } catch (x) {
      toast(`Your appeal was saved as a draft, but a file could not be uploaded (${x instanceof Error ? x.message : String(x)}). Open the draft to add the file and submit.`, 'bad');
      setBusy(false); onDone(); onClose(); nav(`/appeals/${id}`); return;
    }
    try {
      if (!asDraft) await repo.submitDraftAppeal(id);
      toast(asDraft ? 'Draft saved. Submit it before the deadline.' : 'Appeal submitted to your Team Lead.');
      onDone(); onClose(); nav(`/appeals/${id}`);
    } catch (x) {
      setErr(new Error(`Saved as a draft but not submitted: ${x instanceof Error ? x.message : String(x)}`));
      onDone();
    } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title={draft ? `Edit draft ${draft.reference}` : 'Raise an appeal'} wide footer={<>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button variant="secondary" loading={busy} onClick={() => submit(true)}>Save as draft</Button>
      <Button loading={busy} onClick={() => submit(false)}>Submit to Team Lead</Button>
    </>}>
      <div className="flex flex-col gap-4 text-[13px]">
        <div className="grid gap-x-4 gap-y-1.5 rounded bg-sunken p-3 sm:grid-cols-2">
          <div><span className="text-muted">CAM:</span> {me!.full_name}</div><div><span className="text-muted">Email:</span> {me!.email}</div>
          <div><span className="text-muted">Task ID:</span> <span className="font-mono text-[12px]">{e.task_id}</span></div>
          <div><span className="text-muted">Task link:</span> <a className="text-brand hover:underline" href={e.task_link} target="_blank" rel="noreferrer noopener">Open</a></div>
          <div><span className="text-muted">Audit date:</span> {fmtDate(e.audited_at)}</div><div><span className="text-muted">Audit week:</span> {e.period_short_label}</div>
          <div><span className="text-muted">Task type:</span> {e.task_type_name}</div><div><span className="text-muted">QA evaluator:</span> {e.evaluator_name ?? '—'}</div>
          <div><span className="text-muted">Original score:</span> <strong>{fmtPct(e.original_score, 0)}</strong>{e.adjusted && <span className="text-muted"> (current {fmtPct(e.score, 0)} after an earlier change)</span>}</div><div><span className="text-muted">Routed to:</span> {me!.lead_name ?? 'No Team Lead assigned'}</div>
          <div><span className="text-muted">Appeal reference:</span> {draft ? <span className="font-mono text-[12px]">{draft.reference}</span> : <span className="text-muted">assigned automatically when saved</span>}</div>
          <div><span className="text-muted">Submission date:</span> {fmtDate(new Date().toISOString())}</div>
          <div className="sm:col-span-2"><span className="text-muted">Appeal deadline:</span> <strong>{deadline ? fmtDateTime(deadline) : '—'}</strong></div>
        </div>
        {e.feedback && <div><div className="eyebrow mb-1">Original QA feedback</div><p className="rounded border border-line p-2.5">{e.feedback}</p></div>}
        <fieldset>
          <legend className="mb-1.5 font-medium">Disputed parameter(s) <span className="text-bad">*</span></legend>
          <p className="mb-2 text-[12px] text-muted">Dispute only the parameters you disagree with. Each one is decided separately.</p>
          <div className="flex flex-col divide-y divide-line rounded border border-line">
            {options.map((o) => {
              const st = picked[o.key] ?? { on: false, requested: '' };
              return (
                <div key={o.key} className="flex flex-wrap items-center gap-3 px-3 py-2">
                  <label className="flex flex-1 items-center gap-2" htmlFor={`ap-${o.key}`}>
                    <input id={`ap-${o.key}`} type="checkbox" checked={st.on} disabled={blocked.has(o.key)} onChange={(x) => setPicked((p) => ({ ...p, [o.key]: { ...st, on: x.target.checked } }))} />
                    <span className="font-medium">{o.label}</span>{blocked.has(o.key) && <span className="text-[12px] text-muted">· already under appeal</span>}
                    <span className="text-muted tnum">{o.key === 'AF' ? 'Autofail = Yes' : `${o.earned}/${o.max}`}</span>
                  </label>
                  {st.on && (o.remarks || o.criteria) && (
                    <div className="basis-full pl-6 text-[12px] text-muted">
                      {o.remarks && <div><span className="eyebrow mr-1">QA remark</span>{o.remarks}</div>}
                      {o.criteria && <div><span className="eyebrow mr-1">Scoring criteria</span>{o.criteria}</div>}
                    </div>
                  )}
                  {st.on && o.key !== 'AF' && (
                    <span className="flex items-center gap-1.5">
                      <label htmlFor={`ap-req-${o.key}`} className="text-[12px] text-muted">Proposed score (optional)</label>
                      <input id={`ap-req-${o.key}`} type="number" min={0} max={o.max} className={inputBase + ' w-20'} value={st.requested} onChange={(x) => setPicked((p) => ({ ...p, [o.key]: { ...st, requested: x.target.value } }))} />
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </fieldset>
        <Field label="Reason for appeal" htmlFor="ap-reason" required hint={`${reason.trim().length} characters · explain what happened and point to the evidence.`}>
          <textarea id="ap-reason" rows={5} className={textareaCls} value={reason} onChange={(x) => setReason(x.target.value)} />
        </Field>
        <Field label="Supporting evidence" htmlFor="ap-files" hint="Screenshots, PDF or text files. Up to 10 MB each.">
          <input id="ap-files" type="file" multiple accept=".png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.docx,.xlsx" onChange={(x) => setFiles([...(x.target.files ?? [])])} className="text-[13px]" />
        </Field>
        <ErrorBox error={err} />
      </div>
    </Modal>
  );
}

function AdjustScoreModal({ open, onClose, evaluation: e, onDone }: { open: boolean; onClose: () => void; evaluation: Evaluation; onDone: () => void }) {
  const toast = useToast();
  const [param, setParam] = useState<string>(e.scores[0]?.parameter_id ?? 'AF');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const cur = param === 'AF' ? (e.autofail ? 1 : 0) : e.scores.find((x) => x.parameter_id === param)?.earned;
  return (
    <Modal open={open} onClose={onClose} title="Correct a finalized score" footer={<>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button loading={busy} onClick={async () => {
        setBusy(true); setErr(null);
        try { await repo.adminAdjustScore(e.id, param === 'AF' ? null : param, Number(value), reason); toast('Score updated and logged.'); onDone(); onClose(); }
        catch (x) { setErr(x); } finally { setBusy(false); }
      }}>Save correction</Button>
    </>}>
      <div className="flex flex-col gap-3 text-[13px]">
        <p className="text-muted">Use this for QA corrections outside an appeal. The original score is kept; the change, your reason and your name are written to the audit log, and the CAM is notified.</p>
        <Field label="Parameter" htmlFor="adj-param">
          <select id="adj-param" className={inputCls} value={param} onChange={(x) => setParam(x.target.value)}>
            {e.scores.map((x) => <option key={x.parameter_id} value={x.parameter_id}>{x.parameter_name} (max {x.max_score})</option>)}
            <option value="AF">Autofail flag</option>
          </select>
        </Field>
        <p>Current value: <strong className="tnum">{param === 'AF' ? (cur ? 'Yes' : 'No') : cur ?? 'NA'}</strong></p>
        <Field label={param === 'AF' ? 'New value (1 = autofail, 0 = no autofail)' : 'New score'} htmlFor="adj-val"><input id="adj-val" type="number" className={inputCls} value={value} onChange={(x) => setValue(x.target.value)} /></Field>
        <Field label="Reason" htmlFor="adj-reason" required><textarea id="adj-reason" rows={3} className={textareaCls} value={reason} onChange={(x) => setReason(x.target.value)} /></Field>
        <ErrorBox error={err} />
      </div>
    </Modal>
  );
}
