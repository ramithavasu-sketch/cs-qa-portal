// POST { action: 'invite', employee_id, redirect_to }       -> sends a Supabase Auth invitation
// POST { action: 'deactivate' | 'reactivate', employee_id } -> blocks/unblocks the login and revokes sessions
import { cors, json, serviceClient, requireSuperAdmin, HttpError } from '../_shared/auth.ts';

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
      const { data, error } = await admin.auth.admin.inviteUserByEmail(emp.email, { redirectTo: body.redirect_to });
      if (error) throw new HttpError(400, error.message);
      // the on_auth_user_created trigger links by email; make sure it is linked even for pre-existing users
      await admin.from('employees').update({ auth_user_id: data.user.id }).eq('id', emp.id).is('auth_user_id', null);
      await admin.from('audit_logs').insert({ actor_id: actor.id, action: 'invite', table_name: 'employees', record_id: emp.id, new_value: { email: emp.email } });
      return json({ ok: true });
    }
    if (body.action === 'deactivate' || body.action === 'reactivate') {
      const active = body.action === 'reactivate';
      await admin.from('employees').update({ status: active ? 'active' : 'inactive' }).eq('id', emp.id);
      if (emp.auth_user_id) {
        await admin.auth.admin.updateUserById(emp.auth_user_id, { ban_duration: active ? 'none' : '876000h' });
      }
      await admin.from('audit_logs').insert({ actor_id: actor.id, action: body.action, table_name: 'employees', record_id: emp.id });
      return json({ ok: true });
    }
    throw new HttpError(400, 'Unknown action');
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return json({ error: e instanceof Error ? e.message : String(e) }, status);
  }
});
