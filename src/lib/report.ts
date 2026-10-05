// Builds one report model from already-authorised data, then renders it as PDF,
// Excel or CSV. Because the input rows come from RLS-filtered queries, an export
// can never contain data the user cannot see on screen.
import { buildInsights, camRows, fmtDate, fmtDateTime, fmtPct, fmtPp, parameterStats, summarize, variance, weeklyTrend,
  APPEAL_STATUS_LABEL, type Insights, type PeriodSelection, type Summary, type TrendPoint, type ParamStat, type CamRow } from './metrics';
import type { Appeal, Employee, Evaluation, Parameter, Period, PortalSettings, Team } from './types';

export interface ReportModel {
  kind: 'cam' | 'team' | 'org';
  title: string; subject: string; periodLabel: string; previousLabel: string; generatedAt: string; generatedBy: string;
  summary: Summary; prevSummary: Summary; variance: number | null;
  trend: TrendPoint[]; params: ParamStat[]; insights: Insights | null; camTable: CamRow[] | null;
  evaluations: Evaluation[]; appeals: Appeal[]; parameters: Parameter[]; settings: PortalSettings; taskTypeNames: Record<string, string>;
}

export function buildReport(args: {
  kind: ReportModel['kind']; subject: string; sel: PeriodSelection; cur: Evaluation[]; prev: Evaluation[]; history: Evaluation[];
  historyWeeks: Period[]; appeals: Appeal[]; parameters: Parameter[]; settings: PortalSettings; taskTypeNames: Record<string, string>;
  generatedBy: string; cams?: Employee[]; teams?: Team[]; employees?: Employee[];
}): ReportModel {
  const s = summarize(args.cur);
  const ps = summarize(args.prev);
  const curIds = new Set(args.cur.map((e) => e.id));
  return {
    kind: args.kind,
    title: args.kind === 'cam' ? 'CS QA Performance Report' : args.kind === 'team' ? 'CS QA Team Performance Report' : 'CS QA Consolidated Report',
    subject: args.subject, periodLabel: args.sel.label, previousLabel: args.sel.previousLabel,
    generatedAt: new Date().toISOString(), generatedBy: args.generatedBy,
    summary: s, prevSummary: ps, variance: variance(s.avg, ps.avg),
    trend: weeklyTrend(args.history, args.historyWeeks),
    params: parameterStats(args.cur, args.parameters, args.taskTypeNames).filter((p) => p.evaluated > 0),
    insights: args.kind === 'cam' ? buildInsights(args.cur, args.prev, args.history, args.historyWeeks, args.parameters, args.taskTypeNames, args.settings) : null,
    camTable: args.cams ? camRows(args.cams, args.teams ?? [], args.employees ?? [], args.cur, args.prev, args.history, args.historyWeeks, args.appeals, args.settings) : null,
    evaluations: [...args.cur].sort((a, b) => a.audited_at.localeCompare(b.audited_at)),
    appeals: args.appeals.filter((a) => curIds.has(a.evaluation_id)),
    parameters: args.parameters, settings: args.settings, taskTypeNames: args.taskTypeNames,
  };
}

const CONFIDENTIAL = 'CONFIDENTIAL — Internal CS QA performance data. For the named recipient(s) only. Do not forward.';
const fileBase = (m: ReportModel) => `CS_QA_${m.kind === 'cam' ? 'Report' : m.kind === 'team' ? 'Team_Report' : 'Consolidated'}_${m.subject.replace(/[^\w]+/g, '_')}_${m.periodLabel.replace(/[^\w]+/g, '_')}`.replace(/_+/g, '_');

function taskRows(m: ReportModel) {
  const allParams = [...m.parameters].sort((a, b) => a.task_type.localeCompare(b.task_type) || a.sort_order - b.sort_order);
  const header = ['Audit Week', 'Audited On', 'CAM', 'CAM Email', 'Team Lead', 'Task Type', 'Request From', 'Task ID', 'DS Task Link', 'Task Loaded',
    'QA Evaluator', 'Score', 'Original Score', 'Adjusted', 'Autofail', 'FCR', ...allParams.map((p) => `${m.taskTypeNames[p.task_type]} · ${p.name} [${p.max_score}]`), 'QA Feedback'];
  const rows = m.evaluations.map((e) => [e.period_short_label, fmtDateTime(e.audited_at), e.cam_name, e.cam_email, e.lead_name ?? '', e.task_type_name,
    e.request_from ?? '', e.task_id, e.task_link, e.task_loaded_date ?? '', e.evaluator_name ?? '', e.score, e.original_score, e.adjusted ? 'Yes' : 'No',
    e.autofail ? 'Yes' : 'No', e.fcr ?? '',
    ...allParams.map((p) => { const s = e.scores.find((x) => x.parameter_id === p.id); return s ? (s.earned === null ? 'NA' : s.earned) : ''; }), e.feedback ?? '']);
  return { header, rows };
}

// ------------------------------------------------------------------ CSV
export function reportToCsv(m: ReportModel): Blob {
  const { header, rows } = taskRows(m);
  const esc = (v: unknown) => {
    let s = String(v ?? '');
    if (/^[=+\-@]/.test(s)) s = "'" + s; // prevent spreadsheet formula injection
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header, ...rows].map((r) => r.map(esc).join(','));
  return new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
}

// ------------------------------------------------------------------ XLSX
export async function reportToXlsx(m: ReportModel): Promise<Blob> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'CS QA Performance Portal';
  wb.created = new Date();
  const headStyle = (ws: import('exceljs').Worksheet, row = 1) => {
    const r = ws.getRow(row);
    r.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0E7478' } };
    r.alignment = { vertical: 'middle', wrapText: true };
    ws.views = [{ state: 'frozen', ySplit: row }];
  };

  const sum = wb.addWorksheet('Summary');
  sum.columns = [{ width: 34 }, { width: 22 }, { width: 22 }, { width: 18 }];
  sum.addRow([m.title]).font = { bold: true, size: 14 };
  sum.addRow([m.subject]);
  sum.addRow([`Period: ${m.periodLabel}   ·   Compared with: ${m.previousLabel}`]);
  sum.addRow([`Generated ${fmtDateTime(m.generatedAt)} by ${m.generatedBy}`]);
  sum.addRow([CONFIDENTIAL]).font = { italic: true, color: { argb: 'FFBA2828' } };
  sum.addRow([]);
  const h = sum.addRow(['Metric', 'Current period', 'Comparison period', 'Variance']);
  h.font = { bold: true };
  sum.addRow(['Tasks audited', m.summary.tasks, m.prevSummary.tasks, m.summary.tasks - m.prevSummary.tasks]);
  sum.addRow(['Average QA score (%)', m.summary.avg ?? 'No Data', m.prevSummary.avg ?? 'No Data', m.variance === null ? '—' : fmtPp(m.variance)]);
  sum.addRow(['Autofails', m.summary.autofails, m.prevSummary.autofails, m.summary.autofails - m.prevSummary.autofails]);
  sum.addRow(['FCR rate (%)', m.summary.fcrRate ?? 'No Data', m.prevSummary.fcrRate ?? 'No Data', fmtPp(variance(m.summary.fcrRate, m.prevSummary.fcrRate))]);
  sum.addRow(['QA target (%)', m.settings.qa_target.score]);
  sum.addRow([]);
  sum.addRow(['Weekly trend']).font = { bold: true };
  sum.addRow(['Week', 'Average (%)', 'Tasks', 'Autofails']).font = { bold: true };
  m.trend.forEach((t) => sum.addRow([t.label, t.avg ?? 'No Data', t.tasks, t.autofails]));

  if (m.camTable) {
    const ws = wb.addWorksheet('CAM Summary');
    ws.columns = [
      { header: 'CAM', width: 24 }, { header: 'Team', width: 18 }, { header: 'Team Lead', width: 20 }, { header: 'Tasks Audited', width: 12 },
      { header: 'Average QA Score (%)', width: 14 }, { header: 'Previous Period (%)', width: 14 }, { header: 'Variance (pp)', width: 12 },
      { header: 'Autofails', width: 10 }, { header: 'Appeals', width: 10 }, { header: 'Appeal Status', width: 16 }, { header: 'Needs attention', width: 28 },
    ];
    m.camTable.filter((r) => r.tasks || r.prevAvg !== null).forEach((r) => ws.addRow([r.cam.full_name, r.teamName, r.leadName, r.tasks, r.avg ?? 'No Data', r.prevAvg ?? 'No Data',
      r.variance ?? '—', r.autofails, r.appeals, r.appealSummary, r.attentionReasons.join('; ')]));
    headStyle(ws);
  }

  const ps = wb.addWorksheet('Parameters');
  ps.columns = [{ header: 'Task Type', width: 16 }, { header: 'Parameter', width: 44 }, { header: 'Max Score', width: 10 }, { header: 'Times Evaluated', width: 14 },
    { header: 'Deductions', width: 11 }, { header: 'Points Earned', width: 13 }, { header: 'Points Possible', width: 14 }, { header: '% Achieved', width: 11 }];
  m.params.forEach((p) => ps.addRow([p.taskTypeName, p.parameter.name, p.parameter.max_score, p.evaluated, p.deductions, p.earned, p.max, p.pct]));
  headStyle(ps);

  const { header, rows } = taskRows(m);
  const ts = wb.addWorksheet('Task Details');
  ts.addRow(header);
  rows.forEach((r) => ts.addRow(r));
  ts.columns.forEach((c, i) => { c.width = i === header.length - 1 ? 80 : i === 8 ? 40 : 14; });
  headStyle(ts);

  const as = wb.addWorksheet('Appeals');
  as.columns = [{ header: 'Reference', width: 18 }, { header: 'CAM', width: 22 }, { header: 'Task ID', width: 38 }, { header: 'Audit Week', width: 10 },
    { header: 'Disputed', width: 30 }, { header: 'Status', width: 22 }, { header: 'Submitted', width: 18 }, { header: 'Decided', width: 18 }, { header: 'Resolution', width: 60 }];
  m.appeals.forEach((a) => as.addRow([a.reference, a.cam_name, a.task_id, a.period_short_label, a.parameters_label ?? '', APPEAL_STATUS_LABEL[a.status],
    fmtDateTime(a.submitted_at), fmtDateTime(a.decided_at), a.resolution_note ?? '']));
  headStyle(as);

  if (m.insights) {
    const is = wb.addWorksheet('Strengths & Focus');
    is.columns = [{ header: 'Section', width: 22 }, { header: 'Parameter', width: 44 }, { header: 'Detail (from recorded scores)', width: 90 }];
    const add = (label: string, list: Insights['strengths']) => list.forEach((i) => is.addRow([label, `${i.stat.parameter.name} (${i.stat.taskTypeName})`, i.detail]));
    add('Strength', m.insights.strengths); add('Improvement area', m.insights.improvements); add('Recurring finding', m.insights.recurring);
    add('Positive trend', m.insights.positive); add('Declining trend', m.insights.declining); add('Recommended focus', m.insights.focus);
    headStyle(is);
  }
  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

// ------------------------------------------------------------------ PDF
// Standard PDF fonts only cover WinAnsi; map the few symbols we use.
export const pdfSafe = (v: unknown) => String(v ?? '').replace(/≥/g, '>=').replace(/≤/g, '<=').replace(/−/g, '-').replace(/→/g, '->')
  .replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/±/g, '+/-');

export async function reportToPdf(m: ReportModel): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const rawText = doc.text.bind(doc);
  (doc as unknown as { text: (...a: unknown[]) => unknown }).text = (t: unknown, ...rest: unknown[]) =>
    (rawText as unknown as (...a: unknown[]) => unknown)(Array.isArray(t) ? t.map(pdfSafe) : pdfSafe(t), ...rest);
  const W = doc.internal.pageSize.getWidth();
  const M = 40;
  const teal: [number, number, number] = [14, 116, 120];
  const inkC: [number, number, number] = [22, 33, 36];
  const mutedC: [number, number, number] = [84, 99, 103];
  let y = 0;

  // header band
  doc.setFillColor(...teal); doc.rect(0, 0, W, 86, 'F');
  doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(18);
  doc.text(m.title, M, 38);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(11);
  doc.text(`${m.subject}  ·  ${m.periodLabel}`, M, 58);
  doc.setFontSize(8.5);
  doc.text(`Compared with ${m.previousLabel}  ·  Generated ${fmtDateTime(m.generatedAt)} by ${m.generatedBy}`, M, 74);
  y = 108;

  // KPI boxes
  const kpis: [string, string, string][] = [
    ['Average QA score', fmtPct(m.summary.avg), `Previous ${fmtPct(m.prevSummary.avg)}`],
    ['Variance', fmtPp(m.variance), 'percentage points'],
    ['Tasks audited', String(m.summary.tasks), `Previous ${m.prevSummary.tasks}`],
    ['Autofails', String(m.summary.autofails), m.summary.autofailRate === null ? '—' : `${m.summary.autofailRate.toFixed(2)}% of tasks`],
    ['FCR rate', fmtPct(m.summary.fcrRate), `${m.summary.fcrYes}/${m.summary.fcrTotal} tasks`],
  ];
  const bw = (W - 2 * M - 4 * 8) / 5;
  kpis.forEach(([l, v, s], i) => {
    const x = M + i * (bw + 8);
    doc.setDrawColor(218, 225, 225); doc.setFillColor(248, 250, 250); doc.roundedRect(x, y, bw, 58, 4, 4, 'FD');
    doc.setTextColor(...mutedC); doc.setFontSize(7.5); doc.text(l.toUpperCase(), x + 8, y + 14);
    doc.setTextColor(...inkC); doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.text(v, x + 8, y + 34);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(...mutedC); doc.text(s, x + 8, y + 49);
  });
  y += 76;
  doc.setFontSize(8); doc.setTextColor(...mutedC);
  doc.text(`QA target ${m.settings.qa_target.score}%. Colour bands: on target ≥ ${m.settings.thresholds.green}%, needs attention ≥ ${m.settings.thresholds.amber}%, otherwise below target. Variance is shown in percentage points.`, M, y, { maxWidth: W - 2 * M });
  y += 18;

  const section = (t: string) => {
    if (y > 740) { doc.addPage(); y = 50; }
    doc.setTextColor(...teal); doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.text(t, M, y); doc.setFont('helvetica', 'normal'); y += 8;
  };
  const table = (head: string[], body: (string | number)[][], opts: Record<string, unknown> = {}) => {
    autoTable(doc, {
      startY: y, head: [head.map(pdfSafe)], body: body.map((r) => r.map(pdfSafe)), margin: { left: M, right: M }, styles: { fontSize: 8, cellPadding: 4, textColor: inkC, lineColor: [218, 225, 225], lineWidth: 0.5 },
      headStyles: { fillColor: teal, textColor: 255, fontStyle: 'bold' }, alternateRowStyles: { fillColor: [246, 248, 248] }, ...opts,
    });
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 18;
  };

  section('Weekly performance trend');
  table(['Week', ...m.trend.map((t) => t.label)], [
    ['Average', ...m.trend.map((t) => (t.avg === null ? 'No Data' : t.avg.toFixed(2)))],
    ['Tasks', ...m.trend.map((t) => t.tasks)],
    ['Autofails', ...m.trend.map((t) => t.autofails)],
  ], { styles: { fontSize: 7.5, cellPadding: 3, halign: 'center' } });

  if (m.camTable) {
    section(m.kind === 'team' ? 'CAM comparison' : 'CAM performance');
    table(['CAM', 'Team Lead', 'Tasks', 'Avg %', 'Prev %', 'Variance', 'Autofails', 'Appeals'],
      m.camTable.filter((r) => r.tasks || r.prevAvg !== null).sort((a, b) => (b.avg ?? -1) - (a.avg ?? -1))
        .map((r) => [r.cam.full_name, r.leadName, r.tasks, r.avg === null ? 'No Data' : r.avg.toFixed(2), r.prevAvg === null ? 'No Data' : r.prevAvg.toFixed(2), fmtPp(r.variance), r.autofails, r.appealSummary]));
  }

  section('Parameter-level results');
  table(['Task type', 'Parameter', 'Max', 'Evaluated', 'Deductions', 'Earned / Possible', '% Achieved'],
    m.params.map((p) => [p.taskTypeName, p.parameter.name, p.parameter.max_score, p.evaluated, p.deductions, `${p.earned} / ${p.max}`, fmtPct(p.pct)]));

  if (m.insights) {
    section('Strengths and improvement areas');
    doc.setFontSize(7.5); doc.setTextColor(...mutedC);
    doc.text('Automated summary derived only from recorded scores. Official coaching feedback is the QA feedback on each task below.', M, y + 4); y += 12;
    const rows: string[][] = [];
    const add = (l: string, list: Insights['strengths'], n = 5) => list.slice(0, n).forEach((i) => rows.push([l, `${i.stat.parameter.name} (${i.stat.taskTypeName})`, i.detail]));
    add('Recommended focus', m.insights.focus, 3); add('Improvement area', m.insights.improvements); add('Recurring finding', m.insights.recurring);
    add('Declining trend', m.insights.declining); add('Positive trend', m.insights.positive); add('Strength', m.insights.strengths);
    if (rows.length) table(['Section', 'Parameter', 'Detail'], rows, { columnStyles: { 0: { cellWidth: 90 }, 1: { cellWidth: 150 } } });
    else { doc.setFontSize(9); doc.text('No findings for this period.', M, y + 6); y += 24; }
  }

  section(`Task-level audit details (${m.evaluations.length})`);
  if (m.evaluations.length) {
    table(['Week', 'Audited', m.kind === 'cam' ? 'Type' : 'CAM', 'Task ID', 'Score', 'AF', 'Deducted parameters', 'QA feedback'],
      m.evaluations.map((e) => [e.period_short_label, fmtDate(e.audited_at), m.kind === 'cam' ? e.task_type_name : `${e.cam_name}\n${e.task_type_name}`,
        e.task_id.slice(0, 8), `${e.score}${e.adjusted ? '*' : ''}`, e.autofail ? 'Yes' : '',
        e.scores.filter((s) => s.earned !== null && s.earned < s.max_score).map((s) => `${s.parameter_name} (${s.earned}/${s.max_score})`).join(', '),
        e.feedback ?? '']),
      { columnStyles: { 0: { cellWidth: 34 }, 1: { cellWidth: 52 }, 2: { cellWidth: 60 }, 3: { cellWidth: 44 }, 4: { cellWidth: 30 }, 5: { cellWidth: 20 }, 6: { cellWidth: 90 } }, styles: { fontSize: 7, cellPadding: 3 } });
    doc.setFontSize(7); doc.setTextColor(...mutedC); doc.text('* score changed after an approved appeal or QA correction; the original score is retained in the audit history.', M, y - 6); y += 10;
  }

  section(`Appeals (${m.appeals.length})`);
  if (m.appeals.length) {
    table(['Reference', 'CAM', 'Disputed', 'Status', 'Submitted', 'Resolution'],
      m.appeals.map((a) => [a.reference, a.cam_name, a.parameters_label ?? '', APPEAL_STATUS_LABEL[a.status], fmtDate(a.submitted_at), a.resolution_note ?? '']));
  } else { doc.setFontSize(9); doc.setTextColor(...mutedC); doc.text('No appeals for this period.', M, y + 6); }

  // footer on every page
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFontSize(7); doc.setTextColor(186, 40, 40);
    doc.text(CONFIDENTIAL, M, 820);
    doc.setTextColor(...mutedC);
    doc.text(`Page ${i} of ${pages}`, W - M, 820, { align: 'right' });
  }
  return doc.output('blob');
}

export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export async function downloadReport(m: ReportModel, format: 'pdf' | 'xlsx' | 'csv') {
  const base = fileBase(m);
  if (format === 'pdf') saveBlob(await reportToPdf(m), `${base}.pdf`);
  else if (format === 'xlsx') saveBlob(await reportToXlsx(m), `${base}.xlsx`);
  else saveBlob(reportToCsv(m), `${base}.csv`);
}
