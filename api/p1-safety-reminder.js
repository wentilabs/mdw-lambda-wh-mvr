/**
 * P1 Safety Reminder API endpoint
 *
 * This API endpoint sends a reminder message about P1 safety issues
 * that have been open for more than 3 hours.
 *
 * POST /p1-safety-reminder
 * {
 *   "chatId": "123456789@g.us",  // Required, WhatsApp chat ID to send the message to
 *   "quoteMessageId": "3A1234567890ABCDEF"  // Optional, message ID to quote/reply to
 * }
 */

// Note: dotenv is loaded in index.js handler, secrets come from AWS Secrets Manager
const { loadData } = require("../utils/action");
const { sendWhatsAppReply } = require("../utils/sendMessage");

// Environment variables
const SAFETY_SPREADSHEET_ID = process.env.SAFETY_SPREADSHEET_ID;
const SAFETY_SHEET_NAME = "Safety";

// Month names for parsing timestamps
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

/**
 * Parse timestamp from Safety sheet "Created Timestamp" column
 * Format: "DD-MMM-YYYY HH:MM" (e.g., "02-Jan-2025 14:03")
 * @param {string} timestampStr - Timestamp string from sheet
 * @returns {Date|null} - Parsed Date object or null if invalid
 */
function parseCreatedTimestamp(timestampStr) {
  try {
    if (!timestampStr || typeof timestampStr !== "string") {
      return null;
    }

    // Format: "DD-MMM-YYYY HH:MM"
    // Example: "02-Jan-2025 14:03"
    const parts = timestampStr.trim().split(" ");
    if (parts.length !== 2) {
      return null;
    }

    const [datePart, timePart] = parts;
    const [day, monthStr, year] = datePart.split("-");
    const [hour, minute] = timePart.split(":");

    const monthKey = monthStr.toLowerCase();
    const monthIndex = MONTH_MAP[monthKey];

    if (monthIndex === undefined) {
      console.error(`Invalid month in timestamp: ${monthStr}`);
      return null;
    }

    // Create date in Singapore timezone (UTC+8)
    // Note: Date constructor uses local timezone, but we'll treat this as Singapore time
    const date = new Date(parseInt(year), monthIndex, parseInt(day), parseInt(hour), parseInt(minute), 0, 0);

    if (isNaN(date.getTime())) {
      return null;
    }

    return date;
  } catch (error) {
    console.error("Error parsing timestamp:", timestampStr, error);
    return null;
  }
}

/**
 * Format hours open as a human-readable string
 * @param {number} hours - Hours open
 * @returns {string} - Formatted string like "4.5 hours" or "6.2 hours"
 */
function formatHoursOpen(hours) {
  return `${hours.toFixed(1)} hours`;
}

/**
 * Format time in 12-hour format with AM/PM
 * @param {Date} date - Date object
 * @returns {string} - Formatted time like "2:15 PM"
 */
function formatTime12Hour(date) {
  let hours = date.getHours();
  const minutes = date.getMinutes();
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12;
  hours = hours ? hours : 12; // 0 should be 12
  const minutesStr = minutes < 10 ? "0" + minutes : minutes;
  return `${hours}:${minutesStr} ${ampm}`;
}

/**
 * Check if two dates are the same day
 * @param {Date} date1 - First date
 * @param {Date} date2 - Second date
 * @returns {boolean} - true if same day
 */
function isSameDay(date1, date2) {
  return (
    date1.getFullYear() === date2.getFullYear() &&
    date1.getMonth() === date2.getMonth() &&
    date1.getDate() === date2.getDate()
  );
}

/**
 * Get P1 safety issues that are open for more than 3 hours today
 * @returns {Promise<Array>} - Array of P1 issues with details
 */
async function getOpenP1IssuesOverThreeHours() {
  try {
    console.log("[P1 REMINDER] Loading Safety sheet data...");

    // Load Safety sheet
    const groupConfig = {
      spreadsheetId: SAFETY_SPREADSHEET_ID,
      safetySheetName: SAFETY_SHEET_NAME,
    };

    const sheetData = await loadData(SAFETY_SHEET_NAME, groupConfig);

    if (!sheetData || sheetData.length < 2) {
      console.log("[P1 REMINDER] No data found in Safety sheet");
      return [];
    }

    // Extract headers (first row)
    const headers = sheetData[0];
    const statusIndex = headers.indexOf("Status");
    const severityIndex = headers.indexOf("Severity");
    const snIndex = headers.indexOf("S/N");
    const descriptionIndex = headers.indexOf("Description");
    const locationIndex = headers.indexOf("Location");
    const dateIndex = headers.indexOf("Date");
    const createdTimestampIndex = headers.indexOf("Created Timestamp");

    if (statusIndex === -1 || severityIndex === -1 || createdTimestampIndex === -1) {
      console.error("[P1 REMINDER] Required columns not found in Safety sheet");
      return [];
    }

    console.log("[P1 REMINDER] Column indices:", {
      status: statusIndex,
      severity: severityIndex,
      sn: snIndex,
      description: descriptionIndex,
      location: locationIndex,
      date: dateIndex,
      createdTimestamp: createdTimestampIndex,
    });

    // Current time
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // Filter for P1 issues open > 3 hours today
    const p1Issues = [];

    for (let i = 1; i < sheetData.length; i++) {
      const row = sheetData[i];
      const status = String(row[statusIndex] || "")
        .toLowerCase()
        .trim();
      const severity = String(row[severityIndex] || "")
        .toLowerCase()
        .trim();
      const createdTimestampStr = row[createdTimestampIndex];

      // Check if open and P1
      const isOpen = status === "open";
      const isP1 =
        severity === "p1" ||
        severity === "1" ||
        severity === "high" ||
        severity === "h" ||
        severity.includes("priority 1") ||
        severity.startsWith("p1");

      if (!isOpen || !isP1) {
        continue;
      }

      // Parse created timestamp
      const createdDate = parseCreatedTimestamp(createdTimestampStr);
      if (!createdDate) {
        console.warn("[P1 REMINDER] Could not parse timestamp:", createdTimestampStr);
        continue;
      }

      // Check if created today
      if (!isSameDay(createdDate, today)) {
        continue;
      }

      // Calculate hours open
      const hoursOpen = (now.getTime() - createdDate.getTime()) / (1000 * 60 * 60);

      // Filter for > 3 hours
      if (hoursOpen <= 3) {
        continue;
      }

      // Add to results
      p1Issues.push({
        sn: row[snIndex] || "",
        description: row[descriptionIndex] || "",
        location: row[locationIndex] || "",
        date: row[dateIndex] || "",
        createdTimestamp: createdTimestampStr,
        createdDate: createdDate,
        hoursOpen: hoursOpen,
        rowIndex: i,
      });
    }

    // Sort by hours open (oldest first)
    p1Issues.sort((a, b) => b.hoursOpen - a.hoursOpen);

    console.log(`[P1 REMINDER] Found ${p1Issues.length} P1 issues open > 3 hours today`);

    return p1Issues;
  } catch (error) {
    console.error("[P1 REMINDER] Error getting P1 issues:", error);
    throw error;
  }
}

/**
 * Build reminder message from P1 issues
 * @param {Array} p1Issues - Array of P1 issues
 * @returns {string} - Formatted reminder message
 */
function buildReminderMessage(p1Issues) {
  if (p1Issues.length === 0) {
    return "✅ *No P1 safety issues requiring immediate attention*\n\nAll P1 items have been closed or were reported less than 3 hours ago.";
  }

  let message = "⚠️ *P1 Safety Issues Still Open After 3 Hours*\n\n";
  message += "Please close/resolve/rectify the following items:\n\n";

  p1Issues.forEach((issue, index) => {
    const num = index + 1;
    const sn = issue.sn ? `S/N ${issue.sn}` : "N/A";
    const description = issue.description || "No description";
    const location = issue.location || "No location";
    const reportedTime = formatTime12Hour(issue.createdDate);
    const hoursAgo = formatHoursOpen(issue.hoursOpen);

    message += `${num}. [${sn}] ${description}\n`;
    message += `   📍 Location: ${location}\n`;
    message += `   🕐 Reported at: ${reportedTime} (${hoursAgo} ago)\n\n`;
  });

  message += `\n📊 Total: *${p1Issues.length}* open P1 item${
    p1Issues.length > 1 ? "s" : ""
  } requiring immediate attention.`;

  return message;
}

/**
 * Main handler for P1 safety reminder API
 * @param {object} event - Lambda event object
 * @returns {object} - API response
 */
async function processP1SafetyReminderRequest(event) {
  try {
    console.log("[P1 REMINDER] Processing P1 safety reminder request");

    // Parse request body
    let body;
    try {
      body = typeof event.body === "string" ? JSON.parse(event.body) : event.body;
    } catch (error) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          success: false,
          error: "Invalid JSON in request body",
        }),
      };
    }

    // Validate required parameters
    const { chatId, quoteMessageId } = body;

    if (!chatId) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          success: false,
          error: "chatId is required",
        }),
      };
    }

    console.log("[P1 REMINDER] Request parameters:", { chatId, quoteMessageId });

    // Get P1 issues
    const p1Issues = await getOpenP1IssuesOverThreeHours();

    // Build reminder message
    const reminderMessage = buildReminderMessage(p1Issues);

    console.log("[P1 REMINDER] Sending reminder message to:", chatId);
    console.log("[P1 REMINDER] Message:", reminderMessage);

    // Send message
    const sendResult = await sendWhatsAppReply(chatId, reminderMessage, "6587842038", 30000, quoteMessageId || null);

    console.log("[P1 REMINDER] Message sent successfully:", sendResult);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        success: true,
        message: "P1 reminder sent successfully",
        issuesCount: p1Issues.length,
        sentTo: chatId,
      }),
    };
  } catch (error) {
    console.error("[P1 REMINDER] Error processing request:", error);

    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        success: false,
        error: error.message || "Internal server error",
      }),
    };
  }
}

module.exports = {
  processP1SafetyReminderRequest,
  getOpenP1IssuesOverThreeHours, // Export for testing
  buildReminderMessage, // Export for testing
};
