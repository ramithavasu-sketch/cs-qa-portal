# CS QA Performance Portal

This portal replaces the weekly Looker Studio report. Each CAM, Team Lead and QA analyst signs in and sees only the performance data their role allows. Reports are produced automatically for every audit week. Appeals follow a fixed path: **CAM → Team Lead → QA → decision**.

| Layer | Choice |
|---|---|
| Frontend | React 19 + TypeScript, Vite, Tailwind CSS, Recharts, React Router (hash routing: runs on any static host) |
| Backend | Supabase: PostgreSQL 15+, Supabase Auth, Row Level Security, Storage, Edge Functions (Deno) |
| Exports | PDF (jsPDF + autotable), Excel (ExcelJS), CSV |
| Hosting | Any static host (Vercel, Netlify, Cloudflare Pages, S3) + a Supabase project |

---

## 1. What is where

```
supabase/
  migrations/0001_schema.sql          tables, enums, indexes
  migrations/0002_security.sql        identity helpers, *_effective views, RLS policies, grants
  migrations/0003_workflow.sql        appeal RPCs, score adjustments, publishing, import, audit triggers
  migrations/0004_reference_data.sql  task types, parameters (live-form weights), default settings  [generated]
  migrations/0005_storage.sql         private evidence bucket + storage policies
  functions/_shared/rubric.ts         single source of the scoring rubric
  functions/_shared/mapper.ts         audit-sheet → import rows (used by browser AND Edge Function)
  functions/admin-users               invite / deactivate logins (service role, server-side only)
  functions/sheets-sync               pulls the Google Sheet with a service account
  functions/send-email                sends queued notification emails
  tests/                              SQL test harness (security + workflow, 85 assertions)
  cron.sql                            optional pg_cron schedules
src/
  data/repo.ts            the one interface every screen uses
  data/supabaseRepo.ts    production implementation
  data/demoRepo.ts        in-browser demo implementation (fictional data, same rules)
  lib/metrics.ts          all calculations (shared by dashboards, reports, exports)
  lib/report.ts           PDF / XLSX / CSV generation
  pages/…                 20 screens (see §6)
scripts/
  test-db.sh              runs the SQL test-suite on a local PostgreSQL
  seed-demo.ts            loads the fictional demo dataset into a DEV Supabase project
  purge-demo.sql          removes demo data again
  sample-exports.ts       writes sample PDF/XLSX/CSV from demo data
tests/                    Vitest unit tests (mapper, metrics, demo rules)
e2e/                      Playwright smoke + appeal-workflow tests against the demo build
```

## 2. Security model

* **Authentication**: Supabase Auth with email and password, PKCE flow, password reset by email, and sign-out after inactivity (`VITE_IDLE_TIMEOUT_MINUTES`, default 30). Accounts are **invite-only**: sign-ups are disabled in `config.toml`, and a login with no active `employees` row sees nothing.
* **Temporary passwords** (Users & Roles → *Set password*, Super Admin only; the `admin-users` Edge Function re-checks the role): an alternative to invitation emails. The portal generates a strong password, shows it **once** so QA can pass it on privately, and keeps only a hashed copy. It is never written to the audit log (only the fact that it was set). The user must choose their own password at first sign-in. In local review mode such users can sign in on that computer only.
* **Authorisation in the database**. Hiding things in the UI is not the protection:
  * `my_employee_id()`, `my_role()`, `is_lead_of()` and `can_view_*()` are SECURITY DEFINER helpers used by the RLS policies.
  * **CAM**: sees only their own evaluations, and only in *published* weeks. Sees only their own appeals and notifications. Never sees internal comments.
  * **Team Lead**: sees only CAMs in teams they lead, plus those CAMs' appeals. Cannot change scores, scoring rules or users.
  * **QA Super Admin**: sees everything, including draft weeks, audit logs and imports.
  * Changing a URL or an ID in an API call returns no rows. These cases are tested.
* **Workflow enforcement**: every state change is an RPC that checks the caller's role **and** the appeal's current status. For example, `qa_decide_appeal` refuses unless the status is `pending_qa_review`, which only `lead_review_appeal` can set. Tables have no INSERT or UPDATE grants for these objects.
* **Immutable originals**: triggers block UPDATE and DELETE on `evaluations` and `evaluation_scores`. Corrections go into the append-only `score_adjustments` table, with original value, revised value, reason, approver and timestamp. The `v_evaluations_effective` view applies the latest adjustment and recalculates the task score.
* **Audit log**: triggers record every change to users, teams, rubric, settings, periods, score adjustments, appeal status changes and imports.
* **Evidence**: files go in a private Storage bucket. The path is prefixed with the appeal id, and policies allow read only to people who can see the appeal. Uploads are limited to 10 MB and to images, PDF, text, .docx and .xlsx.
* **Secrets**: the browser only ever has the public anon key. The service-role key and Google credentials exist only as Edge Function secrets.
* **Emails**: contain only the appeal reference, task id, status and a portal link. They never include scores, feedback or other CAMs' data.

## 3. Scoring (matches the live audit form)

The rules were derived from *New QA Live Task Audit Form (Responses)* and checked against 11,652 existing audits (100% match):

* Task score = Σ earned ÷ Σ applicable max × 100. NA parameters are excluded.
* **Autofail → 0**. Autofails are counted separately from point deductions.
* **FCR** is stored as Yes or No and reported as an FCR rate. It does not change the score, which is how the current form works.
* Weekly average = mean of task scores. Variance is shown in **percentage points**.
* Weights: ER 30/15/15/10/20/10 · Chat 30/10/10/10/10/10/10/10 · IB Call soft 10/10/10/10/5 + tech 20/10/10/10/5 · Internal 80/10/10.
  The weights can be edited under *Scoring Configuration*. `CS_QA_Guidelines_v3` proposes different weights (FCR scored at 10, Chat Professionalism at 15). When the audit form changes, update the parameters there.
* The unique audit key is **DS Task Link + CAM + QA Week**, because the same link can legitimately appear in more than one week. Re-importing the whole sheet is therefore safe.
* Import validation rejects rows where the recorded Score doesn't equal the parameter total, so the portal never disagrees with the sheet. On the current sheet this flags **10 rows**, for example a *Tone of Voice* score of 20 against a maximum of 10. It also finds **73 exact duplicate rows**.

## 3a. Local review mode (your real data, on your computer only)

Use this to review everything with live data before anyone else gets access:
```bash
npm install
npm run local        # then open http://localhost:5173
```
0. Copy `.env.example` to `.env` and fill in `VITE_LIVE_SHEET_ID`, `VITE_LIVE_SHEET_GID` and `VITE_ARCHIVE_SHEET_ID` from your sheet links. The sheet IDs are kept out of the source code because this repository is public. (You can also add sheets later on **Data Import → Google Sheets**.)
1. The first time, the portal asks you to create the **Super Admin** login for this computer.
2. Open **Data Import** and click **Download latest CSV from the sheet**. This downloads the responses tab (gid <your-tab-gid>) using your own Google login. Then choose that file on the same page. Tick *Publish new weeks immediately* to see every week at once.
3. To refresh, repeat step 2. Audits that are already loaded are skipped.

Everything stays in this browser on this computer (IndexedDB). Nothing is uploaded, nobody else can sign in, and no emails can be sent. Teams are created from the sheet's *Lead Name* column. Leads' emails show as "needed" until you import the CAM ↔ Lead mapping. **Delete local data** in the blue bar removes everything.

### Connect Google Sheets directly (no CSV uploads)

Do this once so the portal reads your sheets itself, using your own Google account with read-only access.
1. Go to **console.cloud.google.com** and pick or create a project (for example "CS QA Portal").
2. Open **APIs & Services → Library**, search for **Google Sheets API** and click **Enable**.
3. Open **APIs & Services → OAuth consent screen**. Choose **Internal**, enter an app name ("CS QA Portal") and your email, then save.
4. Open **APIs & Services → Credentials → Create credentials → OAuth client ID**.
   * Application type: **Web application**
   * Authorised JavaScript origins: **http://localhost:5173** (add the deployed portal URL here later)
   * Click Create and copy the **Client ID**.
5. In the `portal` folder, create a file named `.env` (or edit the existing one) with this line:
   ```
   VITE_GOOGLE_CLIENT_ID=<the client id>
   ```
6. Restart with `npm run local`. Then go to **Data Import → Google Sheets (direct connection)**:
   * **Sync live sheet now** reads the live form.
   * **Sync live + archives** also loads the 2022–2025 archive tabs. It only needs to run once, and it's safe to repeat.
   * Tick *Re-sync every 30 minutes* to keep the portal up to date while it's open.

If Google shows "access blocked", your Workspace admin needs to allow the app. Using **Internal** in step 3 usually avoids this.

### Archived audits (2022–2025)

The archive tabs in *CS Task Audit | Archives | 2022 - 2025* are read with the rubric that applied in each year:

* **2022–23**: Chat was 30/15/10/10/10/15/10 and IB Call was 10/5/5/10/10/15/15/15/10/5. These parameters are stored as a separate "Rubric 2022–23" version.
* **2024 onward**: the current rubric. Older header spellings, such as "Empathy / Mirroring", are recognised automatically.
* The 2022 tab was checked row by row: 7,220 audits, every score matches its parameters, plus 49 exact duplicate rows.

Archived rows record the CAM by name (for example "Akanksha R"), not by email. Under **Users & Roles → Names from archived audits**, link each name to the CAM it belongs to. Likely matches are suggested; for example, "Aishwarya C" is suggested for aishwarya.chandra. Once linked, that CAM's history appears on their dashboard, and future imports of the same name go straight to them. Names you don't link stay as history only and can't sign in.

## 4. Deploy

### 4.1 Supabase project
1. Create a project (PostgreSQL 15+). Under **Auth → Providers → Email**, **disable sign-ups**. Set the Site URL and Redirect URLs to your portal URL.
2. Apply the migrations, in order:
   ```bash
   npx supabase link --project-ref <ref>
   npx supabase db push            # applies supabase/migrations/*
   ```
   Or paste each file, in order, into the SQL editor.
3. Deploy the Edge Functions and set their secrets:
   ```bash
   npx supabase functions deploy admin-users sheets-sync send-email
   npx supabase secrets set CRON_SECRET=<random> ALLOWED_ORIGIN=https://<portal-host>
   ```
4. (Optional) Enable the `pg_cron` and `pg_net` extensions, then run `supabase/cron.sql` for auto-publishing, SLA reminders, sheet sync and email.

### 4.2 First Super Admin (do this once, in the SQL editor)
```sql
insert into public.employees (email, full_name, role)
values ('you@example.com', 'Your Name', 'super_admin');
```
Next, in **Auth → Users → Invite user**, invite the same email. The `on_auth_user_created` trigger links the login to the employee record. After that, add everyone else from **Users & Roles** and **Teams**. The *Send invite* button uses the `admin-users` function.

### 4.3 Frontend
```bash
cp .env.example .env         # VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_DATA_MODE=supabase
npm ci
npm run build                # -> dist/  (static files; deploy to Vercel/Netlify/etc.)
```
On Vercel, set the framework to *Vite* and the output folder to `dist`, then add the three `VITE_` variables.

## 5. Connect your QA data

**Option A: CSV or Excel upload.** Works now, with nothing extra to set up.
Export *New QA Live Task Audit Form (Responses)* (File → Download → CSV), then open **Data Import** and upload it. The page validates every row, shows the reasons for any rejections, skips duplicates, and creates audit weeks from the *QA Week* label. New weeks start as **Draft**, visible to QA only, until you publish them. For a historical backfill, tick *Publish new weeks immediately*.

**Option B: Google Sheets sync (live).** Keeps the portal in step with the audit form automatically. Needs a service account:
1. In Google Cloud, create a service account, enable the **Sheets API**, and create a JSON key.
2. Share the responses sheet with the service account's email as **Viewer**.
3. Set the secrets:
   ```bash
   npx supabase secrets set GOOGLE_SERVICE_ACCOUNT_JSON="$(cat key.json)" \
     GOOGLE_SHEET_ID=<your-sheet-id> \
     GOOGLE_SHEET_GID=<your-tab-gid> SHEET_TIMEZONE_OFFSET=+05:30
   ```
   `GOOGLE_SHEET_GID` is the tab from the sheet link you use (`…#gid=<your-tab-gid>`). The function looks up that tab's name itself.
4. Use **Data Import → Sync from Google Sheet**, or let `cron.sql` run it every 30 minutes. Each run adds only new audits; rows already in the portal are skipped.

Nothing reads Looker Studio directly. Scraping is fragile and would need your Google login. The portal reads the Sheet that Looker Studio uses as its source.

**CAM ↔ Lead mapping.** CAMs are matched by the email in the *CAM Name* column. On import, a CAM with no team is placed in the team whose Lead's name matches the row's *Lead Name* column. Create the teams and Leads first, under **Teams**, so this mapping works. Rows marked "No Longer With Company" or "Moved to Different Team" still import, and those CAMs remain unassigned until you assign them.

## 5a. Weekly report emails to CAMs

Once a week is published, **QA administration → Weekly Report Emails** lists every CAM audited that week. The list shows the CAM's email (To), their Team Lead's email (CC), the number of tasks audited, and whether the email has been sent.

* **Send to N not yet emailed** sends one email per CAM straight away. It uses your current wording from *Instructions for Gemini – Draft CS QA Report Emails*: the subject `CS QA Report WK-39 | <CAM NAME>`, "Quality Assurance Report" hyperlinked to that CAM's own dashboard for the week, and your signature.
* CAMs who have already been emailed for that week are skipped. Tick CAMs and use *Send / resend selected* to send again.
* The subject, body, sender name, Reply-To and extra CC can be edited under *Email template*. The *Send automatically when a week is published* option is also there.
* Emails contain no scores or feedback. The CAM signs in to see their report.
* Delivery runs through the `send-email` function. Configure one of:
  * **Google Workspace SMTP** (default): `EMAIL_PROVIDER=smtp`, `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_USER`, `SMTP_PASSWORD` (an app password, or use `smtp-relay.gmail.com` if IT allows), `EMAIL_FROM="Your Name <you@example.com>"`
  * or **Resend**: `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, `EMAIL_FROM`
* Set **Reporting & Settings → Notifications → Portal URL** so the links point at your deployed portal.

**Team Lead emails (CC).** The audit sheet only has Lead *names*. Load the Lead emails once with **Teams & Assignments → Import CAM ↔ Team Lead mapping**, using a CSV or Excel file with the columns *CAM Email, CAM Name, Lead Email, Lead Name, Team*. This file also creates the Lead logins and sets which CAMs each Lead can see.

## 6. Pages
Login · Forgot/Reset password · QA Master Dashboard · Team Lead Dashboard · CAM Personal Dashboard (also opened by Leads and QA for any CAM in their scope) · Task Evaluations and Evaluation Detail · Weekly & Monthly Reports (report history) · Parameter Analysis · Appeal form (from any evaluation) · CAM Appeal History · Lead Review Queue · QA Review Queue · Appeal Detail & Timeline · Download Reports · Users & Roles · Teams & Assignments · Scoring Configuration · Reporting Periods & Settings · Data Import & Validation · Notifications · Audit Logs.

## 7. Tests (all run in the build environment)

| Suite | Command | Result |
|---|---|---|
| SQL security + workflow + weekly emails + archive import (real PostgreSQL 16, Supabase auth shim) | `npm run test:db` | 118 assertions passed |
| Direct Google sync in local mode, Google endpoints replaced by the real live + 2022 archive exports | `node e2e/local-google.mjs` | 11,594 + 7,220 audits loaded; 52 archived names; linking moves their audits |
| Unit tests (mapper, metrics, demo rules) | `npm test` | 29 passed |
| Mapper vs the live sheet (re-run 29 Sep 2026: 11,678 rows, WK-2 → WK-39) | — | 11,594 valid, 73 duplicates, 11 genuine data errors |
| SMTP delivery path (nodemailer, TLS 465, To + CC + Reply-To) against a local mail server | — | delivered |
| Weekly Report Emails page in the demo (send, skip already-sent) | `node e2e/emails.mjs` | passed |
| Playwright: every page as CAM, Lead and QA, plus mobile | `node e2e/smoke.mjs` | no page errors |
| Playwright: full appeal (CAM → Lead → QA → score recalculated; isolation checks) | `node e2e/workflow.mjs` | passed |
| Super Admin sets a temporary password → CAM signs in, must change it, sees no admin pages; password never stored or logged in readable form | `node e2e/passwords.mjs` | 16/16 passed |
| Edge Functions type check | `deno check supabase/functions/*/index.ts` | passed |

The SQL suite covers: CAM, Lead, stranger and anonymous isolation; ID-guessing attempts; blocked role escalation; draft weeks hidden; appeals that skip the Lead are rejected; a Lead can't finalise; QA can't decide before the Lead has reviewed; duplicate-appeal and appeal-window enforcement; partial approvals; overturning an autofail with re-scoring; reopening an appeal and reverting it; append-only history; evidence policies; SLA sweeps; and import validation.

## 8. What still needs your configuration (not live yet)

| Item | Status |
|---|---|
| Supabase project, auth settings, migrations | Needs your project. Migrations are tested on PostgreSQL 16 with a Supabase shim, not yet on a hosted Supabase project |
| Hosting (Vercel etc.) | Not deployed. `npm run build` output is ready |
| Google Sheets sync | Code written and type-checked. Needs a service account and the sheet shared with it; not run against Google |
| Email sending (weekly reports + notifications) | Tested against a local SMTP server. Needs your SMTP or Resend credentials; not yet sent through Google or Resend |
| Live Google Sheet sync | Needs the service account (§5, option B). Until then, upload a CSV export on Data Import |
| Team Lead emails | Needs the CAM ↔ Lead mapping file (§5a) |
| Scheduled jobs | `cron.sql` provided. Needs pg_cron/pg_net enabled |
| Invites and deactivation of logins | `admin-users` function written and type-checked. Not run against a live project |
| `seed-demo.ts` (demo data in a DEV project) | Type-checked. Not run against a live project |

## 9. Demo build
`npm run build:demo` creates a single self-contained HTML file with **fictional** people and audits (`@demo.csqa.test`, password `Demo@2026`). It is clearly marked as a demo and keeps changes in that viewer's browser only. It never contains real employee data.
