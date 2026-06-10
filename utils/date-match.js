/**
 * Date matching utilities extracted from daily-summary.js
 * Used by daily-safety-summary API for date comparison in safety sheets
 */

/**
 * Check if a date value (string or Excel serial number) matches a search date
 * @param {string|number} dateValue - Date value from sheet (string or serial number)
 * @param {string} searchDate - Search date in DD-MMM-YYYY format
 * @returns {boolean} True if dates match
 */
function checkDateMatch(dateValue, searchDate) {
  // Skip empty values
  if (dateValue === null || dateValue === undefined || dateValue === '') return false;

  // Extract search date components
  const searchComponents = getDateComponents(searchDate);
  if (!searchComponents) return false;

  const { day: searchDayNum, monthNum: searchMonthNum, year: searchYearNum } = searchComponents;

  // APPROACH 1: Check for formatted date string with time
  if (typeof dateValue === 'string') {
    // Try to extract date parts from the formatted string
    const datePattern = /(\d{1,2})-([A-Za-z]{3})-(\d{4})/i;
    const dateMatch = dateValue.match(datePattern);

    if (dateMatch) {
      const day = parseInt(dateMatch[1]);
      const month = dateMatch[2].toLowerCase();
      const year = parseInt(dateMatch[3]);
      const monthNum = getMonthNumber(month);

      // Check if it matches the search date
      if (day === searchDayNum && monthNum === searchMonthNum && year === searchYearNum) {
        return true;
      }
    }
  }

  // APPROACH 2: Check for Excel/Google Sheets serial date number
  const numericValue = parseFloat(String(dateValue));
  if (!isNaN(numericValue)) {
    try {
      // Get the UTC date first
      const jsDate = excelSerialDateToJSDate(numericValue);

      // Get UTC date components
      const utcDay = jsDate.getUTCDate();
      const utcMonth = jsDate.getUTCMonth() + 1; // 0-based to 1-based
      const utcYear = jsDate.getUTCFullYear();

      // Always use UTC for date matching
      if (utcDay === searchDayNum && utcMonth === searchMonthNum && utcYear === searchYearNum) {
        return true;
      }
    } catch (e) {
      console.log(`❌ Error in Excel date conversion: ${e.message}`);
    }
  }

  return false;
}

/**
 * Convert Excel serial date number to JavaScript Date
 * @param {number} serialDate - Excel serial date number
 * @returns {Date} JavaScript Date object (UTC)
 */
function excelSerialDateToJSDate(serialDate) {
  // Google Sheets' epoch starts on 12/30/1899 (day 0)
  const baseDate = new Date(Date.UTC(1899, 11, 30));
  const jsDate = new Date(baseDate.getTime() + serialDate * 24 * 60 * 60 * 1000);
  return jsDate;
}

/**
 * Extract date components from search date string
 * @param {string} searchDate - Date string in DD-MMM-YYYY format
 * @returns {Object} Object with day, month, monthNum, and year properties
 */
function getDateComponents(searchDate) {
  const searchDateParts = searchDate.toLowerCase().split('-');
  if (searchDateParts.length !== 3) {
    return null;
  }

  const [searchDay, searchMonth, searchYear] = searchDateParts;

  return {
    day: parseInt(searchDay),
    month: searchMonth,
    monthNum: getMonthNumber(searchMonth),
    year: parseInt(searchYear),
  };
}

/**
 * Convert month name to month number
 * @param {string} monthStr - Month name (e.g., 'Jan', 'February')
 * @returns {number} Month number (1-12)
 */
function getMonthNumber(monthStr) {
  const monthMap = {
    jan: 1,
    january: 1,
    feb: 2,
    february: 2,
    mar: 3,
    march: 3,
    apr: 4,
    april: 4,
    may: 5,
    jun: 6,
    june: 6,
    jul: 7,
    july: 7,
    aug: 8,
    august: 8,
    sep: 9,
    sept: 9,
    september: 9,
    oct: 10,
    october: 10,
    nov: 11,
    november: 11,
    dec: 12,
    december: 12,
  };

  return monthMap[monthStr.toLowerCase()] || 0;
}

module.exports = {
  checkDateMatch,
  getDateComponents,
  getMonthNumber,
  excelSerialDateToJSDate,
};
