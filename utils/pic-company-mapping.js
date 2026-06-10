// PIC (Person In Charge) → Novade contractorid resolution.
// Ported from mdw-lambda-boustead-safety/utils/pic-company-mapping.js.
// COMPANY_PERSON_MAPPING is intentionally empty — populate as WH-MBS subcons are
// confirmed. Until then, resolvePICToContractorId() returns null and the sync
// handler omits `contractorid` from the action payload.

const fuzzball = require("fuzzball");

const COMPANY_PERSON_MAPPING = [
  // Example: { person: "Person Name", company: "Subcontractor Pte Ltd" },
];

const FUZZY_MATCH_THRESHOLD = 75;

function cleanWhatsAppName(name) {
  if (!name) return "";
  let cleaned = String(name);
  cleaned = cleaned.replace(/\([^)]*\)/g, "");
  cleaned = cleaned.replace(/\d+$/g, "");
  const trimmed = cleaned.trim();
  if (trimmed.length >= 4 && trimmed.length % 2 === 0) {
    const half = trimmed.length / 2;
    const firstHalf = trimmed.substring(0, half).toLowerCase();
    const secondHalf = trimmed.substring(half).toLowerCase();
    if (firstHalf === secondHalf) {
      cleaned = trimmed.substring(0, half);
    }
  }
  return cleaned.trim();
}

function fuzzyMatchPersonToCompany(rawName) {
  const name = cleanWhatsAppName(rawName);
  if (!name) return null;
  if (!COMPANY_PERSON_MAPPING.length) return null;

  let bestScore = 0;
  let bestMatch = null;
  for (const entry of COMPANY_PERSON_MAPPING) {
    const score = fuzzball.token_set_ratio(name.toLowerCase(), entry.person.toLowerCase());
    if (score > bestScore) {
      bestScore = score;
      bestMatch = entry;
    }
  }
  if (bestMatch && bestScore >= FUZZY_MATCH_THRESHOLD) return bestMatch.company;
  return null;
}

function resolveContractorId(companyName, novadeCompanies) {
  if (!companyName || !Array.isArray(novadeCompanies) || !novadeCompanies.length) return null;

  let bestScore = 0;
  let bestMatch = null;
  for (const company of novadeCompanies) {
    if (!company?.name) continue;
    const score = fuzzball.token_set_ratio(companyName.toLowerCase(), company.name.toLowerCase());
    if (score > bestScore) {
      bestScore = score;
      bestMatch = company;
    }
  }
  if (bestMatch && bestScore >= FUZZY_MATCH_THRESHOLD) return bestMatch.id || null;
  return null;
}

function resolvePICToContractorId(picString, novadeCompanies) {
  if (!picString || !String(picString).trim()) return null;

  const names = String(picString)
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);

  for (const name of names) {
    const companyName = fuzzyMatchPersonToCompany(name);
    if (companyName) {
      const contractorId = resolveContractorId(companyName, novadeCompanies);
      if (contractorId) return contractorId;
    }
    const directId = resolveContractorId(name, novadeCompanies);
    if (directId) return directId;
  }
  return null;
}

module.exports = {
  COMPANY_PERSON_MAPPING,
  FUZZY_MATCH_THRESHOLD,
  cleanWhatsAppName,
  fuzzyMatchPersonToCompany,
  resolveContractorId,
  resolvePICToContractorId,
};
