const { writeGenericData, runSQLQuery, normalizeDateString } = require("../utils/action");
const { getSupabaseClient } = require("../utils/common");
const { deleteRow, updateExistingRow } = require("../utils/gsheet");
const { convertToSingaporeTime } = require("../utils/date");
const { extractManpowerFromMessage, metadata } = require("./manpower-extract");
const { extractWohhupWorkersManpower } = require("./wohhup-manpower-extract");
const { formatDateCell } = require("./manpower-gsheet");
const { sendWhatsAppReply } = require("../utils/sendMessage");

// ──────────────────────────────────────────────────────────────────────────
// Date-discrepancy soft warning
// ──────────────────────────────────────────────────────────────────────────
// Manpower reports occasionally carry a body-date that differs from the
// WhatsApp message-sent date. Some are typos; some are legitimate (e.g., a
// night-shift TBM filed at 8pm for the following calendar day's work).
// Rather than reject either way, we write the row as-is and send a soft reply
// asking the supervisor to edit the message if the date was a mistake — they
// can ignore the reply if intentional.
const MONTH_INDEX = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

// Parse "DD-MMM-YYYY" / "D-MMM-YYYY" / ISO-ish into a UTC midnight Date, or null.
function parseReportDateUtc(str) {
  if (!str || typeof str !== "string") return null;
  const m = str.trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
  if (m) {
    const monIdx = MONTH_INDEX[m[2].toLowerCase()];
    if (monIdx === undefined) return null;
    return new Date(Date.UTC(Number(m[3]), monIdx, Number(m[1])));
  }
  const fallback = new Date(str);
  if (Number.isNaN(fallback.getTime())) return null;
  return new Date(Date.UTC(fallback.getUTCFullYear(), fallback.getUTCMonth(), fallback.getUTCDate()));
}

// Convert a raw senderDetails.timestamp (Unix seconds, ms, or ISO string) into
// a UTC midnight Date that represents the SGT (UTC+8) calendar date.
function timestampToSgtUtcMidnight(raw) {
  if (raw == null) return null;
  let ms;
  if (typeof raw === "number") {
    ms = raw < 1e10 ? raw * 1000 : raw;
  } else if (typeof raw === "string") {
    if (/^\d{10,13}$/.test(raw)) {
      ms = Number(raw) * (raw.length <= 10 ? 1000 : 1);
    } else {
      const parsed = new Date(raw);
      if (Number.isNaN(parsed.getTime())) return null;
      ms = parsed.getTime();
    }
  } else {
    return null;
  }
  const sgt = new Date(ms + 8 * 3600 * 1000);
  return new Date(Date.UTC(sgt.getUTCFullYear(), sgt.getUTCMonth(), sgt.getUTCDate()));
}

const FMT_MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function formatHumanDate(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "(unknown)";
  return `${String(d.getUTCDate()).padStart(2, "0")}-${FMT_MONTH[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

// Compares the report's stated date against the WhatsApp message timestamp's
// SGT calendar date. Returns null when they match; otherwise an object with
// the two dates and the diff in days (positive = report ahead of timestamp).
function detectDateDiscrepancy(reportDateStr, senderDetails) {
  const reported = parseReportDateUtc(reportDateStr);
  const expected = timestampToSgtUtcMidnight(senderDetails?.timestamp);
  if (!reported || !expected) return null;
  const diffDays = Math.round((reported.getTime() - expected.getTime()) / 86400000);
  if (diffDays === 0) return null;
  return {
    reported,
    expected,
    reportedStr: formatHumanDate(reported),
    expectedStr: formatHumanDate(expected),
    diffDays,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Shared LLM-extraction audit (matches the original create-flow logic
// verbatim — no new heuristics added; this is the same `breakdownSum vs
// totalWorkers` check that has been in createManpowerData all along, just
// extracted so the edit flow can call the exact same code).
// ──────────────────────────────────────────────────────────────────────────
function auditExtractedCompany(_messageBody, company) {
  if (!company) return null;
  const breakdownKeys = Object.keys(company.workerBreakdown || {});
  const breakdownSum = breakdownKeys.length > 0 ? Object.values(company.workerBreakdown).reduce((a, b) => a + b, 0) : 0;

  if (breakdownKeys.length > 0 && company.totalWorkers > 0 && breakdownSum !== company.totalWorkers) {
    return {
      kind: "internal_mismatch",
      breakdownSum,
      logMsg: `Mismatch for "${company.name}": totalWorkers=${company.totalWorkers}, breakdownSum=${breakdownSum}`,
      replyText:
        `⚠️ *Manpower report rejected — total does not match breakdown*\n\n` +
        `Stated total: *${company.totalWorkers}*\n` +
        `Breakdown sum: *${breakdownSum}* (${breakdownKeys.length} roles)\n\n` +
        `Please check your numbers and resubmit.`,
    };
  }

  return null;
}

// If the LLM returned totalWorkers=0 but the breakdown has data, fill in the
// total from the sum. Mutates `company` in place. Used by both create + edit
// so the sheet's Total cell never says 0 when individual roles add up.
function normalizeTotalWorkersIfMissing(company) {
  if (!company) return;
  const breakdownKeys = Object.keys(company.workerBreakdown || {});
  if (!breakdownKeys.length) return;
  const breakdownSum = Object.values(company.workerBreakdown).reduce((a, b) => a + b, 0);
  if (company.totalWorkers === 0 && breakdownSum > 0) {
    console.log(`[Manpower Validation] No stated total, using breakdown sum: ${breakdownSum}`);
    company.totalWorkers = breakdownSum;
  }
}

// Send the audit's mismatch reply. Best-effort — never throws.
async function sendAuditReply(message, senderDetails, audit) {
  if (!audit?.replyText) return;
  const chatId = typeof message === "object" ? message.from || message.chatId : null;
  if (!chatId) return;
  try {
    const quotedMsgId = senderDetails?.messageIdSerialized || null;
    await sendWhatsAppReply(chatId, audit.replyText, undefined, undefined, quotedMsgId);
  } catch (replyError) {
    console.error("[Manpower Validation] Failed to send audit reply:", replyError.message);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Customer-specific fallback — WHPL TBM "Production : NN pax" reports
// ──────────────────────────────────────────────────────────────────────────
// WHPL submits TBMs that intentionally don't break manpower down by role —
// they only report a single Production headcount (e.g. "Production : 4 pax").
// The standard extractor correctly rejects such messages because they have no
// role-count pairs. The customer wants these counted as totalWorkers=NN with
// a single "Production" entry in the breakdown.
//
// This fallback is narrow on purpose:
//   - Only fires when the LLM REJECTED the message (isValidReport=false).
//   - Only fires when *Company*: WHPL is explicitly written.
//   - Only fires when a "Production : NN pax" line is present.
//   - Returns null otherwise → standard rejection path still applies for
//     every other company / format.
//
// Returns an `args`-shaped object compatible with the LLM extraction output,
// or null if the body doesn't fit the WHPL pattern.
const _MONTHS_3 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function tryWhplProductionOverride(body) {
  if (!body || typeof body !== "string") return null;
  // "Company" label, tolerant to common typos (Compacy, Compnay, Compay…).
  // Comp\w* matches any Comp- prefix word; the `WHPL\b` word boundary keeps
  // false positives away (the WHPL token is the actual identifier).
  if (!/\*?\s*Comp\w*\s*\*?\s*[:\-]\s*WHPL\b/i.test(body)) return null;
  // Production headcount: "Production : 4pax" / "Production: 4 pax" / "Production - 4 pax"
  // Allow whitespace/newlines between "Production" header and the number line.
  const m = body.match(/Production\s*[:\-]?\s*[\n\r\s]*\s*(\d+)\s*pax\b/i);
  if (!m) return null;
  const totalWorkers = Number(m[1]);
  if (!Number.isFinite(totalWorkers) || totalWorkers <= 0) return null;

  // Parse date — accept "DD/MM/YYYY" / "DD/MM/YY" / "DD-MM-YYYY".
  // Reject the override if no date can be parsed: every manpower row must carry a real
  // Date so daily filters and date-discrepancy warnings work. Without one, fall through
  // to the LLM-rejection flow (the message is then skipped by the caller).
  const dm = body.match(/\*?\s*Date\s*\*?\s*[:\-]?\s*(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/i);
  if (!dm) return null;
  const monIdx = parseInt(dm[2], 10) - 1;
  if (monIdx < 0 || monIdx > 11) return null;
  const day = String(dm[1]).padStart(2, "0");
  const yr = dm[3].length === 2 ? `20${dm[3]}` : dm[3];
  const date = `${day}-${_MONTHS_3[monIdx]}-${yr}`;

  const shift = /night/i.test(body) ? "Night" : "Day";

  // Parse the *Machineries & Equipments:-* block when present. WHPL's TBM
  // template lists equipment as a numbered list between the "Machineries"
  // header and the next section ("Control measures" / "Hazard" / end-of-body).
  // Tolerant of "Machinerie/s", "Machinery", "&"/"and", trailing colon/dash,
  // bullet variants. Returns an empty breakdown when the section is missing
  // or empty — preserves the previous "no machinery" semantics.
  const { totalMachines, machineBreakdown } = parseWhplMachinery(body);

  return {
    isValidReport: true,
    rejectionReason: null,
    date,
    shift,
    companies: [
      {
        name: "WHPL",
        location: "",
        totalWorkers,
        workerBreakdown: { Production: totalWorkers },
        activity: "",
        totalMachines,
        machineBreakdown,
      },
    ],
  };
}

/**
 * Parses the "Machineries & Equipments" block from a WHPL TBM body.
 * Returns `{ totalMachines, machineBreakdown }`. Empty block / missing block
 * → `{ totalMachines: 0, machineBreakdown: {} }`.
 *
 * Equipment line shapes we accept (all real samples from WH SAFETY group):
 *   "1) Telescopic Crawler Crane"                       → { "Telescopic Crawler Crane": 1 }
 *   "1) Telescopic Crawler Crane(110T)"                 → { "Telescopic Crawler Crane": 1 }
 *   "1) Telescopic Crawler Crane(110T) - 1 no's"        → { "Telescopic Crawler Crane": 1 }
 *   "2)Mobile crane(300T) - 1 no's"                     → { "Mobile crane": 1 }
 *   "3)Excavater - 2 no's"                              → { "Excavater": 2 }
 *
 * Count rules:
 *   - If a trailing "- N no's / nos / units / pcs" suffix is present, use N.
 *   - Otherwise default to 1 (the listing presence itself implies ≥1).
 *
 * Name canonicalisation (kept light — heavy fuzzy dedup is the consumer's job):
 *   - Strip leading bullet/number ("1)", "•", "-", "*", "(").
 *   - Strip trailing "(XXXT)" / "(110T)" capacity parentheticals.
 *   - Strip trailing "- N no's"-style count suffix.
 *   - Trim whitespace.
 *
 * Aggregation: same equipment name appearing twice in one TBM is SUMMED
 * (e.g., "1) Crawler Crane - 1 no's", "2) Crawler Crane - 1 no's" → 2).
 * This is unusual but defensive — never lose data.
 */
function parseWhplMachinery(body) {
  const out = { totalMachines: 0, machineBreakdown: {} };
  if (!body || typeof body !== "string") return out;

  // Find the section. Header tolerance: "Machinery"/"Machineries"/"Machinerie",
  // with or without "& Equipment"/"& Equipments"/"and Equipment". Optional
  // asterisks, optional colon/dash. End boundary is the next section header
  // we know about, or end-of-body.
  //
  // The `Machiner(?:y|ies|ie)` alternation is deliberate — `Machinerie?s?`
  // (the obvious-looking shorthand) does NOT match `Machinery` because the
  // root is `Machiner`+`y`, not `Machineri`+`e?`+`s?`.
  const sectionRe =
    /\*?\s*Machiner(?:y|ies|ie|i)\s*\*?\s*(?:\&|and)?\s*\*?\s*Equipments?\*?\s*[:：\-]?\s*\-?\s*([\s\S]*?)(?:\*?\s*(?:Control\s*measures?|Hazards?|Safety|PPE|Total\s*Manpower|Activit(?:y|ies)|Work\s*Activit(?:y|ies)|TBM\s*conducted|Attended\s*By)\b|$)/i;
  const mc = body.match(sectionRe);
  if (!mc) return out;
  const block = (mc[1] || "").trim();
  if (!block) return out;

  const lines = block
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const rawLine of lines) {
    // Strip leading list markers: digits, ), . , -, *, •, (
    let line = rawLine
      .replace(/^[\s\*\-•·]*\(?\s*\d{1,2}\s*[\)\.\:]\s*/, "")
      .replace(/^[\*\-•·\s]+/, "")
      .trim();
    if (!line) continue;
    // Skip lines that are clearly not equipment (e.g., section headers that
    // slipped past the boundary regex due to weird casing).
    if (/^(control\s*measure|hazard|ppe|safety)/i.test(line)) continue;

    // Count: "- N no's / nos / no.s / unit(s) / pcs / nums" at end of line.
    // WHPL uses "no's" (apostrophe-s) most days, so the apostrophe must be
    // tolerated explicitly.
    let count = 1;
    const cntM = line.match(/[\-\s:]\s*(\d+)\s*(?:no\.?'?s?|nos?|nums?|units?|pcs?)\s*$/i);
    if (cntM) {
      const c = parseInt(cntM[1], 10);
      if (Number.isFinite(c) && c > 0) count = c;
      line = line.slice(0, cntM.index).trim();
    } else {
      // Tolerant pass: "- 2" at end of line without unit suffix.
      const cntM2 = line.match(/[\-:]\s*(\d+)\s*$/);
      if (cntM2) {
        const c = parseInt(cntM2[1], 10);
        if (Number.isFinite(c) && c > 0) count = c;
        line = line.slice(0, cntM2.index).trim();
      }
    }

    // Strip a trailing capacity parenthetical like "(110T)" / "(300T)" /
    // "(50 Ton)" — keeps the equipment name canonical for downstream dedup.
    line = line.replace(/\s*\((?:\d+\s*(?:T|Ton|tonne|tonnes|t)\.?)\s*\)\s*$/i, "").trim();

    // Final cleanup: trailing punctuation.
    line = line.replace(/[\s\-:,.;]+$/g, "").trim();
    if (!line) continue;

    out.machineBreakdown[line] = (out.machineBreakdown[line] || 0) + count;
  }
  out.totalMachines = Object.values(out.machineBreakdown).reduce((s, n) => s + n, 0);
  return out;
}

// Best-effort soft reply. Never throws — failure is logged.
async function maybeReplyDateDiscrepancy(message, senderDetails, reportDateStr, shift) {
  const discrepancy = detectDateDiscrepancy(reportDateStr, senderDetails);
  if (!discrepancy) return;
  const chatId = typeof message === "object" ? message.from || message.chatId : null;
  if (!chatId) return;
  const shiftLabel = shift ? ` (${shift} shift)` : "";
  const warnMsg =
    `⚠️ *Date discrepancy detected*${shiftLabel}\n\n` +
    `Reported date: *${discrepancy.reportedStr}*\n` +
    `Message sent on: *${discrepancy.expectedStr}* (SGT)\n\n` +
    `If the report date is wrong, please *edit the message* to fix it.\n` +
    `If it's intentional, you can ignore this.`;
  try {
    const quotedMsgId = senderDetails?.messageIdSerialized || null;
    await sendWhatsAppReply(chatId, warnMsg, undefined, undefined, quotedMsgId);
    console.log(
      `[Manpower Validation] Sent date-discrepancy reply (reported=${discrepancy.reportedStr}, sent=${discrepancy.expectedStr}, diffDays=${discrepancy.diffDays}, shift=${shift || "?"}).`,
    );
  } catch (replyError) {
    console.error("[Manpower Validation] Failed to send date-discrepancy reply:", replyError.message);
  }
}

/**
 * Creates manpower data entries from a message
 * @param {object|string} message - The message object or content string
 * @param {object} senderDetails - Details about the message sender
 * @param {object} groupConfig - Group configuration containing spreadsheetId
 * @returns {Promise<object>} - The result of the extraction
 */
async function createManpowerData(message, senderDetails = null, groupConfig = null) {
  const messageContent = typeof message === "object" ? message.body : message;
  const chatName = (typeof message === "object" ? message.chatName : "") || "";
  const rawMessage = messageContent || "";
  const messageId = senderDetails?.messageId || "";

  // ── DEBUG LOG: what's about to be passed to the LLM ──
  console.log(
    `[Manpower Create] LLM input — messageId=${messageId}, body length=${(messageContent || "").length} chars, body:\n----- BEGIN BODY -----\n${messageContent}\n----- END BODY -----`,
  );

  const extraction = await extractManpowerFromMessage(messageContent);

  if (!extraction) {
    return {
      functionCalls: [],
      message: `Failed to extract valid manpower data.`,
      metadata,
    };
  }

  const { args, functionCalls } = extraction;

  // ── DEBUG LOG: what the LLM returned ──
  console.log(
    `[Manpower Create] LLM output — isValidReport=${args.isValidReport}, companies=${args.companies?.length ?? 0}, date=${args.date}, shift=${args.shift}`,
  );
  if (args.companies?.[0]) {
    const c0 = args.companies[0];
    const sum0 = Object.values(c0.workerBreakdown || {}).reduce((a, b) => a + b, 0);
    console.log(
      `[Manpower Create] LLM output — company="${c0.name}", totalWorkers=${c0.totalWorkers}, breakdown sum=${sum0}, breakdown=${JSON.stringify(c0.workerBreakdown)}`,
    );
  }

  // Check if message was classified as invalid (handled inside extractManpowerFromMessage for retry,
  // but the final result may still be invalid)
  if (args.isValidReport === false) {
    // Customer-specific fallback: WHPL TBMs that report only a Production
    // headcount (no role-count pairs). Reuse the LLM-shaped args.
    const whplOverride = tryWhplProductionOverride(rawMessage);
    if (whplOverride) {
      console.log(
        `[Manpower Validation] WHPL TBM override applied — Production-only format. totalWorkers=${whplOverride.companies[0].totalWorkers}`,
      );
      Object.assign(args, whplOverride);
      // Fall through into the normal create flow with the synthesized args.
    } else {
      console.log(`📋 Message rejected as invalid manpower report: ${args.rejectionReason || "No reason given"}`);
      return {
        functionCalls,
        message: `Message is not a valid manpower report: ${args.rejectionReason || "Does not meet standard report criteria"}`,
        metadata,
        skipped: true,
      };
    }
  }

  let processedCount = 0;

  try {
    // One message = one record. Always take the first company only.
    // If LLM hallucinated multiple companies from a single message, merge them.
    if (args.companies.length > 1) {
      console.warn(`⚠️ LLM returned ${args.companies.length} companies from a single message — using first entry only`);
    }
    const company = args.companies[0];
    if (!company || (company.totalWorkers === 0 && Object.keys(company.workerBreakdown || {}).length === 0)) {
      return {
        functionCalls: [],
        message: "No worker data found in the report.",
        metadata,
        skipped: true,
      };
    }

    // ── POST-EXTRACTION VALIDATION (code, not LLM) ──
    // Sum the breakdown in code and compare with stated total.
    // Same logic as before — extracted into a shared helper so the edit flow
    // can call the exact same code path. No new heuristics added.
    const _bSum = Object.values(company.workerBreakdown || {}).reduce((a, b) => a + b, 0);
    console.log(
      `[Manpower Create] AUDIT input — totalWorkers=${company.totalWorkers}, breakdownSum=${_bSum}, breakdownKeys=${Object.keys(company.workerBreakdown || {}).length}`,
    );
    const audit = auditExtractedCompany(rawMessage, company);
    if (audit) {
      console.warn(`⚠️ [Manpower Create] AUDIT FAIL — ${audit.logMsg}. Rejecting.`);
      await sendAuditReply(message, senderDetails, audit);
      return {
        functionCalls,
        message: `Manpower report rejected: total (${company.totalWorkers}) does not match breakdown sum (${audit.breakdownSum})`,
        metadata,
        skipped: true,
        validationError: true,
      };
    }
    console.log(`[Manpower Create] AUDIT PASS — proceeding to write sheet rows.`);

    // If totalWorkers is 0 but breakdown has data, use breakdown sum as totalWorkers
    normalizeTotalWorkersIfMissing(company);

    const manpowerData = [
      {
        date: args.date,
        company: company.name,
        location: company.location,
        totalWorkers: company.totalWorkers || 0,
        activity: company.activity || "",
        workerBreakdown: JSON.stringify(company.workerBreakdown || {}),
        shift: args.shift || "Day",
      },
    ];

    console.log(
      "📝 Writing manpower data:",
      manpowerData.map((d) => ({
        date: d.date,
        company: d.company,
        totalWorkers: d.totalWorkers,
        workerBreakdown: d.workerBreakdown,
      })),
    );
    await writeGenericData(manpowerData, "Manpower", args.date, senderDetails, {
      spreadsheetId: groupConfig?.manpowerSpreadsheetId,
      appendFields: [chatName, rawMessage, messageId],
    });
    // Format date cell as yyyy-mm-dd — find the exact row by messageId to avoid race conditions
    if (groupConfig?.manpowerSpreadsheetId && messageId) {
      const writtenRow = await findExistingManpowerRow(messageId, groupConfig);
      if (writtenRow) {
        await formatDateCell(
          groupConfig.manpowerSpreadsheetId,
          groupConfig?.manpowerSheetName || "Manpower",
          writtenRow.RowNumber,
        );
      }
    }

    const hasMachinery = (company.totalMachines || 0) > 0 || Object.keys(company.machineBreakdown || {}).length > 0;
    const machineryData = hasMachinery
      ? [
          {
            date: args.date,
            company: company.name,
            location: company.location,
            totalMachines: company.totalMachines || 0,
            machineBreakdown: JSON.stringify(company.machineBreakdown || {}),
            shift: args.shift || "Day",
          },
        ]
      : [];

    if (machineryData.length > 0) {
      console.log(
        "📝 Writing machinery data:",
        machineryData.map((d) => ({
          date: d.date,
          company: d.company,
          totalMachines: d.totalMachines,
          machineBreakdown: d.machineBreakdown,
        })),
      );
      await writeGenericData(machineryData, "Machines", args.date, senderDetails, {
        spreadsheetId: groupConfig?.machinesSpreadsheetId,
        appendFields: [chatName, rawMessage, messageId],
      });
      // Format date cell as yyyy-mm-dd — find the exact row by messageId to avoid race conditions
      if (groupConfig?.machinesSpreadsheetId && messageId) {
        const writtenRow = await findExistingMachinesRow(messageId, groupConfig);
        if (writtenRow) {
          await formatDateCell(
            groupConfig.machinesSpreadsheetId,
            groupConfig?.machinesSheetName || "Machines",
            writtenRow.RowNumber,
          );
        }
      }
    }

    processedCount += args.companies.length;

    // Soft warning: if the body-date and the WhatsApp message timestamp
    // disagree, ask the supervisor to edit if it was a typo. Non-blocking —
    // never rejects the report.
    await maybeReplyDateDiscrepancy(message, senderDetails, args.date, args.shift);

    return {
      functionCalls,
      message: `Successfully extracted and validated data for ${processedCount} entries (manpower and machinery)`,
      metadata,
    };
  } catch (error) {
    console.error("Error processing validated manpower data:", error);
    return {
      functionCalls: [],
      message: `Error processing data: ${error.message}`,
      metadata,
    };
  }
}

/**
 * Creates manpower data entries from a Wohhup compact-format message
 * (e.g. "MBS- IR2 MANPOWER ... WH Workers Manpower ... Workers: T= 06").
 * The standard createManpowerData rejects these messages because they have
 * fewer than 5 role-count pairs and no "Total Manpower" line. This function
 * uses a dedicated Wohhup extractor and writes to the SAME Manpower sheet
 * with role labels "Worker" and "Engineer".
 *
 * @param {object|string} message - The message object or content string
 * @param {object} senderDetails - Details about the message sender
 * @param {object} groupConfig - Group configuration containing spreadsheetId
 * @returns {Promise<object>} - The result of the extraction
 */
async function createWohhupManpowerData(message, senderDetails = null, groupConfig = null) {
  const messageContent = typeof message === "object" ? message.body : message;
  const chatName = (typeof message === "object" ? message.chatName : "") || "";
  const rawMessage = messageContent || "";
  const messageId = senderDetails?.messageId || "";
  // sectionType is set by the pre-classifier (usecases/health_safety/openai.js).
  // Fallback to "workers" if absent (e.g., direct call from a script that bypasses
  // the pre-classifier — the extractor will still parse correctly because the
  // common case is workers).
  const sectionType = (typeof message === "object" ? message.__wohhupSectionType : null) || "workers";

  const extraction = await extractWohhupWorkersManpower(messageContent, sectionType);

  if (!extraction) {
    return {
      functionCalls: [],
      message: "Failed to extract Wohhup manpower data (extractor returned null).",
      metadata,
    };
  }

  // Skip-when-zero double-guard: even if the LLM somehow flags isValid=true with
  // an empty breakdown, refuse to write a 0-worker row to the sheet.
  if (
    !extraction.isValid ||
    extraction.totalWorkers === 0 ||
    !extraction.workerBreakdown ||
    extraction.workerBreakdown.length === 0
  ) {
    console.log(`[Wohhup Manpower] Skipping — ${extraction.rejectionReason || "zero workers / empty breakdown"}`);
    return {
      functionCalls: [{ functionName: "extract_wohhup_workers_manpower", arguments: extraction }],
      message: `Wohhup manpower message skipped: ${extraction.rejectionReason || "zero workers reported"}`,
      metadata,
      skipped: true,
    };
  }

  // Defense-in-depth: even though the strict JSON schema enum is ["Worker","Engineer"],
  // filter out anything that isn't one of those two canonical roles so non-on-site
  // categories (HomeLeave, LoanOut, Total, etc.) can NEVER reach the Manpower sheet.
  // Those values are tracked separately by wh-worker-breakdown-tracker for the daily image.
  const ALLOWED_ROLES = new Set(["Worker", "Engineer"]);
  const filteredBreakdown = extraction.workerBreakdown.filter((entry) => {
    if (!ALLOWED_ROLES.has(entry.role)) {
      console.warn(
        `[Wohhup Manpower] Filtered out non-on-site role "${entry.role}" (count=${entry.count}) — not allowed in Manpower sheet`,
      );
      return false;
    }
    if (!Number.isInteger(entry.count) || entry.count <= 0) return false;
    return true;
  });

  if (filteredBreakdown.length === 0) {
    console.log("[Wohhup Manpower] After defensive filter, breakdown is empty — skipping write");
    return {
      functionCalls: [{ functionName: "extract_wohhup_workers_manpower", arguments: extraction }],
      message: "Wohhup manpower message skipped: no on-site Worker/Engineer counts after filter",
      metadata,
      skipped: true,
    };
  }

  // Convert workerBreakdown array → object form (matches standard manpower schema)
  const workerBreakdownObj = Object.fromEntries(filteredBreakdown.map(({ role, count }) => [role, count]));
  // Recompute totalWorkers from the filtered breakdown to keep Total + Details consistent
  extraction.totalWorkers = filteredBreakdown.reduce((sum, e) => sum + e.count, 0);

  const manpowerData = [
    {
      date: extraction.date,
      company: "Woh Hup",
      location: "",
      totalWorkers: extraction.totalWorkers,
      activity: "",
      workerBreakdown: JSON.stringify(workerBreakdownObj),
      shift: "Day",
    },
  ];

  console.log(
    "📝 [Wohhup Manpower] Writing:",
    JSON.stringify({
      date: extraction.date,
      total: extraction.totalWorkers,
      breakdown: workerBreakdownObj,
    }),
  );

  try {
    await writeGenericData(manpowerData, "Manpower", extraction.date, senderDetails, {
      spreadsheetId: groupConfig?.manpowerSpreadsheetId,
      appendFields: [chatName, rawMessage, messageId],
    });

    if (groupConfig?.manpowerSpreadsheetId && messageId) {
      const writtenRow = await findExistingManpowerRow(messageId, groupConfig);
      if (writtenRow) {
        await formatDateCell(
          groupConfig.manpowerSpreadsheetId,
          groupConfig?.manpowerSheetName || "Manpower",
          writtenRow.RowNumber,
        );
      }
    }

    // Soft date-discrepancy warning (non-blocking — see maybeReplyDateDiscrepancy).
    await maybeReplyDateDiscrepancy(message, senderDetails, extraction.date, "Day");

    return {
      functionCalls: [{ functionName: "extract_wohhup_workers_manpower", arguments: extraction }],
      message: `Wohhup manpower recorded: ${extraction.totalWorkers} (${Object.entries(workerBreakdownObj)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")})`,
      metadata,
    };
  } catch (error) {
    console.error("[Wohhup Manpower] Error writing data:", error);
    return {
      functionCalls: [],
      message: `Error writing Wohhup manpower data: ${error.message}`,
      metadata,
    };
  }
}

/**
 * Resolve the original messageId from a deleted message's parentMsgKey via Supabase.
 * Delete events use parentMsgKey = messageIdSerialized of the original message.
 * @param {object} message - The deletion event message
 * @returns {Promise<string|null>} - The original messageId or null
 */
async function resolveOriginalMessageId(message) {
  const parentMsgKey = message?.parentMsgKey;
  if (!parentMsgKey) return null;

  try {
    const { data: originalMessages, error } = await getSupabaseClient()
      .from("whatsapp_listener")
      .select("messageId")
      .eq("messageIdSerialized", parentMsgKey)
      .eq("from", message.from)
      .order("created_at", { ascending: false })
      .limit(1);

    if (error) {
      console.error("[Manpower Delete] Error querying Supabase for original message:", error);
      return null;
    }

    if (!originalMessages || originalMessages.length === 0) {
      console.log(`[Manpower Delete] Original message not found in DB for parentMsgKey: ${parentMsgKey}`);
      return null;
    }

    return originalMessages[0].messageId;
  } catch (error) {
    console.error("[Manpower Delete] Error resolving original messageId:", error);
    return null;
  }
}

/**
 * Find an existing manpower row by messageId stored in Sender JSON
 * @param {string} messageId - The WhatsApp messageId to search for
 * @param {object} groupConfig - Group configuration containing manpowerSpreadsheetId
 * @returns {Promise<object|null>} - The matching row or null
 */
async function findExistingManpowerRow(messageId, groupConfig) {
  if (!messageId) return null;

  try {
    const sanitized = messageId.replace(/'/g, "''");
    const query = `SELECT TOP 1 RowNumber, * FROM manpowerData WHERE getMessageId(Sender) = '${sanitized}' ORDER BY RowNumber DESC`;

    const rows = await runSQLQuery(query, "manpower", { groupConfig });

    if (!Array.isArray(rows) || rows.length === 0 || rows.error) {
      return null;
    }

    return rows[0];
  } catch (error) {
    console.error("[Manpower] Error finding existing manpower row:", error);
    return null;
  }
}

/**
 * Find an existing machines row by messageId stored in Sender JSON
 * @param {string} messageId - The WhatsApp messageId to search for
 * @param {object} groupConfig - Group configuration containing machinesSpreadsheetId
 * @returns {Promise<object|null>} - The matching row or null
 */
async function findExistingMachinesRow(messageId, groupConfig) {
  if (!messageId) return null;

  try {
    const sanitized = messageId.replace(/'/g, "''");
    const query = `SELECT TOP 1 RowNumber, * FROM machinesData WHERE getMessageId(Sender) = '${sanitized}' ORDER BY RowNumber DESC`;

    const rows = await runSQLQuery(query, "machines", { groupConfig });

    if (!Array.isArray(rows) || rows.length === 0 || rows.error) {
      return null;
    }

    return rows[0];
  } catch (error) {
    console.error("[Machines] Error finding existing machines row:", error);
    return null;
  }
}

/**
 * Handle a deleted WhatsApp message by removing both Manpower and Machines rows.
 * Called BEFORE intent classification — no LLM call needed.
 * @param {object} message - The deletion event message
 * @param {object} groupConfig - Group configuration
 * @returns {Promise<object|null>} - Result of the deletion or null if not found
 */
async function handleDeletedManpowerMessage(message, groupConfig = null) {
  const messageId = await resolveOriginalMessageId(message);
  if (!messageId) return null;

  console.log(`[Manpower Delete] Resolved original messageId: ${messageId}`);

  let deleted = false;

  // Try to delete from Manpower sheet
  const manpowerRow = await findExistingManpowerRow(messageId, groupConfig);
  if (manpowerRow) {
    const spreadsheetId = groupConfig?.manpowerSpreadsheetId;
    const sheetName = groupConfig?.manpowerSheetName || "Manpower";
    if (spreadsheetId) {
      console.log(`[Manpower Delete] Deleting manpower row ${manpowerRow.RowNumber} from "${sheetName}"`);
      await deleteRow(spreadsheetId, sheetName, manpowerRow.RowNumber);
      deleted = true;
    }
  }

  // Try to delete from Machines sheet
  const machinesRow = await findExistingMachinesRow(messageId, groupConfig);
  if (machinesRow) {
    const spreadsheetId = groupConfig?.machinesSpreadsheetId;
    const sheetName = groupConfig?.machinesSheetName || "Machines";
    if (spreadsheetId) {
      console.log(`[Manpower Delete] Deleting machines row ${machinesRow.RowNumber} from "${sheetName}"`);
      await deleteRow(spreadsheetId, sheetName, machinesRow.RowNumber);
      deleted = true;
    }
  }

  if (!deleted) {
    console.log(`[Manpower Delete] No manpower or machines rows found for messageId: ${messageId}`);
    return null;
  }

  return { deleted: true, messageId };
}

/**
 * Handle an edited WhatsApp message by re-extracting manpower data and updating both sheets.
 * Called BEFORE intent classification — uses its own extraction LLM call.
 * @param {object} message - The edited message object
 * @param {object} senderDetails - Sender metadata
 * @param {object} groupConfig - Group configuration
 * @returns {Promise<object|null>} - Result of the update or null if not found
 */
async function handleEditedManpowerMessage(message, senderDetails, groupConfig = null) {
  const messageId = senderDetails?.messageId;
  if (!messageId) return null;

  // Check if this message exists on either Manpower or Machines sheet
  let manpowerRow = await findExistingManpowerRow(messageId, groupConfig);
  let machinesRow = await findExistingMachinesRow(messageId, groupConfig);

  // If not found, the original message may still be processing (out-of-order delivery).
  // Wait and retry up to 2 times with 60s delay to let the original create finish.
  if (!manpowerRow && !machinesRow) {
    const maxWaitRetries = 2;
    const waitDelayMs = 60000; // 60 seconds
    for (let retry = 1; retry <= maxWaitRetries; retry++) {
      console.log(
        `[Manpower Edit] No rows found for messageId ${messageId} — waiting ${waitDelayMs / 1000}s for original to be processed (retry ${retry}/${maxWaitRetries})`,
      );
      await new Promise((resolve) => setTimeout(resolve, waitDelayMs));
      manpowerRow = await findExistingManpowerRow(messageId, groupConfig);
      machinesRow = await findExistingMachinesRow(messageId, groupConfig);
      if (manpowerRow || machinesRow) {
        console.log(`[Manpower Edit] Found rows after ${(retry * waitDelayMs) / 1000}s wait`);
        break;
      }
    }
  }

  if (!manpowerRow && !machinesRow) {
    console.log(`[Manpower Edit] No manpower/machines rows found for messageId: ${messageId} after retries`);
    return null;
  }

  console.log(
    `[Manpower Edit] Found existing rows — manpower: ${manpowerRow?.RowNumber || "none"}, machines: ${machinesRow?.RowNumber || "none"}`,
  );

  // Re-extract manpower data using the SAME extraction logic as createManpowerData
  const messageContent = typeof message === "object" ? message.body : message;
  const chatName = (typeof message === "object" ? message.chatName : "") || "";

  // ── DEBUG LOG: what's about to be passed to the LLM ──
  console.log(
    `[Manpower Edit] LLM input — messageId=${messageId}, body length=${(messageContent || "").length} chars, body:\n----- BEGIN BODY -----\n${messageContent}\n----- END BODY -----`,
  );

  const extraction = await extractManpowerFromMessage(messageContent);

  if (!extraction) {
    console.warn("[Manpower Edit] Failed to extract manpower data from edited message — keeping existing data");
    return { edited: false, kept: true, messageId };
  }

  const { args } = extraction;

  // ── DEBUG LOG: what the LLM returned ──
  console.log(
    `[Manpower Edit] LLM output — isValidReport=${args.isValidReport}, companies=${args.companies?.length ?? 0}, date=${args.date}, shift=${args.shift}`,
  );
  if (args.companies?.[0]) {
    const c0 = args.companies[0];
    const sum0 = Object.values(c0.workerBreakdown || {}).reduce((a, b) => a + b, 0);
    console.log(
      `[Manpower Edit] LLM output — company="${c0.name}", totalWorkers=${c0.totalWorkers}, breakdown sum=${sum0}, breakdown=${JSON.stringify(c0.workerBreakdown)}`,
    );
  }

  if (args.isValidReport === false || !args.companies || args.companies.length === 0) {
    // Customer-specific fallback: WHPL TBMs that report only a Production
    // headcount (no role-count pairs). Mirror the create flow's behavior so
    // edits to those messages don't get silently dropped.
    const whplOverride = tryWhplProductionOverride(messageContent || "");
    if (whplOverride) {
      console.log(
        `[Manpower Edit] WHPL TBM override applied — Production-only format. totalWorkers=${whplOverride.companies[0].totalWorkers}`,
      );
      Object.assign(args, whplOverride);
    } else {
      console.log(`[Manpower Edit] Edited message is not a valid manpower report — keeping existing data`);
      return { edited: false, kept: true, messageId };
    }
  }

  try {
    // ── POST-EXTRACTION AUDIT ── (mirrors createManpowerData; catches LLM
    // hallucinations on the re-extraction pass — the case we hit in prod where
    // the body said total=9 but the LLM returned total=6 with mismatched
    // role counts that happened to sum to 6.)
    const company = args.companies[0];
    const _bSum = Object.values(company.workerBreakdown || {}).reduce((a, b) => a + b, 0);
    console.log(
      `[Manpower Edit] AUDIT input — totalWorkers=${company.totalWorkers}, breakdownSum=${_bSum}, breakdownKeys=${Object.keys(company.workerBreakdown || {}).length}`,
    );
    const audit = auditExtractedCompany(messageContent, company);
    if (audit) {
      console.warn(`⚠️ [Manpower Edit] AUDIT FAIL — ${audit.logMsg}. Keeping existing row.`);
      await sendAuditReply(message, senderDetails, audit);
      return { edited: false, kept: true, messageId, validationError: true };
    }
    console.log(`[Manpower Edit] AUDIT PASS — proceeding to update sheet rows.`);

    // Normalize totalWorkers if 0 but breakdown has data
    normalizeTotalWorkersIfMissing(company);

    // Format timestamp
    let timestamp;
    try {
      const sgTime = convertToSingaporeTime(senderDetails?.timestamp || new Date().toISOString(), { format: "human" });
      timestamp = `'${sgTime}'`;
    } catch (error) {
      timestamp = `'${new Date().toISOString()}'`;
    }

    const senderJSON = JSON.stringify(senderDetails || {});
    const normalizedDate = normalizeDateString(args.date);

    // Update Manpower rows
    if (manpowerRow && groupConfig?.manpowerSpreadsheetId) {
      // (already validated + normalized above; reuse the same `company`)
      if (company) {
        const updatedManpowerData = [
          normalizedDate,
          company.name,
          company.location,
          company.totalWorkers || 0,
          company.activity || "",
          JSON.stringify(company.workerBreakdown || {}),
          args.shift || "Day",
          senderJSON,
          timestamp,
          chatName,
          messageContent || "",
          messageId || "",
        ];
        console.log(`[Manpower Edit] Updating manpower row ${manpowerRow.RowNumber}`);
        const manpowerSheetName = groupConfig?.manpowerSheetName || "Manpower";
        await updateExistingRow(
          groupConfig.manpowerSpreadsheetId,
          manpowerSheetName,
          manpowerRow.RowNumber,
          updatedManpowerData,
        );
        await formatDateCell(groupConfig.manpowerSpreadsheetId, manpowerSheetName, manpowerRow.RowNumber);
      }
    }

    // Update Machines rows
    if (machinesRow && groupConfig?.machinesSpreadsheetId) {
      const company = args.companies[0];
      if (company) {
        const updatedMachinesData = [
          normalizedDate,
          company.name,
          company.location,
          company.totalMachines || 0,
          JSON.stringify(company.machineBreakdown || {}),
          args.shift || "Day",
          senderJSON,
          timestamp,
          chatName,
          messageContent || "",
          messageId || "",
        ];
        console.log(`[Manpower Edit] Updating machines row ${machinesRow.RowNumber}`);
        const machinesSheetName = groupConfig?.machinesSheetName || "Machines";
        await updateExistingRow(
          groupConfig.machinesSpreadsheetId,
          machinesSheetName,
          machinesRow.RowNumber,
          updatedMachinesData,
        );
        await formatDateCell(groupConfig.machinesSpreadsheetId, machinesSheetName, machinesRow.RowNumber);
      }
    }

    console.log(`[Manpower Edit] Successfully updated rows for messageId: ${messageId}`);

    // Same soft date-discrepancy warning as the create flow.
    await maybeReplyDateDiscrepancy(message, senderDetails, args.date, args.shift);

    return { edited: true, messageId };
  } catch (error) {
    console.error("[Manpower Edit] Error handling edited message:", error);
    return null;
  }
}

module.exports = {
  createManpowerData,
  createWohhupManpowerData,
  handleDeletedManpowerMessage,
  handleEditedManpowerMessage,
  // Exported for verification/test scripts — pure deterministic helpers.
  tryWhplProductionOverride,
  parseWhplMachinery,
};
