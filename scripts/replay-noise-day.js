#!/usr/bin/env node
/**
 * Replay a full day of noise data through the production Leq1hr notification logic.
 *
 * For each hour 07-22 SGT on the given date:
 *   1. Read 5min readings from supabase wohhup.ir2_noise_data_daily
 *   2. Compute Leq1hr (production calculator)
 *   3. Resolve leq_1hr limit from the live Limits sheet
 *   4. Print whether sendMultiLocationNotification would fire
 *
 * Usage:
 *   NOISE_LIMITS_SPREADSHEET_ID=… node scripts/replay-noise-day.js 2026-05-08
 *   node scripts/replay-noise-day.js 2026-05-08 --hour=22   # one hour only
 */

require("dotenv").config();
process.env.DRY_RUN_NOTIFICATION = "true";

const { getSupabaseClient } = require("../utils/common");
const { calculateLeq1hr } = require("../usecases/noise_notification/calculator");
const { getNoiseLimitsForMetrics } = require("../usecases/noise_notification/config-loader");
const { sendMultiLocationNotification } = require("../usecases/noise_notification/notification");

const LOCATIONS = [
  { code: "NM01", name: "NM1: Marina Bay Sands Tower 1, Level 6 balcony" },
  { code: "NM02", name: "NM2: Marina Bay Residences, Level 27" },
];

// Suppress calculator debug logs
const realLog = console.log;
console.log = (...a) => {
  if (
    typeof a[0] === "string" &&
    (a[0].startsWith("[DEBUG]") ||
      a[0].startsWith("- Input") ||
      a[0].startsWith("- Energy") ||
      a[0].startsWith("- Sum") ||
      a[0].startsWith("- Average") ||
      a[0].startsWith("- Final") ||
      a[0].startsWith("Loading") ||
      a[0].startsWith("Using cached") ||
      a[0].startsWith("✓ Loaded"))
  )
    return;
  realLog(...a);
};

const args = process.argv.slice(2);
const date = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const hourArg = args.find((a) => a.startsWith("--hour="));
const oneHour = hourArg ? parseInt(hourArg.split("=")[1], 10) : null;

if (!date) {
  console.error("Usage: node scripts/replay-noise-day.js YYYY-MM-DD [--hour=N]");
  process.exit(1);
}

async function replayHour(date, hour) {
  const sb = getSupabaseClient().schema("wohhup");
  const checkDate = new Date(date + "T12:00:00");
  const start = `${date}T${String(hour).padStart(2, "0")}:00:00`;
  const end = `${date}T${String(hour).padStart(2, "0")}:59:59.999`;

  const metricsList = [];
  const perLoc = [];
  for (const loc of LOCATIONS) {
    const { data } = await sb
      .from("ir2_noise_data_daily")
      .select("timestamp, leq_5min")
      .eq("location", loc.name)
      .gte("timestamp", start)
      .lte("timestamp", end)
      .order("timestamp", { ascending: true });

    if (!data || data.length === 0) {
      perLoc.push(`${loc.code}: (no data)`);
      continue;
    }
    const vals = data.map((r) => Number(r.leq_5min)).filter(Number.isFinite);
    const leq1hr = calculateLeq1hr(vals);
    const lim = await getNoiseLimitsForMetrics(loc.code, hour, checkDate);
    metricsList.push({ location: loc.code, currentLeq1hr: leq1hr, hourlyLimit: lim.leq_1hr });
    const verdict = leq1hr > lim.leq_1hr ? "⚠ EXCEEDS" : "✓ within";
    perLoc.push(`${loc.code}: Leq1hr=${leq1hr.toFixed(1)} vs limit=${lim.leq_1hr}  ${verdict}`);
  }

  const result = await sendMultiLocationNotification(metricsList, ["test@g.us"], hour, 33);
  const fires = !(result.sent === false && /within/i.test(result.message || ""));
  const hourLabel = String(hour).padStart(2, "0") + ":00";

  if (fires) {
    realLog(`${hourLabel}  → MESSAGE`);
    for (const l of perLoc) realLog(`         ${l}`);
    realLog(`         ${(result.message || "").split("\n").slice(1).join(" | ")}`);
  } else {
    realLog(`${hourLabel}  → silent   ` + perLoc.join("  |  "));
  }
}

(async () => {
  realLog(`\n═══ NOISE REPLAY — ${date} ═══`);
  realLog("Format: HH:MM  → MESSAGE/silent  per-location Leq1hr vs limit\n");

  const hours = oneHour != null ? [oneHour] : Array.from({ length: 16 }, (_, i) => 7 + i); // 7-22 SGT
  for (const h of hours) {
    await replayHour(date, h);
  }
})().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
