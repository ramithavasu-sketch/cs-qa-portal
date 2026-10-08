import { HashRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, type ReactNode } from 'react';
import { AppProvider, useApp } from './app/context';
import { ToastProvider, Loading } from './components/ui';
import Layout from './components/Layout';
import { LoginPage, ForgotPasswordPage, ResetPasswordPage } from './pages/Auth';
import CamDashboard from './pages/CamDashboard';
import LeadDashboard from './pages/LeadDashboard';
import MyAuditsPage from './pages/MyAudits';
import QaDashboard from './pages/QaDashboard';
import { EvaluationsPage, EvaluationDetailPage } from './pages/Evaluations';
import { AppealsPage, NewAppealPage } from './pages/Appeals';
import AppealDetailPage from './pages/AppealDetail';
import { ReportsPage, DownloadsPage } from './pages/Reports';
import { ParametersPage, NotificationsPage } from './pages/Misc';
import { UsersPage, TeamsPage, ScoringPage, PeriodsPage, ImportPage, AuditLogPage } from './pages/Admin';
import WeeklyEmailsPage from './pages/WeeklyEmails';
import type { Role } from './lib/types';

function RequireAuth({ children }: { children: ReactNode }) {
  const { me, ref, loading } = useApp();
  const loc = useLocation();
  if (loading || (me && !ref)) return <Loading label="Loading portal…" />;
  if (!me) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  if (me.must_change_password) return <Navigate to="/reset-password" replace />;
  return <>{children}</>;
}
/** UI-level guard only; the database enforces the same rules (RLS + RPC checks). */
function RequireRole({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { me } = useApp();
  if (!me || !roles.includes(me.role)) return <div className="p-8 text-center"><h1 className="text-lg font-semibold">You don’t have access to this page</h1><p className="text-muted">This area is limited to {roles.map((r) => (r === 'super_admin' ? 'QA Super Admins' : r === 'evaluator' ? 'QA Evaluators' : r === 'admin' ? 'Team Leads' : 'CAMs')).join(', ')}.</p></div>;
  return <>{children}</>;
}
function HomeByRole() {
  const { me } = useApp();
  if (me!.role === 'super_admin' || me!.role === 'evaluator') return <QaDashboard />;
  if (me!.role === 'admin') return <LeadDashboard />;
  return <CamDashboard />;
}
function RecoveryWatcher() {
  const { recovery } = useApp();
  const nav = useNavigate();
  useEffect(() => { if (recovery) nav('/reset-password'); }, [recovery, nav]);
  return null;
}
function LoginRoute() {
  const { me, loading } = useApp();
  if (loading) return <Loading />;
  return me ? <Navigate to="/" replace /> : <LoginPage />;
}

export default function App() {
  const QA: Role[] = ['super_admin'];                    // portal administration
  const QA_STAFF: Role[] = ['super_admin', 'evaluator'];  // QA work shared with Evaluators
  const STAFF: Role[] = ['super_admin', 'evaluator', 'admin'];
  return (
    <AppProvider>
      <ToastProvider>
        <HashRouter>
          <RecoveryWatcher />
          <Routes>
            <Route path="/login" element={<LoginRoute />} />
            <Route path="/forgot-password" element={<ForgotPasswordPage />} />
            <Route path="/reset-password" element={<ResetPasswordPage />} />
            <Route element={<RequireAuth><Layout /></RequireAuth>}>
              <Route index element={<HomeByRole />} />
              <Route path="cams/:camId" element={<RequireRole roles={STAFF}><CamDashboard /></RequireRole>} />
              <Route path="evaluations" element={<EvaluationsPage />} />
              <Route path="evaluations/:id" element={<EvaluationDetailPage />} />
              <Route path="parameters" element={<ParametersPage />} />
              <Route path="reports" element={<ReportsPage />} />
              <Route path="downloads" element={<DownloadsPage />} />
              <Route path="appeals" element={<AppealsPage />} />
              <Route path="appeals/new" element={<RequireRole roles={['user']}><NewAppealPage /></RequireRole>} />
              <Route path="appeals/:id" element={<AppealDetailPage />} />
              <Route path="notifications" element={<NotificationsPage />} />
              <Route path="admin/users" element={<RequireRole roles={QA}><UsersPage /></RequireRole>} />
              <Route path="admin/teams" element={<RequireRole roles={QA}><TeamsPage /></RequireRole>} />
              <Route path="admin/scoring" element={<RequireRole roles={QA}><ScoringPage /></RequireRole>} />
              <Route path="admin/periods" element={<RequireRole roles={QA_STAFF}><PeriodsPage /></RequireRole>} />
              <Route path="admin/emails" element={<RequireRole roles={QA_STAFF}><WeeklyEmailsPage /></RequireRole>} />
              <Route path="my-audits" element={<RequireRole roles={QA_STAFF}><MyAuditsPage /></RequireRole>} />
              <Route path="admin/import" element={<RequireRole roles={QA}><ImportPage /></RequireRole>} />
              <Route path="admin/audit" element={<RequireRole roles={QA}><AuditLogPage /></RequireRole>} />
              <Route path="*" element={<div className="p-8 text-center text-muted">Page not found.</div>} />
            </Route>
          </Routes>
        </HashRouter>
      </ToastProvider>
    </AppProvider>
  );
}
