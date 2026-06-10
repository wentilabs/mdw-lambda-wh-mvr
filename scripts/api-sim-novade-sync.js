#!/usr/bin/env node
// True API-trigger simulation. Builds a Lambda-style event (JSON body) and
// calls the same route handler that index.js wires up for the cron-fired
// POST /novade-safety-sync. Full chain:
//   route handler → JSON body parse → syncHandler → result.
//
// Mode is selected by SAFETY_SPREADSHEET_ID + NOVADE_PROJECT_NAME env vars,
// not by a body param. Edit .env to switch test ↔ prod.
//
// Usage:
//   node scripts/api-sim-novade-sync.js backfill   # body: {"backfill": true}
//   node scripts/api-sim-novade-sync.js daily      # body: {"backfill": false}
//   DRY_RUN=1 node scripts/api-sim-novade-sync.js backfill

require("dotenv").config();

const processRoute = require("../api/novade-safety-sync");

const mode = (process.argv[2] || "daily").toLowerCase();
const body = {
  backfill: mode === "backfill",
  dryRun: process.env.DRY_RUN === "1",
};

const event = {
  httpMethod: "POST",
  path: "/novade-safety-sync",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
};

// Mock the response helper that the route uses (`res.status(code).json(body)`)
let responseStatus = 0;
let responseBody = null;
const res = {
  status: (code) => ({
    json: (data) => {
      responseStatus = code;
      responseBody = data;
      return { statusCode: code, body: JSON.stringify(data) };
    },
  }),
};

(async () => {
  console.log("\n══ API Simulation: POST /novade-safety-sync ══");
  console.log(`  Body: ${event.body}`);
  console.log(`  SAFETY_SPREADSHEET_ID: ${(process.env.SAFETY_SPREADSHEET_ID || "").slice(0, 12)}…`);
  console.log(`  NOVADE_PROJECT_NAME:   ${process.env.NOVADE_PROJECT_NAME || "(default MBS-IR2)"}\n`);

  const t0 = Date.now();
  await processRoute(event, res);
  const elapsedMs = Date.now() - t0;

  console.log(`\n══ HTTP ${responseStatus} (${(elapsedMs / 1000).toFixed(1)}s) ══`);
  // Trim toCreate dump but keep summary
  if (responseBody && Array.isArray(responseBody.toCreate)) {
    responseBody = { ...responseBody, toCreate: `(${responseBody.toCreate.length} entries — omitted)` };
  }
  console.log(JSON.stringify(responseBody, null, 2));
})().catch((err) => {
  console.error("\nAPI sim crashed:", err?.stack || err);
  process.exit(1);
});
