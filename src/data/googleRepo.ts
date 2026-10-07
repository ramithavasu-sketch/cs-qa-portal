// Google Workspace version: the portal is an Apps Script web app. Every data call goes to the
// server function `api` (server/main.ts), which checks who is signed in with Google and applies
// the same access rules and workflow checks as the other versions. Nothing is decided here.
import type { Repo } from './repo';
import type { Me } from '../lib/types';
import { isWrite, UNDEF_MARK } from './googleApi';

interface GoogleRun {
  withSuccessHandler(cb: (v: string) => void): GoogleRun;
  withFailureHandler(cb: (e: Error | string) => void): GoogleRun;
  api(payload: string): void;
}
interface GoogleScript { run: GoogleRun; url: { getLocation(cb: (l: { parameter: Record<string, string>; hash: string }) => void): void } }
/** google.script (only present when the page is served by the Apps Script web app). */
const gscript = () => (window as unknown as { google?: { script?: GoogleScript } }).google?.script;

interface Pending { m: string; a: unknown[]; resolve: (v: unknown) => void; reject: (e: unknown) => void }
let queue: Pending[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

/** Who Google says is signed in (set by currentUser). Shown on the "no access" screen. */
export const googleIdentity: { email: string | null; owner: boolean; error: string | null } = { email: null, owner: false, error: null };

async function gunzipBase64(b64: string): Promise<string> {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return await new Response(stream).text();
}
function friendly(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  if (/authorization is required|permission|not have permission/i.test(msg)) return 'Google needs you to sign in again. Reload the page.';
  if (/timed out|exceeded maximum execution time/i.test(msg)) return 'That took too long for Google (6-minute limit). Try again, or sync one sheet at a time.';
  if (/network|failed to fetch|NetworkError/i.test(msg)) return 'Could not reach Google. Check your connection and try again.';
  return msg;
}

function flush() {
  const batch = queue; queue = []; timer = null;
  const run = gscript()?.run;
  if (!run) { batch.forEach((c) => c.reject(new Error('This page must be opened from the CS QA Portal web app link.'))); return; }
  // Never wait forever: Google stops any run after 6 minutes, so no answer by then means it was lost.
  let settled = false;
  const write = batch.some((c) => isWrite(c.m));
  const watchdog = setTimeout(() => {
    if (settled) return; settled = true;
    batch.forEach((c) => c.reject(new Error(write
      ? 'Google didn’t answer within 7 minutes, so this was stopped. Reload the page and check whether the change was saved. For a sheet sync, check Data Import (the Last sync column) — if it keeps happening, open the Apps Script project → Executions to see the reason.'
      : 'Google didn’t answer in time. Reload the page to try again.')));
  }, write ? 7 * 60_000 : 3 * 60_000);
  const done = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(watchdog); fn(); };
  run
    .withSuccessHandler((raw: string) => {
      (async () => {
        const text = typeof raw === 'string' && raw.startsWith('z:') ? await gunzipBase64(raw.slice(2)) : String(raw);
        const res = JSON.parse(text) as { r: ({ ok: true; v: unknown } | { ok: false; e: string })[] };
        done(() => batch.forEach((c, i) => { const r = res.r[i]; if (r?.ok) c.resolve(r.v); else c.reject(new Error(r ? r.e : 'No response from the server')); }));
      })().catch((e) => done(() => batch.forEach((c) => c.reject(new Error(friendly(e))))));
    })
    .withFailureHandler((e) => done(() => batch.forEach((c) => c.reject(new Error(friendly(e))))))
    .api(JSON.stringify({ calls: batch.map((c) => ({ m: c.m, a: c.a })) }));
}

/** Queues a server call; calls made in the same moment go to Google as one request. */
export function callServer<T>(m: string, args: unknown[]): Promise<T> {
  const a = args.filter((x) => typeof x !== 'function');
  while (a.length && a[a.length - 1] === undefined) a.pop();
  return new Promise<T>((resolve, reject) => {
    const item = { m, a: a.map((x) => (x === undefined ? UNDEF_MARK : x)), resolve: resolve as (v: unknown) => void, reject };
    if (isWrite(m)) {
      // a change always travels alone, after any reads already waiting
      if (timer) { clearTimeout(timer); flush(); }
      queue.push(item); flush();
      return;
    }
    queue.push(item);
    if (!timer) timer = setTimeout(flush, 0);
  });
}

const notHere = (what: string) => () => Promise.reject(new Error(`${what} isn't used in the Google version — everyone signs in with their company Google account.`));

function readBase64(file: File): Promise<string> {
  return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1] ?? ''); fr.onerror = () => rej(fr.error); fr.readAsDataURL(file); });
}

const local: Partial<Repo> & { mode: 'google' } = {
  mode: 'google',
  async currentUser() {
    try {
      const r = await callServer<{ email: string | null; owner: boolean; me: Me | null }>('whoami', []);
      googleIdentity.email = r.email; googleIdentity.owner = r.owner; googleIdentity.error = null;
      return r.me;
    } catch (e) { googleIdentity.error = e instanceof Error ? e.message : String(e); throw e; }
  },
  signIn: notHere('Password sign-in'),
  async signOut() { /* Google manages the session; the page just goes back to the start */ },
  requestPasswordReset: notHere('Password reset'),
  updatePassword: notHere('Changing a password'),
  setUserPassword: notHere('Setting a password'),
  onAuthEvent() { return () => {}; },
  async uploadEvidence(appealId: string, file: File) {
    if (file.size > 5 * 1024 * 1024) throw new Error('Files must be 5 MB or smaller');
    await callServer('uploadEvidenceData', [appealId, { name: file.name, type: file.type, size: file.size, base64: await readBase64(file) }]);
  },
  // Large uploads are split so each request stays well inside Google's limits.
  async importEvaluations(rows, meta, onProgress) {
    const size = 1500;
    const total = { batch_id: '', total: 0, inserted: 0, duplicates: 0, rejected: 0 };
    for (let i = 0; i < rows.length; i += size) {
      const r = await callServer<typeof total>('importEvaluations', [rows.slice(i, i + size), meta]);
      total.batch_id ||= r.batch_id; total.total += r.total; total.inserted += r.inserted; total.duplicates += r.duplicates; total.rejected += r.rejected;
      onProgress?.(Math.min(rows.length, i + size), rows.length);
    }
    return total;
  },
};

export function createGoogleRepo(): Repo {
  return new Proxy(local, {
    get(t, k) {
      if (k in t) return (t as Record<string | symbol, unknown>)[k];
      if (typeof k !== 'string' || k === 'then' || k === 'toJSON') return undefined;
      return (...args: unknown[]) => callServer(k, args);
    },
  }) as unknown as Repo;
}

/** Deep links from emails arrive as …/exec?p=/appeals/123 — open that page. */
export function applyGoogleDeepLink(): Promise<void> {
  return new Promise((res) => {
    const url = gscript()?.url;
    if (!url) return res();
    url.getLocation((l) => { const p = l.parameter?.p; if (p && p.startsWith('/')) window.location.hash = '#' + p; res(); });
  });
}
