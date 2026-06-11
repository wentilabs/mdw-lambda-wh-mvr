// wh-mbs family adapter for the PIC enrichment flow (mbs + wenti-base-wohhup + mdw-lambda-wh-mvr).
//
// wh-mbs has NO Novade people directory with ids — the candidate pool is NAMES only, from the
// curated assignee list (config/novade-assignees.js) + names scraped from action history.
// Fuzzy matching uses `fuzzball` (a real dependency). Name List tab is "Novade Name List"
// (4 columns, no Company). NOTE: per product decision the appended record + PIC are DATA only —
// wh-mbs's Novade sync drives the assignee from the reporter, not the PIC, and is NOT modified.

const fuzzball = require("fuzzball");
const { listNovadeActorsFromHistory } = require("./novade-api");
const { getKnownAssigneesForProject } = require("../config/novade-assignees");

const NAME_LIST_SHEET = "Novade Name List";
const PROJECT_KEY = "HVS"; // curated-assignee key for the wh-mbs family

function hasNovade() {
  return !!(process.env.NOVADE_EMAIL && process.env.NOVADE_PASSWORD);
}

/** Merge the curated assignee names with action-history actor names, de-duplicated. */
async function gatherNames() {
  const names = [];
  try {
    const known = getKnownAssigneesForProject(PROJECT_KEY);
    if (Array.isArray(known)) names.push(...known);
  } catch (_) {
    /* curated list optional */
  }
  try {
    const hist = await listNovadeActorsFromHistory({});
    if (Array.isArray(hist)) names.push(...hist);
  } catch (e) {
    console.warn("[pic-enrich-whmbs] listNovadeActorsFromHistory failed (fail-soft):", e.message);
  }
  const seen = new Set();
  const out = [];
  for (const n of names) {
    const t = String(n || "").trim();
    const k = t.toLowerCase();
    if (!t || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/**
 * Top-N Novade names for a query (fuzzball WRatio, no cutoff — "show the best we can").
 * phone is unused for wh-mbs (names-only pool). Fail-soft → [].
 * @returns {Promise<Array<{n:string}>>}
 */
async function getCandidates(query, _phone, limit = 5) {
  let names;
  try {
    names = await gatherNames();
  } catch (e) {
    console.warn("[pic-enrich-whmbs] gatherNames failed (fail-soft):", e.message);
    return [];
  }
  if (!names.length) return [];
  try {
    const res = fuzzball.extract(String(query || ""), names, { scorer: fuzzball.WRatio, limit });
    return res.map((r) => ({ n: r[0] })).slice(0, limit); // r = [choice, score, index]
  } catch (e) {
    console.warn("[pic-enrich-whmbs] fuzzball.extract failed (fail-soft):", e.message);
    return names.slice(0, limit).map((n) => ({ n }));
  }
}

module.exports = {
  hasNovade,
  getCandidates,
  nameListSheetName: NAME_LIST_SHEET,
  // "Novade Name List" cols: [Novade Name, Whatsapp Name, Phone Number, Whatsapp ID]
  buildNameListRow: ({ novadeName, whatsappName, phone, lid }) => [novadeName, whatsappName || "", phone || "", lid],
  _internals: { gatherNames, PROJECT_KEY },
};
