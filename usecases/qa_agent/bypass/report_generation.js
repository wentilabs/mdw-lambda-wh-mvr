/**
 * Report Generation Handler for QA Agent
 *
 * Handles the "report_generation" domain — extracts report type and date
 * from the user's question via LLM, then calls the appropriate report API.
 */

const { getOpenAI } = require("../../../utils/openai");
const processDailyReportRequest = require("../../../api/daily-report");
const processWeeklyReportRequest = require("../../../api/weekly-report");
// monthly_report and site_activity_report are optional — only present in
// deployments that include those APIs. Lazy-require at call time to avoid
// MODULE_NOT_FOUND at boot when those files are absent.
const { buildSafetySummaryMessage } = require("./safety_summary");

const metadata = {
  project: "wohhup",
  type: "qa_report_extraction",
};

/**
 * Get current SGT date/time info for the LLM prompt
 */
function getSGTContext() {
  const now = new Date();
  const sg = { timeZone: "Asia/Singapore" };

  const todayDate = now
    .toLocaleDateString("en-GB", { ...sg, day: "2-digit", month: "short", year: "numeric" })
    .replace(/ /g, "-");
  const dayName = now.toLocaleDateString("en-GB", { ...sg, weekday: "long" });

  // Yesterday
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayDate = yesterday
    .toLocaleDateString("en-GB", { ...sg, day: "2-digit", month: "short", year: "numeric" })
    .replace(/ /g, "-");

  // Last Monday (for "last week")
  const sgNow = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Singapore" }));
  const dayOfWeek = sgNow.getDay(); // 0=Sun
  const daysToLastMonday = dayOfWeek === 0 ? 8 : dayOfWeek + 7;
  const lastMonday = new Date(sgNow);
  lastMonday.setDate(sgNow.getDate() - daysToLastMonday + 1);
  const lastMondayDate = lastMonday
    .toLocaleDateString("en-GB", { ...sg, day: "2-digit", month: "short", year: "numeric" })
    .replace(/ /g, "-");

  // This Monday (for "this week")
  const daysToThisMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const thisMonday = new Date(sgNow);
  thisMonday.setDate(sgNow.getDate() - daysToThisMonday);
  const thisMondayDate = thisMonday
    .toLocaleDateString("en-GB", { ...sg, day: "2-digit", month: "short", year: "numeric" })
    .replace(/ /g, "-");

  // Month anchors (for the monthly report). First day of this/last month in
  // DD-MMM-YYYY, built from SGT year/month to avoid tz drift.
  const MON3 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const ty = sgNow.getFullYear();
  const tm = sgNow.getMonth(); // 0-based
  const firstThisMonthDate = `01-${MON3[tm]}-${ty}`;
  const lm = tm === 0 ? 11 : tm - 1;
  const ly = tm === 0 ? ty - 1 : ty;
  const firstLastMonthDate = `01-${MON3[lm]}-${ly}`;

  return {
    todayDate,
    dayName,
    yesterdayDate,
    lastMondayDate,
    thisMondayDate,
    firstThisMonthDate,
    firstLastMonthDate,
  };
}

/**
 * Extract report type and date from the user's question using LLM
 */
async function extractReportParams(cleanedQuestion) {
  const sgt = getSGTContext();

  const systemPrompt = `You extract report generation parameters from user requests.

Current date context (Singapore Time):
- Today: ${sgt.todayDate} (${sgt.dayName})
- Yesterday: ${sgt.yesterdayDate}
- This Monday (start of this week): ${sgt.thisMondayDate}
- Last Monday (start of last week): ${sgt.lastMondayDate}
- First day of this month: ${sgt.firstThisMonthDate}
- First day of last month: ${sgt.firstLastMonthDate}

Report types:
- "daily_report": A PDF daily site report (manpower + machines). Trigger words: "daily report", "daily site report", or just "report" when combined with a specific date.
- "weekly_report": A PDF weekly report with charts and tables. Trigger words: "weekly report".
- "monthly_report": A PDF monthly progress report (Executive Summary, Change Notice list, monthly manpower record, etc.). Trigger words: "monthly report", "monthly progress report", "generate monthly report", "monthly report for <month>".
- "site_activity_report": A Google Sheet report (clones template, fills data). Trigger words: "site activity report", "activity report".
- "safety_summary": The plain-text "Safety Issues Summary" — the same multi-line message the EventBridge cron sends to the safety group (header + open-issues count by P1/P2/P3 + open issues by date). Trigger words: "safety summary", "safety issue summary", "safety issues summary", "send safety summary", "daily safety summary", "safety daily summary". DATE RANGES ARE ALLOWED for safety_summary (e.g. "this week", "last month", "from 2026-05-15 to 2026-05-18", "past 7 days") — for ranges, set confirmed=true and put the START date of the range in the date field (the range itself is resolved downstream from the parser time_window). NEVER set confirmed=false for a safety_summary request just because a range is mentioned.

Date resolution rules:
- "today" → ${sgt.todayDate}
- "yesterday" → ${sgt.yesterdayDate}
- "this week" → ${sgt.thisMondayDate} (the weekly report handler resolves the full week from any date within it)
- "last week" → ${sgt.lastMondayDate}
- Explicit dates like "14 Apr 2026", "14/04/2026", "14-04-2026", "April 14" → convert to DD-MMM-YYYY format
- If no date is mentioned and report type is "daily_report" or "site_activity_report" → use today: ${sgt.todayDate}
- If no date is mentioned and report type is "weekly_report" → use last week: ${sgt.lastMondayDate}
- For "monthly_report": a named month like "May" / "May 2026" / "for May" → the FIRST day of that month in DD-MMM-YYYY (e.g. 01-May-2026; assume the current year ${sgt.todayDate.slice(-4)} if the year is omitted). "this month" → ${sgt.firstThisMonthDate}. If no month is mentioned → use last completed month: ${sgt.firstLastMonthDate}.
- If no date is mentioned and report type is "safety_summary" → use today: ${sgt.todayDate} (QA agent default — customers asking on-demand expect the live state; the EventBridge cron has its own yesterday-default that isn't affected)

IMPORTANT: "this week" is a valid request even if the week is not yet complete — generate whatever data is available so far.

Set confirmed=false ONLY if:
- The report type is truly ambiguous (user just says "generate report" without specifying daily, weekly, or activity)
- The user asks about multiple weeks (e.g. "last two weeks") — we can only handle one at a time
- The request is unclear or not actually asking to generate a report

Set confirmed=true for all clear requests including "this week", "today", "yesterday", partial weeks, etc.`;

  const schema = {
    type: "object",
    properties: {
      reportType: {
        type: "string",
        enum: ["daily_report", "weekly_report", "monthly_report", "site_activity_report", "safety_summary"],
        description: "Which report to generate",
      },
      date: {
        type: "string",
        description: "Target date in DD-MMM-YYYY format (e.g. 14-Apr-2026)",
      },
      confirmed: {
        type: "boolean",
        description: "Whether the request is clear enough to proceed",
      },
      clarificationMessage: {
        type: "string",
        description: "If confirmed=false, explain what's ambiguous",
      },
    },
    required: ["reportType", "date", "confirmed", "clarificationMessage"],
    additionalProperties: false,
  };

  const response = await getOpenAI().responses.create({
    model: "gpt-4.1",
    temperature: 0,
    input: [
      { role: "system", content: systemPrompt },
      { role: "user", content: cleanedQuestion },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "extract_report_params",
        strict: true,
        schema,
      },
    },
    store: true,
    metadata,
  });

  return JSON.parse(response.output_text);
}

/**
 * Build a mock res object that captures the API response
 */
function buildResponseCapture() {
  let captured = null;
  const res = {
    status: (code) => ({
      json: (body) => {
        captured = { statusCode: code, body };
        return {
          statusCode: code,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        };
      },
    }),
  };
  return { res, getCaptured: () => captured };
}

const REPORT_LABELS = {
  daily_report: "Daily Report",
  weekly_report: "Weekly Report",
  monthly_report: "Monthly Report",
  site_activity_report: "Site Activity Report",
  safety_summary: "Daily Safety Summary",
};

/**
 * Handle a report generation request from the QA agent
 *
 * @param {string} cleanedQuestion - The user's question (already cleaned by router)
 * @param {string} chatId - WhatsApp group/chat ID to send reports to
 * @param {object} groupConfig - Group configuration for spreadsheet routing
 * @param {object} [intent] - Optional parser intent (carries time_window).
 *                            When present and reportType === 'safety_summary',
 *                            intent.time_window's start_iso/end_iso is used
 *                            verbatim — supports ranges ("this week", "last
 *                            month", "from X to Y") which the LLM extractor
 *                            below doesn't understand.
 * @returns {Promise<{ message: string }>}
 */
async function handleReportGeneration(cleanedQuestion, chatId, groupConfig, intent) {
  console.log(`[Report Handler] Processing: "${cleanedQuestion}"`);

  // Step 1: Extract report type and date
  const params = await extractReportParams(cleanedQuestion);
  console.log(`[Report Handler] Extracted:`, params);

  if (!params.confirmed) {
    const clarification = params.clarificationMessage || "";
    return {
      message:
        clarification ||
        "Could you clarify which report you'd like?\n\n" +
          "I can generate:\n" +
          "- *Daily Report* (PDF) — manpower & machines summary\n" +
          "- *Weekly Report* (PDF) — weekly overview with charts\n" +
          "- *Site Activity Report* (Google Sheet) — daily activity breakdown\n\n" +
          "Please specify the report type and date.",
    };
  }

  const label = REPORT_LABELS[params.reportType];
  console.log(`[Report Handler] Generating ${label} for ${params.date}, chatId: ${chatId}`);

  // Step 2: Call the appropriate API handler
  const { res, getCaptured } = buildResponseCapture();

  try {
    if (params.reportType === "daily_report") {
      const event = {
        body: JSON.stringify({
          date: params.date,
          groupIds: chatId ? [chatId] : [],
          dryRun: false,
        }),
      };
      await processDailyReportRequest(event, res);
    } else if (params.reportType === "weekly_report") {
      const event = {
        body: JSON.stringify({
          date: params.date,
          groupIds: chatId ? [chatId] : [],
          dryRun: false,
        }),
      };
      await processWeeklyReportRequest(event, res);
    } else if (params.reportType === "monthly_report") {
      let processMonthlyReportRequest;
      try {
        processMonthlyReportRequest = require("../../../api/monthly-report");
      } catch (_) {
        return { message: "Monthly report is not available in this deployment." };
      }
      const event = {
        body: JSON.stringify({
          date: params.date,
          groupIds: chatId ? [chatId] : [],
          dryRun: false,
        }),
      };
      await processMonthlyReportRequest(event, res);
    } else if (params.reportType === "site_activity_report") {
      let processDailySiteActivityReportRequest;
      try {
        processDailySiteActivityReportRequest = require("../../../api/daily-site-activity-report");
      } catch (_) {
        return { message: "Site Activity Report is not available in this deployment." };
      }
      const event = {
        body: JSON.stringify({
          date: params.date,
          dryRun: false,
          overwrite: false,
        }),
      };
      await processDailySiteActivityReportRequest(event, res);
    } else if (params.reportType === "safety_summary") {
      // QA-agent-owned summary — does NOT call the cron API so the cron
      // path stays untouched. Uses the parser's intent.time_window when
      // available (so ranges like "this week" / "from X to Y" flow through
      // without an extra LLM call). Falls back to the LLM-extracted
      // params.date for older callers that don't pass intent.
      let startIso;
      let endIso;
      let rangeLabel;
      if (intent?.time_window?.start_iso && intent?.time_window?.end_iso) {
        startIso = intent.time_window.start_iso;
        endIso = intent.time_window.end_iso;
        rangeLabel = intent.time_window.kind === "range" ? intent.time_window.label : "";
      } else {
        const iso = require("./safety_summary").__test.ddmmmyyyyToIso(params.date);
        if (!iso) {
          return { message: `Daily Safety Summary: couldn't parse the date "${params.date}".` };
        }
        startIso = iso;
        endIso = iso;
        rangeLabel = "";
      }
      const summary = await buildSafetySummaryMessage({
        startIso,
        endIso,
        rangeLabel,
        chatId,
        groupConfig,
      });
      return { message: summary };
    }
  } catch (error) {
    console.error(`[Report Handler] API call failed:`, error.message);
    return { message: `Failed to generate ${label}: ${error.message}` };
  }

  // Step 3: Format the response message
  const result = getCaptured();
  if (!result) {
    return { message: `Failed to generate ${label}: No response from API.` };
  }

  if (result.statusCode !== 200 || !result.body?.success) {
    const errMsg = result.body?.error || "Unknown error";
    return { message: `Failed to generate ${label}: ${errMsg}` };
  }

  // Handle skipped cases
  if (result.body.skipped) {
    if (result.body.reason === "no_data") {
      return { message: `No data found for ${params.date}. Cannot generate ${label}.` };
    }
    if (result.body.reason === "sheet_exists") {
      return {
        message: `Sheet "${result.body.sheetName}" already exists. Ask me to regenerate if you want to overwrite it.`,
      };
    }
    return { message: `${label} skipped: ${result.body.reason}` };
  }

  // Success messages
  if (params.reportType === "site_activity_report") {
    return {
      message: `Site Activity Report for ${params.date} has been generated.\nSheet "${result.body.sheetName}" created in the report spreadsheet.`,
    };
  }

  // PDF reports (daily/weekly)
  const dateInfo = result.body.dateRange || result.body.date || params.date;
  return {
    message: `${label} (${dateInfo}) has been generated and sent to this group.`,
  };
}

module.exports = { handleReportGeneration };
