// CS QA Portal — Google Workspace version (Google Apps Script web app).
//
//  * Deploy as a web app that runs as the QA owner, with access for "Anyone within <your company>".
//  * Who is signed in comes only from Google (Session.getActiveUser()); the browser can never choose it.
//  * All data lives in a private folder in the owner's Google Drive. Nobody else needs Drive access:
//    people see only what the portal's rules allow (the same rules as every other version of the portal).
//  * Emails go out from the owner's Gmail (MailApp: send-only permission).
import { DemoRepo, type OutMail, type ServerHooks } from '../src/data/demoRepo';
import { isRead, isWrite, UNDEF_MARK, type AutomationStatus } from '../src/data/googleApi';
import type { DataSource } from '../supabase/functions/_shared/rubric';
import type { WeeklyEmailResult } from '../src/lib/types';
import { settleNow } from './syncPromise';

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const DriveApp: any, Drive: any, Sheets: any, Session: any, Utilities: any, LockService: any, CacheService: any, MailApp: any,
  HtmlService: any, ScriptApp: any, SpreadsheetApp: any, PropertiesService: any;

const FOLDER_NAME = 'CS QA Portal — data (private, do not share)';
const P = { folder: 'CSQA_FOLDER', lastRun: 'CSQA_LAST_RUN', lastResult: 'CSQA_LAST_RESULT' };
const CHUNK = 90 * 1024;          // CacheService values must stay under 100 KB
const CACHE_SECONDS = 6 * 60 * 60;
const JOB = 'scheduledJobs';
const JOB_MINUTES = 30;

const props = () => PropertiesService.getScriptProperties();
const ownerEmail = () => String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
const activeEmail = () => String(Session.getActiveUser().getEmail() || '').toLowerCase();
const domainOf = (e: string) => e.split('@')[1] ?? '';

// ------------------------------------------------------------------ Drive storage
function dataFolder() {
  const id = props().getProperty(P.folder);
  if (id) { try { const f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch { /* recreate */ } }
  const f = DriveApp.createFolder(FOLDER_NAME);
  f.setDescription('Data for the CS QA Portal web app. Keep this folder private — access to QA data is controlled by the portal, not by Drive sharing.');
  props().setProperty(P.folder, f.getId());
  return f;
}
function subFolder(name: string) {
  const parent = dataFolder();
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

// Storage: one small "core" file (people, teams, settings, weeks, appeals, logs…) plus one file of
// audits per year ("evals-2026", …). Pages load only the years they show; every change loads
// everything, so a partly loaded state can never be saved.
const PARTS = 'CSQA_PARTS';
const fileKey = (part: string) => `CSQA_FILE_${part}`;
const verKey = (part: string) => `CSQA_V_${part}`;
const listParts = (): string[] => { try { return JSON.parse(props().getProperty(PARTS) || '[]'); } catch { return []; } };

interface Store { texts: Record<string, string | null>; full: boolean }

function readPart(part: string): string | null {
  const version = props().getProperty(verKey(part));
  const fileId = props().getProperty(fileKey(part));
  if (!fileId || !version) return null;
  const cache = CacheService.getScriptCache();
  try {
    const n = Number(cache.get(`${part}:${version}:n`) || 0);
    if (n > 0) {
      const keys = Array.from({ length: n }, (_, i) => `${part}:${version}:${i}`);
      const got = cache.getAll(keys);
      if (keys.every((k) => got[k])) return ungzip(keys.map((k) => got[k]).join(''));
    }
  } catch { /* fall back to Drive */ }
  const b64 = Utilities.base64Encode(DriveApp.getFileById(fileId).getBlob().getBytes());
  putCache(part, version, b64);
  return ungzip(b64);
}
function putCache(part: string, version: string, b64: string) {
  try {
    const n = Math.ceil(b64.length / CHUNK);
    const vals: Record<string, string> = { [`${part}:${version}:n`]: String(n) };
    for (let i = 0; i < n; i++) vals[`${part}:${version}:${i}`] = b64.slice(i * CHUNK, (i + 1) * CHUNK);
    CacheService.getScriptCache().putAll(vals, CACHE_SECONDS);
  } catch { /* cache is only a speed-up */ }
}
function ungzip(b64: string): string {
  return Utilities.ungzip(Utilities.newBlob(Utilities.base64Decode(b64), 'application/x-gzip')).getDataAsString('UTF-8');
}
function writePart(part: string, text: string) {
  const blob = Utilities.gzip(Utilities.newBlob(text, 'application/json', `${part}.json`), `portal-${part}.json.gz`);
  const fileId = props().getProperty(fileKey(part));
  let id = fileId;
  if (fileId) { try { Drive.Files.update({}, fileId, blob); } catch { id = null; } }
  if (!id) {
    const f = dataFolder().createFile(blob);
    f.setName(`portal-${part}.json.gz`);
    if (fileId) { try { DriveApp.getFileById(fileId).setTrashed(true); } catch { /* ignore */ } }
    id = f.getId();
    props().setProperty(fileKey(part), id);
  }
  const version = String(Date.now());
  props().setProperty(verKey(part), version);
  putCache(part, version, Utilities.base64Encode(blob.getBytes()));
}
function dropPart(part: string) {
  const id = props().getProperty(fileKey(part));
  if (id) { try { DriveApp.getFileById(id).setTrashed(true); } catch { /* ignore */ } }
  props().deleteProperty(fileKey(part)); props().deleteProperty(verKey(part));
}

type Call = { m: string; a: unknown[] };
const NO_EVALS = new Set(['whoami', 'currentUser', 'getSettings', 'getTaskTypes', 'getParameters', 'getPeriods', 'getTeams', 'getEmployees',
  'listNotifications', 'listImportBatches', 'listImportRejections', 'listAuditLogs', 'automationStatus', 'syncProgress', 'evidenceUrl']);
const evalYear = (id: unknown) => /^(\d{4})-/.exec(String(id))?.[1] ?? null;
const yearOf = (id: string) => evalYear(id) ?? 'other';

/** Which years of audits these (read-only) calls need, or 'all'. */
function yearsFor(calls: Call[], core: { periods: { id: string; start_date: string }[]; appeals: { evaluation_id: string }[] }): 'all' | Set<string> {
  if (calls.some((c) => isWrite(c.m))) return 'all';
  const ys = new Set<string>();
  const periodYear = (pid: unknown) => core.periods.find((x) => x.id === pid)?.start_date.slice(0, 4) ?? null;
  for (const c of calls) {
    if (NO_EVALS.has(c.m)) continue;
    const a = Array.isArray(c.a) ? c.a : [];
    if (c.m === 'getEvaluations') {
      const ids = (a[0] as { periodIds?: unknown } | undefined)?.periodIds;
      if (!Array.isArray(ids)) return 'all';
      ids.forEach((pid) => { const y = periodYear(pid); if (y) ys.add(y); });
    } else if (c.m === 'weeklyEmailPreview') {
      const y = periodYear(a[0]); if (y) ys.add(y);
    } else if (c.m === 'getEvaluation' || c.m === 'getAdjustments' || c.m === 'getAppealDeadline') {
      const y = evalYear(a[0]); if (!y) return 'all'; ys.add(y);
    } else if (c.m === 'listAppeals' || c.m === 'getAppeal') {
      for (const ap of core.appeals ?? []) { const y = evalYear(ap.evaluation_id); if (!y) return 'all'; ys.add(y); }
    } else return 'all';
  }
  return ys;
}

function loadStore(calls: Call[] | 'all'): { store: Store; state: unknown } {
  const coreText = readPart('core');
  if (!coreText) return { store: { texts: {}, full: true }, state: null };
  const core = JSON.parse(coreText);
  const years = calls === 'all' ? 'all' : yearsFor(calls, core);
  const texts: Record<string, string | null> = { core: coreText };
  let evaluations: unknown[] = [];
  for (const part of listParts()) {
    if (part === 'core' || (years !== 'all' && !years.has(part.slice(6)))) continue;
    const t = readPart(part); texts[part] = t;
    if (t) evaluations = evaluations.concat(JSON.parse(t));
  }
  return { store: { texts, full: years === 'all' }, state: { ...core, evaluations } };
}
function saveStore(store: Store, state: Record<string, unknown>) {
  if (!store.full) throw new Error('Internal error: refusing to save a partly loaded state');
  const { evaluations, ...rest } = state as { evaluations: { id: string }[] };
  const groups: Record<string, unknown[]> = {};
  for (const e of evaluations ?? []) (groups[`evals-${yearOf(e.id)}`] ??= []).push(e);
  const names = Object.keys(groups).sort();
  for (const n of names) { const t = JSON.stringify(groups[n]); if (t !== store.texts[n]) { writePart(n, t); store.texts[n] = t; } }
  for (const old of listParts()) if (old !== 'core' && !names.includes(old)) { dropPart(old); delete store.texts[old]; }
  const coreText = JSON.stringify(rest);
  if (coreText !== store.texts.core) { writePart('core', coreText); store.texts.core = coreText; }
  props().setProperty(PARTS, JSON.stringify(['core', ...names]));
}

// ------------------------------------------------------------------ progress + timing (shown on the page and in Executions)
const PROGRESS = 'csqa-progress';
const started = Date.now();
function progress(msg: string) {
  console.log(`[${((Date.now() - started) / 1000).toFixed(1)} s] ${msg}`);
  try { CacheService.getScriptCache().put(PROGRESS, JSON.stringify({ at: new Date().toISOString(), msg }), 900); } catch { /* optional */ }
}
function readProgress(): { at: string; msg: string } | null {
  try { const v = CacheService.getScriptCache().get(PROGRESS); return v ? JSON.parse(v) : null; } catch { return null; }
}

/** Fast path: the Sheets API (one request for the whole tab). Falls back to SpreadsheetApp. */
function readWithSheetsApi(src: DataSource): { title: string; values: string[][] } | null {
  if (typeof Sheets === 'undefined' || !Sheets?.Spreadsheets?.Values) return null;
  let title = src.tab ?? '';
  if (src.gid) {
    const meta = Sheets.Spreadsheets.get(src.sheet_id, { fields: 'sheets.properties(sheetId,title)' });
    const tab = (meta.sheets ?? []).find((s: any) => String(s.properties.sheetId) === String(src.gid));
    if (!tab) throw new Error(`Tab gid ${src.gid} not found in ${src.label}`);
    title = tab.properties.title;
  }
  const res = Sheets.Spreadsheets.Values.get(src.sheet_id, `'${title.replace(/'/g, "''")}'`, { valueRenderOption: 'FORMATTED_VALUE' });
  const rows = (res.values ?? []) as unknown[][];
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  // the API leaves out empty cells at the end of a row; pad so columns line up like the sheet
  return { title, values: rows.map((r) => { const o = r.map((c) => (c == null ? '' : String(c))); while (o.length < width) o.push(''); return o; }) };
}

// ------------------------------------------------------------------ hooks the portal logic uses
function hooks(): ServerHooks {
  return {
    portalUrl: ScriptApp.getService().getUrl() || '',
    progress,
    readSheet(src: DataSource) {
      try {
        const fast = readWithSheetsApi(src);
        if (fast) { progress(`Read ${fast.values.length.toLocaleString('en-US')} rows from “${fast.title}”`); return fast; }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/not found in/.test(msg)) throw e;
        if (/permission|403|not have access|caller does not/i.test(msg)) throw new Error(`The portal owner's Google account cannot open “${src.label}”. Share it with ${ownerEmail()} (Viewer is enough).`);
        console.log('Sheets API read failed, using SpreadsheetApp: ' + msg);
      }
      let ss;
      try { ss = SpreadsheetApp.openById(src.sheet_id); }
      catch { throw new Error(`The portal owner's Google account cannot open “${src.label}”. Share it with ${ownerEmail()} (Viewer is enough).`); }
      const sheet = src.gid ? ss.getSheets().find((s: any) => String(s.getSheetId()) === String(src.gid)) : ss.getSheetByName(src.tab);
      if (!sheet) throw new Error(src.gid ? `Tab gid ${src.gid} not found in ${src.label}` : `Tab “${src.tab}” not found in ${src.label}`);
      const values = sheet.getDataRange().getDisplayValues() as string[][];
      progress(`Read ${values.length.toLocaleString('en-US')} rows from “${sheet.getName()}”`);
      return { title: sheet.getName(), values };
    },
    putFile(name, mime, base64) {
      const f = subFolder('Appeal evidence').createFile(Utilities.newBlob(Utilities.base64Decode(base64), mime, name));
      return f.getId();
    },
    getFile(id) { return Utilities.base64Encode(DriveApp.getFileById(id).getBlob().getBytes()); },
  };
}
function openRepo(state: unknown) {
  const repo = new DemoRepo('google', state);
  repo.server = hooks();
  const s = repo.serverState();
  // links in emails point at this web app
  if (!s.settings.notifications.portal_url) s.settings.notifications.portal_url = repo.server.portalUrl;
  return repo;
}

// ------------------------------------------------------------------ email
function sendOutbox(repo: DemoRepo): { sent: number; failed: { to: string; error: string }[] } {
  const out = { sent: 0, failed: [] as { to: string; error: string }[] };
  const mails: OutMail[] = repo.serverOutbox.splice(0);
  let left = 0; try { left = MailApp.getRemainingDailyQuota(); } catch { left = mails.length; }
  for (const m of mails) {
    const recipients = 1 + (m.cc ? m.cc.split(',').filter((x) => x.trim()).length : 0);
    try {
      if (left < recipients) throw new Error('Daily Gmail sending limit reached — try again tomorrow');
      MailApp.sendEmail({ to: m.to, cc: m.cc || undefined, replyTo: m.reply_to || undefined, name: m.sender_name, subject: m.subject, htmlBody: m.html });
      left -= recipients; out.sent++;
      repo.serverMailResult(m.id, true);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      out.failed.push({ to: m.to, error });
      repo.serverMailResult(m.id, false, error);
    }
  }
  return out;
}

// ------------------------------------------------------------------ automation (scheduled jobs)
function automationStatus(): AutomationStatus {
  const installed = ScriptApp.getProjectTriggers().some((t: any) => t.getHandlerFunction() === JOB);
  return { installed, every_minutes: JOB_MINUTES, last_run: props().getProperty(P.lastRun), last_result: props().getProperty(P.lastResult) };
}
function installAutomation(): AutomationStatus {
  ScriptApp.getProjectTriggers().filter((t: any) => t.getHandlerFunction() === JOB).forEach((t: any) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger(JOB).timeBased().everyMinutes(JOB_MINUTES).create();
  return automationStatus();
}
/** Every 30 minutes: re-read the live sheet, publish due weeks (if auto-publish is on), remind about overdue appeals. */
function runJobs(repo: DemoRepo): string {
  const parts: string[] = [];
  const live = settleNow(repo.syncGoogleSheet('live')) as { title?: string; inserted?: number; error?: string }[];
  for (const r of live) parts.push(r.error ? `Sync error: ${r.error}` : `${r.inserted ?? 0} new audit(s) from ${r.title}`);
  const tz = repo.serverState().settings.reporting.timezone || 'Asia/Kolkata';
  const res = settleNow(repo.serverScheduledJobs(Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm'))) as { published: string[]; reminders: number };
  if (res.published.length) parts.push(`published ${res.published.join(', ')}`);
  if (res.reminders) parts.push(`${res.reminders} overdue reminder(s)`);
  return parts.join('; ') || 'nothing to do';
}

export function scheduledJobs() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(60_000)) return;
  try {
    const { store, state } = loadStore('all');
    if (!state) return;
    const repo = openRepo(state);
    const me = repo.serverActAs(ownerEmail());
    if (!me || me.role !== 'super_admin') { props().setProperty(P.lastResult, 'Skipped: the portal owner is not an active Super Admin'); return; }
    let result: string;
    try { result = runJobs(repo); } catch (e) { result = `Error: ${e instanceof Error ? e.message : String(e)}`; }
    if (repo.serverDirty) saveStore(store, repo.serverState() as unknown as Record<string, unknown>);
    if (repo.serverOutbox.length) { const m = sendOutbox(repo); if (m.sent || m.failed.length) result += `; ${m.sent} email(s) sent${m.failed.length ? `, ${m.failed.length} failed` : ''}`; saveStore(store, repo.serverState() as unknown as Record<string, unknown>); }
    props().setProperty(P.lastRun, new Date().toISOString());
    props().setProperty(P.lastResult, result.slice(0, 500));
  } finally { lock.releaseLock(); }
}

/** Run once from the Apps Script editor if the web app says "Authorization is required". */
export function authorize() {
  dataFolder(); ScriptApp.getProjectTriggers(); MailApp.getRemainingDailyQuota(); CacheService.getScriptCache().get('x');
  try { SpreadsheetApp.openById(String(import.meta.env.VITE_LIVE_SHEET_ID ?? '')); } catch { /* only needed for the permission prompt */ }
  return 'Authorized. Open the portal link again.';
}

// ------------------------------------------------------------------ web app
export function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('CS QA Portal')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

type Result = { ok: true; v: unknown } | { ok: false; e: string };
const MAX_CALLS = 40;

/** First visit by the owner: create the data files and make the owner the first Super Admin. */
function bootstrapIfNeeded(email: string) {
  if (props().getProperty(verKey('core')) || email !== ownerEmail()) return;
  const lock = LockService.getScriptLock();
  lock.waitLock(30_000);
  try {
    const { store, state } = loadStore('all');
    const repo = openRepo(state);
    if (repo.serverBootstrapOwner(email) || !store.texts.core) saveStore(store, repo.serverState() as unknown as Record<string, unknown>);
  } finally { lock.releaseLock(); }
}

/** The single entry point the browser calls (google.script.run.api). */
export function api(payload: string): string {
  const req = JSON.parse(String(payload)) as { calls?: { m: string; a: unknown[] }[] };
  const calls = Array.isArray(req.calls) ? req.calls.slice(0, MAX_CALLS) : [];
  const email = activeEmail();
  const owner = ownerEmail();
  // Only people in the owner's Google Workspace domain (the deployment setting enforces this too).
  const allowedIdentity = !!email && domainOf(email) === domainOf(owner);
  if (allowedIdentity) bootstrapIfNeeded(email);

  const writes = calls.filter((c) => isWrite(c.m));
  if (writes.length > 1 || (writes.length === 1 && calls.length > 1)) throw new Error('Each change must be sent on its own');
  const lock = writes.length ? LockService.getScriptLock() : null;
  if (lock && !lock.tryLock(30_000)) throw new Error('The portal is busy with another change. Please try again in a moment.');
  try {
    const { store, state } = loadStore(calls);
    const repo = openRepo(state);
    const me = allowedIdentity ? repo.serverActAs(email) : null;
    const results: Result[] = calls.map((c): Result => {
      try {
        if (c.m === 'whoami') return { ok: true, v: { email: email || null, owner: !!email && email === owner, me: me ? settleNow(repo.currentUser()) : null } };
        if (!isRead(c.m) && !isWrite(c.m)) throw new Error('Unknown action');
        if (!me) throw new Error('Not authorised: your Google account has no access to the CS QA Portal');
        if (c.m === 'automationStatus' || c.m === 'installAutomation' || c.m === 'runScheduledJobsNow' || c.m === 'syncProgress') {
          if (me.role !== 'super_admin') throw new Error('Only QA Super Admins can do this');
          if (c.m === 'syncProgress') return { ok: true, v: readProgress() };
          if (c.m === 'automationStatus') return { ok: true, v: automationStatus() };
          if (c.m === 'installAutomation') return { ok: true, v: installAutomation() };
          const r = runJobs(repo); props().setProperty(P.lastRun, new Date().toISOString()); props().setProperty(P.lastResult, r.slice(0, 500));
          return { ok: true, v: r };
        }
        const fn = (repo as unknown as Record<string, unknown>)[c.m];
        if (typeof fn !== 'function') throw new Error('Unknown action');
        const args = (Array.isArray(c.a) ? c.a : []).map((x) => (x === UNDEF_MARK ? undefined : x));
        return { ok: true, v: settleNow((fn as (...a: unknown[]) => unknown).apply(repo, args)) ?? null };
      } catch (e) {
        return { ok: false, e: e instanceof Error ? e.message : String(e) };
      }
    });
    // Save only when the one change in this request succeeded. A failed change leaves nothing behind.
    if (writes.length && results[0].ok && repo.serverDirty) {
      if (writes[0].m === 'syncGoogleSheet' || writes[0].m === 'importEvaluations') progress('Saving to your Drive…');
      saveStore(store, repo.serverState() as unknown as Record<string, unknown>);
      if (writes[0].m === 'syncGoogleSheet') progress('Done');
      if (repo.serverOutbox.length) {
        const m = sendOutbox(repo);
        saveStore(store, repo.serverState() as unknown as Record<string, unknown>);
        if (writes[0].m === 'sendWeeklyEmails' && results[0].ok) {
          const v = results[0].v as WeeklyEmailResult;
          results[0] = { ok: true, v: { ...v, sent: m.sent, failed: m.failed.length, failures: m.failed } };
        }
      }
    }
    return encode({ r: results });
  } finally { lock?.releaseLock(); }
}

/** Big answers (dashboards over many weeks) are gzipped to keep the transfer fast. */
function encode(obj: unknown): string {
  const text = JSON.stringify(obj);
  if (text.length < 150_000) return text;
  const gz = Utilities.gzip(Utilities.newBlob(text, 'application/json'));
  return 'z:' + Utilities.base64Encode(gz.getBytes());
}
