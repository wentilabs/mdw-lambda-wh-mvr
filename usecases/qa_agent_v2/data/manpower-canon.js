/**
 * Company-name canonicalization for the Manpower domain.
 *
 * The Manpower sheet contains many sub-division variants for the same parent
 * company (e.g. "LT SAMBO", "LT SAMBO(ATEC)", "LT_SAMBO *(ESK)*", "LT Sambo
 * (Atec)", "LT_SAMBO (Fuchi)"). Each is the same parent. This module collapses
 * them to a canonical name BEFORE the aggregator groups.
 *
 * Regex is used on FIELD VALUES from the sheet — NOT on user-typed text. The
 * "no regex on user text" rule (memory: feedback_no_regex_nlp_in_qa) does not
 * apply here: this is data normalization, not intent classification.
 */

/**
 * @param {string} name
 * @returns {string}
 */
function canonicalCompany(name) {
  const s = String(name || "").trim();
  if (!s) return s;

  // LT SAMBO family — covers "LT SAMBO", "LT SAMBO(ATEC)", "LT_SAMBO *(ESK)*",
  // "LT Sambo (Atec)", "LT_SAMBO (Fuchi)", "LTSAMBO", etc.
  if (/^lt[\s_-]*sambo\b/i.test(s)) return "LT SAMBO";

  // Wohhup family — collapse every variant to "Woh Hup". Mirrors isWHFamily.
  if (/(woh\s*hup|wohhup|woh[-_]hup|whpl)/i.test(s)) return "Woh Hup";

  // KTC sub-divisions
  if (/^ktc\b/i.test(s)) return "KTC";

  // KKL sub-divisions
  if (/^kkl\b/i.test(s)) return "KKL";

  // EGT
  if (/^egt\b/i.test(s)) return "EGT";

  // Teamtech ("Team Tech", "TeamTech")
  if (/^team\s*tech\b/i.test(s)) return "Teamtech";

  return s;
}

module.exports = { canonicalCompany };
