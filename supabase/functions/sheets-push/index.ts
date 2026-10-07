// Receives audit rows pushed by a small Apps Script inside the Google Sheet
// (scripts/apps-script/push-to-portal.gs). No Google Cloud project or service
// account is needed: the script runs as the sheet owner and sends the rows here.
// Rows go through the same mapper and validated import_evaluations RPC as every
// other import, so re-sending rows is safe (duplicates are skipped).
//
// Auth: header `x-push-secret` must equal the SHEETS_PUSH_SECRET function secret.
// Body: { source: 'live' | 'archive', label?: string, header: string[], rows: string[][], first_row: number }
import { json, serviceClient, HttpError } from '../_shared/auth.ts';
import { mapAuditRows, rowsToRecords } from '../_shared/mapper.ts';

const MAX_ROWS = 3000;
const MAX_BYTES = 20 * 1024 * 1024;

/** Constant-time comparison so the secret can't be guessed from response timing. */
function sameSecret(a: string, b: string) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

Deno.serve(async (req) => {
  try {
    if (req.method !== 'POST') throw new HttpError(405, 'Use POST');
    const secret = Deno.env.get('SHEETS_PUSH_SECRET') ?? '';
    if (secret.length < 24) throw new HttpError(501, 'Sheet push is not configured: set the SHEETS_PUSH_SECRET function secret (at least 24 characters).');
    if (!sameSecret(req.headers.get('x-push-secret') ?? '', secret)) throw new HttpError(401, 'Wrong or missing push secret');
    if (Number(req.headers.get('content-length') ?? 0) > MAX_BYTES) throw new HttpError(413, 'Too much data in one request; send fewer rows at a time');

    const body = await req.json().catch(() => null) as { source?: string; label?: string; header?: unknown; rows?: unknown; first_row?: number } | null;
    if (!body || !Array.isArray(body.header) || !Array.isArray(body.rows)) throw new HttpError(400, 'Expected { header: [...], rows: [[...]] }');
    if (body.rows.length > MAX_ROWS) throw new HttpError(413, `Send at most ${MAX_ROWS} rows per request`);
    const source = body.source === 'archive' ? 'archive' : 'live';
    const label = String(body.label ?? (source === 'live' ? 'Live sheet' : 'Archive sheet')).slice(0, 120);
    const header = body.header.map((h) => String(h ?? ''));
    const rows = (body.rows as unknown[]).map((r) => (Array.isArray(r) ? r.map((v) => String(v ?? '')) : []));
    const firstRow = Number.isInteger(body.first_row) && (body.first_row as number) >= 2 ? body.first_row as number : 2;
    if (!rows.length) return json({ inserted: 0, duplicates: 0, rejected: 0, rows: 0 });

    const admin = serviceClient();
    const [{ data: taskTypes }, { data: params }] = await Promise.all([
      admin.from('task_types').select('code, source_label, feedback_column, fcr_column'),
      admin.from('evaluation_parameters').select('id, task_type, name, max_score, source_column, source_aliases, rubric_version, active'),
    ]);
    const mapped = mapAuditRows(rowsToRecords([header, ...rows]), taskTypes ?? [], (params ?? []).map((p) => ({ ...p, max_score: Number(p.max_score) })),
      { timezoneOffset: Deno.env.get('SHEET_TIMEZONE_OFFSET') ?? '+05:30', firstRowNumber: firstRow });
    if (mapped.missingColumns.length) throw new HttpError(422, `Missing columns: ${mapped.missingColumns.join(', ')}`);

    let batch_id: string | null = null;
    const totals = { inserted: 0, duplicates: mapped.duplicates.length, rejected: 0 };
    for (let i = 0; i < mapped.rows.length; i += 400) {
      type R = { batch_id: string; inserted: number; duplicates: number; rejected: number };
      const res: { data: R | null; error: { message: string } | null } = await admin.rpc('import_evaluations', { p_payload: {
        batch_id, source: 'google_sheets', file_name: `${label} (sheet push, rows ${firstRow}–${firstRow + rows.length - 1})`,
        publish_new_periods: source === 'archive' || Deno.env.get('PUBLISH_NEW_PERIODS') === 'true', rows: mapped.rows.slice(i, i + 400) } });
      if (res.error || !res.data) throw new HttpError(500, res.error?.message ?? 'Import failed');
      batch_id = res.data.batch_id;
      totals.inserted += res.data.inserted; totals.duplicates += res.data.duplicates; totals.rejected += res.data.rejected;
    }
    if (!batch_id && mapped.rejections.length) {
      // no valid rows in this request: still create a batch so the rejection reasons are visible on Data Import
      const res = await admin.rpc('import_evaluations', { p_payload: { source: 'google_sheets', file_name: `${label} (sheet push, rows ${firstRow}–${firstRow + rows.length - 1})`, rows: [] } });
      if (res.error) throw new HttpError(500, res.error.message);
      batch_id = (res.data as { batch_id: string }).batch_id;
    }
    if (batch_id && mapped.rejections.length) {
      await admin.from('import_rejections').insert(mapped.rejections.map((x) => ({ batch_id, row_number: x.row_number, reason: x.reason })));
      await admin.from('import_batches').update({ rejected: totals.rejected + mapped.rejections.length }).eq('id', batch_id);
    }
    return json({ rows: rows.length, ...totals, rejected: totals.rejected + mapped.rejections.length, batch_id });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, e instanceof HttpError ? e.status : 500);
  }
});
