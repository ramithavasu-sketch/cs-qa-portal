// "Forgot password?" from the sign-in page. Public (no login), so it never reveals whether an
// email has an account, and sends at most one link per address every 10 minutes.
// With mail_route 'sheet' the link is emailed from the QA owner's Gmail by the sheet script;
// otherwise Supabase sends its own recovery email.
import { cors, json, serviceClient, HttpError } from '../_shared/auth.ts';
import { mailSettings, queueAuthEmail } from '../_shared/authmail.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    if (req.method !== 'POST') throw new HttpError(405, 'Use POST');
    const body = await req.json().catch(() => ({})) as { email?: string; redirect_to?: string };
    const email = String(body.email ?? '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address');
    const admin = serviceClient();
    const { data: emp } = await admin.from('employees').select('id, full_name, status, auth_user_id').eq('email', email).maybeSingle();
    if (emp && emp.status === 'active' && emp.auth_user_id) {
      const { viaSheet, portalUrl } = await mailSettings(admin);
      if (viaSheet) {
        const { data: recent } = await admin.from('email_outbox').select('id').eq('recipient_email', email).eq('kind', 'auth')
          .gte('created_at', new Date(Date.now() - 10 * 60_000).toISOString()).limit(1);
        if (!recent?.length) await queueAuthEmail(admin, { email, name: emp.full_name, kind: 'recovery', portalUrl });
      } else {
        await admin.auth.resetPasswordForEmail(email, { redirectTo: body.redirect_to });
      }
    }
    return json({ ok: true });   // same answer whether or not the address has an account
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, e instanceof HttpError ? e.status : 500);
  }
});
