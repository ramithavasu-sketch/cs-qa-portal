import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowDown, ArrowUp, Search } from 'lucide-react';
import { Pagination, Pill, ScoreBadge, Sparkline, Table, td, th, Variance, inputBase, InfoTip } from './ui';
import type { CamRow } from '../lib/metrics';
import type { PortalSettings } from '../lib/types';

type Key = 'name' | 'lead' | 'tasks' | 'avg' | 'prev' | 'variance' | 'autofails' | 'appeals';
const val = (r: CamRow, k: Key): string | number => {
  switch (k) {
    case 'name': return r.cam.full_name.toLowerCase();
    case 'lead': return r.leadName.toLowerCase();
    case 'tasks': return r.tasks;
    case 'avg': return r.avg ?? -1;
    case 'prev': return r.prevAvg ?? -1;
    case 'variance': return r.variance ?? -999;
    case 'autofails': return r.autofails;
    case 'appeals': return r.appeals;
  }
};

export function CamTable({ rows, settings, showLead = true, pageSize = 15 }: { rows: CamRow[]; settings: PortalSettings; showLead?: boolean; pageSize?: number }) {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<{ k: Key; dir: 1 | -1 }>({ k: 'avg', dir: 1 });
  const [page, setPage] = useState(1);
  const filtered = useMemo(() => rows
    .filter((r) => !q || r.cam.full_name.toLowerCase().includes(q.toLowerCase()) || r.leadName.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => {
      const x = val(a, sort.k); const y = val(b, sort.k);
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
    }), [rows, q, sort]);
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const cur = filtered.slice((page - 1) * pageSize, page * pageSize);
  const H = ({ k, children, right }: { k: Key; children: React.ReactNode; right?: boolean }) => (
    <th className={th + (right ? ' text-right' : '')} aria-sort={sort.k === k ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button className="inline-flex items-center gap-0.5 uppercase" onClick={() => setSort((s) => ({ k, dir: s.k === k ? (s.dir === 1 ? -1 : 1) : k === 'name' || k === 'lead' ? 1 : -1 }))}>
        {children}{sort.k === k && (sort.dir === 1 ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
      </button>
    </th>
  );
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-faint" />
          <label htmlFor="cam-search" className="sr-only">Search CAMs</label>
          <input id="cam-search" className={inputBase + ' w-64 pl-8'} placeholder="Search CAM or Team Lead" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        </div>
        <span className="text-[12px] text-muted tnum">{filtered.length} CAM(s)</span>
      </div>
      <Table>
        <thead><tr>
          <H k="name">CAM Name</H>{showLead && <H k="lead">Team Lead</H>}<H k="tasks" right>Tasks Audited</H><H k="avg" right>Average QA Score</H>
          <H k="prev" right>Previous Period</H><H k="variance" right>Score Variance</H><H k="autofails" right>Autofails</H><H k="appeals" right>Appeals</H>
          <th className={th}>Appeal Status</th><th className={th}><span className="inline-flex items-center gap-1">Trend <InfoTip text="Last 6 audit weeks. Dashed line = QA target. Gaps = No Data." /></span></th>
        </tr></thead>
        <tbody>
          {cur.map((r) => (
            <tr key={r.cam.id} className="cursor-pointer hover:bg-sunken/60" onClick={() => nav(`/cams/${r.cam.id}`)}>
              <td className={td}>
                <button className="whitespace-nowrap font-medium text-ink hover:text-brand" onClick={(e) => { e.stopPropagation(); nav(`/cams/${r.cam.id}`); }}>{r.cam.full_name}</button>
                {r.needsAttention && <div className="mt-0.5 flex flex-wrap gap-1">{r.attentionReasons.map((x) => <Pill key={x} tone="warn">{x}</Pill>)}</div>}
              </td>
              {showLead && <td className={td + ' whitespace-nowrap text-muted'}>{r.leadName}</td>}
              <td className={td + ' text-right tnum'}>{r.tasks}</td>
              <td className={td + ' text-right'}>{r.tasks ? <ScoreBadge score={r.avg} settings={settings} /> : <span className="text-faint">No Data</span>}</td>
              <td className={td + ' text-right tnum text-muted'}>{r.prevAvg === null ? 'No Data' : `${r.prevAvg.toFixed(2)}%`}</td>
              <td className={td + ' text-right'}><Variance value={r.variance} /></td>
              <td className={td + ' text-right tnum'}>{r.autofails ? <span className="font-semibold text-bad">{r.autofails}</span> : 0}</td>
              <td className={td + ' text-right tnum'}>{r.appeals}</td>
              <td className={td + ' whitespace-nowrap text-[12.5px]'}>{r.appealsOpen ? <Pill tone="info">{r.appealSummary}</Pill> : <span className="text-muted">{r.appealSummary}</span>}</td>
              <td className={td}><Sparkline values={r.trend} settings={settings} /></td>
            </tr>
          ))}
          {cur.length === 0 && <tr><td colSpan={10} className="px-3 py-8 text-center text-muted">No CAMs match these filters.</td></tr>}
        </tbody>
      </Table>
      <Pagination page={page} pages={pages} onPage={setPage} />
    </div>
  );
}
