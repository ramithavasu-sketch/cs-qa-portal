import type { PortalSettings } from '../../supabase/functions/_shared/rubric';
export type { PortalSettings };

export type Role = 'super_admin' | 'evaluator' | 'admin' | 'user';
export type AppealStatus =
  | 'draft' | 'pending_lead_review' | 'returned_to_cam' | 'pending_qa_review'
  | 'pending_additional_info' | 'approved' | 'partially_approved' | 'rejected' | 'closed';
export type ItemDecision = 'pending' | 'approved' | 'rejected';
export type LeadRecommendation = 'recommend_approval' | 'recommend_rejection' | 'request_more_info';

export interface Employee {
  id: string;
  email: string;
  full_name: string;
  role: Role;
  status: 'active' | 'inactive';
  team_id: string | null;
  auth_user_id?: string | null;
  is_demo?: boolean;
}

export interface Me extends Employee {
  team_name: string | null;
  lead_name: string | null;
  /** Signed in with a password the QA team set: must choose their own before continuing. */
  must_change_password?: boolean;
}

export interface Team { id: string; name: string; lead_id: string | null }

export interface TaskType {
  code: string; name: string; source_label: string; feedback_column: string | null;
  fcr_column: string | null; sort_order: number; active: boolean;
}

export interface Parameter {
  id: string; task_type: string; name: string; section: string | null; max_score: number;
  sort_order: number; source_column: string | null; active: boolean;
  rubric_version?: string; source_aliases?: string[];
  /** Scoring guidance shown during appeals. */
  criteria?: string | null;
}

export interface Period {
  id: string; label: string; short_label: string; year: number; week_number: number;
  start_date: string; end_date: string; status: 'draft' | 'published';
  published_at: string | null; auto_publish_at: string | null;
  /** Optional fixed appeal deadline for this week (overrides the appeal-window rule). */
  appeal_closes_at?: string | null;
}

export interface ScoreRow {
  id: string; evaluation_id: string; parameter_id: string; parameter_name: string; section: string | null;
  sort_order: number; max_score: number; original_earned: number | null; earned: number | null;
  adjusted: boolean; remarks: string | null;
}

export interface Evaluation {
  id: string; task_id: string; task_link: string; cam_id: string; evaluator_id: string | null;
  evaluator_email: string | null; evaluator_name: string | null; task_type: string; task_type_name: string;
  request_from: string | null; task_loaded_date: string | null; audited_at: string; period_id: string;
  period_label: string; period_short_label: string; period_start: string; period_end: string;
  period_status: 'draft' | 'published'; published_at: string | null; task_seq: string | null;
  connection_id: string | null; screenshot_url: string | null; fcr: 'Yes' | 'No' | null; feedback: string | null;
  cam_name: string; cam_email: string; team_id: string | null; team_name: string | null; lead_id: string | null;
  lead_name: string | null; original_autofail: boolean; original_score: number; autofail: boolean;
  score: number; adjusted: boolean;
  scores: ScoreRow[];
}

export interface ScoreAdjustment {
  id: string; evaluation_id: string; kind: 'parameter' | 'autofail'; parameter_id: string | null;
  original_value: number; revised_value: number; reason: string; appeal_id: string | null;
  approved_by: string; approved_by_name?: string | null; created_at: string;
}

export interface Appeal {
  id: string; reference: string; evaluation_id: string; cam_id: string; lead_id: string | null;
  status: AppealStatus; reason: string; info_requested_from: 'cam' | 'lead' | null; info_due_at: string | null;
  lead_recommendation: LeadRecommendation | null; submitted_at: string | null; forwarded_at: string | null;
  decided_at: string | null; decided_by: string | null; resolution_note: string | null;
  status_changed_at: string; created_at: string;
  // joined
  task_id: string; task_link: string; task_type: string; period_id: string; period_label: string;
  period_short_label: string; audited_at: string; evaluator_name: string | null; original_score: number;
  cam_name: string; cam_email: string; lead_name: string | null; days_in_status: number; overdue: boolean;
  item_count?: number; parameters_label?: string;
  /** Disputed parameter ids ('AF' for the autofail flag). */
  disputed_keys?: string[];
}

export interface AppealItem {
  id: string; appeal_id: string; parameter_id: string | null; is_autofail: boolean;
  original_score: number | null; requested_score: number | null; decision: ItemDecision;
  revised_score: number | null; decision_reason: string | null; decided_by: string | null; decided_at: string | null;
}

export interface AppealEvent {
  id: string; appeal_id: string; actor_id: string | null; actor_name?: string | null; actor_role: Role | null;
  action: string; recommendation: LeadRecommendation | null; comment: string | null;
  visibility: 'shared' | 'internal'; from_status: AppealStatus | null; to_status: AppealStatus | null; created_at: string;
}

export interface Evidence {
  id: string; appeal_id: string; storage_path: string; file_name: string; mime_type: string;
  size_bytes: number; uploaded_by: string; created_at: string;
}

export interface AppealDetail {
  appeal: Appeal; items: AppealItem[]; events: AppealEvent[]; evidence: Evidence[]; evaluation: Evaluation | null;
}

export interface NotificationRow {
  id: string; type: string; title: string; message: string; link: string | null; appeal_id: string | null;
  read_at: string | null; created_at: string;
}

export interface AuditLog {
  id: number; actor_id: string | null; actor_name?: string | null; action: string; table_name: string | null;
  record_id: string | null; previous: unknown; new_value: unknown; reason: string | null; created_at: string;
}

export interface ImportBatch {
  id: string; source: string; file_name: string | null; uploaded_by: string | null; total_rows: number;
  inserted: number; duplicates: number; rejected: number; created_at: string;
}
export interface ImportRejection { row_number: number; reason: string }

export interface EvaluationFilter {
  periodIds?: string[];
  camIds?: string[];
}

export interface AppealFilter {
  statuses?: AppealStatus[];
  camId?: string;
  leadId?: string;
  evaluationId?: string;
}

export interface SubmitAppealItem { parameter_id?: string; is_autofail?: boolean; requested_score?: number | null }
export interface QaDecisionInput { item_id: string; decision: 'approved' | 'rejected'; revised_score?: number | null; reason?: string }
export interface ExtraAdjustmentInput { parameter_id: string; revised_score: number; reason: string }

export interface WeeklyEmailRow {
  cam_id: string; cam_name: string; cam_email: string; cam_active: boolean; lead_name: string | null; lead_email: string | null;
  tasks: number; last_status: 'queued' | 'sent' | 'failed' | 'skipped' | null; last_sent_at: string | null; last_error: string | null; last_queued_at: string | null;
}
export interface WeeklyEmailResult { queued: number; skipped: number; no_email: number; sent: number; failed: number; failures: { to: string; error: string }[] }
export interface TeamMappingRow { cam_email: string; cam_name?: string; lead_email: string; lead_name?: string; team?: string }
export interface TeamMappingResult { rows: number; new_leads: number; new_teams: number; new_cams: number; reassigned: number; rejected: number; errors: { row: number; reason: string }[] }
export interface HistoricalCam { id: string; name: string; tasks: number; first_week: string | null; last_week: string | null; candidates: { id: string; name: string; email: string }[] }
export interface SheetSyncResult { source: string; title?: string; inserted?: number; duplicates?: number; rejected?: number; error?: string }
