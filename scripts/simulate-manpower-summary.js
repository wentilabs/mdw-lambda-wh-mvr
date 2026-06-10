#!/usr/bin/env node
// Simulate POST /daily-manpower-summary in dry-run mode and print the message.
// Usage: node scripts/simulate-manpower-summary.js [DD-MMM-YYYY] [groupId]

require("dotenv").config();

const handler = require("../api/daily-manpower-summary");

const dateArg = process.argv[2] || "07-May-2026";
const groupArg = process.argv[3] || "120363425972155556@g.us"; // MBS IR2 - WH SAFETY

const event = {
  body: JSON.stringify({
    date: dateArg,
    groupId: groupArg,
    dryRun: true,
  }),
};

const res = {
  status: (code) => ({
    json: (body) => ({ statusCode: code, body }),
  }),
};

(async () => {
  console.log(`\n═══ Simulating POST /daily-manpower-summary ═══`);
  console.log(`Date: ${dateArg}   Group: ${groupArg}   dryRun: true\n`);
  const result = await handler(event, res);
  const out = result.body;
  console.log(`\n── HTTP ${result.statusCode} ──`);
  console.log(`success:        ${out.success}`);
  console.log(`date:           ${out.date}`);
  console.log(`totalRecords:   ${out.totalRecords}`);
  console.log(`totalWorkers:   ${out.totalWorkers}`);
  console.log(`totalMachines:  ${out.totalMachines}`);
  console.log(`companies:      ${JSON.stringify(out.companies)}`);
  console.log(`\n═══ MESSAGE THAT WOULD BE SENT ═══\n`);
  console.log(out.message);
  console.log(`\n═══ END ═══\n`);
})().catch((err) => {
  console.error("Failed:", err?.stack || err);
  process.exit(1);
});
