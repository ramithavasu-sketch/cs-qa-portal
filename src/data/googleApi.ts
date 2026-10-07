// The only actions the browser may ask the Google server to run. Anything else is refused.
// Reads can be grouped into one request; each change (write) is sent on its own, so if it
// fails nothing from it is saved.
export const READ_METHODS = [
  'whoami', 'currentUser', 'getSettings', 'getTaskTypes', 'getParameters', 'getPeriods', 'getTeams', 'getEmployees',
  'getEvaluations', 'getEvaluation', 'getAdjustments', 'getAppealDeadline', 'listAppeals', 'getAppeal', 'evidenceUrl',
  'listImportBatches', 'listImportRejections', 'listAuditLogs', 'weeklyEmailPreview', 'historicalCams', 'listNotifications',
  'automationStatus', 'syncProgress',
] as const;
export const WRITE_METHODS = [
  'submitAppeal', 'submitDraftAppeal', 'leadReviewAppeal', 'respondToAppealRequest', 'addAppealComment', 'qaRequestInfo',
  'qaDecideAppeal', 'qaReopenAppeal', 'closeAppeal', 'grantResubmission', 'uploadEvidenceData', 'adminAdjustScore',
  'setPeriodStatus', 'upsertPeriod', 'updateSetting', 'updateParameter', 'createParameter', 'upsertEmployee', 'inviteUser',
  'upsertTeam', 'deleteTeam', 'importEvaluations', 'syncGoogleSheet', 'sendWeeklyEmails', 'importTeamMapping', 'mergeEmployee',
  'markNotificationsRead', 'importSetup', 'installAutomation', 'runScheduledJobsNow',
  'updateDraftAppeal', 'shareAppealComment', 'logExport',
] as const;
export const isRead = (m: string) => (READ_METHODS as readonly string[]).includes(m);
export const isWrite = (m: string) => (WRITE_METHODS as readonly string[]).includes(m);
export const UNDEF_MARK = '__csqa_undefined__';

export interface AutomationStatus { installed: boolean; every_minutes: number; last_run: string | null; last_result: string | null }
