/**
 * Daily safety summary API endpoint
 *
 * Generates and sends a daily safety summary message to a WhatsApp group.
 * Same handler is reused for the morning ("as of yesterday") cron and the
 * evening ("current status today") cron — the data shape is identical, only
 * the target date differs.
 *
 * POST /daily-safety-summary
 * {
 *   "date":      "05-Jul-2025",          // Optional, explicit DD-MMM-YYYY date. Wins if set.
 *   "targetDay": "today" | "yesterday",  // Optional shorthand. Default = "yesterday".
 *                                        //   Cron rules:
 *                                        //     09:00 SGT next-day summary  → body {} (defaults yesterday)
 *                                        //     18:00 SGT same-day reminder → body {"targetDay":"today"}
 *   "groupIds":  ["123456789@g.us"],     // Optional — WhatsApp group(s) to send to
 *   "groupId":   "123456789@g.us",       // Fallback — single group ID
 *   "dryRun":    false                   // Optional — if true, returns message without sending
 * }
 */

// Note: dotenv is loaded in index.js handler, secrets come from AWS Secrets Manager
const axios = require("axios");
const { loadData } = require("../utils/action");
const { convertToSingaporeTime } = require("../utils/date");
const { checkDateMatch } = require("../utils/date-match");
const { sendWhatsAppReply, sendWhatsAppMessage } = require("../utils/sendMessage");
const { getQuotedMessageId } = require("../utils/common");

// Environment variables
const DEFAULT_SAFETY_GROUP_ID = "120363295524508218@g.us";
const SAFETY_SPREADSHEET_ID = process.env.SAFETY_SPREADSHEET_ID;
const SAFETY_SHEET_NAME = "Safety";

// Config for Safety sheet operations
const safetyGroupConfig = {
  spreadsheetId: SAFETY_SPREADSHEET_ID,
  safetySheetName: SAFETY_SHEET_NAME,
};

// Deterministic month constants and helper to ensure dd-mmm-yyyy (lowercase)
const MONTHS_LC = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_MAP = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

function formatDDMMMYYYY(dateObj) {
  const dd = String(dateObj.getDate()).padStart(2, "0");
  const mmm = MONTHS_LC[dateObj.getMonth()];
  const yyyy = dateObj.getFullYear();
  return `${dd}-${mmm}-${yyyy}`;
}

function normalizeSeverityPriority(value) {
  const s = String(value || "")
    .trim()
    .toLowerCase();
  // Map common forms into severity + priority
  // Priority
  if (s.startsWith("p1") || s === "1" || s.includes("priority 1") || s === "high" || s === "h") {
    return { severity: "High", priority: "P1" };
  }
  if (s.startsWith("p2") || s === "2" || s.includes("priority 2") || s === "medium" || s === "mid" || s === "m") {
    return { severity: "Medium", priority: "P2" };
  }
  if (s.startsWith("p3") || s === "3" || s.includes("priority 3") || s === "low" || s === "l") {
    return { severity: "Low", priority: "P3" };
  }
  // Fallbacks based on first letter
  if (s.startsWith("h")) return { severity: "High", priority: "P1" };
  if (s.startsWith("m")) return { severity: "Medium", priority: "P2" };
  if (s.startsWith("l")) return { severity: "Low", priority: "P3" };
  return { severity: "Unknown", priority: "Unknown" };
}

/**
 * Get the current date in Singapore timezone as a Date object
 * Lambda runs in UTC — this ensures correct date when called between 00:00-08:00 SGT
 * @returns {Date}
 */
function getNowSGT() {
  const nowUtc = new Date();
  // Singapore is UTC+8, convert by formatting in SGT then parsing back
  const sgtString = nowUtc.toLocaleString("en-US", { timeZone: "Asia/Singapore" });
  return new Date(sgtString);
}

/**
 * Get yesterday's date formatted as DD-MMM-YYYY (Singapore timezone)
 * @returns {string} Yesterday's date in DD-MMM-YYYY format
 */
function getYesterdayFormatted() {
  const yesterday = getNowSGT();
  yesterday.setDate(yesterday.getDate() - 1);
  return formatDDMMMYYYY(yesterday);
}

/**
 * Get today's date formatted as DD-MMM-YYYY (Singapore timezone)
 * @returns {string}
 */
function getTodayFormatted() {
  return formatDDMMMYYYY(getNowSGT());
}

/**
 * Format the current SGT time as "h:mm AM/PM SGT" (e.g. "1:00 PM SGT").
 * Used in the summary header so recipients see exactly when the report was
 * generated.
 */
function getNowSGTTimeString() {
  // Use Intl directly so we don't depend on getNowSGT()'s round-tripped Date
  // (which loses the tz tag). en-US gives us h:mm AM/PM cleanly.
  const t = new Date().toLocaleTimeString("en-US", {
    timeZone: "Asia/Singapore",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return `${t}`;
}

/**
 * Resolve the summary's target date from the request body.
 * Priority:
 *   1. explicit `date` (any supported format) → parsed
 *   2. `targetDay: "today"` → today SGT
 *   3. `targetDay: "yesterday"` (or anything else / unset) → yesterday SGT (default)
 *
 * @param {{date?: string, targetDay?: "today"|"yesterday"}} opts
 * @returns {string} DD-MMM-YYYY
 */
function resolveSearchDate({ date, targetDay } = {}) {
  if (date) return parseApiDateParam(date);
  if (String(targetDay || "").toLowerCase() === "today") return getTodayFormatted();
  return getYesterdayFormatted();
}

/**
 * Parse date parameter and handle various formats
 * @param {string} dateParam - Date parameter from request
 * @returns {string} Standardized date string in DD-MMM-YYYY format
 */
function parseApiDateParam(dateParam) {
  if (!dateParam) {
    // If no date specified, use YESTERDAY as the reference date.
    // Summary will say: "as of yesterday" and show issues created yesterday.
    return getYesterdayFormatted();
  }

  try {
    // Try to parse various date formats

    // Format: DD-MMM-YYYY (05-Jul-2025) or DD-Month-YYYY (05-July-2025)
    const fullMonthRegex = /^(\d{1,2})[-\s]([A-Za-z]+)[-\s](\d{4})$/;
    let match = dateParam.match(fullMonthRegex);

    if (match) {
      const [_, day, month, year] = match;
      const dayNum = parseInt(day, 10);
      const monthIndex = MONTH_MAP[String(month).toLowerCase()];
      const yearNum = parseInt(year, 10);
      if (Number.isInteger(dayNum) && Number.isInteger(monthIndex) && Number.isInteger(yearNum)) {
        const dateObj = new Date(yearNum, monthIndex, dayNum);
        if (!isNaN(dateObj.getTime())) {
          return formatDDMMMYYYY(dateObj);
        }
      }
    }

    // Format: DD/MM/YYYY or MM/DD/YYYY
    const numericDateRegex = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/;
    match = dateParam.match(numericDateRegex);

    if (match) {
      const [_, firstNum, secondNum, year] = match;
      let day = parseInt(firstNum);
      let month = parseInt(secondNum);

      // If first number is > 12, it's likely a day (DD/MM/YYYY format)
      // Otherwise, try to parse as MM/DD/YYYY
      if (day > 12) {
        // Format is DD/MM/YYYY
      } else if (month > 12) {
        // Format is MM/DD/YYYY
        [day, month] = [month, day];
      } else {
        // Ambiguous - default to DD/MM/YYYY (international format)
      }

      // Fix year if it's 2 digits
      const fullYear = year.length === 2 ? `20${year}` : year;
      const parsed = new Date(parseInt(fullYear, 10), month - 1, day);
      return formatDDMMMYYYY(parsed);
    }

    throw new Error(`Invalid date format: ${dateParam}`);
  } catch (error) {
    console.error(`Error parsing date: ${error.message}`);
    console.log("Using yesterday's date instead.");
    return getYesterdayFormatted();
  }
}

/**
 * Get safety issues for a given date
 * @param {string} searchDate - Date to search for in DD-MMM-YYYY format
 * @returns {Object} Object with safety issue statistics
 */
async function getSafetyIssuesForDate(searchDate) {
  try {
    // Load data from Safety sheet
    const sheetData = await loadData(SAFETY_SHEET_NAME, safetyGroupConfig);

    if (!sheetData || sheetData.length <= 1) {
      console.log("❌ No data found in Safety sheet or sheet is empty");
      return {
        totalIssues: 0,
        openIssues: 0,
        closedIssues: 0,
        categoryCounts: {},
        severityCounts: {},
      };
    }

    // Find the actual header row (may not be row 0 if data was inserted above it)
    let headerRowIndex = 0;
    for (let i = 0; i < Math.min(sheetData.length, 10); i++) {
      const row = sheetData[i];
      if (
        Array.isArray(row) &&
        row.some((cell) => String(cell).trim() === "Date") &&
        row.some((cell) => String(cell).trim() === "Status")
      ) {
        headerRowIndex = i;
        break;
      }
    }

    const headers = sheetData[headerRowIndex];
    console.log("Sheet headers (row " + headerRowIndex + "):", headers);
    const dateIndex = headers.findIndex((h) => String(h).trim() === "Date");
    const statusIndex = headers.findIndex((h) => String(h).trim() === "Status");
    const categoryIndex = headers.findIndex((h) => String(h).trim() === "Category");
    const severityIndex = headers.findIndex((h) => String(h).trim() === "Severity");
    const timestampIndex = headers.findIndex((h) => String(h).trim() === "Created Timestamp");

    console.log(
      "Column indices - Date:",
      dateIndex,
      "Status:",
      statusIndex,
      "Category:",
      categoryIndex,
      "Severity:",
      severityIndex,
    );
    console.log(
      "First few rows Date values:",
      sheetData.slice(1, 5).map((row) => row[dateIndex]),
    );

    if (dateIndex === -1 || statusIndex === -1 || categoryIndex === -1 || severityIndex === -1) {
      console.log("❌ Required columns not found in Safety sheet");
      return {
        totalIssues: 0,
        openIssues: 0,
        closedIssues: 0,
        categoryCounts: {},
        severityCounts: {},
      };
    }

    // Find matching rows and calculate statistics
    const matchingIssues = [];
    const categoryCounts = {};
    // Severity-based counts (High/Medium/Low)
    const severityCounts = {};
    const openSeverityCounts = {};
    // Priority-based counts (P1/P2/P3)
    const priorityCounts = {};
    const openPriorityCounts = {};
    let openIssues = 0;
    let closedIssues = 0;

    for (let i = headerRowIndex + 1; i < sheetData.length; i++) {
      const row = sheetData[i];

      // Skip empty rows
      if (!row || (!row[dateIndex] && !(timestampIndex !== -1 && row[timestampIndex]))) {
        continue;
      }

      // Check if this date matches
      // Prefer Timestamp (SGT) for created-day matching if available; fallback to Date column
      let isMatch = false;

      // 1) Try matching by Timestamp (SGT) if present
      if (timestampIndex !== -1 && row[timestampIndex]) {
        const tsVal = String(row[timestampIndex]);
        // Extract dd-MMM-yyyy from timestamp, e.g., "02-Sep-2025 14:03" or "02-Sep-2025"
        const m = tsVal.match(/(\d{1,2})-([A-Za-z]{3,})-(\d{2,4})/);
        if (m) {
          const tsDay = parseInt(m[1], 10);
          const tsMonthIdx = MONTH_MAP[String(m[2]).toLowerCase()];
          let tsYear = m[3];
          if (tsYear.length === 2) tsYear = `20${tsYear}`;

          const searchParts = searchDate.split("-");
          if (searchParts.length === 3) {
            const sDay = parseInt(searchParts[0], 10);
            const sMonthIdx = MONTH_MAP[String(searchParts[1]).toLowerCase()];
            const sYear = searchParts[2];
            if (Number.isInteger(tsMonthIdx) && Number.isInteger(sMonthIdx)) {
              isMatch = tsDay === sDay && tsMonthIdx === sMonthIdx && String(tsYear) === sYear;
            }
          }
        }
      }

      // Specific check for 29-Jul-2025 since there might be date entries that need special handling
      if (
        !isMatch &&
        searchDate === "29-Jul-2025" &&
        row[dateIndex] &&
        row[dateIndex].toString().includes("29-Jul-2025")
      ) {
        console.log(`Found direct match for 29-Jul-2025: ${row[dateIndex]}`);
        isMatch = true;
      }

      // If no direct match, continue with normal processing
      if (!isMatch) {
        // Cleanup date string if it has trailing quote or other characters
        let dateValue = row[dateIndex];
        if (typeof dateValue === "string") {
          dateValue = dateValue.replace(/['"]$/g, "").trim();
        }

        // Handle YYYY-MM-DD format
        if (typeof dateValue === "string" && dateValue.match(/^\d{4}-\d{2}-\d{2}/)) {
          // Convert YYYY-MM-DD format to match our search date format (DD-MMM-YYYY)
          const dateParts = dateValue.split("-");
          if (dateParts.length === 3) {
            const year = dateParts[0];
            const month = parseInt(dateParts[1]);
            const day = parseInt(dateParts[2]);

            // Extract search date components
            const searchDateParts = searchDate.split("-");
            if (searchDateParts.length === 3) {
              const searchDay = parseInt(searchDateParts[0]);
              const searchMonthStr = searchDateParts[1].toLowerCase();
              const searchYear = searchDateParts[2];

              // Convert month name to month number for comparison (supports sep/sept)
              const searchMonthIndex = MONTH_MAP[searchMonthStr];
              const searchMonthNum = Number.isInteger(searchMonthIndex) ? searchMonthIndex + 1 : -1;

              isMatch = day === searchDay && month === searchMonthNum && year === searchYear;
              console.log(
                `Comparing YYYY-MM-DD: [${dateValue}] (${day}-${month}-${year}) to [${searchDate}] (${searchDay}-${searchMonthStr}-${searchYear}) - Match: ${isMatch}`,
              );
            }
          }
        } else {
          // Use the standard matching function for other date formats
          isMatch = checkDateMatch(dateValue, searchDate);
          console.log(`Standard comparison: [${dateValue}] against [${searchDate}] - Match: ${isMatch}`);
        }
      }

      if (isMatch) {
        matchingIssues.push(row);

        // Count by status
        const status = String(row[statusIndex] || "")
          .trim()
          .toLowerCase();
        if (status === "open") {
          openIssues++;
        } else if (status === "closed") {
          closedIssues++;
        }

        // Count by category (all issues on the day)
        const category = row[categoryIndex] || "Unknown";
        categoryCounts[category] = (categoryCounts[category] || 0) + 1;

        // Count by severity and priority (all issues on the day)
        const { severity, priority } = normalizeSeverityPriority(row[severityIndex]);
        severityCounts[severity] = (severityCounts[severity] || 0) + 1;
        priorityCounts[priority] = (priorityCounts[priority] || 0) + 1;

        // Count by severity limited to OPEN issues only (for open breakdown)
        if (status === "open") {
          openSeverityCounts[severity] = (openSeverityCounts[severity] || 0) + 1;
          openPriorityCounts[priority] = (openPriorityCounts[priority] || 0) + 1;
        }
      }
    }

    return {
      totalIssues: matchingIssues.length,
      openIssues,
      closedIssues,
      categoryCounts,
      severityCounts,
      openSeverityCounts,
      priorityCounts,
      openPriorityCounts,
      matchingIssues,
    };
  } catch (error) {
    console.error("❌ Error finding safety issues:", error);
    return {
      totalIssues: 0,
      openIssues: 0,
      closedIssues: 0,
      categoryCounts: {},
      severityCounts: {},
    };
  }
}

/**
 * Count currently open issues (status=open), regardless of created date
 * Also returns priority (P1/P2/P3) breakdown for open issues
 * @returns {Object} { openIssues, openPriorityCounts }
 */
async function getOpenOutstandingIssues() {
  try {
    const sheetData = await loadData(SAFETY_SHEET_NAME, safetyGroupConfig);
    if (!sheetData || sheetData.length <= 1) {
      return { openIssues: 0, openPriorityCounts: {} };
    }

    // Find header row dynamically
    let headerRowIndex = 0;
    for (let i = 0; i < Math.min(sheetData.length, 10); i++) {
      const row = sheetData[i];
      if (Array.isArray(row) && row.some((cell) => String(cell).trim() === "Status")) {
        headerRowIndex = i;
        break;
      }
    }

    const headers = sheetData[headerRowIndex];
    const statusIndex = headers.findIndex((h) => String(h).trim() === "Status");
    const severityIndex = headers.findIndex((h) => String(h).trim() === "Severity");

    if (statusIndex === -1) return { openIssues: 0, openPriorityCounts: {} };

    let openIssues = 0;
    const openPriorityCounts = {};

    for (let i = headerRowIndex + 1; i < sheetData.length; i++) {
      const row = sheetData[i];
      if (!row) continue;
      const status = String(row[statusIndex] || "")
        .trim()
        .toLowerCase();
      if (status === "open") {
        openIssues++;
        const { priority } = normalizeSeverityPriority(row[severityIndex]);
        openPriorityCounts[priority] = (openPriorityCounts[priority] || 0) + 1;
      }
    }

    return { openIssues, openPriorityCounts };
  } catch (e) {
    console.error("❌ Error counting open outstanding issues:", e);
    return { openIssues: 0, openPriorityCounts: {} };
  }
}

/**
 * Get yesterday's date relative to a given search date
 * @param {string} searchDate - Date in DD-MMM-YYYY format
 * @returns {string} Yesterday's date in DD-MMM-YYYY format
 */
function getYesterdayFromDate(searchDate) {
  const [day, month, year] = searchDate.split("-");
  const monthIndex = MONTH_MAP[String(month).toLowerCase()];
  const date = new Date(parseInt(year, 10), monthIndex, parseInt(day, 10));
  date.setDate(date.getDate() - 1);
  return formatDDMMMYYYY(date);
}

/**
 * Get open issues for a date range to show historical breakdown
 * @param {string} searchDate - The main search date
 * @returns {Array} Array of objects with date, openIssues, and severityCounts
 */
async function getOpenIssuesByDateRange(searchDate) {
  const results = [];

  const [day, month, year] = searchDate.split("-");
  const monthIndex = MONTH_MAP[String(month).toLowerCase()];
  const baseDate = new Date(parseInt(year, 10), monthIndex, parseInt(day, 10));

  for (let i = 1; i <= 4; i++) {
    const checkDate = new Date(baseDate);
    checkDate.setDate(checkDate.getDate() - i);

    const dateStr = formatDDMMMYYYY(checkDate);

    const dayData = await getSafetyIssuesForDate(dateStr);

    if (dayData.openIssues > 0) {
      results.push({
        date: dateStr,
        openIssues: dayData.openIssues,
        // Use open-only counts for the historical open breakdown
        severityCounts: dayData.openSeverityCounts,
        priorityCounts: dayData.openPriorityCounts,
      });
    }
  }

  return results;
}

/**
 * Generate a formatted safety summary message
 * @param {Object} safetyData - Processed safety data for the search date
 * @param {Object} yesterdayData - Safety data for yesterday
 * @param {Array} historicalData - Open issues by date for the last few days
 * @param {string} searchDate - The date of the summary
 * @returns {string} Formatted message text
 */
function generateSafetySummaryMessage(createdYesterdayData, yesterdayOpenData, historicalData, searchDate) {
  const { openIssues = 0, priorityCounts = {} } = yesterdayOpenData;

  // Use P1/P2/P3 for the bracket breakdown
  const p1Count = priorityCounts["P1"] || 0;
  const p2Count = priorityCounts["P2"] || 0;
  const p3Count = priorityCounts["P3"] || 0;

  // Helper to shorten date (e.g., 26-Aug-2025 → 26-Aug)
  const shortDate = (d) => {
    const parts = String(d).split("-");
    return parts.length === 3 ? `${parts[0]}-${parts[1]}` : d;
  };

  let message = `MBS IR2 Project
Safety Issues Summary (as of ${searchDate}, ${getNowSGTTimeString()})

Total issues reported: ${createdYesterdayData.totalIssues}
Open issues: ${openIssues} (${p1Count} P1, ${p2Count} P2, ${p3Count} P3)

Open issues by date:`;

  historicalData.forEach((dayData) => {
    if (dayData.openIssues > 0) {
      // Skip showing today's date in historical section since it's already shown above
      const todayShort = shortDate(searchDate);
      const dayShort = shortDate(dayData.date);

      if (dayShort !== todayShort) {
        const severityBreakdown = [];
        if (dayData.priorityCounts?.["P1"]) severityBreakdown.push(`${dayData.priorityCounts["P1"]} P1`);
        if (dayData.priorityCounts?.["P2"]) severityBreakdown.push(`${dayData.priorityCounts["P2"]} P2`);
        if (dayData.priorityCounts?.["P3"]) severityBreakdown.push(`${dayData.priorityCounts["P3"]} P3`);

        const severityText = severityBreakdown.length > 0 ? ` (${severityBreakdown.join(", ")})` : "";
        message += `\n${dayShort}: ${dayData.openIssues}${severityText}`;
      }
    }
  });

  return message;
}

/**
 * Process daily safety summary request
 * @param {object} req - The request object
 * @param {object} res - The response object
 */
async function processDailySafetySummaryRequest(req, res) {
  try {
    // Extract parameters from request body. Tolerate missing/empty body so
    // EventBridge rules can fire with no payload (defaults to yesterday).
    let body = {};
    try {
      if (req.body) body = JSON.parse(req.body);
    } catch (e) {
      console.warn("Failed to parse request body, treating as empty:", e.message);
    }
    const { date, targetDay, groupIds, groupId, dryRun = false } = body;
    console.log("Extracted request params:", { date, targetDay, groupIds, groupId, dryRun });

    // Resolve recipient list: groupIds (array) > groupId (string) > default
    const recipientIds =
      groupIds && Array.isArray(groupIds) && groupIds.length > 0 ? groupIds : groupId ? [groupId] : [];
    console.log("Using recipient IDs:", recipientIds);

    // Resolve target date — explicit `date` wins; otherwise `targetDay` picks today/yesterday.
    const searchDate = resolveSearchDate({ date, targetDay });
    console.log(`🔍 Finding safety issues for date: ${searchDate} (targetDay=${targetDay || "(default yesterday)"})`);

    // Parse search date into components for easier comparison
    const searchDateParts = searchDate.split("-");
    if (searchDateParts.length === 3) {
      const [day, month, year] = searchDateParts;
      console.log(`Search date components: day=${day}, month=${month}, year=${year}`);
    }

    // Get issues for the provided date (typically yesterday)
    const createdYesterdayData = await getSafetyIssuesForDate(searchDate);

    // Open issues for that same date
    const yesterdayOpenIssues = {
      openIssues: createdYesterdayData.openIssues || 0,
      priorityCounts: createdYesterdayData.openPriorityCounts || {},
    };

    // Historical open issues for preceding days relative to the search date
    const historicalData = await getOpenIssuesByDateRange(searchDate);

    // Generate summary message
    const summaryMessage = generateSafetySummaryMessage(
      createdYesterdayData,
      yesterdayOpenIssues,
      historicalData,
      searchDate,
    );

    // Send the message to WhatsApp (unless in dry run mode)
    const sendResults = [];

    if (dryRun) {
      console.log("🔒 Dry run mode: Skipping WhatsApp message send");
      sendResults.push({
        groupId: recipientIds[0],
        sent: true,
        data: { message: "Dry run - message not actually sent" },
      });
    } else {
      for (const gid of recipientIds) {
        try {
          console.log(`📱 Sending message to group: ${gid}`);

          const response = await sendWhatsAppMessage(gid, summaryMessage, "6587842038", 15000);
          sendResults.push({ groupId: gid, sent: true, data: response });
          console.log(`✅ Sent to ${gid}`);
        } catch (sendErr) {
          console.error(`❌ Failed to send to ${gid}:`, sendErr.message);
          sendResults.push({ groupId: gid, sent: false, error: sendErr.message });
        }
      }
    }

    return res.status(200).json({
      success: true,
      date: searchDate,
      targetDay: String(targetDay || "yesterday").toLowerCase(),
      issuesCount: createdYesterdayData.totalIssues,
      message: "Daily safety summary message sent successfully",
      messagePreview: summaryMessage.substring(0, 100) + "...",
      // Full text — used by the QA agent bypass to relay the exact same
      // summary back to the user as the EventBridge cron sends. Cheap to
      // include and helps callers that need the literal text (dryRun + test).
      messageFull: summaryMessage,
      sendResults,
    });
  } catch (error) {
    console.error("Error processing daily safety summary request:", error);
    return res.status(500).json({
      success: false,
      error: error.message,
      message: "Failed to process daily safety summary request",
    });
  }
}

module.exports = processDailySafetySummaryRequest;
