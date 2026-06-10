/**
 * Manpower domain plugin.
 *
 * Manpower has TWO data backends merged into one logical row stream:
 *   1. Manpower Google Sheet — subcontractor company totals (LT SAMBO, KTC, …)
 *      via `runSQLQuery('manpower')` which already loads + filters the sheet.
 *      Company-name variants (LT SAMBO(ATEC), LT_SAMBO (ESK), etc.) are
 *      canonicalized via `canonicalCompany`.
 *   2. Wohhup family — buildWohhupTotals() reads WhatsApp message trackers
 *      and exposes every tracker subfield (Engineer / Staff TS+NTS day+night /
 *      Workers on-site/home-leave/loan-out/etc.). WHPL is collapsed INTO
 *      Woh Hup at the plugin boundary, so the rest of the system sees a
 *      single "Woh Hup" company row.
 *
 * For a single date the plugin merges: sheet subcontractors (minus any
 * WH-family rows) + 1 synthesized "Woh Hup" row from buildWohhupTotals.
 * For a range the planner asks for per-day rows; the plugin loops day-by-day.
 */

const { runSQLQuery } = require("../../../utils/action");
const { buildWohhupTotals } = require("../../../api/daily-manpower-summary");
const { isoDaysInRange, isoToDdMmm } = require("../shared/time-window");
const { stageLog, stageWarn } = require("../shared/logging");
const { canonicalCompany } = require("./manpower-canon");

const SOURCE_TAG = "manpowerData+wohhup_tracker";

const isWHFamily = (name) => {
  const lk = String(name || "").toLowerCase();
  return (
    lk.includes("woh hup") ||
    lk.includes("wohhup") ||
    lk.includes("woh-hup") ||
    lk.includes("woh_hup") ||
    lk.includes("whpl")
  );
};

/**
 * Fetch normalized manpower rows for a date window.
 */
async function fetchRows({ window, filters = [], select, groupConfig }) {
  const days = window.kind === "all_time" ? [] : isoDaysInRange(window.start_iso, window.end_iso);
  if (days.length === 0) return [];

  // 1) Sheet rows for every day in the window — single SQL query.
  let sheetRows = [];
  try {
    const dateExpr =
      days.length === 1 ? `[Date] = '${days[0]}'` : `[Date] IN (${days.map((d) => `'${d}'`).join(", ")})`;
    const cols = "[Date], [Company], [Shift], [Total], [Details], [Group]";
    const query = `SELECT ${cols} FROM manpowerData WHERE ${dateExpr}`;
    sheetRows = (await runSQLQuery(query, "manpower", { groupConfig })) || [];
  } catch (e) {
    stageWarn("data/manpower", "sheet load failed", e?.message || e);
  }

  // 2) Wohhup canonical rows — one per day. Each row carries every tracker
  //    subfield so v2 metrics (ts_count, on_site_count, etc.) can reduce
  //    over them without re-fetching.
  const wohhupRows = [];
  for (const iso of days) {
    const ddMmm = isoToDdMmm(iso);
    try {
      const t = await buildWohhupTotals(ddMmm, []);
      const hasSignal =
        t && (t.total > 0 || t.engineer !== null || t.staff !== null || t.worker !== null || t.totalRegister !== null);
      if (hasSignal) {
        wohhupRows.push({
          Date: iso,
          Company: "Woh Hup",
          Shift: "Day", // Wohhup messages don't carry Shift; canonical message totals are day-wide accumulated
          Total: t.total || 0,
          Engineer: t.engineer,
          Staff: t.staff,
          Worker: t.worker,
          // Staff subfields
          StaffTS: t.staffTS,
          StaffNTS: t.staffNTS,
          DayStaffTS: t.dayStaffTS,
          DayStaffNTS: t.dayStaffNTS,
          NightStaffTS: t.nightStaffTS,
          NightStaffNTS: t.nightStaffNTS,
          // Workers register
          TotalRegister: t.totalRegister,
          WorkersOnSite: t.workersOnSite,
          HomeLeave: t.homeLeave,
          LoanOut: t.loanOut,
          LoanIn: t.loanIn,
          Course: t.course,
          MedicalLeave: t.medicalLeave,
          Absent: t.absent,
          DayOnSite: t.dayOnSite,
          NightOnSite: t.nightOnSite,
          Source: "wohhup_tracker",
        });
      }
    } catch (e) {
      stageWarn("data/manpower", `buildWohhupTotals(${iso}) failed`, e?.message || e);
    }
  }

  // 3) Drop sheet Wohhup-family rows (already represented by wohhupRows),
  //    canonicalize every other company name, and aggregate same-day same-company
  //    rows that came in as multiple variants (e.g. "LT SAMBO (Atec)" + "LT_SAMBO *(ESK)*").
  const sheetRowsCanonical = sheetRows
    .filter((r) => !isWHFamily(r.Company))
    .map((r) => ({
      Date: r.Date,
      Company: canonicalCompany(r.Company),
      Shift: String(r.Shift || "").trim() || "Day",
      Total: parseInt(r.Total, 10) || 0,
      Details: r.Details,
      Group: r.Group,
      Source: "sheet",
    }));

  // 4) Apply incoming filters declaratively (Layer 2 may have pushed them
  //    down; we treat the standard ones here too for safety).
  let rows = [...wohhupRows, ...sheetRowsCanonical];
  for (const f of filters) {
    rows = applyFilter(rows, f);
  }
  stageLog("data/manpower", `fetched ${rows.length} rows`, {
    window: window.label,
    sources: { sheet: sheetRowsCanonical.length, wohhup: wohhupRows.length },
  });
  return rows;
}

function applyFilter(rows, filter) {
  const { field, op, value, values } = filter || {};
  if (!field) return rows;
  return rows.filter((r) => {
    const v = r[field];
    switch (op) {
      case "=":
        return String(v) === String(value);
      case "!=":
        return String(v) !== String(value);
      case "in":
        return Array.isArray(values) && values.some((x) => String(x) === String(v));
      case "like":
        return String(v || "")
          .toLowerCase()
          .includes(String(value || "").toLowerCase());
      case ">=":
        return Number(v) >= Number(value);
      case "<=":
        return Number(v) <= Number(value);
      default:
        return true;
    }
  });
}

module.exports = {
  name: "manpower",
  displayName: "Manpower",
  description:
    "Worker headcount per company/shift; Wohhup-family Engineer/Staff/Worker on-site; Staff TS+NTS Day/Night breakdown; Workers register (on-site, home-leave, loan-out/in, course, MC, absent). Per-day and per-range totals.",
  metrics: [
    // Generic
    { name: "headcount", field: "Total", unit: "pax", aggregations: ["sum", "count", "avg", "min", "max"] },
    { name: "engineer_count", field: "Engineer", unit: "pax", aggregations: ["sum"] },
    { name: "staff_count", field: "Staff", unit: "pax", aggregations: ["sum"] },
    { name: "worker_count", field: "Worker", unit: "pax", aggregations: ["sum"] },
    { name: "company_count", aggregations: ["count"] },
    // Wohhup specialty — Staff TS/NTS
    { name: "ts_count", field: "StaffTS", unit: "pax", aggregations: ["sum"] },
    { name: "nts_count", field: "StaffNTS", unit: "pax", aggregations: ["sum"] },
    { name: "day_ts_count", field: "DayStaffTS", unit: "pax", aggregations: ["sum"] },
    { name: "day_nts_count", field: "DayStaffNTS", unit: "pax", aggregations: ["sum"] },
    { name: "night_ts_count", field: "NightStaffTS", unit: "pax", aggregations: ["sum"] },
    { name: "night_nts_count", field: "NightStaffNTS", unit: "pax", aggregations: ["sum"] },
    // Wohhup specialty — Workers register
    { name: "on_site_count", field: "WorkersOnSite", unit: "pax", aggregations: ["sum"] },
    { name: "home_leave_count", field: "HomeLeave", unit: "pax", aggregations: ["sum"] },
    { name: "loan_out_count", field: "LoanOut", unit: "pax", aggregations: ["sum"] },
    { name: "loan_in_count", field: "LoanIn", unit: "pax", aggregations: ["sum"] },
    { name: "course_count", field: "Course", unit: "pax", aggregations: ["sum"] },
    { name: "medical_leave_count", field: "MedicalLeave", unit: "pax", aggregations: ["sum"] },
    { name: "absent_count", field: "Absent", unit: "pax", aggregations: ["sum"] },
    { name: "total_register", field: "TotalRegister", unit: "pax", aggregations: ["sum"] },
    { name: "day_on_site_count", field: "DayOnSite", unit: "pax", aggregations: ["sum"] },
    { name: "night_on_site_count", field: "NightOnSite", unit: "pax", aggregations: ["sum"] },
  ],
  dimensions: [
    { name: "Date", semantic_type: "date" },
    { name: "Company", semantic_type: "category" },
    { name: "Shift", semantic_type: "category", enum: ["Day", "Night"] },
    // Role is a virtual dimension — the raw Manpower-sheet row stores roles
    // as a JSON map in the Details column (e.g. {"Site Supervisor": 7,
    // "Rigger": 38, "Welder": 17}). When the parser group_bys by Role the
    // meta-enricher parses Details JSON, sums same-role counts across rows
    // of the same Company, and the format override renders the nested
    // breakdown. The Wohhup canonical row contributes Engineer/Staff/Worker
    // (and TS/NTS/onsite/etc. when present) as synthetic role buckets.
    { name: "Role", semantic_type: "text" },
  ],
  fetchRows,
  __test: { isWHFamily, applyFilter },
  __sources: [SOURCE_TAG],
};
