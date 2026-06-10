/**
 * Time-window helpers. Pure code — no LLM calls.
 *
 * Used by:
 *   - The parser's prompt-injection of TODAY = YYYY-MM-DD (so the LLM resolves
 *     relative phrases deterministically)
 *   - The query planner to expand TimeWindow into ISO date lists
 *   - The aggregation engine for date-bucketing
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_MAP = Object.fromEntries(MONTHS.map((m, i) => [m.toLowerCase(), i]));
const DAY_OF_WEEK = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Return today's date in SGT (UTC+8) as ISO YYYY-MM-DD.
 * @returns {string}
 */
function todaySgtIso() {
  const sgNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Singapore" }));
  return formatIso(sgNow);
}

function formatIso(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** "2026-05-04" → "04-May-2026" */
function isoToDdMmm(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  if (!m) return null;
  return `${m[3]}-${MONTHS[parseInt(m[2], 10) - 1]}-${m[1]}`;
}

/** "04-May-2026" → "2026-05-04" */
function ddMmmToIso(ddMmm) {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(ddMmm || "");
  if (!m) return null;
  const mi = MONTH_MAP[m[2].toLowerCase()];
  if (mi === undefined) return null;
  return `${m[3]}-${String(mi + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

/** Day-of-week label for an ISO date (Sun/Mon/Tue/...). */
function dayOfWeek(iso) {
  const d = new Date(iso + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return null;
  return DAY_OF_WEEK[d.getUTCDay()];
}

/** Friendly label e.g. "Mon 04-May-2026". */
function formatDayLabel(iso) {
  return `${dayOfWeek(iso)} ${isoToDdMmm(iso)}`;
}

/**
 * Enumerate every ISO day in [start, end] inclusive. Caps at maxDays for
 * safety (default 400 — about 13 months).
 * @param {string} startIso
 * @param {string} endIso
 * @param {number} [maxDays]
 * @returns {string[]}
 */
function isoDaysInRange(startIso, endIso, maxDays = 400) {
  if (!startIso || !endIso) return [];
  const start = new Date(startIso + "T00:00:00Z");
  const end = new Date(endIso + "T00:00:00Z");
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return [];
  const out = [];
  for (let d = new Date(start); d <= end && out.length < maxDays; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Resolve common relative phrases used by the LLM during parsing. The LLM
 * resolves these against TODAY = todaySgtIso() and writes start/end into the
 * QueryIntent — this function is a fallback / sanity-check helper.
 *
 * Returns null when the phrase isn't a recognized relative shorthand.
 * @param {string} phrase
 * @param {string} [todayIso]
 * @returns {{start_iso: string, end_iso: string, label: string} | null}
 */
function resolveRelativePhrase(phrase, todayIso = todaySgtIso()) {
  const p = String(phrase || "")
    .trim()
    .toLowerCase();
  if (!p) return null;

  const today = new Date(todayIso + "T00:00:00Z");
  const yesterday = new Date(today);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const tomorrow = new Date(today);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);

  if (p === "today") return { start_iso: todayIso, end_iso: todayIso, label: "today" };
  if (p === "yesterday") {
    const iso = formatIso(yesterday);
    return { start_iso: iso, end_iso: iso, label: "yesterday" };
  }
  if (p === "tomorrow") {
    const iso = formatIso(tomorrow);
    return { start_iso: iso, end_iso: iso, label: "tomorrow" };
  }

  // ISO calendar week: Mon..Sun.
  const dayIdx = today.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const daysToMonday = dayIdx === 0 ? 6 : dayIdx - 1; // Sun→6, Mon→0, Tue→1, ...
  const thisWeekStart = new Date(today);
  thisWeekStart.setUTCDate(thisWeekStart.getUTCDate() - daysToMonday);
  const thisWeekEnd = new Date(thisWeekStart);
  thisWeekEnd.setUTCDate(thisWeekEnd.getUTCDate() + 6);
  const lastWeekStart = new Date(thisWeekStart);
  lastWeekStart.setUTCDate(lastWeekStart.getUTCDate() - 7);
  const lastWeekEnd = new Date(thisWeekStart);
  lastWeekEnd.setUTCDate(lastWeekEnd.getUTCDate() - 1);

  if (p === "this week") {
    return { start_iso: formatIso(thisWeekStart), end_iso: formatIso(thisWeekEnd), label: "this week" };
  }
  if (p === "last week") {
    return { start_iso: formatIso(lastWeekStart), end_iso: formatIso(lastWeekEnd), label: "last week" };
  }

  // Calendar month.
  const thisMonthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const thisMonthEnd = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0));
  const lastMonthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
  const lastMonthEnd = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0));

  if (p === "this month") {
    return { start_iso: formatIso(thisMonthStart), end_iso: formatIso(thisMonthEnd), label: "this month" };
  }
  if (p === "last month") {
    return { start_iso: formatIso(lastMonthStart), end_iso: formatIso(lastMonthEnd), label: "last month" };
  }

  // "past N days" / "last N days" → today minus N to today.
  const pastDaysMatch = p.match(/^(?:past|last)\s+(\d{1,3})\s+days?$/);
  if (pastDaysMatch) {
    const n = parseInt(pastDaysMatch[1], 10);
    if (n >= 1) {
      const start = new Date(today);
      start.setUTCDate(start.getUTCDate() - (n - 1));
      return { start_iso: formatIso(start), end_iso: todayIso, label: `the past ${n} days` };
    }
  }

  return null;
}

/**
 * Build the date-context string injected into the parser's system prompt
 * so the LLM resolves relative phrases deterministically.
 * @param {string} [todayIso]
 * @returns {string}
 */
function buildDateContextPrompt(todayIso = todaySgtIso()) {
  const today = new Date(todayIso + "T00:00:00Z");
  const dayIdx = today.getUTCDay();
  const daysToMonday = dayIdx === 0 ? 6 : dayIdx - 1;

  const yesterday = new Date(today);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);

  const thisWeekStart = new Date(today);
  thisWeekStart.setUTCDate(thisWeekStart.getUTCDate() - daysToMonday);
  const thisWeekEnd = new Date(thisWeekStart);
  thisWeekEnd.setUTCDate(thisWeekEnd.getUTCDate() + 6);
  const lastWeekStart = new Date(thisWeekStart);
  lastWeekStart.setUTCDate(lastWeekStart.getUTCDate() - 7);
  const lastWeekEnd = new Date(thisWeekStart);
  lastWeekEnd.setUTCDate(lastWeekEnd.getUTCDate() - 1);

  const thisMonthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const thisMonthEnd = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0));
  const lastMonthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
  const lastMonthEnd = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0));

  return [
    `Date context (SGT, UTC+8). Resolve all relative date expressions using these pre-computed anchors — never compute your own:`,
    `  Today        = ${todayIso} (${DAY_OF_WEEK[dayIdx]})`,
    `  Yesterday    = ${formatIso(yesterday)}`,
    `  This week    = ${formatIso(thisWeekStart)} (Mon) to ${formatIso(thisWeekEnd)} (Sun)`,
    `  Last week    = ${formatIso(lastWeekStart)} (Mon) to ${formatIso(lastWeekEnd)} (Sun)`,
    `  This month   = ${formatIso(thisMonthStart)} to ${formatIso(thisMonthEnd)}`,
    `  Last month   = ${formatIso(lastMonthStart)} to ${formatIso(lastMonthEnd)}`,
  ].join("\n");
}

module.exports = {
  MONTHS,
  DAY_OF_WEEK,
  todaySgtIso,
  formatIso,
  isoToDdMmm,
  ddMmmToIso,
  dayOfWeek,
  formatDayLabel,
  isoDaysInRange,
  resolveRelativePhrase,
  buildDateContextPrompt,
};
