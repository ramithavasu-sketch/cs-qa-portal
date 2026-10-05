import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import {
  LayoutDashboard, ListChecks, BarChart3, FileText, Download, Scale, Bell, Users, UsersRound, SlidersHorizontal,
  CalendarCog, Upload, ScrollText, Mail, LogOut, Menu, X, ShieldCheck,
} from 'lucide-react';
import { useApp, useAsync } from '../app/context';
import { repo, demoRepo, localRepo } from '../data';
import { AutoSheetSync } from './SheetSync';
import { fmtDateTime } from '../lib/metrics';

const ROLE_LABEL = { super_admin: 'QA · Super Admin', admin: 'Team Lead · Admin', user: 'CAM · User' } as const;

interface NavItem { to: string; label: string; icon: typeof LayoutDashboard; roles?: ('super_admin' | 'admin' | 'user')[] }
const MAIN: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/evaluations', label: 'Task Evaluations', icon: ListChecks },
  { to: '/parameters', label: 'Parameter Analysis', icon: BarChart3 },
  { to: '/reports', label: 'Weekly & Monthly Reports', icon: FileText },
  { to: '/downloads', label: 'Download Reports', icon: Download },
  { to: '/appeals', label: 'Appeals', icon: Scale },
  { to: '/notifications', label: 'Notifications', icon: Bell },
];
const ADMIN: NavItem[] = [
  { to: '/admin/users', label: 'Users & Roles', icon: Users },
  { to: '/admin/teams', label: 'Teams & Assignments', icon: UsersRound },
  { to: '/admin/scoring', label: 'Scoring Configuration', icon: SlidersHorizontal },
  { to: '/admin/periods', label: 'Reporting & Settings', icon: CalendarCog },
  { to: '/admin/emails', label: 'Weekly Report Emails', icon: Mail },
  { to: '/admin/import', label: 'Data Import', icon: Upload },
  { to: '/admin/audit', label: 'Audit Logs', icon: ScrollText },
];

export default function Layout() {
  const { me, signOut, dataVersion } = useApp();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  if (!me) return null;
  const isSuper = me.role === 'super_admin';

  return (
    <div className="flex min-h-full">
      {/* sidebar */}
      <aside className={clsx('fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-line bg-surface transition-transform lg:translate-x-0',
        open ? 'translate-x-0' : '-translate-x-full')} style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}>
        <div className="flex h-14 items-center gap-2 border-b border-line px-4">
          <ShieldCheck className="h-5 w-5 text-brand" aria-hidden />
          <div className="leading-tight">
            <div className="text-[14px] font-bold">CS QA Portal</div>
            <div className="text-[11px] text-muted">Client Services Quality</div>
          </div>
          <button className="ml-auto lg:hidden" onClick={() => setOpen(false)} aria-label="Close menu"><X className="h-5 w-5" /></button>
        </div>
        <nav className="flex-1 overflow-y-auto px-2 py-3" aria-label="Main">
          <NavGroup items={MAIN} />
          {isSuper && (<><div className="eyebrow px-3 pb-1 pt-4">QA administration</div><NavGroup items={ADMIN} /></>)}
        </nav>
        <div className="border-t border-line p-3 text-[12px] text-muted">
          <div className="font-medium text-ink">{me.full_name}</div>
          <div>{ROLE_LABEL[me.role]}</div>
          {me.team_name && <div>{me.team_name}{me.role === 'user' && me.lead_name ? ` · Lead: ${me.lead_name}` : ''}</div>}
          <button onClick={() => signOut()} className="mt-2 inline-flex items-center gap-1.5 font-medium text-ink hover:text-brand"><LogOut className="h-4 w-4" />Sign out</button>
        </div>
      </aside>
      {open && <div className="fixed inset-0 z-30 bg-black/30 lg:hidden" onClick={() => setOpen(false)} />}

      <div className="flex min-w-0 flex-1 flex-col lg:pl-64">
        {demoRepo && <DemoBanner />}
        {localRepo && <LocalBanner />}
        {localRepo && isSuper && <AutoSheetSync />}
        <header className="sticky z-20 flex h-14 items-center gap-3 border-b border-line bg-surface/95 px-4 backdrop-blur" style={{ top: 'env(safe-area-inset-top, 0px)' }}>
          <button className="lg:hidden" onClick={() => setOpen(true)} aria-label="Open menu"><Menu className="h-5 w-5" /></button>
          <div className="min-w-0 flex-1 truncate text-[13px] text-muted">
            <span className="font-semibold text-ink">{me.full_name}</span>
            <span className="hidden sm:inline"> · {ROLE_LABEL[me.role]}{me.team_name ? ` · ${me.team_name}` : ''}</span>
          </div>
          <NotificationBell key={dataVersion} />
        </header>
        <main className="mx-auto w-full max-w-[1320px] flex-1 px-4 py-5 sm:px-6"><Outlet /></main>
        <footer className="px-6 pb-6 text-[11.5px] text-faint">Confidential — internal QA performance data. Access is limited by role and logged.</footer>
      </div>
    </div>
  );
}

function NavGroup({ items }: { items: NavItem[] }) {
  return (
    <ul className="flex flex-col gap-0.5">
      {items.map((it) => (
        <li key={it.to}>
          <NavLink to={it.to} end={it.to === '/'} className={({ isActive }) => clsx('flex items-center gap-2.5 rounded px-3 py-2 text-[13.5px] font-medium',
            isActive ? 'bg-brand-soft text-brand' : 'text-muted hover:bg-sunken hover:text-ink')}>
            <it.icon className="h-4 w-4" aria-hidden />{it.label}
          </NavLink>
        </li>
      ))}
    </ul>
  );
}

function NotificationBell() {
  const nav = useNavigate();
  const { bump } = useApp();
  const [open, setOpen] = useState(false);
  const { data } = useAsync(() => repo.listNotifications(), [open]);
  const unread = (data ?? []).filter((n) => !n.read_at);
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} className="relative rounded p-2 text-muted hover:bg-sunken hover:text-ink" aria-label={`Notifications, ${unread.length} unread`}>
        <Bell className="h-5 w-5" />
        {unread.length > 0 && <span className="absolute right-1 top-1 min-w-[16px] rounded-full bg-bad px-1 text-center text-[10px] font-bold leading-4 text-white tnum">{unread.length}</span>}
      </button>
      {open && (
        <div className="absolute right-0 top-11 z-40 w-[min(92vw,360px)] rounded-lg border border-line bg-surface shadow-xl">
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <span className="font-semibold text-sm">Notifications</span>
            <button className="text-[12px] text-brand hover:underline" onClick={async () => { await repo.markNotificationsRead(); bump(); }}>Mark all read</button>
          </div>
          <ul className="max-h-96 overflow-y-auto">
            {(data ?? []).slice(0, 8).map((n) => (
              <li key={n.id}>
                <button className={clsx('block w-full px-3 py-2.5 text-left hover:bg-sunken', !n.read_at && 'bg-brand-soft/40')}
                  onClick={async () => { setOpen(false); await repo.markNotificationsRead([n.id]); bump(); if (n.link) nav(n.link.replace('/dashboard', '/')); }}>
                  <div className="text-[13px] font-medium">{n.title}</div>
                  <div className="text-[12px] text-muted">{n.message}</div>
                  <div className="mt-0.5 text-[11px] text-faint">{fmtDateTime(n.created_at)}</div>
                </button>
              </li>
            ))}
            {(data ?? []).length === 0 && <li className="px-3 py-6 text-center text-[13px] text-muted">No notifications yet.</li>}
          </ul>
          <button className="w-full border-t border-line px-3 py-2 text-[13px] font-medium text-brand hover:bg-sunken" onClick={() => { setOpen(false); nav('/notifications'); }}>View all</button>
        </div>
      )}
    </div>
  );
}

function DemoBanner() {
  const { signOut } = useApp();
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-warn-soft px-4 py-1.5 text-[12.5px] text-warn">
      <strong>Demo mode</strong>
      <span>Fictional people and sample audits only. Changes stay in this browser.</span>
      {confirm ? (
        <span className="flex gap-2">
          <button className="font-semibold underline" onClick={() => { demoRepo!.resetDemo(); signOut(); }}>Confirm reset</button>
          <button className="underline" onClick={() => setConfirm(false)}>Cancel</button>
        </span>
      ) : <button className="font-semibold underline" onClick={() => setConfirm(true)}>Reset demo data</button>}
    </div>
  );
}

function LocalBanner() {
  const { signOut } = useApp();
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-info-soft px-4 py-1.5 text-[12.5px] text-info">
      <strong>Local review mode</strong>
      <span>Real audit data, stored only in this browser on this computer. Only you, and people you set a password for, can sign in — on this computer only. No emails are sent.</span>
      {confirm ? (
        <span className="flex gap-2">
          <button className="font-semibold underline" onClick={async () => { await localRepo!.deleteLocalData(); await signOut(); location.reload(); }}>Yes, delete everything</button>
          <button className="underline" onClick={() => setConfirm(false)}>Cancel</button>
        </span>
      ) : <button className="font-semibold underline" onClick={() => setConfirm(true)}>Delete local data</button>}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-[22px] font-bold leading-tight text-ink">{title}</h1>
        {subtitle && <p className="mt-1 text-[13.5px] text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
