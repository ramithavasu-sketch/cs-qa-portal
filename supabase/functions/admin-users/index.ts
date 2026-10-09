// POST { action: 'invite', employee_id, redirect_to }       -> sends a Supabase Auth invitation (or, if they already
//                                                          have a login, a link to set their own password)
// POST { action: 'set_password', employee_id, password } -> creates the login (or resets it) with a temporary password;
//                                                          the user must change it at first sign-in. Never logged or returned.
// POST { action: 'deactivate' | 'reactivate', employee_id } -> blocks/unblocks the login and revokes sessions
import { cors, json, serviceClient, requireSuperAdmin, HttpError } from '../_shared/auth.ts';
import { mailSettings, queueAuthEmail } from '../_shared/authmail.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const admin = serviceClient();
    const actor = await requireSuperAdmin(req, admin);
    const body = await req.json();
    const { data: emp } = await admin.from('employees').select('*').eq('id', body.employee_id).maybeSingle();
    if (!emp) throw new HttpError(404, 'Employee not found');

    if (body.action === 'invite') {
      if (emp.status !== 'active') throw new HttpError(400, 'Reactivate the user before inviting');
      if (String(emp.email).endsWith('.invalid')) throw new HttpError(400, 'Add this person’s real email address first');
      const mail = await mailSettings(admin);
      if (mail.viaSheet) {
        // Sent from the QA owner's Gmail by the audit sheet's script (no SMTP needed).
        await queueAuthEmail(admin, { email: emp.email, name: emp.full_name, kind: emp.auth_user_id ? 'recovery' : 'invite', portalUrl: mail.portalUrl });
        await admin.from('audit_logs').insert({ actor_id: actor.id, action: emp.auth_user_id ? 'password_link' : 'invite', table_name: 'employees', record_id: emp.id, new_value: { email: emp.email, via: 'sheet' } });
        return json({ ok: true, queued: true });
      }
      if (emp.auth_user_id) {
        // Already has a login: email a link to set (or reset) their own password instead of an invitation.
        const { error } = await admin.auth.resetPasswordForEmail(emp.email, { redirectTo: body.redirect_to });
        if (error) throw new HttpError(400, error.message);
        await admin.from('audit_logs').insert({ actor_id: actor.id, action: 'password_link', table_name: 'employees', record_id: emp.id, new_value: { email: emp.email } });
        return json({ ok: true, sent: 'password_link' });
      }
      // must_change_password: the invitation link signs them in once; the portal then asks them to choose their own password
      const { data, error } = await admin.auth.admin.inviteUserByEmail(emp.email, { redirectTo: body.redirect_to, data: { must_change_password: true } });
      if (error) throw new HttpError(400, error.message);
      // the on_auth_user_created trigger links by email; make sure it is linked even for pre-existing users
      await admin.from('employees').update({ auth_user_id: data.user.id }).eq('id', emp.id).is('auth_user_id', null);
      await admin.from('audit_logs').insert({ actor_id: actor.id, action: 'invite', table_name: 'employees', record_id: emp.id, new_value: { email: emp.email } });
      return json({ ok: true });
    }
    if (body.action === 'set_password') {
      const pw = String(body.password ?? '');
      if (pw.length < 10 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) throw new HttpError(400, 'Use at least 10 characters with a letter and a number');
      if (emp.status !== 'active') throw new HttpError(400, 'Reactivate the user before setting a password');
      if (emp.id === actor.id) throw new HttpError(400, 'Change your own password from the sign-in page instead');
      if (String(emp.email).endsWith('.invalid')) throw new HttpError(400, 'Add this person’s real email address before setting a password');
      let authId: string | null = emp.auth_user_id;
      if (authId) {
        const { error } = await admin.auth.admin.updateUserById(authId, { password: pw, user_metadata: { must_change_password: true } });
        if (error) throw new HttpError(400, error.message);
      } else {
        const { data, error } = await admin.auth.admin.createUser({ email: emp.email, password: pw, email_confirm: true, user_metadata: { must_change_password: true } });
        if (error) throw new HttpError(400, error.message);
        authId = data.user.id;
        await admin.from('employees').update({ auth_user_id: authId }).eq('id', emp.id).is('auth_user_id', null);
      }
      await admin.from('audit_logs').insert({ actor_id: actor.id, action: 'set_password', table_name: 'employees', record_id: emp.id, new_value: { email: emp.email, note: 'Temporary password set by QA; must be changed at first sign-in' } });
      return json({ ok: true });
    }
    if (body.action === 'deactivate' || body.action === 'reactivate') {
      const active = body.action === 'reactivate';
      if (!active && emp.id === actor.id) throw new HttpError(400, 'You cannot deactivate your own account');
      // The database also refuses to deactivate the last active Super Admin; stop before touching the login if it does.
      const { error: upErr } = await admin.from('employees').update({ status: active ? 'active' : 'inactive' }).eq('id', emp.id);
      if (upErr) throw new HttpError(400, upErr.message);
      if (emp.auth_user_id) {
        const { error } = await admin.auth.admin.updateUserById(emp.auth_user_id, { ban_duration: active ? 'none' : '876000h' });
        if (error) throw new HttpError(400, error.message);
      }
      await admin.from('audit_logs').insert({ actor_id: actor.id, action: body.action, table_name: 'employees', record_id: emp.id,
        previous: { status: emp.status }, new_value: { status: active ? 'active' : 'inactive', email: emp.email }, reason: body.reason ?? null });
      return json({ ok: true });
    }
    throw new HttpError(400, 'Unknown action');
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return json({ error: e instanceof Error ? e.message : String(e) }, status);
  }
});
