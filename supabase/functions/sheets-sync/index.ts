// Pulls the QA audit responses sheet with a Google service account (read-only scope),
// maps rows with the same mapper the browser uses, and imports them through the
// validated import_evaluations RPC. Safe to run repeatedly: duplicates are skipped.
// Invoke: by a Super Admin from the Data Import page, or on a schedule with x-cron-secret.
import { cors, json, serviceClient, requireSuperAdmin, isCron, HttpError } from '../_shared/auth.ts';
import { mapAuditRows } from '../_shared/mapper.ts';

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const admin = serviceClient();
    if (!isCron(req)) await requireSuperAdmin(req, admin);
    const saJson = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_JSON');
    const sheetId = Deno.env.get('GOOGLE_SHEET_ID');
    if (!saJson || !sheetId) throw new HttpError(501, 'Google Sheets sync is not configured: set GOOGLE_SERVICE_ACCOUNT_JSON and GOOGLE_SHEET_ID secrets and share the sheet with the service account (Viewer).');
    const token = await googleAccessToken(JSON.parse(saJson));
    // The tab is identified by its gid (the number after #gid= in the sheet URL) or by name.
    let range = Deno.env.get('GOOGLE_SHEET_RANGE') ?? '';
    const gid = Deno.env.get('GOOGLE_SHEET_GID');
    if (gid) {
      const meta = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties(sheetId,title)`, { headers: { authorization: `Bearer ${token}` } });
      if (!meta.ok) throw new HttpError(502, `Sheets API error: ${await meta.text()}`);
      const tab = ((await meta.json()).sheets ?? []).find((x: { properties: { sheetId: number } }) => String(x.properties.sheetId) === gid);
      if (!tab) throw new HttpError(404, `No tab with gid ${gid} in this spreadsheet`);
      range = tab.properties.title;
    }
    if (!range) range = 'Form Responses 1';
    const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}?valueRenderOption=FORMATTED_VALUE`,
      { headers: { authorization: `Bearer ${token}` } });
    if (!r.ok) throw new HttpError(502, `Sheets API error: ${await r.text()}`);
    const values: string[][] = (await r.json()).values ?? [];
    const [header, ...body] = values;
    const records = body.map((row) => Object.fromEntries(header.map((h, i) => [h, row[i] ?? ''])));

    const [{ data: taskTypes }, { data: params }] = await Promise.all([
      admin.from('task_types').select('code, source_label, feedback_column, fcr_column'),
      admin.from('evaluation_parameters').select('id, task_type, name, max_score, source_column, active'),
    ]);
    const mapped = mapAuditRows(records, taskTypes ?? [], (params ?? []).map((p) => ({ ...p, max_score: Number(p.max_score) })),
      { timezoneOffset: Deno.env.get('SHEET_TIMEZONE_OFFSET') ?? '+05:30' });
    if (mapped.missingColumns.length) throw new HttpError(422, `Sheet is missing columns: ${mapped.missingColumns.join(', ')}`);

    let batch_id: string | null = null;
    const totals = { total: 0, inserted: 0, duplicates: mapped.duplicates.length, rejected: 0 };
    for (let i = 0; i < mapped.rows.length; i += 400) {
      type R = { batch_id: string; total: number; inserted: number; duplicates: number; rejected: number };
      const res: { data: R | null; error: { message: string } | null } = await admin.rpc('import_evaluations', { p_payload: {
        batch_id, source: 'google_sheets', file_name: `Sheet ${sheetId} / ${range}`,
        publish_new_periods: Deno.env.get('PUBLISH_NEW_PERIODS') === 'true', rows: mapped.rows.slice(i, i + 400) } });
      if (res.error || !res.data) throw new HttpError(500, res.error?.message ?? 'Import failed');
      const data = res.data;
      batch_id = data.batch_id;
      totals.total += data.total; totals.inserted += data.inserted; totals.duplicates += data.duplicates; totals.rejected += data.rejected;
    }
    // client-side (mapper) rejections are recorded against the same batch for the validation report
    if (batch_id && mapped.rejections.length) {
      await admin.from('import_rejections').insert(mapped.rejections.map((x) => ({ batch_id, row_number: x.row_number, reason: x.reason })));
      await admin.from('import_batches').update({ rejected: totals.rejected + mapped.rejections.length, total_rows: totals.total + mapped.rejections.length }).eq('id', batch_id);
    }
    return json({ batch_id, ...totals, rejected: totals.rejected + mapped.rejections.length, total: totals.total + mapped.rejections.length });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, e instanceof HttpError ? e.status : 500);
  }
});
