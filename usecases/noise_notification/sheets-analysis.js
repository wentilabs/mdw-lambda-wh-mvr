/**
 * Noise Analysis Sheet Writer
 *
 * Writes Leq5min data to the noise analysis spreadsheet (NM01/NM02 sheets).
 * Each sheet has dates as columns and 5-min time intervals as rows.
 * New dates are appended as new columns automatically.
 *
 * Sheet structure:
 *   Row 1: Day names (Wed, Thu, ...)
 *   Row 2: Dates as Excel serial numbers
 *   Row 3: 12-HR AVG (formula)
 *   Rows 4-15: 7:00-7:55 AM (12 data rows)
 *   Rows 16-17: 7 AM AVG / MAX ALLOWED
 *   Rows 18-29: 8:00-8:55 AM
 *   ... pattern repeats (14 rows per hour block) through 11 PM
 */

const { getAuth, readGoogleSheet } = require("../../utils/gsheet");
const { sheets: createSheets } = require("@googleapis/sheets");

const ANALYSIS_SPREADSHEET_ID = () => process.env.NOISE_LIMITS_SPREADSHEET_ID || process.env.NOISE_SPREADSHEET_ID;

// Day names for row 1
const DAY_NAMES = ["Sun", "Mon", "Tues", "Wed", "Thu", "Fri", "Sat"];

/**
 * Convert a JS Date to an Excel serial number
 * Excel base: Dec 30, 1899 = serial 0
 */
function dateToExcelSerial(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const excelBase = new Date(1899, 11, 30);
  return Math.round((d - excelBase) / (24 * 60 * 60 * 1000));
}

/**
 * Convert column index (0-based) to column letter (A, B, ..., Z, AA, AB, ...)
 */
function colIndexToLetter(index) {
  let letter = "";
  let i = index;
  while (i >= 0) {
    letter = String.fromCharCode((i % 26) + 65) + letter;
    i = Math.floor(i / 26) - 1;
  }
  return letter;
}

/**
 * Map a timestamp hour+minute to the row number in the analysis sheet.
 * Pattern: hour block starts at row 4 + (hour - 7) * 14
 * Within each block: 12 data rows (5-min intervals), then 2 summary rows
 *
 * @param {number} hour - Hour (7-22)
 * @param {number} minute - Minute (0, 5, 10, ..., 55)
 * @returns {number|null} - 1-based row number, or null if out of range
 */
function timeToAnalysisRow(hour, minute) {
  if (hour < 7 || hour > 22) return null;
  if (minute % 5 !== 0) {
    minute = Math.round(minute / 5) * 5;
  }
  const intervalIndex = minute / 5; // 0-11
  if (intervalIndex < 0 || intervalIndex > 11) return null;

  // Each hour block: 12 data rows + 2 summary rows = 14 rows
  // First block (7 AM) starts at row 4
  const blockStart = 4 + (hour - 7) * 14;
  return blockStart + intervalIndex;
}

/**
 * Find the column index for a given date in the analysis sheet.
 * Reads row 2 which contains Excel serial numbers.
 * Returns the 0-based column index, or -1 if not found.
 *
 * @param {object} sheetsApi - Google Sheets API instance
 * @param {string} sheetName - Sheet name (NM01 or NM02)
 * @param {number} targetSerial - Excel serial number for the target date
 * @returns {Promise<{colIndex: number, totalCols: number}>}
 */
async function findDateColumn(sheetsApi, sheetName, targetSerial) {
  const spreadsheetId = ANALYSIS_SPREADSHEET_ID();

  const result = await sheetsApi.spreadsheets.values.get({
    spreadsheetId,
    range: `'${sheetName}'!1:2`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });

  const row2 = result.data.values?.[1] || [];

  // Search for the serial number in row 2 (skip column A which is labels)
  for (let i = 1; i < row2.length; i++) {
    if (row2[i] === targetSerial) {
      return { colIndex: i, totalCols: row2.length };
    }
  }

  return { colIndex: -1, totalCols: row2.length };
}

/**
 * Add a new date column to the analysis sheet by cloning the previous column's
 * formulas and writing the new date header. Data cells are left empty for writing.
 *
 * @param {object} sheetsApi - Google Sheets API instance
 * @param {string} sheetName - Sheet name
 * @param {number} colIndex - 0-based column index for the new column
 * @param {Date} date - The date to add
 * @param {number} serial - Excel serial number
 */
async function addDateColumn(sheetsApi, sheetName, colIndex, date, serial) {
  const spreadsheetId = ANALYSIS_SPREADSHEET_ID();
  const colLetter = colIndexToLetter(colIndex);
  const prevColLetter = colIndexToLetter(colIndex - 1);
  const dayName = DAY_NAMES[date.getDay()];

  console.log(`[Analysis] Adding new column ${colLetter} by cloning ${prevColLetter} in ${sheetName}`);

  // First, expand the grid by appending a column (the sheet may not have enough columns)
  const spreadsheet = await sheetsApi.spreadsheets.get({ spreadsheetId });
  const sheet = spreadsheet.data.sheets.find((s) => s.properties.title === sheetName);
  if (sheet) {
    const currentCols = sheet.properties.gridProperties.columnCount;
    if (colIndex >= currentCols) {
      await sheetsApi.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              appendDimension: {
                sheetId: sheet.properties.sheetId,
                dimension: "COLUMNS",
                length: colIndex - currentCols + 1,
              },
            },
          ],
        },
      });
      console.log(`[Analysis] Expanded grid from ${currentCols} to ${colIndex + 1} columns`);
    }
  }

  // Read the entire previous column (formulas) to clone its structure
  const prevResult = await sheetsApi.spreadsheets.values.get({
    spreadsheetId,
    range: `'${sheetName}'!${prevColLetter}1:${prevColLetter}241`,
    valueRenderOption: "FORMULA",
  });

  const prevValues = prevResult.data.values || [];

  // Build the new column: clone formulas from prev column, clear data cells
  const newValues = prevValues.map((row, i) => {
    const rowNum = i + 1;
    const cellValue = row[0];

    // Row 1: day name (override)
    if (rowNum === 1) return [dayName];
    // Row 2: date serial (override)
    if (rowNum === 2) return [serial];

    // If it's a formula, adapt column references from prev to new
    // Only replace the letter when it's a cell reference (followed by a digit, $, or :)
    // e.g., F4 → G4, F$4 → G$4, F15 → G15, but NOT FILTER → GILTER
    if (typeof cellValue === "string" && cellValue.startsWith("=")) {
      const newFormula = cellValue.replace(new RegExp(`(?<![A-Za-z])${prevColLetter}(?=\\d|\\$|:)`, "g"), colLetter);
      return [newFormula];
    }

    // For data rows (non-formula), leave empty so new data can be written
    // Check if this is a formula row (row 3 = 12HR AVG, or hourly AVG/MAX ALLOWED rows)
    // These are: row 3, and rows 16,17,30,31,44,45,...
    // Data rows: 4-15, 18-29, 32-43, ...
    return [""];
  });

  // Write the entire new column at once
  await sheetsApi.spreadsheets.values.update({
    spreadsheetId,
    range: `'${sheetName}'!${colLetter}1:${colLetter}${newValues.length}`,
    valueInputOption: "USER_ENTERED",
    resource: { values: newValues },
  });

  // Copy formatting (bold, background, borders) from previous column
  if (sheet) {
    const totalRows = sheet.properties.gridProperties.rowCount;
    await sheetsApi.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            copyPaste: {
              source: {
                sheetId: sheet.properties.sheetId,
                startRowIndex: 0,
                endRowIndex: totalRows,
                startColumnIndex: colIndex - 1,
                endColumnIndex: colIndex,
              },
              destination: {
                sheetId: sheet.properties.sheetId,
                startRowIndex: 0,
                endRowIndex: totalRows,
                startColumnIndex: colIndex,
                endColumnIndex: colIndex + 1,
              },
              pasteType: "PASTE_FORMAT",
            },
          },
        ],
      },
    });
    console.log(`[Analysis] Copied formatting from ${prevColLetter} to ${colLetter}`);
  }

  console.log(
    `[Analysis] Created column ${colLetter} (${dayName} ${serial}) with formulas + formatting cloned from ${prevColLetter}`,
  );
}

/**
 * Write noise data to the analysis spreadsheet for a specific NM sheet.
 *
 * @param {string} nmCode - "NM01" or "NM02" (sheet name in analysis spreadsheet)
 * @param {Date} date - Target date
 * @param {Array<{hour: number, minute: number, value: number}>} readings - Leq5min readings
 * @returns {Promise<{success: boolean, written: number, colLetter: string}>}
 */
async function writeToAnalysisSheet(nmCode, date, readings) {
  try {
    const spreadsheetId = ANALYSIS_SPREADSHEET_ID();
    if (!spreadsheetId) {
      console.warn("[Analysis] No NOISE_LIMITS_SPREADSHEET_ID set, skipping analysis write");
      return { success: false, written: 0 };
    }

    const sheetsApi = createSheets({ version: "v4", auth: getAuth() });
    const serial = dateToExcelSerial(date);

    console.log(`[Analysis] Writing ${readings.length} readings to ${nmCode} for serial ${serial}`);

    // Find or create the date column
    let { colIndex, totalCols } = await findDateColumn(sheetsApi, nmCode, serial);

    if (colIndex === -1) {
      // Date not found — add new column at the end
      colIndex = totalCols;
      await addDateColumn(sheetsApi, nmCode, colIndex, date, serial);
    }

    const colLetter = colIndexToLetter(colIndex);
    console.log(`[Analysis] Using column ${colLetter} (index ${colIndex}) for ${nmCode}`);

    // Build batch updates for all readings
    const updates = [];
    for (const { hour, minute, value } of readings) {
      const row = timeToAnalysisRow(hour, minute);
      if (row === null) continue;
      updates.push({
        range: `'${nmCode}'!${colLetter}${row}`,
        values: [[value]],
      });
    }

    if (updates.length === 0) {
      console.log(`[Analysis] No valid readings to write for ${nmCode}`);
      return { success: true, written: 0, colLetter };
    }

    // Batch write
    await sheetsApi.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data: updates,
      },
    });

    console.log(`[Analysis] Wrote ${updates.length} values to ${nmCode} column ${colLetter}`);
    return { success: true, written: updates.length, colLetter };
  } catch (error) {
    console.error(`[Analysis] Error writing to ${nmCode}:`, error.message);
    return { success: false, written: 0, error: error.message };
  }
}

/**
 * Write noise data to both NM01 and NM02 analysis sheets.
 * Called from updateNoiseDataForDate after writing to the tracking sheet.
 *
 * @param {Date} date - Target date
 * @param {Object} groupedData - Data grouped by NM code from fetchNoiseDataForDateRange
 *   Format: { NM1: [{timestamp, value, timeStr}, ...], NM2: [...] }
 * @returns {Promise<{NM01: object, NM02: object}>}
 */
async function updateAnalysisSheets(date, groupedData) {
  try {
    // Map NM codes from tracking (NM1, NM2) to analysis sheet names (NM01, NM02)
    const nmMapping = { NM1: "NM01", NM2: "NM02" };

    const results = {};
    for (const [trackingCode, analysisSheetName] of Object.entries(nmMapping)) {
      const records = groupedData[trackingCode];
      if (!records || records.length === 0) {
        console.log(`[Analysis] No data for ${trackingCode}, skipping ${analysisSheetName}`);
        results[analysisSheetName] = { success: true, written: 0 };
        continue;
      }

      // Convert to the format writeToAnalysisSheet expects
      const readings = records.map((r) => {
        const ts = r.timestamp instanceof Date ? r.timestamp : new Date(r.timestamp);
        return {
          hour: ts.getHours(),
          minute: ts.getMinutes(),
          value: parseFloat(r.value),
        };
      });

      console.log(`[Analysis] ${analysisSheetName}: ${readings.length} readings`);
      results[analysisSheetName] = await writeToAnalysisSheet(analysisSheetName, date, readings);
    }

    return results;
  } catch (error) {
    console.error("[Analysis] Error updating analysis sheets:", error.message);
    return {
      NM01: { success: false, error: error.message },
      NM02: { success: false, error: error.message },
    };
  }
}

module.exports = {
  updateAnalysisSheets,
  writeToAnalysisSheet,
  dateToExcelSerial,
  timeToAnalysisRow,
  colIndexToLetter,
};
