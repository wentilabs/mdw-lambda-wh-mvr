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
 * Resolve the @mentions in a message body to a PIC display string + the ordered
 * list of resolved people.
 *
 * display = whatsappName || phone || novadeName (per product decision).
 * Unmatched mentions and all-empty entries are skipped. Order is the order the
 * mentions appear in the body (first = primary, used as the Novade assignee).
 *
 * @param {string} body
 * @param {string} spreadsheetId
 * @returns {Promise<{ picText:string, resolved: Array<{id:string, novadeName:string, whatsappName:string, phone:string, display:string}> }>}
 */
async function resolvePicFromMentions(body, spreadsheetId) {
  if (!spreadsheetId) return { picText: "", resolved: [] };

  const ids = extractMentionIds(body);
  if (ids.length === 0) return { picText: "", resolved: [] };

  const map = await loadNameList(spreadsheetId);
  if (map.size === 0) return { picText: "", resolved: [] };

  const resolved = [];
  for (const id of ids) {
    const entry = map.get(id);
    if (!entry) continue; // unmatched mention -> skip
    const display = entry.whatsappName || entry.phone || entry.novadeName;
    if (!display) continue; // row exists but has no usable display value -> skip
    resolved.push({ id, ...entry, display });
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
