/**
 * Shared helpers for the MONTHLY-archived safety sheets.
 *
 * Safety issues live in ONE spreadsheet but are rotated monthly: the live current
 * month is the tab "Safety", and past months are archived as "Safety-<Mon> <Year>"
 * (e.g. "Safety-May 2026", "Safety-Apr 2026", back to 2025). Any consumer that must
 * query/operate across history needs to discover all these tabs.
 *
 * One source of truth — reused by:
 *   - utils/action.js (the runSQLQuery 'safety' multi-tab merge loader)
 *   - handlers/safety-handlers.js (edit/delete/close find — current + previous month)
 *   - usecases/qa_agent/bypass/novade_sync.js (full-history Novade sync writeback)
 *   - usecases/safety_novade_sync/index.js (the cron — already multi-tab)
 */
const { getSheetNames } = require("./gsheet");

const DEFAULT_SAFETY_SHEET_NAME = "Safety";
// Matches the live "Safety" tab and any monthly archive like "Safety-Apr 2026".
const SAFETY_TAB_PATTERN = /^Safety(-[A-Za-z]{3} \d{4})?$/;
const MONTH_ABBR_3 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_ORDER = MONTH_ABBR_3.reduce((acc, m, i) => ((acc[m] = i + 1), acc), {});

/**
 * The safety-archive tab name for the month BEFORE the given ISO date.
 * E.g. "2026-05-01" → "Safety-Apr 2026". null on a bad input.
 */
function previousMonthSafetyTab(targetDateIso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(targetDateIso || ""));
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const lastMonth = month === 1 ? 12 : month - 1;
  const lastYear = month === 1 ? year - 1 : year;
  return `Safety-${MONTH_ABBR_3[lastMonth - 1]} ${lastYear}`;
}

/** Sort tabs so "Safety" (current) is first, then archives newest → oldest. */
function compareSafetyTabs(a, b) {
  if (a === DEFAULT_SAFETY_SHEET_NAME) return -1;
  if (b === DEFAULT_SAFETY_SHEET_NAME) return 1;
  const parse = (name) => {
    const m = name.match(/^Safety-([A-Za-z]{3}) (\d{4})$/);
    if (!m) return [0, 0];
    return [Number(m[2]) || 0, MONTH_ORDER[m[1]] || 0];
  };
  const [yA, mA] = parse(a);
  const [yB, mB] = parse(b);
  if (yA !== yB) return yB - yA;
  return mB - mA;
}

/** Discover all safety tabs (current + archives), sorted current-first then newest→oldest. */
async function discoverSafetyTabs(spreadsheetId) {
  const all = (await getSheetNames(spreadsheetId)) || [];
  return all.filter((name) => SAFETY_TAB_PATTERN.test(name)).sort(compareSafetyTabs);
}

module.exports = {
  DEFAULT_SAFETY_SHEET_NAME,
  SAFETY_TAB_PATTERN,
  MONTH_ABBR_3,
  previousMonthSafetyTab,
  compareSafetyTabs,
  discoverSafetyTabs,
};
