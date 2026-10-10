import { useMemo, useState } from 'react';
import { CalendarCheck, ExternalLink, RefreshCw } from 'lucide-react';
import { useApp, useAsync, useRef_ } from '../app/context';
import { repo } from '../data';
import { PageHeader } from '../components/Layout';
import { Button, Card, ConfirmModal, EmptyState, ErrorBox, Field, Kpi, Loading, Modal, Pill, Table, td, th, inputBase, inputCls, useToast } from '../components/ui';
import { fmtDate, fmtDateTime, isQaRole } from '../lib/metrics';
import type { FeedbackSession, FeedbackStatus } from '../lib/types';

const STATUS: Record<FeedbackStatus, { label: string; tone: 'neutral' | 'good' | 'warn' | 'bad' | 'info' }> = {
  not_booked: { label: 'Not booked', tone: 'warn' },
  booked: { label: 'Booked', tone: 'info' },
  completed: { label: 'Completed', tone: 'good' },
  cancelled: { label: 'Cancelled', tone: 'bad' },
  no_audit: { label: 'No audits this cycle', tone: 'neutral' },
};
const StatusPill = ({ s }: { s: FeedbackStatus }) => <Pill tone={STATUS[s].tone}>{STATUS[s].label}</Pill>;
const overdue = (f: FeedbackSession) => f.status === 'not_booked' && !!f.book_by && f.book_by < new Date().toISOString().slice(0, 10);
/** value for <input type="datetime-local"> in the browser's time zone */
const toLocalInput = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

/** Feedback sessions every 3 audit weeks: CAMs book with their QA provider (Team Lead joins). */
export default function FeedbackSessionsPage() {
  const { me } = useApp();
  const ref = useRef_();
  const qa = isQaRole(me!.role);
  const cycles = useAsync(() => repo.listFeedbackCycles(), []);
  const [cycleId, setCycleId] = useState('');
  const current = cycleId || cycles.data?.[0]?.id || '';
  const cycle = cycles.data?.find((c) => c.id === current);
  const sessions = useAsync(() => (current ? repo.listFeedbackSessions(current) : Promise.resolve([] as FeedbackSession[])), [current]);
  const [tab, setTab] = useState<'sessions' | 'responses'>('sessions');
  const weekNames = cycle ? cycle.period_ids.map((id) => ref.periods.find((p) => p.id === id)?.short_label ?? '?').join(', ') : '';
  const list = sessions.data ?? [];
  const mine = list.filter((s) => s.cam_id === me!.id);
  const others = list.filter((s) => s.cam_id !== me!.id);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Feedback Sessions"
        subtitle="Every 3 audit weeks each CAM books a feedback session with the QA team member who audited them most. Their Team Lead joins the session."
        actions={(cycles.data?.length ?? 0) > 0 && <div className="flex items-center gap-2">
          <label htmlFor="fb-cycle" className="text-[13px] text-muted">Cycle</label>
          <select id="fb-cycle" className={inputBase + ' w-auto'} value={current} onChange={(e) => setCycleId(e.target.value)}>
            {cycles.data!.map((c) => <option key={c.id} value={c.id}>Session {c.number}{c.released_at ? '' : ' (not visible to CAMs yet)'}</option>)}
          </select></div>} />
      <ErrorBox error={cycles.error ?? sessions.error} />
      {cycles.loading ? <Loading /> : !cycle ? (
        <EmptyState title="No feedback cycle yet" body={qa ? 'A cycle is created automatically when its last audit week is published, or start one below.' : 'Your next feedback session will show here once the audit weeks are published.'} />
      ) : (<>
        {qa && (
          <div className="flex gap-1 border-b border-line">
            {(['sessions', 'responses'] as const).map((t) => (
              <button key={t} onClick={() => setTab(t)} className={'px-3 py-2 text-[13.5px] font-medium ' + (tab === t ? 'border-b-2 border-brand text-brand' : 'text-muted hover:text-ink')}>
                {t === 'sessions' ? 'Sessions' : 'Form responses'}</button>
            ))}
          </div>
        )}
        {tab === 'responses' && qa ? <ResponsesView /> : sessions.loading ? <Loading /> : (<>
          {mine.map((s) => <MySession key={s.id} s={s} weekNames={weekNames} />)}
          {qa ? <QaView cycle={cycle} weekNames={weekNames} list={list} />
            : others.length > 0 && <TeamView list={others} weekNames={weekNames} number={cycle.number} />}
          {!qa && mine.length === 0 && others.length === 0 && <EmptyState title={`Nothing to book for Session ${cycle.number}`} body="You had no audits in this cycle's weeks." />}
        </>)}
      </>)}
      {me!.role === 'super_admin' && <LinksCard />}
      {qa && <NewCycle nextNumber={(cycles.data?.[0]?.number ?? (ref.settings.feedback?.anchor_number ?? 22) - 1) + 1} />}
    </div>
  );
}

function MySession({ s, weekNames }: { s: FeedbackSession; weekNames: string }) {
  const ref = useRef_();
  const toast = useToast();
  const { bump } = useApp();
  const [when, setWhen] = useState(toLocalInput(s.booked_for));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [editing, setEditing] = useState(s.status === 'not_booked');
  const [removing, setRemoving] = useState(false);
  const url = ref.settings.feedback?.booking_url;
  const form = ref.settings.feedback?.form_url;
  const save = async () => {
    setBusy(true); setErr(null);
    try { await repo.markFeedbackBooked(s.id, new Date(when).toISOString()); toast('Booking saved. Your Team Lead and QA can see it.'); setEditing(false); bump(); }
    catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Card title={`Your feedback session · Session ${s.cycle_number}`} subtitle={`Audit weeks ${weekNames}`} actions={<StatusPill s={s.status} />}>
      {s.status === 'no_audit' ? <p className="text-[13.5px] text-muted">You had no audits in these weeks, so there is no session to book this cycle.</p> : (
        <div className="flex flex-col gap-4 text-[13.5px]">
          <div className="grid gap-3 sm:grid-cols-3">
            <div><div className="text-[12px] text-muted">Session with (QA)</div><div className="text-[15px] font-semibold">{s.provider_name ?? 'To be confirmed by QA'}</div></div>
            <div><div className="text-[12px] text-muted">Your Team Lead joins</div><div className="text-[15px] font-semibold">{s.lead_name ?? '—'}</div></div>
            <div><div className="text-[12px] text-muted">Book on or before</div><div className={'text-[15px] font-semibold ' + (overdue(s) ? 'text-bad' : '')}>{fmtDate(s.book_by)}{overdue(s) ? ' (overdue)' : ''}</div></div>
          </div>
          {s.status === 'completed' ? <p className="rounded bg-good-soft px-3 py-2 text-good">Session completed{s.completed_at ? ` on ${fmtDate(s.completed_at)}` : ''}. Thank you for filling in the feedback form.</p> : (<>
            {s.status === 'booked' && !editing && (<>
              <p className="rounded bg-info-soft px-3 py-2 text-info">Booked for <strong>{fmtDateTime(s.booked_for)}</strong>{s.booking_source === 'sheet' ? ' (from Setmore)' : ''}. <button className="font-semibold underline" onClick={() => setEditing(true)}>Change time</button>
                {' · '}<button className="font-semibold underline" onClick={() => setRemoving(true)}>Remove booking</button></p>
              <div>After the session, fill in the feedback form. The portal marks the session completed when your response arrives.
                <div className="mt-2">{form ? <a href={form} target="_blank" rel="noreferrer"><Button type="button" variant="secondary"><ExternalLink className="h-4 w-4" />Open feedback form</Button></a>
                  : <span className="text-warn">QA has not added the feedback form link yet.</span>}</div></div>
            </>)}
            {editing && (
              <ol className="flex flex-col gap-3">
                <li><strong>1.</strong> Book a slot with <strong>{s.provider_name ?? 'your QA provider'}</strong> in Setmore, and invite {s.lead_name ? <strong>{s.lead_name}</strong> : 'your Team Lead'}.
                  <div className="mt-2">{url ? <a href={url} target="_blank" rel="noreferrer"><Button type="button"><ExternalLink className="h-4 w-4" />Book in Setmore</Button></a>
                    : <span className="text-warn">QA has not added the booking link yet.</span>}</div></li>
                <li><strong>2.</strong> Your booking shows here automatically once it reaches the Setmore booking sheet (usually within 10 minutes). If it doesn't, enter the date and time yourself.
                  <div className="mt-2 flex flex-wrap items-end gap-2">
                    <input aria-label="Booked date and time" type="datetime-local" className={inputBase + ' w-auto'} value={when} onChange={(e) => setWhen(e.target.value)} />
                    <Button variant="secondary" loading={busy} disabled={!when} onClick={save}><CalendarCheck className="h-4 w-4" />Save my booking</Button>
                    {s.status === 'booked' && <Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>}
                  </div></li>
                <li><strong>3.</strong> After the session, fill in the feedback form. The portal marks the session completed when your response arrives.
                  <div className="mt-2">{form ? <a href={form} target="_blank" rel="noreferrer"><Button type="button" variant="secondary"><ExternalLink className="h-4 w-4" />Open feedback form</Button></a>
                    : <span className="text-warn">QA has not added the feedback form link yet.</span>}</div></li>
              </ol>
            )}
            <ErrorBox error={err} />
          </>)}
          <WeekBreakdown s={s} />
          <ConfirmModal open={removing} title="Remove this booking?" confirmLabel="Remove booking" danger onClose={() => setRemoving(false)}
            onConfirm={async () => { await repo.clearFeedbackBooking(s.id); setWhen(''); setEditing(true); toast('Booking removed. Your session shows as Not booked again.'); bump(); }}
            body={<p>Your session on <strong>{fmtDateTime(s.booked_for)}</strong> will show as <strong>Not booked</strong> again for you, your Team Lead and QA. This only changes the portal; if you booked in Setmore, cancel it there too.</p>} />
        </div>
      )}
    </Card>
  );
}

function WeekBreakdown({ s }: { s: FeedbackSession }) {
  return (
    <div className="text-[12.5px] text-muted">Who audited {s.weeks.length ? '' : 'you: —'}{s.weeks.map((w, i) => (
      <span key={w.period_id}>{i ? ' · ' : ''}{w.label}: <span className="text-ink">{w.audits ? `${w.evaluator ?? '?'} (${w.audits})` : 'No audit'}</span></span>
    ))}</div>
  );
}

function TeamView({ list, weekNames, number }: { list: FeedbackSession[]; weekNames: string; number: number }) {
  return (
    <Card title={`Your team · Session ${number}`} subtitle={`Audit weeks ${weekNames}. Each CAM books their own session; you join it.`} pad={false}>
      <Table>
        <thead><tr><th className={th}>CAM</th><th className={th}>Session with (QA)</th><th className={th}>Status</th><th className={th}>Booked for</th><th className={th}>Book by</th></tr></thead>
        <tbody>{list.map((s) => (
          <tr key={s.id}><td className={td}><div className="font-medium">{s.cam_name}</div><div className="text-[12px] text-muted">{s.cam_email}</div></td>
            <td className={td}>{s.provider_name ?? '—'}</td><td className={td}><StatusPill s={s.status} />{overdue(s) && <div className="text-[11.5px] text-bad">Overdue</div>}</td>
            <td className={td}>{s.booked_for ? fmtDateTime(s.booked_for) : '—'}</td><td className={td}>{fmtDate(s.book_by)}</td></tr>
        ))}</tbody>
      </Table>
    </Card>
  );
}

function QaView({ cycle, weekNames, list }: { cycle: { id: string; number: number; period_ids: string[]; book_by: string | null; released_at: string | null }; weekNames: string; list: FeedbackSession[] }) {
  const ref = useRef_();
  const toast = useToast();
  const { bump, me } = useApp();
  const [q, setQ] = useState('');
  const [st, setSt] = useState<'' | FeedbackStatus>('');
  const [prov, setProv] = useState('');
  const [bookBy, setBookBy] = useState(cycle.book_by ?? '');
  const [busy, setBusy] = useState('');
  const qaPeople = ref.employees.filter((e) => e.status === 'active' && (e.role === 'super_admin' || e.role === 'evaluator')).sort((a, b) => a.full_name.localeCompare(b.full_name));
  const providers = [...new Set(list.map((s) => s.provider_name).filter(Boolean) as string[])].sort();
  const shown = list.filter((s) => (!st || s.status === st) && (!prov || s.provider_name === prov)
    && (!q || `${s.cam_name} ${s.cam_email} ${s.lead_name ?? ''}`.toLowerCase().includes(q.toLowerCase())));
  const count = (x: FeedbackStatus) => list.filter((s) => s.status === x).length;
  const run = async (key: string, fn: () => Promise<unknown>, msg: string) => {
    setBusy(key);
    try { await fn(); toast(msg); bump(); } catch (e) { toast(e instanceof Error ? e.message : String(e), 'bad'); } finally { setBusy(''); }
  };
  const byProvider = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of list) if (s.provider_name && s.status !== 'no_audit') m.set(s.provider_name, (m.get(s.provider_name) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [list]);

  return (<>
    {!cycle.released_at && <p className="rounded bg-warn-soft px-3 py-2 text-[13px] text-warn">CAMs and Team Leads can't see Session {cycle.number} yet. It appears for them when its last audit week is published.</p>}
    <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
      <Kpi label="CAMs to book" value={list.length - count('no_audit')} sub={`Audit weeks ${weekNames}`} />
      <Kpi label="Not booked" value={count('not_booked')} tone={count('not_booked') ? 'warn' : 'good'} sub={list.filter(overdue).length ? `${list.filter(overdue).length} overdue` : `Book by ${fmtDate(cycle.book_by)}`} />
      <Kpi label="Booked" value={count('booked')} />
      <Kpi label="Completed" value={count('completed')} tone="good" sub="feedback form received" />
      <Kpi label="No audits" value={count('no_audit')} sub="nothing to book" />
    </div>
    <Card title={`Session ${cycle.number} · ${weekNames}`} subtitle={<>Sessions per provider: {byProvider.map(([n, c]) => `${n.split(' ')[0]} ${c}`).join(' · ') || '—'}</>} pad={false}
      actions={<div className="flex flex-wrap items-center gap-2">
        <label htmlFor="fb-bookby" className="text-[12.5px] text-muted">Book by</label>
        <input id="fb-bookby" type="date" className={inputBase + ' w-auto'} value={bookBy} onChange={(e) => setBookBy(e.target.value)} />
        <Button size="sm" variant="secondary" disabled={bookBy === (cycle.book_by ?? '')} loading={busy === 'bookby'} onClick={() => run('bookby', () => repo.updateFeedbackCycle(cycle.id, bookBy || null), 'Booking deadline saved.')}>Save date</Button>
        <Button size="sm" variant="secondary" loading={busy === 'refresh'} onClick={() => run('refresh', () => repo.buildFeedbackCycle(cycle.number, cycle.period_ids, cycle.book_by), 'Providers refreshed from the latest audits (your manual changes are kept).')}><RefreshCw className="h-4 w-4" />Refresh from audits</Button>
      </div>}>
      <div className="flex flex-wrap gap-2 border-b border-line px-4 py-3">
        <input aria-label="Search CAM or Lead" placeholder="Search CAM or Lead" className={inputBase + ' w-56'} value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="Status" className={inputBase + ' w-auto'} value={st} onChange={(e) => setSt(e.target.value as FeedbackStatus | '')}>
          <option value="">All statuses</option>{(Object.keys(STATUS) as FeedbackStatus[]).map((k) => <option key={k} value={k}>{STATUS[k].label}</option>)}</select>
        <select aria-label="Provider" className={inputBase + ' w-auto'} value={prov} onChange={(e) => setProv(e.target.value)}>
          <option value="">All providers</option>{providers.map((p) => <option key={p}>{p}</option>)}</select>
        <span className="self-center text-[12.5px] text-muted">{shown.length} of {list.length}</span>
      </div>
      <Table>
        <thead><tr><th className={th}>CAM</th>{cycle.period_ids.map((id) => <th key={id} className={th}>{ref.periods.find((p) => p.id === id)?.short_label}</th>)}
          <th className={th}>Session with</th><th className={th}>Team Lead</th><th className={th}>Status</th><th className={th}>Booked for</th></tr></thead>
        <tbody>{shown.map((s) => (
          <tr key={s.id}>
            <td className={td}><div className="font-medium">{s.cam_name}</div><div className="text-[12px] text-muted">{s.cam_email}</div></td>
            {cycle.period_ids.map((id) => { const w = s.weeks.find((x) => x.period_id === id); return <td key={id} className={td + ' text-[12.5px]'}>{w?.audits ? <>{(w.evaluator ?? '?').split(' ')[0]} <span className="text-muted">({w.audits})</span></> : <span className="text-muted">No audit</span>}</td>; })}
            <td className={td}>
              <select aria-label={`Provider for ${s.cam_name}`} className={inputBase + ' w-auto text-[13px]'} value={s.provider_id ?? ''} disabled={busy === s.id}
                onChange={(e) => e.target.value && run(s.id, () => repo.updateFeedbackSession(s.id, { providerId: e.target.value }), `Provider for ${s.cam_name} changed.`)}>
                <option value="">{s.provider_name ?? '— choose —'}</option>
                {qaPeople.map((p) => <option key={p.id} value={p.id}>{p.full_name}{p.id === me!.id ? ' (you)' : ''}</option>)}
              </select>
              {!s.provider_auto && <div className="text-[11px] text-muted">Changed by QA</div>}
            </td>
            <td className={td}>{s.lead_name ?? <span className="text-warn">No Lead</span>}</td>
            <td className={td}>
              <select aria-label={`Status for ${s.cam_name}`} className={inputBase + ' w-auto text-[13px]'} value={s.status} disabled={busy === s.id}
                onChange={(e) => run(s.id, () => repo.updateFeedbackSession(s.id, { status: e.target.value as FeedbackStatus }), `Status for ${s.cam_name} updated.`)}>
                {(Object.keys(STATUS) as FeedbackStatus[]).map((k) => <option key={k} value={k}>{STATUS[k].label}</option>)}
              </select>
              {overdue(s) && <div className="text-[11.5px] text-bad">Overdue</div>}
            </td>
            <td className={td + ' whitespace-nowrap'}>{s.booked_for ? fmtDateTime(s.booked_for) : '—'}{s.booking_source && <div className="text-[11px] text-muted">{{ sheet: 'From Setmore', cam: 'Entered by CAM', qa: 'Entered by QA' }[s.booking_source]}</div>}</td>
          </tr>
        ))}</tbody>
      </Table>
    </Card>
  </>);
}

function ResponsesView() {
  const rows = useAsync(() => repo.listFeedbackResponses(), []);
  const [q, setQ] = useState('');
  const [prov, setProv] = useState('');
  const list = rows.data ?? [];
  const providers = [...new Set(list.map((r) => r.provider_name).filter(Boolean) as string[])].sort();
  const shown = list.filter((r) => (!prov || r.provider_name === prov) && (!q || `${r.cam_email} ${r.feedback_for_provider ?? ''} ${r.lead_name ?? ''}`.toLowerCase().includes(q.toLowerCase())));
  const pct = (f: (r: typeof list[number]) => boolean) => (shown.length ? `${Math.round((100 * shown.filter(f).length) / shown.length)}%` : '—');
  return (<>
    <ErrorBox error={rows.error} />
    {rows.loading ? <Loading /> : list.length === 0 ? (
      <EmptyState title="No form responses yet" body="Responses arrive from the feedback form tab in your audit sheet each time the sheet script runs (paste the latest script first)." />
    ) : (<>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Responses" value={shown.length} />
        <Kpi label="Agree with the feedback" value={pct((r) => /^yes/i.test(r.agrees ?? ''))} />
        <Kpi label="Team Lead present" value={pct((r) => /^yes/i.test(r.lead_present ?? ''))} />
        <Kpi label="Latest" value={fmtDate(shown[0]?.submitted_at)} />
      </div>
      <Card title="Feedback form responses" subtitle="Visible to the QA team only." pad={false}>
        <div className="flex flex-wrap gap-2 border-b border-line px-4 py-3">
          <input aria-label="Search responses" placeholder="Search CAM or comment" className={inputBase + ' w-60'} value={q} onChange={(e) => setQ(e.target.value)} />
          <select aria-label="Provider" className={inputBase + ' w-auto'} value={prov} onChange={(e) => setProv(e.target.value)}>
            <option value="">All providers</option>{providers.map((p) => <option key={p}>{p}</option>)}</select>
        </div>
        <Table>
          <thead><tr><th className={th}>Submitted</th><th className={th}>CAM</th><th className={th}>Provider</th><th className={th}>Lead present</th><th className={th}>Agrees</th><th className={th}>Feedback for the provider</th><th className={th}>QA feedback</th></tr></thead>
          <tbody>{shown.map((r) => (
            <tr key={r.id}><td className={td + ' whitespace-nowrap'}>{fmtDateTime(r.submitted_at)}</td><td className={td}>{r.cam_email}</td><td className={td}>{r.provider_name ?? '—'}</td>
              <td className={td}>{r.lead_present ?? '—'}{r.lead_name ? <div className="text-[12px] text-muted">{r.lead_name}</div> : null}</td>
              <td className={td}>{r.agrees ?? '—'}</td><td className={td + ' max-w-[360px] whitespace-pre-wrap text-[12.5px]'}>{r.feedback_for_provider ?? '—'}</td>
              <td className={td + ' max-w-[260px] whitespace-pre-wrap text-[12.5px]'}>{r.qa_feedback ?? '—'}</td></tr>
          ))}</tbody>
        </Table>
      </Card>
    </>)}
  </>);
}

function NewCycle({ nextNumber }: { nextNumber: number }) {
  const ref = useRef_();
  const toast = useToast();
  const { bump } = useApp();
  const [open, setOpen] = useState(false);
  const [num, setNum] = useState(nextNumber);
  const [weeks, setWeeks] = useState<string[]>([]);
  const [bookBy, setBookBy] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const recent = [...ref.periods].reverse().slice(0, 12);
  return (<>
    <div><Button variant="ghost" size="sm" onClick={() => { setNum(nextNumber); setWeeks([]); setOpen(true); }}>Start a feedback cycle manually…</Button>
      <span className="ml-2 text-[12px] text-muted">Normally not needed: cycles are created when their last week is published.</span></div>
    <Modal open={open} title="Start a feedback cycle" onClose={() => setOpen(false)} footer={<>
      <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
      <Button loading={busy} disabled={!weeks.length} onClick={async () => {
        setBusy(true); setErr(null);
        try { await repo.buildFeedbackCycle(num, [...weeks].sort((a, b) => (ref.periods.find((p) => p.id === a)?.start_date ?? '').localeCompare(ref.periods.find((p) => p.id === b)?.start_date ?? '')), bookBy || null); toast(`Session ${num} set up.`); setOpen(false); bump(); }
        catch (e) { setErr(e); } finally { setBusy(false); }
      }}>Set up Session {num}</Button></>}>
      <div className="flex flex-col gap-3 text-sm">
        <Field label="Session number" htmlFor="nc-num"><input id="nc-num" type="number" className={inputCls} value={num} onChange={(e) => setNum(Number(e.target.value))} /></Field>
        <div><div className="mb-1 text-[13px] font-medium">Audit weeks</div>
          <div className="grid grid-cols-3 gap-1">{recent.map((p) => (
            <label key={p.id} className="flex items-center gap-1.5 text-[13px]"><input type="checkbox" checked={weeks.includes(p.id)}
              onChange={(e) => setWeeks(e.target.checked ? [...weeks, p.id] : weeks.filter((w) => w !== p.id))} />{p.short_label}</label>))}</div></div>
        <Field label="Book on or before" htmlFor="nc-by"><input id="nc-by" type="date" className={inputCls} value={bookBy} onChange={(e) => setBookBy(e.target.value)} /></Field>
        <p className="text-[12.5px] text-muted">If the session number already exists, it's refreshed from the latest audits (manual provider changes and bookings are kept).</p>
        <ErrorBox error={err} />
      </div>
    </Modal>
  </>);
}

function LinksCard() {
  const ref = useRef_();
  const toast = useToast();
  const { reloadRef } = useApp();
  const f = ref.settings.feedback;
  const [booking, setBooking] = useState(f?.booking_url ?? '');
  const [form, setForm] = useState(f?.form_url ?? '');
  const [busy, setBusy] = useState(false);
  const ok = (u: string) => !u || /^https:\/\//.test(u.trim());
  return (
    <Card title="Links shown to CAMs" subtitle="Super Admin only." actions={<Button size="sm" loading={busy} disabled={!ok(booking) || !ok(form) || (booking === (f?.booking_url ?? '') && form === (f?.form_url ?? ''))}
      onClick={async () => {
        setBusy(true);
        try { await repo.updateSetting('feedback', { ...f, booking_url: booking.trim(), form_url: form.trim() }); await reloadRef(); toast('Links saved.'); }
        catch (e) { toast(e instanceof Error ? e.message : String(e), 'bad'); } finally { setBusy(false); }
      }}>Save links</Button>}>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Setmore booking link" htmlFor="fl-book" hint={ok(booking) ? undefined : 'Start the link with https://'}><input id="fl-book" className={inputCls} value={booking} onChange={(e) => setBooking(e.target.value)} /></Field>
        <Field label="Feedback form link (Google Form)" htmlFor="fl-form" hint={ok(form) ? 'Open the form, click Send → link icon, copy the link and paste it here.' : 'Start the link with https://'}>
          <input id="fl-form" className={inputCls} placeholder="https://forms.gle/…" value={form} onChange={(e) => setForm(e.target.value)} /></Field>
      </div>
    </Card>
  );
}
