#!/usr/bin/env node
/**
 * Backfill noise data to Google Sheets for specific dates.
 * Calls the sheet-update handler for each date that has data in Supabase.
 *
 * Usage:
 *   node scripts/backfill-noise-sheets.js                    # All dates with data
 *   node scripts/backfill-noise-sheets.js --date 2026-04-07  # Specific date
 */

process.env.USE_LOCAL_ENV = "true";
require("dotenv").config();

const { parseArgs } = require("util");
const { handler } = require("../usecases/noise_notification/index");

const { values } = parseArgs({
  options: { date: { type: "string" } },
});

async function backfillDate(dateStr) {
  console.log(`\nBackfilling ${dateStr}...`);

  const event = {
    noise: {
      action: "sheet-update",
      date: dateStr,
      requestType: "POST",
    },
  };

  try {
    const result = await handler(event, {});
    const body = JSON.parse(result.body || "{}");
    if (body.success) {
      console.log(`  ✅ ${dateStr}: ${body.message || "success"}`);
    } else {
      console.log(`  ❌ ${dateStr}: ${body.message || body.error || "failed"}`);
    }
  } catch (err) {
    console.log(`  ❌ ${dateStr}: ${err.message}`);
  }
}

async function main() {
  if (values.date) {
    await backfillDate(values.date);
    return;
  }

  // Find all dates with data in Supabase
  const { getSupabaseClient } = require("../utils/common");
  const client = getSupabaseClient();
  const { data } = await client
    .schema("wohhup")
    .from("ir2_noise_data_daily")
    .select("timestamp")
    .order("timestamp", { ascending: true })
    .limit(5000);

  const dates = [...new Set(data.map((r) => r.timestamp.substring(0, 10)))].sort();
  console.log(`Found ${dates.length} dates with noise data: ${dates.join(", ")}`);

  for (const date of dates) {
    await backfillDate(date);
  }
}

main()
  .then(() => console.log("\nDone"))
  .catch((err) => console.error("Fatal:", err));
