import type {
  Appeal, AppealDetail, AppealFilter, AuditLog, Employee, Evaluation, EvaluationFilter, ExtraAdjustmentInput,
  ImportBatch, ImportRejection, LeadRecommendation, Me, NotificationRow, Parameter, Period, PortalSettings,
  QaDecisionInput, Role, ScoreAdjustment, SubmitAppealItem, TaskType, Team, WeeklyEmailRow, WeeklyEmailResult, TeamMappingRow, TeamMappingResult, HistoricalCam, SheetSyncResult,
} from '../lib/types';
import type { ImportRow } from '../../supabase/functions/_shared/mapper';
import type { SetupFile } from './demoRepo';

/**
 * Every screen talks to the backend through this interface.
 *  - SupabaseRepo: production. Reads are filtered by Postgres RLS; every state
 *    change is a SECURITY DEFINER RPC that re-checks role and status.
 *  - DemoRepo: in-browser store with fictional data that mirrors the same rules,
 *    used for the public demo only.
 */
export interface Repo {
  /** google = Google Workspace version (Apps Script web app, Google sign-in, data in the owner's Drive). */
  readonly mode: 'supabase' | 'demo' | 'local' | 'google';

  // ---- auth
  currentUser(): Promise<Me | null>;
  signIn(email: string, password: string): Promise<Me>;
  signOut(): Promise<void>;
  requestPasswordReset(email: string): Promise<void>;
  updatePassword(password: string): Promise<void>;
  onAuthEvent(cb: (event: 'SIGNED_IN' | 'SIGNED_OUT' | 'PASSWORD_RECOVERY') => void): () => void;

  // ---- reference data
  getSettings(): Promise<PortalSettings>;
  getTaskTypes(): Promise<TaskType[]>;
  getParameters(): Promise<Parameter[]>;
  getPeriods(): Promise<Period[]>;
  getTeams(): Promise<Team[]>;
  getEmployees(): Promise<Employee[]>;

  // ---- evaluations
  getEvaluations(filter: EvaluationFilter): Promise<Evaluation[]>;
  getEvaluation(id: string): Promise<Evaluation | null>;
  getAdjustments(evaluationId: string): Promise<ScoreAdjustment[]>;
  getAppealDeadline(evaluationId: string): Promise<string | null>;

  // ---- appeals
  listAppeals(filter?: AppealFilter): Promise<Appeal[]>;
  getAppeal(id: string): Promise<AppealDetail | null>;
  submitAppeal(evaluationId: string, reason: string, items: SubmitAppealItem[], asDraft?: boolean): Promise<string>;
  submitDraftAppeal(appealId: string): Promise<void>;
  /** CAM: change a draft's reason and disputed parameters before submitting it. */
  updateDraftAppeal(appealId: string, reason: string, items: SubmitAppealItem[]): Promise<void>;
  /** Lead (author) or QA: make an internal comment visible to the CAM. */
  shareAppealComment(eventId: string): Promise<void>;
  leadReviewAppeal(appealId: string, rec: LeadRecommendation, comment: string, internalNote?: string): Promise<void>;
  respondToAppealRequest(appealId: string, response: string): Promise<void>;
  addAppealComment(appealId: string, comment: string, internal: boolean): Promise<void>;
  qaRequestInfo(appealId: string, from: 'cam' | 'lead', comment: string): Promise<void>;
  qaDecideAppeal(appealId: string, decisions: QaDecisionInput[], resolution: string, extra?: ExtraAdjustmentInput[]): Promise<string>;
  qaReopenAppeal(appealId: string, reason: string): Promise<void>;
  closeAppeal(appealId: string, reason: string): Promise<void>;
  grantResubmission(evaluationId: string, parameterId: string | null, isAutofail: boolean, reason: string): Promise<void>;
  uploadEvidence(appealId: string, file: File): Promise<void>;
  evidenceUrl(storagePath: string): Promise<string>;

  // ---- QA administration
  adminAdjustScore(evaluationId: string, parameterId: string | null, revised: number, reason: string): Promise<void>;
  setPeriodStatus(periodId: string, status: 'draft' | 'published'): Promise<void>;
  upsertPeriod(p: Partial<Period> & { label: string; start_date: string; end_date: string }): Promise<void>;
  updateSetting<K extends keyof PortalSettings>(key: K, value: PortalSettings[K]): Promise<void>;
  updateParameter(id: string, patch: Partial<Pick<Parameter, 'name' | 'max_score' | 'active' | 'sort_order' | 'section' | 'criteria'>>): Promise<void>;
  createParameter(p: Omit<Parameter, 'id'>): Promise<void>;
  upsertEmployee(e: Partial<Employee> & { email: string; full_name: string; role: Role }): Promise<void>;
  inviteUser(employeeId: string): Promise<void>;
  /** Super Admin only: set a temporary password for a user (they must change it at first sign-in). */
  setUserPassword(employeeId: string, password: string): Promise<void>;
  upsertTeam(t: Partial<Team> & { name: string }): Promise<void>;
  deleteTeam(id: string): Promise<void>;
  importEvaluations(rows: ImportRow[], meta: { source: 'csv' | 'xlsx' | 'google_sheets'; file_name: string; publish_new_periods: boolean },
    onProgress?: (done: number, total: number) => void): Promise<{ batch_id: string; total: number; inserted: number; duplicates: number; rejected: number }>;
  /** Server-side sync (deployed portal): scope 'live' = live form, 'all' = live + archive tabs. */
  syncGoogleSheet(scope: 'live' | 'all' | string[]): Promise<SheetSyncResult[]>;
  listImportBatches(): Promise<ImportBatch[]>;
  listImportRejections(batchId: string): Promise<ImportRejection[]>;
  /** Records a report download in the audit log (best effort; never blocks the download). */
  logExport(info: { scope: string; period: string; format: string }): Promise<void>;
  listAuditLogs(opts: { limit: number; offset: number; table?: string; action?: string; actorId?: string; from?: string; to?: string; record?: string }): Promise<AuditLog[]>;

  // ---- weekly report emails & team mapping
  weeklyEmailPreview(periodId: string): Promise<WeeklyEmailRow[]>;
  sendWeeklyEmails(periodId: string, camIds: string[] | null, resend: boolean): Promise<WeeklyEmailResult>;
  importTeamMapping(rows: TeamMappingRow[]): Promise<TeamMappingResult>;

  // ---- archived (name-only) CAMs
  historicalCams(): Promise<HistoricalCam[]>;
  mergeEmployee(fromId: string, intoId: string): Promise<{ moved: number }>;

  // ---- moving from local review to the Google version (local and google modes only)
  exportSetup?(): Promise<SetupFile>;
  importSetup?(file: SetupFile): Promise<{ employees: number; teams: number }>;

  // ---- notifications
  listNotifications(): Promise<NotificationRow[]>;
  markNotificationsRead(ids?: string[]): Promise<void>;
}

