import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { repo } from '../data';
import type { Employee, Me, Parameter, Period, PortalSettings, TaskType, Team } from '../lib/types';

interface RefData {
  settings: PortalSettings; taskTypes: TaskType[]; parameters: Parameter[]; periods: Period[]; teams: Team[]; employees: Employee[];
  taskTypeNames: Record<string, string>;
  publishedPeriods: Period[];
}
interface AppCtx {
  me: Me | null;
  ref: RefData | null;
  loading: boolean;
  recovery: boolean;
  setRecovery: (v: boolean) => void;
  signIn: (email: string, pw: string) => Promise<void>;
  signOut: (reason?: string) => Promise<void>;
  reloadRef: () => Promise<void>;
  dataVersion: number;
  bump: () => void;
  signedOutReason: string | null;
  refreshMe: () => Promise<void>;
}
const Ctx = createContext<AppCtx>(null as unknown as AppCtx);
export const useApp = () => useContext(Ctx);
export const useRef_ = () => {
  const { ref } = useApp();
  if (!ref) throw new Error('Reference data not loaded');
  return ref;
};

const IDLE_MIN = Number(import.meta.env.VITE_IDLE_TIMEOUT_MINUTES ?? 30) || 30;

export function AppProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [ref, setRef] = useState<RefData | null>(null);
  const [loading, setLoading] = useState(true);
  const [recovery, setRecovery] = useState(false);
  const [dataVersion, setDataVersion] = useState(0);
  const [signedOutReason, setSignedOutReason] = useState<string | null>(null);
  const bump = useCallback(() => setDataVersion((v) => v + 1), []);

  const loadRef = useCallback(async () => {
    const [settings, taskTypes, parameters, periods, teams, employees] = await Promise.all([
      repo.getSettings(), repo.getTaskTypes(), repo.getParameters(), repo.getPeriods(), repo.getTeams(), repo.getEmployees(),
    ]);
    const taskTypeNames = Object.fromEntries(taskTypes.map((t) => [t.code, t.name]));
    const sorted = [...periods].sort((a, b) => a.start_date.localeCompare(b.start_date));
    setRef({ settings, taskTypes, parameters, periods: sorted, teams, employees, taskTypeNames, publishedPeriods: sorted.filter((p) => p.status === 'published') });
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const u = await repo.currentUser();
        if (!alive) return;
        setMe(u);
        if (u) await loadRef();
      } catch (e) {
        console.error(e);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    const off = repo.onAuthEvent((ev) => {
      if (ev === 'PASSWORD_RECOVERY') setRecovery(true);
      if (ev === 'SIGNED_OUT') { setMe(null); setRef(null); }
    });
    return () => { alive = false; off(); };
  }, [loadRef]);

  const signIn = useCallback(async (email: string, pw: string) => {
    const u = await repo.signIn(email, pw);
    setSignedOutReason(null);
    setMe(u);
    await loadRef();
  }, [loadRef]);
  const refreshMe = useCallback(async () => { setMe(await repo.currentUser()); }, []);
  const signOut = useCallback(async (reason?: string) => {
    await repo.signOut();
    setMe(null); setRef(null);
    setSignedOutReason(reason ?? null);
  }, []);

  // Session expiry on inactivity.
  const last = useRef(Date.now());
  useEffect(() => {
    if (!me) return;
    const touch = () => { last.current = Date.now(); };
    const evs = ['mousemove', 'keydown', 'click', 'touchstart', 'scroll'];
    evs.forEach((e) => window.addEventListener(e, touch, { passive: true }));
    const t = setInterval(() => {
      if (Date.now() - last.current > IDLE_MIN * 60000) signOut(`You were signed out after ${IDLE_MIN} minutes of inactivity.`);
    }, 30000);
    return () => { evs.forEach((e) => window.removeEventListener(e, touch)); clearInterval(t); };
  }, [me, signOut]);

  const value = useMemo(() => ({ me, ref, loading, recovery, setRecovery, signIn, signOut, reloadRef: loadRef, dataVersion, bump, signedOutReason, refreshMe }),
    [me, ref, loading, recovery, signIn, signOut, loadRef, dataVersion, bump, signedOutReason, refreshMe]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Small async data hook that re-runs when deps or the global data version change. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const { dataVersion } = useApp();
  const [state, setState] = useState<{ data: T | null; error: unknown; loading: boolean }>({ data: null, error: null, loading: true });
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    fn().then((data) => alive && setState({ data, error: null, loading: false }))
      .catch((error) => alive && setState({ data: null, error, loading: false }));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, dataVersion]);
  return state;
}
