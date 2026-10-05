// Pulls the QA audit responses sheet with a Google service account (read-only scope),
// maps rows with the same mapper the browser uses, and imports them through the
// validated import_evaluations RPC. Safe to run repeatedly: duplicates are skipped.
// Invoke: by a Super Admin from the Data Import page, or on a schedule with x-cron-secret.
import { cors, json, serviceClient, requireSuperAdmin, isCron, HttpError } from '../_shared/auth.ts';
import { mapAuditRows, rowsToRecords } from '../_shared/mapper.ts';
import type { DataSource } from '../_shared/rubric.ts';

async function googleAccessToken(sa: { client_email: string; private_key: string }) {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
  const pem = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(pem), (c) => c.charCodeAt(0)),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned)));
  const jwt = `${unsigned}.${btoa(String.fromCharCode(...sig)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')}`;
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }) });
  if (!r.ok) throw new HttpError(502, `Google auth failed: ${await r.text()}`);
  return (await r.json()).access_token as string;
}

// Body: { scope?: 'live' | 'all' | string[] }  — 'live' (default, used by the schedule) reads the live form;
// 'all' also re-reads the archive tabs (safe to repeat: audits already present are skipped).
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const admin = serviceClient();
    if (!isCron(req)) await requireSuperAdmin(req, admin);
    const body = await req.json().catch(() => ({})) as { scope?: 'live' | 'all' | string[] };
    const saJson = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_JSON');
    if (!saJson) throw new HttpError(501, 'Google Sheets sync is not configured: set the GOOGLE_SERVICE_ACCOUNT_JSON secret and share the sheets with the service account (Viewer).');
    const token = await googleAccessToken(JSON.parse(saJson));
    const { data: cfg } = await admin.from('settings').select('value').eq('key', 'data_sources').maybeSingle();
    let sources: DataSource[] = (cfg?.value?.sources ?? []).filter((x: DataSource) => x.enabled);
    // Backwards compatible single-sheet env configuration
    if (!sources.length && Deno.env.get('GOOGLE_SHEET_ID')) {
      sources = [{ id: 'live', label: 'Live sheet', kind: 'live', sheet_id: Deno.env.get('GOOGLE_SHEET_ID')!, gid: Deno.env.get('GOOGLE_SHEET_GID') ?? undefined, tab: Deno.env.get('GOOGLE_SHEET_RANGE') ?? undefined, enabled: true }];
    }
    const scope = body.scope ?? 'live';
    sources = sources.filter((x) => Array.isArray(scope) ? scope.includes(x.id) : scope === 'all' || x.kind === 'live');
    if (!sources.length) throw new HttpError(400, 'No enabled Google Sheet sources for this sync');

    const [{ data: taskTypes }, { data: params }] = await Promise.all([
      admin.from('task_types').select('code, source_label, feedback_column, fcr_column'),
      admin.from('evaluation_parameters').select('id, task_type, name, max_score, source_column, source_aliases, rubric_version, active'),
    ]);
    const results = [];
    for (const src of sources) {
      try {
        let title = src.tab ?? '';
        if (src.gid) {
          const meta = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${src.sheet_id}?fields=sheets.properties(sheetId,title)`, { headers: { authorization: `Bearer ${token}` } });
          if (!meta.ok) throw new HttpError(502, `Sheets API error: ${await meta.text()}`);
          const tab = ((await meta.json()).sheets ?? []).find((x: { properties: { sheetId: number } }) => String(x.properties.sheetId) === src.gid);
          if (!tab) throw new HttpError(404, `No tab with gid ${src.gid}`);
          title = tab.properties.title;
        }
        const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${src.sheet_id}/values/${encodeURIComponent(`'${title.replace(/'/g, "''")}'`)}?valueRenderOption=FORMATTED_VALUE`,
          { headers: { authorization: `Bearer ${token}` } });
        if (!r.ok) throw new HttpError(502, `Sheets API error: ${await r.text()}`);
        const records = rowsToRecords((await r.json()).values ?? []);
        const mapped = mapAuditRows(records, taskTypes ?? [], (params ?? []).map((p) => ({ ...p, max_score: Number(p.max_score) })),
          { timezoneOffset: Deno.env.get('SHEET_TIMEZONE_OFFSET') ?? '+05:30' });
        if (mapped.missingColumns.length) throw new HttpError(422, `Missing columns: ${mapped.missingColumns.join(', ')}`);
        let batch_id: string | null = null;
        const totals = { inserted: 0, duplicates: mapped.duplicates.length, rejected: 0 };
        for (let i = 0; i < mapped.rows.length; i += 400) {
          type R = { batch_id: string; total: number; inserted: number; duplicates: number; rejected: number };
          const res: { data: R | null; error: { message: string } | null } = await admin.rpc('import_evaluations', { p_payload: {
            batch_id, source: 'google_sheets', file_name: `${src.label} · ${title}`,
            publish_new_periods: src.kind === 'archive' || Deno.env.get('PUBLISH_NEW_PERIODS') === 'true', rows: mapped.rows.slice(i, i + 400) } });
          if (res.error || !res.data) throw new HttpError(500, res.error?.message ?? 'Import failed');
          batch_id = res.data.batch_id;
          totals.inserted += res.data.inserted; totals.duplicates += res.data.duplicates; totals.rejected += res.data.rejected;
        }
        if (batch_id && mapped.rejections.length) {
          await admin.from('import_rejections').insert(mapped.rejections.map((x) => ({ batch_id, row_number: x.row_number, reason: x.reason })));
          await admin.from('import_batches').update({ rejected: totals.rejected + mapped.rejections.length }).eq('id', batch_id);
        }
        results.push({ source: src.id, title, batch_id, ...totals, rejected: totals.rejected + mapped.rejections.length });
      } catch (e) {
        results.push({ source: src.id, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return json({ results });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, e instanceof HttpError ? e.status : 500);
  }
});
