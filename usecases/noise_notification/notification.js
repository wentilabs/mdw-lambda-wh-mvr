// Note: dotenv is loaded in index.js handler, secrets come from AWS Secrets Manager
const { sendWhatsAppMessage } = require("../../utils/sendMessage");

/**
 * Send the consolidated hourly noise alert for multiple locations.
 *
 * This is the ONLY notification builder on the live path (cron triggers with
 * groupIds → action='notification' → here). Strictly Leq1hr-driven: a message
 * fires iff `currentLeq1hr > hourlyLimit` for at least one location; if none
 * exceed, nothing is sent.
 *
 * Message format:
 *   ⚠️ Noise limit exceeded, H:MM
 *   NM01: Leq1hr 64 (63) - Reduce, stay below 62.1
 *   NM02: Leq1hr 64.6 (63) - Stop, stay below 61.3
 * where "stay below" = max remaining Leq5min permitted to keep the hour under
 * the limit (item.maxRemainingLeq5min), and the action is Stop when the budget
 * is badly blown (limit − maxRemaining ≥ 2) else Reduce.
 *
 * @param {Array<{location:string,currentLeq1hr:number,hourlyLimit:number,maxRemainingLeq5min?:number}>} locationsMetrics
 * @param {string[]} groupIds
 * @param {number} hour
 * @param {number} minutes
 * @returns {object}
 */
async function sendMultiLocationNotification(locationsMetrics, groupIds = [], hour, minutes) {
  try {
    const fmt1 = (n) => {
      if (n === undefined || n === null || Number.isNaN(n)) return n;
      return Number.parseFloat(n).toFixed(1).replace(/\.0$/, "");
    };

    // Sort by location code so NM01 comes before NM02
    const sorted = [...locationsMetrics].sort((a, b) => a.location.localeCompare(b.location));

    // Leq1hr-only check: build one line per exceeding location. If none exceed → no message.
    // Line format: "NM01: Leq1hr 64 (63) - Reduce, stay below 62.1"
    //   current = current Leq1hr · (limit) = hourly limit · action = Stop/Reduce
    //   stay below = max remaining Leq5min permitted to keep the hour under limit
    //                (item.maxRemainingLeq5min, computed in calculator.js).
    const lines = [];
    for (const item of sorted) {
      if (item.currentLeq1hr > item.hourlyLimit) {
        const current = fmt1(item.currentLeq1hr);
        const limit = fmt1(item.hourlyLimit);

        // Action: Stop if the budget is badly blown, else Reduce. Same thresholds
        // as the summary builder (thresholdDiff = limit − maxRemaining; ≥2 → Stop).
        let action = "Reduce";
        if (typeof item.maxRemainingLeq5min === "number") {
          const thresholdDiff = item.hourlyLimit - item.maxRemainingLeq5min;
          if (thresholdDiff >= 2.0) action = "Stop";
        }

        // "stay below" only when a positive remaining-Leq5min budget exists.
        if (typeof item.maxRemainingLeq5min === "number" && item.maxRemainingLeq5min > 0) {
          const stayBelow = fmt1(item.maxRemainingLeq5min);
          lines.push(`${item.location}: Leq1hr ${current} (${limit}) - ${action}, stay below ${stayBelow}`);
        } else {
          lines.push(`${item.location}: Leq1hr ${current} (${limit}) - ${action}`);
        }
      }
    }

    if (lines.length === 0) {
      console.log("All locations within Leq1hr limit; not sending notification");
      return { sent: false, message: "All locations within Leq1hr limit" };
    }

    const timeDisplay = `${hour}:${minutes.toString().padStart(2, "0")}`;
    // Header: "⚠️ Noise limit exceeded, <time>" (replaces the old 🕒 clock prefix).
    const message = [`⚠️ Noise limit exceeded, ${timeDisplay}`, ...lines].join("\n");

    // Resolve recipients
    const recipients = Array.isArray(groupIds) && groupIds.length > 0 ? groupIds : [];
    if (recipients.length === 0) {
      console.warn("No groupIds provided for noise notification");
      return { sent: false, message: "No groupIds provided" };
    }

    // Support dry run for local testing
    if (process.env.DRY_RUN_NOTIFICATION === "true" || process.env.USE_LOCAL_ENV) {
      console.log("[DRY RUN] Would send multi-location notification:", { message, recipients });
      return { sent: false, dryRun: true, message, recipients };
    }

    // Send to all group IDs
    const results = [];
    for (const gid of recipients) {
      try {
        console.log(`Sending multi-location notification to: ${gid}`);
        await sendWhatsAppMessage(gid, message);
        results.push({ groupId: gid, sent: true });
      } catch (err) {
        console.error(`Error sending to ${gid}:`, err.message);
        results.push({ groupId: gid, sent: false, error: err.message });
      }
    }

    return {
      sent: results.some((r) => r.sent),
      message,
      results,
    };
  } catch (error) {
    console.error("Error sending multi-location noise notification:", error);
    return { sent: false, error: error.message };
  }
}

module.exports = {
  sendMultiLocationNotification,
};
