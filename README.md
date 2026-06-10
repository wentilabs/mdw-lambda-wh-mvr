# wenti-base-wohhup

> **GitHub template repo** for spawning new Wohhup Lambda projects (Safety + Manpower + QA Agent).

This repo is **not** meant to run directly. Use it as a template via the admin-fe rollout flow:
**Customers → Wohhup → Projects → "Roll out new project"**.

The rollout system clones this repo, replaces the `__FUNCTION_NAME__` placeholder in
the deploy workflow with the new Lambda's name, sets repo secrets, creates AWS
resources (Lambda, API Gateway, IAM role, Security Group, EventBridge rules), and
triggers the initial GitHub Actions deploy.

## After rollout

Each spawned project is an **independent** GitHub repo + AWS Lambda. Changes made to
this base repo do **not** propagate to existing spawned projects — each one evolves
on its own.

To configure a freshly-rolled-out project, go to the admin-fe project detail page:

- **Environment Variables** tab — fill in `SAFETY_SPREADSHEET_ID`, `MANPOWER_SPREADSHEET_ID`,
  `WBGT_SPREADSHEET_ID`, `MACHINES_SPREADSHEET_ID`, `MANPOWER_DATA_SPREADSHEET_ID`,
  `SAFETY_WA_GROUP_ID`, `QA_WA_GROUP_ID`, `CRON_JOB_SECRET`. The shared keys
  (`BASE_LISTENER_URL`, `CLIENTIDENTIFIER`, `WHATSAPP_CLIENT_ID`, `MENTION_BOT_ID`,
  `SECRET_NAME`, `APP_VERSION`, `SCRAPE_API_URL`) are pre-filled.
- **WhatsApp Groups** tab — add the WA group → Lambda routing in
  `wa_group_permissions`.
- **Cron Jobs** tab — toggle each of the 8 default crons once the env vars are set.

## What this template ships

### Usecases (`usecases/`)

- `health_safety/` — safety issue + manpower + WBGT (LLM intent classification + dispatch)
- `qa_agent/` — mention-based QA agent over Safety / Manpower / Machines / WBGT

### API routes (`api/`)

- `daily-safety-summary.js`, `p1-safety-reminder.js`, `wbgt-reading.js`
- `daily-manpower-summary.js`, `daily-manpower-data.js`, `manpower-reminder.js`
- `daily-report.js`, `weekly-report.js`

### Handlers

- `safety-handlers.js`, `manpower-handlers.js`, `manpower-extract.js`,
  `wohhup-manpower-extract.js`, `manpower-gsheet.js`, `wbgt-monthly-handlers.js`
- `prompts/safety-prompts.js`, `prompts/activity-classifier-prompt.js`

### Utilities

- Google Sheets, Supabase, OpenAI, Secrets Manager, WA listener client,
  date helpers, log collectors, role classifier, WH staff/worker trackers.

## Local dev

```bash
yarn install
node -e "require('./index')"   # boot check (must succeed with no errors)
node index-dev.js              # local server (uses .env via dotenv)
```

Set `USE_LOCAL_ENV=true` in `.env` to skip Secrets Manager and use local env vars
directly.

## Independence guarantee

This template was extracted from `mdw-lambda-wh-mbs` at a snapshot in time. Once a
project is spawned from it, both repos diverge freely. There is **no** automated
sync. If the template adds a feature later, you must manually port it to spawned
projects (or vice-versa). This was an intentional design decision for simplicity
and isolation.
