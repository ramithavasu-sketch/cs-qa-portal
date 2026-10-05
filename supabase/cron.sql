-- Optional scheduled jobs (run once in the Supabase SQL editor after enabling the
-- pg_cron and pg_net extensions). Replace <PROJECT_REF> and <CRON_SECRET>.

-- Auto-publish weeks whose auto_publish_at has passed (every 15 minutes)
select cron.schedule('csqa-publish-due', '*/15 * * * *', $$ select public.publish_due_periods(); $$);

-- Appeal SLA reminders (hourly)
select cron.schedule('csqa-appeal-sla', '5 * * * *', $$ select public.appeal_sla_sweep(); $$);

-- Pull new audits from the Google Sheet (every 30 minutes)
select cron.schedule('csqa-sheets-sync', '*/30 * * * *', $$
  select net.http_post(url := 'https://<PROJECT_REF>.supabase.co/functions/v1/sheets-sync',
                       headers := jsonb_build_object('x-cron-secret', '<CRON_SECRET>', 'content-type', 'application/json'),
                       body := '{}'::jsonb);
$$);

-- Send queued emails (every 5 minutes, only if email notifications are enabled)
select cron.schedule('csqa-send-email', '*/5 * * * *', $$
  select net.http_post(url := 'https://<PROJECT_REF>.supabase.co/functions/v1/send-email',
                       headers := jsonb_build_object('x-cron-secret', '<CRON_SECRET>', 'content-type', 'application/json'),
                       body := '{}'::jsonb);
$$);
