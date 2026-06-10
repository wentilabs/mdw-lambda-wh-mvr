// WBGT Monthly Monitoring Sheet Handlers
// Handles monthly sheet creation, date population, and temperature writing

const {
  formatMonthlySheetName,
  roundToNearestHour,
  isWithinTrackingHours,
  convertSerialToDate,
} = require("../utils/date");
const { readGoogleSheet, duplicateSheet, batchUpdateRanges, updateCell, getAuth } = require("../utils/gsheet");
const { sheets: createSheets } = require("@googleapis/sheets");
const { getTemperatureColumnIndex } = require("../utils/wbgt-monitoring");

/**
 * Ensure monthly WBGT monitoring sheet exists
 * If doesn't exist, clone from "Template Monitoring Record" and populate dates
 * @param {Date} date - Date to determine which monthly sheet
 * @param {string} spreadsheetId - Spreadsheet ID
 * @returns {Promise<string>} - Name of monthly sheet (e.g., "Dec-2025")
 */
async function ensureMonthlySheetExists(date, spreadsheetId) {
  try {
    const monthlySheetName = formatMonthlySheetName(date);
    console.log(`[WBGT MONTHLY] Checking if sheet exists: ${monthlySheetName}`);

    // Try to read the sheet
    let sheetData;
    try {
      sheetData = await readGoogleSheet(spreadsheetId, monthlySheetName);
    } catch (error) {
      sheetData = null; // Sheet doesn't exist
    }

    if (sheetData && sheetData.length > 0) {
      console.log(`✅ [WBGT MONTHLY] Sheet "${monthlySheetName}" already exists`);
      return monthlySheetName;
    }

    // Clone from template
    console.log(`🔄 [WBGT MONTHLY] Creating sheet from template...`);
    const templateSheetName = "Template Monitoring Record";
    await duplicateSheet(spreadsheetId, templateSheetName, monthlySheetName, false);
    console.log(`✅ [WBGT MONTHLY] Sheet cloned: ${monthlySheetName}`);

    // Populate dates for the target month
    console.log(`📅 [WBGT MONTHLY] Populating dates for ${monthlySheetName}...`);
    await populateMonthlySheetDates(spreadsheetId, monthlySheetName, date);
    console.log(`✅ [WBGT MONTHLY] Dates populated successfully`);

    return monthlySheetName;
  } catch (error) {
    console.error("[WBGT MONTHLY] Error ensuring sheet exists:", error);
    throw new Error(`Failed to create monthly sheet: ${error.message}`);
  }
}

/**
 * Apply comprehensive formatting to a row (alignment, borders, date format)
 * @param {string} spreadsheetId - Spreadsheet ID
 * @param {number} sheetId - Sheet ID (numeric)
 * @param {string} sheetName - Sheet name (for logging)
 * @param {number} rowNumber - Row number (1-based)
 * @param {number} startCol - Start column index (0-based)
 * @param {number} endCol - End column index (0-based, exclusive)
 */
async function applyRowFormatting(spreadsheetId, sheetId, sheetName, rowNumber, startCol = 0, endCol = 21) {
  try {
    const sheets = createSheets({ version: "v4", auth: getAuth() });

    const requests = [
      // Apply center alignment to entire row
      {
        repeatCell: {
          range: {
            sheetId: sheetId,
            startRowIndex: rowNumber - 1,
            endRowIndex: rowNumber,
            startColumnIndex: startCol,
            endColumnIndex: endCol,
          },
          cell: {
            userEnteredFormat: {
              horizontalAlignment: "CENTER",
              verticalAlignment: "MIDDLE",
            },
          },
          fields: "userEnteredFormat(horizontalAlignment,verticalAlignment)",
        },
      },
      // Apply borders to entire row
      {
        updateBorders: {
          range: {
            sheetId: sheetId,
            startRowIndex: rowNumber - 1,
            endRowIndex: rowNumber,
            startColumnIndex: startCol,
            endColumnIndex: endCol,
          },
          top: {
            style: "SOLID",
            width: 1,
            color: { red: 0, green: 0, blue: 0 },
          },
          bottom: {
            style: "SOLID",
            width: 1,
            color: { red: 0, green: 0, blue: 0 },
          },
          left: {
            style: "SOLID",
            width: 1,
            color: { red: 0, green: 0, blue: 0 },
          },
          right: {
            style: "SOLID",
            width: 1,
            color: { red: 0, green: 0, blue: 0 },
          },
          innerHorizontal: {
            style: "SOLID",
            width: 1,
            color: { red: 0, green: 0, blue: 0 },
          },
          innerVertical: {
            style: "SOLID",
            width: 1,
            color: { red: 0, green: 0, blue: 0 },
          },
        },
      },
      // Apply date formatting to column C (index 2)
      {
        repeatCell: {
          range: {
            sheetId: sheetId,
            startRowIndex: rowNumber - 1,
            endRowIndex: rowNumber,
            startColumnIndex: 2,
            endColumnIndex: 3,
          },
          cell: {
            userEnteredFormat: {
              numberFormat: {
                type: "DATE",
                pattern: "dd-mmm-yy",
              },
            },
          },
          fields: "userEnteredFormat.numberFormat",
        },
      },
    ];

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests },
    });

    console.log(`✅ [ROW FORMAT] Applied formatting (alignment, borders, date) to row ${rowNumber} in ${sheetName}`);
  } catch (error) {
    console.error("[ROW FORMAT] Error applying formatting:", error.message);
    throw error;
  }
}

/**
 * Populate correct dates in monthly monitoring sheet after cloning
 * Handles different month lengths (28/29/30/31 days) and adds/removes rows as needed
 * @param {string} spreadsheetId - Spreadsheet ID
 * @param {string} sheetName - Monthly sheet name (e.g., "Dec-2025")
 * @param {Date} targetDate - Date representing the target month
 * @returns {Promise<void>}
 */
async function populateMonthlySheetDates(spreadsheetId, sheetName, targetDate) {
  try {
    // Get sheetId for formatting operations
    const sheets = createSheets({ version: "v4", auth: getAuth() });
    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
    const sheet = spreadsheet.data.sheets.find((s) => s.properties.title === sheetName);
    if (!sheet) {
      throw new Error(`Sheet "${sheetName}" not found for formatting`);
    }
    const sheetId = sheet.properties.sheetId;

    const year = targetDate.getFullYear();
    const month = targetDate.getMonth(); // 0-11

    // Calculate days in target month
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    console.log(`[WBGT DATES] Target month has ${daysInMonth} days`);

    // Calculate Excel serial number for first day of month
    // Use Date.UTC() to avoid timezone offset mismatch between 1899 (historical TZ) and modern dates
    // Excel/Google Sheets base: December 30, 1899 (serial 0)
    const firstDayOfMonth = Date.UTC(year, month, 1);
    const excelBaseDate = Date.UTC(1899, 11, 30);
    const firstDaySerial = Math.round((firstDayOfMonth - excelBaseDate) / (24 * 60 * 60 * 1000));

    console.log(`[WBGT DATES] First day serial: ${firstDaySerial} (${year}-${String(month + 1).padStart(2, "0")}-01)`);

    // Build updates for column C (index 2)
    // Data rows start at row 6 (1-based notation)
    // Clear row 5 date (template leftover) to prevent stale dates in cloned sheets
    const updates = [{ range: `${sheetName}!C5`, values: [[""]] }];
    const dataStartRowOneBased = 6; // First data row is row 6 in 1-based notation

    for (let day = 1; day <= daysInMonth; day++) {
      const rowOneBased = dataStartRowOneBased + day - 1; // Row 6 for day 1, row 7 for day 2, etc.
      const serialNumber = firstDaySerial + day - 1;

      updates.push({
        range: `${sheetName}!C${rowOneBased}`,
        values: [[serialNumber]],
      });

      // Also update S/N in column A
      updates.push({
        range: `${sheetName}!A${rowOneBased}`,
        values: [[day]],
      });
    }

    // Batch update all date cells
    if (updates.length > 0) {
      await batchUpdateRanges(spreadsheetId, updates);
      console.log(`✅ [WBGT DATES] Updated ${daysInMonth} date cells`);
    }

    // Handle row additions for different month lengths
    const templateRows = 30; // November template has 30 rows

    if (daysInMonth > templateRows) {
      // Need to add rows (e.g., December with 31 days)
      const rowsToAdd = daysInMonth - templateRows;
      console.log(`[WBGT DATES] Adding ${rowsToAdd} row(s) for ${daysInMonth}-day month`);

      // Copy row 35 (last November row) and append for day 31
      const lastRowData = await readGoogleSheet(spreadsheetId, `${sheetName}!A35:U35`);
      if (lastRowData && lastRowData.length > 0) {
        const newRow = [...lastRowData[0]];
        newRow[0] = 31; // S/N
        newRow[1] = "ZRA"; // Site location
        newRow[2] = firstDaySerial + 30; // December 31st serial
        // Clear temperature columns (indices 3, 5, 7, 9, 11, 13, 15, 17, 19)
        [3, 5, 7, 9, 11, 13, 15, 17, 19].forEach((idx) => {
          if (newRow[idx] !== undefined) newRow[idx] = "";
        });

        await batchUpdateRanges(spreadsheetId, [
          {
            range: `${sheetName}!A36:U36`,
            values: [newRow],
          },
        ]);
        console.log(`✅ [WBGT DATES] Added row 36 for day 31`);

        // Apply comprehensive formatting to row 36 (alignment, borders, date format)
        await applyRowFormatting(spreadsheetId, sheetId, sheetName, 36, 0, 21);
        console.log(`✅ [WBGT DATES] Applied formatting to row 36`);
      }
    } else if (daysInMonth < templateRows) {
      // Need to remove rows (e.g., February with 28/29 days)
      console.log(
        `⚠️ [WBGT DATES] Month has ${daysInMonth} days, template has ${templateRows}. Extra rows will remain but won't be used.`,
      );
      // Don't delete rows - just leave them blank. Safer approach.
    }
  } catch (error) {
    console.error("[WBGT DATES] Error populating dates:", error);
    throw error;
  }
}

/**
 * Normalize various date formats to YYYY-MM-DD
 * @param {string} dateStr - Date string in various formats
 * @returns {string} - YYYY-MM-DD format
 */
function normalizeDateToISO(dateStr) {
  try {
    // Handle "1-Nov-2025", "01-Nov-2025" format
    const match = dateStr.match(/^(\d{1,2})-([A-Za-z]{3,4})-(\d{4})$/);
    if (match) {
      const [, day, month, year] = match;
      const monthMap = {
        Jan: "01",
        Feb: "02",
        Mar: "03",
        Apr: "04",
        May: "05",
        Jun: "06",
        Jul: "07",
        Aug: "08",
        Sep: "09",
        Sept: "09",
        Oct: "10",
        Nov: "11",
        Dec: "12",
      };
      const monthNum = monthMap[month];
      if (monthNum) {
        const dayNum = day.padStart(2, "0");
        return `${year}-${monthNum}-${dayNum}`;
      }
    }

    // Try parsing as ISO or other standard formats
    const parsed = new Date(dateStr);
    if (!isNaN(parsed.getTime())) {
      return parsed.toISOString().split("T")[0];
    }

    return dateStr;
  } catch (error) {
    console.error("Error normalizing date:", error);
    return dateStr;
  }
}

/**
 * Find row index by date in column C of monthly monitoring sheet
 * @param {Array<Array>} sheetData - 2D array from readGoogleSheet()
 * @param {Date} targetDate - Date to find
 * @returns {number|null} - Row index (1-based) or null if not found
 */
function findRowByDate(sheetData, targetDate) {
  if (!sheetData || sheetData.length < 2) {
    console.warn("[WBGT MONTHLY] Sheet has no data rows");
    return null;
  }

  const targetDateStr = targetDate.toISOString().split("T")[0];
  console.log(`[WBGT MONTHLY] Searching for date: ${targetDateStr}`);

  const dateColumnIndex = 2; // Column C

  for (let i = 1; i < sheetData.length; i++) {
    const cellValue = sheetData[i][dateColumnIndex];
    if (!cellValue) continue;

    let cellDateStr;

    // Handle Excel serial numbers
    if (typeof cellValue === "number") {
      cellDateStr = convertSerialToDate(cellValue);
    }
    // Handle formatted strings
    else if (typeof cellValue === "string") {
      cellDateStr = normalizeDateToISO(cellValue);
    }

    if (cellDateStr === targetDateStr) {
      console.log(`✅ [WBGT MONTHLY] Found at row ${i + 1}`);
      return i + 1; // 1-based for Google Sheets API
    }
  }

  console.warn(`⚠️ [WBGT MONTHLY] No row found for ${targetDateStr}`);
  return null;
}

/**
 * Write WBGT temperature to monthly monitoring sheet
 * @param {number} temperature - Temperature in Celsius
 * @param {Date} timestamp - Timestamp of reading
 * @param {object} groupConfig - Group configuration
 * @returns {Promise<boolean>} - True if successful
 */
async function writeToMonthlyMonitoringSheet(temperature, timestamp, groupConfig) {
  try {
    console.log(`[WBGT MONTHLY] Processing ${temperature}°C at ${timestamp.toISOString()}`);

    // Validate time range
    if (!isWithinTrackingHours(timestamp)) {
      const hour = roundToNearestHour(timestamp);
      console.log(`⏭️ [WBGT MONTHLY] Skipping - hour ${hour} outside range`);
      return false;
    }

    // Get spreadsheet ID
    const spreadsheetId = groupConfig?.wbgtSpreadsheetId || groupConfig?.spreadsheetId;
    if (!spreadsheetId) {
      console.error("[WBGT MONTHLY] No spreadsheetId");
      return false;
    }

    // Ensure monthly sheet exists
    const monthlySheetName = await ensureMonthlySheetExists(timestamp, spreadsheetId);

    // Load sheet data
    const sheetData = await readGoogleSheet(spreadsheetId, monthlySheetName);
    if (!sheetData || sheetData.length < 2) {
      console.error(`[WBGT MONTHLY] Sheet has no data`);
      return false;
    }

    // Find row by date
    const rowIndex = findRowByDate(sheetData, timestamp);
    if (!rowIndex) {
      console.error(`[WBGT MONTHLY] Row not found`);
      return false;
    }

    // Get column for hour
    const hour = roundToNearestHour(timestamp);
    const columnIndex = getTemperatureColumnIndex(hour);
    if (columnIndex === null) {
      console.error(`[WBGT MONTHLY] Invalid hour ${hour}`);
      return false;
    }

    // Write temperature
    console.log(`📝 [WBGT MONTHLY] Writing to ${monthlySheetName}, row ${rowIndex}, col ${columnIndex}`);
    await updateCell(spreadsheetId, monthlySheetName, rowIndex, columnIndex, temperature);

    console.log(`✅ [WBGT MONTHLY] Write successful`);
    return true;
  } catch (error) {
    console.error("[WBGT MONTHLY] Error:", error);
    return false; // Non-blocking
  }
}

module.exports = {
  ensureMonthlySheetExists,
  populateMonthlySheetDates,
  normalizeDateToISO,
  findRowByDate,
  writeToMonthlyMonitoringSheet,
};
