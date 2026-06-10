// Note: dotenv is loaded in index.js handler, secrets come from AWS Secrets Manager

const { parseGroupIds } = require("./utils");

// =============================================================================
// WhatsApp Group IDs - Parsed from comma-separated environment variables
// =============================================================================
const SAFETY_GROUP_IDS = parseGroupIds(process.env.SAFETY_WA_GROUP_ID);
const QA_GROUP_IDS = parseGroupIds(process.env.QA_WA_GROUP_ID);

// =============================================================================
// Spreadsheet Configuration by Domain
// Each domain has its own spreadsheet and sheet name(s).
// Per-project domains (safety, manpower, machines, wbgt, manpowerDataReport)
// resolve their spreadsheet IDs at runtime from env vars set on the Lambda.
// =============================================================================
const SPREADSHEET_CONFIG = {
  safety: {
    spreadsheetId: process.env.SAFETY_SPREADSHEET_ID,
    sheetName: "Safety",
  },
  manpower: {
    spreadsheetId: process.env.MANPOWER_SPREADSHEET_ID,
    sheetName: "Manpower",
  },
  wbgt: {
    spreadsheetId: process.env.WBGT_SPREADSHEET_ID,
    sheetName: "WBGT",
  },
  machines: {
    spreadsheetId: process.env.MACHINES_SPREADSHEET_ID,
    sheetName: "Machines",
  },
  manpowerDataReport: {
    spreadsheetId: process.env.MANPOWER_DATA_SPREADSHEET_ID,
    templateSheetName: "MBS",
  },
  noise: {
    spreadsheetId: process.env.NOISE_SPREADSHEET_ID,
    sheetName: "Noise",
  },
  noiseLimits: {
    spreadsheetId: process.env.NOISE_LIMITS_SPREADSHEET_ID || process.env.NOISE_SPREADSHEET_ID,
    sheetName: "Limits",
  },
};

/**
 * Get spreadsheet configuration for a specific domain
 * @param {string} domain - Domain name (safety, manpower, wbgt, machines, manpowerDataReport)
 * @returns {object|null} Spreadsheet configuration or null if not found
 */
function getSpreadsheetConfig(domain) {
  return SPREADSHEET_CONFIG[domain] || null;
}

/**
 * Get group-specific configuration for sheet routing
 * Returns the full configuration object with all spreadsheet configs for a group
 * @param {string} groupId - WhatsApp group ID
 * @returns {object} Group configuration object with all domain spreadsheet configs
 */
function getGroupConfiguration(groupId) {
  return {
    // Safety spreadsheet
    spreadsheetId: SPREADSHEET_CONFIG.safety.spreadsheetId,
    safetySpreadsheetId: SPREADSHEET_CONFIG.safety.spreadsheetId,
    safetySheetName: SPREADSHEET_CONFIG.safety.sheetName,
    // Manpower spreadsheet
    manpowerSheetName: SPREADSHEET_CONFIG.manpower.sheetName,
    manpowerSpreadsheetId: SPREADSHEET_CONFIG.manpower.spreadsheetId,
    // WBGT spreadsheet
    wbgtSheetName: SPREADSHEET_CONFIG.wbgt.sheetName,
    wbgtSpreadsheetId: SPREADSHEET_CONFIG.wbgt.spreadsheetId,
    // Machines spreadsheet (used by manpower handler for equipment tracking)
    machinesSheetName: SPREADSHEET_CONFIG.machines.sheetName,
    machinesSpreadsheetId: SPREADSHEET_CONFIG.machines.spreadsheetId,
    // Manpower Data Report — separate spreadsheet with daily sheets
    manpowerDataReportSpreadsheetId: SPREADSHEET_CONFIG.manpowerDataReport.spreadsheetId,
    manpowerDataReportTemplateSheetName: SPREADSHEET_CONFIG.manpowerDataReport.templateSheetName,
    // Noise spreadsheet
    noiseSpreadsheetId: SPREADSHEET_CONFIG.noise.spreadsheetId,
    noiseLimitsSpreadsheetId: SPREADSHEET_CONFIG.noiseLimits.spreadsheetId,
  };
}

// Soil-disposal subcon resolver — ported VERBATIM from wh-mbs config/group-config.js.
// Required because the verbatim utils/action.js soil-disposal load branch calls
// getSoilDisposalSubcon (keyed off the LLM-generated SQL string, action.js:541).
const SOIL_DISPOSAL_GROUP_ID_TO_SUBCON = {
  "120363427464538133@g.us": "KKL", // MBS IR2 - WH-KKL (Soil Disposal)
  "120363406806860046@g.us": "KTC", // IR2- KTC
};

// Legacy chatName-based mapping. Read paths still encounter pre-migration rows
// whose Source column carries a chatName, so we keep this fallback. New writes
// store the group ID instead (see usecases/soil_disposal/openai.js).
const SOIL_DISPOSAL_SOURCE_TO_SUBCON = {
  "IR2- KTC": "KTC",
  "MBS IR2 - WH-KTC (Soil Disposal)": "KKL",
};

function getSoilDisposalSubcon(source) {
  if (!source) return "KKL";
  const trimmed = String(source).trim();
  // Group-ID lookup first (the canonical key for new writes — immutable).
  if (trimmed.endsWith("@g.us") && SOIL_DISPOSAL_GROUP_ID_TO_SUBCON[trimmed]) {
    return SOIL_DISPOSAL_GROUP_ID_TO_SUBCON[trimmed];
  }
  // Legacy fallback: pre-migration rows carry the chatName in the Source column.
  return SOIL_DISPOSAL_SOURCE_TO_SUBCON[trimmed] || "KKL";
}

module.exports = {
  // Group ID arrays
  SAFETY_GROUP_IDS,
  QA_GROUP_IDS,
  // Configuration objects
  SPREADSHEET_CONFIG,
  // Functions
  getGroupConfiguration,
  getSpreadsheetConfig,
  getSoilDisposalSubcon,
  parseGroupIds,
};
