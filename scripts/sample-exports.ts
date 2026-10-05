// Generates sample PDF / XLSX / CSV exports from the fictional demo data (for review).
import { writeFileSync, mkdirSync } from 'node:fs';
import { DemoRepo } from '../src/data/demoRepo';
import { DEMO_PASSWORD } from '../src/demo/generate';
import { buildReport, reportToCsv, reportToPdf, reportToXlsx } from '../src/lib/report';
import { buildSelection, inPeriods } from '../src/lib/metrics';

const out = process.argv[2] ?? 'sample-exports';
mkdirSync(out, { recursive: true });
const r = new DemoRepo();
async function make(email: string, kind: 'cam' | 'team' | 'org', name: string) {
  const me = await r.signIn(email, DEMO_PASSWORD);
  const [periodsAll, parameters, settings, taskTypes, teams, employees] = await Promise.all([r.getPeriods(), r.getParameters(), r.getSettings(), r.getTaskTypes(), r.getTeams(), r.getEmployees()]);
  const periods = periodsAll.filter((p) => p.status === 'published').sort((a, b) => a.start_date.localeCompare(b.start_date));
  const sel = buildSelection(periods, 'week');
  const hw = periods.slice(-12);
  const evals = await r.getEvaluations({ periodIds: hw.map((p) => p.id) });
  const appeals = await r.listAppeals();
  const cams = kind === 'cam' ? undefined : employees.filter((e) => e.role === 'user' && (kind === 'org' || teams.some((t) => t.id === e.team_id && t.lead_id === me.id)));
  const m = buildReport({ kind, subject: kind === 'cam' ? me.full_name : kind === 'team' ? `${me.team_name ?? teams.find((t) => t.lead_id === me.id)?.name}` : 'All teams', sel,
    cur: inPeriods(evals, sel.current), prev: inPeriods(evals, sel.previous), history: evals, historyWeeks: hw, appeals, parameters, settings,
    taskTypeNames: Object.fromEntries(taskTypes.map((t) => [t.code, t.name])), generatedBy: me.full_name, cams, teams, employees });
  writeFileSync(`${out}/${name}.pdf`, Buffer.from(await (await reportToPdf(m)).arrayBuffer()));
  writeFileSync(`${out}/${name}.xlsx`, Buffer.from(await (await reportToXlsx(m)).arrayBuffer()));
  writeFileSync(`${out}/${name}.csv`, Buffer.from(await reportToCsv(m).arrayBuffer()));
  console.log('wrote', name, m.evaluations.length, 'tasks');
}
await make('marcus.webb@demo.csqa.test', 'cam', 'DEMO_CAM_Report_Marcus_Webb');
await make('daniel.brooks@demo.csqa.test', 'team', 'DEMO_Team_Report_Harbor');
await make('maya.raman@demo.csqa.test', 'org', 'DEMO_Consolidated_Report');
