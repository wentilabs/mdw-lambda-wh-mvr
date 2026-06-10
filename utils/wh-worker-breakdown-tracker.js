/**
 * WH Worker Breakdown Tracker
 *
 * Queries Supabase whatsapp_listener for "WH Workers Manpower" compact-format
 * messages on a given date and parses the breakdown fields:
 *   • Total (TOTAL REGISTER)
 *   • Workers on site
 *   • Home leave / H/Leave / HL
 *   • Loan out / Loan to ANY
 *   • Loan in / Loan from ANY
 *   • Course
 *   • Medical leave / MC
 *   • Absent
 *
 * The on-site count is already saved to the Manpower sheet by the webhook handler
 * (createWohhupManpowerData). This tracker provides the OTHER fields that the
 * daily manpower image needs to populate the WHPL register block (rows 9-15)
 * so the on-site formula at E16 displays correctly.
 *
 * Mirrors the wh-staff-tracker.js pattern: text regex on Supabase data, no LLM.
 *
 * Message format example:
 *   *MBS- IR2 MANPOWER*
 *   *Company: Woh Hup*
 *   *Date: 29/04/2026*
 *   *Day: WEDNESDAY*
 *
 *    *WH Workers Manpower*
 *   Total: 27
 *   * Workers on site: 6
 *   * Home leave: 1
 *   * Loan out: 20
 */

const { getSupabaseClient } = require("./common");

// Wohhup manpower messages are only sent in the Internal Site Team chat.
// SAFETY group is excluded — see wh-engineering-tracker.js for rationale.
const TARGET_CHAT_IDS = [
  "120363408413581964@g.us", // MBS IR2 - Internal Site Team
];
const PRIMARY_CLIENT_ID = "6587842038";

const MONTH_MAP = {
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

/**
 * Convert "DD-MMM-YYYY" to a Unix timestamp range covering that day in SGT.
 */
function getSGTDayRange(dateStr) {
  const m = String(dateStr || "").match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const monthIdx = MONTH_MAP[m[2].toLowerCase()];
  const year = parseInt(m[3], 10);
  if (!Number.isInteger(day) || !Number.isInteger(monthIdx) || !Number.isInteger(year)) return null;

  const sgtMidnight = Date.UTC(year, monthIdx, day) - 8 * 3600 * 1000;
  return {
    startTs: Math.floor(sgtMidnight / 1000),
    endTs: Math.floor(sgtMidnight / 1000) + 86400 - 1,
  };
}

/**
 * Strip markdown bold and normalize whitespace, then parse breakdown fields.
 * Returns null if the body is not parseable as a WH Workers Manpower compact
 * format (no "WH Workers Manpower" header).
 *
 * Returns numeric fields with default 0 when not present in the message.
 */
function parseWorkerBreakdown(body) {
  if (!body) return null;
  const clean = String(body)
    .replace(/\*/g, "")
    .replace(/[ \t]+/g, " ");
  if (!/wh\s+workers\s+manpower/i.test(clean)) return null;

  // Helper: matches "label: NN" or "label : NN" or "label= NN" with optional bullet "*" / "·" / dash prefix
  // Returns NN as integer, or null if not found.
  const findCount = (labelRegex) => {
    const re = new RegExp(`(?:^|\\n)\\s*[*·•\\-\\u2060\\u2063]?\\s*${labelRegex}\\s*[:=]\\s*(\\d{1,4})\\b`, "i");
    const m = clean.match(re);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    return Number.isInteger(n) ? n : null;
  };

  // Label-tolerant patterns. Wohhup has shipped at least these variants:
  //   "Total Register: NN" / "Total: NN"           (older format)
  //   "WH Register: NN"    / "Register: NN"         (2026-05-10 onwards)
  //   "Workers on site: NN" / "Total on site: NN"   (interchangeable)
  // If the parser misses any of these, downstream renderers default the field
  // to 0 and the on-site formula goes negative — which is the prod bug we hit
  // on 2026-05-10 (rendered −29). Keep the OR-chain wide.
  const totalRegister =
    findCount("total\\s+register") ?? findCount("wh\\s+register") ?? findCount("register") ?? findCount("total");
  const workersOnSite =
    findCount("workers?\\s+on\\s+site") ??
    findCount("total\\s+on\\s+site") ??
    findCount("on\\s+site\\s+total") ??
    findCount("on\\s+site");
  const homeLeave = findCount("home\\s+leave") ?? findCount("h\\s*/\\s*leave") ?? findCount("hl");
  const loanOut = findCount("loan\\s+out") ?? findCount("loan\\s+to\\s+\\w+");
  const loanIn = findCount("loan\\s+in") ?? findCount("loan\\s+from\\s+\\w+");
  const course = findCount("course");
  const medicalLeave = findCount("medical\\s+leave") ?? findCount("mc");
  const absent = findCount("absent");
  // Night-shift workers STATED inline in the message (e.g. "Night Shift: 04").
  // These are deployed workers reported on the same message as the day
  // "Workers on site" line — read DIRECTLY from the message, never derived.
  // Added to the deployed total in getWHWorkerBreakdown (with a guard so a
  // separate night-shift message is never double-counted).
  const nightShift = findCount("night\\s+shift");

  // Need at least one breakdown field to consider this a valid parse.
  const anyField = [
    totalRegister,
    workersOnSite,
    homeLeave,
    loanOut,
    loanIn,
    course,
    medicalLeave,
    absent,
    nightShift,
  ].some((v) => v !== null);
  if (!anyField) return null;

  return {
    totalRegister: totalRegister ?? 0,
    workersOnSite: workersOnSite ?? 0,
    homeLeave: homeLeave ?? 0,
    loanOut: loanOut ?? 0,
    loanIn: loanIn ?? 0,
    course: course ?? 0,
    medicalLeave: medicalLeave ?? 0,
    absent: absent ?? 0,
    nightShift: nightShift ?? 0,
  };
}

/**
 * Get the WH Workers Manpower breakdown for a specific date.
 *
 * @param {string} searchDate - "DD-MMM-YYYY" (e.g. "29-Apr-2026")
 * @returns {Promise<{
 *   totalRegister: number,
 *   workersOnSite: number,
 *   homeLeave: number,
 *   loanOut: number,
 *   loanIn: number,
 *   course: number,
 *   medicalLeave: number,
 *   absent: number,
 *   messageId: string,
 *   timestamp: number,
 * } | null>}
 */
async function getWHWorkerBreakdown(searchDate) {
  const range = getSGTDayRange(searchDate);
  if (!range) {
    console.log(`[WH Worker Tracker] Invalid date format: ${searchDate}`);
    return null;
  }

  try {
    const supabase = getSupabaseClient();
    // Bucket strictly by SGT timestamp day. Body Date label is unreliable.
    const { data, error } = await supabase
      .from("whatsapp_listener")
      .select("body, messageId, timestamp, chatId")
      .in("chatId", TARGET_CHAT_IDS)
      .eq("clientIdentifier", PRIMARY_CLIENT_ID)
      .gte("timestamp", range.startTs)
      .lte("timestamp", range.endTs)
      .ilike("body", "%WH Workers Manpower%")
      .order("timestamp", { ascending: false });

    if (error) {
      console.error(`[WH Worker Tracker] Supabase error:`, error.message);
      return null;
    }

    if (!data || data.length === 0) {
      console.log(`[WH Worker Tracker] No WH Workers Manpower message found for ${searchDate}`);
      return null;
    }

    // Day + Night are ACCUMULATIVE (different workers per shift).
    //   • "( Night shift )" / "(Night shift)" parens marker
    //   • "Night: <Day>" header
    //   • Posted timestamp ≥ 19:00 SGT (7 PM heuristic — late posts even
    //     without explicit annotation are night-shift)
    const isNightShiftBody = (body) =>
      /\(\s*night\s+shift\s*\)/i.test(String(body || "")) || /\bnight\s*:/i.test(String(body || ""));
    const sgtHour = (timestamp) => new Date((timestamp + 8 * 3600) * 1000).getUTCHours();
    const isNightShift = (msg) => isNightShiftBody(msg.body) || sgtHour(msg.timestamp) >= 19;

    let latestDay = null;
    let latestNight = null;
    for (const msg of [...data].sort((a, b) => b.timestamp - a.timestamp)) {
      const parsed = parseWorkerBreakdown(msg.body);
      if (!parsed) continue;
      if (isNightShift(msg)) {
        if (!latestNight) latestNight = { parsed, msg };
      } else {
        if (!latestDay) latestDay = { parsed, msg };
      }
      if (latestDay && latestNight) break;
    }

    if (!latestDay && !latestNight) {
      console.log(`[WH Worker Tracker] Found ${data.length} candidate(s) but none parseable for ${searchDate}`);
      return null;
    }

    // Sum every numeric register field across the two shifts. Where one shift
    // is absent its contribution is 0.
    const sumField = (key) => (latestDay?.parsed[key] || 0) + (latestNight?.parsed[key] || 0);
    const summed = {
      totalRegister: sumField("totalRegister"),
      workersOnSite: sumField("workersOnSite"),
      homeLeave: sumField("homeLeave"),
      loanOut: sumField("loanOut"),
      loanIn: sumField("loanIn"),
      course: sumField("course"),
      medicalLeave: sumField("medicalLeave"),
      absent: sumField("absent"),
    };

    // Night-shift workers STATED inline (e.g. "Night Shift: 04") in a message.
    // When there is NO separate night-shift message, that inline figure is the
    // only record of the night crew — add it to the deployed total (read
    // straight from the message, never derived). When a separate night message
    // exists, its own `workersOnSite` already counts the night crew, so the
    // inline figure is ignored to avoid double-counting.
    const inlineNightWorkers = latestNight ? 0 : latestDay?.parsed.nightShift || 0;
    summed.workersOnSite += inlineNightWorkers;

    console.log(
      `[WH Worker Tracker] Found WH Workers for ${searchDate}: ` +
        `Day onSite=${latestDay?.parsed.workersOnSite || 0}, Night onSite=${latestNight?.parsed.workersOnSite || 0}, ` +
        `inlineNight=${inlineNightWorkers}, Total onSite=${summed.workersOnSite}`,
    );

    return {
      ...summed,
      dayOnSite: latestDay?.parsed.workersOnSite || 0,
      nightOnSite: (latestNight?.parsed.workersOnSite || 0) + inlineNightWorkers,
      messageId: (latestNight || latestDay).msg.messageId,
      timestamp: (latestNight || latestDay).msg.timestamp,
    };
  } catch (e) {
    console.error(`[WH Worker Tracker] Unexpected error:`, e.message);
    return null;
  }
}

/**
 * Range variant — fetch every WH Workers Manpower message in [startIso, endIso]
 * (inclusive ISO YYYY-MM-DD) and return per-day parsed breakdowns.
 *
 * @param {string} startIso - "YYYY-MM-DD"
 * @param {string} endIso   - "YYYY-MM-DD"
 * @returns {Promise<Map<string, {totalRegister, workersOnSite, homeLeave, loanOut, loanIn, course, medicalLeave, absent, messageId, timestamp}>>}
 *          Map keyed by date ISO. Days with no parseable message are absent.
 */
async function getWHWorkerBreakdownForRange(startIso, endIso) {
  const isoToTs = (iso) => Math.floor(new Date(iso + "T00:00:00+08:00").getTime() / 1000);
  const startTs = isoToTs(startIso);
  const endTs = isoToTs(endIso) + 86400 - 1;
  const out = new Map();
  if (!Number.isFinite(startTs) || !Number.isFinite(endTs) || startTs > endTs) return out;
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from("whatsapp_listener")
      .select("body, messageId, timestamp, chatId")
      .in("chatId", TARGET_CHAT_IDS)
      .eq("clientIdentifier", PRIMARY_CLIENT_ID)
      .gte("timestamp", startTs)
      .lte("timestamp", endTs)
      .ilike("body", "%WH Workers Manpower%")
      .order("timestamp", { ascending: false });
    if (error) {
      console.error(`[WH Worker Tracker] Range Supabase error:`, error.message);
      return out;
    }
    // Bucket by SGT timestamp day (NOT body Date label).
    const isNightShift = (body) => /\(\s*night\s+shift\s*\)/i.test(String(body || ""));
    const buckets = new Map();
    for (const msg of data || []) {
      const sgtDayIso = new Date((msg.timestamp + 8 * 3600) * 1000).toISOString().slice(0, 10);
      if (sgtDayIso < startIso || sgtDayIso > endIso) continue;
      if (!buckets.has(sgtDayIso)) buckets.set(sgtDayIso, { day: [], night: [] });
      const slot = isNightShift(msg.body) ? "night" : "day";
      buckets.get(sgtDayIso)[slot].push(msg);
    }
    for (const [dayIso, slots] of buckets) {
      const candidates = slots.day.length > 0 ? slots.day : slots.night;
      for (const msg of candidates) {
        const parsed = parseWorkerBreakdown(msg.body);
        if (parsed) {
          out.set(dayIso, { ...parsed, messageId: msg.messageId, timestamp: msg.timestamp });
          break;
        }
      }
    }
    return out;
  } catch (e) {
    console.error(`[WH Worker Tracker] Range unexpected error:`, e.message);
    return out;
  }
}

module.exports = {
  getWHWorkerBreakdown,
  getWHWorkerBreakdownForRange,
  parseWorkerBreakdown,
  getSGTDayRange,
};
