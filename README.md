# CS QA Performance Portal

This portal replaces the weekly Looker Studio report. Each CAM, Team Lead and QA analyst signs in and sees only the performance data their role allows. Reports are produced automatically for every audit week. Appeals follow a fixed path: **CAM → Team Lead → QA → decision**.

| Layer | Choice |
|---|---|
| Frontend | React 19 + TypeScript, Vite, Tailwind CSS, Recharts, React Router (hash routing: runs on any static host) |
| Backend | Supabase: PostgreSQL 15+, Supabase Auth, Row Level Security, Storage, Edge Functions (Deno) |
| Exports | PDF (jsPDF + autotable), Excel (ExcelJS), CSV |
| Hosting | **Google Workspace version (recommended):** a Google Apps Script web app — see §0. Or: any static host + a Supabase project (§4) |

---

## 0. Google Workspace version — everything inside Google

The whole portal runs as a **Google Apps Script web app** in your own Google account. No Supabase, no other hosting, no other accounts.

| | How it works |
|---|---|
| Sign-in | Everyone opens the portal link and is recognised by their **company Google account**. No passwords. Only people you add under *Users & Roles* get in; everyone else sees "You don't have access yet". The web app only accepts accounts in your Google Workspace domain. |
| Data | A private folder in **your Drive**: *CS QA Portal — data (private, do not share)*. Nobody else needs, or should get, access to it. The portal applies the same rules as every other version: a CAM sees only their own published weeks, a Lead only their team, QA everything. |
| Audits | Read straight from your Google Sheets (live form + archives) as your account. Every 30 minutes a scheduled job re-reads the live sheet once you turn on *Automatic jobs*. |
| Emails | Sent from **your Gmail**: weekly report to each CAM (CC their Lead), invites, and appeal updates (title and a link only — never scores, feedback or other CAMs' data). |
| Evidence files | Stored in the same private Drive folder (max 5 MB each). |

### Put it live (about 15 minutes, once)
1. Open **https://script.google.com/home/usersettings** and switch **Google Apps Script API** on.
2. In Terminal, in the portal folder:
   ```bash
   npm install
   npm run google:login      # a browser opens: sign in with your work Google account and click Allow
   npm run google:deploy     # builds, uploads and publishes; prints your portal link
   ```
3. Open the portal link. Google asks you to **Review permissions** → choose your account → **Allow**. (If you see "Google hasn't verified this app", click *Advanced* → *Go to CS QA Portal*: it's your own script.) You're now the Super Admin.
4. *(Optional, if you set people up in local review)* In local review: *Users & Roles* → **Download setup file**. In the Google version: *Data Import* → **Load setup file** — do this **before** the first sync.
5. *Data Import* → **Sync live + archives**. New live weeks arrive as drafts; past weeks are published on the first sync.
6. *Reporting & Settings* → **Automatic jobs → Turn on**. Turn on email notifications there if you want them.
7. *Users & Roles* → add people with their work email (or load the Lead mapping on *Teams*), then **Send invite**.

**Updating later:** run `npm run google:deploy` again. The portal link stays the same.

**Your own address:** Apps Script links always look like `https://script.google.com/macros/s/…/exec`. Ask IT to point a company address (for example `csqa.<your-domain>`) at that link with a redirect, or put it on a Google Sites page with that address.

### Limits to know
* Pages take a few seconds to load (Google runs the portal on demand).
* Gmail sends to at most **1,500 recipients a day** (a CC counts as one).
* Any single action is limited to 6 minutes. Sheets are synced one at a time, well inside this.
* If you ever move the portal to another Google account, the data folder moves with a copy of the script. Ask before doing this.

### If something goes wrong
| You see | Do this |
|---|---|
| `You are not signed in yet` when deploying | `npm run google:login` |
| "Access blocked" when logging in with clasp | Your Google Workspace admin blocks the Apps Script command-line tool. Ask IT to allow **Google Apps Script CLI (clasp)**. |
| "Authorization is required" on the portal link | `cd google && npx clasp open-script`, pick the function **authorize** at the top and click **Run**, then **Allow** |
| "You don't have access yet" | Add that email under *Users & Roles* |
| Sync says the owner cannot open a sheet | Share that sheet with your account (Viewer is enough) |

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
1. The first time, the portal asks you to create the **Super Admin** login for this computer.
2. Open **Data Import** and click **Download latest CSV from the sheet**. This downloads the responses tab (the gid set in `.env`) using your own Google login. Then choose that file on the same page. Tick *Publish new weeks immediately* to see every week at once.
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
4. (Optional) Enable the `pg_cron` and `pg_net` extensions, then run `supabase/cron.sql` for auto-publishing, SLA reminders (due-soon and overdue), sheet sync and email.
5. Under **Authentication → Policies → Password strength**, set the minimum length to **10** and require **letters and digits** (the same rule the portal shows; `config.toml` sets it for local Supabase).

### 4.1a Upgrading an existing project (October 2026 update)
Projects set up before 7 Oct 2026 need one extra step. In the Supabase **SQL editor**, paste and run
`supabase/migrations/20261007000008_brief_gaps.sql` once (it is safe to run again), then redeploy the changed function:
```bash
npx supabase functions deploy admin-users
```
The update was tested on PostgreSQL 16 both on a fresh database and on one already holding data. What it changes is listed in §10.

### 4.2 First Super Admin (do this once, in the SQL editor)
```sql
insert into public.employees (email, full_name, role)
values ('you@example.com', 'Your Name', 'super_admin');
```
Next, in **Auth → Users → Invite user**, invite the same email. The `on_auth_user_created` trigger links the login to the employee record. After that, add everyone else from **Users & Roles** and **Teams**. The *Send invite* button uses the `admin-users` function.

If invitation emails can't be delivered yet (custom SMTP not set up), use **Auth → Users → Add user → Create new user** with the same email, a strong password and *Auto Confirm User* ticked; the trigger links it the same way. For everyone else, **Users & Roles → Set password** creates a temporary password that must be changed at first sign-in.

The database always keeps at least one active Super Admin, and a Super Admin cannot remove their own access, so create a second QA Super Admin early.

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

**Option C: sync without a service account (Apps Script inside the sheet).** Use this when your company doesn't allow Google Cloud projects. A short script in the audit sheet sends new rows to the portal every 30 minutes, running as you. Nothing is made public.
1. Make up a long random secret (at least 24 characters, letters and numbers). In Supabase, open **Edge Functions → Secrets → Add new secret**: name `SHEETS_PUSH_SECRET`, value = your secret.
2. Deploy the receiving function once: `npx supabase functions deploy sheets-push --no-verify-jwt`
3. Open the audit sheet → **Extensions → Apps Script**. Delete what's there, paste all of `scripts/apps-script/push-to-portal.gs`, and save.
4. In the Apps Script editor: **Project Settings (gear) → Script Properties → Add script property**: `PORTAL_PUSH_SECRET` = the same secret.
5. Check the `TABS` list at the top of the script (tab name `Form Responses 1` for the live form).
6. Choose **pushToPortal** at the top and click **Run** → **Review permissions** → your account → **Allow**. The first run sends everything (it continues on the next run if it needs more than about 4 minutes).
7. Choose **installTrigger** and click **Run** once. From now on it runs every 30 minutes. (**removeTrigger** stops it.)
8. Results appear under **Data Import → Import history** (source *google_sheets*). For archive years, paste the same script into the archive sheet with its tab names and `source: 'archive'`, then run **pushToPortal** once (no trigger needed).

**Score changes back to the sheet.** The same Apps Script also writes portal score changes (approved appeals, QA corrections) back into the audit sheet at the end of every run: the original row (matched by DS Task Link + CAM Name + QA Week) gets the new parameter score and task Score, each with a cell note showing the old value, the reason and who approved it, and every change is listed in a **Portal Score Changes** tab. `installTrigger` sets up three jobs: **onAuditSubmitted** (a new form submission reaches the portal within seconds), **everyMinute** (sends portal emails and writes score changes back; it reads the audit tab only when there is a change) and a 30-minute safety-net **pushToPortal**. After pasting a newer version of the script, run `installTrigger` once.

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

## 5a-2. Emails from your Gmail (no SMTP)

When the company's Google Workspace blocks SMTP, set **Reporting & Settings → Notifications → Send portal emails through: My Gmail, via the Google Sheet script** (the live project uses this). Then:
* **Send invite / Send password link** (Users & Roles) and **Forgot password?** create a one-time link (Supabase sends nothing) and queue the email.
* The sheet script's `sendPortalEmails` (scheduled every minute by `installTrigger`) sends queued emails — invitations, password links, appeal notifications and weekly reports — from the script owner's Gmail with `MailApp`, then reports back. One-time links are removed from the stored copy once sent.
* The link opens `#/auth-confirm`, which signs the person in once and takes them to **Choose your password**.
* Limits: Gmail allows about 1,500 recipients a day; invitation links expire after 24 hours, password links after 1 hour.

## 5b. Roles

| Role | Who | Can |
|---|---|---|
| Super Admin | QA owners | Everything, including users, teams, scoring, settings, data import and the audit log |
| Evaluator | QA analysts | Everything QA sees (all teams, draft weeks, internal comments); decide appeals (including on their own audits); correct scores; publish weeks, set appeal closing dates and auto-publish times; send weekly emails; **My Audits** |
| Admin | Team Leads | Their team's results and appeals (review and forward to QA) |
| User | CAMs | Their own results; raise appeals |

## 6. Pages
Login · Forgot/Reset password · QA Master Dashboard (organisation, by Team Lead, individual CAM) · Team Lead Dashboard · CAM Personal Dashboard (also opened by Leads and QA for any CAM in their scope) · Task Evaluations and Evaluation Detail · Report History (weekly, monthly, quarterly) · Parameter Analysis · Appeal form (from any evaluation) · CAM Appeal History · Lead Review Queue · QA Review Queue · Appeal Detail & Timeline · Download Reports · Users & Roles · Teams & Assignments · Scoring Configuration · Reporting Periods & Settings · Data Import & Validation · Notifications · Audit Logs.

## 7. Tests (all run in the build environment)

| Suite | Command | Result |
|---|---|---|
| SQL security + workflow + weekly emails + archive import + Oct 2026 gap fixes (real PostgreSQL 16, Supabase auth shim) | `npm run test:db` | 161 assertions passed (7 Oct 2026, macOS + Homebrew PostgreSQL 16) |
| Oct 2026 update applied on top of a database already holding data, then its tests | — | passed; running the update twice is harmless |
| Direct Google sync in local mode, Google endpoints replaced by the real live + 2022 archive exports | `node e2e/local-google.mjs` | 11,594 + 7,220 audits loaded; 52 archived names; linking moves their audits |
| Unit tests (mapper, metrics, demo rules) | `npm test` | 31 passed |
| Mapper vs the live sheet (re-run 29 Sep 2026: 11,678 rows, WK-2 → WK-39) | — | 11,594 valid, 73 duplicates, 11 genuine data errors |
| SMTP delivery path (nodemailer, TLS 465, To + CC + Reply-To) against a local mail server | — | delivered |
| Weekly Report Emails page in the demo (send, skip already-sent) | `node e2e/emails.mjs` | passed |
| Playwright: every page as CAM, Lead and QA, plus mobile | `PW_EXEC=<path to Chrome> node e2e/smoke.mjs` | no page errors (re-run 7 Oct 2026) |
| Playwright: full appeal (CAM → Lead → QA → score recalculated; isolation checks) | `PW_EXEC=<path to Chrome> node e2e/workflow.mjs` | passed (re-run 7 Oct 2026) |
| Super Admin sets a temporary password → CAM signs in, must change it, sees no admin pages; password never stored or logged in readable form | `node e2e/passwords.mjs` | 16/16 passed |
| **Google version, server:** access rules for CAM / Lead / QA / outsiders, appeal flow with no Lead bypass, emails (no scores, CC Lead, no other CAMs), Drive evidence, scheduled jobs, cold start from Drive, setup file — `google/Code.js` in a simulated Apps Script runtime with the real live + 2022 exports | `node e2e/google-api.mjs` | 75 checks passed |
| **Google version, in the browser:** Google sign-in, sheet sync from the page, CAM/Lead/no-access screens, email deep links | `node e2e/google-ui.mjs` | 15 checks passed |
| Edge Functions type check | `deno check supabase/functions/*/index.ts` | passed |

The SQL suite covers: CAM, Lead, stranger and anonymous isolation; ID-guessing attempts; blocked role escalation; draft weeks hidden; appeals that skip the Lead are rejected; a Lead can't finalise; QA can't decide before the Lead has reviewed; duplicate-appeal and appeal-window enforcement; partial approvals; overturning an autofail with re-scoring; reopening an appeal and reverting it; append-only history; evidence policies; SLA sweeps; and import validation.

## 8. What still needs your configuration (not live yet)

| Item | Status |
|---|---|
| **Google version** | Built and tested against a simulated Google environment (Drive, Sheets, Gmail, triggers). **Not yet run on real Google** — that happens when you run `npm run google:deploy` (§0) |
| Supabase project, auth settings, migrations | Needs your project. Migrations are tested on PostgreSQL 16 with a Supabase shim, not yet on a hosted Supabase project |
| Hosting (Vercel etc.) | Not deployed. `npm run build` output is ready |
| Google Sheets sync | Code written and type-checked. Needs a service account and the sheet shared with it; not run against Google |
| Email sending (weekly reports + notifications) | Tested against a local SMTP server. Needs your SMTP or Resend credentials; not yet sent through Google or Resend |
| Live Google Sheet sync | Needs the service account (§5, option B). Until then, upload a CSV export on Data Import |
| Team Lead emails | Needs the CAM ↔ Lead mapping file (§5a) |
| Scheduled jobs | `cron.sql` provided. Needs pg_cron/pg_net enabled |
| Invites and deactivation of logins | `admin-users` function written and type-checked. Not run against a live project |
| `seed-demo.ts` (demo data in a DEV project) | Type-checked. Not run against a live project |
| `ALLOWED_ORIGIN` function secret | Required: the Edge Functions only answer the portal's own address (they no longer fall back to "any site") |
| Notifications → Portal URL | Required for links in emails and weekly report emails |
| Supabase Auth email (invites, password reset) | Supabase's built-in sender only reaches your project team. Set custom SMTP under **Authentication → Emails → SMTP** before inviting CAMs |
| Weekly auto-publish schedule | Works once `cron.sql` runs `publish_due_periods()`; nothing publishes automatically without it |
| Due-soon / overdue appeal reminders | Need `cron.sql` (`appeal_sla_sweep()`) |

## 9. Demo build
`npm run build:demo` creates a single self-contained HTML file with **fictional** people and audits (`@demo.csqa.test`, password `Demo@2026`). It is clearly marked as a demo and keeps changes in that viewer's browser only. It never contains real employee data.

## 10. October 2026 review against the project brief

The portal was checked line by line against the original brief. These gaps were fixed:

**Dashboards and reports**
* QA Master Dashboard: *CAM name* and *Evaluation category* filters; the *Individual CAMs* tab now shows the selected CAM's full dashboard; appeal counts use the same scope as the table and say which period they cover.
* Weekly **and monthly** trend on every dashboard; weeks or months without audits show "No Data".
* Score badges carry an icon and a screen-reader label, so results never rely on colour alone. Metric definitions (ⓘ) on KPI tiles and table headers.
* Parameter table: *Related QA feedback* column; the drill-down lists every evaluated task (deductions first) with the per-parameter QA remark.
* **Final rating** (policy) shown separately from the raw score: *Meets standard* needs the average at or above the QA target **and** the autofail rate within the limit.
* Report History: quarterly summaries and a year of history; QA can export draft weeks. Every download is written to the audit log.
* PDF: line chart of the trend, previous-period and variance per parameter, final rating, appeal decision dates and Lead recommendation, and an explicit "No QA evaluations…" message for empty periods. Excel adds the same columns. CSV starts with a summary block (period, generation date, confidentiality notice).

**Appeals**
* *Raise appeal* from the task list, from each parameter row ("Appeal this"), and directly from the Appeals page; parameters already under appeal are disabled.
* The form shows the true original score, the per-parameter QA remark, the scoring criteria, the submission date and when the reference is assigned.
* Evidence is uploaded while the appeal is still a draft and only then submitted, so a failed upload never leaves a submitted appeal without its files.
* Drafts can be edited. The weekly appeal limit also applies when a draft is submitted. Two simultaneous submissions can no longer both pass the duplicate check. A **closed** appeal no longer blocks a new one.
* Lead (author) or QA can **share an internal comment** with the CAM.
* QA must give a reason for every approved score change; each parameter shows who decided it and when; approvals that raise a score less than requested show as *Partially approved*. Reopening clears the previous decision (it stays in the timeline and audit log).
* *Days since submitted* column next to *Days in status*; the disputed-parameter filter matches exact parameters.
* Scoring criteria text per parameter (editable under Scoring Configuration) is shown to the CAM, Lead and QA during appeals.

**Notifications**
* Every appeal notification carries the reference, task ID and current status; the CAM gets a receipt on submission; the Lead is told when a CAM withdraws.
* "Report published" links open the CAM's dashboard for that week (the old link went to a missing page), and CAMs are also notified when a recent week is created already published by an import. Back-filled archive weeks do not notify anyone.
* "Due soon" reminders a day before a review target, as well as "overdue".
* Separate in-app and email switches per notification type (including *Appeal reopened*).

**Administration and security (enforced in the database)**
* At least one active Super Admin always remains; a Super Admin cannot demote or deactivate themselves; a Lead who still leads a team cannot be turned into a CAM; only active Admins can lead a team.
* Settings are validated (thresholds, days, week start, time zone, portal URL) and new employee emails must look like email addresses.
* A week's status can only change through Publish / Unpublish or the schedule. The **weekly auto-publish schedule** now actually publishes draft weeks that have audits.
* The audit log records every appeal action with its reason, item decisions and report downloads; the viewer filters by person, date range and record, shows full record IDs and exports to CSV.
* Users: the header shows a Lead's team(s); QA can't change their own role in the form; Data Import has a column-mapping step for renamed headers and a downloadable validation report (valid, duplicate and rejected rows with reasons); all server rejections can be downloaded.
* Edge Functions no longer accept requests from any website when `ALLOWED_ORIGIN` is missing; deactivating a user stops before touching the login if the database refuses.

**Deliberately unchanged (and why)**
* *Table names.* The brief's `users`, `evaluation parameters` and `appeal reviews` tables are `employees`, `evaluation_parameters`, and `appeal_events` + `appeal_items` here. Same information; renaming would break the live database for no gain.
* *Unique task key.* Duplicates are detected by DS Task Link + CAM + QA Week, because the same link legitimately appears in more than one week (see §3).
* *Audit week assignment* comes from the form's *QA Week* label, which is how the QA team already assigns weeks; inferring it from timestamps would disagree with the sheet.
* *Team history.* A Lead sees their current CAMs' full history; when a CAM moves team, the new Lead sees their history. Keeping per-audit team snapshots would need a design decision from QA.
* *Session time-out* is enforced in the browser (`VITE_IDLE_TIMEOUT_MINUTES`); a server-side inactivity limit is a paid Supabase feature (Auth → Sessions).
* *Late clarification answers* are still accepted after the deadline (the appeal is flagged overdue and reminders go out) rather than auto-closed, so a CAM is never cut off by a timer.

