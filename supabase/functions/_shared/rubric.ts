// Scoring framework taken from the live "New QA Live Task Audit Form (Responses)"
// sheet (column headers carry the max score, e.g. "[Query resolution (ER) [30]]").
// Verified against 11,652 audits: task score = sum of parameter scores; autofail => 0;
// FCR is recorded Yes/No and does not contribute to the score.
// This file is the single source for the reference-data migration, the demo data
// and the import mapper. Weights stay editable at runtime (QA Scoring Configuration).

export type TaskTypeCode = 'ER' | 'CHAT' | 'IB_CALL' | 'INTERNAL';

export interface RubricTaskType {
  code: TaskTypeCode;
  name: string;
  sourceLabel: string;
  feedbackColumn: string;
  fcrColumn: string;
  sortOrder: number;
}

export interface RubricParameter {
  id: string;
  taskType: TaskTypeCode;
  name: string;
  section: string | null;
  maxScore: number;
  sortOrder: number;
  sourceColumn: string;
  /** Other header spellings used by older form versions (matched ignoring case, spaces and punctuation). */
  aliases?: string[];
  /** 'current' = live audit form. Older rubric versions are kept (inactive) so archived audits score correctly. */
  rubricVersion?: string;
  active?: boolean;
}

export const TASK_TYPES: RubricTaskType[] = [
  { code: 'ER', name: 'Email Request', sourceLabel: 'Email Request (Client, Agent)', feedbackColumn: 'Feedback (ER)', fcrColumn: ' [First Contact Resolution (ER)]', sortOrder: 1 },
  { code: 'CHAT', name: 'Chat Request', sourceLabel: 'Chat Request', feedbackColumn: 'Feedback (Chat)', fcrColumn: ' [First Contact Resolution (Chat)]', sortOrder: 2 },
  { code: 'IB_CALL', name: 'IB Call', sourceLabel: 'Calls (Client, Agent)', feedbackColumn: 'Feedback (IB call)', fcrColumn: ' [First Contact Resolution (IB call)]', sortOrder: 3 },
  { code: 'INTERNAL', name: 'Internal', sourceLabel: 'Other Request (Internal)', feedbackColumn: 'Feedback (Internal)', fcrColumn: ' [First Contact Resolution (Internal)]', sortOrder: 4 },
];

const p = (n: number) => `00000000-0000-4000-a000-000000000${String(n).padStart(3, '0')}`;

export const PARAMETERS: RubricParameter[] = [
  // Email Request (100)
  { id: p(101), taskType: 'ER', name: 'Query Resolution', section: null, maxScore: 30, sortOrder: 1, sourceColumn: ' [Query resolution (ER) [30]]' },
  { id: p(102), taskType: 'ER', name: 'OB Call / Follow-up', section: null, maxScore: 15, sortOrder: 2, sourceColumn: ' [OB call/Follow-up (ER) [15]]' },
  { id: p(103), taskType: 'ER', name: 'Average Task-Handled Time', section: null, maxScore: 15, sortOrder: 3, sourceColumn: ' [Average Task-Handled Time (ER) [15]]' },
  { id: p(104), taskType: 'ER', name: 'Required Documentation', section: null, maxScore: 10, sortOrder: 4, sourceColumn: ' [Required Documentation (ER) [10]]' },
  { id: p(105), taskType: 'ER', name: 'Email Structure', section: null, maxScore: 20, sortOrder: 5, sourceColumn: ' [Email Structure (ER) [20]]' },
  { id: p(106), taskType: 'ER', name: 'Checklist', section: null, maxScore: 10, sortOrder: 6, sourceColumn: ' [Checklist (ER) [10]]' },
  // Chat Request (100)
  { id: p(201), taskType: 'CHAT', name: 'Query Resolution', section: null, maxScore: 30, sortOrder: 1, sourceColumn: ' [Query resolution (Chat) [30]]' },
  { id: p(202), taskType: 'CHAT', name: 'OB Call / Follow-up', section: null, maxScore: 10, sortOrder: 2, sourceColumn: ' [OB call/Follow-up (Chat) [10]]' },
  { id: p(203), taskType: 'CHAT', name: 'Required Documentation', section: null, maxScore: 10, sortOrder: 3, sourceColumn: ' [Required Documentation (Chat) [10]]' },
  { id: p(204), taskType: 'CHAT', name: 'Hold & Response Time', section: null, maxScore: 10, sortOrder: 4, sourceColumn: ' [Hold & Response Time (Chat) [10]]' },
  { id: p(205), taskType: 'CHAT', name: 'Average Task-Handled Time', section: null, maxScore: 10, sortOrder: 5, sourceColumn: ' [Average Task-Handled Time (Chat) [10]]' },
  { id: p(206), taskType: 'CHAT', name: 'Professionalism / Communication / Personalization', section: null, maxScore: 10, sortOrder: 6, sourceColumn: ' [Professionalism/Communication/Personalization (Chat) [10]]' },
  { id: p(207), taskType: 'CHAT', name: 'Email Structure', section: null, maxScore: 10, sortOrder: 7, sourceColumn: ' [Email Structure (Chat) [10]]' },
  { id: p(208), taskType: 'CHAT', name: 'Checklist', section: null, maxScore: 10, sortOrder: 8, sourceColumn: ' [Checklist (Chat) [10]]' },
  // IB Call — Soft Skills (45) + Technical Skills (55)
  { id: p(301), taskType: 'IB_CALL', name: 'Tone of Voice', section: 'Soft Skills', maxScore: 10, sortOrder: 1, sourceColumn: ' [Tone of Voice  [10]]' },
  { id: p(302), taskType: 'IB_CALL', name: 'Call Control / Accountability', section: 'Soft Skills', maxScore: 10, sortOrder: 2, sourceColumn: ' [Call Control / Accountability [10]]' },
  { id: p(303), taskType: 'IB_CALL', name: 'Acknowledgement / Active Listening', section: 'Soft Skills', maxScore: 10, sortOrder: 3, sourceColumn: ' [Acknowledgement / Active Listening [10]]' },
  { id: p(304), taskType: 'IB_CALL', name: 'Empathy & Affirmation', section: 'Soft Skills', maxScore: 10, sortOrder: 4, sourceColumn: ' [Empathy & Affimation [10]]', aliases: [' [Empathy / Mirroring [10]]', ' [Empathy / Affirmation [10]]', ' [Empathy & Affirmation [10]]'] },
  { id: p(305), taskType: 'IB_CALL', name: 'Personalization & Rapport Building', section: 'Soft Skills', maxScore: 5, sortOrder: 5, sourceColumn: ' [Personalization & Rapport Building  (IB call) [5]]' },
  { id: p(306), taskType: 'IB_CALL', name: 'Query Resolution', section: 'Technical Skills', maxScore: 20, sortOrder: 6, sourceColumn: ' [Query resolution (IB call) [20]]' },
  { id: p(307), taskType: 'IB_CALL', name: 'Average Task-Handled Time', section: 'Technical Skills', maxScore: 10, sortOrder: 7, sourceColumn: ' [Average Task-Handled Time (IB call) [10]]' },
  { id: p(308), taskType: 'IB_CALL', name: 'Email Structure / Follow-up', section: 'Technical Skills', maxScore: 10, sortOrder: 8, sourceColumn: ' [Email Structure / Follow up (IB call) [10]]' },
  { id: p(309), taskType: 'IB_CALL', name: 'Documentation', section: 'Technical Skills', maxScore: 10, sortOrder: 9, sourceColumn: ' [Documentation (IB call) [10]]' },
  { id: p(310), taskType: 'IB_CALL', name: 'Checklist', section: 'Technical Skills', maxScore: 5, sortOrder: 10, sourceColumn: ' [Checklist (IB call) [5]]' },
  // Internal (100)
  { id: p(401), taskType: 'INTERNAL', name: 'Query Resolution', section: null, maxScore: 80, sortOrder: 1, sourceColumn: ' [Query resolution (Internal) [80]]' },
  { id: p(402), taskType: 'INTERNAL', name: 'Average Task-Handled Time', section: null, maxScore: 10, sortOrder: 2, sourceColumn: ' [Average Task-Handled Time (Internal) [10]]' },
  { id: p(403), taskType: 'INTERNAL', name: 'Required Documentation', section: null, maxScore: 10, sortOrder: 3, sourceColumn: ' [Required Documentation (Internal) [10]]' },

  // ---- Rubric used until end of 2023 (CS Task Audit | Archives: "Archived Data 2022" / "2023").
  // Email Request and Internal were unchanged, so those archived audits use the parameters above.
  // Chat Request (100)
  { id: p(501), taskType: 'CHAT', name: 'Query Resolution', section: 'Rubric 2022–23', maxScore: 30, sortOrder: 51, sourceColumn: ' [Query resolution (Chat) [30]]', rubricVersion: '2022-23', active: false },
  { id: p(502), taskType: 'CHAT', name: 'OB Call / Follow-up', section: 'Rubric 2022–23', maxScore: 15, sortOrder: 52, sourceColumn: ' [OB call/Follow-up (Chat) [15]]', rubricVersion: '2022-23', active: false },
  { id: p(503), taskType: 'CHAT', name: 'Required Documentation', section: 'Rubric 2022–23', maxScore: 10, sortOrder: 53, sourceColumn: ' [Required Documentation (Chat) [10]]', rubricVersion: '2022-23', active: false },
  { id: p(504), taskType: 'CHAT', name: 'Hold & Response Time', section: 'Rubric 2022–23', maxScore: 10, sortOrder: 54, sourceColumn: ' [Hold & Response Time (Chat) [10]]', rubricVersion: '2022-23', active: false },
  { id: p(505), taskType: 'CHAT', name: 'Personalization', section: 'Rubric 2022–23', maxScore: 10, sortOrder: 55, sourceColumn: ' [Personalization (Chat) [10]]', rubricVersion: '2022-23', active: false },
  { id: p(506), taskType: 'CHAT', name: 'Professionalism / Communication', section: 'Rubric 2022–23', maxScore: 15, sortOrder: 56, sourceColumn: ' [Professionalism/Communication (Chat) [15]]', rubricVersion: '2022-23', active: false },
  { id: p(507), taskType: 'CHAT', name: 'Checklist', section: 'Rubric 2022–23', maxScore: 10, sortOrder: 57, sourceColumn: ' [Checklist (Chat) [10]]', rubricVersion: '2022-23', active: false },
  // IB Call (100)
  { id: p(601), taskType: 'IB_CALL', name: 'Tone of Voice', section: 'Soft Skills · Rubric 2022–23', maxScore: 10, sortOrder: 61, sourceColumn: ' [Tone of Voice (IB call) [10]]', rubricVersion: '2022-23', active: false },
  { id: p(602), taskType: 'IB_CALL', name: 'Active Listening / Acknowledgement', section: 'Soft Skills · Rubric 2022–23', maxScore: 5, sortOrder: 62, sourceColumn: ' [Active Listening / Acknowledgement (IB call) [5]]', rubricVersion: '2022-23', active: false },
  { id: p(603), taskType: 'IB_CALL', name: 'Empathy / Mirroring', section: 'Soft Skills · Rubric 2022–23', maxScore: 5, sortOrder: 63, sourceColumn: ' [Empathy / Mirroring (IB call) [5]]', rubricVersion: '2022-23', active: false },
  { id: p(604), taskType: 'IB_CALL', name: 'Confidence / Professionalism', section: 'Soft Skills · Rubric 2022–23', maxScore: 10, sortOrder: 64, sourceColumn: ' [Confidence/Professionalism (IB call) [10]]', rubricVersion: '2022-23', active: false },
  { id: p(605), taskType: 'IB_CALL', name: 'Positivity / Accountability', section: 'Soft Skills · Rubric 2022–23', maxScore: 10, sortOrder: 65, sourceColumn: ' [Positivity / Accountability (IB call) [10]]', rubricVersion: '2022-23', active: false },
  { id: p(606), taskType: 'IB_CALL', name: 'Call Control', section: 'Soft Skills · Rubric 2022–23', maxScore: 15, sortOrder: 66, sourceColumn: ' [Call Control (IB call) [15]]', rubricVersion: '2022-23', active: false },
  { id: p(607), taskType: 'IB_CALL', name: 'Personalization & Rapport Building', section: 'Soft Skills · Rubric 2022–23', maxScore: 15, sortOrder: 67, sourceColumn: ' [Personalization & Rapport Building (IB call) [15]]', rubricVersion: '2022-23', active: false },
  { id: p(608), taskType: 'IB_CALL', name: 'Query Resolution', section: 'Technical Skills · Rubric 2022–23', maxScore: 15, sortOrder: 68, sourceColumn: ' [Query resolution (IB call) [15]]', rubricVersion: '2022-23', active: false },
  { id: p(609), taskType: 'IB_CALL', name: 'Required Documentation', section: 'Technical Skills · Rubric 2022–23', maxScore: 10, sortOrder: 69, sourceColumn: ' [Required Documentation (IB call) [10]]', rubricVersion: '2022-23', active: false },
  { id: p(610), taskType: 'IB_CALL', name: 'Checklist', section: 'Technical Skills · Rubric 2022–23', maxScore: 5, sortOrder: 70, sourceColumn: ' [Checklist (IB call) [5]]', rubricVersion: '2022-23', active: false },
];

/** Google Sheets the portal reads audits from. Live = current form; archive = previous years (imported once, re-runnable). */
export interface DataSource { id: string; label: string; kind: 'live' | 'archive'; sheet_id: string; gid?: string; tab?: string; enabled: boolean }
export const ARCHIVE_TABS = ['Archived Data 2022', 'Archived Data 2023', 'Archived Data 2024', 'Archived Data 2025 (Until WK 51)', 'Archived Data 2025 (From WK 52 to 53)'];
/** Sheet IDs are not kept in the (public) source code: pass them from .env, or add sheets on the Data Import page. */
export function buildDataSources(ids: { liveSheetId?: string; liveGid?: string; archiveSheetId?: string } = {}): DataSource[] {
  const live: DataSource[] = ids.liveSheetId ? [{ id: 'live', label: 'New QA Live Task Audit Form (Responses)', kind: 'live', sheet_id: ids.liveSheetId, gid: ids.liveGid || undefined, enabled: true }] : [];
  const archives: DataSource[] = ids.archiveSheetId ? ARCHIVE_TABS.map((tab, i) => ({
    id: `archive-${i + 1}`, label: `CS Task Audit | Archives — ${tab}`, kind: 'archive' as const, sheet_id: ids.archiveSheetId!, tab, enabled: true,
  })) : [];
  return [...live, ...archives];
}
export const DEFAULT_DATA_SOURCES: DataSource[] = buildDataSources();

export interface PortalSettings {
  qa_target: { score: number; fcr_rate: number; autofail_rate_max: number };
  thresholds: { green: number; amber: number };
  appeal_window: { days: number; business_days: boolean; max_appeals_per_cam_per_period: number | null; /** close at 11:59 pm (portal time zone) on the last day */ end_of_day?: boolean; /** close at 11:59 pm on this weekday (1 = Mon … 7 = Sun) after publishing; overrides days */ close_dow?: number | null };
  sla: { lead_review_days: number; qa_review_days: number; clarification_days: number };
  reporting: { week_start_dow: number; auto_publish: boolean; auto_publish_dow: number; auto_publish_time: string; timezone: string };
  notifications: {
    email_enabled: boolean;
    portal_url: string;
    /** 'sheet' = emails are sent from the QA owner's Gmail by the audit sheet's Apps Script; otherwise Supabase/SMTP. */
    mail_route?: 'sheet' | 'supabase';
    in_app: Record<string, boolean>;
    email: Record<string, boolean>;
  };
  data_sources: { sources: DataSource[]; auto_sync_minutes: number };
  report_email: {
    subject: string;
    body_html: string;
    sender_name: string;
    reply_to: string;
    cc_lead: boolean;
    extra_cc: string;
    send_on_publish: boolean;
  };
  /** Feedback sessions every few audit weeks: Setmore booking link and cycle numbering. */
  feedback: { booking_url: string; anchor_number: number; anchor_start: string; weeks_per_cycle: number; book_by_days: number };
}

// Weekly report email — wording taken from the QA team's current CAM email instructions.
// Placeholders: {CAM_NAME} {CAM_FIRST_NAME} {WEEK} {WEEK_RANGE} {REPORT_LINK} {SENDER_NAME}
export const DEFAULT_REPORT_EMAIL_HTML =
  '<p>Hello {CAM_NAME},</p>' +
  '<p>Here is the <a href="{REPORT_LINK}">Quality Assurance Report</a> for the audits completed during <strong>{WEEK} ({WEEK_RANGE})</strong>. Please reach out to us if you have any questions.</p>' +
  '<p>Have an amazing week!</p>' +
  '<p>Thank you,<br>Regards,<br>{SENDER_NAME}<br>Quality Assurance | FULL Creative</p>';

// Defaults. Targets follow CS_QA_Guidelines_v3 KPI table (Overall QA ≥ 95%,
// autofail < 2%, FCR ≥ 90%); the appeal window follows the SOP (5 business days).
export const DEFAULT_SETTINGS: PortalSettings = {
  qa_target: { score: 95, fcr_rate: 90, autofail_rate_max: 2 },
  thresholds: { green: 95, amber: 85 },
  appeal_window: { days: 7, business_days: false, max_appeals_per_cam_per_period: null, end_of_day: true, close_dow: 3 },
  sla: { lead_review_days: 2, qa_review_days: 3, clarification_days: 2 },
  reporting: { week_start_dow: 4, auto_publish: false, auto_publish_dow: 1, auto_publish_time: '10:00', timezone: 'Asia/Kolkata' },
  notifications: {
    email_enabled: false,
    portal_url: '',
    in_app: {},
    email: {},
  },
  data_sources: { sources: DEFAULT_DATA_SOURCES, auto_sync_minutes: 30 },
  report_email: {
    subject: 'CS QA Report {WEEK} | {CAM_NAME}',
    body_html: DEFAULT_REPORT_EMAIL_HTML,
    sender_name: 'Ramitha V',
    reply_to: '',
    cc_lead: true,
    extra_cc: '',
    send_on_publish: false,
  },
  feedback: { booking_url: 'https://qaanywhereworks.setmore.com/book?step=staff&products=04932840-f23f-4dfa-9b79-ebe915086d79&type=service', anchor_number: 22, anchor_start: '2026-09-17', weeks_per_cycle: 3, book_by_days: 23 },
};

export const SETTING_DESCRIPTIONS: Record<keyof PortalSettings, string> = {
  qa_target: 'QA targets used for "meeting target" indicators',
  thresholds: 'Colour bands: green ≥ green, amber ≥ amber, otherwise red',
  appeal_window: 'How long after publication a CAM may appeal, and optional per-week limit',
  sla: 'Review service-level targets (days) used for overdue flags',
  reporting: 'Audit-week definition and automatic publishing',
  notifications: 'In-app / email notification switches (email requires the send-email function)',
  data_sources: 'Google Sheets the portal imports audits from (live form + archives)',
  report_email: 'Weekly QA report email sent to each CAM (CC: Team Lead) when a week is published',
  feedback: 'Feedback sessions: booking link, cycle numbering (anchor) and booking deadline (days after the last week ends)',
};
