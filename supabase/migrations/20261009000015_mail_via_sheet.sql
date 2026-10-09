-- =============================================================================
-- Send portal emails from the QA owner's Gmail through the Apps Script in the
-- audit sheet (no SMTP needed). Invitation and password links are queued as
-- kind 'auth' by the Edge Functions; the sheet script fetches queued emails
-- every minute (sheets-push action 'outbox'), sends them with MailApp and
-- reports back. After an auth email is sent its link is removed from the outbox.
-- Safe to run more than once.
-- =============================================================================
alter table public.email_outbox drop constraint if exists email_outbox_kind_check;
alter table public.email_outbox add constraint email_outbox_kind_check
  check (kind in ('notification', 'weekly_report', 'auth'));
create index if not exists email_outbox_recipient_kind_idx on public.email_outbox (recipient_email, kind, created_at desc);

-- Route all portal email through the sheet script, and turn on email notifications.
update public.settings
   set value = value || '{"mail_route": "sheet", "email_enabled": true}'::jsonb
 where key = 'notifications';
