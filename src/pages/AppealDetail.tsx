import { useState } from 'react';
import { AppealForm } from './Evaluations';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ExternalLink, Lock, Paperclip } from 'lucide-react';
import clsx from 'clsx';
import { useApp, useAsync, useRef_ } from '../app/context';
import { repo } from '../data';
import { PageHeader } from '../components/Layout';
import { Button, Card, ConfirmModal, EmptyState, ErrorBox, Field, Loading, Pill, ScoreBadge, StatusBadge, Table, td, th, inputCls, inputBase, textareaCls, useToast } from '../components/ui';
import { APPEAL_STATUS_LABEL, RECOMMENDATION_LABEL, fmtDate, fmtDateTime, fmtPct } from '../lib/metrics';
import type { AppealDetail, AppealItem, LeadRecommendation } from '../lib/types';

const ACTION_LABEL: Record<string, string> = {
  draft_saved: 'Saved as draft', submitted: 'Submitted to Team Lead', lead_forwarded: 'Forwarded to QA', lead_returned: 'Returned to CAM for clarification',
  cam_responded: 'CAM responded', lead_responded: 'Team Lead responded', qa_requested_info: 'QA requested more information', qa_decided: 'QA decision',
  qa_reopened: 'Reopened by QA', closed: 'Closed', comment: 'Comment', evidence_added: 'Evidence attached', comment_shared: 'Internal comment shared with CAM',
};
const STEPS = ['Submitted', 'Lead review', 'QA review', 'Decision'];
function stepIndex(status: string) {
  if (status === 'draft') return -1;
  if (status === 'pending_lead_review' || status === 'returned_to_cam') return 1;
  if (status === 'pending_qa_review' || status === 'pending_additional_info') return 2;
  return 3;
}

export default function AppealDetailPage() {
  const { id } = useParams();
  const { me, bump } = useApp();
  const ref = useRef_();
  const d = useAsync(() => repo.getAppeal(id!), [id]);
  if (d.loading) return <Loading />;
  if (!d.data) return <EmptyState title="Appeal not available" body="It does not exist or is outside your access." action={<Link to="/appeals" className="text-brand">Back to appeals</Link>} />;
  const { appeal: a, items, events, evidence, evaluation: e } = d.data;
  const pname = (it: AppealItem) => (it.is_autofail ? 'Autofail decision' : ref.parameters.find((p) => p.id === it.parameter_id)?.name ?? '?');
  const pmax = (it: AppealItem) => (it.is_autofail ? 1 : e?.scores.find((s) => s.parameter_id === it.parameter_id)?.max_score ?? 0);
  const step = stepIndex(a.status);
  const nameOf = (id: string | null) => (id ? ref.employees.find((x) => x.id === id)?.full_name ?? (id === me!.id ? me!.full_name : 'QA') : '—');
  const criteriaOf = (it: AppealItem) => (it.is_autofail ? null : ref.parameters.find((p) => p.id === it.parameter_id)?.criteria ?? null);
  const final = ['approved', 'partially_approved', 'rejected', 'closed'].includes(a.status);

  return (
    <div className="flex flex-col gap-5">
      <Link to="/appeals" className="inline-flex items-center gap-1 text-[13px] text-brand hover:underline"><ArrowLeft className="h-4 w-4" />Appeals</Link>
      <PageHeader title={`Appeal ${a.reference}`} subtitle={<>{a.cam_name} · {a.period_label} · Team Lead: {a.lead_name ?? '—'}</>} actions={<StatusBadge status={a.status} overdue={a.overdue} />} />

      <ol className="flex flex-wrap gap-2" aria-label="Appeal progress">
        {STEPS.map((s, i) => (
          <li key={s} className={clsx('flex items-center gap-2 rounded-full border px-3 py-1 text-[12.5px] font-medium',
            i < step || (i === 3 && final) ? 'border-good/40 bg-good-soft text-good' : i === step ? 'border-brand bg-brand-soft text-brand' : 'border-line text-faint')}>
            <span className="tnum">{i + 1}</span>{s}{i === 3 && final ? `: ${APPEAL_STATUS_LABEL[a.status]}` : ''}
          </li>
        ))}
      </ol>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          <Card title="Disputed parameters" pad={false}>
            <Table>
              <thead><tr><th className={th}>Parameter</th><th className={th + ' text-right'}>Max</th><th className={th + ' text-right'}>Original</th><th className={th + ' text-right'}>Requested</th><th className={th}>Decision</th><th className={th + ' text-right'}>Revised</th></tr></thead>
              <tbody>{items.map((it) => (
                <tr key={it.id}>
                  <td className={td + ' font-medium'}>{pname(it)}{it.decision_reason && it.decision !== 'pending' && <div className="mt-0.5 text-[12px] font-normal text-muted">{it.decision_reason}</div>}
                    {it.decided_at && it.decision !== 'pending' && <div className="mt-0.5 text-[11.5px] font-normal text-faint">Decided by {nameOf(it.decided_by)} · {fmtDateTime(it.decided_at)}</div>}</td>
                  <td className={td + ' text-right tnum'}>{it.is_autofail ? '—' : pmax(it)}</td>
                  <td className={td + ' text-right tnum'}>{it.is_autofail ? 'Autofail' : it.original_score ?? 'NA'}</td>
                  <td className={td + ' text-right tnum'}>{it.is_autofail ? 'Remove' : it.requested_score ?? '—'}</td>
                  <td className={td}>{it.decision === 'pending' ? <Pill>Pending</Pill> : it.decision === 'approved' ? (isPartial(it, pmax(it)) ? <Pill tone="good">Partially approved</Pill> : <Pill tone="good">Approved</Pill>) : <Pill tone="bad">Rejected</Pill>}</td>
                  <td className={td + ' text-right tnum'}>{it.decision === 'approved' ? (it.is_autofail ? 'No autofail' : it.revised_score) : '—'}</td>
                </tr>
              ))}</tbody>
            </Table>
          </Card>

          <Card title="CAM’s reason for appeal"><p className="whitespace-pre-wrap text-[13.5px] leading-relaxed">{a.reason}</p>
            {a.resolution_note && <div className="mt-4 rounded border border-brand/30 bg-brand-soft/40 p-3"><div className="eyebrow mb-1">QA resolution · {APPEAL_STATUS_LABEL[a.status]} · {nameOf(a.decided_by)} · {fmtDateTime(a.decided_at)}</div><p className="text-[13.5px]">{a.resolution_note}</p></div>}
          </Card>

          {e && (
            <Card title="Original evaluation" actions={<Link to={`/evaluations/${e.id}`} className="text-[13px] font-medium text-brand hover:underline">Open evaluation</Link>}>
              <div className="flex flex-wrap items-center gap-3 text-[13px]">
                <ScoreBadge score={e.score} settings={ref.settings} />{e.adjusted && <span className="text-muted">original {fmtPct(e.original_score, 0)}</span>}
                <span>{e.task_type_name}</span><span className="text-muted">audited {fmtDate(e.audited_at)} by {e.evaluator_name ?? '—'}</span>
                <a href={e.task_link} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 font-mono text-[12px] text-brand hover:underline">{e.task_id.slice(0, 8)}<ExternalLink className="h-3 w-3" /></a>
              </div>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-[12.5px]"><tbody>
                  {e.scores.map((s) => (
                    <tr key={s.id} className={clsx(items.some((i) => i.parameter_id === s.parameter_id) && 'bg-warn-soft/60')}>
                      <td className="py-1 pr-3">{s.parameter_name}{s.remarks && <div className="text-[11.5px] text-muted">QA remark: {s.remarks}</div>}
                        {items.some((i) => i.parameter_id === s.parameter_id) && criteriaOf(items.find((i) => i.parameter_id === s.parameter_id)!) && <div className="text-[11.5px] text-muted">Scoring criteria: {criteriaOf(items.find((i) => i.parameter_id === s.parameter_id)!)}</div>}</td><td className="py-1 pr-3 text-right tnum">{s.earned ?? 'NA'}/{s.max_score}</td>
                      <td className="py-1 text-muted">{s.adjusted ? `original ${s.original_earned}` : ''}</td>
                    </tr>
                  ))}
                </tbody></table>
              </div>
              {e.feedback && <p className="mt-3 rounded bg-sunken p-2.5 text-[13px]"><span className="eyebrow mr-1">QA feedback</span>{e.feedback}</p>}
            </Card>
          )}

          <Card title="Supporting evidence" actions={!final && <EvidenceUpload appealId={a.id} onDone={bump} />}>
            {evidence.length === 0 ? <p className="text-[13px] text-muted">No files attached.</p> : (
              <ul className="flex flex-col gap-1.5">{evidence.map((f) => <li key={f.id}><EvidenceLink path={f.storage_path} name={f.file_name} size={f.size_bytes} /></li>)}</ul>
            )}
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-5">
          <ActionPanel d={d.data} onDone={bump} role={me!.role} meId={me!.id} pname={pname} pmax={pmax} />
          <Card title="Timeline">
            <ol className="relative flex flex-col gap-4 border-l border-line pl-4">
              {events.map((ev) => (
                <li key={ev.id} className="relative">
                  <span className={clsx('absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full border-2 border-surface', ev.visibility === 'internal' ? 'bg-warn' : 'bg-brand')} />
                  <div className="flex flex-wrap items-center gap-1.5 text-[13px]">
                    <span className="font-semibold">{ACTION_LABEL[ev.action] ?? ev.action}</span>
                    {ev.recommendation && <Pill tone={ev.recommendation === 'recommend_approval' ? 'good' : ev.recommendation === 'recommend_rejection' ? 'bad' : 'warn'}>{RECOMMENDATION_LABEL[ev.recommendation]}</Pill>}
                    {ev.visibility === 'internal' && <Pill tone="warn"><Lock className="mr-0.5 h-3 w-3" />Internal · not visible to CAM</Pill>}
                  </div>
                  <div className="text-[12px] text-muted">{ev.actor_name ?? 'System'} · {fmtDateTime(ev.created_at)}{ev.to_status && ev.from_status !== ev.to_status ? ` · → ${APPEAL_STATUS_LABEL[ev.to_status]}` : ''}</div>
                  {ev.comment && <p className="mt-1 whitespace-pre-wrap rounded bg-sunken px-2.5 py-1.5 text-[13px]">{ev.comment}</p>}
                  {ev.visibility === 'internal' && ev.action === 'comment' && me!.role !== 'user' && (ev.actor_id === me!.id || me!.role === 'super_admin') && <ShareButton eventId={ev.id} onDone={bump} />}
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>
    </div>
  );
}

function EvidenceLink({ path, name, size }: { path: string; name: string; size: number }) {
  const [err, setErr] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-wrap items-center gap-2 text-[13px]">
      <Paperclip className="h-4 w-4 text-muted" />
      <button className="text-brand hover:underline" onClick={async () => {
        try {
          const url = await repo.evidenceUrl(path);
          if (url.startsWith('data:')) {
            // files kept by the portal itself (demo, local review, Google version): save a copy
            const blob = await (await fetch(url)).blob();
            const href = URL.createObjectURL(blob);
            const a = document.createElement('a'); a.href = href; a.download = name; document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(href), 10_000);
          } else {
            const w = window.open(url, '_blank');
            if (!w) setErr('Your browser blocked the new tab.'); else w.opener = null;
          }
        } catch (x) { setErr(x instanceof Error ? x.message : String(x)); }
      }}>{name}</button>
      <span className="text-faint tnum">{(size / 1024).toFixed(0)} KB</span>{err && <span className="text-bad text-[12px]">{err}</span>}
    </span>
  );
}

function EvidenceUpload({ appealId, onDone }: { appealId: string; onDone: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <label className={clsx('inline-flex cursor-pointer items-center gap-1.5 rounded border border-line px-2.5 py-1.5 text-[13px] font-medium hover:bg-sunken', busy && 'opacity-50')}>
      <Paperclip className="h-4 w-4" />{busy ? 'Uploading…' : 'Attach file'}
      <input type="file" className="sr-only" accept=".png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.docx,.xlsx" disabled={busy} onChange={async (e) => {
        const f = e.target.files?.[0]; if (!f) return;
        setBusy(true);
        try { await repo.uploadEvidence(appealId, f); toast('File attached.'); onDone(); } catch (x) { toast(x instanceof Error ? x.message : String(x), 'bad'); } finally { setBusy(false); e.target.value = ''; }
      }} />
    </label>
  );
}

function ActionPanel({ d, onDone, role, meId, pname, pmax }: { d: AppealDetail; onDone: () => void; role: string; meId: string; pname: (i: AppealItem) => string; pmax: (i: AppealItem) => number }) {
  const a = d.appeal;
  const isCam = a.cam_id === meId;
  const isLead = role === 'admin';
  const isQa = role === 'super_admin';
  const awaitingMe = (a.status === 'returned_to_cam' && isCam) || (a.status === 'pending_additional_info' && ((a.info_requested_from === 'cam' && isCam) || (a.info_requested_from === 'lead' && isLead)));
  return (
    <div className="flex flex-col gap-5">
      {awaitingMe && <RespondCard appealId={a.id} onDone={onDone} request={[...d.events].reverse().find((e) => e.action === 'lead_returned' || e.action === 'qa_requested_info')?.comment ?? null} dueAt={a.info_due_at} />}
      {isCam && a.status === 'draft' && <DraftCard d={d} onDone={onDone} />}
      {isLead && a.status === 'pending_lead_review' && <LeadReviewCard appealId={a.id} onDone={onDone} />}
      {isQa && a.status === 'pending_qa_review' && <QaDecisionCard d={d} onDone={onDone} pname={pname} pmax={pmax} />}
      {isQa && <QaSecondaryActions d={d} onDone={onDone} pname={pname} />}
      {isCam && ['pending_lead_review', 'returned_to_cam', 'draft'].includes(a.status) && <WithdrawCard appealId={a.id} onDone={onDone} />}
      {!['closed'].includes(a.status) && <CommentCard appealId={a.id} canInternal={!isCam && role !== 'user'} onDone={onDone} />}
      {!awaitingMe && !isQa && !(isLead && a.status === 'pending_lead_review') && (
        <Card title="What happens next"><p className="text-[13px] text-muted">{nextText(a.status, isCam)}</p></Card>
      )}
    </div>
  );
}
function nextText(status: string, isCam: boolean) {
  switch (status) {
    case 'pending_lead_review': return isCam ? 'Your Team Lead will review the appeal and forward it to QA with a recommendation, or ask you for more information.' : 'Waiting for the Team Lead’s review.';
    case 'returned_to_cam': return 'Waiting for the CAM to provide the requested information.';
    case 'pending_qa_review': return 'QA is reviewing the appeal. The final decision will be shared here and by notification.';
    case 'pending_additional_info': return 'QA has asked for more information before deciding.';
    case 'approved': case 'partially_approved': return 'The decision is final. Approved changes are reflected in all dashboards and reports.';
    case 'rejected': return 'The decision is final. The original score stands.';
    default: return 'No further action.';
  }
}

function RespondCard({ appealId, onDone, request, dueAt }: { appealId: string; onDone: () => void; request: string | null; dueAt: string | null }) {
  const toast = useToast();
  const [text, setText] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState<unknown>(null);
  return (
    <Card title="Information requested from you" className="border-warn/50">
      <div className="flex flex-col gap-3 text-[13px]">
        {request && <p className="rounded bg-warn-soft px-3 py-2 text-warn">{request}</p>}
        {dueAt && <p className="text-muted">Please respond by <strong className="text-ink">{fmtDateTime(dueAt)}</strong>.</p>}
        <Field label="Your response" htmlFor="resp-text"><textarea id="resp-text" rows={4} className={textareaCls} value={text} onChange={(e) => setText(e.target.value)} /></Field>
        <ErrorBox error={err} />
        <Button loading={busy} onClick={async () => { setBusy(true); setErr(null); try { await repo.respondToAppealRequest(appealId, text); toast('Response sent.'); onDone(); } catch (x) { setErr(x); } finally { setBusy(false); } }}>Send response</Button>
      </div>
    </Card>
  );
}

function DraftCard({ d, onDone }: { d: AppealDetail; onDone: () => void }) {
  const toast = useToast(); const [busy, setBusy] = useState(false); const [err, setErr] = useState<unknown>(null);
  const [edit, setEdit] = useState(false);
  const appealId = d.appeal.id;
  const deadline = useAsync(() => repo.getAppealDeadline(d.appeal.evaluation_id), [d.appeal.evaluation_id]);
  return (
    <Card title="Draft appeal">
      <p className="mb-3 text-[13px] text-muted">This draft has not been sent. Submit it to route it to your Team Lead{deadline.data ? <> before <strong className="text-ink">{fmtDateTime(deadline.data)}</strong></> : ''}.</p>
      <ErrorBox error={err} />
      <div className="flex flex-wrap gap-2">
        <Button loading={busy} onClick={async () => { setBusy(true); try { await repo.submitDraftAppeal(appealId); toast('Appeal submitted to your Team Lead.'); onDone(); } catch (x) { setErr(x); } finally { setBusy(false); } }}>Submit to Team Lead</Button>
        {d.evaluation && <Button variant="secondary" onClick={() => setEdit(true)}>Edit draft</Button>}
      </div>
      {edit && d.evaluation && <AppealForm open onClose={() => setEdit(false)} evaluation={d.evaluation} deadline={deadline.data ?? null} onDone={onDone}
        draft={{ id: appealId, reference: d.appeal.reference, reason: d.appeal.reason, items: d.items }} />}
    </Card>
  );
}

function ShareButton({ eventId, onDone }: { eventId: string; onDone: () => void }) {
  const toast = useToast(); const [open, setOpen] = useState(false);
  return (<>
    <button className="mt-1 text-[12px] font-medium text-brand hover:underline" onClick={() => setOpen(true)}>Share with CAM</button>
    <ConfirmModal open={open} title="Share this comment with the CAM?" confirmLabel="Share with CAM" onClose={() => setOpen(false)}
      onConfirm={async () => { await repo.shareAppealComment(eventId); toast('Comment is now visible to the CAM.'); onDone(); }}
      body={<p>The CAM will be able to read this comment in the appeal timeline. This cannot be undone.</p>} />
  </>);
}

/** Approved and raised, but not as far as requested (or not to the maximum when nothing was requested). */
function isPartial(it: AppealItem, max: number) {
  return it.decision === 'approved' && !it.is_autofail && it.revised_score !== null
    && it.revised_score > (it.original_score ?? 0) && it.revised_score < (it.requested_score ?? max);
}

function LeadReviewCard({ appealId, onDone }: { appealId: string; onDone: () => void }) {
  const toast = useToast();
  const [rec, setRec] = useState<LeadRecommendation>('recommend_approval');
  const [comment, setComment] = useState(''); const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<unknown>(null);
  return (
    <Card title="Your review" subtitle="You recommend; QA makes the final decision." className="border-brand/50">
      <div className="flex flex-col gap-3 text-[13px]">
        <fieldset className="flex flex-col gap-1.5"><legend className="mb-1 font-medium">Recommendation</legend>
          {(Object.keys(RECOMMENDATION_LABEL) as LeadRecommendation[]).map((k) => (
            <label key={k} className="flex items-center gap-2" htmlFor={`rec-${k}`}><input id={`rec-${k}`} type="radio" name="rec" checked={rec === k} onChange={() => setRec(k)} />{RECOMMENDATION_LABEL[k]}
              <span className="text-[12px] text-muted">{k === 'request_more_info' ? '— returns the appeal to the CAM' : '— forwards to QA'}</span></label>
          ))}
        </fieldset>
        <Field label={rec === 'request_more_info' ? 'What do you need from the CAM? (visible to CAM)' : 'Comment for QA (visible to CAM)'} htmlFor="lead-comment" required>
          <textarea id="lead-comment" rows={3} className={textareaCls} value={comment} onChange={(e) => setComment(e.target.value)} />
        </Field>
        <Field label="Internal note (optional — QA and Leads only)" htmlFor="lead-note"><textarea id="lead-note" rows={2} className={textareaCls} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <ErrorBox error={err} />
        <Button loading={busy} onClick={async () => { setBusy(true); setErr(null); try { await repo.leadReviewAppeal(appealId, rec, comment, note || undefined); toast(rec === 'request_more_info' ? 'Returned to CAM.' : 'Forwarded to QA.'); onDone(); } catch (x) { setErr(x); } finally { setBusy(false); } }}>
          {rec === 'request_more_info' ? 'Return to CAM' : 'Forward to QA'}
        </Button>
      </div>
    </Card>
  );
}

function QaDecisionCard({ d, onDone, pname, pmax }: { d: AppealDetail; onDone: () => void; pname: (i: AppealItem) => string; pmax: (i: AppealItem) => number }) {
  const toast = useToast();
  const ref = useRef_();
  const e = d.evaluation;
  const [dec, setDec] = useState<Record<string, { decision: '' | 'approved' | 'rejected'; revised: string; reason: string }>>(
    Object.fromEntries(d.items.map((i) => [i.id, { decision: '', revised: i.requested_score !== null && !i.is_autofail ? String(i.requested_score) : '', reason: '' }])));
  const [resolution, setResolution] = useState('');
  const [extra, setExtra] = useState<Record<string, string>>({});
  const [extraReason, setExtraReason] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<unknown>(null);
  const [mode, setMode] = useState<'decide' | 'info'>('decide');
  const [infoFrom, setInfoFrom] = useState<'cam' | 'lead'>('cam'); const [infoText, setInfoText] = useState('');
  const afApproved = d.items.some((i) => i.is_autofail && dec[i.id]?.decision === 'approved');
  const lead = d.events.filter((x) => x.action === 'lead_forwarded').pop();
  const submit = async () => {
    setErr(null);
    const missing = d.items.find((i) => !dec[i.id].decision);
    if (missing) return setErr(new Error(`Choose approve or reject for “${pname(missing)}”.`));
    const noReason = d.items.find((i) => dec[i.id].decision === 'approved' && dec[i.id].reason.trim().length < 5);
    if (noReason) return setErr(new Error(`Give the reason for the score adjustment on “${pname(noReason)}”.`));
    setBusy(true);
    try {
      const extras = Object.entries(extra).filter(([, v]) => v !== '').map(([pid, v]) => ({ parameter_id: pid, revised_score: Number(v), reason: extraReason }));
      const r = await repo.qaDecideAppeal(d.appeal.id, d.items.map((i) => ({ item_id: i.id, decision: dec[i.id].decision as 'approved' | 'rejected',
        revised_score: i.is_autofail ? null : dec[i.id].revised === '' ? null : Number(dec[i.id].revised), reason: dec[i.id].reason || undefined })), resolution, extras);
      toast(`Decision recorded: ${APPEAL_STATUS_LABEL[r as keyof typeof APPEAL_STATUS_LABEL] ?? r}.`); onDone();
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  return (
    <Card title="QA decision" subtitle="Decide each disputed parameter. Approved changes recalculate the task score; originals are kept." className="border-brand/50">
      <div className="flex flex-col gap-3 text-[13px]">
        {lead && <div className="rounded bg-sunken p-2.5"><span className="eyebrow">Team Lead recommendation</span><div className="mt-1 font-medium">{lead.recommendation ? RECOMMENDATION_LABEL[lead.recommendation] : '—'}</div>{lead.comment && <p className="text-muted">{lead.comment}</p>}</div>}
        <div className="flex gap-2">
          <Button size="sm" variant={mode === 'decide' ? 'primary' : 'secondary'} onClick={() => setMode('decide')}>Decide</Button>
          <Button size="sm" variant={mode === 'info' ? 'primary' : 'secondary'} onClick={() => setMode('info')}>Request information</Button>
        </div>
        {mode === 'info' ? (<>
          <Field label="Request from" htmlFor="info-from"><select id="info-from" className={inputCls} value={infoFrom} onChange={(x) => setInfoFrom(x.target.value as 'cam' | 'lead')}><option value="cam">CAM</option><option value="lead">Team Lead</option></select></Field>
          <Field label="What information is needed?" htmlFor="info-text" required><textarea id="info-text" rows={3} className={textareaCls} value={infoText} onChange={(x) => setInfoText(x.target.value)} /></Field>
          <ErrorBox error={err} />
          <Button loading={busy} onClick={async () => { setBusy(true); setErr(null); try { await repo.qaRequestInfo(d.appeal.id, infoFrom, infoText); toast('Information requested.'); onDone(); } catch (x) { setErr(x); } finally { setBusy(false); } }}>Send request</Button>
        </>) : (<>
          {d.items.map((i) => {
            const st = dec[i.id];
            return (
              <div key={i.id} className="rounded border border-line p-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{pname(i)}</span>
                  <span className="text-muted tnum">{i.is_autofail ? 'Autofail = Yes' : `original ${i.original_score}/${pmax(i)}${i.requested_score !== null ? ` · requested ${i.requested_score}` : ''}`}</span>
                </div>
                {!i.is_autofail && (() => { const c = ref.parameters.find((p) => p.id === i.parameter_id)?.criteria; const r = e?.scores.find((x) => x.parameter_id === i.parameter_id)?.remarks;
                  return (c || r) ? <div className="mt-1 text-[12px] text-muted">{c && <div><span className="eyebrow mr-1">Scoring criteria</span>{c}</div>}{r && <div><span className="eyebrow mr-1">QA remark</span>{r}</div>}</div> : null; })()}
                <div className="mt-2 flex flex-wrap items-end gap-3">
                  {(['approved', 'rejected'] as const).map((k) => (
                    <label key={k} htmlFor={`dec-${i.id}-${k}`} className="flex items-center gap-1.5"><input id={`dec-${i.id}-${k}`} type="radio" name={`dec-${i.id}`} checked={st.decision === k} onChange={() => setDec((x) => ({ ...x, [i.id]: { ...st, decision: k } }))} />{k === 'approved' ? 'Approve' : 'Reject'}</label>
                  ))}
                  {st.decision === 'approved' && !i.is_autofail && (
                    <span className="flex items-center gap-1.5"><label htmlFor={`rev-${i.id}`} className="text-[12px] text-muted">Revised score (0–{pmax(i)})</label>
                      <input id={`rev-${i.id}`} type="number" min={0} max={pmax(i)} className={inputBase + ' w-20'} value={st.revised} onChange={(x) => setDec((y) => ({ ...y, [i.id]: { ...st, revised: x.target.value } }))} /></span>
                  )}
                </div>
                <label htmlFor={`reason-${i.id}`} className="sr-only">Reason for {pname(i)}</label>
                <input id={`reason-${i.id}`} className={inputCls + ' mt-2'} placeholder={st.decision === 'approved' ? 'Reason for the score adjustment (required)' : 'Reason for this parameter (optional — defaults to the resolution remarks)'} value={st.reason} onChange={(x) => setDec((y) => ({ ...y, [i.id]: { ...st, reason: x.target.value } }))} />
              </div>
            );
          })}
          {afApproved && e && (
            <div className="rounded border border-info/40 bg-info-soft/40 p-2.5">
              <div className="font-medium">Re-score other parameters (optional)</div>
              <p className="text-[12px] text-muted">When an autofail is overturned, the task is scored from its parameters. Mark down any parameters that still missed the standard.</p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {e.scores.map((s) => (
                  <span key={s.parameter_id} className="flex items-center justify-between gap-2"><label htmlFor={`x-${s.parameter_id}`} className="text-[12.5px]">{s.parameter_name} <span className="text-faint">(now {s.earned}/{s.max_score})</span></label>
                    <input id={`x-${s.parameter_id}`} type="number" min={0} max={s.max_score} className={inputBase + ' w-20'} value={extra[s.parameter_id] ?? ''} onChange={(x) => setExtra((y) => ({ ...y, [s.parameter_id]: x.target.value }))} /></span>
                ))}
              </div>
              <label htmlFor="x-reason" className="sr-only">Reason for re-scoring</label>
              <input id="x-reason" className={inputCls + ' mt-2'} placeholder="Reason for these score changes" value={extraReason} onChange={(x) => setExtraReason(x.target.value)} />
            </div>
          )}
          <Field label="Resolution remarks (shared with CAM and Lead)" htmlFor="qa-res" required><textarea id="qa-res" rows={3} className={textareaCls} value={resolution} onChange={(x) => setResolution(x.target.value)} /></Field>
          <ErrorBox error={err} />
          <Button loading={busy} onClick={submit}>Record final decision</Button>
        </>)}
      </div>
    </Card>
  );
}

function QaSecondaryActions({ d, onDone, pname }: { d: AppealDetail; onDone: () => void; pname: (i: AppealItem) => string }) {
  const toast = useToast();
  const a = d.appeal;
  const [reopen, setReopen] = useState(false); const [close, setClose] = useState(false); const [reason, setReason] = useState('');
  const [grantItem, setGrantItem] = useState<AppealItem | null>(null);
  const decided = ['approved', 'partially_approved', 'rejected'].includes(a.status);
  const canReopen = decided || (a.status === 'closed' && !!a.forwarded_at);
  if (!canReopen && a.status === 'closed') return null;
  return (
    <Card title="QA actions">
      <div className="flex flex-wrap gap-2">
        {canReopen && <Button variant="secondary" onClick={() => { setReason(''); setReopen(true); }}>Reopen appeal</Button>}
        {a.status !== 'closed' && <Button variant="secondary" onClick={() => { setReason(''); setClose(true); }}>Close appeal</Button>}
        {decided && d.items.map((i) => <Button key={i.id} size="sm" variant="ghost" onClick={() => { setReason(''); setGrantItem(i); }}>Allow new appeal: {pname(i)}</Button>)}
      </div>
      <ConfirmModal open={reopen} title="Reopen appeal" confirmLabel="Reopen" onClose={() => setReopen(false)}
        onConfirm={async () => { await repo.qaReopenAppeal(a.id, reason); toast('Appeal reopened.'); onDone(); }}
        body={<><p>The appeal returns to Pending QA Review. Existing score changes stay until you record a new decision. The previous decision remains in the timeline and the audit log.</p><ReasonBox value={reason} onChange={setReason} /></>} />
      <ConfirmModal open={close} title="Close appeal" confirmLabel="Close appeal" danger onClose={() => setClose(false)}
        onConfirm={async () => { await repo.closeAppeal(a.id, reason); toast('Appeal closed.'); onDone(); }}
        body={<><p>Closing ends the workflow. The CAM is notified.</p><ReasonBox value={reason} onChange={setReason} /></>} />
      <ConfirmModal open={!!grantItem} title="Allow a new appeal" confirmLabel="Allow resubmission" onClose={() => setGrantItem(null)}
        onConfirm={async () => { await repo.grantResubmission(a.evaluation_id, grantItem!.parameter_id, grantItem!.is_autofail, reason); toast('The CAM can submit one new appeal for this parameter.'); onDone(); }}
        body={<><p>The CAM will be able to submit one new appeal on <strong>{grantItem ? pname(grantItem) : ''}</strong> for this task.</p><ReasonBox value={reason} onChange={setReason} /></>} />
    </Card>
  );
}
function ReasonBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return <Field label="Reason" htmlFor="confirm-reason" required><textarea id="confirm-reason" rows={3} className={textareaCls} value={value} onChange={(e) => onChange(e.target.value)} /></Field>;
}

function WithdrawCard({ appealId, onDone }: { appealId: string; onDone: () => void }) {
  const toast = useToast(); const [open, setOpen] = useState(false); const [reason, setReason] = useState('');
  return (
    <>
      <Button variant="ghost" onClick={() => setOpen(true)}>Withdraw appeal</Button>
      <ConfirmModal open={open} title="Withdraw appeal" confirmLabel="Withdraw" danger onClose={() => setOpen(false)}
        onConfirm={async () => { await repo.closeAppeal(appealId, reason); toast('Appeal withdrawn.'); onDone(); }}
        body={<><p>Withdrawing closes the appeal. You can raise a new one while the appeal window is open.</p><ReasonBox value={reason} onChange={setReason} /></>} />
    </>
  );
}

function CommentCard({ appealId, canInternal, onDone }: { appealId: string; canInternal: boolean; onDone: () => void }) {
  const toast = useToast();
  const [text, setText] = useState(''); const [internal, setInternal] = useState(canInternal); const [busy, setBusy] = useState(false); const [err, setErr] = useState<unknown>(null);
  return (
    <Card title="Add a comment">
      <div className="flex flex-col gap-2 text-[13px]">
        <label htmlFor="cm-text" className="sr-only">Comment</label>
        <textarea id="cm-text" rows={2} className={textareaCls} value={text} onChange={(e) => setText(e.target.value)} placeholder="Write a comment" />
        {canInternal && <label htmlFor="cm-int" className="flex items-center gap-2"><input id="cm-int" type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} />Internal (hidden from the CAM)</label>}
        <ErrorBox error={err} />
        <div><Button size="sm" variant="secondary" loading={busy} onClick={async () => { setBusy(true); setErr(null); try { await repo.addAppealComment(appealId, text, internal); setText(''); toast('Comment added.'); onDone(); } catch (x) { setErr(x); } finally { setBusy(false); } }}>Post comment</Button></div>
      </div>
    </Card>
  );
}
