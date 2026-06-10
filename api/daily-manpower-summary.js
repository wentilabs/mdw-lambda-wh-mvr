/**
 * Daily Manpower Summary API endpoint
 *
 * Generates and sends a professional daily manpower summary message
 * to a specified WhatsApp group, showing total headcount, per-company
 * breakdown, activities, and machinery deployed.
 *
 * POST /daily-manpower-summary
 * {
 *   "date": "26-Mar-2026",           // Optional, DD-MMM-YYYY. Defaults to today (SG timezone)
 *   "groupIds": ["120363xxx@g.us"],   // Required — WhatsApp group(s) to send the summary to
 *   "groupId": "120363xxx@g.us",      // Fallback — single group ID
 *   "dryRun": false                  // Optional — if true, returns message without sending
 * }
 */

const { loadData } = require("../utils/action");
const { sendWhatsAppMessage } = require("../utils/sendMessage");
const { getGroupConfiguration, getSpreadsheetConfig } = require("../config/group-config");
const { getWHStaffTSNTS } = require("../utils/wh-staff-tracker");
const { getWHWorkerBreakdown } = require("../utils/wh-worker-breakdown-tracker");
const { getWHEngineerOnSite } = require("../utils/wh-engineering-tracker");

// Wohhup is the main contractor; WHPL is its worker-only sub-team. Both belong
// to the same parent. In the summary they merge into one canonical "Wohhup"
// row; row Totals are summed from the sheet, classified by Details JSON into
// Engineer / Staff / Worker buckets so the breakdown sums to the row total.
const WOHHUP_MAIN_KEYWORDS = ["woh hup", "wohhup", "woh-hup", "woh_hup", "won hup"];
const WHPL_KEYWORDS = ["whpl"];
const WOHHUP_FAMILY_CANONICAL = "Wohhup";

function isWohhupMain(name) {
  if (!name) return false;
  const lower = String(name).toLowerCase();
  return WOHHUP_MAIN_KEYWORDS.some((k) => lower.includes(k));
}
function isWHPL(name) {
  if (!name) return false;
  const lower = String(name).toLowerCase();
  return WHPL_KEYWORDS.some((k) => lower.includes(k));
}
function isWohhupFamily(name) {
  return isWohhupMain(name) || isWHPL(name);
}

/**
 * Build the Wohhup 3-bucket breakdown sub-lines (Engineer / Staff / Worker).
 *
 * Sources:
 * - Engineer: sum role counts in Details JSON where the role matches "Engineer(s)"
 *   across Wohhup-main rows on the sheet.
 * - Staff:    TS + NTS from `wh-staff-tracker` (separate Supabase WH Staff message).
 * - Worker:   sum [Total] across Wohhup-family sheet rows that are NOT engineer
 *   or staff rows (WHPL rows are always workers).
 *
 * @param {string} searchDate         - DD-MMM-YYYY
 * @param {Array}  manpowerObjects    - All manpower rows for the date (already filtered)
 * @returns {Promise<string[]>} sub-lines to append after the Wohhup header line
 */
/**
 * Compute Engineer / Staff / Worker totals for the Wohhup family on a given date.
 *
 * Rule: each total comes DIRECTLY from the message that day, never derived via
 * arithmetic from sheet sums. Missing message → null (NOT 0). Callers should
 * distinguish "no message" from "0 people".
 *
 *   • Engineer ← Wohhup-main sheet rows whose Details JSON has an "Engineer" role.
 *                The sheet stores the message total directly, so this IS the
 *                authoritative engineer count. (No Engineer Supabase tracker
 *                exists — Wohhup never sends an engineer breakdown.)
 *   • Staff    ← getWHStaffTSNTS — staffTS + staffNTS from the WH Staff
 *                Manpower message in Supabase whatsapp_listener.
 *   • Worker   ← getWHWorkerBreakdown — prefer the message's stated
 *                workersOnSite. Fall back to the register-formula
 *                (totalRegister − homeLeave − course − MC + loanIn − loanOut − absent)
 *                only when on-site is missing AND register > 0. Sanity-clamp
 *                negative results to 0 with a warning.
 *
 * @param {string} searchDate    - "DD-MMM-YYYY"
 * @param {Array}  manpowerObjects - Optional. All manpower rows for the date
 *                                   (already filtered to that date). When
 *                                   omitted, Engineer falls back to 0.
 * @returns {Promise<{engineer: number|null, staff: number|null, worker: number|null, total: number, staffTS: number|null, staffNTS: number|null, dayStaffTS: number|null, dayStaffNTS: number|null, nightStaffTS: number|null, nightStaffNTS: number|null, totalRegister: number|null, workersOnSite: number|null, homeLeave: number|null, loanOut: number|null, loanIn: number|null, course: number|null, medicalLeave: number|null, absent: number|null, dayOnSite: number|null, nightOnSite: number|null, engineerOnSite: number|null, engineerTotal: number|null, engineerAbsent: number|null}>}
 */
async function buildWohhupTotals(searchDate, manpowerObjects) {
  // Engineer — comes ONLY from the WH Engineering Supabase tracker.
  // No sheet fallback: per the "for Wohhup never from sheet" rule, if the
  // tracker can't parse the message (or no message exists), engineer = null
  // (treated as 0 in totals). The `manpowerObjects` parameter is retained
  // for API compatibility but is no longer used for engineer derivation.
  let engineer = null;
  let engineerDetail = null;
  try {
    const r = await getWHEngineerOnSite(searchDate).catch(() => null);
    if (r && Number.isFinite(r.onSite)) engineer = r.onSite;
    engineerDetail = r || null;
  } catch (e) {
    console.warn("[buildWohhupTotals] engineer tracker fetch failed:", e?.message || e);
  }
  void manpowerObjects; // suppress unused-arg lint; kept for backward compat

  // Staff — message total from WH Staff Manpower (Supabase tracker).
  let staff = null;
  let staffDetail = null;
  try {
    const r = await getWHStaffTSNTS(searchDate).catch(() => null);
    if (r) staff = (r.staffTS || 0) + (r.staffNTS || 0);
    staffDetail = r || null;
  } catch (e) {
    console.warn("[buildWohhupTotals] staff tracker fetch failed:", e?.message || e);
  }

  // Worker — message total from WH Workers Manpower (Supabase tracker).
  // Prefer stated `workersOnSite`; fall back to register-formula derivation
  // only when on-site is missing AND register is present. Clamp negatives.
  let worker = null;
  let workerDetail = null;
  try {
    const r = await getWHWorkerBreakdown(searchDate).catch(() => null);
    workerDetail = r || null;
    if (r) {
      if (Number.isFinite(r.workersOnSite) && r.workersOnSite > 0) {
        worker = r.workersOnSite;
      } else if (Number.isFinite(r.totalRegister) && r.totalRegister > 0) {
        const derived = r.totalRegister - r.homeLeave - r.course - r.medicalLeave + r.loanIn - r.loanOut - r.absent;
        if (derived < 0) {
          console.warn(
            `[buildWohhupTotals] Negative derived worker count (${derived}) on ${searchDate} — parser likely missed a label. Clamping to 0. Breakdown=${JSON.stringify(r)}`,
          );
          worker = 0;
        } else {
          worker = derived;
        }
      } else {
        // Tracker returned a parsed object but neither field had a usable value.
        worker = 0;
      }
    }
  } catch (e) {
    console.warn("[buildWohhupTotals] worker tracker fetch failed:", e?.message || e);
  }

  const total = (engineer || 0) + (staff || 0) + (worker || 0);

  // Per-shift totals — engineer attaches to Day (no shift split in its tracker).
  // Worker / Staff carry explicit day-night fields from their parsers.
  const dayTotal =
    (engineer || 0) +
    (Number(staffDetail?.dayStaffTS) || 0) +
    (Number(staffDetail?.dayStaffNTS) || 0) +
    (Number(workerDetail?.dayOnSite) ?? worker ?? 0);
  const nightTotal =
    (Number(staffDetail?.nightStaffTS) || 0) +
    (Number(staffDetail?.nightStaffNTS) || 0) +
    (Number(workerDetail?.nightOnSite) || 0);

  // Extended subfields — null when the underlying tracker returned no message,
  // numeric when present. Consumers may safely ignore unknown fields; adding
  // these is strictly additive and backwards-compatible.
  const ext = {
    // Staff subfields
    staffTS: staffDetail ? (Number.isFinite(staffDetail.staffTS) ? staffDetail.staffTS : null) : null,
    staffNTS: staffDetail ? (Number.isFinite(staffDetail.staffNTS) ? staffDetail.staffNTS : null) : null,
    dayStaffTS: staffDetail ? (Number.isFinite(staffDetail.dayStaffTS) ? staffDetail.dayStaffTS : null) : null,
    dayStaffNTS: staffDetail ? (Number.isFinite(staffDetail.dayStaffNTS) ? staffDetail.dayStaffNTS : null) : null,
    nightStaffTS: staffDetail ? (Number.isFinite(staffDetail.nightStaffTS) ? staffDetail.nightStaffTS : null) : null,
    nightStaffNTS: staffDetail ? (Number.isFinite(staffDetail.nightStaffNTS) ? staffDetail.nightStaffNTS : null) : null,
    // Workers register
    totalRegister: workerDetail
      ? Number.isFinite(workerDetail.totalRegister)
        ? workerDetail.totalRegister
        : null
      : null,
    workersOnSite: workerDetail
      ? Number.isFinite(workerDetail.workersOnSite)
        ? workerDetail.workersOnSite
        : null
      : null,
    homeLeave: workerDetail ? (Number.isFinite(workerDetail.homeLeave) ? workerDetail.homeLeave : null) : null,
    loanOut: workerDetail ? (Number.isFinite(workerDetail.loanOut) ? workerDetail.loanOut : null) : null,
    loanIn: workerDetail ? (Number.isFinite(workerDetail.loanIn) ? workerDetail.loanIn : null) : null,
    course: workerDetail ? (Number.isFinite(workerDetail.course) ? workerDetail.course : null) : null,
    medicalLeave: workerDetail ? (Number.isFinite(workerDetail.medicalLeave) ? workerDetail.medicalLeave : null) : null,
    absent: workerDetail ? (Number.isFinite(workerDetail.absent) ? workerDetail.absent : null) : null,
    dayOnSite: workerDetail ? (Number.isFinite(workerDetail.dayOnSite) ? workerDetail.dayOnSite : null) : null,
    nightOnSite: workerDetail ? (Number.isFinite(workerDetail.nightOnSite) ? workerDetail.nightOnSite : null) : null,
    // Engineer detail
    engineerOnSite: engineerDetail ? (Number.isFinite(engineerDetail.onSite) ? engineerDetail.onSite : null) : null,
    engineerTotal: engineerDetail ? (Number.isFinite(engineerDetail.total) ? engineerDetail.total : null) : null,
    engineerAbsent: engineerDetail ? (Number.isFinite(engineerDetail.absent) ? engineerDetail.absent : null) : null,
  };

  return { engineer, staff, worker, total, dayTotal, nightTotal, ...ext };
}

/**
 * Render the Engineer / Staff / Worker sub-lines for the Wohhup row in the
 * daily summary. Missing categories show "(no … message today)" so the gap
 * is visible to the customer instead of silently rendering 0.
 */
async function buildWohhupBreakdownLines(searchDate, manpowerObjects) {
  const t = await buildWohhupTotals(searchDate, manpowerObjects);
  const lines = [];
  if (t.engineer === null) lines.push(`     ◦ Engineer: (no message today)`);
  else if (t.engineer > 0) lines.push(`     ◦ Engineer: ${t.engineer} pax`);
  if (t.staff === null) lines.push(`     ◦ Staff: (no message today)`);
  else if (t.staff > 0) lines.push(`     ◦ Staff: ${t.staff} pax`);
  if (t.worker === null) lines.push(`     ◦ Worker: (no message today)`);
  else if (t.worker > 0) lines.push(`     ◦ Worker: ${t.worker} pax`);
  return lines;
}

// 3-letter month constants
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Get today's date in DD-MMM-YYYY format using Singapore timezone
 * @returns {string} e.g. "26-Mar-2026"
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
 * @param {string} dateParam - Date string like "26-Mar-2026"
 * @returns {string} Validated DD-MMM-YYYY string
 */
function parseDate(dateParam) {
  if (!dateParam) return getTodaySGT();

  const match = dateParam.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!match) throw new Error(`Invalid date format: "${dateParam}". Expected DD-MMM-YYYY (e.g., "26-Mar-2026")`);

  const [, day, monthStr, year] = match;
  const monthCap = monthStr.charAt(0).toUpperCase() + monthStr.slice(1).toLowerCase();
  if (!MONTHS.includes(monthCap)) {
    throw new Error(`Invalid month: "${monthStr}". Use 3-letter abbreviation (Jan, Feb, Mar, ...)`);
  }

  return `${day.padStart(2, "0")}-${monthCap}-${year}`;
}

/**
 * Convert DD-MMM-YYYY to YYYY-MM-DD (ISO) for matching against the Date column.
 * The Date column is stored as YYYY-MM-DD after readGoogleSheet auto-conversion.
 * @param {string} ddMmmYyyy - Date in DD-MMM-YYYY format (e.g., "31-Mar-2026")
 * @returns {string} ISO date string (e.g., "2026-03-31")
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
 * Extract the date portion from a Timestamp column value and normalize to DD-MMM-YYYY.
 *
 * The Timestamp column is written as `'DD-MMM-YYYY HH:MM` (leading single quote
 * prevents Google Sheets from converting it to a date serial). When read back with
 * valueRenderOption "FORMULA", the leading quote is preserved.
 *
 * Handles:
 *   "'26-Mar-2026 14:30"  → "26-Mar-2026"
 *   "26-Mar-2026 14:30"   → "26-Mar-2026"
 *   "'26-Mar-2026"        → "26-Mar-2026"
 *   "2026-03-26T06:30:00" → "26-Mar-2026"  (ISO fallback)
 *
 * @param {string} rawTimestamp - Raw timestamp string from sheet
 * @returns {string} Normalized DD-MMM-YYYY string, or empty string if unparseable
 */
function extractDateFromTimestamp(rawTimestamp) {
  if (!rawTimestamp) return "";
  // Strip leading single quote (Google Sheets text prefix)
  let trimmed = String(rawTimestamp).trim();
  if (trimmed.startsWith("'")) trimmed = trimmed.slice(1);

  // DD-MMM-YYYY at the start, optionally followed by space + time
  const ddMmmYyyy = trimmed.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
  if (ddMmmYyyy) {
    const [, d, m, y] = ddMmmYyyy;
    return `${d.padStart(2, "0")}-${m.charAt(0).toUpperCase() + m.slice(1).toLowerCase()}-${y}`;
  }

  // ISO format fallback: YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS
  const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const [, y, m, d] = iso;
    const monthIdx = parseInt(m, 10) - 1;
    if (monthIdx >= 0 && monthIdx < 12) {
      return `${d}-${MONTHS[monthIdx]}-${y}`;
    }
  }

  return "";
}

/**
 * Format a display date like "Wednesday, 26 March 2026"
 * @param {string} ddMmmYyyy - Date in DD-MMM-YYYY format
 * @returns {string} Human-friendly display date
 */
function formatDisplayDate(ddMmmYyyy) {
  const match = ddMmmYyyy.match(/^(\d{2})-([A-Za-z]{3})-(\d{4})$/);
  if (!match) return ddMmmYyyy;

  const [, day, monthStr, year] = match;
  const monthIndex = MONTHS.indexOf(monthStr);
  if (monthIndex === -1) return ddMmmYyyy;

  const date = new Date(parseInt(year), monthIndex, parseInt(day));
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const monthNames = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];

  return `${dayNames[date.getDay()]}, ${parseInt(day)} ${monthNames[monthIndex]} ${year}`;
}

/**
 * Compute similarity ratio between two strings (0 to 1).
 * Uses Levenshtein distance normalized by the longer string's length.
 * @param {string} a
 * @param {string} b
 * @returns {number} similarity ratio (1 = identical)
 */
function similarity(a, b) {
  const al = a.toLowerCase().trim();
  const bl = b.toLowerCase().trim();
  if (al === bl) return 1;
  const lenA = al.length;
  const lenB = bl.length;
  if (lenA === 0 || lenB === 0) return 0;

  // Levenshtein distance via two-row DP
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
  const dist = prev[lenB];
  return 1 - dist / Math.max(lenA, lenB);
}

const SIMILARITY_THRESHOLD = 0.85;

/**
 * Find the canonical company name from existing keys, or return the raw name.
 * @param {string} name - Company name from the row
 * @param {Map} map - Existing company map
 * @returns {string} The matched canonical name, or the original name
 */
function resolveCompanyName(name, map) {
  for (const existing of map.keys()) {
    if (similarity(name, existing) >= SIMILARITY_THRESHOLD) {
      return existing;
    }
  }
  return name;
}

/**
 * Build the professional summary message from manpower + machines data
 * @param {string} searchDate - DD-MMM-YYYY
 * @param {Array} manpowerRows - Matching manpower rows
 * @param {Array} machinesRows - Matching machines rows
 * @returns {string} Formatted WhatsApp message
 */
async function buildSummaryMessage(searchDate, manpowerRows, machinesRows) {
  const displayDate = formatDisplayDate(searchDate);

  if (manpowerRows.length === 0) {
    return [`📊 *DAILY MANPOWER SUMMARY*`, `📅 ${displayDate}`, ``, `No manpower records found for this date.`].join(
      "\n",
    );
  }

  // Aggregate by shift → company (fuzzy-matched)
  // shiftMap: { "Day": Map<company, {totalWorkers}>, "Night": Map<company, {totalWorkers}> }
  const shiftMap = new Map();
  const globalCompanyMap = new Map(); // for fuzzy matching across shifts

  for (const row of manpowerRows) {
    const rawName = row.Company || row.company || "Unknown";
    // Wohhup family (WHPL / Woh Hup / Won hup / variants) is NEVER aggregated
    // from the sheet — totals come exclusively from whatsapp_listener trackers
    // (see setShiftWohhup below). Sheet rows for these companies are skipped.
    if (isWohhupFamily(rawName)) continue;
    const shift = row.Shift || "Day";
    const company = resolveCompanyName(rawName, globalCompanyMap);

    if (!globalCompanyMap.has(company)) {
      globalCompanyMap.set(company, true);
    }

    if (!shiftMap.has(shift)) {
      shiftMap.set(shift, new Map());
    }
    const companyMap = shiftMap.get(shift);
    if (!companyMap.has(company)) {
      companyMap.set(company, { totalWorkers: 0 });
    }
    const entry = companyMap.get(company);
    const workers = parseInt(row.Total || row.TotalWorkers || row.total || row.totalWorkers || 0, 10);
    entry.totalWorkers += isNaN(workers) ? 0 : workers;
  }

  // Aggregate machines by shift → company (fuzzy-matched)
  // machineShiftMap: { "Day": Map<company, {totalMachines}>, "Night": Map<company, {totalMachines}> }
  const machineShiftMap = new Map();
  for (const row of machinesRows) {
    const rawName = row.Company || row.company || "Unknown";
    const shift = row.Shift || "Day";
    const familyMapped = isWohhupFamily(rawName) ? WOHHUP_FAMILY_CANONICAL : rawName;
    const company = resolveCompanyName(familyMapped, globalCompanyMap);
    if (!globalCompanyMap.has(company)) {
      globalCompanyMap.set(company, true);
    }

    if (!machineShiftMap.has(shift)) {
      machineShiftMap.set(shift, new Map());
    }
    const machineMap = machineShiftMap.get(shift);
    if (!machineMap.has(company)) {
      machineMap.set(company, { totalMachines: 0 });
    }
    const entry = machineMap.get(company);
    const machines = parseInt(row.Total || row.TotalMachines || row.total || row.totalMachines || 0, 10);
    entry.totalMachines += isNaN(machines) ? 0 : machines;
  }

  // Wohhup override — split the trackers' totals by shift.
  //
  // `wohhupTotals.total` is the GRAND total (engineer + all-staff + worker, =71 for 14-May);
  // it is what daily-manpower-data.js / supabase_node / weekly report consumers care
  // about, so keep it intact at the source.
  //
  // But the summary message has Day/Night sections — each needs its own number.
  // The staff and worker trackers already expose day/night subfields:
  //   · dayStaffTS / dayStaffNTS / nightStaffTS / nightStaffNTS  (WH Staff tracker)
  //   · dayOnSite / nightOnSite                                  (WH Worker tracker)
  // Engineer has no day/night split — attached to Day.
  //
  //   wohhupDayTotal   = engineer + dayStaff   + dayWorker
  //   wohhupNightTotal = 0        + nightStaff + nightWorker
  //
  // For 14-May this resolves to Day=65, Night=6 (sum 71 — matches grand total).
  //
  // We also ENSURE the Wohhup row exists in each shift's companyMap when the
  // tracker shows non-zero activity — even if no Wohhup-family row was present
  // in the source Manpower sheet for that shift — and DELETE the row when
  // tracker shows zero (so stale sheet rows can't render a phantom value).
  const wohhupTotals = await buildWohhupTotals(searchDate, manpowerRows);

  // Wohhup family totals come EXCLUSIVELY from whatsapp_listener trackers —
  // never from the sheet. Initial sheet aggregation above skips them. We add
  // the tracker-derived day/night totals here. If trackers return null/0,
  // Wohhup simply doesn't appear in the summary for that date.
  const wohhupDayTotal =
    (wohhupTotals.engineer || 0) +
    (wohhupTotals.dayStaffTS || 0) +
    (wohhupTotals.dayStaffNTS || 0) +
    (wohhupTotals.dayOnSite ?? wohhupTotals.worker ?? 0);
  const wohhupNightTotal =
    (wohhupTotals.nightStaffTS || 0) + (wohhupTotals.nightStaffNTS || 0) + (wohhupTotals.nightOnSite || 0);

  function setShiftWohhup(shift, value) {
    if (value > 0) {
      if (!shiftMap.has(shift)) shiftMap.set(shift, new Map());
      const m = shiftMap.get(shift);
      if (!m.has(WOHHUP_FAMILY_CANONICAL)) {
        m.set(WOHHUP_FAMILY_CANONICAL, { totalWorkers: 0 });
        globalCompanyMap.set(WOHHUP_FAMILY_CANONICAL, true);
      }
      m.get(WOHHUP_FAMILY_CANONICAL).totalWorkers = value;
    } else {
      shiftMap.get(shift)?.delete(WOHHUP_FAMILY_CANONICAL);
    }
  }
  setShiftWohhup("Day", wohhupDayTotal);
  setShiftWohhup("Night", wohhupNightTotal);

  // Calculate totals
  let grandTotalWorkers = 0;
  let grandTotalMachines = 0;
  const shiftTotals = {};
  const shiftMachineTotals = {};
  for (const [shift, companyMap] of shiftMap) {
    let shiftTotal = 0;
    for (const [, data] of companyMap) shiftTotal += data.totalWorkers;
    shiftTotals[shift] = shiftTotal;
    grandTotalWorkers += shiftTotal;
  }
  for (const [shift, machineMap] of machineShiftMap) {
    let shiftMachineTotal = 0;
    for (const [, data] of machineMap) shiftMachineTotal += data.totalMachines;
    shiftMachineTotals[shift] = shiftMachineTotal;
    grandTotalMachines += shiftMachineTotal;
  }

  // Recount companies from actual rendered shift entries (manpower + machinery)
  // so a Wohhup override that deletes both shift entries doesn't leave a
  // phantom in the count, and companies that only appear in machineShiftMap
  // still count.
  const renderedCompanies = new Set();
  for (const [, m] of shiftMap) for (const c of m.keys()) renderedCompanies.add(c);
  for (const [, m] of machineShiftMap) for (const c of m.keys()) renderedCompanies.add(c);
  const totalCompanies = renderedCompanies.size;

  // Build message
  const lines = [];
  lines.push(`📊 *Manpower Summary — ${displayDate}*`);
  lines.push(
    `👷 *${grandTotalWorkers}* workers | ${totalCompanies} companies${grandTotalMachines > 0 ? ` | 🚜 ${grandTotalMachines} machines` : ""}`,
  );

  // Shift breakdown — Day first, then Night
  const shiftOrder = ["Day", "Night"];
  for (const shift of shiftOrder) {
    const companyMap = shiftMap.get(shift);
    if (!companyMap || companyMap.size === 0) continue;

    const shiftTotal = shiftTotals[shift] || 0;
    const shiftMachineTotal = shiftMachineTotals[shift] || 0;
    const shiftIcon = shift === "Night" ? "🌙" : "☀️";
    const machinesSuffix = shiftMachineTotal > 0 ? ` | 🚜 ${shiftMachineTotal} machines` : "";

    lines.push(``);
    lines.push(`${shiftIcon} *${shift} Shift — ${shiftTotal} pax${machinesSuffix}*`);

    const machineMap = machineShiftMap.get(shift);
    const sorted = [...companyMap.entries()].sort((a, b) => b[1].totalWorkers - a[1].totalWorkers);
    for (const [company, data] of sorted) {
      const machineData = machineMap?.get(company);
      const machinePart = machineData && machineData.totalMachines > 0 ? ` | 🚜 ${machineData.totalMachines}` : "";
      lines.push(` · ${company} — ${data.totalWorkers} pax${machinePart}`);

      // For Wohhup, append the per-shift 3-bucket breakdown
      // (Engineer / Staff / Worker). Day attaches the engineer count; Night
      // shows only the night-staff / night-worker numbers from the trackers.
      // Mirrors the canonical PDF generated by supabase_node.
      if (company === WOHHUP_FAMILY_CANONICAL) {
        const t = wohhupTotals;
        if (shift === "Day") {
          const dayStaff = (t.dayStaffTS || 0) + (t.dayStaffNTS || 0);
          const dayWorker = t.dayOnSite ?? t.worker ?? 0;
          if (t.engineer === null) lines.push(`     ◦ Engineer: (no message today)`);
          else if (t.engineer > 0) lines.push(`     ◦ Engineer: ${t.engineer} pax`);
          if (t.staff === null && dayStaff === 0) lines.push(`     ◦ Staff: (no message today)`);
          else if (dayStaff > 0) lines.push(`     ◦ Staff: ${dayStaff} pax`);
          if (t.worker === null && dayWorker === 0) lines.push(`     ◦ Worker: (no message today)`);
          else if (dayWorker > 0) lines.push(`     ◦ Worker: ${dayWorker} pax`);
        } else if (shift === "Night") {
          const nightStaff = (t.nightStaffTS || 0) + (t.nightStaffNTS || 0);
          const nightWorker = t.nightOnSite || 0;
          if (nightStaff > 0) lines.push(`     ◦ Staff: ${nightStaff} pax`);
          if (nightWorker > 0) lines.push(`     ◦ Worker: ${nightWorker} pax`);
        }
      }
    }
  }

  return lines.join("\n");
}

/**
 * Process daily manpower summary request
 * @param {object} event - Lambda event
 * @param {object} res - Response helper { status(code).json(body) }
 */
async function processDailyManpowerSummaryRequest(event, res) {
  try {
    let body = {};
    try {
      if (event.body) body = JSON.parse(event.body);
    } catch (e) {
      console.warn("Failed to parse request body:", e.message);
    }

    const { date: dateParam, groupIds, groupId, dryRun = false } = body;
    console.log("📊 [MANPOWER SUMMARY] Request:", { date: dateParam, groupIds, groupId, dryRun });

    // Resolve recipient list: groupIds (array) > groupId (string)
    const recipientIds =
      groupIds && Array.isArray(groupIds) && groupIds.length > 0 ? groupIds : groupId ? [groupId] : [];

    if (recipientIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: "Missing required parameter: groupIds (array) or groupId (string)",
      });
    }

    // Parse + validate date
    const searchDate = parseDate(dateParam);
    console.log(`📊 [MANPOWER SUMMARY] Search date: ${searchDate}`);

    // Load manpower data from sheet — use first group for config
    const groupConfig = getGroupConfiguration(recipientIds[0]);

    const manpowerConfig = {
      spreadsheetId: groupConfig.manpowerSpreadsheetId || getSpreadsheetConfig("manpower")?.spreadsheetId,
    };
    const machinesConfig = {
      spreadsheetId: groupConfig.machinesSpreadsheetId || getSpreadsheetConfig("machines")?.spreadsheetId,
    };

    if (!manpowerConfig.spreadsheetId) {
      return res.status(400).json({
        success: false,
        error: "No manpower spreadsheet configured",
      });
    }

    // Load raw sheet data
    const manpowerSheetName = groupConfig.manpowerSheetName || "Manpower";
    const machinesSheetName = groupConfig.machinesSheetName || "Machines";

    console.log(`📊 [MANPOWER SUMMARY] Loading ${manpowerSheetName} from ${manpowerConfig.spreadsheetId}`);
    const manpowerData = await loadData(manpowerSheetName, { spreadsheetId: manpowerConfig.spreadsheetId });

    let machinesData = [];
    if (machinesConfig.spreadsheetId) {
      console.log(`📊 [MANPOWER SUMMARY] Loading ${machinesSheetName} from ${machinesConfig.spreadsheetId}`);
      machinesData = await loadData(machinesSheetName, { spreadsheetId: machinesConfig.spreadsheetId });
    }

    if (!manpowerData || manpowerData.length === 0) {
      console.log("📊 [MANPOWER SUMMARY] No manpower data found in sheet");
      const emptyMessage = await buildSummaryMessage(searchDate, [], []);
      const sendResults = [];
      if (!dryRun) {
        for (const gid of recipientIds) {
          try {
            await sendWhatsAppMessage(gid, emptyMessage);
            sendResults.push({ groupId: gid, sent: true });
          } catch (sendErr) {
            sendResults.push({ groupId: gid, sent: false, error: sendErr.message });
          }
        }
      }
      return res.status(200).json({
        success: true,
        date: searchDate,
        totalRecords: 0,
        message: emptyMessage,
        sent: sendResults.some((r) => r.sent),
        sendResults,
      });
    }

    // Convert searchDate (DD-MMM-YYYY) to ISO (YYYY-MM-DD) for matching against Date column
    // The Date column is stored as YYYY-MM-DD after readGoogleSheet auto-conversion
    const searchDateIso = toIsoDate(searchDate);
    console.log(`📊 [MANPOWER SUMMARY] Filtering by Date column = ${searchDateIso}`);

    // Sheet data comes as arrays: [headers, ...rows]
    // loadData returns raw arrays — first row is headers
    const headers = manpowerData[0];
    const rows = manpowerData.slice(1);

    // Map rows to objects
    const manpowerObjects = rows
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

    console.log(`📊 [MANPOWER SUMMARY] Found ${manpowerObjects.length} manpower records for ${searchDate}`);

    // Same for machines
    let machinesObjects = [];
    if (machinesData && machinesData.length > 1) {
      const mHeaders = machinesData[0];
      const mRows = machinesData.slice(1);
      machinesObjects = mRows
        .map((row) => {
          const obj = {};
          mHeaders.forEach((h, i) => {
            obj[h] = row[i];
          });
          return obj;
        })
        .filter((row) => {
          const rowDate = String(row.Date || "").trim();
          return rowDate === searchDateIso;
        });
      console.log(`📊 [MANPOWER SUMMARY] Found ${machinesObjects.length} machines records for ${searchDate}`);
    }

    // Build the message
    const message = await buildSummaryMessage(searchDate, manpowerObjects, machinesObjects);

    // Send or dry-run
    const sendResults = [];
    if (!dryRun) {
      for (const gid of recipientIds) {
        try {
          console.log(`📊 [MANPOWER SUMMARY] Sending message to ${gid}`);
          await sendWhatsAppMessage(gid, message);
          sendResults.push({ groupId: gid, sent: true });
          console.log(`📊 [MANPOWER SUMMARY] ✅ Sent to ${gid}`);
        } catch (sendErr) {
          console.error(`📊 [MANPOWER SUMMARY] ❌ Failed to send to ${gid}:`, sendErr.message);
          sendResults.push({ groupId: gid, sent: false, error: sendErr.message });
        }
      }
    } else {
      console.log(`📊 [MANPOWER SUMMARY] Dry run — message not sent`);
    }

    return res.status(200).json({
      success: true,
      date: searchDate,
      totalRecords: manpowerObjects.length,
      totalWorkers: manpowerObjects.reduce(
        (sum, r) => sum + (parseInt(r.TotalWorkers || r.totalWorkers || 0, 10) || 0),
        0,
      ),
      totalMachines: machinesObjects.reduce(
        (sum, r) => sum + (parseInt(r.TotalMachines || r.totalMachines || 0, 10) || 0),
        0,
      ),
      companies: [...new Set(manpowerObjects.map((r) => r.Company || r.company))],
      message,
      sent: sendResults.some((r) => r.sent),
      sendResults,
    });
  } catch (error) {
    console.error("📊 [MANPOWER SUMMARY] Error:", error);
    return res.status(500).json({
      success: false,
      error: error.message,
      message: "Failed to process daily manpower summary request",
    });
  }
}

module.exports = processDailyManpowerSummaryRequest;
// Named exports for the new /wh-manpower-totals endpoint and the QA agent
// post-processor — both reuse the same per-day computation so the lambda
// gives a single canonical answer for any "what's Wohhup at on date X" query.
module.exports.buildWohhupTotals = buildWohhupTotals;
module.exports.buildWohhupBreakdownLines = buildWohhupBreakdownLines;
