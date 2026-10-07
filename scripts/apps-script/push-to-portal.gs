/**
 * CS QA Portal — send audits from this Google Sheet to the portal.
 *
 * Paste this whole file into the sheet: Extensions → Apps Script. It runs as you, so no
 * Google Cloud project or service account is needed. Setup steps are in the portal README
 * ("Sync without a service account"). In short:
 *   1. Project Settings → Script Properties → add PORTAL_PUSH_SECRET (the same secret you
 *      saved in Supabase as SHEETS_PUSH_SECRET).
 *   2. Check the TABS list below, then run  pushToPortal  once and click Allow.
 *   3. Run  installTrigger  once so it repeats every 30 minutes.
 * Rows already in the portal are skipped, so running it again is always safe.
 */

const PORTAL_PUSH_URL = 'https://fjctcwhhugkvxfsotzjc.supabase.co/functions/v1/sheets-push';

/** Tabs to send. source: 'live' for the live form (new weeks arrive as drafts), 'archive' for past years (published). */
const TABS = [
  { name: 'Form Responses 1', source: 'live', label: 'New QA Live Task Audit Form (Responses)' },
];

const CHUNK = 1000;           // rows per request
const OVERLAP = 50;           // re-send the last rows each time, in case recent ones were edited
const TIME_BUDGET_MS = 4.5 * 60 * 1000; // Apps Script stops at 6 minutes; continue on the next run

function pushToPortal() {
  const secret = PropertiesService.getScriptProperties().getProperty('PORTAL_PUSH_SECRET');
  if (!secret) throw new Error('Add PORTAL_PUSH_SECRET under Project Settings → Script Properties first.');
  const started = Date.now();
  const book = SpreadsheetApp.getActiveSpreadsheet();
  const props = PropertiesService.getDocumentProperties();
  const summary = [];

  for (const tab of TABS) {
    const sheet = book.getSheetByName(tab.name);
    if (!sheet) { summary.push(`${tab.name}: tab not found`); continue; }
    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    if (lastRow < 2) { summary.push(`${tab.name}: no rows`); continue; }
    const header = sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
    const key = 'pushed_up_to:' + tab.name;
    let from = Math.max(2, Number(props.getProperty(key) || 1) + 1 - OVERLAP);
    let totals = { inserted: 0, duplicates: 0, rejected: 0 };

    while (from <= lastRow) {
      if (Date.now() - started > TIME_BUDGET_MS) { summary.push(`${tab.name}: paused at row ${from}, continues next run`); break; }
      const to = Math.min(lastRow, from + CHUNK - 1);
      const rows = sheet.getRange(from, 1, to - from + 1, lastCol).getDisplayValues();
      const res = UrlFetchApp.fetch(PORTAL_PUSH_URL, {
        method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        headers: { 'x-push-secret': secret },
        payload: JSON.stringify({ source: tab.source, label: tab.label, header, rows, first_row: from }),
      });
      const body = JSON.parse(res.getContentText() || '{}');
      if (res.getResponseCode() !== 200) throw new Error(`Portal refused rows ${from}–${to}: ${body.error || res.getResponseCode()}`);
      totals.inserted += body.inserted || 0; totals.duplicates += body.duplicates || 0; totals.rejected += body.rejected || 0;
      props.setProperty(key, String(to));
      from = to + 1;
    }
    summary.push(`${tab.name}: ${totals.inserted} new · ${totals.duplicates} already in the portal · ${totals.rejected} rejected`);
  }
  console.log(summary.join('\n'));
  return summary.join('\n');
}

/** Sends every row again from the top (safe: duplicates are skipped). */
function pushEverything() {
  const props = PropertiesService.getDocumentProperties();
  TABS.forEach((t) => props.deleteProperty('pushed_up_to:' + t.name));
  return pushToPortal();
}

/** Run once: repeats pushToPortal every 30 minutes. */
function installTrigger() {
  ScriptApp.getProjectTriggers().filter((t) => t.getHandlerFunction() === 'pushToPortal').forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('pushToPortal').timeBased().everyMinutes(30).create();
  return 'Automatic sync every 30 minutes is on.';
}

/** Run to stop the automatic sync. */
function removeTrigger() {
  ScriptApp.getProjectTriggers().filter((t) => t.getHandlerFunction() === 'pushToPortal').forEach((t) => ScriptApp.deleteTrigger(t));
  return 'Automatic sync is off.';
}
