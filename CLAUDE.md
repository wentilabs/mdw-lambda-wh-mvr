# CLAUDE.md

## Project Overview

**wenti-base-wohhup** — GitHub template repo for spawning new Wohhup Lambda projects.
Each spawned project is an independent AWS Lambda that handles WhatsApp webhook
processing for one Wohhup site/project, supporting Safety + Manpower + QA Agent
usecases out of the box.

This repo is the **source-of-truth** for those 3 shared usecases. It was extracted
from `mdw-lambda-wh-mbs` and is fully independent of it going forward.

## Scope

This template ships with:
- **Safety issue** creation, query, update, close, clone, edit, delete
- **Manpower** data entry, query, edit, delete (writes to Manpower + Machines sheets)
- **WBGT** readings (API-driven, writes to WBGT sheet + WhatsApp notification)
- **QA Agent** — natural-language queries over Safety, Manpower, Machines, WBGT
  via mention-based trigger
- **Daily safety summary**, **P1 safety reminder**, **Daily / Weekly manpower
  summary**, **Manpower reminder**, **Daily / Weekly PDF report** — all
  cron-triggered API routes

**NOT in scope (not in this template):** soil disposal, piling progress,
instrumentation monitoring, pile cap, noise, vibration, document upload, Novade
sync, daily activity update, daily site activity report, WhatsApp viewer.

These can be added per-project later by copying the relevant code from a
project that has them (e.g. wh-mbs).

## Key Architecture

### Message Flow

1. WhatsApp webhook → `index.js` routes by `chatId`
2. `QA_GROUP_IDS` + bot mention → `usecases/qa_agent/index.js`
3. `SAFETY_GROUP_IDS` → `usecases/health_safety/index.js`
4. Intent classification (OpenAI) → handler dispatch
5. Handlers write to Google Sheets via `utils/action.js` + `utils/gsheet.js`

### API Routes

- `GET /version` — App version
- `POST /middleware` — WhatsApp webhook (routes to safety / QA agent)
- `POST /daily-safety-summary`
- `POST /p1-safety-reminder`
- `POST /wbgt-reading`
- `POST /daily-manpower-summary`
- `POST /daily-manpower-data`
- `POST /manpower-reminder`
- `POST /daily-report`
- `POST /weekly-report`

### Config

- `config/group-config.js` — Safety + QA group IDs, spreadsheet config (safety/manpower/wbgt/machines/manpowerDataReport)

## Development

```bash
yarn install
node -e "require('./index')"  # Verify all imports resolve
```

## Environment Variables

**Shared (across all rolled-out projects):**
- `BASE_LISTENER_URL` — WA listener service
- `CLIENTIDENTIFIER`, `WHATSAPP_CLIENT_ID` — WA phone number
- `MENTION_BOT_ID` — bot mention pattern (`@<phone>`)
- `SECRET_NAME` — AWS Secrets Manager secret name (default: `lambda-common-secrets`)
- `APP_VERSION`, `SCRAPE_API_URL`

**Per-project (set on the Lambda after rollout, via admin-fe):**
- `SAFETY_WA_GROUP_ID`, `QA_WA_GROUP_ID` (comma-separated WA group IDs)
- `SAFETY_SPREADSHEET_ID`, `MANPOWER_SPREADSHEET_ID`, `WBGT_SPREADSHEET_ID`,
  `MACHINES_SPREADSHEET_ID`, `MANPOWER_DATA_SPREADSHEET_ID`
- `CRON_JOB_SECRET` (random hex per Lambda; used by guarded cron routes)

**AWS-managed (in Secrets Manager `lambda-common-secrets`, shared):**
- `SUPABASE_URL`, `SUPABASE_SECRET_KEY`
- `OPENAI_API_KEY`
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`

## Critical Rules

- **NEVER** use text/regex matching for NLP — all classification via LLM prompts
- **NEVER** run SQL/PSQL directly — use Supabase JS client
- Always update BOTH classifier and auditor prompts when fixing misclassifications
- Use `yarn` not `npm`
- Each spawned project is INDEPENDENT — changes here do NOT auto-propagate to existing projects
