/**
 * WH Staff TS/NTS Tracker
 *
 * Queries Supabase whatsapp_listener for "WH Staff Manpower" short messages
 * sent to MBS IR2 - Internal Site Team group, parses Staff TS/NTS counts.
 *
 * Message format:
 *   *MBS- IR2 MANPOWER*
 *   *Company: Woh Hup*
 *   *Date: 24/04/2026*
 *   *Day: Friday*
 *   · *WH Staff Manpower*
 *   Staff TS= 17
 *   Staff NTS= 06
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
 * @param {string} dateStr - e.g. "24-Apr-2026"
 * @returns {{startTs: number, endTs: number} | null}
 */
function getSGTDayRange(dateStr) {
  const m = String(dateStr || "").match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) return null;

  const day = parseInt(m[1], 10);
  const monthIdx = MONTH_MAP[m[2].toLowerCase()];
  const year = parseInt(m[3], 10);
  if (!Number.isInteger(day) || !Number.isInteger(monthIdx) || !Number.isInteger(year)) return null;

  // SGT is UTC+8, so day 00:00 SGT = previous day 16:00 UTC
  const sgtMidnight = Date.UTC(year, monthIdx, day) - 8 * 3600 * 1000;
  return {
    startTs: Math.floor(sgtMidnight / 1000),
    endTs: Math.floor(sgtMidnight / 1000) + 86400 - 1,
  };
}

/**
 * Parse Staff TS and Staff NTS values from message body.
 *
 * Handles bold markdown (*17*), spaces around `=` / `:`, "NIL" → 0.
 *
 * On-site priority (mirrors WH Workers / WH Engineering rule):
 *   - If the message contains "Staff TS on site" / "Staff NTS on site" lines
 *     (with `=` or `:`), those are the AUTHORITATIVE on-site counts and the
 *     plain `Staff TS = N` / `Staff NTS = N` lines (which would be the
 *     register totals in that format) are ignored.
 *   - Otherwise fall back to `Staff TS [:=] N` / `Staff NTS [:=] N` lines.
 *     Both `=` and `:` separators are accepted — Wohhup ships both
 *     variants (e.g. "Staff TS= 17" or "Staff TS: 03"); failing to match
 *     either silently dropped the staff total in past prod incidents.
 *
 * Non-on-site lines (Total / Home leave / Loan out / Absent / Course / MC) are
 * not matched by these regexes — they're effectively ignored.
 */
function parseStaffCounts(body) {
  if (!body) return null;
  const clean = String(body).replace(/\*/g, "");

  // On-site lines first (priority).
  const tsOnSite = clean.match(/Staff\s*TS\s*on\s*site\s*[:=]\s*([A-Za-z0-9]+)/i);
  const ntsOnSite = clean.match(/Staff\s*NTS\s*on\s*site\s*[:=]\s*([A-Za-z0-9]+)/i);

  // Fallback: `Staff TS = N` / `Staff TS: N` (only when no on-site line).
  // Accept both `=` and `:` as separators — Wohhup ships both variants.
  const tsMatch = tsOnSite || clean.match(/Staff\s*TS\s*[:=]\s*([A-Za-z0-9]+)/i);
  const ntsMatch = ntsOnSite || clean.match(/Staff\s*NTS\s*[:=]\s*([A-Za-z0-9]+)/i);

  if (!tsMatch || !ntsMatch) return null;

  const parseValue = (raw) => {
    const v = String(raw).trim().toUpperCase();
    if (v === "NIL" || v === "N/A" || v === "-") return 0;
    const num = parseInt(v, 10);
    return Number.isNaN(num) ? null : num;
  };

  const staffTS = parseValue(tsMatch[1]);
  const staffNTS = parseValue(ntsMatch[1]);
  if (staffTS === null || staffNTS === null) return null;

  return { staffTS, staffNTS };
}

/**
 * Get the WH Staff TS/NTS counts for a specific date.
 * Bucketing: SGT timestamp day. Body Date label is ignored.
 * @param {string} searchDate - "DD-MMM-YYYY" (e.g. "24-Apr-2026")
 * @returns {Promise<{staffTS: number, staffNTS: number, messageId: string, timestamp: number} | null>}
 */
async function getWHStaffTSNTS(searchDate) {
  const range = getSGTDayRange(searchDate);
  if (!range) {
    console.log(`[WH Staff Tracker] Invalid date format: ${searchDate}`);
    return null;
  }

  try {
    const supabase = getSupabaseClient();
    // Bucket strictly by SGT timestamp day. Body Date label is unreliable
    // (workers sometimes type the wrong date) — when the message landed is
    // the source of truth.
    const { data, error } = await supabase
      .from("whatsapp_listener")
      .select("body, messageId, timestamp, chatId")
      .in("chatId", TARGET_CHAT_IDS)
      .eq("clientIdentifier", PRIMARY_CLIENT_ID)
      .gte("timestamp", range.startTs)
      .lte("timestamp", range.endTs)
      .ilike("body", "%WH Staff Manpower%")
      .order("timestamp", { ascending: false });

    if (error) {
      console.error(`[WH Staff Tracker] Supabase error:`, error.message);
      return null;
    }

    if (!data || data.length === 0) {
      console.log(`[WH Staff Tracker] No WH Staff message found for ${searchDate}`);
      return null;
    }

    // Day + Night are ACCUMULATIVE. Wohhup posts ONE Staff message per shift
    // (morning = Day, evening = Night). Different people, different shifts —
    // the day's total = Day_count + Night_count. Never "pick one".
    //
    // Night-shift detection (any of):
    //   • "( Night shift )" / "(Night shift)" parens marker
    //   • "Night: <Day>" header
    //   • Posted timestamp ≥ 19:00 SGT (7 PM cutoff — late post even without
    //     explicit annotation is a night-shift posting, as seen on Sunday
    //     2026-05-10 where the 21:50 message kept the "Day: Sunday" label)
    const isNightShiftBody = (body) =>
      /\(\s*night\s+shift\s*\)/i.test(String(body || "")) || /\bnight\s*:/i.test(String(body || ""));
    const sgtHour = (timestamp) => {
      const sgtMs = (timestamp + 8 * 3600) * 1000;
      return new Date(sgtMs).getUTCHours();
    };
    const isNightShift = (msg) => isNightShiftBody(msg.body) || sgtHour(msg.timestamp) >= 19;

    // Pick latest within each shift cohort. Latest correction wins inside the
    // same shift; the two cohorts then accumulate.
    let latestDay = null;
    let latestNight = null;
    for (const msg of [...data].sort((a, b) => b.timestamp - a.timestamp)) {
      const parsed = parseStaffCounts(msg.body);
      if (!parsed) continue;
      if (isNightShift(msg)) {
        if (!latestNight) latestNight = { parsed, msg };
      } else {
        if (!latestDay) latestDay = { parsed, msg };
      }
      if (latestDay && latestNight) break;
    }

    if (!latestDay && !latestNight) {
      console.log(`[WH Staff Tracker] Found ${data.length} candidate messages but none parseable for ${searchDate}`);
      return null;
    }

    const dayTS = latestDay?.parsed.staffTS ?? 0;
    const dayNTS = latestDay?.parsed.staffNTS ?? 0;
    const nightTS = latestNight?.parsed.staffTS ?? 0;
    const nightNTS = latestNight?.parsed.staffNTS ?? 0;
    const totalTS = dayTS + nightTS;
    const totalNTS = dayNTS + nightNTS;

    console.log(
      `[WH Staff Tracker] Found WH Staff for ${searchDate}: ` +
        `Day TS=${dayTS} NTS=${dayNTS} (${latestDay ? "msg=" + latestDay.msg.messageId.slice(-8) : "—"}), ` +
        `Night TS=${nightTS} NTS=${nightNTS} (${latestNight ? "msg=" + latestNight.msg.messageId.slice(-8) : "—"}), ` +
        `Total TS=${totalTS} NTS=${totalNTS}`,
    );

    return {
      staffTS: totalTS,
      staffNTS: totalNTS,
      dayStaffTS: dayTS,
      dayStaffNTS: dayNTS,
      nightStaffTS: nightTS,
      nightStaffNTS: nightNTS,
      messageId: (latestNight || latestDay).msg.messageId,
      timestamp: (latestNight || latestDay).msg.timestamp,
    };
  } catch (e) {
    console.error(`[WH Staff Tracker] Unexpected error:`, e.message);
    return null;
  }
}

/**
 * Range variant — fetch every WH Staff Manpower message in [startIso, endIso]
 * (inclusive, ISO YYYY-MM-DD) and return per-day parsed totals.
 *
 * @param {string} startIso - "YYYY-MM-DD"
 * @param {string} endIso   - "YYYY-MM-DD"
 * @returns {Promise<Map<string, {staffTS: number, staffNTS: number, messageId: string, timestamp: number}>>}
 *          Map keyed by date ISO. Days with no parseable message are absent from the map.
 */
async function getWHStaffForRange(startIso, endIso) {
  const isoToTs = (iso) => Math.floor(new Date(iso + "T00:00:00+08:00").getTime() / 1000);
  const startTs = isoToTs(startIso);
  const endTs = isoToTs(endIso) + 86400 - 1; // include the entire endIso day
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
      .ilike("body", "%WH Staff Manpower%")
      .order("timestamp", { ascending: false }); // newest first — matches single-day getWHStaffTSNTS
    if (error) {
      console.error(`[WH Staff Tracker] Range Supabase error:`, error.message);
      return out;
    }
    // Day-shift takes precedence over Night-shift on the same SGT day.
    // Wohhup posts a separate "( Night shift )" roster for the night crew —
    // never let it override the morning Day-shift number for that day.
    // Group messages by SGT calendar day, pick Day-shift if present (newest
    // among Day-shift), else Night-shift fallback.
    const isNightShift = (body) => /\(\s*night\s+shift\s*\)/i.test(String(body || ""));
    const buckets = new Map(); // dayIso → { day: [msg], night: [msg] } (each newest-first)
    for (const msg of data || []) {
      const dayIso = new Date((msg.timestamp + 8 * 3600) * 1000).toISOString().slice(0, 10);
      if (!buckets.has(dayIso)) buckets.set(dayIso, { day: [], night: [] });
      const slot = isNightShift(msg.body) ? "night" : "day";
      buckets.get(dayIso)[slot].push(msg);
    }
    for (const [dayIso, slots] of buckets) {
      const candidates = slots.day.length > 0 ? slots.day : slots.night;
      for (const msg of candidates) {
        const parsed = parseStaffCounts(msg.body);
        if (parsed) {
          out.set(dayIso, { ...parsed, messageId: msg.messageId, timestamp: msg.timestamp });
          break;
        }
      }
    }
    return out;
  } catch (e) {
    console.error(`[WH Staff Tracker] Range unexpected error:`, e.message);
    return out;
  }
}

module.exports = {
  getWHStaffTSNTS,
  getWHStaffForRange,
  parseStaffCounts,
  getSGTDayRange,
};
