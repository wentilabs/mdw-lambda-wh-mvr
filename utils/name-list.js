// Note: dotenv is loaded in index.js handler, secrets come from AWS Secrets Manager
//
// Resolves WhatsApp @mentions in a message body to real people by looking them up
// in the "Novade Name List" tab of the safety spreadsheet.
//
// A safety message designates the person-in-charge (PIC) by @mentioning them. In the
// raw body this appears as a token "@<digits>" where <digits> is the WhatsApp LID
// (14-15 digits), e.g. "@42714070515919  OXY cage regulator glass was damaged".
// The "Whatsapp ID" column holds that same LID — entered as "@<digits>" OR bare "<digits>"
// — which we normalize to "@<digits>", so the mention -> person mapping is an exact lookup.
//
// "Novade Name List" columns (resolved by normalized header, NOT index — order may vary):
//   "Novade Name"   - curated exact Novade person name
//   "Whatsapp Name"
//   "Phone Number"
//   "Whatsapp ID"   - the LID ("@<digits>" or bare "<digits>")
//
// Columns are resolved by normalized header (not hardcoded index) so a column reorder
// in the sheet doesn't silently break the lookup.

const { readGoogleSheet } = require("./gsheet");
const { getSupabaseClient } = require("./common");

const NAME_LIST_SHEET = "Novade Name List";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// { [spreadsheetId]: { map: Map<"@id", Entry>, fetchedAtMs: number } }
// Entry = { novadeName: string, whatsappName: string, phone: string }
const _cache = {};

/**
 * Extract WhatsApp mention tokens ("@<digits>") from a message body.
 * Deterministic structured-token parse (NOT NLP) — the @mention is a literal
 * identifier, so a regex is the correct, 100%-consistent extractor.
 *
 * Handles: multiple mentions, no-space runs ("@111...@222..."), mentions anywhere
 * in the body, and dedup (preserving first-seen order). Requires >= 5 digits to
 * avoid false positives on things like "@2pm" (real LIDs are 14-15 digits).
 *
 * @param {string} body
 * @returns {string[]} e.g. ["@14753430798369", "@138860738646117"]
 */
function extractMentionIds(body) {
  if (!body || typeof body !== "string") return [];
  const matches = body.match(/@\d{5,}/g) || [];
  return [...new Set(matches)];
}

/**
 * Read the "Name List (proposed)" tab and build a lookup map keyed by the
 * "@<digits>" Whatsapp ID. Cached per-spreadsheet for CACHE_TTL_MS.
 *
 * Fail-soft: on any read error (e.g. the tab doesn't exist in a test/dev
 * spreadsheet) or missing "Whatsapp ID" column, logs a warning and caches an
 * empty Map so callers degrade gracefully and we don't hammer the Sheets API.
 *
 * @param {string} spreadsheetId
 * @returns {Promise<Map<string, {novadeName:string, whatsappName:string, phone:string}>>}
 */
async function loadNameList(spreadsheetId) {
  if (!spreadsheetId) return new Map();

  const cached = _cache[spreadsheetId];
  if (cached && Date.now() - cached.fetchedAtMs < CACHE_TTL_MS) {
    return cached.map;
  }

  const map = new Map();

  let rows;
  try {
    rows = await readGoogleSheet(spreadsheetId, NAME_LIST_SHEET);
  } catch (e) {
    console.warn(
      `[name-list] Failed to read "${NAME_LIST_SHEET}" tab: ${e.message}. PIC mention resolution disabled for ${spreadsheetId}.`,
    );
    _cache[spreadsheetId] = { map, fetchedAtMs: Date.now() };
    return map;
  }

  if (!rows || rows.length < 2) {
    _cache[spreadsheetId] = { map, fetchedAtMs: Date.now() };
    return map;
  }

  const headers = (rows[0] || []).map((h) =>
    String(h || "")
      .trim()
      .toLowerCase(),
  );
  const novadeNameCol = headers.indexOf("novade name");
  const whatsappNameCol = headers.indexOf("whatsapp name");
  const phoneCol = headers.indexOf("phone number");
  const idCol = headers.indexOf("whatsapp id");

  if (idCol === -1) {
    console.warn(
      `[name-list] "${NAME_LIST_SHEET}" has no "Whatsapp ID" column. Headers: ${JSON.stringify(headers)}. PIC mention resolution disabled.`,
    );
    _cache[spreadsheetId] = { map, fetchedAtMs: Date.now() };
    return map;
  }

  const cell = (row, col) => (col >= 0 ? String(row[col] ?? "").trim() : "");

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];
    // The "Whatsapp ID" column may store the LID as "@<digits>" OR a bare "<digits>"
    // (sometimes entered/returned as a number). Normalize to the "@<digits>" mention token
    // so it matches the body's @mention regardless of how it was typed in the sheet.
    const lid = cell(row, idCol).replace(/^@/, "");
    if (!/^\d{5,}$/.test(lid)) continue;
    map.set("@" + lid, {
      novadeName: cell(row, novadeNameCol),
      whatsappName: cell(row, whatsappNameCol),
      phone: cell(row, phoneCol),
    });
  }

  _cache[spreadsheetId] = { map, fetchedAtMs: Date.now() };
  return map;
}

/**
 * Fallback resolver: when a mentioned LID is NOT in the curated Name List, recover the
 * person's display name from whatsapp_listener (their pushname in past messages, any group).
 * The mention "@<digits>" maps to the listener "author" column "<digits>@lid". Rows are read
 * newest-first and we take the LATEST real pushname — people change their WhatsApp name often,
 * so the most recent one is current. Names that are just the bare LID / a phone number are
 * ignored; phone number is the final fallback. Cached per-LID (5 min); fully fail-soft.
 *
 * @param {string} id  e.g. "@42714070515919"
 * @returns {Promise<{display:string, whatsappName:string, phone:string}|null>}
 */
const _listenerCache = {}; // { "@id": { value: {display,whatsappName,phone}|null, fetchedAtMs } }

async function resolveMentionViaListener(id) {
  const digits = String(id || "").replace(/^@/, "");
  if (!/^\d{5,}$/.test(digits)) return null;

  const cached = _listenerCache[id];
  if (cached && Date.now() - cached.fetchedAtMs < CACHE_TTL_MS) return cached.value;

  let value = null;
  try {
    const { data, error } = await getSupabaseClient()
      .from("whatsapp_listener")
      .select("sender,phoneNumber,timestamp")
      .ilike("author", `${digits}@%`)
      .not("sender", "is", null)
      .order("timestamp", { ascending: false })
      .limit(50);
    if (!error && Array.isArray(data) && data.length) {
      const isRealName = (s) => {
        const t = String(s || "").trim();
        return t && t !== digits && t !== id && t !== "." && t.toLowerCase() !== "null" && !/^\+?\d{5,}$/.test(t);
      };
      // Newest-first: take the LATEST real pushname; grab the first phone we see as fallback.
      let display = "";
      let phone = "";
      for (const r of data) {
        if (!phone && r.phoneNumber) phone = String(r.phoneNumber).trim();
        if (!display && isRealName(r.sender)) display = String(r.sender).trim();
        if (display && phone) break;
      }
      const finalDisplay = display || phone || "";
      if (finalDisplay) value = { display: finalDisplay, whatsappName: display, phone };
    }
  } catch (e) {
    console.warn(`[name-list] listener fallback failed for ${id} (non-blocking): ${e.message}`);
    value = null;
  }

  _listenerCache[id] = { value, fetchedAtMs: Date.now() };
  return value;
}

/**
 * Resolve the @mentions in a message body to a PIC display string + the ordered list of
 * resolved people. EVERY mention yields a token (so a designated PIC is never silently
 * dropped and we never re-ask): try the curated Name List first, then whatsapp_listener
 * history, then fall back to the raw "@id" itself.
 *
 * display = whatsappName || phone || novadeName (Name List) | latest listener pushname/phone | "@id".
 * Order follows the body (first = primary, used as the Novade assignee).
 *
 * @param {string} body
 * @param {string} spreadsheetId
 * @returns {Promise<{ picText:string, resolved: Array<{id:string, novadeName:string, whatsappName:string, phone:string, display:string, source:string}> }>}
 */
async function resolvePicFromMentions(body, spreadsheetId) {
  const ids = extractMentionIds(body);
  if (ids.length === 0) return { picText: "", resolved: [] };

  // Curated Name List (preferred — also bridges to the Novade assignee). May be empty.
  const map = spreadsheetId ? await loadNameList(spreadsheetId) : new Map();

  const resolved = [];
  for (const id of ids) {
    // 1) Curated Name List — whatsappName -> phone -> novadeName.
    const entry = map.get(id);
    let novadeName = entry ? entry.novadeName : "";
    let whatsappName = entry ? entry.whatsappName : "";
    let phone = entry ? entry.phone : "";
    let display = entry ? entry.whatsappName || entry.phone || entry.novadeName : "";
    let source = display ? "namelist" : "";

    // 2) whatsapp_listener fallback — recover the latest real pushname from message history.
    if (!display) {
      const li = await resolveMentionViaListener(id);
      if (li && li.display) {
        display = li.display;
        whatsappName = li.whatsappName || (display === li.phone ? "" : display);
        phone = phone || li.phone || "";
        source = "listener";
      }
    }

    // 3) Last resort — keep the raw "@id" so a designated PIC is never lost and we never
    //    re-ask. The Novade sync resolves raw "@id" tokens defensively.
    if (!display) {
      display = id;
      source = "raw";
    }

    resolved.push({ id, novadeName, whatsappName, phone, display, source });
  }

  const picText = resolved.map((p) => p.display).join(", ");
  return { picText, resolved };
}

/**
 * Remove any raw "@<digits>" mention tokens from a string (and tidy leftover separators),
 * so a WhatsApp mention id can never survive into the PIC column. Plain names/text are
 * returned unchanged (e.g. "Mr Tan" → "Mr Tan"; "John & @999999999" → "John").
 * @param {string} text
 * @returns {string}
 */
function stripMentionIds(text) {
  if (!text || typeof text !== "string") return "";
  return text
    .replace(/@\d{5,}/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,;&]+|[\s,;&]+$/g, "")
    .trim();
}

/**
 * Drop cached Name List data (one spreadsheet, or all). For tests/ops.
 * @param {string} [spreadsheetId]
 */
function invalidateNameListCache(spreadsheetId) {
  if (spreadsheetId) {
    delete _cache[spreadsheetId];
  } else {
    Object.keys(_cache).forEach((k) => delete _cache[k]);
  }
}

module.exports = {
  extractMentionIds,
  loadNameList,
  resolvePicFromMentions,
  stripMentionIds,
  invalidateNameListCache,
  NAME_LIST_SHEET,
};
