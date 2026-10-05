// Mirrors public.queue_weekly_report_emails() rendering so QA can preview the exact email.
import type { Period, PortalSettings } from './types';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const mmdd = (d: string) => `${d.slice(5, 7)}/${d.slice(8, 10)}`;

export function reportLink(settings: PortalSettings, period: Period) {
  const base = (settings.notifications.portal_url || '').replace(/\/+$/, '');
  return `${base}/#/?mode=week&period=${period.id}`;
}

export function renderReportEmail(settings: PortalSettings, period: Period, camName: string) {
  const cfg = settings.report_email;
  const range = `${mmdd(period.start_date)}–${mmdd(period.end_date)}/${period.end_date.slice(0, 4)}`;
  const first = camName.split(' ')[0];
  const subject = cfg.subject.replaceAll('{WEEK}', period.short_label).replaceAll('{CAM_NAME}', camName).replaceAll('{CAM_FIRST_NAME}', first);
  const html = cfg.body_html
    .replaceAll('{CAM_NAME}', esc(camName)).replaceAll('{CAM_FIRST_NAME}', esc(first)).replaceAll('{WEEK}', esc(period.short_label))
    .replaceAll('{WEEK_RANGE}', esc(range)).replaceAll('{REPORT_LINK}', esc(reportLink(settings, period))).replaceAll('{SENDER_NAME}', esc(cfg.sender_name || 'CS QA Team'));
  return { subject, html };
}
