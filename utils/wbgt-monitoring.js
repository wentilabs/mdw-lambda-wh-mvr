/**
 * WBGT Monitoring Sheet Column Mapping
 *
 * This module handles column mapping for the monthly WBGT monitoring sheets.
 * The sheets follow a template structure with hourly temperature tracking.
 *
 * Template Structure:
 * - Column A: S/N
 * - Column B: Person In-charge
 * - Column C: Date
 * - Columns D onwards: Hourly tracking with 2-column pattern per hour
 *   (Temperature | Heat Stress Level)
 *
 * Time Range: 08:00-17:59 (excluding 12:00 lunch hour)
 */

/**
 * Maps hour (8-17, excluding 12) to column indices
 * Each hour has 2 columns: Temperature, Heat Stress Level
 * Only write to Temperature column, leave others for formulas
 */
const HOUR_TO_COLUMN_MAP = {
  8: { temp: 3, stress: 4 }, // D-E:   08:00Hrs
  9: { temp: 5, stress: 6 }, // F-G:   09:00Hrs
  10: { temp: 7, stress: 8 }, // H-I:   10:00Hrs
  11: { temp: 9, stress: 10 }, // J-K:   11:00Hrs
  13: { temp: 11, stress: 12 }, // L-M:   13:00Hrs (skip 12:00)
  14: { temp: 13, stress: 14 }, // N-O:   14:00Hrs
  15: { temp: 15, stress: 16 }, // P-Q:   15:00Hrs
  16: { temp: 17, stress: 18 }, // R-S:   16:00Hrs
  17: { temp: 19, stress: 20 }, // T-U:   17:00Hrs
};

/**
 * Get column index for temperature reading based on hour
 * @param {number} hour - Hour (8-17, excluding 12)
 * @returns {number|null} - Column index (0-based) or null if invalid
 *
 * @example
 * getTemperatureColumnIndex(8)  // Returns 3 (column D)
 * getTemperatureColumnIndex(12) // Returns null (lunch hour)
 * getTemperatureColumnIndex(17) // Returns 19 (column T)
 */
function getTemperatureColumnIndex(hour) {
  const mapping = HOUR_TO_COLUMN_MAP[hour];
  return mapping ? mapping.temp : null;
}

/**
 * Get column letter from index (0-based)
 * Converts numeric column index to Excel-style column letter(s)
 *
 * @param {number} index - 0-based column index
 * @returns {string} - Column letter (e.g., "A", "D", "AB")
 *
 * @example
 * columnIndexToLetter(0)  // Returns "A"
 * columnIndexToLetter(3)  // Returns "D"
 * columnIndexToLetter(26) // Returns "AA"
 * columnIndexToLetter(27) // Returns "AB"
 */
function columnIndexToLetter(index) {
  if (index < 0) return "";

  let letter = "";
  while (index >= 0) {
    letter = String.fromCharCode((index % 26) + 65) + letter;
    index = Math.floor(index / 26) - 1;
  }
  return letter;
}

/**
 * Get full column mapping info for a given hour
 * @param {number} hour - Hour (8-17, excluding 12)
 * @returns {object|null} - Object with temp/stress columns or null
 *
 * @example
 * getColumnMapping(9)
 * // Returns { temp: 5, stress: 6 }
 */
function getColumnMapping(hour) {
  return HOUR_TO_COLUMN_MAP[hour] || null;
}

/**
 * Get all valid tracking hours
 * @returns {number[]} - Array of valid hours [8, 9, 10, 11, 13, 14, 15, 16, 17]
 */
function getValidTrackingHours() {
  return Object.keys(HOUR_TO_COLUMN_MAP).map(Number);
}

module.exports = {
  HOUR_TO_COLUMN_MAP,
  getTemperatureColumnIndex,
  columnIndexToLetter,
  getColumnMapping,
  getValidTrackingHours,
};
