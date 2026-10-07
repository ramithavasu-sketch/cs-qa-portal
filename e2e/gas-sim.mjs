// A stand-in for the Google Apps Script runtime, good enough to run google/Code.js unchanged:
// Drive (files, folders, Drive.Files.update), Sheets (read from CSV exports), MailApp, Cache,
// Properties, Lock, Session (who is signed in), ScriptApp (triggers) and HtmlService.
// Browser-only globals (window, crypto, structuredClone, setTimeout, TextEncoder, URL, atob) are
// deliberately NOT provided, because Apps Script doesn't have them either.
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import Papa from 'papaparse';

class Blob {
  constructor(bytes, type = 'application/octet-stream', name = '') { this.bytes = Buffer.from(bytes); this.type = type; this.name = name; }
  getBytes() { return this.bytes; }
  getDataAsString() { return this.bytes.toString('utf8'); }
  getContentType() { return this.type; }
  getName() { return this.name; }
  setName(n) { this.name = n; return this; }
}

export function createGas({ owner, domainUsers = true, sheets = {}, cacheLimitBytes = 100 * 1024 }) {
  const files = new Map(); const folders = new Map();
  let nextId = 1; const id = (p) => `${p}${nextId++}`;
  const props = new Map(); const cache = new Map();
  const mails = []; const triggers = [];
  const stats = { driveReads: 0, driveWrites: 0, cacheHits: 0 };
  let active = owner;

  const mkFile = (blob, parent) => {
    const f = { id: id('file'), blob, trashed: false, parent, name: blob.getName() };
    const api = {
      getId: () => f.id, getName: () => f.name, setName: (n) => { f.name = n; return api; },
      getBlob: () => { stats.driveReads++; return new Blob(f.blob.bytes, f.blob.type, f.name); },
      setTrashed: (t) => { f.trashed = t; return api; }, isTrashed: () => f.trashed, _f: f,
    };
    files.set(f.id, api); return api;
  };
  const mkFolder = (name, parent = null) => {
    const d = { id: id('folder'), name, parent, trashed: false };
    const api = {
      getId: () => d.id, getName: () => d.name, isTrashed: () => d.trashed, setDescription: () => api,
      createFile: (blob) => { stats.driveWrites++; return mkFile(blob, d.id); },
      createFolder: (n) => mkFolder(n, d.id),
      getFoldersByName: (n) => { const list = [...folders.values()].filter((x) => x._d.parent === d.id && x._d.name === n); let i = 0; return { hasNext: () => i < list.length, next: () => list[i++] }; },
      _d: d,
    };
    folders.set(d.id, api); return api;
  };

  const sheetFor = (sheetId) => {
    const tabs = sheets[sheetId];
    if (!tabs) throw new Error('Exception: You do not have permission to access the requested document.');
    return {
      getSheets: () => tabs.map((t) => sheetApi(t)),
      getSheetByName: (n) => { const t = tabs.find((x) => x.title === n); return t ? sheetApi(t) : null; },
    };
  };
  const sheetApi = (t) => ({
    getSheetId: () => Number(t.gid ?? 0), getName: () => t.title,
    getDataRange: () => ({ getDisplayValues: () => { t._values ??= Papa.parse(readFileSync(t.csv, 'utf8'), { skipEmptyLines: false }).data.filter((r) => r.length > 1 || r[0] !== ''); return t._values.map((r) => r.map(String)); } }),
  });

  const fmtDate = (d, tz) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((p) => [p.type, p.value]));
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
  };

  const g = {
    console: { log() {}, info() {}, warn: (...a) => console.warn('[gas]', ...a), error: (...a) => console.error('[gas]', ...a) },
    Session: { getActiveUser: () => ({ getEmail: () => active ?? '' }), getEffectiveUser: () => ({ getEmail: () => owner }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props.get(k) ?? null, setProperty: (k, v) => { if (String(v).length > 9 * 1024) throw new Error('Property too large'); props.set(k, String(v)); }, deleteProperty: (k) => { props.delete(k); } }) },
    CacheService: { getScriptCache: () => ({
      get: (k) => cache.get(k) ?? null,
      put: (k, v) => { if (String(v).length > cacheLimitBytes) throw new Error('Argument too large: value'); cache.set(k, String(v)); },
      getAll: (ks) => { const o = {}; ks.forEach((k) => { if (cache.has(k)) o[k] = cache.get(k); }); if (Object.keys(o).length === ks.length) stats.cacheHits++; return o; },
      putAll: (o) => { for (const [k, v] of Object.entries(o)) { if (v.length > cacheLimitBytes) throw new Error('Argument too large: value'); cache.set(k, v); } },
    }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} }) },
    Utilities: {
      newBlob: (data, type, name) => new Blob(typeof data === 'string' ? Buffer.from(data, 'utf8') : data, type, name),
      gzip: (blob, name) => new Blob(gzipSync(blob.getBytes()), 'application/x-gzip', name ?? `${blob.getName()}.gz`),
      ungzip: (blob) => new Blob(gunzipSync(blob.getBytes()), 'application/octet-stream'),
      base64Encode: (b) => Buffer.from(b).toString('base64'),
      base64Decode: (s) => Buffer.from(s, 'base64'),
      formatDate: (d, tz) => fmtDate(d, tz),
      getUuid: () => randomUUID(),
    },
    DriveApp: {
      createFolder: (n) => mkFolder(n),
      getFolderById: (i) => { const f = folders.get(i); if (!f) throw new Error('No item with the given ID could be found'); return f; },
      getFileById: (i) => { const f = files.get(i); if (!f) throw new Error('No item with the given ID could be found'); return f; },
    },
    Drive: { Files: { update: (_r, fileId, blob) => { const f = files.get(fileId); if (!f) throw new Error('File not found'); stats.driveWrites++; f._f.blob = new Blob(blob.getBytes(), blob.getContentType(), f._f.name); return { id: fileId }; } } },
    SpreadsheetApp: { openById: (i) => { stats.spreadsheetApp = (stats.spreadsheetApp ?? 0) + 1; return sheetFor(i); } },
    // Advanced Sheets service (v4): like the real API, trailing empty cells and rows are left out
    Sheets: { Spreadsheets: {
      get: (i) => { const tabs = sheets[i]; if (!tabs) throw new Error('API call to sheets.spreadsheets.get failed with error: The caller does not have permission'); return { sheets: tabs.map((t) => ({ properties: { sheetId: Number(t.gid ?? 0), title: t.title } })) }; },
      Values: { get: (i, range) => {
        stats.sheetsApi = (stats.sheetsApi ?? 0) + 1;
        const tabs = sheets[i]; if (!tabs) throw new Error('API call to sheets.spreadsheets.values.get failed with error: The caller does not have permission');
        const title = range.replace(/^'|'$/g, '').replace(/''/g, "'"); const t = tabs.find((x) => x.title === title);
        if (!t) throw new Error('Unable to parse range: ' + range);
        const vals = sheetApi(t).getDataRange().getDisplayValues().map((r) => { const o = [...r]; while (o.length && o[o.length - 1] === '') o.pop(); return o; });
        return { values: vals };
      } },
    } },
    MailApp: { sendEmail: (m) => { if (!m.to || !m.subject) throw new Error('Invalid email'); mails.push(m); }, getRemainingDailyQuota: () => 1500 - mails.length },
    ScriptApp: {
      getService: () => ({ getUrl: () => 'https://script.google.com/a/macros/example.com/s/SIMULATED/exec' }),
      getProjectTriggers: () => triggers.map((t) => ({ getHandlerFunction: () => t.fn, _t: t })),
      deleteTrigger: (t) => { const i = triggers.indexOf(t._t); if (i >= 0) triggers.splice(i, 1); },
      newTrigger: (fn) => { const t = { fn }; return { timeBased: () => ({ everyMinutes: (m) => ({ create: () => { t.minutes = m; triggers.push(t); return t; } }) }) }; },
    },
    HtmlService: {
      XFrameOptionsMode: { DEFAULT: 'DEFAULT', ALLOWALL: 'ALLOWALL' },
      createHtmlOutputFromFile: (n) => { const o = { file: n, title: '', meta: {}, setTitle: (t) => { o.title = t; return o; }, addMetaTag: (k, v) => { o.meta[k] = v; return o; }, setXFrameOptionsMode: (x) => { o.xfo = x; return o; } }; return o; },
    },
  };
  void domainUsers;
  const ctx = vm.createContext(g);
  vm.runInContext(readFileSync(new URL('../google/Code.js', import.meta.url), 'utf8'), ctx, { filename: 'Code.js' });
  return {
    ctx, mails, triggers, props, cache, stats, files,
    as(email) { active = email; return this; },
    api(calls) { const raw = ctx.api(JSON.stringify({ calls })); const text = raw.startsWith('z:') ? gunzipSync(Buffer.from(raw.slice(2), 'base64')).toString('utf8') : raw; return JSON.parse(text).r; },
    rawApi(payload) { return ctx.api(payload); },
    call(m, ...a) { const [r] = this.api([{ m, a }]); if (!r.ok) throw new Error(r.e); return r.v; },
    runJobs() { return ctx.scheduledJobs(); },
    doGet() { return ctx.doGet({ parameter: {} }); },
    dataSize() { let n = 0; for (const f of files.values()) if (!f._f.trashed) n += f._f.blob.bytes.length; return n; },
  };
}
