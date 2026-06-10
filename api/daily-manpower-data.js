/**
 * Daily Manpower Data Report API endpoint
 *
 * Reads today's manpower data from the existing Manpower Google Sheet,
 * classifies roles via LLM into SUPERVISOR/WORKER categories,
 * clones the "MBS" template sheet in the Manpower Data spreadsheet,
 * and writes a formatted daily report.
 *
 * POST /daily-manpower-data
 * {
 *   "date": "09-Apr-2026",           // Optional, DD-MMM-YYYY. Defaults to today (SG timezone)
 *   "groupIds": ["120363xxx@g.us"],   // Optional — WhatsApp group(s) to send image to
 *   "groupId": "120363xxx@g.us",      // Optional — fallback single group ID
 *   "dryRun": false,                  // Optional — if true, returns computed data without writing
 *   "overwrite": true                 // Optional — if false, skip if sheet already exists
 * }
 */

const { loadData } = require("../utils/action");
const { duplicateSheet, batchUpdateRanges, sheetExists, exportSheetAsPdf, getAuth } = require("../utils/gsheet");
const { sheets: createSheets } = require("@googleapis/sheets");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const { classifyRoles } = require("../utils/role-classifier");
const { getSupabaseClient } = require("../utils/common");
const { getWHStaffTSNTS } = require("../utils/wh-staff-tracker");
const { getWHWorkerBreakdown } = require("../utils/wh-worker-breakdown-tracker");
const { getWHEngineerOnSite } = require("../utils/wh-engineering-tracker");
const { sendWhatsAppImage } = require("../utils/sendMessage");
const { getSpreadsheetConfig } = require("../config/group-config");

/**
 * Delete a sheet tab by name. Used for overwrite: delete then re-clone from template.
 * @param {string} spreadsheetId
 * @param {string} sheetName
 */
async function deleteSheetByName(spreadsheetId, sheetName) {
  const sheetsApi = createSheets({ version: "v4", auth: getAuth() });
  const resp = await sheetsApi.spreadsheets.get({ spreadsheetId });
  const sheet = resp.data.sheets.find((s) => s.properties.title === sheetName);
  if (!sheet) return;
  await sheetsApi.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{ deleteSheet: { sheetId: sheet.properties.sheetId } }],
    },
  });
  console.log(`📋 [MANPOWER DATA] Deleted sheet "${sheetName}"`);
}

/**
 * Auto-resize specific columns to fit content.
 * @param {string} spreadsheetId
 * @param {string} sheetName
 * @param {number[]} columnIndices - 0-based column indices to resize (e.g., [0, 6, 12] for A, G, M)
 */
async function autoResizeColumns(spreadsheetId, sheetName, columnIndices) {
  const sheetsApi = createSheets({ version: "v4", auth: getAuth() });
  const resp = await sheetsApi.spreadsheets.get({ spreadsheetId });
  const sheet = resp.data.sheets.find((s) => s.properties.title === sheetName);
  if (!sheet) return;
  const sheetId = sheet.properties.sheetId;

  const requests = columnIndices.map((col) => ({
    autoResizeDimensions: {
      dimensions: {
        sheetId,
        dimension: "COLUMNS",
        startIndex: col,
        endIndex: col + 1,
      },
    },
  }));

  await sheetsApi.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Section A: Date Helpers
// ─────────────────────────────────────────────────────────────────────────────

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_NAMES = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];

/**
 * Get today's date in DD-MMM-YYYY format using Singapore timezone
 * @returns {string} e.g. "09-Apr-2026"
 */
function getTodaySGT() {
  const now = new Date();
  const sg = { timeZone: "Asia/Singapore" };
  const day = now.toLocaleDateString("en-GB", { ...sg, day: "2-digit" });
  const month = now.toLocaleDateString("en-GB", { ...sg, month: "short" });
  const year = now.toLocaleDateString("en-GB", { ...sg, year: "numeric" });
  return `${day}-${month}-${year}`;
}

/**
 * Parse and validate date parameter in DD-MMM-YYYY format
 * @param {string} dateParam - Date string like "09-Apr-2026"
 * @returns {string} Validated DD-MMM-YYYY string
 */
function parseDate(dateParam) {
  if (!dateParam) return getTodaySGT();
  const match = dateParam.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!match) throw new Error(`Invalid date format: "${dateParam}". Expected DD-MMM-YYYY (e.g., "09-Apr-2026")`);
  const [, day, monthStr, year] = match;
  const monthCap = monthStr.charAt(0).toUpperCase() + monthStr.slice(1).toLowerCase();
  if (!MONTHS.includes(monthCap)) {
    throw new Error(`Invalid month: "${monthStr}". Use 3-letter abbreviation (Jan, Feb, ...)`);
  }
  return `${day.padStart(2, "0")}-${monthCap}-${year}`;
}

/**
 * Convert DD-MMM-YYYY to YYYY-MM-DD (ISO) for matching against the Date column.
 * @param {string} ddMmmYyyy - e.g. "09-Apr-2026"
 * @returns {string} e.g. "2026-04-09"
 */
function toIsoDate(ddMmmYyyy) {
  const match = ddMmmYyyy.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!match) return ddMmmYyyy;
  const [, day, monthStr, year] = match;
  const monthIndex = MONTHS.indexOf(monthStr.charAt(0).toUpperCase() + monthStr.slice(1).toLowerCase());
  if (monthIndex === -1) return ddMmmYyyy;
  return `${year}-${String(monthIndex + 1).padStart(2, "0")}-${day.padStart(2, "0")}`;
}

/**
 * Format sheet tab name: "9-Apr-2026" (no leading zero on day)
 * @param {string} ddMmmYyyy - e.g. "09-Apr-2026"
 * @returns {string} e.g. "9-Apr-2026"
 */
function formatSheetTabName(ddMmmYyyy) {
  const match = ddMmmYyyy.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!match) return ddMmmYyyy;
  const [, day, month, year] = match;
  return `${parseInt(day, 10)}-${month}-${year}`;
}

/**
 * Get day of week name from DD-MMM-YYYY
 * @param {string} ddMmmYyyy - e.g. "09-Apr-2026"
 * @returns {string} e.g. "THURSDAY"
 */
function getDayOfWeek(ddMmmYyyy) {
  const match = ddMmmYyyy.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!match) return "";
  const [, day, monthStr, year] = match;
  const monthCap = monthStr.charAt(0).toUpperCase() + monthStr.slice(1).toLowerCase();
  const monthIndex = MONTHS.indexOf(monthCap);
  if (monthIndex === -1) return "";
  const date = new Date(parseInt(year), monthIndex, parseInt(day));
  return DAY_NAMES[date.getDay()];
}

/**
 * Format date as DD/MM/YYYY for the sheet header
 * @param {string} ddMmmYyyy - e.g. "09-Apr-2026"
 * @returns {string} e.g. "09/04/2026"
 */
function formatDateSlash(ddMmmYyyy) {
  const match = ddMmmYyyy.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!match) return ddMmmYyyy;
  const [, day, monthStr, year] = match;
  const monthCap = monthStr.charAt(0).toUpperCase() + monthStr.slice(1).toLowerCase();
  const monthIndex = MONTHS.indexOf(monthCap);
  if (monthIndex === -1) return ddMmmYyyy;
  return `${day.padStart(2, "0")}/${String(monthIndex + 1).padStart(2, "0")}/${year}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Section B: Company Fuzzy Matching
// ─────────────────────────────────────────────────────────────────────────────

const SIMILARITY_THRESHOLD = 0.85;

/**
 * Levenshtein-based similarity ratio between two strings (0 to 1)
 */
function similarity(a, b) {
  const al = a.toLowerCase().trim();
  const bl = b.toLowerCase().trim();
  if (al === bl) return 1;
  const lenA = al.length;
  const lenB = bl.length;
  if (lenA === 0 || lenB === 0) return 0;
  let prev = Array.from({ length: lenB + 1 }, (_, i) => i);
  let curr = new Array(lenB + 1);
  for (let i = 1; i <= lenA; i++) {
    curr[0] = i;
    for (let j = 1; j <= lenB; j++) {
      const cost = al[i - 1] === bl[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return 1 - prev[lenB] / Math.max(lenA, lenB);
}

/**
 * Find canonical company name from existing keys, or return the raw name
 */
function resolveCompanyName(name, map) {
  for (const existing of map.keys()) {
    if (similarity(name, existing) >= SIMILARITY_THRESHOLD) {
      return existing;
    }
  }
  return name;
}

// ─────────────────────────────────────────────────────────────────────────────
// Section C: WHPL (Woh Hup) Detection
// ─────────────────────────────────────────────────────────────────────────────

const WHPL_KEYWORDS = ["woh hup", "whpl", "woh-hup", "wohhup", "woh_hup", "won hup"];

function isWohHup(companyName) {
  const lower = (companyName || "").toLowerCase().replace(/\s+/g, " ").trim();
  return WHPL_KEYWORDS.some((kw) => lower.includes(kw));
}

// ─────────────────────────────────────────────────────────────────────────────
// Section D: LLM Role Classifier (imported from utils/role-classifier.js)
// ─────────────────────────────────────────────────────────────────────────────

// classifyRoles is imported at the top from ../utils/role-classifier

// Placeholder to preserve the section marker — the old inline function was moved
// to utils/role-classifier.js for shared use by both manpower data API and QA agent.
void classifyRoles; // reference to suppress unused warning if any

// ─────────────────────────────────────────────────────────────────────────────
// Section E: Data Aggregation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Aggregate manpower rows into structured company data.
 *
 * @param {object[]} rows - manpower row objects with Company, Details, Total, Shift
 * @param {Record<string, "SUPERVISOR"|"WORKER">} roleMap - role classification
 * @returns {{ whpl: { workerNTS: number, staffNTS: number, engineerNTS: number }, subcons: Array<{ company: string, supervisorNTS: number, workerNTS: number, total: number }> }}
 */
function aggregateManpower(rows, roleMap, whRoleMap = null) {
  const whpl = { workerNTS: 0, staffNTS: 0, engineerNTS: 0 };
  const subconMap = new Map(); // canonical name → { supervisorNTS, workerNTS }

  for (const row of rows) {
    const rawCompany = row.Company || row.company || "Unknown";
    const total = parseInt(row.Total || row.total || row.TotalWorkers || row.totalWorkers || 0, 10) || 0;

    // Parse Details JSON
    let details = {};
    try {
      const detailsStr = row.Details || row.details || "{}";
      details = typeof detailsStr === "string" ? JSON.parse(detailsStr) : detailsStr;
    } catch {
      // Malformed JSON — treat entire row as WORKER with Total count
    }

    const isWh = isWohHup(rawCompany);

    if (isWh) {
      // Wohhup family rows are NEVER aggregated from the sheet — Engineer /
      // Staff / Worker totals come exclusively from whatsapp_listener trackers
      // (getWHEngineerOnSite / getWHStaffTSNTS / getWHWorkerBreakdown),
      // applied by the handler after this loop. Skip the row entirely.
      continue;
    } else {
      // Sub-contractor — two independent tasks per row, with NO interaction:
      //
      //   TASK 1: TOTAL  — taken directly from the sheet's [Total] column.
      //                    This is the authoritative headcount and is what
      //                    rolls up into grandTotal / totalSubCon.
      //
      //   TASK 2: SPLIT  — taken from the [Details] JSON's per-role counts,
      //                    classified into SUPERVISOR vs WORKER via roleMap.
      //                    Used ONLY for the per-subcon visual breakdown on
      //                    the daily image (template's Supervisor / Worker
      //                    cells). Never compared to or reconciled against
      //                    the row's Total — they are independent measures.
      //
      // If Details is empty, the split has no signal — supervisor=0, worker=0.
      // (The total row in the image still shows row.Total via the explicit
      // total-cell override in buildSheetUpdates.)
      let supervisorCount = 0;
      let workerCount = 0;
      const detailKeys = Object.keys(details);
      if (detailKeys.length > 0) {
        for (const [role, count] of Object.entries(details)) {
          const numCount = parseInt(count, 10) || 0;
          const category = roleMap[role] || "WORKER";
          if (category === "SUPERVISOR") supervisorCount += numCount;
          else workerCount += numCount;
        }
      }

      const canonical = resolveCompanyName(rawCompany, subconMap);
      if (!subconMap.has(canonical)) {
        subconMap.set(canonical, { supervisorNTS: 0, workerNTS: 0, total: 0 });
      }
      const entry = subconMap.get(canonical);
      entry.supervisorNTS += supervisorCount;
      entry.workerNTS += workerCount;
      entry.total += total; // row.Total — independent of Details
    }
  }

  // Convert to sorted array (highest total first)
  const subcons = [...subconMap.entries()]
    .map(([company, data]) => ({
      company,
      supervisorNTS: data.supervisorNTS,
      workerNTS: data.workerNTS,
      total: data.total, // from row.Total only, never derived from supervisor+worker
    }))
    .sort((a, b) => b.total - a.total);

  return { whpl, subcons };
}

// ─────────────────────────────────────────────────────────────────────────────
// Section F: Sheet Layout Writer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Column letter mapping for each visual column
 */
const COL_MAP = {
  1: { label: "A", ts: "B", nts: "C", prc: "D", total: "E" },
  2: { label: "G", ts: "H", nts: "I", prc: "J", total: "K" },
  3: { label: "M", ts: "N", nts: "O", prc: "P", total: "Q" },
};

/**
 * Sub-contractor block start rows for each visual column.
 * Column 3 first slot (rows 8-11) is reserved for WH ENGINEERING — subcons start at row 13.
 */
// Col 1 has ONLY 9 subcon slots — row 63 is a register-style overflow block
//   in the template (H/LEAVE / ABSENT / COURSE / MEDICAL LEAVE / LOAN OUT /
//   LOAN IN labels), NOT a regular Sup/Worker/Total slot. Including row 63
//   here previously caused the 10th subcon to be written with mismatched cell
//   semantics AND its total cell (E66) is OUTSIDE the TOTAL SUB CON formula at
//   O5 (which references E21..E61), so its headcount silently vanished from
//   the grand total — verified 2026-05-14: A&B Scaffold 5 pax lost.
const SUBCON_START_ROWS = {
  1: [18, 23, 28, 33, 38, 43, 48, 53, 58],
  2: [13, 18, 23, 28, 33, 38, 43, 48, 53, 58],
  3: [13, 18, 23, 28, 33, 38, 43, 48, 53],
};

/**
 * Assign sub-contractors to visual column slots
 * @param {Array} subcons - sorted array of { company, supervisorNTS, workerNTS, total }
 * @returns {Array<{ company, data, visualCol, startRow }>}
 */
function assignSubconSlots(subcons) {
  const slots = [];
  let colIdx = 1;
  let slotIdx = 0;

  for (const subcon of subcons) {
    // Move to next column if current is full
    while (colIdx <= 3 && slotIdx >= SUBCON_START_ROWS[colIdx].length) {
      colIdx++;
      slotIdx = 0;
    }
    if (colIdx > 3) {
      console.warn(`📋 [MANPOWER DATA] Overflow: cannot fit company "${subcon.company}" — all columns full`);
      break;
    }
    slots.push({
      company: subcon.company,
      data: subcon,
      visualCol: colIdx,
      startRow: SUBCON_START_ROWS[colIdx][slotIdx],
    });
    slotIdx++;
  }
  return slots;
}

/**
 * Build the batchUpdateRanges data for the target sheet.
 *
 * @param {string} sheetName - cloned sheet tab name e.g. "9-Apr-2026"
 * @param {string} dateStr - DD-MMM-YYYY e.g. "09-Apr-2026"
 * @param {{ whpl, subcons }} aggregated - result of aggregateManpower()
 * @returns {{ updates: Array<{range: string, values: Array}>, stats: object }}
 */
function buildSheetUpdates(sheetName, dateStr, aggregated) {
  const { whpl, subcons } = aggregated;
  // Sheet names with special characters need single quotes in range notation
  const sn = `'${sheetName}'`;
  const updates = [];

  // Helper to add a cell update
  const addCell = (cell, value) => updates.push({ range: `${sn}!${cell}`, values: [[value]] });

  // ── Header area ──
  addCell("A4", `DAY: ${getDayOfWeek(dateStr)}`);
  addCell("A5", `DATE: ${formatDateSlash(dateStr)}`);
  addCell("A6", "DONE BY : JOEY");

  // ── WHPL WORKER section (Col 1, rows 8-16) ──
  // Template layout:
  //   Row 8: WHPL header (TS|NTS|PRC|TOTAL columns)
  //   Row 9: TOTAL REGISTER  (C9 = NTS count)
  //   Row 10: HOME LEAVE
  //   Row 11: COURSE
  //   Row 12: MEDICAL LEAVE
  //   Row 13: ON LOAN (IN)
  //   Row 14: ON LOAN (OUT)
  //   Row 15: ABSENT
  //   Row 16: TOTAL ON SITE  (E16 formula = C9-C10-C11-C12+C13-C14-C15)
  addCell("A8", "WHPL WORKER");
  if (whpl.workerBreakdown) {
    // Full WHPL register breakdown is available (from wh-worker-breakdown-tracker).
    // Populate C9-C15 so E16 formula computes ON SITE correctly.
    const wb = whpl.workerBreakdown;
    addCell("C9", wb.totalRegister); // TOTAL REGISTER
    addCell("C10", wb.homeLeave);
    addCell("C11", wb.course);
    addCell("C12", wb.medicalLeave);
    addCell("C13", wb.loanIn);
    addCell("C14", wb.loanOut);
    addCell("C15", wb.absent);
    // E16 formula (=C9-C10-C11-C12+C13-C14-C15) is from the template — don't overwrite
  } else {
    // No breakdown message available — fallback to legacy behavior (C9 = on-site worker count
    // from manpower sheet rows). E16 formula resolves to the same value because rows 10-15 are 0.
    addCell("C9", whpl.workerNTS);
  }

  // ── WHPL STAFF section (Col 2, rows 8-11) ──
  addCell("G8", "WHPL STAFF");
  addCell("G9", "SITE"); // Overwrite template's "SUPERVISOR" label
  if (whpl.staffTS && whpl.staffTS > 0) {
    addCell("H9", whpl.staffTS); // TS column, SITE row
  }
  addCell("I9", whpl.staffNTS); // NTS column, SITE row
  // K11 formula (=I9+I10+H9+H10) is from the template — don't overwrite

  // ── WH ENGINEERING section (Col 3, rows 8-11) ──
  // The template's first col-3 slot is normally a sub-contractor block (SUPERVISOR/WORKER/TOTAL).
  // We overwrite it to a WHPL-STAFF-style block: SITE/OFFICE/TOTAL with TS+NTS columns,
  // then overwrite Q11 to a WHPL-STAFF-style sum formula (=O9+O10+N9+N10).
  addCell("M8", "WH ENGINEERING");
  addCell("M9", "SITE"); // Overwrite template's "SUPERVISOR" label
  addCell("M10", "OFFICE"); // Overwrite template's "WORKER" label
  addCell("M11", "TOTAL"); // Idempotent — TOTAL label may already be in template
  addCell("O9", whpl.engineerNTS || 0); // NTS column, SITE row
  addCell("Q11", "=O9+O10+N9+N10"); // Overwrite subcon's =O9+O10 formula with WHPL-STAFF-style

  // ── Sub-contractor blocks ──
  // Template already has SUPERVISOR/WORKER/TOTAL labels and TOTAL formulas
  // in every block. We only write: company name + supervisor NTS + worker NTS.
  const slots = assignSubconSlots(subcons);
  let totalSubCon = 0;

  for (const slot of slots) {
    const cols = COL_MAP[slot.visualCol];
    const r = slot.startRow;

    // Company name header (overwrite template placeholder)
    addCell(`${cols.label}${r}`, slot.data.company.toUpperCase());

    // Supervisor count (NTS column, row+1 where template has "SUPERVISOR" label).
    // Derived from Details JSON — display only, never reconciled against Total.
    addCell(`${cols.nts}${r + 1}`, slot.data.supervisorNTS);

    // Worker count (NTS column, row+2 where template has "WORKER" label).
    // Derived from Details JSON — display only, never reconciled against Total.
    addCell(`${cols.nts}${r + 2}`, slot.data.workerNTS);

    // TOTAL row (row+3) — OVERRIDE the template's `=Sup+Wkr` formula with the
    // explicit row.Total value. Supervisor + Worker (display) and Total are now
    // independent measures: total comes from the sheet's Total column directly
    // and is what rolls up into totalSubCon. (User's "never compare Details to
    // Total" rule.)
    addCell(`${cols.total}${r + 3}`, slot.data.total);

    totalSubCon += slot.data.total;
  }

  // ── Summary totals (O4:Q4, O5:Q5, O6:Q6 — merged cells, anchor at O) ──
  // Override template formulas so TOTAL WHPL = WHPL WORKER + WHPL STAFF + WH ENGINEERING
  // and TOTAL SUB CON excludes K11 (WHPL STAFF) and Q11 (WH ENGINEERING) to avoid double-counting.
  addCell("O4", "=E16+K11+Q11"); // TOTAL WHPL ON SITE = WHPL WORKER + WHPL STAFF + WH ENGINEERING
  addCell(
    "O5",
    "=E21+E26+E31+E36+E41+E46+E51+E56+E61+K16+K21+K26+K31+K36+K41+K46+K51+K56+K61+Q16+Q21+Q26+Q31+Q36+Q41+Q46+Q51+Q56+Q61",
  ); // TOTAL SUB CON ON SITE (K11 removed — WHPL STAFF; Q11 removed — WH ENGINEERING)
  // O6 template formula =O4+O5 is correct — don't overwrite

  // On-site worker count — trust the message's stated value when present.
  // Earlier this code blindly derived via the register formula
  // (totalRegister - homeLeave - course - medicalLeave + loanIn - loanOut - absent),
  // which renders deeply negative when the parser misses the register label
  // (e.g. message says "WH Register: 34" instead of "Total Register: 34" → register=0
  //  → 0 - 2 - 17 - 10 = -29 displayed to customer; verified 2026-05-10).
  //
  // Resolution order (matches the message-totals-as-source-of-truth plan):
  //   1. Use parser's `workersOnSite` if it captured a value from the message.
  //   2. Else derive via the register formula — but only if `totalRegister > 0`
  //      (a 0 register means the parser missed the label, not that nobody is on site).
  //   3. Else fall back to whpl.workerNTS (legacy aggregate from sheet).
  // Sanity guard: any branch that produces a negative number is clamped to 0
  // and logged — better to under-report than to display nonsense.
  let workerOnSite;
  if (
    whpl.workerBreakdown &&
    Number.isFinite(whpl.workerBreakdown.workersOnSite) &&
    whpl.workerBreakdown.workersOnSite > 0
  ) {
    workerOnSite = whpl.workerBreakdown.workersOnSite;
  } else if (whpl.workerBreakdown && whpl.workerBreakdown.totalRegister > 0) {
    workerOnSite =
      whpl.workerBreakdown.totalRegister -
      whpl.workerBreakdown.homeLeave -
      whpl.workerBreakdown.course -
      whpl.workerBreakdown.medicalLeave +
      whpl.workerBreakdown.loanIn -
      whpl.workerBreakdown.loanOut -
      whpl.workerBreakdown.absent;
  } else {
    workerOnSite = whpl.workerNTS;
  }
  if (workerOnSite < 0) {
    console.warn(
      `[MANPOWER DATA] Negative WHPL workerOnSite (${workerOnSite}) — likely parser miss on register/on-site label. Clamping to 0. Breakdown=${JSON.stringify(whpl.workerBreakdown || null)}`,
    );
    workerOnSite = 0;
  }
  const totalWHPL = workerOnSite + whpl.staffNTS + (whpl.staffTS || 0) + (whpl.engineerNTS || 0);

  // Display the message-STATED on-site count directly — overrides the template's
  // E16 register formula (=C9-C10-C11-C12+C13-C14-C15). This guarantees the
  // image's WHPL WORKER "TOTAL ON SITE" equals the exact value the summary
  // message, /wh-manpower-totals endpoint and daily report all use (read from
  // the WhatsApp message, incl. the inline "Night Shift" crew), so the image can
  // never self-calculate a divergent number. C9-C15 remain as a display-only
  // register breakdown.
  addCell("E16", workerOnSite);

  // Compute the last row with data (for PDF export range)
  // WHPL WORKER always ends at row 16. Sub-con blocks end at startRow+3 (TOTAL row).
  let lastDataRow = 16; // minimum: WHPL WORKER section
  for (const slot of slots) {
    const totalRow = slot.startRow + 3;
    if (totalRow > lastDataRow) lastDataRow = totalRow;
  }

  const stats = {
    totalWHPL,
    totalSubCon,
    grandTotal: totalWHPL + totalSubCon,
    whplWorkerNTS: whpl.workerNTS,
    whplStaffTS: whpl.staffTS || 0,
    whplStaffNTS: whpl.staffNTS,
    whplEngineerNTS: whpl.engineerNTS || 0,
    subconCount: subcons.length,
    subconsFitted: slots.length,
    subconsOverflow: subcons.length - slots.length,
    lastDataRow,
  };

  return { updates, stats };
}

// ─────────────────────────────────────────────────────────────────────────────
// Section G: Main Handler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Process daily manpower data report request
 * @param {object} event - Lambda event
 * @param {object} res - Response helper { status(code).json(body) }
 */
async function processDailyManpowerDataRequest(event, res) {
  try {
    let body = {};
    try {
      if (event.body) body = JSON.parse(event.body);
    } catch (e) {
      console.warn("Failed to parse request body:", e.message);
    }

    const { date: dateParam, groupIds, groupId, dryRun = false, overwrite = true } = body;

    // Resolve recipient list: groupIds (array) > groupId (string)
    const recipientIds =
      groupIds && Array.isArray(groupIds) && groupIds.length > 0 ? groupIds : groupId ? [groupId] : [];

    console.log("📋 [MANPOWER DATA] Request:", { date: dateParam, dryRun, overwrite, recipients: recipientIds.length });

    // Resolve spreadsheet ID
    const manpowerDataConfig = getSpreadsheetConfig("manpowerDataReport");
    const targetSpreadsheetId = manpowerDataConfig?.spreadsheetId || process.env.MANPOWER_DATA_SPREADSHEET_ID;

    if (!targetSpreadsheetId) {
      return res.status(400).json({
        success: false,
        error: "Missing MANPOWER_DATA_SPREADSHEET_ID environment variable",
      });
    }

    const templateSheetName = manpowerDataConfig?.templateSheetName || "MBS";

    // Parse and validate date
    const searchDate = parseDate(dateParam);
    const searchDateIso = toIsoDate(searchDate);
    console.log(`📋 [MANPOWER DATA] Search date: ${searchDate} (ISO: ${searchDateIso})`);

    // Load manpower data from source sheet
    const manpowerConfig = getSpreadsheetConfig("manpower");
    const sourceSpreadsheetId = manpowerConfig?.spreadsheetId || process.env.MANPOWER_SPREADSHEET_ID;

    if (!sourceSpreadsheetId) {
      return res.status(400).json({
        success: false,
        error: "Missing MANPOWER_SPREADSHEET_ID environment variable",
      });
    }

    console.log(`📋 [MANPOWER DATA] Loading Manpower sheet from ${sourceSpreadsheetId}`);
    const rawData = await loadData("Manpower", { spreadsheetId: sourceSpreadsheetId });

    if (!rawData || rawData.length <= 1) {
      console.log("📋 [MANPOWER DATA] No manpower data found in sheet");
      return res.status(200).json({
        success: true,
        skipped: true,
        reason: "no_data",
        date: searchDate,
      });
    }

    // Map rows to objects and filter by date
    const headers = rawData[0];
    const rows = rawData.slice(1);
    const manpowerRows = rows
      .map((row) => {
        const obj = {};
        headers.forEach((h, i) => {
          obj[h] = row[i];
        });
        return obj;
      })
      .filter((row) => {
        const rowDate = String(row.Date || "").trim();
        return rowDate === searchDateIso;
      });

    console.log(`📋 [MANPOWER DATA] Found ${manpowerRows.length} manpower records for ${searchDate}`);

    if (manpowerRows.length === 0) {
      return res.status(200).json({
        success: true,
        skipped: true,
        reason: "no_data",
        date: searchDate,
      });
    }

    // Collect unique role keys split by company type (Woh Hup vs normal)
    const whRoleSet = new Set();
    const normalRoleSet = new Set();
    for (const row of manpowerRows) {
      try {
        const detailsStr = row.Details || row.details || "{}";
        const details = typeof detailsStr === "string" ? JSON.parse(detailsStr) : detailsStr;
        const company = row.Company || row.company || "";
        const targetSet = isWohHup(company) ? whRoleSet : normalRoleSet;
        for (const role of Object.keys(details)) {
          targetSet.add(role);
        }
      } catch {
        // Skip malformed JSON
      }
    }
    const whRoles = [...whRoleSet];
    const normalRoles = [...normalRoleSet];
    console.log(`📋 [MANPOWER DATA] WH roles (${whRoles.length}): ${whRoles.join(", ")}`);
    console.log(`📋 [MANPOWER DATA] Normal roles (${normalRoles.length}): ${normalRoles.join(", ")}`);

    // Classify roles via LLM — separate prompts for each company type
    const [normalRoleMap, whRoleMap] = await Promise.all([
      normalRoles.length > 0 ? classifyRoles(normalRoles, "normal") : {},
      whRoles.length > 0 ? classifyRoles(whRoles, "wohhup") : {},
    ]);
    // Merge for backward-compatible response (normal takes precedence for shared roles)
    const roleMap = { ...whRoleMap, ...normalRoleMap };
    console.log("📋 [MANPOWER DATA] Normal classifications:", JSON.stringify(normalRoleMap));
    console.log("📋 [MANPOWER DATA] WH classifications:", JSON.stringify(whRoleMap));

    // Aggregate data by company — pass both role maps so each row uses the right one
    const aggregated = aggregateManpower(manpowerRows, normalRoleMap, whRoleMap);
    console.log(
      `📋 [MANPOWER DATA] Aggregated: WHPL workers=${aggregated.whpl.workerNTS}, staff=${aggregated.whpl.staffNTS}, engineers=${aggregated.whpl.engineerNTS}, subcons=${aggregated.subcons.length}`,
    );

    // Pull WH Worker breakdown (TOTAL REGISTER / HOME LEAVE / LOAN OUT / etc.) if a
    // "WH Workers Manpower" compact-format message was posted today. This populates
    // the WHPL register block (rows 9-15) so E16 displays ON SITE correctly.
    const whWorkerBreakdown = await getWHWorkerBreakdown(searchDate);
    if (whWorkerBreakdown) {
      console.log(
        `📋 [MANPOWER DATA] WH Worker breakdown: register=${whWorkerBreakdown.totalRegister}, ` +
          `onSite=${whWorkerBreakdown.workersOnSite}, homeLeave=${whWorkerBreakdown.homeLeave}, ` +
          `loanOut=${whWorkerBreakdown.loanOut}`,
      );
      aggregated.whpl.workerBreakdown = whWorkerBreakdown;
    }

    // Override WH engineer count with the WH Engineering message tracker (same
    // pattern as Staff/Worker — message is canonical, sheet aggregation is the
    // fallback). Keeps the daily image, summary, endpoint, and QA all in lockstep.
    try {
      const whEngineer = await getWHEngineerOnSite(searchDate);
      if (whEngineer && Number.isFinite(whEngineer.onSite)) {
        console.log(
          `📋 [MANPOWER DATA] WH Engineering tracker override: onSite=${whEngineer.onSite} (was computed engineerNTS=${aggregated.whpl.engineerNTS})`,
        );
        aggregated.whpl.engineerNTS = whEngineer.onSite;
      }
    } catch (e) {
      console.warn("[MANPOWER DATA] WH engineer tracker fetch failed:", e?.message || e);
    }

    // Override WH staff with TS/NTS values from short message if available.
    // The short message provides ONLY the TS/NTS split — real worker/staff counts
    // come from the manpower sheet (role classification).
    const whStaffShort = await getWHStaffTSNTS(searchDate);
    if (whStaffShort) {
      console.log(
        `📋 [MANPOWER DATA] WH Staff short message override: TS=${whStaffShort.staffTS}, NTS=${whStaffShort.staffNTS} (was computed staff=${aggregated.whpl.staffNTS})`,
      );
      aggregated.whpl.staffTS = whStaffShort.staffTS;
      aggregated.whpl.staffNTS = whStaffShort.staffNTS;
    } else {
      // Fallback: keep computed staffNTS, no TS data
      aggregated.whpl.staffTS = 0;
    }

    // Compute sheet tab name
    const sheetTabName = formatSheetTabName(searchDate);
    console.log(`📋 [MANPOWER DATA] Target sheet: "${sheetTabName}" in ${targetSpreadsheetId}`);

    // Build sheet updates
    const { updates, stats } = buildSheetUpdates(sheetTabName, searchDate, aggregated);

    // Normalize subcons for response
    const subconsResponse = aggregated.subcons.map((s) => ({
      company: s.company,
      supervisor: s.supervisorNTS,
      worker: s.workerNTS,
      total: s.total,
    }));

    if (dryRun) {
      console.log("📋 [MANPOWER DATA] Dry run — returning computed data without writing");
      return res.status(200).json({
        success: true,
        dryRun: true,
        date: searchDate,
        sheetName: sheetTabName,
        totalRecords: manpowerRows.length,
        stats,
        roleClassifications: roleMap,
        subcons: subconsResponse,
        updateCount: updates.length,
        updates,
      });
    }

    // Check if sheet already exists
    const exists = await sheetExists(targetSpreadsheetId, sheetTabName);

    if (exists && !overwrite) {
      console.log(`📋 [MANPOWER DATA] Sheet "${sheetTabName}" already exists and overwrite=false, skipping`);
      return res.status(200).json({
        success: true,
        skipped: true,
        reason: "sheet_exists",
        sheetName: sheetTabName,
      });
    }

    if (exists) {
      // Delete existing sheet and re-clone from template
      // (clearSheet would destroy template formulas and labels)
      console.log(`📋 [MANPOWER DATA] Sheet "${sheetTabName}" exists, deleting for overwrite`);
      await deleteSheetByName(targetSpreadsheetId, sheetTabName);
    }

    // Clone MBS template to new sheet (always fresh clone with all formulas/formatting)
    console.log(`📋 [MANPOWER DATA] Cloning template "${templateSheetName}" to "${sheetTabName}"`);
    await duplicateSheet(targetSpreadsheetId, templateSheetName, sheetTabName, false);

    // Write all data in a single batch
    console.log(`📋 [MANPOWER DATA] Writing ${updates.length} cell updates to "${sheetTabName}"`);
    await batchUpdateRanges(targetSpreadsheetId, updates, "USER_ENTERED");

    // Auto-resize company name columns (A, G, M) to fit long names like "LT_SAMBO (TAEHWA )"
    await autoResizeColumns(targetSpreadsheetId, sheetTabName, [0, 6, 12]);

    console.log(`📋 [MANPOWER DATA] ✅ Successfully wrote manpower data report for ${searchDate}`);

    // ── PDF → Image → WhatsApp flow (if groupIds provided) ──
    let imageUrl = null;
    const sendResults = [];

    if (recipientIds.length > 0) {
      try {
        // Step 1: Export sheet as PDF
        console.log(`📋 [MANPOWER DATA] Exporting sheet "${sheetTabName}" as PDF`);
        const pdfBuffer = await exportSheetAsPdf(targetSpreadsheetId, sheetTabName);
        console.log(`📋 [MANPOWER DATA] PDF exported (${pdfBuffer.length} bytes)`);

        // Step 2: Upload PDF to Supabase storage
        const supabase = getSupabaseClient();
        const bucketName = "manpower-data-pdfs";
        const pdfFileName = `manpower-${sheetTabName}-${uuidv4()}.pdf`;

        const { error: uploadError } = await supabase.storage
          .from(bucketName)
          .upload(pdfFileName, pdfBuffer, { contentType: "application/pdf", upsert: false });

        if (uploadError) throw new Error(`PDF upload failed: ${uploadError.message}`);

        const { data: signedUrlData, error: signedUrlError } = await supabase.storage
          .from(bucketName)
          .createSignedUrl(pdfFileName, 3600);

        if (signedUrlError) throw new Error(`Signed URL failed: ${signedUrlError.message}`);

        const pdfUrl = signedUrlData.signedUrl;
        console.log(`📋 [MANPOWER DATA] PDF uploaded to Supabase: ${pdfFileName}`);

        // Step 3: Convert PDF to image via supabase_node API
        const supabaseNodeUrl = "https://api.scrape.wentilabs.com";

        console.log(`📋 [MANPOWER DATA] Converting PDF to image via ${supabaseNodeUrl}/api/pdf-to-image`);
        const convertResponse = await axios.post(
          `${supabaseNodeUrl}/api/pdf-to-image`,
          { pdfUrl, page: 1, dpi: 200 },
          { timeout: 60000 },
        );

        if (!convertResponse.data?.success || !convertResponse.data?.imageUrl) {
          throw new Error(`PDF to image conversion failed: ${JSON.stringify(convertResponse.data)}`);
        }

        imageUrl = convertResponse.data.imageUrl;
        console.log(`📋 [MANPOWER DATA] Image generated: ${imageUrl}`);

        // Step 4: Send image to WhatsApp groups
        const caption = `📊 Manpower Data Report — ${sheetTabName}`;
        for (const gid of recipientIds) {
          try {
            console.log(`📋 [MANPOWER DATA] Sending image to ${gid}`);
            await sendWhatsAppImage(gid, imageUrl, caption);
            sendResults.push({ groupId: gid, sent: true });
            console.log(`📋 [MANPOWER DATA] ✅ Image sent to ${gid}`);
          } catch (sendErr) {
            console.error(`📋 [MANPOWER DATA] ❌ Failed to send image to ${gid}:`, sendErr.message);
            sendResults.push({ groupId: gid, sent: false, error: sendErr.message });
          }
        }
      } catch (imageError) {
        console.error("📋 [MANPOWER DATA] Image flow failed:", imageError.message);
        sendResults.push({ error: imageError.message });
      }
    }

    return res.status(200).json({
      success: true,
      date: searchDate,
      sheetName: sheetTabName,
      totalRecords: manpowerRows.length,
      stats,
      roleClassifications: roleMap,
      subcons: subconsResponse,
      imageUrl,
      sent: sendResults.some((r) => r.sent),
      sendResults,
    });
  } catch (error) {
    console.error("📋 [MANPOWER DATA] Error:", error);
    return res.status(500).json({
      success: false,
      error: error.message,
      message: "Failed to process daily manpower data request",
    });
  }
}

module.exports = processDailyManpowerDataRequest;
// Re-exports — the daily-site-activity-report endpoint mirrors this aggregation
//   so both daily reports show identical manpower numbers for the same date.
module.exports.aggregateManpower = aggregateManpower;
module.exports.isWohHup = isWohHup;
module.exports.similarity = similarity;
module.exports.resolveCompanyName = resolveCompanyName;
