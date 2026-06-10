/**
 * WH Engineering Worker-on-site Tracker
 *
 * Queries Supabase whatsapp_listener for "WH Engineering" short messages
 * (sent by ZH and similar engineers reporting headcount at site). Parses the
 * "Worker on site" value as the canonical Engineer count for the date.
 *
 * Standard message format:
 *   *MBS- IR2 MANPOWER*
 *   *Company: Woh Hup Engineering*
 *   *Date: 09/05/2026*
 *   *Day: SATURDAY*
 *   *WH Engineering*
 *   Workers = 02
 *   Absent =0
 *   Worker on site= 02
 *
 * The "Worker on site" line is the AUTHORITATIVE count; "Workers" minus
 * "Absent" should equal it but we always trust the explicit on-site value
 * to keep parity with how wh-worker-breakdown-tracker handles its on-site.
 *
 * Bucketing: by SGT timestamp day. The body's "Date: DD/MM/YYYY" label is
 * unreliable (workers sometimes type the wrong date) — when the message
 * landed in the chat is the source of truth.
 */

const { getSupabaseClient } = require("./common");

// Same chats as the other Wohhup trackers.
// Wohhup manpower messages are only sent in the Internal Site Team chat.
// The SAFETY group is intentionally excluded — it produces accidental dupes
// of the same body when crossposted, and the user has confirmed they only
// want this one chat as the source of truth for Wohhup numbers.
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
 * Parse the engineer on-site count from a WH Engineering message body.
 * Returns { onSite, total, absent } or null if not parseable.
 */
function parseEngineerCounts(body) {
  if (!body) return null;
  const clean = String(body).replace(/\*/g, "");
  if (!/wh\s+engineering/i.test(clean)) return null;

  const findCount = (labelRegex) => {
    const re = new RegExp(`(?:^|\\n)\\s*[*·•\\-\\u2060\\u2063]?\\s*${labelRegex}\\s*[:=]\\s*([0-9]+)\\b`, "i");
    const m = clean.match(re);
    return m ? parseInt(m[1], 10) : null;
  };

  // Trust on-site directly (priority) — same rule as the workers tracker.
  const onSite = findCount("workers?\\s+on\\s+site") ?? findCount("total\\s+on\\s+site") ?? findCount("on\\s+site");
  const total = findCount("workers?") ?? findCount("total") ?? findCount("engineer(s)?");
  const absent = findCount("absent");

  // Need at least one of (onSite | total) to be useful.
  if (onSite === null && total === null) return null;

  // Compute on-site fallback if not stated: total − absent (clamp at 0).
  let resolvedOnSite = onSite;
  if (resolvedOnSite === null && Number.isFinite(total)) {
    const derived = total - (absent || 0);
    resolvedOnSite = derived < 0 ? 0 : derived;
  }
  return {
    onSite: resolvedOnSite ?? 0,
    total: total ?? null,
    absent: absent ?? null,
  };
}

const isNightShift = (body) => /\(\s*night\s+shift\s*\)/i.test(String(body || ""));

/**
 * Get the WH Engineering Worker-on-site count for a specific date.
 * @param {string} searchDate - "DD-MMM-YYYY"
 * @returns {Promise<{onSite, total, absent, messageId, timestamp} | null>}
 */
async function getWHEngineerOnSite(searchDate) {
  const range = getSGTDayRange(searchDate);
  if (!range) return null;

  try {
    const supabase = getSupabaseClient();
    // Bucket strictly by SGT timestamp day. Body Date label is ignored — workers
    // sometimes type the wrong date in the body but the timestamp is the truth.
    const { data, error } = await supabase
      .from("whatsapp_listener")
      .select("body, messageId, timestamp, chatId")
      .in("chatId", TARGET_CHAT_IDS)
      .eq("clientIdentifier", PRIMARY_CLIENT_ID)
      .gte("timestamp", range.startTs)
      .lte("timestamp", range.endTs)
      .ilike("body", "%WH Engineering%")
      .order("timestamp", { ascending: false });
    if (error) {
      console.error(`[WH Engineer Tracker] Supabase error:`, error.message);
      return null;
    }
    if (!data || data.length === 0) {
      console.log(`[WH Engineer Tracker] No WH Engineering message for ${searchDate}`);
      return null;
    }

    // Day-shift precedence, newest within group.
    const ordered = [...data].sort((a, b) => {
      const aN = isNightShift(a.body) ? 1 : 0;
      const bN = isNightShift(b.body) ? 1 : 0;
      if (aN !== bN) return aN - bN;
      return b.timestamp - a.timestamp;
    });

    for (const msg of ordered) {
      const parsed = parseEngineerCounts(msg.body);
      if (parsed) {
        console.log(
          `[WH Engineer Tracker] Found WH Engineering for ${searchDate}: onSite=${parsed.onSite}, total=${parsed.total}, absent=${parsed.absent}`,
        );
        return { ...parsed, messageId: msg.messageId, timestamp: msg.timestamp };
      }
    }
    console.log(`[WH Engineer Tracker] Found ${data.length} candidates but none parseable for ${searchDate}`);
    return null;
  } catch (e) {
    console.error(`[WH Engineer Tracker] Error:`, e.message);
    return null;
  }
}

/**
 * Range variant — per-day on-site map for [startIso, endIso].
 */
async function getWHEngineerForRange(startIso, endIso) {
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
      .ilike("body", "%WH Engineering%")
      .order("timestamp", { ascending: false });
    if (error) {
      console.error(`[WH Engineer Tracker] Range error:`, error.message);
      return out;
    }
    // Bucket by SGT timestamp day (NOT body Date label).
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
        const parsed = parseEngineerCounts(msg.body);
        if (parsed) {
          out.set(dayIso, { ...parsed, messageId: msg.messageId, timestamp: msg.timestamp });
          break;
        }
      }
    }
    return out;
  } catch (e) {
    console.error(`[WH Engineer Tracker] Range error:`, e.message);
    return out;
  }
}

module.exports = {
  getWHEngineerOnSite,
  getWHEngineerForRange,
  parseEngineerCounts,
  getSGTDayRange,
};
