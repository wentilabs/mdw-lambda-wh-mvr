// Note: dotenv is loaded in index.js handler, secrets come from AWS Secrets Manager
const { readGoogleSheet } = require("../../utils/gsheet");

// Configuration
const SPREADSHEET_ID = process.env.NOISE_LIMITS_SPREADSHEET_ID || process.env.NOISE_SPREADSHEET_ID;
const SHEET_NAME = "Limits";

// In-memory cache
let limitsCache = null;
let lastLoadTime = null;
const CACHE_TTL = 3600000; // 1 hour in milliseconds

// const CACHE_TTL = 3600000; // 1 hour in milliseconds

/**
 * Convert Excel decimal time to HH:MM format
 * Excel stores time as a decimal where 0.0 = 00:00 and 1.0 = 24:00
 * @param {number} decimal - Excel time value (e.g., 0.7916666666666666 = 19:00)
 * @returns {string} - Time in HH:MM format
 */
function excelTimeToHHMM(decimal) {
  const totalMinutes = Math.round(decimal * 24 * 60);
  const hours = Math.floor(totalMinutes / 60) % 24;
  const minutes = totalMinutes % 60;
  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
}

/**
 * Normalize time value to HH:MM format
 * Handles both Excel decimal format and string format
 * @param {number|string} timeValue - Time as Excel decimal or HH:MM string
 * @returns {string} - Time in HH:MM format
 */
function normalizeTime(timeValue) {
  if (typeof timeValue === "number") {
    return excelTimeToHHMM(timeValue);
  }
  if (typeof timeValue === "string") {
    if (/^0\.\d+$/.test(timeValue.trim())) {
      return excelTimeToHHMM(parseFloat(timeValue));
    }
    return timeValue.trim();
  }
  return "00:00";
}

/**
 * Parse time string (HH:MM) to minutes since midnight
 * @param {string} timeStr - Time in HH:MM format
 * @returns {number} - Minutes since midnight
 */
function timeToMinutes(timeStr) {
  const [hours, minutes] = timeStr.split(":").map(Number);
  return hours * 60 + minutes;
}

/**
 * Check if a given hour falls within a time period
 * @param {number} hour - Hour to check (0-23)
 * @param {string} startTime - Start time (HH:MM)
 * @param {string} endTime - End time (HH:MM)
 * @returns {boolean}
 */
function isHourInPeriod(hour, startTime, endTime) {
  const hourMinutes = hour * 60;
  const startMinutes = timeToMinutes(startTime);
  const endMinutes = timeToMinutes(endTime);

  // Handle periods that cross midnight (e.g., 22:00 to 07:00)
  if (endMinutes <= startMinutes) {
    return hourMinutes >= startMinutes || hourMinutes < endMinutes;
  } else {
    return hourMinutes >= startMinutes && hourMinutes < endMinutes;
  }
}

/**
 * Normalize day type values from the Google Sheets "Limits" tab.
 * Handles both old format (weekday/weekend/holiday) and new format (mon_sat/sun_ph).
 * @param {string} dayType - Raw day type string from sheet
 * @returns {string} - Normalized day type: "mon_sat" or "sun_ph"
 */
function normalizeDayType(dayType) {
  if (!dayType) return dayType;
  // Already in new format
  if (dayType === "mon_sat" || dayType === "sun_ph") return dayType;
  // Map old format → new format
  if (dayType === "weekday" || dayType === "mon-sat" || dayType === "mon_sat") return "mon_sat";
  if (
    dayType === "weekend" ||
    dayType === "holiday" ||
    dayType === "sun_ph" ||
    dayType === "sun & ph" ||
    dayType === "sun/ph"
  )
    return "sun_ph";
  // Fallback: return as-is (will be compared against getDayType() output)
  return dayType;
}

/**
 * Load noise limits configuration from Google Sheet
 * Results are cached for performance
 * @param {boolean} forceReload - Force reload from Google Sheet, bypassing cache
 * @returns {Promise<Array>} - Array of limit configurations
 */
async function loadNoiseLimitsConfig(forceReload = false) {
  const now = Date.now();

  // Return cached data if available and not expired
  if (!forceReload && limitsCache && lastLoadTime && now - lastLoadTime < CACHE_TTL) {
    console.log("Using cached noise limits configuration");
    return limitsCache;
  }

  console.log("Loading noise limits configuration from Google Sheet...");

  try {
    if (!SPREADSHEET_ID) {
      console.log("No NOISE_LIMITS_SPREADSHEET_ID configured, using default limits");
      return [];
    }

    let sheetData;
    try {
      sheetData = await readGoogleSheet(SPREADSHEET_ID, SHEET_NAME);
    } catch (err) {
      if (err.message && err.message.includes("Unable to parse range")) {
        console.log(`Sheet "${SHEET_NAME}" not found, using default limits (75/67/62 dBA)`);
        limitsCache = [];
        lastLoadTime = Date.now();
        return [];
      }
      throw err;
    }

    if (!sheetData || sheetData.length === 0) {
      throw new Error("Noise limits sheet is empty or does not exist");
    }

    // Parse the data
    const headers = sheetData[0];

    // Find column indices
    const locationIdx = headers.findIndex(
      (h) => h && h.toLowerCase().includes("location") && !h.toLowerCase().includes("name"),
    );
    const locationNameIdx = headers.findIndex(
      (h) => h && h.toLowerCase().includes("location") && h.toLowerCase().includes("name"),
    );
    const dayTypeIdx = headers.findIndex(
      (h) => h && h.toLowerCase().includes("day") && h.toLowerCase().includes("type"),
    );
    const startTimeIdx = headers.findIndex(
      (h) => h && h.toLowerCase().includes("start") && h.toLowerCase().includes("time"),
    );
    const endTimeIdx = headers.findIndex(
      (h) => h && h.toLowerCase().includes("end") && h.toLowerCase().includes("time"),
    );
    const limitIdx = headers.findIndex(
      (h) => h && (h.toLowerCase().includes("limit") || h.toLowerCase().includes("dba")),
    );
    const labelIdx = headers.findIndex((h) => h && h.toLowerCase().includes("label"));
    const leqTypeIdx = headers.findIndex(
      (h) => h && h.toLowerCase().includes("leq") && h.toLowerCase().includes("type"),
    );

    if (locationIdx === -1 || dayTypeIdx === -1 || startTimeIdx === -1 || endTimeIdx === -1 || limitIdx === -1) {
      throw new Error("Required columns not found in noise limits sheet");
    }

    // Parse data rows
    const configs = [];
    for (let i = 1; i < sheetData.length; i++) {
      const row = sheetData[i];

      if (!row || row.length === 0 || !row[locationIdx]) {
        continue;
      }

      const config = {
        location: row[locationIdx]?.toString().trim(),
        locationName: locationNameIdx !== -1 ? row[locationNameIdx]?.toString().trim() : "",
        dayType: normalizeDayType(row[dayTypeIdx]?.toString().trim().toLowerCase()),
        startTime: normalizeTime(row[startTimeIdx]),
        endTime: normalizeTime(row[endTimeIdx]),
        limit: parseFloat(row[limitIdx]),
        label: labelIdx !== -1 ? row[labelIdx]?.toString().trim() : "",
        leqType: leqTypeIdx !== -1 ? row[leqTypeIdx]?.toString().trim().toLowerCase() : "leq_1hr",
      };

      if (config.location && config.dayType && config.startTime && config.endTime && !isNaN(config.limit)) {
        configs.push(config);
      }
    }

    // Cache the results
    limitsCache = configs;
    lastLoadTime = now;

    console.log(`✓ Loaded ${configs.length} noise limit configurations`);

    return configs;
  } catch (error) {
    console.error("Error loading noise limits configuration:", error.message);

    // If we have cached data, return it as fallback
    if (limitsCache) {
      console.warn("Using stale cached configuration due to loading error");
      return limitsCache;
    }

    // If no cache available, throw error
    throw error;
  }
}

/**
 * Determine day type based on date.
 * Matches NEA construction noise regulations: "Mon-Sat" vs "Sun & PH".
 *
 * @param {Date} date - Date to check
 * @returns {string} - Day type: 'mon_sat' (Monday-Saturday) or 'sun_ph' (Sunday + Public Holidays)
 */
function getDayType(date) {
  // Singapore public holidays 2025-2026 (update this list annually)
  const publicHolidays = [
    "2025-01-01", // New Year's Day
    "2025-01-29", // Chinese New Year
    "2025-01-30", // Chinese New Year
    "2025-04-18", // Good Friday
    "2025-05-01", // Labour Day
    "2025-05-12", // Vesak Day
    "2025-06-02", // Hari Raya Puasa
    "2025-08-09", // National Day
    "2025-08-09", // Hari Raya Haji
    "2025-10-24", // Deepavali
    "2025-12-25", // Christmas Day
    "2026-01-01", // New Year's Day
    "2026-02-17", // Chinese New Year
    "2026-02-18", // Chinese New Year
    "2026-04-03", // Good Friday
    "2026-05-01", // Labour Day
    "2026-05-31", // Vesak Day
    "2026-06-19", // Hari Raya Haji
    "2026-08-09", // National Day
    "2026-10-14", // Deepavali
    "2026-12-25", // Christmas Day
  ];

  const dateStr = date.toISOString().split("T")[0];

  // Public holidays → sun_ph (same thresholds as Sunday)
  if (publicHolidays.includes(dateStr)) {
    return "sun_ph";
  }

  // Sunday (dayOfWeek === 0) → sun_ph
  // Monday-Saturday (dayOfWeek 1-6) → mon_sat
  const dayOfWeek = date.getDay();
  if (dayOfWeek === 0) {
    return "sun_ph";
  }

  return "mon_sat";
}

/**
 * Normalize location code for Limits sheet matching.
 * Converts short codes (NM1, NM2) to zero-padded form (NM01, NM02).
 * @param {string} code - Location code (e.g., "NM1" or "NM01")
 * @returns {string} - Normalized code (e.g., "NM01")
 */
function normalizeLocationCode(code) {
  if (!code) return code;
  return code.replace(/^NM(\d)$/, "NM0$1");
}

/**
 * Get noise limit for specific parameters (returns the primary LEQ_1hr limit for backward compatibility).
 * If LEQ_1hr is not applicable, falls back to LEQ_5min limit.
 *
 * @param {string} location - Location code (e.g., "NM01" or "NM1")
 * @param {number} hour - Hour (0-23)
 * @param {Date} [date] - Date to check (defaults to current date)
 * @returns {Promise<number>} - Noise limit in dBA
 */
async function getNoiseLimit(location, hour, date = null) {
  try {
    const normalizedLoc = normalizeLocationCode(location);
    const limits = await getNoiseLimitsForMetrics(normalizedLoc, hour, date);

    // Prefer LEQ_1hr, fall back to LEQ_5min
    if (limits.leq_1hr !== null) return limits.leq_1hr;
    if (limits.leq_5min !== null) return limits.leq_5min;

    console.warn(`No applicable limit found for ${normalizedLoc} at hour ${hour}, using default values`);
    return getDefaultNoiseLimit(hour);
  } catch (error) {
    console.error("Error getting noise limit from configuration:", error.message);
    console.warn("Falling back to default hardcoded values");
    return getDefaultNoiseLimit(hour);
  }
}

/**
 * Get all applicable noise limits for a given location, hour, and date.
 * Returns limits grouped by LEQ metric type (leq_5min, leq_1hr, leq_12hr).
 * A null value means N.A. (not applicable) for that metric.
 *
 * @param {string} location - Location code (e.g., "NM01")
 * @param {number} hour - Hour (0-23)
 * @param {Date} [date] - Date to check (defaults to current date)
 * @returns {Promise<{leq_5min: number|null, leq_1hr: number|null, leq_12hr: number|null}>}
 */
async function getNoiseLimitsForMetrics(location, hour, date = null) {
  const result = { leq_5min: null, leq_1hr: null, leq_12hr: null };

  try {
    const configs = await loadNoiseLimitsConfig();
    const checkDate = date || new Date();
    const dayType = getDayType(checkDate);
    const normalizedLoc = normalizeLocationCode(location);

    // Find matching configurations for each LEQ type
    for (const config of configs) {
      const configLoc = normalizeLocationCode(config.location);
      if (configLoc !== normalizedLoc) continue;
      if (config.dayType !== dayType) continue;
      if (!isHourInPeriod(hour, config.startTime, config.endTime)) continue;

      const leqType = config.leqType || "leq_1hr";
      if (result[leqType] === null || result[leqType] === undefined) {
        result[leqType] = config.limit;
      }
    }

    // If no match for the current day type, try mon_sat as fallback
    if (result.leq_5min === null && result.leq_1hr === null && result.leq_12hr === null && dayType !== "mon_sat") {
      for (const config of configs) {
        const configLoc = normalizeLocationCode(config.location);
        if (configLoc !== normalizedLoc) continue;
        if (config.dayType !== "mon_sat") continue;
        if (!isHourInPeriod(hour, config.startTime, config.endTime)) continue;

        const leqType = config.leqType || "leq_1hr";
        if (result[leqType] === null || result[leqType] === undefined) {
          result[leqType] = config.limit;
        }
      }
      if (result.leq_5min !== null || result.leq_1hr !== null || result.leq_12hr !== null) {
        console.warn(`No ${dayType} configuration for ${normalizedLoc} at hour ${hour}, using mon_sat fallback`);
      }
    }

    // If still nothing found, use hardcoded defaults as leq_1hr
    if (result.leq_5min === null && result.leq_1hr === null && result.leq_12hr === null) {
      console.warn(`No configuration found for ${normalizedLoc} ${dayType} at hour ${hour}, using default values`);
      result.leq_1hr = getDefaultNoiseLimit(hour);
    }

    return result;
  } catch (error) {
    console.error("Error getting noise limits for metrics:", error.message);
    result.leq_1hr = getDefaultNoiseLimit(hour);
    return result;
  }
}

/**
 * Get default noise limit based on hour (fallback when configuration is unavailable)
 * @param {number} hour - The hour (0-23)
 * @returns {number} - The noise limit in dBA
 */
function getDefaultNoiseLimit(hour) {
  if (hour >= 7 && hour < 19) {
    return 75.0; // Daytime limit (7am-7pm)
  } else if (hour >= 19 && hour < 22) {
    return 67.0; // Evening limit (7pm-10pm)
  } else {
    return 62.0; // Night limit (10pm-7am)
  }
}

/**
 * Clear the cache (useful for testing or force refresh)
 */
function clearCache() {
  limitsCache = null;
  lastLoadTime = null;
  console.log("Noise limits cache cleared");
}

module.exports = {
  loadNoiseLimitsConfig,
  getNoiseLimit,
  getNoiseLimitsForMetrics,
  getDayType,
  clearCache,
  getDefaultNoiseLimit,
  normalizeLocationCode,
  // Export helper functions for testing
  excelTimeToHHMM,
  normalizeTime,
  timeToMinutes,
  isHourInPeriod,
};
