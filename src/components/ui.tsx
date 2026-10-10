import { createContext, useCallback, useContext, useEffect, useId, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import clsx from 'clsx';
import { Info, Loader2, X, CheckCircle2, AlertTriangle, ArrowUpRight, ArrowDownRight, Minus, Check, XCircle } from 'lucide-react';
import { band, BAND_LABEL, fmtPct, fmtPp, METRIC_DEFINITIONS, APPEAL_STATUS_LABEL } from '../lib/metrics';
import type { AppealStatus, PortalSettings } from '../lib/types';

export function Button({ variant = 'primary', size = 'md', loading, className, children, ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'sm' | 'md'; loading?: boolean }) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      className={clsx(
        'inline-flex items-center justify-center gap-1.5 rounded font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap',
        size === 'sm' ? 'h-8 px-2.5 text-[13px]' : 'h-9 px-3.5 text-sm',
        variant === 'primary' && 'bg-brand text-brand-ink hover:bg-brand/90',
        variant === 'secondary' && 'border border-line bg-surface text-ink hover:bg-sunken',
        variant === 'ghost' && 'text-muted hover:bg-sunken hover:text-ink',
        variant === 'danger' && 'bg-bad text-white hover:bg-bad/90',
        className,
      )}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

export function Card({ title, subtitle, actions, children, className, pad = true }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; pad?: boolean }) {
  return (
    <section className={clsx('rounded-lg border border-line bg-surface min-w-0', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-2 border-b border-line px-4 py-3">
          <div className="min-w-0">
            {title && <h2 className="text-[15px] font-semibold text-ink">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-[13px] text-muted">{subtitle}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={pad ? 'p-4' : ''}>{children}</div>
    </section>
  );
}

const BAND_CLS = { green: 'bg-good-soft text-good', amber: 'bg-warn-soft text-warn', red: 'bg-bad-soft text-bad', none: 'bg-sunken text-muted' };
// A distinct icon per band so the result never depends on colour alone.
const BAND_ICON = { green: Check, amber: AlertTriangle, red: XCircle, none: null };
export function ScoreBadge({ score, settings, showLabel = false }: { score: number | null; settings: PortalSettings; showLabel?: boolean }) {
  const b = band(score, settings);
  const Icon = BAND_ICON[b];
  return (
    <span className={clsx('inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[13px] font-semibold tnum', BAND_CLS[b])} title={BAND_LABEL[b]}>
      {Icon && <Icon className="h-3 w-3 shrink-0" aria-hidden />}
      {fmtPct(score)}
      {!showLabel && b !== 'none' && <span className="sr-only">({BAND_LABEL[b]})</span>}
      {showLabel && <span className="font-medium">· {BAND_LABEL[b]}</span>}
    </span>
  );
}

export function Variance({ value }: { value: number | null }) {
  if (value === null) return <span className="text-faint">—</span>;
  const Icon = value > 0 ? ArrowUpRight : value < 0 ? ArrowDownRight : Minus;
  return (
    <span className={clsx('inline-flex items-center gap-0.5 whitespace-nowrap font-medium tnum', value > 0 ? 'text-good' : value < 0 ? 'text-bad' : 'text-muted')}>
      <Icon className="h-3.5 w-3.5" aria-hidden />{fmtPp(value)}
    </span>
  );
}

const STATUS_CLS: Record<AppealStatus, string> = {
  draft: 'bg-sunken text-muted',
  pending_lead_review: 'bg-info-soft text-info',
  returned_to_cam: 'bg-warn-soft text-warn',
  pending_qa_review: 'bg-brand-soft text-brand',
  pending_additional_info: 'bg-warn-soft text-warn',
  approved: 'bg-good-soft text-good',
  partially_approved: 'bg-good-soft text-good',
  rejected: 'bg-bad-soft text-bad',
  closed: 'bg-sunken text-muted',
};
export function StatusBadge({ status, overdue }: { status: AppealStatus; overdue?: boolean }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span className={clsx('rounded px-1.5 py-0.5 text-[12px] font-semibold', STATUS_CLS[status])}>{APPEAL_STATUS_LABEL[status]}</span>
      {overdue && <span className="rounded bg-bad text-white px-1.5 py-0.5 text-[11px] font-semibold">Overdue</span>}
    </span>
  );
}

export function Pill({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'info' | 'brand' }) {
  const cls = { neutral: 'bg-sunken text-muted', good: 'bg-good-soft text-good', warn: 'bg-warn-soft text-warn', bad: 'bg-bad-soft text-bad', info: 'bg-info-soft text-info', brand: 'bg-brand-soft text-brand' }[tone];
  return <span className={clsx('inline-flex items-center rounded px-1.5 py-0.5 text-[12px] font-semibold', cls)}>{children}</span>;
}

export function InfoTip({ term, text }: { term?: string; text?: string }) {
  const [open, setOpen] = useState(false);
  const body = text ?? (term ? METRIC_DEFINITIONS[term] : '');
  const id = useId();
  return (
    <span className="relative inline-flex">
      <button type="button" aria-describedby={open ? id : undefined} aria-label={`What is ${term ?? 'this'}?`} onClick={() => setOpen((o) => !o)} onBlur={() => setOpen(false)}
        className="text-faint hover:text-muted"><Info className="h-3.5 w-3.5" /></button>
      {open && (
        <span id={id} role="tooltip" className="absolute left-1/2 top-5 z-30 w-64 -translate-x-1/2 rounded border border-line bg-surface p-2.5 text-[12px] font-normal normal-case tracking-normal text-ink shadow-lg">
          {body}
        </span>
      )}
    </span>
  );
}

export function Kpi({ label, value, sub, term, tone }: { label: string; value: ReactNode; sub?: ReactNode; term?: string; tone?: 'good' | 'warn' | 'bad' | 'neutral' }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3 min-w-0">
      <div className="eyebrow flex items-center gap-1">{label}{term && <InfoTip term={term} />}</div>
      <div className={clsx('mt-1.5 text-[26px] leading-none font-semibold tnum', tone === 'good' && 'text-good', tone === 'warn' && 'text-warn', tone === 'bad' && 'text-bad')}>{value}</div>
      {sub && <div className="mt-1.5 text-[12.5px] text-muted">{sub}</div>}
    </div>
  );
}

export function EmptyState({ title, body, action }: { title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-line px-6 py-10 text-center">
      <p className="font-semibold text-ink">{title}</p>
      {body && <p className="max-w-md text-[13px] text-muted">{body}</p>}
      {action}
    </div>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <div className="flex items-center gap-2 p-6 text-muted" role="status"><Loader2 className="h-4 w-4 animate-spin" />{label}</div>;
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div role="alert" className="flex items-start gap-2 rounded border border-bad/30 bg-bad-soft px-3 py-2 text-[13px] text-bad">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{error instanceof Error ? error.message : String(error)}</span>
    </div>
  );
}

export function Field({ label, htmlFor, hint, children, required }: { label: string; htmlFor: string; hint?: ReactNode; children: ReactNode; required?: boolean }) {
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <label htmlFor={htmlFor} className="text-[13px] font-medium text-ink">{label}{required && <span className="text-bad"> *</span>}</label>
      {children}
      {hint && <p className="text-[12px] text-muted">{hint}</p>}
    </div>
  );
}
export const inputBase = 'h-9 rounded border border-line bg-surface px-2.5 text-sm text-ink placeholder:text-faint focus:border-brand focus:outline-none';
export const inputCls = inputBase + ' w-full';
export const textareaCls = 'w-full rounded border border-line bg-surface px-2.5 py-2 text-sm text-ink placeholder:text-faint focus:border-brand focus:outline-none';

export function Modal({ open, title, onClose, children, footer, wide }: { open: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={title} className={clsx('flex max-h-[92vh] w-full flex-col rounded-t-lg bg-surface shadow-xl sm:rounded-lg', wide ? 'sm:max-w-3xl' : 'sm:max-w-lg')}>
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="font-semibold">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="text-muted hover:text-ink"><X className="h-5 w-5" /></button>
        </div>
        <div className="overflow-y-auto px-4 py-4">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line px-4 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmModal({ open, title, body, confirmLabel, danger, confirmDisabled, onConfirm, onClose }: { open: boolean; title: string; body: ReactNode; confirmLabel: string; danger?: boolean; confirmDisabled?: boolean; onConfirm: () => Promise<void> | void; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  return (
    <Modal open={open} title={title} onClose={onClose} footer={<>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button variant={danger ? 'danger' : 'primary'} loading={busy} disabled={confirmDisabled} onClick={async () => { setBusy(true); setErr(null); try { await onConfirm(); onClose(); } catch (e) { setErr(e); } finally { setBusy(false); } }}>{confirmLabel}</Button>
    </>}>
      <div className="flex flex-col gap-3 text-sm">{body}<ErrorBox error={err} /></div>
    </Modal>
  );
}

// ---------------------------------------------------------------- toasts
type Toast = { id: number; text: string; tone: 'good' | 'bad' | 'info' };
const ToastCtx = createContext<(text: string, tone?: Toast['tone']) => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: Toast['tone'] = 'good') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex max-w-sm flex-col gap-2" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={clsx('pointer-events-auto flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm shadow-lg bg-surface',
            t.tone === 'good' && 'border-good/40', t.tone === 'bad' && 'border-bad/40', t.tone === 'info' && 'border-info/40')}>
            {t.tone === 'bad' ? <AlertTriangle className="h-4 w-4 text-bad mt-0.5" /> : <CheckCircle2 className={clsx('h-4 w-4 mt-0.5', t.tone === 'good' ? 'text-good' : 'text-info')} />}
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: ReactNode }[] }) {
  return (
    <div role="tablist" className="flex gap-1 overflow-x-auto border-b border-line">
      {tabs.map((t) => (
        <button key={t.value} role="tab" aria-selected={value === t.value} onClick={() => onChange(t.value)}
          className={clsx('-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium', value === t.value ? 'border-brand text-brand' : 'border-transparent text-muted hover:text-ink')}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx('overflow-x-auto', className)}><table className="w-full border-collapse text-left text-[13px]">{children}</table></div>;
}
export const th = 'border-b border-line bg-sunken/60 px-3 py-2 text-[11.5px] font-semibold uppercase tracking-wide text-muted whitespace-nowrap';
export const td = 'border-b border-line px-3 py-2 align-top';

export function Pagination({ page, pages, onPage }: { page: number; pages: number; onPage: (p: number) => void }) {
  if (pages <= 1) return null;
  return (
    <div className="flex items-center justify-end gap-2 px-3 py-2 text-[13px] text-muted">
      <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</Button>
      <span className="tnum">Page {page} of {pages}</span>
      <Button size="sm" variant="secondary" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</Button>
    </div>
  );
}

export function Sparkline({ values, settings }: { values: (number | null)[]; settings: PortalSettings }) {
  const w = 84, h = 24;
  const pts = values.map((v, i) => ({ v, x: values.length > 1 ? (i * (w - 6)) / (values.length - 1) + 3 : w / 2 }));
  const lo = 50;
  const y = (v: number) => h - 3 - ((Math.max(lo, v) - lo) / (100 - lo)) * (h - 6);
  const segs: string[] = [];
  let cur = '';
  for (const p of pts) {
    if (p.v === null) { if (cur) segs.push(cur); cur = ''; continue; }
    cur += `${cur ? 'L' : 'M'}${p.x.toFixed(1)},${y(p.v).toFixed(1)}`;
  }
  if (cur) segs.push(cur);
  const last = [...pts].reverse().find((p) => p.v !== null);
  const tgt = y(settings.qa_target.score);
  return (
    <svg width={w} height={h} role="img" aria-label={`Trend: ${values.map((v) => (v === null ? 'no data' : v.toFixed(0))).join(', ')}`}>
      <line x1={0} x2={w} y1={tgt} y2={tgt} stroke="rgb(var(--line))" strokeDasharray="2 2" />
      {segs.map((d, i) => <path key={i} d={d} fill="none" stroke="rgb(var(--brand))" strokeWidth={1.5} />)}
      {last && last.v !== null && <circle cx={last.x} cy={y(last.v)} r={2.5} fill="rgb(var(--brand))" />}
    </svg>
  );
}
