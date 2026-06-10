/**
 * Noise 5-Minute Reading API endpoint
 *
 * Triggers the IR2 scraper, waits 2 minutes for data to land, then fetches the
 * latest Leq5min row per location from Supabase (no time-window math — always the
 * most recent row), checks it against the applicable Leq5min limit for the current
 * hour/day-type, and sends a WhatsApp alert if any location exceeds.
 *
 * POST /noise-reading-5min
 * {
 *   "groupIds": ["120363xxx@g.us"]  // Required
 * }
 */

const axios = require("axios");
const { readNoiseData } = require("../utils/common");
const { convertToSingaporeTime } = require("../utils/date");
const { getHourlyNoiseLimitsForMetrics } = require("../usecases/noise_notification/calculator");
const { normalizeLocationCode } = require("../usecases/noise_notification/config-loader");
const { sendWhatsAppMessage } = require("../utils/sendMessage");

const IR2_NOISE_TRIGGER_URL = "https://api4.wentilabs.com/api/run-ir2-noise";
// 2 min — leaves ~3 min for read + notify within a 5-min cron window
const IR2_NOISE_WAIT_MS = 2 * 60 * 1000;

const LOCATIONS = [
  "NM1: Marina Bay Sands Tower 1, Level 6 balcony",
  "NM2: Marina Bay Residences, Level 27",
];

/**
 * Fetch the single most recent row for a location, regardless of time window.
 * @param {string} location - Full location string matching the DB value
 * @returns {object|null} - Latest row or null if none found
 */
async function fetchLatestReading(location) {
  const { data, error } = await readNoiseData({
    location,
    orderBy: "timestamp",
    ascending: false,
    limit: 1,
  });

  if (error) {
    console.error(`[Noise5min] Supabase error for ${location}:`, error);
    return null;
  }

  return data && data.length > 0 ? data[0] : null;
}

/**
 * Extract the Leq5min dBA value from a row, handling column name variants.
 * @param {object} row
 * @returns {number|null}
 */
function extractLeq5min(row) {
  const raw = row.Leq5min ?? row.leq5min ?? row.leq_5min ?? row.leq ?? row.value;
  if (raw === undefined || raw === null) return null;
  const parsed = parseFloat(raw);
  return isNaN(parsed) ? null : parsed;
}

/**
 * Process the 5-minute noise check and send an alert if any location exceeds its Leq5min limit.
 */
async function processNoiseReading5minRequest(req, res) {
  try {
    let body = {};
    try {
      body = JSON.parse(req.body || "{}");
    } catch (_) {}

    const { groupIds } = body;

    if (!groupIds || !Array.isArray(groupIds) || groupIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: "groupIds is required",
        message: "Please provide a non-empty array of WhatsApp group IDs in the request body",
      });
    }

    // Determine current SGT time
    const now = new Date();
    const sgTime = convertToSingaporeTime(now, { format: "locale" });
    const sgDate = new Date(sgTime);
    const currentHour = sgDate.getHours();
    const currentMinutes = sgDate.getMinutes();

    console.log(`[Noise5min] SGT time: ${sgTime} (hour=${currentHour})`);

    if (currentHour < 7 || currentHour > 22) {
      console.log(`[Noise5min] Outside tracking hours, skipping.`);
      return res.status(200).json({
        success: true,
        message: `Outside tracking hours (SGT hour: ${currentHour}), no check performed`,
        data: { sgtHour: currentHour, skipped: true },
      });
    }

    // Trigger IR2 scraper then wait for data to land
    console.log(`[Noise5min] Triggering IR2 scraper at ${IR2_NOISE_TRIGGER_URL}...`);
    try {
      const triggerResponse = await axios.post(IR2_NOISE_TRIGGER_URL, {}, { timeout: 60000 });
      console.log(`[Noise5min] IR2 trigger response: ${triggerResponse.status}`);
    } catch (triggerError) {
      console.error("[Noise5min] IR2 trigger failed (continuing anyway):", triggerError.message);
    }

    console.log(`[Noise5min] Waiting ${IR2_NOISE_WAIT_MS / 1000}s for IR2 data...`);
    await new Promise((resolve) => setTimeout(resolve, IR2_NOISE_WAIT_MS));

    // Check each location
    const results = [];

    for (const loc of LOCATIONS) {
      const nmMatch = loc.match(/^(NM\d+)/);
      const rawCode = nmMatch ? nmMatch[1] : "UNKNOWN";
      const code = normalizeLocationCode(rawCode);

      const row = await fetchLatestReading(loc);
      if (!row) {
        console.log(`[Noise5min] No data for ${code}, skipping`);
        results.push({ location: code, skipped: true, reason: "no_data" });
        continue;
      }

      const leq5min = extractLeq5min(row);
      if (leq5min === null) {
        console.log(`[Noise5min] No Leq5min value in latest row for ${code}`);
        results.push({ location: code, skipped: true, reason: "no_leq5min_field" });
        continue;
      }

      const limits = await getHourlyNoiseLimitsForMetrics(code, currentHour, sgDate);
      const limit = limits.leq_5min;

      const exceeded = limit !== null && leq5min > limit;
      console.log(
        `[Noise5min] ${code}: Leq5min=${leq5min} limit=${limit ?? "N/A"} timestamp=${row.timestamp} exceeded=${exceeded}`,
      );

      results.push({
        location: code,
        leq5min,
        limit,
        timestamp: row.timestamp,
        exceeded,
      });
    }

    // Build and send alert if any location exceeded
    const exceeding = results.filter((r) => r.exceeded);

    let notificationResult = { sent: false, message: "No Leq5min limit exceeded" };

    if (exceeding.length > 0) {
      const fmt = (n) => Number.parseFloat(n).toFixed(1).replace(/\.0$/, "");
      const timeDisplay = `${currentHour}:${String(currentMinutes).padStart(2, "0")}`;

      const messages = exceeding
        .sort((a, b) => a.location.localeCompare(b.location))
        .map(
          (r) =>
            `🔴 ${r.location} 5 min Leq exceeded, ${timeDisplay}:\n${r.location}: ${fmt(r.leq5min)} dBA (limit ${fmt(r.limit)})`,
        );
      const message = messages.join("\n\n");

      if (process.env.DRY_RUN_NOTIFICATION === "true" || process.env.USE_LOCAL_ENV) {
        console.log("[Noise5min][DRY RUN] Would send:", messages);
        notificationResult = { sent: false, dryRun: true, message, messages };
      } else {
        const sendResults = [];
        for (const gid of groupIds) {
          for (const alertMessage of messages) {
            try {
              await sendWhatsAppMessage(gid, alertMessage);
              sendResults.push({ groupId: gid, message: alertMessage, sent: true });
            } catch (err) {
              console.error(`[Noise5min] Send failed for ${gid}:`, err.message);
              sendResults.push({ groupId: gid, message: alertMessage, sent: false, error: err.message });
            }
          }
        }
        notificationResult = { sent: sendResults.some((r) => r.sent), message, messages, results: sendResults };
      }
    }

    return res.status(200).json({
      success: true,
      sgtHour: currentHour,
      results,
      notification: notificationResult,
    });
  } catch (error) {
    console.error("[Noise5min] Unexpected error:", error);
    return res.status(500).json({
      success: false,
      error: error.message,
      message: "Failed to process 5-minute noise check",
    });
  }
}

module.exports = processNoiseReading5minRequest;
