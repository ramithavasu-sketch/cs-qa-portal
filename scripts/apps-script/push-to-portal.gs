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
 *
 * Score changes made in the portal (approved appeals, QA corrections) are written back too:
 * the original audit row gets the new parameter score and task Score (with a cell note showing
 * the old value and the reason), and every change is listed in the "Portal Score Changes" tab.
 * This runs at the end of every pushToPortal; run  pullScoreChanges  on its own to do just that.
 *
 * Portal emails (invitations, password links, appeal updates, weekly reports) are sent from YOUR
 * Gmail by  sendPortalEmails , which installTrigger schedules every minute. No SMTP is needed.
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
  const secret = (PropertiesService.getScriptProperties().getProperty('PORTAL_PUSH_SECRET') || '').trim().replace(/^['"]+|['"]+$/g, '').trim();
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
  try { summary.push(pullScoreChanges()); } catch (e) { summary.push('Score changes: ' + e.message); }
  console.log(summary.join('\n'));
  return summary.join('\n');
}

const CHANGES_TAB = 'Portal Score Changes';
const CHANGES_HEADER = ['Changed (portal)', 'CAM', 'CAM Email', 'QA Week', 'DS Task Link', 'Task Type', 'What changed', 'Original', 'New', 'New task score',
  'Reason', 'Approved by', 'Appeal', 'Sheet row updated'];
const keyOf = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Fetches score changes made in the portal since the last run and writes them into this sheet. */
function pullScoreChanges() {
  const secret = (PropertiesService.getScriptProperties().getProperty('PORTAL_PUSH_SECRET') || '').trim().replace(/^['"]+|['"]+$/g, '').trim();
  if (!secret) throw new Error('Add PORTAL_PUSH_SECRET under Project Settings → Script Properties first.');
  const props = PropertiesService.getDocumentProperties();
  const book = SpreadsheetApp.getActiveSpreadsheet();
  let log = book.getSheetByName(CHANGES_TAB);
  if (!log) { log = book.insertSheet(CHANGES_TAB); log.appendRow(CHANGES_HEADER); log.setFrozenRows(1); log.getRange(1, 1, 1, CHANGES_HEADER.length).setFontWeight('bold'); }

  const live = TABS.filter((t) => t.source === 'live').map((t) => book.getSheetByName(t.name)).filter(Boolean);
  const index = live.map(indexSheet);
  let since = props.getProperty('score_changes_since') || null;
  let done = 0, updated = 0;
  for (let round = 0; round < 10; round++) {
    const res = UrlFetchApp.fetch(PORTAL_PUSH_URL, { method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { 'x-push-secret': secret }, payload: JSON.stringify({ action: 'changes', since }) });
    const body = JSON.parse(res.getContentText() || '{}');
    if (res.getResponseCode() !== 200) throw new Error('Portal refused the score-change request: ' + (body.error || res.getResponseCode()));
    const changes = body.changes || [];
    for (const c of changes) {
      const where = applyChange(index, c);
      if (where) updated++;
      log.appendRow([new Date(c.changed_at), c.cam_name, c.cam_email, c.qa_week, c.task_link, c.task_type,
        c.kind === 'autofail' ? 'Auto-Fail' : c.parameter_name, c.kind === 'autofail' ? (c.original_value ? 'Yes' : 'No') : c.original_value,
        c.kind === 'autofail' ? (c.revised_value ? 'Yes' : 'No') : c.revised_value, c.task_score, c.reason, c.approved_by || '', c.appeal_reference || 'QA correction',
        where || 'Row not found in the sheet']);
      done++;
    }
    since = body.next_since || since;
    if (since) props.setProperty('score_changes_since', since);
    if (changes.length < 500) break;
  }
  return `Score changes: ${done} received from the portal, ${updated} sheet row(s) updated`;
}

/** Column positions and a lookup of rows by DS Task Link + CAM Name + QA Week. */
function indexSheet(sheet) {
  const lastRow = sheet.getLastRow(), lastCol = sheet.getLastColumn();
  const header = sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
  const col = (name) => header.findIndex((h) => keyOf(h) === keyOf(name)) + 1;
  const c = { link: col('DS Task Link'), cam: col('CAM Name'), week: col('QA Week'), score: col('Score'), af: col('Auto-Fail') };
  const rows = new Map();
  if (lastRow >= 2 && c.link && c.cam && c.week) {
    const vals = sheet.getRange(2, 1, lastRow - 1, lastCol).getDisplayValues();
    vals.forEach((r, i) => rows.set([r[c.link - 1], r[c.cam - 1], r[c.week - 1]].map((x) => String(x).trim().toLowerCase()).join('|'), i + 2));
  }
  return { sheet, header, col, c, rows };
}

/** Updates the original audit row; returns "Tab!row" or null when the row isn't in this sheet. */
function applyChange(index, ch) {
  const key = [ch.task_link, ch.cam_email, ch.qa_week].map((x) => String(x || '').trim().toLowerCase()).join('|');
  for (const ix of index) {
    const row = ix.rows.get(key);
    if (!row) continue;
    const when = Utilities.formatDate(new Date(ch.changed_at), Session.getScriptTimeZone(), 'dd MMM yyyy HH:mm');
    const note = (from, to) => `Changed in CS QA Portal on ${when}${ch.approved_by ? ' by ' + ch.approved_by : ''}: ${from} → ${to}.` +
      `${ch.reason ? ' Reason: ' + ch.reason : ''}${ch.appeal_reference ? ' (appeal ' + ch.appeal_reference + ')' : ''}`;
    const addNote = (cell, text) => { const old = cell.getNote(); cell.setNote(old ? old + '\n' + text : text); };
    if (ch.kind === 'autofail' && ix.c.af) {
      const cell = ix.sheet.getRange(row, ix.c.af);
      addNote(cell, note(ch.original_value ? 'Yes' : 'No', ch.revised_value ? 'Yes' : 'No'));
      cell.setValue(ch.revised_value ? 'Yes' : 'No');
    } else if (ch.kind === 'parameter') {
      const names = [ch.sheet_column].concat(ch.sheet_column_aliases || []).filter(Boolean);
      const pc = names.map(ix.col).find((n) => n > 0);
      if (pc) { const cell = ix.sheet.getRange(row, pc); addNote(cell, note(ch.original_value, ch.revised_value)); cell.setValue(Number(ch.revised_value)); }
    }
    if (ix.c.score && ch.task_score !== null && ch.task_score !== undefined) {
      const cell = ix.sheet.getRange(row, ix.c.score);
      const old = cell.getDisplayValue();
      if (String(Number(old)) !== String(Number(ch.task_score))) { addNote(cell, note(old, ch.task_score)); cell.setValue(Number(ch.task_score)); }
    }
    return `${ix.sheet.getName()}!${row}`;
  }
  return null;
}

/** Sends every row again from the top (safe: duplicates are skipped). */
function pushEverything() {
  const props = PropertiesService.getDocumentProperties();
  TABS.forEach((t) => props.deleteProperty('pushed_up_to:' + t.name));
  return pushToPortal();
}

/** Run once: syncs audits every 30 minutes and sends portal emails every minute. */
function installTrigger() {
  ScriptApp.getProjectTriggers().filter((t) => ['pushToPortal', 'sendPortalEmails'].includes(t.getHandlerFunction())).forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('pushToPortal').timeBased().everyMinutes(30).create();
  ScriptApp.newTrigger('sendPortalEmails').timeBased().everyMinutes(1).create();
  return 'Automatic sync every 30 minutes and email sending every minute are on.';
}

/** Run to stop the automatic sync and email sending. */
function removeTrigger() {
  ScriptApp.getProjectTriggers().filter((t) => ['pushToPortal', 'sendPortalEmails'].includes(t.getHandlerFunction())).forEach((t) => ScriptApp.deleteTrigger(t));
  return 'Automatic sync and email sending are off.';
}

/** Sends the portal's queued emails from your Gmail and tells the portal which ones went out. */
function sendPortalEmails() {
  const secret = (PropertiesService.getScriptProperties().getProperty('PORTAL_PUSH_SECRET') || '').trim().replace(/^['"]+|['"]+$/g, '').trim();
  if (!secret) throw new Error('Add PORTAL_PUSH_SECRET under Project Settings → Script Properties first.');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return 'Another run is already sending emails';
  try {
    const call = (payload) => {
      const res = UrlFetchApp.fetch(PORTAL_PUSH_URL, { method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        headers: { 'x-push-secret': secret }, payload: JSON.stringify(payload) });
      const body = JSON.parse(res.getContentText() || '{}');
      if (res.getResponseCode() !== 200) throw new Error('Portal refused the email request: ' + (body.error || res.getResponseCode()));
      return body;
    };
    const emails = call({ action: 'outbox' }).emails || [];
    if (!emails.length) return 'No portal emails waiting';
    const results = [];
    for (const m of emails) {
      if (MailApp.getRemainingDailyQuota() < (m.cc_email ? 2 : 1)) { results.push({ id: m.id, ok: false, error: 'Daily Gmail sending limit reached; will retry tomorrow' }); continue; }
      try {
        const opts = { to: m.recipient_email, subject: m.subject, body: m.body_text, name: 'CS QA Portal' };
        if (m.body_html) opts.htmlBody = m.body_html;
        if (m.cc_email) opts.cc = m.cc_email;
        if (m.reply_to) opts.replyTo = m.reply_to;
        MailApp.sendEmail(opts);
        results.push({ id: m.id, ok: true });
      } catch (e) { results.push({ id: m.id, ok: false, error: String(e.message || e) }); }
    }
    call({ action: 'outbox_done', results });
    const ok = results.filter((r) => r.ok).length;
    return `Portal emails: ${ok} sent, ${results.length - ok} failed`;
  } finally { lock.releaseLock(); }
}
