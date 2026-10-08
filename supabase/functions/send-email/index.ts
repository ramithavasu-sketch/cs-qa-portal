// Delivers queued emails from public.email_outbox.
//  - Called by a QA Super Admin from the portal ("Send weekly report emails") or on a schedule (x-cron-secret).
//  - Provider: EMAIL_PROVIDER=smtp (e.g. Google Workspace: smtp.gmail.com:465 with an app password,
//    or smtp-relay.gmail.com) or EMAIL_PROVIDER=resend (HTTP API). Supabase blocks ports 25/587; use 465.
import nodemailer from 'npm:nodemailer@6.9.16';
import { cors, json, serviceClient, isCron, requireQa } from '../_shared/auth.ts';

interface Msg { to: string; cc?: string | null; replyTo?: string | null; subject: string; text: string; html?: string | null }

const provider = (Deno.env.get('EMAIL_PROVIDER') ?? 'smtp').toLowerCase();
const from = Deno.env.get('EMAIL_FROM') ?? '';
let transport: ReturnType<typeof nodemailer.createTransport> | null = null;

async function sendOne(m: Msg) {
  if (!from) throw new Error('EMAIL_FROM is not set');
  if (provider === 'resend') {
    const key = Deno.env.get('RESEND_API_KEY');
    if (!key) throw new Error('RESEND_API_KEY is not set');
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to: [m.to], cc: m.cc ? m.cc.split(/\s*,\s*/) : undefined, reply_to: m.replyTo || undefined,
        subject: m.subject, text: m.text, html: m.html || undefined }),
    });
    if (!r.ok) throw new Error(await r.text());
    return;
  }
  transport ??= nodemailer.createTransport({
    host: Deno.env.get('SMTP_HOST') ?? 'smtp.gmail.com',
    port: Number(Deno.env.get('SMTP_PORT') ?? 465),
    secure: true,
    auth: { user: Deno.env.get('SMTP_USER'), pass: Deno.env.get('SMTP_PASSWORD') },
  });
  await transport.sendMail({ from, to: m.to, cc: m.cc || undefined, replyTo: m.replyTo || undefined, subject: m.subject, text: m.text, html: m.html || undefined });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const admin = serviceClient();
  try { if (!isCron(req)) await requireQa(req, admin); } catch (e) { return json({ error: (e as Error).message }, 401); }
  const body = await req.json().catch(() => ({})) as { kind?: string };
  let q = admin.from('email_outbox').select('*').eq('status', 'queued').lt('attempts', 5).order('created_at').limit(100);
  if (body.kind) q = q.eq('kind', body.kind);
  const { data: rows, error } = await q;
  if (error) return json({ error: error.message }, 500);
  let sent = 0, failed = 0;
  const failures: { to: string; error: string }[] = [];
  for (const m of rows ?? []) {
    try {
      await sendOne({ to: m.recipient_email, cc: m.cc_email, replyTo: m.reply_to, subject: m.subject, text: m.body_text, html: m.body_html });
      await admin.from('email_outbox').update({ status: 'sent', sent_at: new Date().toISOString(), attempts: m.attempts + 1, last_error: null }).eq('id', m.id);
      sent++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await admin.from('email_outbox').update({ status: m.attempts + 1 >= 5 ? 'failed' : 'queued', attempts: m.attempts + 1, last_error: msg.slice(0, 500) }).eq('id', m.id);
      failures.push({ to: m.recipient_email, error: msg.slice(0, 200) });
      failed++;
    }
  }
  return json({ sent, failed, failures });
});
