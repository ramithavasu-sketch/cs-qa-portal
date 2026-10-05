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
  { id: p(304), taskType: 'IB_CALL', name: 'Empathy & Affirmation', section: 'Soft Skills', maxScore: 10, sortOrder: 4, sourceColumn: ' [Empathy & Affimation [10]]' },
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
];

export interface PortalSettings {
  qa_target: { score: number; fcr_rate: number; autofail_rate_max: number };
  thresholds: { green: number; amber: number };
  appeal_window: { days: number; business_days: boolean; max_appeals_per_cam_per_period: number | null };
  sla: { lead_review_days: number; qa_review_days: number; clarification_days: number };
  reporting: { week_start_dow: number; auto_publish: boolean; auto_publish_dow: number; auto_publish_time: string; timezone: string };
  notifications: {
    email_enabled: boolean;
    portal_url: string;
    in_app: Record<string, boolean>;
    email: Record<string, boolean>;
  };
  report_email: {
    subject: string;
    body_html: string;
    sender_name: string;
    reply_to: string;
    cc_lead: boolean;
    extra_cc: string;
    send_on_publish: boolean;
  };
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
  appeal_window: { days: 5, business_days: true, max_appeals_per_cam_per_period: null },
  sla: { lead_review_days: 2, qa_review_days: 3, clarification_days: 2 },
  reporting: { week_start_dow: 4, auto_publish: false, auto_publish_dow: 1, auto_publish_time: '10:00', timezone: 'Asia/Kolkata' },
  notifications: {
    email_enabled: false,
    portal_url: '',
    in_app: {},
    email: {},
  },
  report_email: {
    subject: 'CS QA Report {WEEK} | {CAM_NAME}',
    body_html: DEFAULT_REPORT_EMAIL_HTML,
    sender_name: 'Ramitha V',
    reply_to: '',
    cc_lead: true,
    extra_cc: '',
    send_on_publish: false,
  },
};

export const SETTING_DESCRIPTIONS: Record<keyof PortalSettings, string> = {
  qa_target: 'QA targets used for "meeting target" indicators',
  thresholds: 'Colour bands: green ≥ green, amber ≥ amber, otherwise red',
  appeal_window: 'How long after publication a CAM may appeal, and optional per-week limit',
  sla: 'Review service-level targets (days) used for overdue flags',
  reporting: 'Audit-week definition and automatic publishing',
  notifications: 'In-app / email notification switches (email requires the send-email function)',
  report_email: 'Weekly QA report email sent to each CAM (CC: Team Lead) when a week is published',
};
