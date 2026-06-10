// WhatsApp display name → Novade actor name resolution.
//
// Novade has no public user-list endpoint. The closest proxy is the set of
// distinct actor strings already used in safety action records (lodgedby,
// confirmedby, completedby, closedby, owner) — see
// utils/novade-api.js#listNovadeActorsFromHistory.
//
// This module takes a raw WhatsApp display name (e.g., from the sheet's
// `Sender` or `Updated By` JSON column) and tries to fuzzy-match it against
// that known-actor list. Returns the matched Novade actor string, or null on
// no match — caller decides whether to fall back to NOVADE_DEFAULT_ACTOR.

const fuzzball = require("fuzzball");
const { cleanWhatsAppName } = require("./pic-company-mapping");

// fuzzball.WRatio is fuzzball's hybrid (combines token_set, token_sort,
// partial_ratio with weighting) — handles all the common name-shape mismatches
// in our sheet vs. Novade list:
//   - Single-word vs multi-word: "karthik" ↔ "Sekar karthikeyan"
//   - Initials vs full: "PK.MANI" ↔ "PACKIASAMY MANI"
//   - Partial overlap: "Ngoc" ↔ "Nguyen Pham Tuan Ngoc"
//   - Different cases: "Mirza Shohag" ↔ "MIRZA SHOHAG"
// Threshold 80 keeps all known true matches (min score 86) and rejects the
// closest known false positive (Ali Ahammad → Ali Showkat: 55).
const FUZZY_MATCH_THRESHOLD = 80;

/**
 * Parse a sheet's Sender / Updated By JSON cell into a display name.
 * Returns "" if the cell can't be parsed or has no name field.
 */
function parseSenderJsonName(rawCell) {
  if (!rawCell) return "";
  try {
    const parsed = typeof rawCell === "string" ? JSON.parse(rawCell) : rawCell;
    return String(parsed?.name || parsed?.senderName || parsed?.from || "").trim();
  } catch {
    return "";
  }
}

/**
 * Resolve a raw WhatsApp display name against a list of known Novade actors.
 *
 * @param {string} rawName        e.g. "Ali Ahammad" / "WhatsApp display name"
 * @param {string[]} knownActors  list of Novade actor strings (from listNovadeActorsFromHistory)
 * @param {number} threshold      0-100, default 75
 * @returns {string|null}         matched actor name, or null on no match
 */
function resolveNovadeActor(rawName, knownActors, threshold = FUZZY_MATCH_THRESHOLD) {
  const cleaned = cleanWhatsAppName(rawName);
  if (!cleaned) return null;
  if (!Array.isArray(knownActors) || !knownActors.length) return null;

  // Strip common separators (dots in initials like "PK.MANI" / "K.Sakthivel")
  // so token_set within WRatio sees "PK MANI" and "K SAKTHIVEL" instead.
  const a = cleaned.toLowerCase().replace(/[.]/g, " ").replace(/\s+/g, " ").trim();

  let bestScore = 0;
  let bestMatch = null;
  for (const actor of knownActors) {
    if (!actor) continue;
    const b = String(actor).toLowerCase();
    const score = fuzzball.WRatio(a, b);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = actor;
    }
  }
  if (bestMatch && bestScore >= threshold) return bestMatch;
  return null;
}

module.exports = {
  parseSenderJsonName,
  resolveNovadeActor,
  FUZZY_MATCH_THRESHOLD,
};
