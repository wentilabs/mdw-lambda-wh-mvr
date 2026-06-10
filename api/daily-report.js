/**
 * Daily Report PDF API endpoint
 *
 * Calls supabase_node to generate a daily site report PDF from
 * Manpower + Machines spreadsheet data, then sends it to WhatsApp groups.
 *
 * POST /daily-report
 * {
 *   "date": "20-Apr-2026",                // Optional, DD-MMM-YYYY. Defaults to YESTERDAY SGT
 *                                          // (this lambda runs from EventBridge ~10am SGT
 *                                          // and reports on the just-ended previous day).
 *   "groupIds": ["120363xxx@g.us"],        // Optional — WhatsApp group(s) to send to
 *   "dryRun": false                        // Optional — if true, returns URL without sending
 * }
 */

const axios = require("axios");
const { getGroupConfiguration } = require("../config/group-config");

const SCRAPE_API_URL = process.env.SCRAPE_API_URL || "https://api.scrape.wentilabs.com";
const SEND_DOCUMENT_URL = `${process.env.BASE_LISTENER_URL}/send-document`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ─── Date helpers ───

/**
 * Format a Date as DD-MMM-YYYY in Singapore time (UTC+8).
 */
function formatSGT(date) {
  const sg = { timeZone: "Asia/Singapore" };
  const day = date.toLocaleDateString("en-GB", { ...sg, day: "2-digit" });
  const month = date.toLocaleDateString("en-GB", { ...sg, month: "short" });
  const year = date.toLocaleDateString("en-GB", { ...sg, year: "numeric" });
  return `${day}-${month}-${year}`;
}

/**
 * Returns yesterday's date in Singapore time as DD-MMM-YYYY.
 *
 * Yesterday is the default for the daily report because the customer triggers
 * this lambda from an EventBridge cron the next morning (~10am SGT) — by then
 * the previous day is fully ended and intercorp attendance includes the night
 * shift workers who clocked out post-midnight. EventBridge can't pass dynamic
 * parameters so the default has to be computed inside the lambda.
 */
function getYesterdaySGT() {
  const sgNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Singapore" }));
  sgNow.setDate(sgNow.getDate() - 1);
  return formatSGT(sgNow);
}

function parseDate(dateParam) {
  if (!dateParam) return getYesterdaySGT();
  const match = dateParam.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!match) throw new Error(`Invalid date format: "${dateParam}". Expected DD-MMM-YYYY`);
  const [, day, monthStr, year] = match;
  const monthCap = monthStr.charAt(0).toUpperCase() + monthStr.slice(1).toLowerCase();
  return `${day.padStart(2, "0")}-${monthCap}-${year}`;
}

/**
 * Convert DD-MMM-YYYY to DD/MM/YY (format expected by supabase_node daily-report API)
 */
function toShortDate(ddMmmYyyy) {
  const match = ddMmmYyyy.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!match) return ddMmmYyyy;
  const [, day, monthStr, year] = match;
  const monthIndex = MONTHS.indexOf(monthStr);
  if (monthIndex === -1) return ddMmmYyyy;
  return `${day.padStart(2, "0")}/${String(monthIndex + 1).padStart(2, "0")}/${year.slice(2)}`;
}

// ─── Send document to WhatsApp ───

async function sendPdfToWhatsApp(chatId, pdfUrl, caption) {
  try {
    const payload = {
      chatId,
      fileUrl: pdfUrl,
      mimeType: "application/pdf",
      fileName: "Daily-Report.pdf",
      caption,
      clientId: process.env.WHATSAPP_CLIENT_ID || "6587842038",
      sendAsDocument: true,
    };
    await axios.post(SEND_DOCUMENT_URL, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: 60000,
    });
    console.log(`[Daily Report] PDF sent to ${chatId}`);
    return true;
  } catch (error) {
    console.error(`[Daily Report] Failed to send to ${chatId}:`, error.message);
    return false;
  }
}

// ─── Main handler ───

async function processDailyReportRequest(event, res) {
  try {
    let body = {};
    try {
      if (event.body) body = JSON.parse(event.body);
    } catch {}

    const { date: dateParam, groupIds, groupId, dryRun = false } = body;
    console.log("[Daily Report] Request:", { date: dateParam, groupIds, groupId, dryRun });

    const recipientIds =
      groupIds && Array.isArray(groupIds) && groupIds.length > 0 ? groupIds : groupId ? [groupId] : [];

    const searchDate = parseDate(dateParam);
    const shortDate = toShortDate(searchDate);
    console.log(`[Daily Report] Date: ${searchDate} → ${shortDate}`);

    // Get spreadsheet ID from group config
    const gc = getGroupConfiguration(null);
    const spreadsheetId = gc.manpowerSpreadsheetId;

    // Call supabase_node to generate PDF
    console.log("[Daily Report] Calling supabase_node...");
    const pdfFileName = `MBS-IR2-Daily-${searchDate}`;

    const pdfResponse = await axios.post(
      `${SCRAPE_API_URL}/daily-report/generate`,
      {
        date: shortDate,
        spreadsheetId,
        fileName: pdfFileName,
      },
      { timeout: 300000 },
    );

    if (!pdfResponse.data?.success || !pdfResponse.data?.signedUrl) {
      throw new Error(`PDF generation failed: ${pdfResponse.data?.error || "Unknown error"}`);
    }

    const pdfUrl = pdfResponse.data.signedUrl;
    console.log(`[Daily Report] PDF generated: ${pdfUrl.substring(0, 80)}...`);

    if (dryRun) {
      return res.status(200).json({
        success: true,
        dryRun: true,
        date: searchDate,
        pdfUrl,
        fileSize: pdfResponse.data.fileSize,
      });
    }

    // Send to WhatsApp groups
    const sendResults = [];
    const caption = `Daily Site Report (${searchDate})`;

    for (const gid of recipientIds) {
      const sent = await sendPdfToWhatsApp(gid, pdfUrl, caption);
      sendResults.push({ groupId: gid, sent });
    }

    return res.status(200).json({
      success: true,
      date: searchDate,
      pdfUrl,
      fileSize: pdfResponse.data.fileSize,
      sendResults,
    });
  } catch (error) {
    console.error("[Daily Report] Error:", error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
}

module.exports = processDailyReportRequest;
