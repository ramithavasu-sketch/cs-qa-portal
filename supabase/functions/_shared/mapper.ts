// Maps rows of the "New QA Live Task Audit Form (Responses)" sheet (or a CSV/XLSX
// export of it) into the normalized payload accepted by public.import_evaluations.
// Pure TypeScript with no runtime dependencies: used by the browser import page and
// by the `sheets-sync` Edge Function (Deno).

export interface MapperTaskType { code: string; source_label: string; feedback_column: string | null; fcr_column: string | null }
export interface MapperParameter { id: string; task_type: string; name: string; max_score: number; source_column: string | null; active: boolean; rubric_version?: string | null; source_aliases?: string[] | null }

export interface ImportPeriod { label: string; short_label: string; year: number; week: number; start: string; end: string }
export interface ImportRow {
  row_number: number;
  task_link: string;
  task_id: string;
  /** '' when the sheet only has a name (archived years) — the server resolves or creates a historical CAM. */
  cam_email: string;
  cam_name: string | null;
  lead_name: string | null;
  evaluator_email: string | null;
  evaluator_name: string | null;
  task_type: string;
  request_from: string | null;
  task_loaded_date: string | null;
  audited_at: string;
  period: ImportPeriod;
  task_seq: string | null;
  connection_id: string | null;
  screenshot_url: string | null;
  autofail: boolean;
  fcr: 'Yes' | 'No' | null;
  score: number;
  feedback: string | null;
  scores: { parameter_id: string; earned: number | null }[];
}
export interface MapperRejection { row_number: number; reason: string }
export interface MapperResult { rows: ImportRow[]; rejections: MapperRejection[]; duplicates: MapperRejection[]; missingColumns: string[] }

// Column mapping (header in the source sheet -> meaning). Editable in the import UI.
export const DEFAULT_COLUMN_MAP = {
  timestamp: 'Timestamp',
  evaluatorEmail: 'Email Address',
  score: 'Score',
  week: 'QA Week',
  taskLink: 'DS Task Link',
  cam: 'CAM Name',
  taskLoadedDate: 'Task Loaded Date',
  taskSeq: 'Task Count',
  screenshot: 'Screenshot URL (If applicable)',
  requestFrom: 'Request from?',
  autofail: 'Auto-Fail',
  taskType: 'Task Type',
  connectionId: 'Connection ID',
  evaluatorName: 'QA Person',
  leadName: 'Lead Name',
} as const;
export type ColumnMap = { [K in keyof typeof DEFAULT_COLUMN_MAP]: string };
export const REQUIRED_KEYS: (keyof ColumnMap)[] = ['timestamp', 'score', 'week', 'taskLink', 'cam', 'autofail', 'taskType'];

const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
/** Loose header key: ignores case, spaces and punctuation ("[Tone of Voice  [10]]" == "Tone of Voice [10]"). */
export const headerKey = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Makes duplicate header names unique ("Score", "Score_1", …) so no column is silently overwritten. */
export function rowsToRecords(values: string[][]): Record<string, string>[] {
  const [hdr = [], ...body] = values;
  const seen = new Map<string, number>();
  const names = hdr.map((h) => { const n = seen.get(h) ?? 0; seen.set(h, n + 1); return n ? `${h}_${n}` : h; });
  return body.map((row) => Object.fromEntries(names.map((h, i) => [h, row[i] ?? ''])));
}

/** 'WK-39 : 2026 (09/24- 09/30)' -> period (handles year roll-over e.g. 12/29 - 01/04). */
export function parseWeekLabel(label: string): ImportPeriod | null {
  const m = /^\s*WK-(\d{1,2})\s*:\s*(\d{4})\s*\((\d{2})\/(\d{2})\s*-\s*(\d{2})\/(\d{2})\)\s*$/.exec(label ?? '');
  if (!m) return null;
  const [, wk, yr, sm, sd, em, ed] = m;
  const week = Number(wk);
  const year = Number(yr);
  // Week 1 may start in December of the previous year.
  const startYear = week === 1 && Number(sm) === 12 ? year - 1 : year;
  const endYear = Number(em) < Number(sm) ? startYear + 1 : startYear;
  const start = `${startYear}-${sm}-${sd}`;
  const end = `${endYear}-${em}-${ed}`;
  if (Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end))) return null;
  return { label: label.trim(), short_label: `WK-${week}`, year, week, start, end };
}

/** Builds the canonical label for a new period (same format as the audit form). */
export function formatWeekLabel(week: number, year: number, start: string, end: string): string {
  const md = (d: string) => `${d.slice(5, 7)}/${d.slice(8, 10)}`;
  return `WK-${week} : ${year} (${md(start)}- ${md(end)})`;
}

/** US-style 'M/D/YYYY' (optionally followed by 'H:MM:SS') -> ISO date or datetime. */
export function parseUsDate(value: string, withTime: boolean, tzOffset = '+05:30'): string | null {
  const v = (value ?? '').trim();
  // Google Sheets serial numbers (e.g. 46293)
  if (/^\d{5}(\.\d+)?$/.test(v)) {
    const ms = Math.round((Number(v) - 25569) * 86400 * 1000);
    const d = new Date(ms);
    return withTime ? d.toISOString() : d.toISOString().slice(0, 10);
  }
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(v);
  if (!m) {
    const iso = Date.parse(v);
    if (Number.isNaN(iso)) return null;
    return withTime ? new Date(iso).toISOString() : new Date(iso).toISOString().slice(0, 10);
  }
  const [, mo, da, yr, hh = '0', mi = '0', ss = '0'] = m;
  const date = `${yr}-${mo.padStart(2, '0')}-${da.padStart(2, '0')}`;
  if (!withTime) return date;
  const iso = `${date}T${hh.padStart(2, '0')}:${mi}:${ss.padStart(2, '0')}${tzOffset}`;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function parseScore(v: string): number | null | 'invalid' {
  const s = (v ?? '').trim();
  if (s === '' || /^n\/?a$/i.test(s)) return null;
  if (!/^-?\d+(\.\d+)?$/.test(s)) return 'invalid';
  return Number(s);
}

const nameFromEmail = (email: string) =>
  email.split('@')[0].split(/[._-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

export function mapAuditRows(
  records: Record<string, string>[],
  taskTypes: MapperTaskType[],
  parameters: MapperParameter[],
  opts: { columnMap?: Partial<ColumnMap>; timezoneOffset?: string; firstRowNumber?: number } = {},
): MapperResult {
  const cm: ColumnMap = { ...DEFAULT_COLUMN_MAP, ...(opts.columnMap ?? {}) };
  const headers = records.length ? Object.keys(records[0]) : [];
  const headerByNorm = new Map(headers.map((h) => [norm(h), h]));
  const headerByKey = new Map<string, string>();
  for (const h of headers) if (!headerByKey.has(headerKey(h))) headerByKey.set(headerKey(h), h);
  const col = (name: string) => headerByNorm.get(norm(name)) ?? headerByKey.get(headerKey(name));
  const paramCol = (p: MapperParameter) => [p.source_column, ...(p.source_aliases ?? [])].filter(Boolean).map((c) => col(c as string)).find(Boolean);
  const missingColumns = REQUIRED_KEYS.filter((k) => !col(cm[k])).map((k) => cm[k]);
  const out: MapperResult = { rows: [], rejections: [], duplicates: [], missingColumns };
  if (missingColumns.length) return out;

  const typeByLabel = new Map(taskTypes.map((t) => [norm(t.source_label), t]));
  // Rubric versions per task type: the live ('current', active parameters) plus any archived versions.
  // A version is usable for this file when every one of its parameter columns is present.
  const versionsByType = new Map<string, { version: string; params: MapperParameter[] }[]>();
  for (const p of parameters) {
    const v = p.rubric_version ?? 'current';
    if (v === 'current' && !p.active) continue;
    const list = versionsByType.get(p.task_type) ?? [];
    let entry = list.find((x) => x.version === v);
    if (!entry) { entry = { version: v, params: [] }; list.push(entry); }
    entry.params.push(p);
    versionsByType.set(p.task_type, list);
  }
  for (const list of versionsByType.values()) list.sort((a, b) => (a.version === 'current' ? -1 : b.version === 'current' ? 1 : b.version.localeCompare(a.version)));
  const usable = new Map<string, { version: string; params: MapperParameter[]; cols: string[] }[]>();
  for (const [tt, list] of versionsByType) {
    usable.set(tt, list.map((v) => ({ ...v, cols: v.params.map((p) => paramCol(p) ?? '') })).filter((v) => v.cols.every(Boolean)));
  }
  const get = (r: Record<string, string>, name: string) => {
    const h = col(name);
    return h ? String(r[h] ?? '').trim() : '';
  };
  const first = opts.firstRowNumber ?? 2;

  records.forEach((r, i) => {
    const row_number = first + i;
    const reject = (reason: string) => out.rejections.push({ row_number, reason });
    const allBlank = Object.values(r).every((v) => String(v ?? '').trim() === '');
    if (allBlank) return;

    const link = get(r, cm.taskLink);
    if (!/^https?:\/\//i.test(link)) return reject('Missing or invalid DS Task Link');
    const task_id = /task\/([0-9a-f-]{36})/i.exec(link)?.[1] ?? link;
    const camRaw = get(r, cm.cam);
    if (!camRaw) return reject('CAM Name is empty');
    const camIsEmail = /^[^@\s]+@[^@\s]+$/.test(camRaw);
    const tt = typeByLabel.get(norm(get(r, cm.taskType)));
    if (!tt) return reject(`Unknown Task Type "${get(r, cm.taskType)}"`);
    const period = parseWeekLabel(get(r, cm.week));
    if (!period) return reject(`QA Week "${get(r, cm.week)}" is not in the format WK-n : yyyy (mm/dd - mm/dd)`);
    const audited_at = parseUsDate(get(r, cm.timestamp), true, opts.timezoneOffset);
    if (!audited_at) return reject('Invalid Timestamp');
    const scoreV = parseScore(get(r, cm.score));
    if (scoreV === null || scoreV === 'invalid' || scoreV < 0 || scoreV > 100) return reject('Score missing or outside 0-100');
    const afRaw = norm(get(r, cm.autofail));
    if (!['yes', 'no'].includes(afRaw)) return reject('Auto-Fail must be Yes or No');
    const autofail = afRaw === 'yes';

    const versions = usable.get(tt.code) ?? [];
    if (!versions.length) return reject(`The scoring columns for ${tt.code} are not in this sheet`);
    const hasValues = (v: { cols: string[] }) => v.cols.some((c) => String(r[c] ?? '').trim() !== '');
    const ver = versions.find(hasValues) ?? versions[0];
    const scores: ImportRow['scores'] = [];
    for (let k = 0; k < ver.params.length; k++) {
      const p = ver.params[k]; const h = ver.cols[k];
      const v = parseScore(String(r[h] ?? ''));
      if (v === 'invalid') return reject(`Parameter "${p.name}" has a non-numeric value "${r[h]}"`);
      if (v !== null && (v < 0 || v > p.max_score)) return reject(`Parameter "${p.name}" score ${v} exceeds max ${p.max_score}`);
      scores.push({ parameter_id: p.id, earned: v });
    }
    const applicable = scores.filter((s) => s.earned !== null);
    if (!applicable.length && !autofail) return reject('No parameter scores recorded for this task');
    const maxSum = applicable.reduce((a, s) => a + ver.params.find((p) => p.id === s.parameter_id)!.max_score, 0);
    const sum = applicable.reduce((a, s) => a + (s.earned as number), 0);
    if (autofail && scoreV !== 0) return reject('Auto-Fail = Yes but Score is not 0');
    if (!autofail && maxSum > 0 && Math.round((10000 * sum) / maxSum) / 100 !== Math.round(scoreV * 100) / 100) {
      return reject(`Score ${scoreV} does not match the parameter total ${Math.round((10000 * sum) / maxSum) / 100}`);
    }

    const fcrRaw = tt.fcr_column ? norm(get(r, tt.fcr_column)) : '';
    const evaluatorEmail = get(r, cm.evaluatorEmail).toLowerCase() || null;
    out.rows.push({
      row_number,
      task_link: link,
      task_id,
      cam_email: camIsEmail ? camRaw.toLowerCase() : '',
      cam_name: camIsEmail ? nameFromEmail(camRaw) : camRaw.replace(/\s+/g, ' ').trim(),
      lead_name: get(r, cm.leadName) || null,
      evaluator_email: evaluatorEmail,
      evaluator_name: get(r, cm.evaluatorName) || (evaluatorEmail ? nameFromEmail(evaluatorEmail) : null),
      task_type: tt.code,
      request_from: get(r, cm.requestFrom) || null,
      task_loaded_date: parseUsDate(get(r, cm.taskLoadedDate), false),
      audited_at,
      period,
      task_seq: get(r, cm.taskSeq) || null,
      connection_id: get(r, cm.connectionId) || null,
      screenshot_url: get(r, cm.screenshot) || null,
      autofail,
      fcr: fcrRaw === 'yes' ? 'Yes' : fcrRaw === 'no' ? 'No' : null,
      score: scoreV,
      feedback: (tt.feedback_column ? get(r, tt.feedback_column) : '') || null,
      scores,
    });
  });

  // Duplicates inside the same file (DS Task Link + CAM + QA Week)
  const seen = new Set<string>();
  out.rows = out.rows.filter((row) => {
    const k = `${row.task_link}|${row.cam_email || 'name:' + (row.cam_name ?? '').toLowerCase()}|${row.period.label}`;
    if (seen.has(k)) {
      out.duplicates.push({ row_number: row.row_number, reason: 'Duplicate of an earlier row in this file (same task link, CAM and week)' });
      return false;
    }
    seen.add(k);
    return true;
  });
  return out;
}
