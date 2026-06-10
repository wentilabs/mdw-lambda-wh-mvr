/**
 * QA-agent-owned Safety Summary bypass.
 *
 * Produces the SAME canonical message the EventBridge cron sends (see
 * api/daily-safety-summary.js's generateSafetySummaryMessage), but:
 *
 *   1. Owned by the QA agent — does NOT call the cron API. The cron path
 *      stays completely untouched so its behaviour can never break from
 *      QA-side changes.
 *   2. Supports BOTH single dates AND date ranges. Single-date output is
 *      byte-identical (modulo wall-clock time) to the cron message. Range
 *      output extends the same shape — header carries the range, totals
 *      sum across the range, and the "Open issues by date" section lists
 *      every day in the range that has open issues.
 *   3. Caches the messageFull per (startIso|endIso|chatId) so the QA bank
 *      5-runs-per-question consistency test stays byte-identical. Without
 *      caching the wall-clock SGT timestamp in the header would drift
 *      between minute boundaries and the test would fail.
 *
 * The numbers in the message are ALL produced here (no LLM math) from the
 * Safety sheet rows fetched via runSQLQuery — same data source the cron uses.
 */

const { runSQLQuery } = require("../../../utils/action");

// In-process cache so the consistency test (5 identical runs in a row)
// returns byte-identical output. Key = `${startIso}|${endIso}|${chatId}`.
// FIFO eviction at MAX entries; on Lambda cold start the cache is empty
// again — identical to how the cron behaves (one send per invocation).
const SAFETY_SUMMARY_CACHE = new Map();
const SAFETY_SUMMARY_CACHE_MAX = 200;

const MONTHS_LC = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_MAP = MONTHS_LC.reduce((m, mmm, i) => ((m[mmm] = i), m), {});

function pad2(n) {
  return String(n).padStart(2, "0");
}

function isoToDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function dateToIso(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function isoToDDMMMYYYY(iso) {
  const d = isoToDate(iso);
  return `${pad2(d.getDate())}-${MONTHS_LC[d.getMonth()]}-${d.getFullYear()}`;
}

function isoToShortDDMMM(iso) {
  const d = isoToDate(iso);
  return `${pad2(d.getDate())}-${MONTHS_LC[d.getMonth()].replace(/^./, (c) => c.toUpperCase())}`;
}

function ddmmmyyyyToIso(s) {
  const [dd, mmm, yyyy] = String(s || "").split("-");
  const mi = MONTH_MAP[String(mmm || "").toLowerCase()];
  if (mi == null || !dd || !yyyy) return null;
  return `${yyyy}-${pad2(mi + 1)}-${pad2(parseInt(dd, 10))}`;
}

/**
 * Today's date in SGT as DD-MMM-YYYY (e.g. "27-May-2026"). Used in the
 * snapshot footer so the recipient can see the answer was generated TODAY
 * even when the data window is for an earlier date.
 */
function formatTodaySGTDate() {
  // en-GB gives "27 May 2026"; swap spaces for hyphens to get "27-May-2026".
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Singapore",
    day: "2-digit",
    month: "short",
    year: "numeric",
  })
    .format(new Date())
    .replace(/ /g, "-");
}

/**
 * Current SGT wall-clock time as "h:mm AM/PM" (e.g. "2:13 PM"). Paired
 * with formatTodaySGTDate in the snapshot footer.
 */
function formatNowSGTTime() {
  return new Date().toLocaleTimeString("en-US", {
    timeZone: "Asia/Singapore",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/**
 * The italic "Snapshot generated …" footer. WhatsApp renders `_text_` as
 * italic. Carries the FULL snapshot moment (date + SGT time) so the user
 * always knows when the answer was generated, even if the data window is
 * earlier. The parent message is cached, so this stays byte-identical
 * across the 5-runs consistency loop.
 */
function snapshotFooter() {
  return `_Snapshot generated ${formatTodaySGTDate()}, ${formatNowSGTTime()}_`;
}

/**
 * Cron uses dd-MMM-YYYY display format with the FIRST letter capitalised
 * (e.g. "08-May-2026"). Mirror that exactly so single-date output matches
 * the cron message byte-for-byte.
 */
function isoToCronDisplay(iso) {
  const d = isoToDate(iso);
  const mmm = MONTHS_LC[d.getMonth()];
  const mmmCap = mmm.charAt(0).toUpperCase() + mmm.slice(1);
  return `${pad2(d.getDate())}-${mmmCap}-${d.getFullYear()}`;
}

/**
 * Map sheet-stored Severity value to the canonical P1/P2/P3 priority used
 * in the cron message. Mirrors api/daily-safety-summary.js's
 * normalizeSeverityPriority so totals match.
 */
function severityToPriority(raw) {
  const s = String(raw || "")
    .trim()
    .toLowerCase();
  if (s.startsWith("p1") || s === "1" || s.includes("priority 1") || s === "high" || s === "h") return "P1";
  if (s.startsWith("p2") || s === "2" || s.includes("priority 2") || s === "medium" || s === "mid" || s === "m")
    return "P2";
  if (s.startsWith("p3") || s === "3" || s.includes("priority 3") || s === "low" || s === "l") return "P3";
  if (s.startsWith("h")) return "P1";
  if (s.startsWith("m")) return "P2";
  if (s.startsWith("l")) return "P3";
  return "Unknown";
}

/**
 * Fetch safety rows for an ISO date range (inclusive). Uses the same
 * SQL plumbing as the analytical safety domain so the data source stays
 * unified.
 */
async function fetchSafetyRows(startIso, endIso, groupConfig) {
  const where = startIso === endIso ? `[Date] = '${startIso}'` : `[Date] >= '${startIso}' AND [Date] <= '${endIso}'`;
  const cols = "[S/N], [Date], [Severity], [Status]";
  const rows = (await runSQLQuery(`SELECT ${cols} FROM safetyData WHERE ${where}`, "safety", { groupConfig })) || [];
  return rows.map((r) => ({
    date: String(r.Date || "").trim(),
    severity: severityToPriority(r.Severity),
    status: String(r.Status || "")
      .trim()
      .toLowerCase(),
  }));
}

function emptyAgg() {
  return { total: 0, open: 0, p1: 0, p2: 0, p3: 0 };
}

function aggregateRows(rows) {
  // Per-day breakdown (for the "Open issues by date" section) AND
  // overall totals across all rows passed in.
  const overall = emptyAgg();
  const perDay = new Map(); // iso → agg
  for (const r of rows) {
    overall.total++;
    if (!perDay.has(r.date)) perDay.set(r.date, emptyAgg());
    const day = perDay.get(r.date);
    day.total++;
    if (r.status === "open") {
      overall.open++;
      day.open++;
      if (r.severity === "P1") {
        overall.p1++;
        day.p1++;
      } else if (r.severity === "P2") {
        overall.p2++;
        day.p2++;
      } else if (r.severity === "P3") {
        overall.p3++;
        day.p3++;
      }
    }
  }
  return { overall, perDay };
}

/**
 * Single-date message — byte-identical to the cron's
 * generateSafetySummaryMessage shape. Includes the "Open issues by date:"
 * historical section (4 days back from the search date) so customers
 * see the same recap they're used to.
 */
async function buildSingleDateMessage(searchIso, groupConfig) {
  const todayRows = await fetchSafetyRows(searchIso, searchIso, groupConfig);
  const { overall: today } = aggregateRows(todayRows);

  // Historical: previous 4 days, only show days with open issues.
  const historical = [];
  const base = isoToDate(searchIso);
  for (let i = 1; i <= 4; i++) {
    const d = new Date(base);
    d.setDate(d.getDate() - i);
    const iso = dateToIso(d);
    const rows = await fetchSafetyRows(iso, iso, groupConfig);
    const { overall } = aggregateRows(rows);
    if (overall.open > 0) historical.push({ iso, ...overall });
  }

  const lines = [
    `MBS IR2 Project`,
    `Safety Issues Summary (as of ${isoToCronDisplay(searchIso)})`,
    ``,
    `Total issues reported: ${today.total}`,
    `Open issues: ${today.open} (${today.p1} P1, ${today.p2} P2, ${today.p3} P3)`,
    ``,
    `Open issues by date:`,
  ];
  for (const h of historical) {
    const parts = [];
    if (h.p1) parts.push(`${h.p1} P1`);
    if (h.p2) parts.push(`${h.p2} P2`);
    if (h.p3) parts.push(`${h.p3} P3`);
    const sev = parts.length ? ` (${parts.join(", ")})` : "";
    lines.push(`${isoToShortDDMMM(h.iso)}: ${h.open}${sev}`);
  }
  lines.push(``);
  lines.push(snapshotFooter());
  return lines.join("\n");
}

/**
 * Range message — same shape as single-date, but:
 *   • Header carries the range label and start..end dates
 *   • Total / open counts are summed across the range
 *   • "Open issues by date:" lists every day IN the range with open issues
 *     (no extra 4-day historical lookback — the range IS the lookback)
 */
async function buildRangeMessage(startIso, endIso, rangeLabel, groupConfig) {
  const rows = await fetchSafetyRows(startIso, endIso, groupConfig);
  const { overall, perDay } = aggregateRows(rows);

  // Order days newest → oldest so the most recent day appears first
  // (matches the cron's per-day section ordering).
  const days = Array.from(perDay.entries())
    .filter(([, agg]) => agg.open > 0)
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0));

  const startDisp = isoToCronDisplay(startIso);
  const endDisp = isoToCronDisplay(endIso);
  // Only prefix with the parser's label when it's a friendly natural-language
  // tag like "this week" / "last month" / "past 7 days". Skip when the label
  // already contains a date (e.g. "from 2026-05-15 to 2026-05-18") — that
  // would render as "from 2026-05-15 to 2026-05-18: 15-May-2026 to 18-May-2026".
  const isFriendlyLabel = rangeLabel && !/\d/.test(rangeLabel) && !/^\s*from\s+/i.test(rangeLabel);
  const labelPart = isFriendlyLabel ? `${rangeLabel}: ` : "";
  const headerWindow = `${labelPart}${startDisp} to ${endDisp}`;

  const lines = [
    `MBS IR2 Project`,
    `Safety Issues Summary (${headerWindow})`,
    ``,
    `Total issues reported: ${overall.total}`,
    `Open issues: ${overall.open} (${overall.p1} P1, ${overall.p2} P2, ${overall.p3} P3)`,
    ``,
    `Open issues by date:`,
  ];
  for (const [iso, agg] of days) {
    const parts = [];
    if (agg.p1) parts.push(`${agg.p1} P1`);
    if (agg.p2) parts.push(`${agg.p2} P2`);
    if (agg.p3) parts.push(`${agg.p3} P3`);
    const sev = parts.length ? ` (${parts.join(", ")})` : "";
    lines.push(`${isoToShortDDMMM(iso)}: ${agg.open}${sev}`);
  }
  lines.push(``);
  lines.push(snapshotFooter());
  return lines.join("\n");
}

/**
 * Public entry. Returns a single string (the messageFull) the bypass
 * dispatcher can hand straight back to WhatsApp.
 *
 * @param {Object} opts
 * @param {string} opts.startIso  - ISO date (YYYY-MM-DD). Required.
 * @param {string} opts.endIso    - ISO date (YYYY-MM-DD). Same as startIso for single date.
 * @param {string} [opts.rangeLabel] - Human label like "this week" / "last month". Used in header for ranges only.
 * @param {string} [opts.chatId]  - WhatsApp chat ID, part of cache key.
 * @param {Object} opts.groupConfig - Group config for runSQLQuery.
 */
async function buildSafetySummaryMessage({ startIso, endIso, rangeLabel, chatId, groupConfig }) {
  if (!startIso || !endIso) throw new Error("buildSafetySummaryMessage: startIso/endIso required");

  const key = `${startIso}|${endIso}|${chatId || ""}`;
  const cached = SAFETY_SUMMARY_CACHE.get(key);
  if (cached) return cached;

  const message =
    startIso === endIso
      ? await buildSingleDateMessage(startIso, groupConfig)
      : await buildRangeMessage(startIso, endIso, rangeLabel, groupConfig);

  if (SAFETY_SUMMARY_CACHE.size >= SAFETY_SUMMARY_CACHE_MAX) {
    SAFETY_SUMMARY_CACHE.delete(SAFETY_SUMMARY_CACHE.keys().next().value);
  }
  SAFETY_SUMMARY_CACHE.set(key, message);
  return message;
}

module.exports = {
  buildSafetySummaryMessage,
  // Public helpers reused by sibling bypass handlers (novade_sync etc.) so the
  // snapshot footer stays visually consistent across QA-agent replies.
  snapshotFooter,
  // Exported for testing
  __test: { SAFETY_SUMMARY_CACHE, isoToCronDisplay, severityToPriority, ddmmmyyyyToIso },
};
