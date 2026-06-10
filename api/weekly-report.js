/**
 * Weekly Report API endpoint — thin forwarder.
 *
 * Mirrors api/daily-report.js: the lambda parses the body, forwards to
 * supabase_node `/weekly-report/generate`, and on success delivers the
 * resulting PDF URL to the configured WhatsApp groups. NO data processing
 * happens here — that all lives in supabase_node now (manpower /
 * machinery / soil-disposal extractors, role classifier, fuzzy dedup,
 * chart prep, PDF render).
 *
 * POST /weekly-report
 * {
 *   "date": "14-Apr-2026",            // Optional, DD-MMM-YYYY. Any day inside
 *                                       // the target week. Defaults to LAST WEEK
 *                                       // (Mon–Sun) computed on the api side.
 *   "groupIds": ["120363xxx@g.us"],   // Required — WhatsApp group(s) to send to
 *   "groupId":  "120363xxx@g.us",     // Fallback single group
 *   "dryRun":   false                 // Optional — return URL without sending
 * }
 */

const axios = require("axios");
const { getGroupConfiguration } = require("../config/group-config");

const SCRAPE_API_URL = process.env.SCRAPE_API_URL || "https://api.scrape.wentilabs.com";
const SEND_DOCUMENT_URL = `${process.env.BASE_LISTENER_URL}/send-document`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ─── Date helpers ───

/** DD-MMM-YYYY → DD/MM/YY (the format supabase_node /weekly-report expects). */
function toShortDate(ddMmmYyyy) {
  if (!ddMmmYyyy) return undefined;
  const m = ddMmmYyyy.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) return undefined;
  const monthIdx = MONTHS.indexOf(m[2].charAt(0).toUpperCase() + m[2].slice(1).toLowerCase());
  if (monthIdx === -1) return undefined;
  return `${m[1].padStart(2, "0")}/${String(monthIdx + 1).padStart(2, "0")}/${m[3].slice(2)}`;
}

// ─── Send PDF to WhatsApp ───

async function sendPdfToWhatsApp(chatId, pdfUrl, caption, clientId) {
  try {
    const payload = {
      chatId,
      fileUrl: pdfUrl,
      mimeType: "application/pdf",
      fileName: "Weekly-Report.pdf",
      caption,
      clientId: clientId || process.env.WHATSAPP_CLIENT_ID || "6587842038",
      sendAsDocument: true,
    };
    await axios.post(SEND_DOCUMENT_URL, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: 60000,
    });
    console.log(`[Weekly Report] PDF sent to ${chatId}`);
    return true;
  } catch (error) {
    console.error(`[Weekly Report] Failed to send PDF to ${chatId}:`, error.message);
    return false;
  }
}

// ─── Main handler ───

async function processWeeklyReportRequest(event, res) {
  try {
    let body = {};
    try {
      if (event.body) body = JSON.parse(event.body);
    } catch {}

    const { date: dateParam, groupIds, groupId, dryRun = false } = body;
    console.log("[Weekly Report] Request:", { date: dateParam, groupIds, groupId, dryRun });

    const recipientIds =
      groupIds && Array.isArray(groupIds) && groupIds.length > 0 ? groupIds : groupId ? [groupId] : [];

    // Resolve spreadsheet IDs from group config (matches /daily-report).
    // Aconex sheet is hardcoded on the supabase_node side now, so the
    // lambda only forwards the manpower spreadsheet ID.
    const gc = getGroupConfiguration(null);
    const spreadsheetId = gc.manpowerSpreadsheetId;
    const shortDate = toShortDate(dateParam); // may be undefined → api uses default last-week

    console.log("[Weekly Report] Calling supabase_node /weekly-report/generate...");
    const pdfResponse = await axios.post(
      `${SCRAPE_API_URL}/weekly-report/generate`,
      {
        ...(shortDate ? { date: shortDate } : {}),
        spreadsheetId,
      },
      { timeout: 300000 },
    );

    if (!pdfResponse.data?.success) {
      throw new Error(`PDF generation failed: ${pdfResponse.data?.error || "Unknown error"}`);
    }

    // Skipped (no rows for the week) — propagate as a clean response.
    if (pdfResponse.data?.skipped) {
      return res.status(200).json({
        success: true,
        skipped: true,
        reason: pdfResponse.data.reason,
        dateRange: pdfResponse.data.dateRange,
      });
    }

    const pdfUrl = pdfResponse.data.signedUrl;
    const dateRange = pdfResponse.data.dateRange;
    console.log(`[Weekly Report] PDF generated: ${pdfUrl.substring(0, 80)}... (range: ${dateRange})`);

    if (dryRun) {
      return res.status(200).json({
        success: true,
        dryRun: true,
        dateRange,
        pdfUrl,
        stats: pdfResponse.data.stats,
        recipientCount: recipientIds.length,
      });
    }

    // Send to WhatsApp groups
    const sendResults = [];
    const caption = `Weekly Report (${dateRange})`;
    for (const gid of recipientIds) {
      const sent = await sendPdfToWhatsApp(gid, pdfUrl, caption);
      sendResults.push({ groupId: gid, sent });
    }

    return res.status(200).json({
      success: true,
      dateRange,
      pdfUrl,
      stats: pdfResponse.data.stats,
      sendResults,
    });
  } catch (error) {
    console.error("[Weekly Report] Error:", error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
}

module.exports = processWeeklyReportRequest;
