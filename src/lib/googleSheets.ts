// Direct Google Sheets connection from the browser (local review mode).
// Uses Google Identity Services with the *viewer's own* Google account and the read-only
// Sheets scope, so it can read exactly the sheets that person can already open.
// Needs VITE_GOOGLE_CLIENT_ID (an OAuth "Web application" client with
// http://localhost:5173 as an authorised JavaScript origin).
import { mapAuditRows, rowsToRecords, type ImportRow, type MapperParameter, type MapperTaskType } from '../../supabase/functions/_shared/mapper';
import type { DataSource } from '../../supabase/functions/_shared/rubric';

declare global {
  interface Window {
    google?: { accounts: { oauth2: { initTokenClient(cfg: { client_id: string; scope: string; callback: (r: { access_token?: string; expires_in?: number; error?: string }) => void; error_callback?: (e: { type: string }) => void }): { requestAccessToken(o?: { prompt?: string }): void } } } };
  }
}

export const GOOGLE_CLIENT_ID = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) ?? '';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
let token: { value: string; expires: number } | null = null;

function loadGis(): Promise<void> {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
    s.onload = () => res(); s.onerror = () => rej(new Error('Could not load Google sign-in. Check your internet connection.'));
    document.head.appendChild(s);
  });
}

export const hasGoogleToken = () => !!token && token.expires > Date.now() + 60_000;

/** interactive=false tries a silent refresh (works after the first consent while the Google session lasts). */
export async function getGoogleToken(interactive: boolean): Promise<string> {
  if (hasGoogleToken()) return token!.value;
  if (!GOOGLE_CLIENT_ID) throw new Error('Google connection is not set up: add VITE_GOOGLE_CLIENT_ID to the .env file (see README “Connect Google Sheets directly”).');
  await loadGis();
  return new Promise((res, rej) => {
    const client = window.google!.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID, scope: SCOPE,
      callback: (r) => {
        if (!r.access_token) return rej(new Error(r.error === 'access_denied' ? 'Google access was not allowed.' : `Google sign-in failed (${r.error ?? 'unknown'})`));
        token = { value: r.access_token, expires: Date.now() + (r.expires_in ?? 3600) * 1000 };
        res(r.access_token);
      },
      error_callback: (e) => rej(new Error(e.type === 'popup_closed' ? 'The Google sign-in window was closed.' : e.type === 'popup_failed_to_open' ? 'Your browser blocked the Google sign-in pop-up. Allow pop-ups for localhost and try again.' : `Google sign-in failed (${e.type})`)),
    });
    client.requestAccessToken({ prompt: interactive ? '' : 'none' });
  });
}

async function gfetch(url: string, tok: string) {
  const r = await fetch(url, { headers: { authorization: `Bearer ${tok}` } });
  if (r.status === 401) { token = null; throw new Error('Your Google session expired. Click “Connect Google” again.'); }
  if (r.status === 403) throw new Error('Your Google account cannot open this sheet (or the Sheets API is not enabled for the OAuth client).');
  if (!r.ok) throw new Error(`Google Sheets error ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

/** Reads one tab (by gid or by name) as records keyed by header. */
export async function readTab(src: DataSource, tok: string): Promise<{ title: string; records: Record<string, string>[] }> {
  let title = src.tab ?? '';
  if (src.gid) {
    const meta = await gfetch(`https://sheets.googleapis.com/v4/spreadsheets/${src.sheet_id}?fields=sheets.properties(sheetId,title)`, tok);
    const tab = (meta.sheets ?? []).find((x: { properties: { sheetId: number } }) => String(x.properties.sheetId) === src.gid);
    if (!tab) throw new Error(`Tab gid ${src.gid} not found in ${src.label}`);
    title = tab.properties.title;
  }
  const data = await gfetch(`https://sheets.googleapis.com/v4/spreadsheets/${src.sheet_id}/values/${encodeURIComponent(`'${title.replace(/'/g, "''")}'`)}?valueRenderOption=FORMATTED_VALUE`, tok);
  return { title, records: rowsToRecords((data.values ?? []) as string[][]) };
}

export interface SourceResult { source: DataSource; title?: string; mapped?: number; rejectedByMapper?: number; duplicatesInSheet?: number; inserted?: number; alreadyPresent?: number; rejected?: number; error?: string }

export async function syncSources(
  sources: DataSource[], taskTypes: MapperTaskType[], parameters: MapperParameter[],
  importer: (rows: ImportRow[], label: string) => Promise<{ inserted: number; duplicates: number; rejected: number }>,
  opts: { interactive: boolean; timezoneOffset?: string; onStep?: (msg: string) => void },
): Promise<SourceResult[]> {
  const tok = await getGoogleToken(opts.interactive);
  const out: SourceResult[] = [];
  for (const src of sources) {
    try {
      opts.onStep?.(`Reading ${src.label}…`);
      const { title, records } = await readTab(src, tok);
      const m = mapAuditRows(records, taskTypes, parameters, { timezoneOffset: opts.timezoneOffset });
      if (m.missingColumns.length) { out.push({ source: src, title, error: `Missing columns: ${m.missingColumns.join(', ')}` }); continue; }
      opts.onStep?.(`Importing ${m.rows.length.toLocaleString()} audits from ${title}…`);
      const r = await importer(m.rows, `${src.label}`);
      out.push({ source: src, title, mapped: m.rows.length, rejectedByMapper: m.rejections.length, duplicatesInSheet: m.duplicates.length, inserted: r.inserted, alreadyPresent: r.duplicates, rejected: r.rejected });
    } catch (e) {
      out.push({ source: src, error: e instanceof Error ? e.message : String(e) });
      if (e instanceof Error && /expired|not set up|pop-up|closed/.test(e.message)) break;
    }
  }
  return out;
}
