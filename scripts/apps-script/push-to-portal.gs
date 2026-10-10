/**
 * CS QA Portal — send audits from this Google Sheet to the portal.
 *
 * Paste this whole file into the sheet: Extensions → Apps Script. It runs as you, so no
 * Google Cloud project or service account is needed. Setup steps are in the portal README
 * ("Sync without a service account"). In short:
 *   1. Project Settings → Script Properties → add PORTAL_PUSH_SECRET (the same secret you
 *      saved in Supabase as SHEETS_PUSH_SECRET).
 *   2. Check the TABS list below, then run  pushToPortal  once and click Allow.
 *   3. Run  installTrigger  once. It sets up:
 *        - onAuditSubmitted : every new audit form submission reaches the portal within seconds
 *        - everyMinute      : sends portal emails and writes portal score changes into this sheet
 *        - pushToPortal     : every 30 minutes, a safety-net sync of the audit tab
 * Rows already in the portal are skipped, so running it again is always safe.
 *
 * Score changes made in the portal (approved appeals, QA corrections) are written back too:
 * the original audit row gets the new parameter score and task Score (with a cell note showing
 * the old value and the reason), and every change is listed in the "Portal Score Changes" tab.
 * This runs every minute (it only reads the audit tab when there is a change); run  pullScoreChanges  on its own to do just that.
 *
 * Portal emails (invitations, password links, appeal updates, weekly reports) are sent from YOUR
 * Gmail by  sendPortalEmails , which installTrigger schedules every minute. No SMTP is needed.
 */

const PORTAL_PUSH_URL = 'https://fjctcwhhugkvxfsotzjc.supabase.co/functions/v1/sheets-push';
// Weekly reminder emailed to you (the sheet owner) shortly before you publish the week.
const PORTAL_SITE_URL = 'https://ramithavasu-sketch.github.io/csqa-portal/#';
const REMINDER = { weekday: 4, time: '23:54', timezone: 'Asia/Kolkata' };   // Thursday (1 = Mon … 7 = Sun), 11:54 pm IST

/** Tabs to send. source: 'live' for the live form (new weeks arrive as drafts), 'archive' for past years (published). */
const TABS = [
  { name: 'Data 2.0', source: 'live', label: 'New QA Live Task Audit Form (Responses)' },
];

const CHUNK = 1000;           // rows per request
const OVERLAP = 50;           // re-send the last rows each time, in case recent ones were edited
const TIME_BUDGET_MS = 4.5 * 60 * 1000; // Apps Script stops at 6 minutes; continue on the next run

function pushToPortal() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(60 * 1000)) return 'Another sync is running; this one was skipped';
  try { return pushToPortalLocked(); } finally { lock.releaseLock(); }
}

/** Runs the moment someone submits the audit form (installed by installTrigger). */
function onAuditSubmitted(e) {
  return pushToPortal();
}

function pushToPortalLocked() {
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
    // If the tab got shorter than where we stopped last time (rows deleted, sorted or moved),
    // start again from the top: rows already in the portal are skipped as duplicates.
    if (Number(props.getProperty(key) || 0) > lastRow) props.deleteProperty(key);
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
  try { summary.push(pullScoreChangesLocked()); } catch (e) { summary.push('Score changes: ' + e.message); }
  console.log(summary.join('\n'));
  return summary.join('\n');
}

const CHANGES_TAB = 'Portal Score Changes';
const CHANGES_HEADER = ['Changed (portal)', 'CAM', 'CAM Email', 'QA Week', 'DS Task Link', 'Task Type', 'What changed', 'Original', 'New', 'New task score',
  'Reason', 'Approved by', 'Appeal', 'Sheet row updated'];
const keyOf = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Fetches score changes made in the portal since the last run and writes them into this sheet. */
function pullScoreChanges() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) return 'Score changes: another run is busy; will retry next minute';
  try { return pullScoreChangesLocked(); } finally { lock.releaseLock(); }
}

function pullScoreChangesLocked() {
  const secret = (PropertiesService.getScriptProperties().getProperty('PORTAL_PUSH_SECRET') || '').trim().replace(/^['"]+|['"]+$/g, '').trim();
  if (!secret) throw new Error('Add PORTAL_PUSH_SECRET under Project Settings → Script Properties first.');
  const props = PropertiesService.getDocumentProperties();
  const book = SpreadsheetApp.getActiveSpreadsheet();
  let log = null, index = null;   // the audit tab is only read when there is something to write
  let since = props.getProperty('score_changes_since') || null;
  let done = 0, updated = 0;
  for (let round = 0; round < 10; round++) {
    const res = UrlFetchApp.fetch(PORTAL_PUSH_URL, { method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { 'x-push-secret': secret }, payload: JSON.stringify({ action: 'changes', since }) });
    const body = JSON.parse(res.getContentText() || '{}');
    if (res.getResponseCode() !== 200) throw new Error('Portal refused the score-change request: ' + (body.error || res.getResponseCode()));
    const changes = body.changes || [];
    if (changes.length && !index) {
      log = book.getSheetByName(CHANGES_TAB);
      if (!log) { log = book.insertSheet(CHANGES_TAB); log.appendRow(CHANGES_HEADER); log.setFrozenRows(1); log.getRange(1, 1, 1, CHANGES_HEADER.length).setFontWeight('bold'); }
      index = TABS.filter((t) => t.source === 'live').map((t) => book.getSheetByName(t.name)).filter(Boolean).map(indexSheet);
    }
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
  return done ? `Score changes: ${done} received from the portal, ${updated} sheet row(s) updated` : 'Score changes: none new';
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

const TRIGGER_HANDLERS = ['pushToPortal', 'sendPortalEmails', 'everyMinute', 'onAuditSubmitted'];

/** Run once: instant sync on every form submission, emails + score changes every minute, and a 30-minute safety-net sync. */
function installTrigger() {
  ScriptApp.getProjectTriggers().filter((t) => TRIGGER_HANDLERS.includes(t.getHandlerFunction())).forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('onAuditSubmitted').forSpreadsheet(SpreadsheetApp.getActiveSpreadsheet()).onFormSubmit().create();
  ScriptApp.newTrigger('everyMinute').timeBased().everyMinutes(1).create();
  ScriptApp.newTrigger('pushToPortal').timeBased().everyMinutes(30).create();
  return 'On: new audits sync as soon as the form is submitted; emails and score changes every minute; full sync every 30 minutes.';
}

/** Run to stop all automatic jobs. */
function removeTrigger() {
  ScriptApp.getProjectTriggers().filter((t) => TRIGGER_HANDLERS.includes(t.getHandlerFunction())).forEach((t) => ScriptApp.deleteTrigger(t));
  return 'Automatic sync, emails and score write-back are off.';
}

/** Every minute: send queued portal emails, then write any new portal score changes into this sheet. */
function everyMinute() {
  const out = [];
  try { out.push(sendPortalEmails()); } catch (e) { out.push('Emails: ' + e.message); }
  try { out.push(pullScoreChanges()); } catch (e) { out.push('Score changes: ' + e.message); }
  try { out.push(publishReminder()); } catch (e) { out.push('Reminder: ' + e.message); }
  if (new Date().getMinutes() % 10 === 0) {   // feedback sessions: every 10 minutes is plenty
    try { out.push(pushFeedbackResponses()); } catch (e) { out.push('Feedback responses: ' + e.message); }
    try { out.push(pushFeedbackBookings()); } catch (e) { out.push('Feedback bookings: ' + e.message); }
    try { out.push(writeFeedbackSheet()); } catch (e) { out.push('Feedback sheet: ' + e.message); }
  }
  console.log(out.join('\n'));
  return out.join('\n');
}

/** Once a week at REMINDER time: email yourself a heads-up to publish the week and send the report emails. */
function publishReminder(force) {
  const now = new Date();
  const day = Number(Utilities.formatDate(now, REMINDER.timezone, 'u'));
  const hm = Utilities.formatDate(now, REMINDER.timezone, 'HH:mm');
  const today = Utilities.formatDate(now, REMINDER.timezone, 'yyyy-MM-dd');
  if (!force) {
    if (day !== REMINDER.weekday || hm < REMINDER.time || hm > '23:58') return 'No reminder due';
    const props = PropertiesService.getDocumentProperties();
    if (props.getProperty('publish_reminder_sent') === today) return 'Reminder already sent today';
    props.setProperty('publish_reminder_sent', today);
  }
  const weekEnd = Utilities.formatDate(new Date(now.getTime() - 86400000), REMINDER.timezone, 'EEE d MMM');
  const me = Session.getEffectiveUser().getEmail();
  const html = '<p>Heads-up: in about 5 minutes (11:59 pm) it is time to publish this week\'s QA report.</p>' +
    '<ol><li><a href="' + PORTAL_SITE_URL + '/admin/periods">Publish the audit week</a> that ended ' + weekEnd + ' (Reporting Periods). Appeals then stay open until next Wednesday 11:59 pm.</li>' +
    '<li><a href="' + PORTAL_SITE_URL + '/admin/emails">Send the weekly report emails</a> to all CAMs (Weekly Report Emails → Send → tick the box → Yes, send).</li></ol>' +
    '<p>This reminder comes from the script in your QA audit sheet.</p>';
  MailApp.sendEmail({ to: me, subject: 'Reminder: publish the QA report and send emails at 11:59 pm', htmlBody: html,
    body: html.replace(/<li>/g, '- ').replace(/<[^>]+>/g, ' '), name: 'CS QA Portal' });
  return 'Publish reminder emailed to ' + me;
}

// ---------------------------------------------------------------- feedback sessions
// Form responses: the tab in THIS sheet whose header has "Session Provider" (or Script Property FEEDBACK_RESPONSES_TAB).
// Session lists: written into your "Feedback Sessions" spreadsheet; put its ID (the long part of its link
// between /d/ and /edit) in Script Property FEEDBACK_SHEET_ID.

function portalCall_(payload) {
  const secret = (PropertiesService.getScriptProperties().getProperty('PORTAL_PUSH_SECRET') || '').trim().replace(/^['"]+|['"]+$/g, '').trim();
  if (!secret) throw new Error('Add PORTAL_PUSH_SECRET under Project Settings → Script Properties first.');
  const res = UrlFetchApp.fetch(PORTAL_PUSH_URL, { method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'x-push-secret': secret }, payload: JSON.stringify(payload) });
  const body = JSON.parse(res.getContentText() || '{}');
  if (res.getResponseCode() !== 200) throw new Error('Portal refused the request: ' + (body.error || res.getResponseCode()));
  return body;
}

/** Sends the feedback form answers to the portal (QA-only page). A new answer marks that CAM's session completed. */
function pushFeedbackResponses() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const named = PropertiesService.getScriptProperties().getProperty('FEEDBACK_RESPONSES_TAB');
  const sheet = named ? ss.getSheetByName(named) : ss.getSheets().find((sh) => sh.getLastColumn() > 0 &&
    sh.getRange(1, 1, 1, Math.min(sh.getLastColumn(), 30)).getDisplayValues()[0].some((h) => String(h).trim() === 'Session Provider'));
  if (!sheet) return 'Feedback responses: no tab with a "Session Provider" column';
  const values = sheet.getDataRange().getValues();
  const head = values[0].map((h) => String(h).trim());
  const col = (name) => head.findIndex((h) => h.toLowerCase().startsWith(name.toLowerCase()));
  const c = { at: col('Timestamp'), email: col('Email Address'), provider: col('Session Provider'), lead_present: col('Team Lead Present'),
    agrees: col('Do you agree'), feedback: col('Feedback for the Session Provider'), lead_name: col('Lead Name'), qa: col('QA Feedback') };
  if (c.at < 0 || c.email < 0) return 'Feedback responses: Timestamp / Email Address columns not found';
  const v = (r, i) => (i < 0 ? '' : String(r[i] == null ? '' : r[i]).trim());
  const rows = values.slice(1).filter((r) => r[c.at] instanceof Date && v(r, c.email)).map((r) => ({
    submitted_at: r[c.at].toISOString(), email: v(r, c.email), provider: v(r, c.provider), lead_present: v(r, c.lead_present),
    agrees: v(r, c.agrees), feedback: v(r, c.feedback), lead_name: v(r, c.lead_name), qa_feedback: v(r, c.qa) }));
  const res = portalCall_({ action: 'feedback_responses', rows: rows });
  return 'Feedback responses: ' + rows.length + ' sent, ' + (res.new || 0) + ' new, ' + (res.completed || 0) + ' sessions marked completed';
}

/** Sends the Setmore bookings ("Booked Sessions" tab of the Feedback Sessions sheet) to the portal. */
function pushFeedbackBookings() {
  const id = (PropertiesService.getScriptProperties().getProperty('FEEDBACK_SHEET_ID') || '').trim();
  if (!id) return 'Feedback bookings: add Script Property FEEDBACK_SHEET_ID first';
  const tabName = PropertiesService.getScriptProperties().getProperty('FEEDBACK_BOOKINGS_TAB') || 'Booked Sessions';
  const sheet = SpreadsheetApp.openById(id).getSheetByName(tabName);
  if (!sheet) return 'Feedback bookings: tab "' + tabName + '" not found';
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return 'Feedback bookings: no bookings in "' + tabName + '" yet';
  const head = values[0].map((h) => String(h).trim().toLowerCase());
  const col = (name) => head.findIndex((h) => h.startsWith(name));
  const c = { date: col('date'), cam: col('cam'), provider: col('provider'), status: col('session status') >= 0 ? col('session status') : col('status') };
  if (c.date < 0 || c.cam < 0) return 'Feedback bookings: Date / CAM Name columns not found';
  const when = (v) => {
    if (v instanceof Date) return v.toISOString();
    const m = String(v).trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T]+(\d{1,2}):(\d{2})\s*(AM|PM)?/i);   // e.g. 2026-09-29 10:30 PM (India time)
    if (!m) return '';
    let h = Number(m[4]) % 12; if (!m[6] || /pm/i.test(m[6])) h = m[6] ? h + 12 : Number(m[4]);
    const pad = (n) => String(n).padStart(2, '0');
    return m[1] + '-' + pad(m[2]) + '-' + pad(m[3]) + 'T' + pad(h) + ':' + m[5] + ':00+05:30';
  };
  const rows = values.slice(1).map((r) => ({ date: when(r[c.date]), cam_name: String(r[c.cam] || '').trim(),
    provider_name: c.provider < 0 ? '' : String(r[c.provider] || '').trim(), status: c.status < 0 ? '' : String(r[c.status] || '').trim() }))
    .filter((r) => r.date && r.cam_name);
  const res = portalCall_({ action: 'feedback_bookings', rows: rows });
  return 'Feedback bookings: ' + rows.length + ' rows, ' + (res.updated || 0) + ' updated' +
    ((res.unmatched || []).length ? ', not matched to a CAM: ' + res.unmatched.join(', ') : '');
}

/** Writes each recent cycle into the Feedback Sessions spreadsheet, in the same layout as before. */
function writeFeedbackSheet() {
  const id = (PropertiesService.getScriptProperties().getProperty('FEEDBACK_SHEET_ID') || '').trim();
  if (!id) return 'Feedback sheet: add Script Property FEEDBACK_SHEET_ID to fill the Feedback Sessions sheet';
  const cycles = portalCall_({ action: 'feedback_feed' }).cycles || [];
  if (!cycles.length) return 'Feedback sheet: no released cycle yet';
  const book = SpreadsheetApp.openById(id);
  const props = PropertiesService.getDocumentProperties();
  const ord = (n) => n + ([, 'st', 'nd', 'rd'][(n % 100 >> 3 ^ 1) && n % 10] || 'th');
  const out = [];
  for (const cy of cycles) {
    const nums = cy.weeks.map((w) => String(w).replace(/\D+/g, '')).join(',');
    const due = cy.book_by ? new Date(cy.book_by + 'T00:00:00') : null;
    const dueText = due ? ord(due.getDate()) + ' ' + Utilities.formatDate(due, Session.getScriptTimeZone(), 'MMM') : '—';
    const label = { not_booked: 'Not booked', booked: 'Booked', completed: 'Completed', cancelled: 'Cancelled', no_audit: 'No audit' };
    const rows = cy.rows.filter((r) => r.status !== 'no_audit');
    const audit = [['Last Date to book session on or before  ' + dueText, '', '', '', '', '', '', ''],
      ['Booking Link : ' + (cy.booking_url || ''), '', '', '', '', '', '', ''],
      ['CAM'].concat(cy.weeks.map((w) => String(w).replace('-', ' - ')), [ord(cy.number) + ' Feedback Session', 'Lead Name', 'Session Status', 'Booked For'])]
      .concat(rows.map((r) => [r.cam_email].concat(r.weeks, [r.provider, r.lead_name || '', label[r.status] || r.status,
        r.booked_for ? Utilities.formatDate(new Date(r.booked_for), REMINDER.timezone, 'yyyy-MM-dd h:mm a') : ''])));
    const width = audit[2].length;
    const auditRows = audit.map((r) => r.concat(Array(Math.max(0, width - r.length)).fill('')).slice(0, width));
    const byProv = {};
    rows.forEach((r) => { if (r.provider) (byProv[r.provider] = byProv[r.provider] || []).push(r.cam_email); });
    const provs = Object.keys(byProv).sort((a, b) => byProv[b].length - byProv[a].length);
    const depth = Math.max(0, ...provs.map((p) => byProv[p].length));
    const provRows = provs.length ? [provs].concat(Array.from({ length: depth }, (_, i) => provs.map((p) => byProv[p][i] || ''))) : [['No sessions']];
    const tabs = [['Audit Data (' + nums + ')', auditRows], ['Feedback Session-' + cy.number + '(WK -' + nums + ') - Provider', provRows]];
    const hash = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, JSON.stringify(tabs)));
    if (props.getProperty('fb_sheet:' + cy.number) === hash) { out.push('Session ' + cy.number + ' unchanged'); continue; }
    for (const [name, data] of tabs) {
      const sh = book.getSheetByName(name) || book.insertSheet(name);
      sh.clearContents();
      sh.getRange(1, 1, data.length, data[0].length).setValues(data);
    }
    props.setProperty('fb_sheet:' + cy.number, hash);
    out.push('Session ' + cy.number + ' written (' + rows.length + ' CAMs)');
  }
  return 'Feedback sheet: ' + out.join('; ');
}

/** Run once to send the feedback responses and fill the Feedback Sessions sheet right away. */
function syncFeedbackNow() { const t = [pushFeedbackResponses(), pushFeedbackBookings(), writeFeedbackSheet()].join('\n'); console.log(t); return t; }

/** Run once to see what the weekly reminder looks like (emails it to you right away). */
function testPublishReminder() { return publishReminder(true); }

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
