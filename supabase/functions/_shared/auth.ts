// Shared helpers for Edge Functions (Deno). The service-role key is only ever
// available here, server-side, via Supabase-provided environment variables.
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

export const cors = {
  'Access-Control-Allow-Origin': Deno.env.get('ALLOWED_ORIGIN') ?? '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } });

export function serviceClient(): SupabaseClient {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
}

/** Returns the calling employee if the request carries a valid JWT of an active Super Admin. */
export async function requireSuperAdmin(req: Request, admin: SupabaseClient) {
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) throw new HttpError(401, 'Missing authorization');
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, 'Invalid session');
  const { data: emp } = await admin.from('employees').select('id, role, status, email').eq('auth_user_id', data.user.id).maybeSingle();
  if (!emp || emp.status !== 'active' || emp.role !== 'super_admin') throw new HttpError(403, 'Only QA Super Admins can do this');
  return emp as { id: string; role: string; status: string; email: string };
}

/** Allows scheduled invocations that present the shared CRON_SECRET header. */
export function isCron(req: Request) {
  const s = Deno.env.get('CRON_SECRET');
  return !!s && req.headers.get('x-cron-secret') === s;
}

export class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }
