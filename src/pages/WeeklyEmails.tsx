import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Mail, Send } from 'lucide-react';
import { useApp, useAsync, useRef_ } from '../app/context';
import { repo, isDemo, isLocal } from '../data';
import { PageHeader } from '../components/Layout';
import { Button, Card, ConfirmModal, EmptyState, ErrorBox, Field, Loading, Pill, Table, td, th, inputBase, inputCls, textareaCls, useToast } from '../components/ui';
import { fmtDateTime, fmtRange } from '../lib/metrics';
import { renderReportEmail } from '../lib/email';
import type { PortalSettings, WeeklyEmailRow } from '../lib/types';

export default function WeeklyEmailsPage() {
  const { reloadRef, bump, me } = useApp();
  const ref = useRef_();
  const toast = useToast();
  const [sp, setSp] = useSearchParams();
  const weeks = [...ref.publishedPeriods].reverse();
  const periodId = sp.get('period') ?? weeks[0]?.id ?? '';
  const period = ref.periods.find((p) => p.id === periodId);
  const rows = useAsync(() => (periodId ? repo.weeklyEmailPreview(periodId) : Promise.resolve([] as WeeklyEmailRow[])), [periodId]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<null | { ids: string[] | null; resend: boolean; count: number; label: string }>(null);
  const [previewCam, setPreviewCam] = useState<string>('');
  const [result, setResult] = useState<Awaited<ReturnType<typeof repo.sendWeeklyEmails>> | null>(null);
  const s = ref.settings;
  const list = rows.data ?? [];
  const sendable = list.filter((r) => r.cam_active && r.cam_email);
  const notYet = sendable.filter((r) => !r.last_status || r.last_status === 'failed');
  const missingLead = list.filter((r) => !r.lead_email);
  const portalMissing = isLocal || (!isDemo && !s.notifications.portal_url);
  const pv = list.find((r) => r.cam_id === previewCam) ?? list[0];
  const email = useMemo(() => (period && pv ? renderReportEmail(s, period, pv.cam_name) : null), [s, period, pv]);
  const cc = pv ? [s.report_email.cc_lead ? pv.lead_email : null, s.report_email.extra_cc.trim() || null].filter(Boolean).join(', ') : '';

  const status = (r: WeeklyEmailRow) => {
    if (!r.cam_active) return <Pill>Inactive CAM</Pill>;
    if (r.last_status === 'sent') return <span className="flex flex-col"><Pill tone="good">Sent</Pill><span className="whitespace-nowrap text-[11px] text-muted">{fmtDateTime(r.last_sent_at)}</span></span>;
    if (r.last_status === 'queued') return <span className="flex flex-col"><Pill tone="info">Queued</Pill>{r.last_error && <span className="text-[11px] text-bad">{r.last_error}</span>}</span>;
    if (r.last_status === 'failed') return <span className="flex flex-col"><Pill tone="bad">Failed</Pill><span className="text-[11px] text-bad">{r.last_error}</span></span>;
    return <Pill tone="warn">Not sent</Pill>;
  };

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Weekly Report Emails" subtitle="Once a week is published, send every audited CAM their QA report link — To: CAM, CC: their Team Lead — using your standard wording."
        actions={<div className="flex items-center gap-2"><label htmlFor="we-week" className="text-[13px] text-muted">Audit week</label>
          <select id="we-week" className={inputBase + ' w-auto'} value={periodId} onChange={(e) => { setSp({ period: e.target.value }, { replace: true }); setSel(new Set()); setResult(null); }}>
            {weeks.map((p) => <option key={p.id} value={p.id}>{p.short_label} · {fmtRange(p.start_date, p.end_date)}</option>)}</select></div>} />
      {!weeks.length && <EmptyState title="No published weeks yet" body="Publish a week under Reporting & Settings first." />}
      {isLocal && <p className="rounded bg-info-soft px-3 py-2 text-[13px] text-info">Local review mode: you can check recipients, CC and the email preview here. Sending is switched off until the portal is deployed, so no email can go out while you review.</p>}
      {portalMissing && !isLocal && <ErrorBox error={new Error('Set the portal URL under Reporting & Settings → Notifications first, so the email can link to each CAM’s report.')} />}
      {isDemo && <p className="rounded bg-warn-soft px-3 py-2 text-[13px] text-warn">Demo mode: sending is simulated and nothing is delivered. In the deployed portal, emails go out through your configured mail account.</p>}
      {missingLead.length > 0 && <p className="rounded bg-warn-soft px-3 py-2 text-[13px] text-warn">{missingLead.length} CAM(s) have no Team Lead email, so their email will go without a CC: {missingLead.map((r) => r.cam_name).join(', ')}. <Link to="/admin/teams" className="font-semibold underline">Fix in Teams</Link></p>}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Card title={period ? `${period.short_label} recipients` : 'Recipients'} subtitle={`${list.length} CAM(s) audited · ${list.filter((r) => r.last_status === 'sent').length} sent · ${notYet.length} not sent yet`} pad={false}
          actions={<>
            <Button disabled={!notYet.length || portalMissing} onClick={() => setConfirm({ ids: notYet.map((r) => r.cam_id), resend: false, count: notYet.length, label: 'everyone not emailed yet' })}><Send className="h-4 w-4" />Send to {notYet.length} not yet emailed</Button>
            <Button variant="secondary" disabled={!sel.size || portalMissing} onClick={() => setConfirm({ ids: [...sel], resend: true, count: sel.size, label: 'the selected CAMs (resend)' })}>Send / resend selected ({sel.size})</Button>
          </>}>
          {rows.loading ? <Loading /> : (
            <Table>
              <thead><tr>
                <th className={th}><input aria-label="Select all" type="checkbox" checked={sel.size > 0 && sel.size === sendable.length} onChange={(e) => setSel(e.target.checked ? new Set(sendable.map((r) => r.cam_id)) : new Set())} /></th>
                <th className={th}>CAM (To)</th><th className={th}>Team Lead (CC)</th><th className={th + ' text-right'}>Tasks</th><th className={th}>Status</th><th className={th}></th></tr></thead>
              <tbody>{list.map((r) => (
                <tr key={r.cam_id} className={r.cam_id === pv?.cam_id ? 'bg-brand-soft/30' : ''}>
                  <td className={td}><input aria-label={`Select ${r.cam_name}`} type="checkbox" disabled={!r.cam_active} checked={sel.has(r.cam_id)} onChange={(e) => { const n = new Set(sel); if (e.target.checked) n.add(r.cam_id); else n.delete(r.cam_id); setSel(n); }} /></td>
                  <td className={td}><div className="font-medium">{r.cam_name}</div><div className="text-[12px] text-muted">{r.cam_email}</div></td>
                  <td className={td}>{r.lead_email ? <><div>{r.lead_name}</div><div className="text-[12px] text-muted">{r.lead_email}</div></> : <span className="text-[12.5px] text-warn">No Lead email</span>}</td>
                  <td className={td + ' text-right tnum'}>{r.tasks}</td>
                  <td className={td}>{status(r)}</td>
                  <td className={td}><Button size="sm" variant="ghost" onClick={() => setPreviewCam(r.cam_id)}>Preview</Button></td>
                </tr>
              ))}</tbody>
            </Table>
          )}
          {result && <div className="border-t border-line px-4 py-3 text-[13px]">
            <strong>{result.sent} sent</strong>{result.failed ? <>, <span className="text-bad">{result.failed} failed</span></> : null}{result.skipped ? `, ${result.skipped} skipped (already emailed)` : ''}{result.no_email ? `, ${result.no_email} without an active email` : ''}.
            {result.failures.map((f) => <div key={f.to} className="text-[12px] text-bad">{f.to}: {f.error}</div>)}
          </div>}
        </Card>

        <Card title="Email preview" subtitle={pv ? `Exactly what ${pv.cam_name} will receive` : undefined}>
          {email && pv ? (
            <div className="flex flex-col gap-2 text-[13px]">
              <div><span className="text-muted">To:</span> {pv.cam_email}</div>
              <div><span className="text-muted">CC:</span> {cc || <span className="text-warn">none</span>}</div>
              {s.report_email.reply_to && <div><span className="text-muted">Reply-To:</span> {s.report_email.reply_to}</div>}
              <div><span className="text-muted">Subject:</span> <strong>{email.subject}</strong></div>
              <iframe title="Email body preview" sandbox="" className="h-64 w-full rounded border border-line bg-white" srcDoc={`<body style="font-family:Arial,sans-serif;font-size:14px;color:#222;margin:12px">${email.html}</body>`} />
              <p className="text-[12px] text-muted">The link opens the CAM’s own dashboard for this week after they sign in. The email contains no scores or feedback.</p>
            </div>
          ) : <p className="text-[13px] text-muted">Choose a week with audits.</p>}
        </Card>
      </div>

      {me?.role === 'super_admin' && <TemplateEditor settings={s} onSaved={async () => { await reloadRef(); toast('Email template saved.'); }} />}

      <ConfirmModal open={!!confirm} title="Send weekly report emails" confirmLabel={`Send ${confirm?.count ?? 0} email(s)`} onClose={() => setConfirm(null)}
        onConfirm={async () => {
          const r = await repo.sendWeeklyEmails(periodId, confirm!.ids, confirm!.resend);
          setResult(r); setSel(new Set()); bump();
          toast(r.failed ? `${r.sent} sent, ${r.failed} failed — see the list.` : `${r.sent} email(s) sent${isDemo ? ' (demo: not delivered)' : ''}.`, r.failed ? 'bad' : 'good');
        }}
        body={<p>Send the {period?.short_label} report email to {confirm?.count} CAM(s) ({confirm?.label}), each with their Team Lead in CC. This can’t be undone.</p>} />
    </div>
  );
}

function TemplateEditor({ settings, onSaved }: { settings: PortalSettings; onSaved: () => void }) {
  const [v, setV] = useState(settings.report_email);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  return (
    <Card title="Email template" subtitle="Placeholders: {CAM_NAME} {CAM_FIRST_NAME} {WEEK} {WEEK_RANGE} {REPORT_LINK} {SENDER_NAME}"
      actions={<Button size="sm" loading={busy} onClick={async () => { setBusy(true); setErr(null); try { await repo.updateSetting('report_email', v); onSaved(); } catch (x) { setErr(x); } finally { setBusy(false); } }}><Mail className="h-4 w-4" />Save template</Button>}>
      <div className="grid gap-3 lg:grid-cols-2">
        <Field label="Subject" htmlFor="rt-subject"><input id="rt-subject" className={inputCls} value={v.subject} onChange={(e) => setV({ ...v, subject: e.target.value })} /></Field>
        <Field label="Sender name (signature)" htmlFor="rt-sender"><input id="rt-sender" className={inputCls} value={v.sender_name} onChange={(e) => setV({ ...v, sender_name: e.target.value })} /></Field>
        <Field label="Reply-To (optional)" htmlFor="rt-reply" hint="e.g. your own address, so CAM replies reach you."><input id="rt-reply" type="email" className={inputCls} value={v.reply_to} onChange={(e) => setV({ ...v, reply_to: e.target.value })} /></Field>
        <Field label="Extra CC (optional, comma separated)" htmlFor="rt-cc"><input id="rt-cc" className={inputCls} value={v.extra_cc} onChange={(e) => setV({ ...v, extra_cc: e.target.value })} /></Field>
        <div className="flex flex-col gap-2 text-[13px] lg:col-span-2">
          <label htmlFor="rt-cclead" className="flex items-center gap-2"><input id="rt-cclead" type="checkbox" checked={v.cc_lead} onChange={(e) => setV({ ...v, cc_lead: e.target.checked })} />CC the CAM’s Team Lead</label>
          <label htmlFor="rt-auto" className="flex items-center gap-2"><input id="rt-auto" type="checkbox" checked={v.send_on_publish} onChange={(e) => setV({ ...v, send_on_publish: e.target.checked })} />Send automatically when a week is published</label>
        </div>
        <div className="lg:col-span-2"><Field label="Body (HTML)" htmlFor="rt-body" hint="Keep “Quality Assurance Report” as the link text around {REPORT_LINK}."><textarea id="rt-body" rows={6} className={textareaCls + ' font-mono text-[12.5px]'} value={v.body_html} onChange={(e) => setV({ ...v, body_html: e.target.value })} /></Field></div>
      </div>
      <ErrorBox error={err} />
    </Card>
  );
}
