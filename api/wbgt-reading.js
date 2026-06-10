/**
 * WBGT Reading API endpoint
 *
 * Fetches the latest WBGT reading directly from the Noiselynx provider API
 * and processes it (updates sheets + sends WhatsApp notification).
 *
 * POST /wbgt-reading
 * {
 *   "groupIds": ["120363xxx@g.us", "120363yyy@g.us"]  // Required - Array of WhatsApp group IDs
 * }
 *
 * Requires env: NOISELYNX_WBGT_API_KEY
 */

const axios = require("axios");
const { getGroupConfiguration } = require("../config/group-config");
const { processWBGTReadingFromAPI } = require("../handlers/safety-handlers");

const NOISELYNX_WBGT_URL = "https://www.noiselynx.com/wbgt_api/api/latestData?numRecords=1";
const NOISELYNX_TIMEOUT_MS = 15_000;

/**
 * Format sensor timestamp (SGT local, no TZ marker) to readable format.
 * Input formats:
 *   - "2026-05-13T16:47:15"           (Noiselynx ISO without TZ — current)
 *   - "2026-01-07T11:00:42+00:00"     (legacy Supabase ISO)
 *   - "2026-01-05 11:04:49+00"        (legacy Supabase space-separated)
 * Output: "13-May-2026 16:47"
 * @param {string} timestamp
 * @returns {string} - Formatted timestamp ("DD-MMM-YYYY HH:MM")
 */
function formatReadingTimestamp(timestamp) {
  try {
    if (!timestamp) return "";

    // Try ISO format first: "2026-01-07T11:00:42+00:00"
    let match = timestamp.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);

    // Try space-separated format: "2026-01-05 11:04:49+00"
    if (!match) {
      match = timestamp.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
    }

    if (!match) {
      console.warn("[WBGT API] Could not parse timestamp:", timestamp);
      return timestamp;
    }

    const [, year, month, day, hour, minute] = match;

    // Month names
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const monthName = months[parseInt(month, 10) - 1];

    return `${day}-${monthName}-${year} ${hour}:${minute}`;
  } catch (error) {
    console.error("[WBGT API] Error formatting timestamp:", error);
    return timestamp || "";
  }
}

/**
 * Fetch the latest WBGT reading directly from the Noiselynx provider API.
 * Replaces the previous Supabase round-trip (scraper → table → SELECT) with one HTTP GET.
 * @returns {Promise<{value: number, timestamp: string, formattedTimestamp: string, createdAt: string}|null>}
 */
async function fetchLatestWBGTReading() {
  const apiKey = process.env.NOISELYNX_WBGT_API_KEY;
  if (!apiKey) {
    console.error("[WBGT API] NOISELYNX_WBGT_API_KEY is not set");
    return null;
  }

  try {
    const res = await axios.get(NOISELYNX_WBGT_URL, {
      headers: { Authorization: `BEARER ${apiKey}`, "Content-Type": "application/json" },
      timeout: NOISELYNX_TIMEOUT_MS,
    });

    const body = res.data;
    if (!body || body.Status !== 1) {
      console.error("[WBGT API] Noiselynx returned non-OK status:", body?.Status, body?.StatusDescription);
      return null;
    }

    const row = Array.isArray(body.DataRows) ? body.DataRows[0] : null;
    if (!row || !Array.isArray(row.Datapoint)) {
      console.error("[WBGT API] Noiselynx response missing DataRows[0].Datapoint");
      return null;
    }

    // Provider spec: WBGT outdoor lives at DataIndex 4. Title fallback is case-insensitive
    //   because the live API returns "WBGT Outdoor" while docs say "WBGT outdoor".
    const WBGT_OUTDOOR_INDEX = 4;
    let outdoor = row.Datapoint.find((d) => d.DataIndex === WBGT_OUTDOOR_INDEX);
    if (!outdoor) {
      const label = (body.DataPointLabels || []).find(
        (l) =>
          String(l.Title || "")
            .toLowerCase()
            .trim() === "wbgt outdoor",
      );
      if (label) outdoor = row.Datapoint.find((d) => d.DataIndex === label.DataIndex);
    }
    if (!outdoor || outdoor.Value == null) {
      console.error("[WBGT API] WBGT outdoor value not found in Noiselynx response");
      return null;
    }

    const value = parseFloat(outdoor.Value);
    if (Number.isNaN(value)) {
      console.error("[WBGT API] WBGT outdoor value not numeric:", outdoor.Value);
      return null;
    }

    const ts = row.Timestamp || "";
    console.log("[WBGT API] Noiselynx returned:", { value, timestamp: ts });

    return {
      value,
      timestamp: ts,
      formattedTimestamp: formatReadingTimestamp(ts),
      createdAt: ts,
    };
  } catch (e) {
    console.error("[WBGT API] Noiselynx fetch failed:", e?.message || e);
    return null;
  }
}

/**
 * Process WBGT reading API request
 * @param {object} req - Request object with body
 * @param {object} res - Response object with status and json methods
 */
async function processWbgtReadingRequest(req, res) {
  try {
    let body = {};
    try {
      body = JSON.parse(req.body || "{}");
    } catch (parseError) {
      console.error("[WBGT API] Error parsing request body:", parseError);
    }

    const { groupIds } = body;
    console.log("[WBGT API] Request params:", { groupIds });

    // Validate required parameter
    if (!groupIds || !Array.isArray(groupIds) || groupIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: "groupIds is required",
        message: "Please provide a non-empty array of WhatsApp group IDs (groupIds) in the request body",
      });
    }

    // Get group configuration from the first group ID
    const groupConfig = getGroupConfiguration(groupIds[0]);
    if (!groupConfig) {
      console.warn("[WBGT API] No group configuration found for:", groupIds[0]);
    }

    // Tracking-window check stays — the monthly monitoring sheet only has columns for hours 8–17 SGT.
    const now = new Date();
    const sgtHour = parseInt(
      now.toLocaleString("en-US", { timeZone: "Asia/Singapore", hour: "2-digit", hour12: false }),
      10,
    );
    console.log(`[WBGT API] Current SGT hour: ${sgtHour}`);

    if (sgtHour < 8 || sgtHour > 17) {
      console.log(`[WBGT API] Outside tracking hours (8am-5pm SGT). Skipping WBGT processing.`);
      return res.status(200).json({
        success: true,
        message: `WBGT processing skipped — outside tracking hours (SGT hour: ${sgtHour})`,
        data: { sgtHour, skipped: true },
      });
    }

    // Fetch latest WBGT reading directly from Noiselynx provider API
    console.log("[WBGT API] Fetching latest WBGT reading from Noiselynx...");
    const wbgtReading = await fetchLatestWBGTReading();

    if (!wbgtReading || wbgtReading.value === null || wbgtReading.value === undefined) {
      return res.status(404).json({
        success: false,
        error: "No WBGT reading found",
        message: "Noiselynx returned no usable WBGT reading",
      });
    }

    const readingValue = parseFloat(wbgtReading.value);
    if (isNaN(readingValue)) {
      return res.status(400).json({
        success: false,
        error: "Invalid WBGT reading value",
        message: `The WBGT reading value "${wbgtReading.value}" is not a valid number`,
      });
    }

    // Use current server time as the sheet-row timestamp (API request time)
    const timestamp = new Date();

    console.log(`[WBGT API] Processing WBGT reading: ${readingValue}°C at ${timestamp.toISOString()}`);
    console.log(`[WBGT API] Sensor reading timestamp: ${wbgtReading.formattedTimestamp}`);

    // Process WBGT reading for each recipient group
    const results = [];
    for (const gid of groupIds) {
      console.log(`[WBGT API] Processing for group: ${gid}`);
      try {
        const result = await processWBGTReadingFromAPI(
          readingValue,
          timestamp,
          gid,
          groupConfig,
          wbgtReading.formattedTimestamp,
        );
        results.push({ groupId: gid, ...result });
      } catch (err) {
        console.error(`[WBGT API] Error processing for group ${gid}:`, err.message);
        results.push({ groupId: gid, success: false, error: err.message });
      }
    }

    const allSuccess = results.every((r) => r.success);
    const anySuccess = results.some((r) => r.success);

    return res.status(anySuccess ? 200 : 500).json({
      success: allSuccess,
      message: allSuccess
        ? `Successfully processed WBGT reading for ${results.length} group(s)`
        : `Processed with some failures (${results.filter((r) => r.success).length}/${results.length} succeeded)`,
      data: {
        readingValue,
        sgtHour,
        sensorReading: {
          value: readingValue,
          readingTimestamp: wbgtReading.formattedTimestamp,
          fetchedAt: wbgtReading.createdAt,
        },
        results,
      },
    });
  } catch (error) {
    console.error("[WBGT API] Error processing WBGT reading request:", error);
    return res.status(500).json({
      success: false,
      error: error.message,
      message: "Failed to process WBGT reading request",
    });
  }
}

module.exports = processWbgtReadingRequest;
