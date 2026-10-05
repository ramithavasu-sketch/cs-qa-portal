import { useEffect, useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis, LabelList,
} from 'recharts';
import type { TrendPoint, ParamStat } from '../lib/metrics';
import { fmtPct } from '../lib/metrics';
import type { PortalSettings } from '../lib/types';

function readVar(name: string) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v ? `rgb(${v.split(/\s+/).join(',')})` : '#888';
}
/** Resolved token colours (SVG presentation attributes can't use CSS variables). */
export function useThemeColors() {
  const read = () => ({ brand: readVar('--brand'), line: readVar('--line'), muted: readVar('--muted'), ink: readVar('--ink'), good: readVar('--good'),
    warn: readVar('--warn'), bad: readVar('--bad'), surface: readVar('--surface'), faint: readVar('--faint') });
  const [c, setC] = useState(read);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const upd = () => setC(read());
    mq.addEventListener('change', upd);
    const mo = new MutationObserver(upd);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => { mq.removeEventListener('change', upd); mo.disconnect(); };
  }, []);
  return c;
}

const tooltipStyle = (c: ReturnType<typeof useThemeColors>) => ({
  contentStyle: { background: c.surface, border: `1px solid ${c.line}`, borderRadius: 6, fontSize: 12, color: c.ink },
  labelStyle: { color: c.ink, fontWeight: 600 },
});

export function TrendChart({ points, settings, selectedIds = [], height = 260 }: { points: TrendPoint[]; settings: PortalSettings; selectedIds?: string[]; height?: number }) {
  const c = useThemeColors();
  const data = points.map((p) => ({ ...p, value: p.avg, selected: selectedIds.includes(p.periodId) }));
  const values = points.map((p) => p.avg).filter((v): v is number => v !== null);
  const min = Math.max(0, Math.floor(Math.min(settings.thresholds.amber - 5, ...values) / 5) * 5);
  if (!points.length) return null;
  return (
    <div>
      <div style={{ height }} role="img" aria-label={`Weekly QA score trend: ${points.map((p) => `${p.label} ${p.avg === null ? 'No Data' : p.avg.toFixed(2) + '%'}`).join(', ')}`}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 16, right: 16, bottom: 4, left: -8 }}>
            <CartesianGrid vertical={false} stroke={c.line} />
            <XAxis dataKey="label" tick={{ fill: c.muted, fontSize: 11 }} tickLine={false} axisLine={{ stroke: c.line }} />
            <YAxis domain={[min, 100]} tick={{ fill: c.muted, fontSize: 11 }} tickLine={false} axisLine={false} unit="%" width={48} />
            <ReferenceLine y={settings.qa_target.score} stroke={c.good} strokeDasharray="4 4"
              label={{ value: `Target ${settings.qa_target.score}%`, position: 'insideTopRight', fill: c.good, fontSize: 11 }} />
            <Tooltip {...tooltipStyle(c)} formatter={(_v, _n, item) => {
              const p = item.payload as TrendPoint;
              return [p.avg === null ? 'No Data' : `${p.avg.toFixed(2)}% · ${p.tasks} task${p.tasks === 1 ? '' : 's'} · ${p.autofails} autofail${p.autofails === 1 ? '' : 's'}`, 'Average'];
            }} />
            <Line type="monotone" dataKey="value" stroke={c.brand} strokeWidth={2} connectNulls={false}
              dot={(props: { cx?: number; cy?: number; payload?: { selected: boolean; value: number | null }; index?: number }) => {
                const { cx, cy, payload, index } = props;
                if (cx === undefined || cy === undefined || payload?.value === null || payload?.value === undefined) return <g key={index} />;
                return <circle key={index} cx={cx} cy={cy} r={payload.selected ? 5.5 : 3.5} fill={payload.selected ? c.brand : c.surface} stroke={c.brand} strokeWidth={2} />;
              }} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-1 overflow-x-auto">
        <table className="w-full text-[11.5px] text-muted tnum">
          <tbody>
            <tr>{points.map((p) => <td key={p.periodId} className="px-1 text-center">{p.label}</td>)}</tr>
            <tr>{points.map((p) => <td key={p.periodId} className={`px-1 text-center font-medium ${p.avg === null ? 'text-faint' : 'text-ink'}`}>{p.avg === null ? 'No Data' : p.avg.toFixed(1)}</td>)}</tr>
            <tr>{points.map((p) => <td key={p.periodId} className="px-1 text-center">{p.tasks} task{p.tasks === 1 ? '' : 's'}</td>)}</tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function ParameterBars({ stats, settings, onSelect }: { stats: ParamStat[]; settings: PortalSettings; onSelect?: (s: ParamStat) => void }) {
  const c = useThemeColors();
  const data = stats.filter((s) => s.evaluated > 0).map((s) => ({ name: s.parameter.name, pct: s.pct ?? 0, stat: s }));
  if (!data.length) return null;
  const color = (p: number) => (p >= settings.thresholds.green ? c.good : p >= settings.thresholds.amber ? c.warn : c.bad);
  return (
    <div style={{ height: Math.max(120, data.length * 34 + 30) }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 56, bottom: 4, left: 4 }}>
          <CartesianGrid horizontal={false} stroke={c.line} />
          <XAxis type="number" domain={[0, 100]} unit="%" tick={{ fill: c.muted, fontSize: 11 }} tickLine={false} axisLine={{ stroke: c.line }} />
          <YAxis type="category" dataKey="name" width={170} tick={{ fill: c.ink, fontSize: 11.5 }} tickLine={false} axisLine={false} />
          <ReferenceLine x={settings.qa_target.score} stroke={c.good} strokeDasharray="4 4" />
          <Tooltip {...tooltipStyle(c)} cursor={{ fill: c.line, opacity: 0.35 }} formatter={(_v, _n, item) => {
            const s = (item.payload as { stat: ParamStat }).stat;
            return [`${fmtPct(s.pct)} · ${s.earned}/${s.max} pts · ${s.deductions} deduction${s.deductions === 1 ? '' : 's'} in ${s.evaluated}`, 'Achieved'];
          }} />
          <Bar dataKey="pct" radius={[0, 3, 3, 0]} isAnimationActive={false} onClick={(d) => onSelect?.((d as unknown as { stat: ParamStat }).stat)} cursor={onSelect ? 'pointer' : undefined}>
            {data.map((d) => <Cell key={d.stat.parameter.id} fill={color(d.pct)} />)}
            <LabelList dataKey="pct" position="right" formatter={(v: unknown) => `${Number(v).toFixed(1)}%`} style={{ fill: c.ink, fontSize: 11 }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
