#!/usr/bin/env node
/**
 * Daily Safety Summary — local script
 *
 * Generates and optionally sends a daily safety summary to WhatsApp.
 * Same output format as the POST /daily-safety-summary API.
 *
 * Usage:
 *   node scripts/daily-safety-summary.js                    # yesterday, dry run
 *   node scripts/daily-safety-summary.js --date 31-Mar-2026 # specific date, dry run
 *   node scripts/daily-safety-summary.js --send             # yesterday, send to WhatsApp
 *   node scripts/daily-safety-summary.js --date 31-Mar-2026 --send
 *   node scripts/daily-safety-summary.js --date 31-Mar-2026 --send --group 120363...@g.us
 */

require("dotenv").config();

const { runSQLQuery } = require("../utils/action");
const { getGroupConfiguration, SAFETY_GROUP_IDS } = require("../config/group-config");
const { sendWhatsAppReply } = require("../utils/sendMessage");
const { getQuotedMessageId } = require("../utils/common");

const MONTHS_LC = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DEFAULT_SAFETY_GROUP_ID = "120363295524508218@g.us";

// ---------------------------------------------------------------------------
// Date helpers (Singapore timezone)
// ---------------------------------------------------------------------------

function getNowSGT() {
  const sgtString = new Date().toLocaleString("en-US", { timeZone: "Asia/Singapore" });
  return new Date(sgtString);
}

function formatDDMMMYYYY(dateObj) {
  const dd = String(dateObj.getDate()).padStart(2, "0");
  const mmm = MONTHS_LC[dateObj.getMonth()];
  const yyyy = dateObj.getFullYear();
  return `${dd}-${mmm}-${yyyy}`;
}

function getYesterdaySGT() {
  const y = getNowSGT();
  y.setDate(y.getDate() - 1);
  return formatDDMMMYYYY(y);
}

function getNowSGTTimeString() {
  const t = new Date().toLocaleTimeString("en-US", {
    timeZone: "Asia/Singapore",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return `${t}`;
}

function toIsoDate(ddMmmYyyy) {
  const [dd, mmm, yyyy] = ddMmmYyyy.split("-");
  const mi = MONTHS_LC.indexOf(mmm.toLowerCase());
  if (mi === -1) return ddMmmYyyy;
  return `${yyyy}-${String(mi + 1).padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

function toDisplayDate(ddMmmYyyy) {
  const [dd, mmm, yyyy] = ddMmmYyyy.split("-");
  return `${dd}-${mmm.charAt(0).toUpperCase()}${mmm.slice(1)}-${yyyy}`;
}

function shortDate(ddMmmYyyy) {
  const parts = ddMmmYyyy.split("-");
  if (parts.length === 3) return `${parts[0]}-${parts[1].charAt(0).toUpperCase()}${parts[1].slice(1)}`;
  return ddMmmYyyy;
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

async function getSafetyIssuesForDate(isoDate, groupConfig) {
  const rows = await runSQLQuery(
    `SELECT [S/N], [Category], [Severity], [Status] FROM safetyData WHERE [Date] = '${isoDate}'`,
    "safety",
    { groupConfig },
  );
  const issues = Array.isArray(rows) ? rows : [];

  const openIssues = issues.filter((r) => r.Status === "open");
  const closedIssues = issues.filter((r) => r.Status === "closed");

  const openPriorityCounts = { P1: 0, P2: 0, P3: 0 };
  openIssues.forEach((r) => {
    if (r.Severity === "P1") openPriorityCounts.P1++;
    else if (r.Severity === "P2") openPriorityCounts.P2++;
    else if (r.Severity === "P3") openPriorityCounts.P3++;
  });

  return {
    totalIssues: issues.length,
    openIssues: openIssues.length,
    closedIssues: closedIssues.length,
    openPriorityCounts,
  };
}

// ---------------------------------------------------------------------------
// Summary generation (same format as the API)
// ---------------------------------------------------------------------------

function generateSummaryMessage(searchDate, todayData, historicalData) {
  const displayDate = toDisplayDate(searchDate);
  const { openIssues, openPriorityCounts } = todayData;
  const p1 = openPriorityCounts.P1 || 0;
  const p2 = openPriorityCounts.P2 || 0;
  const p3 = openPriorityCounts.P3 || 0;

  let message = `MBS IR2 Project
Safety Issues Summary (as of ${displayDate}, ${getNowSGTTimeString()})

Total issues reported: ${todayData.totalIssues}
Open issues: ${openIssues} (${p1} P1, ${p2} P2, ${p3} P3)

Open issues by date:`;

  const todayShort = shortDate(searchDate);
  historicalData.forEach((dayData) => {
    if (dayData.openIssues > 0) {
      const dayShort = shortDate(dayData.date);
      if (dayShort !== todayShort) {
        const parts = [];
        if (dayData.openPriorityCounts.P1) parts.push(`${dayData.openPriorityCounts.P1} P1`);
        if (dayData.openPriorityCounts.P2) parts.push(`${dayData.openPriorityCounts.P2} P2`);
        if (dayData.openPriorityCounts.P3) parts.push(`${dayData.openPriorityCounts.P3} P3`);
        const severityText = parts.length > 0 ? ` (${parts.join(", ")})` : "";
        message += `\n${dayShort}: ${dayData.openIssues}${severityText}`;
      }
    }
  });

  return message;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const dateFlag = args.indexOf("--date");
  const shouldSend = args.includes("--send");
  const groupFlag = args.indexOf("--group");

  const searchDate = dateFlag !== -1 && args[dateFlag + 1] ? args[dateFlag + 1].toLowerCase() : getYesterdaySGT();
  const isoDate = toIsoDate(searchDate);
  const groupId =
    groupFlag !== -1 && args[groupFlag + 1] ? args[groupFlag + 1] : SAFETY_GROUP_IDS[0] || DEFAULT_SAFETY_GROUP_ID;
  const groupConfig = getGroupConfiguration(groupId);

  console.log(`\n📋 Daily Safety Summary`);
  console.log(`   Date: ${toDisplayDate(searchDate)} (${isoDate})`);
  console.log(`   Mode: ${shouldSend ? "SEND to WhatsApp" : "DRY RUN"}`);
  console.log(`   Group: ${groupId}\n`);

  // Fetch today's data
  const todayData = await getSafetyIssuesForDate(isoDate, groupConfig);

  // Fetch previous 4 days for historical context
  const historicalData = [];
  const baseDate = new Date(isoDate + "T00:00:00");
  for (let i = 1; i <= 4; i++) {
    const checkDate = new Date(baseDate);
    checkDate.setDate(checkDate.getDate() - i);
    const checkIso = checkDate.toISOString().split("T")[0];
    const checkFormatted = formatDDMMMYYYY(checkDate);

    const dayData = await getSafetyIssuesForDate(checkIso, groupConfig);
    if (dayData.openIssues > 0) {
      historicalData.push({ date: checkFormatted, ...dayData });
    }
  }

  // Generate message
  const summaryMessage = generateSummaryMessage(searchDate, todayData, historicalData);

  console.log("─".repeat(50));
  console.log(summaryMessage);
  console.log("─".repeat(50));

  if (!shouldSend) {
    console.log("\n✅ Dry run complete. Add --send to send to WhatsApp.");
    return;
  }

  // Send to WhatsApp
  console.log("\n📱 Sending to WhatsApp...");

  let quotedMessageId = await getQuotedMessageId("safety", groupId);
  if (quotedMessageId) {
    console.log(`   Replying to: ${quotedMessageId}`);
  }

  const response = await sendWhatsAppReply(groupId, summaryMessage, "6587842038", 15000, quotedMessageId);
  console.log("✅ Sent!", response);
}

main().catch((err) => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
