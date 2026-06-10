// Note: dotenv is loaded in index.js handler, secrets come from AWS Secrets Manager
const { sheets: createSheets, auth: googleAuth } = require("@googleapis/sheets");

/**
 * Generic retry wrapper for Google Sheets API calls with exponential backoff
 * @param {Function} apiCall - The API call function to retry
 * @param {string} operationName - Name of the operation for logging
 * @param {number} maxRetries - Maximum number of retries (default: 3)
 * @param {number} baseDelay - Base delay in milliseconds (default: 1000)
 * @returns {Promise} - Result of the API call
 */
async function withRetry(apiCall, operationName, maxRetries = 3, baseDelay = 1000) {
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await apiCall();
      if (attempt > 0) {
        console.log(`✅ [RETRY SUCCESS] ${operationName} succeeded on attempt ${attempt + 1}`);
      }
      return result;
    } catch (error) {
      lastError = error;

      // Don't retry on the last attempt
      if (attempt === maxRetries) {
        break;
      }

      // Check if error is retryable
      const isRetryable =
        error.code === 429 || // Rate limit
        error.code === 500 || // Internal server error
        error.code === 502 || // Bad gateway
        error.code === 503 || // Service unavailable
        error.code === 504 || // Gateway timeout
        (error.message &&
          (error.message.includes("quota") ||
            error.message.includes("rate") ||
            error.message.includes("timeout") ||
            error.message.includes("internal error") ||
            error.message.includes("backend error")));

      if (!isRetryable) {
        console.error(`❌ [NON-RETRYABLE] ${operationName} failed with non-retryable error:`, error.message);
        throw error;
      }

      // Calculate delay with exponential backoff + jitter
      const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 1000;

      console.warn(
        `⚠️ [RETRY ${attempt + 1}/${maxRetries}] ${operationName} failed: ${error.message}. Retrying in ${Math.round(
          delay,
        )}ms...`,
      );

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  console.error(`❌ [RETRY EXHAUSTED] ${operationName} failed after ${maxRetries + 1} attempts:`, lastError.message);
  throw lastError;
}

// Mock functions for testing
const mockWriteArrayToGSheetRow = async (spreadsheetId, sheetName, dataArray) => {
  console.log("MOCK - Writing to Google Sheets:", { spreadsheetId, sheetName, data: dataArray });
  return Promise.resolve();
};

// Lazy initialization for Google Auth (for AWS Secrets Manager compatibility)
let auth = null;

function getAuth() {
  if (!auth) {
    auth = new googleAuth.JWT({
      email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.replace(/\\n/g, "\n"),
      scopes: ["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive.readonly"],
    });
  }
  return auth;
}

async function readGoogleSheet(spreadsheetId, sheetName) {
  return withRetry(async () => {
    const sheetsApi = createSheets({ version: "v4", auth: getAuth() });

    // Get the sheet data
    const response = await sheetsApi.spreadsheets.values.get({
      spreadsheetId,
      range: sheetName,
      valueRenderOption: "FORMULA", //read everything as raw data
    });

    const rows = response.data.values;
    if (rows && rows.length) {
      // Find the index of the 'Date' column
      const header = rows[0];
      const dateColIndex = header.findIndex((h) => h === "Date");

      // Helper to convert serial to ISO date
      function serialToDate(serial) {
        const epoch = new Date(Date.UTC(1899, 11, 30));
        const msPerDay = 24 * 60 * 60 * 1000;
        return new Date(epoch.getTime() + serial * msPerDay).toISOString().split("T")[0];
      }

      // Convert date serials in all rows except header
      if (dateColIndex !== -1) {
        for (let i = 1; i < rows.length; i++) {
          const val = rows[i][dateColIndex];
          if (val && !isNaN(val)) {
            const serial = Number(val);
            if (!isNaN(serial)) {
              rows[i][dateColIndex] = serialToDate(serial);
            }
          }
        }
      }
      return rows;
    } else {
      console.log(`READ: No data found in sheet "${sheetName}".`);
      return [];
    }
  }, `readGoogleSheet(${sheetName})`);
}

/**
 * Fetch multiple sheet ranges from one spreadsheet in a single Google Sheets API call.
 *
 * Wraps spreadsheets.values.batchGet — the recommended approach for bulk reads when
 * you need to combine many tabs (e.g. computing project-to-date totals across hundreds
 * of date-named sheets). Counts as a single quota unit regardless of how many ranges
 * you pass, so it dramatically reduces the chance of hitting the 300/min/project read
 * quota.
 *
 * Practical batch-size guidance:
 *   - Up to ~100 ranges per call is safe (range strings live in the request URL/body).
 *   - For wide reads (A:H) keep batches at 50 to keep each response payload reasonable
 *     (~5 MB at 70 rows/sheet * 8 cols).
 *   - Run a few batchGet calls concurrently (3-5) to stay well below the per-minute quota.
 *
 * @param {string} spreadsheetId
 * @param {string[]} ranges A1-style ranges, e.g. `["'30-Apr-2026'!A:H", "'01-May-2026'!A:H"]`
 * @param {object} options
 * @param {string} [options.valueRenderOption="UNFORMATTED_VALUE"]
 *   "UNFORMATTED_VALUE" is fastest + smallest payload; numbers come back as numbers.
 * @returns {Promise<Array<{range: string, values?: any[][]}>>} valueRanges in input order
 */
async function batchGetGoogleSheets(spreadsheetId, ranges, options = {}) {
  const { valueRenderOption = "UNFORMATTED_VALUE" } = options;
  if (!Array.isArray(ranges) || ranges.length === 0) return [];
  return withRetry(async () => {
    const sheetsApi = createSheets({ version: "v4", auth: getAuth() });
    const response = await sheetsApi.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges,
      valueRenderOption,
    });
    return response.data.valueRanges || [];
  }, `batchGetGoogleSheets(${ranges.length} ranges)`);
}

async function readGoogleSheetRaw(spreadsheetId, sheetName) {
  return withRetry(async () => {
    const sheetsApi = createSheets({ version: "v4", auth: getAuth() });

    // Get the sheet data
    const response = await sheetsApi.spreadsheets.values.get({
      spreadsheetId,
      range: sheetName,
      valueRenderOption: "UNFORMATTED_VALUE",
    });

    const rows = response.data.values;
    if (rows && rows.length) {
      return rows;
    } else {
      console.log(`READ: No data found in sheet "${sheetName}".`);
      return [];
    }
  }, `readGoogleSheetRaw(${sheetName})`);
}

async function writeArrayToGSheet(spreadsheetId, sheetName, dataArray, options = {}) {
  const { skipFormatting = false } = options;
  return withRetry(async () => {
    // Initialize the Google Sheets API
    const sheets = createSheets({ version: "v4", auth: getAuth() });

    // Step 1: Get the sheetId based on the sheetName
    const spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId,
    });

    const sheet = spreadsheet.data.sheets.find((s) => s.properties.title === sheetName);
    if (!sheet) {
      throw new Error(`Sheet with name "${sheetName}" not found.`);
    }

    const sheetId = sheet.properties.sheetId;

    const range = `${sheetName}!A1`;

    // Step 2: Write the array data to the sheet
    const resource = {
      values: dataArray,
    };

    // Write the data to the sheet
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: "USER_ENTERED",
      resource,
    });

    console.log("Data written successfully.");

    if (!skipFormatting) {
      // Step 3: Format the columns as currency for monetary values and right-align all numeric cells
      const requests = [
        {
          repeatCell: {
            range: {
              sheetId: sheetId, // Using the correct integer sheetId
              startRowIndex: 1, // Assuming header is in the first row
              endRowIndex: dataArray.length, // Based on the number of rows
              startColumnIndex: 1, // Assuming the first column is for the row label (skip)
              endColumnIndex: dataArray[0].length, // End at the last column
            },
            cell: {
              userEnteredFormat: {
                numberFormat: {
                  type: "CURRENCY",
                  pattern: "$#,##0.00",
                },
                horizontalAlignment: "RIGHT", // Align currency values to the right
              },
            },
            fields: "userEnteredFormat(numberFormat, horizontalAlignment)",
          },
        },
        {
          repeatCell: {
            range: {
              sheetId: sheetId, // Now using the correct integer sheetId
              startRowIndex: 1, // Start applying from the first row (after the header)
              startColumnIndex: 1, // Start from the first column with data
              endColumnIndex: dataArray[0].length, // End at the last column (apply to all columns)
            },
            cell: {
              userEnteredFormat: {
                horizontalAlignment: "RIGHT", // Ensure all numeric values are right-aligned
              },
            },
            fields: "userEnteredFormat(horizontalAlignment)",
          },
        },
      ];

      // Step 4: Apply the formatting
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        resource: {
          requests,
        },
      });
    }

    console.log("Formatting applied successfully.");
  }, `writeArrayToGSheet(${sheetName})`);
}

async function writeArrayToGSheetRow(spreadsheetId, sheetName, dataArray) {
  // Use mock in test environment
  if (process.env.NODE_ENV === "test") {
    return mockWriteArrayToGSheetRow(spreadsheetId, sheetName, dataArray);
  }

  return withRetry(async () => {
    const sheets = createSheets({ version: "v4", auth: getAuth() });

    // Ensure dataArray is properly formatted
    // If it's a single row, wrap it in an array
    const values = Array.isArray(dataArray[0]) ? dataArray : [dataArray];

    // Write the data to the sheet
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${sheetName}!A1`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      resource: {
        values: values,
      },
    });

    console.log("Data appended successfully:", {
      sheetName,
      rowCount: values.length,
      columnCount: values[0].length,
    });
  }, `writeArrayToGSheetRow(${sheetName})`);
}

async function updateExistingRow(spreadsheetId, sheetName, rowIndex, updatedData) {
  return withRetry(async () => {
    const sheets = createSheets({ version: "v4", auth: getAuth() });

    // Create the range string for the specific row (A2, A3, etc.)
    // rowIndex is 0-based in the array but 1-based in sheets, and we need to account for header
    const range = `${sheetName}!A${rowIndex}`;

    // Update the specific row
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: "USER_ENTERED",
      resource: {
        values: [updatedData], // Wrap in array since we're updating a single row
      },
    });

    console.log(`Row ${rowIndex} updated successfully.`);
    return true;
  }, `updateExistingRow(${sheetName}, row ${rowIndex})`);
}

/**
 * Convert column index to Excel column letter (0-based)
 * Examples: 0->A, 25->Z, 26->AA, 27->AB, 701->ZZ
 */
function columnIndexToLetter(index) {
  let letter = "";
  while (index >= 0) {
    letter = String.fromCharCode((index % 26) + 65) + letter;
    index = Math.floor(index / 26) - 1;
  }
  return letter;
}

async function updateCell(spreadsheetId, sheetName, rowIndex, colIndex, value) {
  // For timestamp consistency with batch updates, use batchUpdateCells for timestamps
  if (typeof value === "string" && /^\d{2}-[A-Za-z]{3}-\d{4} \d{2}:\d{2}$/.test(value)) {
    console.log(`⏱️ [TIMESTAMP] Using batch update API for consistent timestamp formatting: ${value}`);
    return batchUpdateCells(spreadsheetId, sheetName, [{ row: rowIndex, col: colIndex, value }]);
  }

  // For non-timestamp values, use regular update with retry
  return withRetry(
    async () => {
      const sheets = createSheets({ version: "v4", auth: getAuth() });
      // Convert colIndex (0-based) to column letter (handles AA, AB, etc.)
      const colLetter = columnIndexToLetter(colIndex);
      const range = `${sheetName}!${colLetter}${rowIndex}`;
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range,
        valueInputOption: "USER_ENTERED",
        resource: { values: [[value]] },
      });
    },
    `updateCell(${sheetName}, ${columnIndexToLetter(colIndex)}${rowIndex})`,
  );
}

/**
 * Duplicates a sheet in a Google Spreadsheet and renames it
 * @param {string} spreadsheetId - The ID of the spreadsheet
 * @param {string} sourceSheetName - The name of the sheet to duplicate
 * @param {string} newSheetName - The name for the new sheet
 * @param {boolean} insertAfterSource - If true, insert right after source sheet; if false, add at end (default: false)
 * @returns {Promise<object>} - The response from the API
 */
async function duplicateSheet(spreadsheetId, sourceSheetName, newSheetName, insertAfterSource = false) {
  return withRetry(async () => {
    const sheets = createSheets({ version: "v4", auth: getAuth() });

    // Step 1: Get the spreadsheet to find the source sheet ID and index
    const spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId,
    });

    const sourceSheetIndex = spreadsheet.data.sheets.findIndex((s) => s.properties.title === sourceSheetName);

    if (sourceSheetIndex === -1) {
      throw new Error(`Source sheet "${sourceSheetName}" not found.`);
    }

    const sourceSheet = spreadsheet.data.sheets[sourceSheetIndex];
    const sourceSheetId = sourceSheet.properties.sheetId;

    // Determine insert position
    let insertSheetIndex;
    if (insertAfterSource) {
      // Insert right after the source sheet
      insertSheetIndex = sourceSheetIndex + 1;
      console.log(`Will insert "${newSheetName}" at position ${insertSheetIndex} (right after "${sourceSheetName}")`);
    } else {
      // Add at the end
      insertSheetIndex = spreadsheet.data.sheets.length;
      console.log(`Will insert "${newSheetName}" at position ${insertSheetIndex} (at the end)`);
    }

    // Step 2: Duplicate the sheet and rename it
    const response = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      resource: {
        requests: [
          {
            duplicateSheet: {
              sourceSheetId: sourceSheetId,
              insertSheetIndex: insertSheetIndex,
              newSheetName: newSheetName,
            },
          },
        ],
      },
    });

    console.log(`Sheet "${sourceSheetName}" duplicated as "${newSheetName}" successfully.`);
    return response.data;
  }, `duplicateSheet(${sourceSheetName} -> ${newSheetName})`);
}

/**
 * Batch update multiple cells in a Google Sheet to avoid quota limits
 * @param {string} spreadsheetId - The ID of the spreadsheet
 * @param {string} sheetName - The name of the sheet
 * @param {Array<{row: number, col: number, value: any}>} updates - Array of update objects
 * @returns {Promise<object>} - The response from the API
 */
async function batchUpdateCells(spreadsheetId, sheetName, updates) {
  // Use mock in test environment
  if (process.env.NODE_ENV === "test") {
    console.log("MOCK - Batch updating cells in Google Sheets:", { spreadsheetId, sheetName, updates });
    return Promise.resolve();
  }

  const sheets = createSheets({ version: "v4", auth: getAuth() });

  // Step 1: Get the sheetId. Cached via resolveSheetId (1 read API call per
  // spreadsheet across the whole process) — previously called
  // spreadsheets.get() every batchUpdateCells invocation, which on bulk runs
  // (100+ docs/min) blew the Sheets read quota even before any writes hit.
  const sheetId = await resolveSheetId(spreadsheetId, sheetName);

  // Get sheet headers to identify timestamp columns. ALSO cached — used only
  // for the timestamp-column heuristic. A stale header cache is fine: tab
  // headers don't change mid-run.
  let headers = [];
  try {
    headers = await _resolveSheetHeaders(spreadsheetId, sheetName);
  } catch (error) {
    console.log("Could not read headers for timestamp column detection, using value-based detection only");
  }

  // Define timestamp column patterns
  const timestampColumnPatterns = [
    "Starting Date and Time",
    "Ending Date and Time",
    "Data and Time of Kingpost",
    "Date and Time of lowering",
    "Casting Start Time",
    "Pull Out Casing Time",
    "Updated",
  ];

  // Identify which column indices are timestamp columns
  const timestampColumnIndices = new Set();
  headers.forEach((header, index) => {
    if (typeof header === "string" && timestampColumnPatterns.some((pattern) => header.includes(pattern))) {
      timestampColumnIndices.add(index);
    }
  });

  // Step 2: Prepare batch update requests
  const requests = updates.map((update) => {
    // Detect if value is likely a timestamp in format: DD-MMM-YYYY HH:MM
    const isTimestampValue =
      typeof update.value === "string" && /^\d{2}-[A-Za-z]{3}-\d{4} \d{2}:\d{2}$/.test(update.value);

    // Check if this column should have timestamp formatting
    const isTimestampColumn = timestampColumnIndices.has(update.col);

    // Apply timestamp formatting ONLY if both conditions are met:
    // 1. The value looks like a timestamp AND
    // 2. The column is meant for timestamps
    const shouldApplyTimestampFormat = isTimestampValue && isTimestampColumn;

    // Detect if value is a formula (starts with =)
    const isFormula = typeof update.value === "string" && update.value.startsWith("=");

    // Determine value type and field name
    let valueType;
    if (isFormula) {
      valueType = "formulaValue";
    } else if (typeof update.value === "number") {
      valueType = "numberValue";
    } else if (typeof update.value === "boolean") {
      valueType = "boolValue";
    } else {
      valueType = "stringValue";
    }

    // Create base update cell request
    const updateRequest = {
      updateCells: {
        start: {
          sheetId: sheetId,
          rowIndex: update.row - 1, // Convert 1-based to 0-based indexing
          columnIndex: update.col,
        },
        rows: [
          {
            values: [
              {
                userEnteredValue: {
                  [valueType]: update.value,
                },
              },
            ],
          },
        ],
        fields: "userEnteredValue",
      },
    };

    // Apply timestamp formatting only to actual timestamp columns with timestamp values
    if (shouldApplyTimestampFormat) {
      console.log(
        `📅 [TIMESTAMP FORMAT] Applying DATE_TIME format to column ${update.col} (${headers[update.col]}) with value: ${
          update.value
        }`,
      );
      updateRequest.updateCells.rows[0].values[0].userEnteredFormat = {
        numberFormat: {
          type: "DATE_TIME",
          pattern: "dd-mmm-yyyy hh:mm",
        },
      };
      updateRequest.updateCells.fields = "userEnteredValue,userEnteredFormat.numberFormat";
    } else {
      console.log(
        `📝 [NO FORMAT] Column ${update.col} (${headers[update.col] || "unknown"}) with value: ${
          update.value
        } - isTimestampValue: ${isTimestampValue}, isTimestampColumn: ${isTimestampColumn}`,
      );
    }

    return updateRequest;
  });

  // Step 3: Execute batch update
  try {
    const response = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      resource: { requests },
    });

    console.log(`Batch updated ${updates.length} cells successfully in ${sheetName}`);
    return response.data;
  } catch (error) {
    console.error("Error in batch update:", error.message);

    // Implement exponential backoff and retry for quota errors
    if (error.code === 429 || error.message.includes("quota")) {
      console.log("Quota exceeded. Implementing exponential backoff...");

      // If updates array is large, split it
      if (updates.length > 20) {
        const midpoint = Math.floor(updates.length / 2);
        const firstHalf = updates.slice(0, midpoint);
        const secondHalf = updates.slice(midpoint);

        console.log(`Splitting ${updates.length} updates into batches of ${firstHalf.length} and ${secondHalf.length}`);

        // Wait before retrying
        await new Promise((resolve) => setTimeout(resolve, 2000 + Math.random() * 1000));

        // Process each half separately
        const results1 = await batchUpdateCells(spreadsheetId, sheetName, firstHalf);

        // Wait between batches
        await new Promise((resolve) => setTimeout(resolve, 2000 + Math.random() * 1000));

        const results2 = await batchUpdateCells(spreadsheetId, sheetName, secondHalf);

        return { firstBatch: results1, secondBatch: results2 };
      } else {
        // For smaller batches, just retry once after a delay
        await new Promise((resolve) => setTimeout(resolve, 5000 + Math.random() * 2000));
        return batchUpdateCells(spreadsheetId, sheetName, updates);
      }
    } else {
      throw error;
    }
  }
}

/**
 * Move a sheet to the last (rightmost) position in the spreadsheet
 * @param {string} spreadsheetId - The ID of the spreadsheet
 * @param {string} sheetName - The name of the sheet to move
 * @returns {Promise<object>} - The response from the API
 */
async function moveSheetToEnd(spreadsheetId, sheetName) {
  return withRetry(async () => {
    const sheets = createSheets({ version: "v4", auth: getAuth() });

    // Get spreadsheet to find sheet ID and total sheet count
    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });

    const sheet = spreadsheet.data.sheets.find((s) => s.properties.title === sheetName);
    if (!sheet) {
      throw new Error(`Sheet "${sheetName}" not found.`);
    }

    const sheetId = sheet.properties.sheetId;
    const totalSheets = spreadsheet.data.sheets.length;

    // Move to last position (index = totalSheets - 1, since it's 0-based)
    const response = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      resource: {
        requests: [
          {
            updateSheetProperties: {
              properties: {
                sheetId: sheetId,
                index: totalSheets - 1,
              },
              fields: "index",
            },
          },
        ],
      },
    });

    console.log(`Sheet "${sheetName}" moved to rightmost position (index ${totalSheets - 1}).`);
    return response.data;
  }, `moveSheetToEnd(${sheetName})`);
}

/**
 * Create a new sheet tab in a Google Spreadsheet
 * @param {string} spreadsheetId - The ID of the spreadsheet
 * @param {string} sheetName - The name for the new sheet
 * @returns {Promise<object>} - The response from the API
 */
async function createNewSheet(spreadsheetId, sheetName) {
  return withRetry(async () => {
    const sheets = createSheets({ version: "v4", auth: getAuth() });

    const response = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      resource: {
        requests: [
          {
            addSheet: {
              properties: {
                title: sheetName,
              },
            },
          },
        ],
      },
    });

    console.log(`Sheet "${sheetName}" created successfully.`);
    return response.data;
  }, `createNewSheet(${sheetName})`);
}

/**
 * Rename an existing sheet in a Google Spreadsheet
 * @param {string} spreadsheetId - The ID of the spreadsheet
 * @param {string} oldSheetName - The current name of the sheet
 * @param {string} newSheetName - The new name for the sheet
 * @returns {Promise<object>} - The response from the API
 */
async function renameSheet(spreadsheetId, oldSheetName, newSheetName) {
  return withRetry(async () => {
    const sheets = createSheets({ version: "v4", auth: getAuth() });

    // Step 1: Get the sheetId based on the oldSheetName
    const spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId,
    });

    const sheet = spreadsheet.data.sheets.find((s) => s.properties.title === oldSheetName);

    if (!sheet) {
      throw new Error(`Sheet "${oldSheetName}" not found in spreadsheet`);
    }

    const sheetId = sheet.properties.sheetId;

    // Step 2: Rename the sheet using updateSheetProperties
    const response = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      resource: {
        requests: [
          {
            updateSheetProperties: {
              properties: {
                sheetId: sheetId,
                title: newSheetName,
              },
              fields: "title",
            },
          },
        ],
      },
    });

    console.log(`Sheet "${oldSheetName}" renamed to "${newSheetName}" successfully.`);
    return response.data;
  }, `renameSheet(${oldSheetName} -> ${newSheetName})`);
}

/**
 * Clear all data rows but keep the header row (row 1)
 * @param {string} spreadsheetId - The ID of the spreadsheet
 * @param {string} sheetName - The name of the sheet
 * @returns {Promise<object>} - The response from the API
 */
async function clearDataKeepHeaders(spreadsheetId, sheetName) {
  return withRetry(async () => {
    const sheets = createSheets({ version: "v4", auth: getAuth() });

    // Read the sheet to get row count
    const sheetData = await readGoogleSheet(spreadsheetId, sheetName);

    if (!sheetData || sheetData.length <= 1) {
      // Only headers or empty, nothing to clear
      console.log(`Sheet "${sheetName}" has no data rows to clear`);
      return { cleared: false, rowCount: 0 };
    }

    const rowCount = sheetData.length;

    // Clear all rows from row 2 onwards (keep row 1 as headers)
    const range = `${sheetName}!A2:Z${rowCount}`;

    const response = await sheets.spreadsheets.values.clear({
      spreadsheetId,
      range,
    });

    console.log(`Cleared ${rowCount - 1} data rows from "${sheetName}", kept header row`);
    return { cleared: true, rowCount: rowCount - 1, ...response.data };
  }, `clearDataKeepHeaders(${sheetName})`);
}

/**
 * Add a conditional formatting rule to a sheet
 * @param {string} spreadsheetId - The ID of the spreadsheet
 * @param {string} sheetName - The name of the sheet
 * @param {object} rule - The conditional formatting rule object with ranges and booleanRule
 * @returns {Promise<object>} - The response from the API
 */
async function addConditionalFormatRule(spreadsheetId, sheetName, rule) {
  return withRetry(async () => {
    const sheets = createSheets({ version: "v4", auth: getAuth() });

    // Get the sheetId based on the sheetName
    const spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId,
    });

    const sheet = spreadsheet.data.sheets.find((s) => s.properties.title === sheetName);
    if (!sheet) {
      throw new Error(`Sheet with name "${sheetName}" not found.`);
    }

    const sheetId = sheet.properties.sheetId;

    // Add sheetId to each range in the rule
    const rangesWithSheetId = rule.ranges.map((range) => ({
      sheetId,
      ...range,
    }));

    const response = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      resource: {
        requests: [
          {
            addConditionalFormatRule: {
              rule: {
                ranges: rangesWithSheetId,
                booleanRule: rule.booleanRule,
              },
              index: 0,
            },
          },
        ],
      },
    });

    console.log(`Conditional formatting rule added to "${sheetName}" successfully.`);
    return response.data;
  }, `addConditionalFormatRule(${sheetName})`);
}

/**
 * Batch update multiple ranges in a Google Sheet
 * @param {string} spreadsheetId - The ID of the spreadsheet
 * @param {Array<{range: string, values: Array<Array>}>} updates - Array of update objects with range and values
 * @returns {Promise<object>} - The response from the API
 *
 * @example
 * await batchUpdateRanges(spreadsheetId, [
 *   { range: 'Sheet1!A1', values: [[1]] },
 *   { range: 'Sheet1!B1', values: [['Hello']] }
 * ]);
 */
async function batchUpdateRanges(spreadsheetId, updates, valueInputOption = "USER_ENTERED") {
  console.log(
    `🔧 [batchUpdateRanges] Called with valueInputOption: "${valueInputOption}" (type: ${typeof valueInputOption})`,
  );
  console.log(`🔧 [batchUpdateRanges] First update sample:`, JSON.stringify(updates[0], null, 2));

  return withRetry(async () => {
    const sheets = createSheets({ version: "v4", auth: getAuth() });

    const requestBody = {
      valueInputOption: valueInputOption,
      data: updates,
    };

    console.log(`🔧 [batchUpdateRanges] Request body valueInputOption: "${requestBody.valueInputOption}"`);

    const response = await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: requestBody,
    });

    console.log(`✅ Batch updated ${updates.length} ranges successfully (mode: ${valueInputOption}).`);
    return response.data;
  }, `batchUpdateRanges(${updates.length} ranges)`);
}

/**
 * Write cells using the simplest possible API - values.update with RAW mode
 * Each cell is written individually to ensure no interpretation
 * @param {string} spreadsheetId - The ID of the spreadsheet
 * @param {string} sheetName - The name of the sheet
 * @param {Array<{row: number, col: number, value: any}>} updates - Array of update objects (row is 1-based, col is 0-based)
 * @returns {Promise<void>}
 */
async function writeStringCells(spreadsheetId, sheetName, updates) {
  if (!updates || updates.length === 0) {
    return;
  }

  console.log(`📝 [writeStringCells] Writing ${updates.length} cells using values.update with RAW mode`);

  const sheets = createSheets({ version: "v4", auth: getAuth() });

  // Write each cell individually using the simplest API
  for (const update of updates) {
    const stringValue = update.value != null ? String(update.value) : "";
    const colLetter = columnIndexToLetter(update.col);
    const range = `'${sheetName}'!${colLetter}${update.row}`;

    console.log(`   📝 [writeStringCells] Writing to ${range}: "${stringValue}"`);

    await withRetry(async () => {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: range,
        valueInputOption: "RAW",
        requestBody: {
          values: [[stringValue]],
        },
      });
    }, `writeStringCells(${range})`);
  }

  console.log(`✅ [writeStringCells] Successfully wrote ${updates.length} cells`);
}

/**
 * Write time cells as decimal numbers with TIME format
 * This writes time values the same way Google Sheets stores them internally:
 * - Value is a decimal (0-1) representing fraction of day
 * - Format is TIME with pattern "h:mm:ss AM/PM"
 * @param {string} spreadsheetId - The ID of the spreadsheet
 * @param {string} sheetName - The name of the sheet
 * @param {Array<{row: number, col: number, value: number}>} updates - Array of update objects (row is 1-based, col is 0-based, value is decimal time)
 * @returns {Promise<void>}
 */
async function writeTimeCells(spreadsheetId, sheetName, updates) {
  if (!updates || updates.length === 0) {
    return;
  }

  console.log(`⏰ [writeTimeCells] Writing ${updates.length} time cells with TIME format`);

  return withRetry(async () => {
    const sheets = createSheets({ version: "v4", auth: getAuth() });

    // Get sheetId
    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
    const sheet = spreadsheet.data.sheets.find((s) => s.properties.title === sheetName);
    if (!sheet) {
      throw new Error(`Sheet with name "${sheetName}" not found.`);
    }
    const sheetId = sheet.properties.sheetId;

    // Build update requests - each cell with numberValue AND TIME format
    const requests = updates.map((update) => {
      const decimalTime = typeof update.value === "number" ? update.value : 0;
      const colLetter = columnIndexToLetter(update.col);

      console.log(`   ⏰ [writeTimeCells] Row ${update.row}, Col ${colLetter}: ${decimalTime} (decimal)`);

      return {
        updateCells: {
          start: {
            sheetId: sheetId,
            rowIndex: update.row - 1, // Convert 1-based to 0-based
            columnIndex: update.col,
          },
          rows: [
            {
              values: [
                {
                  userEnteredValue: {
                    numberValue: decimalTime,
                  },
                  userEnteredFormat: {
                    numberFormat: {
                      type: "TIME",
                      pattern: "hh:mm AM/PM",
                    },
                  },
                },
              ],
            },
          ],
          fields: "userEnteredValue,userEnteredFormat.numberFormat",
        },
      };
    });

    const response = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      resource: { requests },
    });

    console.log(`✅ [writeTimeCells] Successfully wrote ${updates.length} time cells`);
    return response.data;
  }, `writeTimeCells(${sheetName}, ${updates.length} cells)`);
}

/**
 * Clear all values in a sheet tab
 * @param {string} spreadsheetId - Spreadsheet ID
 * @param {string} sheetName - Sheet/tab name
 * @returns {Promise<boolean>} - True when clearing succeeds
 */
async function clearSheet(spreadsheetId, sheetName) {
  return withRetry(async () => {
    const sheets = createSheets({ version: "v4", auth: getAuth() });

    await sheets.spreadsheets.values.clear({
      spreadsheetId,
      range: sheetName,
    });

    console.log(`Sheet "${sheetName}" cleared successfully.`);
    return true;
  }, `clearSheet(${sheetName})`);
}

/**
 * Freeze rows at the top of a sheet (typically used for header rows)
 * @param {string} spreadsheetId - The ID of the spreadsheet
 * @param {string} sheetName - The name of the sheet
 * @param {number} frozenRowCount - Number of rows to freeze (default: 1 for header)
 * @returns {Promise<object>} - The response from the API
 */
async function freezeRows(spreadsheetId, sheetName, frozenRowCount = 1) {
  return withRetry(async () => {
    const sheets = createSheets({ version: "v4", auth: getAuth() });

    // Get the sheetId
    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
    const sheet = spreadsheet.data.sheets.find((s) => s.properties.title === sheetName);

    if (!sheet) {
      throw new Error(`Sheet "${sheetName}" not found.`);
    }

    const sheetId = sheet.properties.sheetId;

    const response = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      resource: {
        requests: [
          {
            updateSheetProperties: {
              properties: {
                sheetId: sheetId,
                gridProperties: {
                  frozenRowCount: frozenRowCount,
                },
              },
              fields: "gridProperties.frozenRowCount",
            },
          },
        ],
      },
    });

    console.log(`Froze ${frozenRowCount} row(s) in sheet "${sheetName}".`);
    return response.data;
  }, `freezeRows(${sheetName}, ${frozenRowCount})`);
}

/**
 * Protect a range in a sheet (lock it from editing)
 * @param {string} spreadsheetId - The ID of the spreadsheet
 * @param {string} sheetName - The name of the sheet
 * @param {object} options - Protection options
 * @param {number} options.startRowIndex - Start row (0-based, default: 0)
 * @param {number} options.endRowIndex - End row (exclusive, default: 1 for header only)
 * @param {string} options.description - Description for the protected range
 * @param {boolean} options.warningOnly - If true, shows warning but allows edit (default: false)
 * @param {string[]} options.allowedEditors - List of email addresses allowed to edit (default: only service account)
 * @returns {Promise<object>} - The response from the API
 */
async function protectRange(spreadsheetId, sheetName, options = {}) {
  const {
    startRowIndex = 0,
    endRowIndex = 1,
    description = "Protected header row",
    warningOnly = false,
    allowedEditors = null, // null means only service account can edit
  } = options;

  return withRetry(async () => {
    const sheets = createSheets({ version: "v4", auth: getAuth() });

    // Get the sheetId
    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
    const sheet = spreadsheet.data.sheets.find((s) => s.properties.title === sheetName);

    if (!sheet) {
      throw new Error(`Sheet "${sheetName}" not found.`);
    }

    const sheetId = sheet.properties.sheetId;

    // Build protected range object
    const protectedRange = {
      range: {
        sheetId: sheetId,
        startRowIndex: startRowIndex,
        endRowIndex: endRowIndex,
      },
      description: description,
      warningOnly: warningOnly,
    };

    // If not warningOnly, restrict editors to only the service account (or specified editors)
    // This prevents other spreadsheet editors from editing the protected range
    if (!warningOnly) {
      const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
      protectedRange.editors = {
        users: allowedEditors || (serviceAccountEmail ? [serviceAccountEmail] : []),
      };
      console.log(`[PROTECT] Restricting editors to: ${protectedRange.editors.users.join(", ") || "none"}`);
    }

    const response = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      resource: {
        requests: [
          {
            addProtectedRange: {
              protectedRange: protectedRange,
            },
          },
        ],
      },
    });

    console.log(
      `Protected rows ${startRowIndex + 1}-${endRowIndex} in sheet "${sheetName}" (warningOnly: ${warningOnly}).`,
    );
    return response.data;
  }, `protectRange(${sheetName}, rows ${startRowIndex}-${endRowIndex})`);
}

/**
 * Setup header row with freeze and protection
 * @param {string} spreadsheetId - The ID of the spreadsheet
 * @param {string} sheetName - The name of the sheet
 * @param {object} options - Options for header setup
 * @param {boolean} options.freeze - Whether to freeze the header row (default: true)
 * @param {boolean} options.protect - Whether to protect the header row (default: true)
 * @param {boolean} options.warningOnly - If true, protection shows warning but allows edit (default: false)
 * @returns {Promise<void>}
 */
async function setupHeaderRow(spreadsheetId, sheetName, options = {}) {
  const { freeze = true, protect = true, warningOnly = false } = options;

  console.log(`[HEADER SETUP] Setting up header row for "${sheetName}"...`);

  if (freeze) {
    await freezeRows(spreadsheetId, sheetName, 1);
  }

  if (protect) {
    await protectRange(spreadsheetId, sheetName, {
      startRowIndex: 0,
      endRowIndex: 1,
      description: `${sheetName} - Protected header row`,
      warningOnly: warningOnly,
    });
  }

  console.log(`[HEADER SETUP] Header row setup complete for "${sheetName}" (freeze: ${freeze}, protect: ${protect}).`);
}

/**
 * Get all sheet names from a spreadsheet
 * @param {string} spreadsheetId - The ID of the spreadsheet
 * @returns {Promise<string[]>} - Array of sheet names
 */
async function getSheetNames(spreadsheetId) {
  return withRetry(async () => {
    const sheets = createSheets({ version: "v4", auth: getAuth() });

    const spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId,
    });

    const sheetNames = spreadsheet.data.sheets.map((sheet) => sheet.properties.title);
    console.log(`Found ${sheetNames.length} sheets in spreadsheet`);
    return sheetNames;
  }, `getSheetNames(${spreadsheetId})`);
}

/**
 * Check if a sheet exists in a spreadsheet
 * @param {string} spreadsheetId - The ID of the spreadsheet
 * @param {string} sheetName - The name of the sheet to check
 * @returns {Promise<boolean>} - True if sheet exists
 */
async function sheetExists(spreadsheetId, sheetName) {
  const sheetNames = await getSheetNames(spreadsheetId);
  return sheetNames.includes(sheetName);
}

/**
 * Get sheet properties including freeze and protection status
 * @param {string} spreadsheetId - The ID of the spreadsheet
 * @param {string} sheetName - The name of the sheet
 * @returns {Promise<object>} - Sheet properties including frozenRowCount, hasHeaderProtection
 */
async function getSheetProperties(spreadsheetId, sheetName) {
  return withRetry(async () => {
    const sheets = createSheets({ version: "v4", auth: getAuth() });

    const spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId,
      includeGridData: false,
    });

    const sheet = spreadsheet.data.sheets.find((s) => s.properties.title === sheetName);

    if (!sheet) {
      throw new Error(`Sheet "${sheetName}" not found.`);
    }

    const frozenRowCount = sheet.properties.gridProperties?.frozenRowCount || 0;

    // Check if header row (row 1) is protected
    let hasHeaderProtection = false;
    if (sheet.protectedRanges && sheet.protectedRanges.length > 0) {
      hasHeaderProtection = sheet.protectedRanges.some(
        (pr) => pr.range.startRowIndex === 0 && pr.range.endRowIndex === 1,
      );
    }

    return {
      sheetId: sheet.properties.sheetId,
      frozenRowCount,
      hasHeaderProtection,
      protectedRanges: sheet.protectedRanges || [],
    };
  }, `getSheetProperties(${sheetName})`);
}

/**
 * Ensure a sheet/tab has at least `minColumns` columns, appending columns at the
 * end if it is narrower. Google Sheets rejects writes to a columnIndex beyond the
 * current grid width, so callers that may write into far-right columns (e.g. the
 * water-parade blocks that spill rightward H/L/P/… past column Z) must call this
 * first. Returns the resulting column count.
 *
 * @param {string} spreadsheetId
 * @param {string} sheetName
 * @param {number} minColumns - required column count (1-based count, not index)
 * @returns {Promise<number>} the column count after any expansion
 */
async function ensureColumnCount(spreadsheetId, sheetName, minColumns) {
  return withRetry(async () => {
    const sheets = createSheets({ version: "v4", auth: getAuth() });
    const meta = await sheets.spreadsheets.get({
      spreadsheetId,
      includeGridData: false,
      fields: "sheets(properties(sheetId,title,gridProperties(columnCount)))",
    });
    const sheet = (meta.data.sheets || []).find((s) => s.properties.title === sheetName);
    if (!sheet) throw new Error(`Sheet "${sheetName}" not found.`);
    const current = sheet.properties.gridProperties?.columnCount || 0;
    if (current >= minColumns) return current;
    const add = minColumns - current;
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      resource: {
        requests: [{ appendDimension: { sheetId: sheet.properties.sheetId, dimension: "COLUMNS", length: add } }],
      },
    });
    console.log(`[gsheet] expanded "${sheetName}" columns ${current} → ${minColumns}`);
    return minColumns;
  }, `ensureColumnCount(${sheetName}, ${minColumns})`);
}

/**
 * Ensure header row is frozen and protected (checks first, applies if needed)
 * @param {string} spreadsheetId - The ID of the spreadsheet
 * @param {string} sheetName - The name of the sheet
 * @param {object} options - Options
 * @param {boolean} options.warningOnly - If true, protection shows warning but allows edit (default: false)
 * @returns {Promise<object>} - Status of what was applied
 */
async function ensureHeaderRowSetup(spreadsheetId, sheetName, options = {}) {
  const { warningOnly = false } = options;

  console.log(`[HEADER SETUP] Checking header row setup for "${sheetName}"...`);

  const props = await getSheetProperties(spreadsheetId, sheetName);
  const result = { froze: false, protected: false };

  // Check and apply freeze if needed
  if (props.frozenRowCount < 1) {
    console.log(`[HEADER SETUP] Row 1 not frozen - applying freeze...`);
    await freezeRows(spreadsheetId, sheetName, 1);
    result.froze = true;
  } else {
    console.log(`[HEADER SETUP] Row 1 already frozen ✓`);
  }

  // Check and apply protection if needed
  if (!props.hasHeaderProtection) {
    console.log(`[HEADER SETUP] Row 1 not protected - applying protection...`);
    await protectRange(spreadsheetId, sheetName, {
      startRowIndex: 0,
      endRowIndex: 1,
      description: `${sheetName} - Protected header row`,
      warningOnly: warningOnly,
    });
    result.protected = true;
  } else {
    console.log(`[HEADER SETUP] Row 1 already protected ✓`);
  }

  console.log(
    `[HEADER SETUP] Header row setup complete for "${sheetName}" (froze: ${result.froze}, protected: ${result.protected}).`,
  );
  return result;
}

/**
 * Protect entire sheet (prevents renaming/deleting sheet tab) while allowing data entry
 * This protects:
 * - Header row (row 1) from editing
 * - Sheet tab from being renamed or deleted
 * But allows:
 * - Editing data rows (row 2 onwards)
 *
 * @param {string} spreadsheetId - The ID of the spreadsheet
 * @param {string} sheetName - The name of the sheet
 * @param {object} options - Options
 * @param {number} options.headerRows - Number of header rows to protect (default: 1)
 * @param {string} options.description - Description for the protection
 * @returns {Promise<object>} - The response from the API
 */
async function protectSheetWithDataAccess(spreadsheetId, sheetName, options = {}) {
  const { headerRows = 1, description = null } = options;

  return withRetry(async () => {
    const sheets = createSheets({ version: "v4", auth: getAuth() });

    // Get sheet info
    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
    const sheet = spreadsheet.data.sheets.find((s) => s.properties.title === sheetName);

    if (!sheet) {
      throw new Error(`Sheet "${sheetName}" not found.`);
    }

    const sheetId = sheet.properties.sheetId;
    const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;

    // Protect entire sheet, but exclude data rows (row 2 onwards) from protection
    const protectedRange = {
      range: {
        sheetId: sheetId,
        // Entire sheet - no startRowIndex/endRowIndex means whole sheet
      },
      description: description || `${sheetName} - Sheet protection (header locked, data editable)`,
      warningOnly: false,
      // Only service account can edit protected areas (header row + sheet name)
      editors: {
        users: serviceAccountEmail ? [serviceAccountEmail] : [],
      },
      // Allow everyone to edit data rows (row 2 onwards)
      unprotectedRanges: [
        {
          sheetId: sheetId,
          startRowIndex: headerRows, // Start from row 2 (0-based index 1)
          // No endRowIndex means to the end of the sheet
        },
      ],
    };

    console.log(`[SHEET PROTECT] Protecting sheet "${sheetName}" with data access...`);
    console.log(`[SHEET PROTECT] - Header rows protected: ${headerRows}`);
    console.log(`[SHEET PROTECT] - Data rows (${headerRows + 1}+): editable by all`);
    console.log(`[SHEET PROTECT] - Sheet tab: protected from rename/delete`);
    console.log(`[SHEET PROTECT] - Editors for protected areas: ${serviceAccountEmail || "none"}`);

    const response = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      resource: {
        requests: [
          {
            addProtectedRange: {
              protectedRange: protectedRange,
            },
          },
        ],
      },
    });

    console.log(`✅ [SHEET PROTECT] Sheet "${sheetName}" protected successfully.`);
    return response.data;
  }, `protectSheetWithDataAccess(${sheetName})`);
}

/**
 * Check if sheet has full sheet protection (not just range protection)
 * @param {string} spreadsheetId - The ID of the spreadsheet
 * @param {string} sheetName - The name of the sheet
 * @returns {Promise<boolean>} - True if sheet has full protection
 */
async function hasSheetProtection(spreadsheetId, sheetName) {
  const props = await getSheetProperties(spreadsheetId, sheetName);

  // Check if any protected range covers the entire sheet (no specific row range)
  const hasFullSheetProtection = props.protectedRanges.some((pr) => {
    // Full sheet protection has no startRowIndex and endRowIndex
    return pr.range.startRowIndex === undefined && pr.range.endRowIndex === undefined;
  });

  return hasFullSheetProtection;
}

/**
 * Insert blank rows at a specific position in a sheet
 * @param {string} spreadsheetId - The ID of the spreadsheet
 * @param {string} sheetName - The name of the sheet
 * @param {number} rowIndex - 0-based row index where rows will be inserted
 * @param {number} numRows - Number of blank rows to insert (default: 1)
 * @returns {Promise<object>} - The response from the API
 */
async function insertRowsAt(spreadsheetId, sheetName, rowIndex, numRows = 1) {
  return withRetry(async () => {
    const sheets = createSheets({ version: "v4", auth: getAuth() });

    // Get the sheetId based on the sheetName
    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
    const sheet = spreadsheet.data.sheets.find((s) => s.properties.title === sheetName);

    if (!sheet) {
      throw new Error(`Sheet "${sheetName}" not found.`);
    }

    const sheetId = sheet.properties.sheetId;

    const response = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      resource: {
        requests: [
          {
            insertDimension: {
              range: {
                sheetId: sheetId,
                dimension: "ROWS",
                startIndex: rowIndex,
                endIndex: rowIndex + numRows,
              },
              inheritFromBefore: true,
            },
          },
        ],
      },
    });

    console.log(`Inserted ${numRows} row(s) at index ${rowIndex} in sheet "${sheetName}".`);
    return response.data;
  }, `insertRowsAt(${sheetName}, row ${rowIndex}, count ${numRows})`);
}

/**
 * Copy ONLY the formatting (borders, fonts, colors, number formats) from one
 * row to another. Cell values are not touched. Useful when appending fresh
 * data rows beyond a styled template area and you want them to match the
 * existing rows' visual style.
 *
 * @param {string} spreadsheetId
 * @param {string} sheetName
 * @param {number} srcRow   1-based source row
 * @param {number} destRow  1-based destination row
 * @param {number} [startCol=0]
 * @param {number} [endCol=30]  exclusive
 */
async function cloneRowFormat(spreadsheetId, sheetName, srcRow, destRow, startCol = 0, endCol = 30) {
  return withRetry(async () => {
    const sheets = createSheets({ version: "v4", auth: getAuth() });
    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
    const sheet = spreadsheet.data.sheets.find((s) => s.properties.title === sheetName);
    if (!sheet) throw new Error(`Sheet "${sheetName}" not found.`);
    const sheetId = sheet.properties.sheetId;

    const response = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      resource: {
        requests: [
          {
            copyPaste: {
              source: {
                sheetId,
                startRowIndex: srcRow - 1,
                endRowIndex: srcRow,
                startColumnIndex: startCol,
                endColumnIndex: endCol,
              },
              destination: {
                sheetId,
                startRowIndex: destRow - 1,
                endRowIndex: destRow,
                startColumnIndex: startCol,
                endColumnIndex: endCol,
              },
              pasteType: "PASTE_FORMAT",
              pasteOrientation: "NORMAL",
            },
          },
        ],
      },
    });
    return response.data;
  }, `cloneRowFormat(${sheetName}, ${srcRow}→${destRow})`);
}

/**
 * Apply a DATE or DATE_TIME numberFormat to a column-range on a tab. Use this
 * once per (spreadsheet, sheet, column) so subsequent writes of Excel serials
 * render as human-readable. The `repeatCell` request sets format on every cell
 * in the range; existing values remain (only format changes).
 *
 * @param {string} spreadsheetId
 * @param {string} sheetName
 * @param {Array<{col:number, startRow:number, endRow:number}>} ranges  cols 0-based, rows 1-based, endRow inclusive
 * @param {string} [pattern="d-mmm-yy"]
 * @param {"DATE"|"DATE_TIME"} [type="DATE"]  number-format type; use "DATE_TIME" when the pattern includes time
 */
async function applyDateColumnFormat(spreadsheetId, sheetName, ranges, pattern = "d-mmm-yy", type = "DATE") {
  if (!ranges || ranges.length === 0) return;
  return withRetry(async () => {
    const sheets = createSheets({ version: "v4", auth: getAuth() });
    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
    const sheet = spreadsheet.data.sheets.find((s) => s.properties.title === sheetName);
    if (!sheet) throw new Error(`Sheet "${sheetName}" not found.`);
    const sheetId = sheet.properties.sheetId;

    const requests = ranges.map((r) => ({
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: r.startRow - 1,
          endRowIndex: r.endRow, // exclusive
          startColumnIndex: r.col,
          endColumnIndex: r.col + 1,
        },
        cell: { userEnteredFormat: { numberFormat: { type, pattern } } },
        fields: "userEnteredFormat.numberFormat",
      },
    }));

    const response = await sheets.spreadsheets.batchUpdate({ spreadsheetId, resource: { requests } });
    console.log(`Applied ${type} format (${pattern}) to ${ranges.length} range(s) on "${sheetName}"`);
    return response.data;
  }, `applyDateColumnFormat(${sheetName}, ${ranges.length} ranges)`);
}

// Cache: `${spreadsheetId}::${sheetName}` → numeric sheetId.
// Avoids one spreadsheets.get() per setRowBackgroundColor call — that quickly
// blows the Sheets API "Read requests per minute" quota during a backfill.
const _sheetIdCache = new Map();

async function resolveSheetId(spreadsheetId, sheetName) {
  const key = `${spreadsheetId}::${sheetName}`;
  if (_sheetIdCache.has(key)) return _sheetIdCache.get(key);
  const sheets = createSheets({ version: "v4", auth: getAuth() });
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets(properties(sheetId,title))" });
  for (const sh of spreadsheet.data.sheets || []) {
    const k = `${spreadsheetId}::${sh.properties.title}`;
    _sheetIdCache.set(k, sh.properties.sheetId);
  }
  if (!_sheetIdCache.has(key)) throw new Error(`Sheet "${sheetName}" not found.`);
  return _sheetIdCache.get(key);
}

// Cache: `${spreadsheetId}::${sheetName}` → first-row header array.
// Used only by batchUpdateCells's timestamp-column heuristic. Tab headers
// don't change mid-run, so the cache is safe for the lifetime of the process.
const _headerRowCache = new Map();

async function _resolveSheetHeaders(spreadsheetId, sheetName) {
  const key = `${spreadsheetId}::${sheetName}`;
  if (_headerRowCache.has(key)) return _headerRowCache.get(key);
  const sheetData = await readGoogleSheet(spreadsheetId, sheetName);
  const headers = sheetData && sheetData.length > 0 ? sheetData[0] : [];
  _headerRowCache.set(key, headers);
  return headers;
}

// Test seam: clear all gsheet caches. Call between independent test runs.
function _clearGsheetCaches() {
  _sheetIdCache.clear();
  _headerRowCache.clear();
}

/**
 * Set the background color of a range of cells (single row, multi-cell).
 *
 * For bulk operations prefer setRowBackgroundColorBatch — calling this per
 * row in a tight loop will hit Sheets API write quotas.
 */
async function setRowBackgroundColor(spreadsheetId, sheetName, rowNumber, startCol, endCol, color) {
  return setRowBackgroundColorBatch(spreadsheetId, sheetName, [{ rowNumber, startCol, endCol, color }]);
}

/**
 * Apply many row-background changes in a single Sheets API batchUpdate.
 *
 * @param {string} spreadsheetId
 * @param {string} sheetName
 * @param {Array<{rowNumber:number, startCol:number, endCol:number, color:object|null}>} entries
 */
async function setRowBackgroundColorBatch(spreadsheetId, sheetName, entries) {
  if (!entries || entries.length === 0) return;
  const valid = entries.filter((e) => e.rowNumber >= 1 && e.endCol > e.startCol);
  if (valid.length === 0) return;
  const sheetId = await resolveSheetId(spreadsheetId, sheetName);
  return withRetry(async () => {
    const sheets = createSheets({ version: "v4", auth: getAuth() });
    const requests = valid.map((e) => ({
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: e.rowNumber - 1,
          endRowIndex: e.rowNumber,
          startColumnIndex: e.startCol,
          endColumnIndex: e.endCol,
        },
        cell: e.color
          ? { userEnteredFormat: { backgroundColor: e.color } }
          : { userEnteredFormat: { backgroundColor: { red: 1, green: 1, blue: 1 } } },
        fields: "userEnteredFormat.backgroundColor",
      },
    }));
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, resource: { requests } });
  }, `setRowBackgroundColorBatch(${sheetName}, ${valid.length} rows)`);
}

/**
 * Insert one or more columns at a 0-based column index. All columns at and
 * after `colIndex` shift right. Formula references auto-adjust per Sheets API
 * semantics.
 *
 * @param {string} spreadsheetId
 * @param {string} sheetName
 * @param {number} colIndex   0-based — new columns appear starting here
 * @param {number} [numCols=1]
 */
async function insertColumnsAt(spreadsheetId, sheetName, colIndex, numCols = 1) {
  return withRetry(async () => {
    const sheets = createSheets({ version: "v4", auth: getAuth() });
    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
    const sheet = spreadsheet.data.sheets.find((s) => s.properties.title === sheetName);
    if (!sheet) throw new Error(`Sheet "${sheetName}" not found.`);

    const response = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      resource: {
        requests: [
          {
            insertDimension: {
              range: {
                sheetId: sheet.properties.sheetId,
                dimension: "COLUMNS",
                startIndex: colIndex,
                endIndex: colIndex + numCols,
              },
              inheritFromBefore: true,
            },
          },
        ],
      },
    });
    console.log(`Inserted ${numCols} column(s) at index ${colIndex} in sheet "${sheetName}".`);
    return response.data;
  }, `insertColumnsAt(${sheetName}, col ${colIndex}, count ${numCols})`);
}

/**
 * Delete a row from a Google Sheet by row number (1-based)
 * @param {string} spreadsheetId - The ID of the spreadsheet
 * @param {string} sheetName - The name of the sheet
 * @param {number} rowIndex - The 1-based row number to delete
 * @returns {Promise<object>} - The response from the API
 */
async function deleteRow(spreadsheetId, sheetName, rowIndex) {
  return withRetry(async () => {
    const sheets = createSheets({ version: "v4", auth: getAuth() });

    // Get the sheetId based on the sheetName
    const spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId,
    });

    const sheet = spreadsheet.data.sheets.find((s) => s.properties.title === sheetName);
    if (!sheet) {
      throw new Error(`Sheet with name "${sheetName}" not found.`);
    }

    const sheetId = sheet.properties.sheetId;

    // Delete the row using batchUpdate with deleteDimension request
    // startIndex is 0-based, endIndex is exclusive
    const response = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      resource: {
        requests: [
          {
            deleteDimension: {
              range: {
                sheetId: sheetId,
                dimension: "ROWS",
                startIndex: rowIndex - 1, // Convert 1-based to 0-based
                endIndex: rowIndex, // Exclusive end index
              },
            },
          },
        ],
      },
    });

    console.log(`Row ${rowIndex} deleted successfully from "${sheetName}".`);
    return response.data;
  }, `deleteRow(${sheetName}, row ${rowIndex})`);
}

/**
 * Delete multiple rows from a Google Sheet in a single batch API call.
 * Rows are automatically sorted descending (high→low) to avoid index shifting.
 * @param {string} spreadsheetId - The ID of the spreadsheet
 * @param {string} sheetName - The name of the sheet
 * @param {number[]} rowIndices - Array of 1-based row numbers to delete
 * @returns {Promise<object>} - The response from the API
 */
/**
 * Delete a sheet (tab) entirely from a spreadsheet by its name.
 *
 * @param {string} spreadsheetId
 * @param {string} sheetName
 * @returns {Promise<boolean>} true if deleted, false if the tab didn't exist
 */
async function deleteSheet(spreadsheetId, sheetName) {
  return withRetry(async () => {
    const sheets = createSheets({ version: "v4", auth: getAuth() });
    const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets(properties(sheetId,title))" });
    const sheet = (meta.data.sheets || []).find((s) => s.properties.title === sheetName);
    if (!sheet) return false;
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      resource: { requests: [{ deleteSheet: { sheetId: sheet.properties.sheetId } }] },
    });
    _sheetIdCache.delete(`${spreadsheetId}::${sheetName}`);
    return true;
  }, `deleteSheet(${sheetName})`);
}

/**
 * Count pages in a PDF buffer by counting `/Type /Page` object dictionaries.
 * Reliable for Google Sheets-generated PDFs (which always have one /Page obj
 * per rendered page). Fast — buffer scan, no PDF library dependency.
 *
 * @param {Buffer} pdfBuffer
 * @returns {number} page count (>=1)
 */
function extractPdfPageCount(pdfBuffer) {
  // PDF page objects look like: "/Type /Page" (with optional whitespace).
  // The "/Type /Pages" catalog entry (plural) is excluded by the [^s] terminator.
  // Counting Page objects is exact and matches the page count reported in any PDF viewer.
  const ascii = pdfBuffer.toString("latin1");
  const matches = ascii.match(/\/Type\s*\/Page[^s]/g);
  return matches ? matches.length : 1;
}

async function deleteRows(spreadsheetId, sheetName, rowIndices) {
  if (!rowIndices || rowIndices.length === 0) return null;

  return withRetry(async () => {
    const sheets = createSheets({ version: "v4", auth: getAuth() });

    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
    const sheet = spreadsheet.data.sheets.find((s) => s.properties.title === sheetName);
    if (!sheet) {
      throw new Error(`Sheet with name "${sheetName}" not found.`);
    }

    const sheetId = sheet.properties.sheetId;

    // Sort descending — MUST delete from bottom to top to avoid index shifting
    const sorted = [...rowIndices].sort((a, b) => b - a);

    const requests = sorted.map((rowIndex) => ({
      deleteDimension: {
        range: {
          sheetId,
          dimension: "ROWS",
          startIndex: rowIndex - 1, // Convert 1-based to 0-based
          endIndex: rowIndex, // Exclusive end index
        },
      },
    }));

    const response = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      resource: { requests },
    });

    console.log(`Batch deleted ${sorted.length} rows from "${sheetName}".`);
    return response.data;
  }, `deleteRows(${sheetName}, ${rowIndices.length} rows)`);
}

/**
 * Collapse a list of 1-based row numbers into contiguous 0-based
 * [startIndex, endIndex) ranges for a Sheets dimension range. Pure — no IO.
 * Sorts + de-dupes. e.g. [2,4,9,10,11,42] ->
 *   [{startIndex:1,endIndex:2},{startIndex:3,endIndex:4},{startIndex:8,endIndex:11},{startIndex:41,endIndex:42}]
 */
function collapseRowsToRanges(rowIndices) {
  if (!rowIndices || rowIndices.length === 0) return [];
  const sorted = [...new Set(rowIndices)].sort((a, b) => a - b);
  const ranges = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const r = sorted[i];
    if (r === prev + 1) {
      prev = r;
      continue;
    }
    ranges.push({ startIndex: start - 1, endIndex: prev }); // 1-based -> 0-based, end exclusive
    start = r;
    prev = r;
  }
  ranges.push({ startIndex: start - 1, endIndex: prev });
  return ranges;
}

/**
 * Hide (or unhide) rows by 1-based row number in ONE batchUpdate.
 * Collapses contiguous rows into ranges. Hiding does NOT shift indices, so no
 * descending sort is required (unlike deleteRows).
 *
 * @param {string} spreadsheetId
 * @param {string} sheetName
 * @param {number[]} rowIndices - 1-based row numbers to hide/unhide
 * @param {boolean} [hidden=true]
 */
async function setRowsHidden(spreadsheetId, sheetName, rowIndices, hidden = true) {
  if (!rowIndices || rowIndices.length === 0) return null;
  return withRetry(async () => {
    const sheets = createSheets({ version: "v4", auth: getAuth() });
    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
    const sheet = spreadsheet.data.sheets.find((s) => s.properties.title === sheetName);
    if (!sheet) {
      throw new Error(`Sheet with name "${sheetName}" not found.`);
    }
    const sheetId = sheet.properties.sheetId;
    const ranges = collapseRowsToRanges(rowIndices);
    const requests = ranges.map((rg) => ({
      updateDimensionProperties: {
        range: { sheetId, dimension: "ROWS", startIndex: rg.startIndex, endIndex: rg.endIndex },
        properties: { hiddenByUser: hidden },
        fields: "hiddenByUser",
      },
    }));
    const response = await sheets.spreadsheets.batchUpdate({ spreadsheetId, resource: { requests } });
    console.log(`${hidden ? "Hid" : "Unhid"} ${rowIndices.length} rows (${ranges.length} range(s)) in "${sheetName}".`);
    return response.data;
  }, `setRowsHidden(${sheetName}, ${rowIndices.length} rows)`);
}

/**
 * Export a sheet tab as a PDF buffer.
 * Uses Google's spreadsheet export URL with the service account token.
 *
 * @param {string} spreadsheetId - The spreadsheet ID
 * @param {string} sheetName - The sheet tab name (used to look up numeric gid)
 * @param {object} [options] - Export options
 * @param {number} [options.lastRow] - Last row to include (1-based). Omit to export all rows.
 * @param {number} [options.lastCol] - Last column to include (0-based, default 17 = column R).
 * @param {number} [options.scale] - 1 = normal (100%), 2 = fit width (multi-page tall),
 *                                    3 = fit height, 4 = fit to one page (default).
 *                                    Use 2 when you want the PDF to paginate vertically
 *                                    so each row stays readable instead of being crushed.
 * @param {"A3"|"A4"|"letter"} [options.size] - Paper size (default "A3").
 * @returns {Promise<Buffer>} PDF buffer
 */
async function exportSheetAsPdf(spreadsheetId, sheetName, options = {}) {
  const axios = require("axios");
  const sheetsApi = createSheets({ version: "v4", auth: getAuth() });

  // Get the numeric sheet ID (gid) from the sheet name
  const resp = await sheetsApi.spreadsheets.get({ spreadsheetId });
  const sheet = resp.data.sheets.find((s) => s.properties.title === sheetName);
  if (!sheet) throw new Error(`Sheet "${sheetName}" not found in spreadsheet`);
  const gid = sheet.properties.sheetId;

  // Get access token from the service account
  const tokenResponse = await getAuth().getAccessToken();
  const accessToken = tokenResponse.token || tokenResponse;

  // PDF export parameters:
  // size — A3 (default) larger paper to fit the wide 3-column layout
  // scale — see option doc above; default 4 = fit-to-page (existing callers depend on this)
  // top/bottom/left/right_margin — minimal margins (in inches)
  // r1/c1/r2/c2 — export range (0-indexed), clips to actual data area
  // orientation — "portrait" (default) or "landscape". Use landscape when
  //   content has long row text overflowing many columns (e.g. RFI subjects).
  const { lastRow, lastCol = 17, orientation = "portrait", scale = 4, size = "A3" } = options;
  // Page margins in inches (all four sides). Default 0.1 keeps existing callers
  // unchanged; the safety COMPACT screenshot passes 0 so the table fills the
  // page edge-to-edge (less surrounding white → bigger/clearer on a phone).
  const margin = options.margin == null ? 0.1 : options.margin;
  let rangeParams = "";
  if (lastRow) {
    rangeParams = `&r1=0&c1=0&r2=${lastRow}&c2=${lastCol}`;
  }
  const portraitParam = orientation === "landscape" ? "false" : "true";
  const url =
    `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export` +
    `?format=pdf&gid=${gid}` +
    `&size=${size}&portrait=${portraitParam}&scale=${scale}` +
    `&top_margin=${margin}&bottom_margin=${margin}&left_margin=${margin}&right_margin=${margin}` +
    `&gridlines=false&printtitle=false&sheetnames=false&pagenumbers=false&fzr=false` +
    `&horizontal_alignment=LEFT&vertical_alignment=TOP` +
    rangeParams;

  const response = await axios.get(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    responseType: "arraybuffer",
    maxRedirects: 5,
    timeout: 120000,
  });

  return Buffer.from(response.data);
}

/**
 * Apply borders to a range of cells.
 *
 * @param {string} spreadsheetId
 * @param {string} sheetName
 * @param {{startRow: number, endRow: number, startCol: number, endCol: number}} range - 0-based, end is exclusive
 * @param {object} [borderStyle] - Default: solid black 1px on all sides + inner H/V
 */
async function applyBorders(spreadsheetId, sheetName, range, borderStyle = null) {
  const sheets = createSheets({ version: "v4", auth: getAuth() });
  const props = await sheets.spreadsheets.get({ spreadsheetId });
  const sheet = props.data.sheets.find((s) => s.properties.title === sheetName);
  if (!sheet) throw new Error(`Sheet "${sheetName}" not found`);
  const sheetId = sheet.properties.sheetId;

  const border = borderStyle || { style: "SOLID", width: 1, color: { red: 0, green: 0, blue: 0 } };

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    resource: {
      requests: [
        {
          updateBorders: {
            range: {
              sheetId,
              startRowIndex: range.startRow,
              endRowIndex: range.endRow,
              startColumnIndex: range.startCol,
              endColumnIndex: range.endCol,
            },
            top: border,
            bottom: border,
            left: border,
            right: border,
            innerHorizontal: border,
            innerVertical: border,
          },
        },
      ],
    },
  });
}

/**
 * Merge a range of cells.
 *
 * @param {string} spreadsheetId
 * @param {string} sheetName
 * @param {{startRow: number, endRow: number, startCol: number, endCol: number}} range - 0-based, end is exclusive
 * @param {"MERGE_ALL"|"MERGE_COLUMNS"|"MERGE_ROWS"} [mergeType="MERGE_ALL"]
 */
async function mergeCells(spreadsheetId, sheetName, range, mergeType = "MERGE_ALL") {
  const sheets = createSheets({ version: "v4", auth: getAuth() });
  const props = await sheets.spreadsheets.get({ spreadsheetId });
  const sheet = props.data.sheets.find((s) => s.properties.title === sheetName);
  if (!sheet) throw new Error(`Sheet "${sheetName}" not found`);
  const sheetId = sheet.properties.sheetId;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    resource: {
      requests: [
        {
          mergeCells: {
            range: {
              sheetId,
              startRowIndex: range.startRow,
              endRowIndex: range.endRow,
              startColumnIndex: range.startCol,
              endColumnIndex: range.endCol,
            },
            mergeType,
          },
        },
      ],
    },
  });
}

/**
 * Batch apply borders + merges in a single API call.
 * Pass arrays of border ranges and merge ranges.
 *
 * @param {string} spreadsheetId
 * @param {string} sheetName
 * @param {object} ops - { borders: [range, ...], merges: [range, ...], cellFormats: [{range, format}, ...] }
 */
async function batchFormatSheet(spreadsheetId, sheetName, ops = {}) {
  const sheets = createSheets({ version: "v4", auth: getAuth() });
  const props = await sheets.spreadsheets.get({ spreadsheetId });
  const sheet = props.data.sheets.find((s) => s.properties.title === sheetName);
  if (!sheet) throw new Error(`Sheet "${sheetName}" not found`);
  const sheetId = sheet.properties.sheetId;

  const requests = [];
  const border = { style: "SOLID", width: 1, color: { red: 0, green: 0, blue: 0 } };

  for (const r of ops.borders || []) {
    requests.push({
      updateBorders: {
        range: {
          sheetId,
          startRowIndex: r.startRow,
          endRowIndex: r.endRow,
          startColumnIndex: r.startCol,
          endColumnIndex: r.endCol,
        },
        top: border,
        bottom: border,
        left: border,
        right: border,
        innerHorizontal: border,
        innerVertical: border,
      },
    });
  }
  for (const r of ops.merges || []) {
    requests.push({
      mergeCells: {
        range: {
          sheetId,
          startRowIndex: r.startRow,
          endRowIndex: r.endRow,
          startColumnIndex: r.startCol,
          endColumnIndex: r.endCol,
        },
        mergeType: "MERGE_ALL",
      },
    });
  }
  for (const item of ops.cellFormats || []) {
    requests.push({
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: item.range.startRow,
          endRowIndex: item.range.endRow,
          startColumnIndex: item.range.startCol,
          endColumnIndex: item.range.endCol,
        },
        cell: { userEnteredFormat: item.format },
        fields: item.fields || "userEnteredFormat",
      },
    });
  }
  if (ops.autoResizeColumns) {
    for (const colIdx of ops.autoResizeColumns) {
      requests.push({
        autoResizeDimensions: {
          dimensions: { sheetId, dimension: "COLUMNS", startIndex: colIdx, endIndex: colIdx + 1 },
        },
      });
    }
  }
  if (ops.columnWidths) {
    // ops.columnWidths = [{ colIdx: 1, pixelSize: 60 }, ...]
    for (const cw of ops.columnWidths) {
      requests.push({
        updateDimensionProperties: {
          range: { sheetId, dimension: "COLUMNS", startIndex: cw.colIdx, endIndex: cw.colIdx + 1 },
          properties: { pixelSize: cw.pixelSize },
          fields: "pixelSize",
        },
      });
    }
  }
  if (ops.rowHeights) {
    // ops.rowHeights = [{ rowIdx: 0, endRowIdx: 5, pixelSize: 30 }]
    for (const rh of ops.rowHeights) {
      requests.push({
        updateDimensionProperties: {
          range: { sheetId, dimension: "ROWS", startIndex: rh.rowIdx, endIndex: rh.endRowIdx },
          properties: { pixelSize: rh.pixelSize },
          fields: "pixelSize",
        },
      });
    }
  }

  if (requests.length === 0) return;
  await sheets.spreadsheets.batchUpdate({ spreadsheetId, resource: { requests } });
}

/**
 * Export a sheet tab as XLSX (Excel) file buffer.
 * Uses Google Sheets export URL with format=xlsx.
 *
 * @param {string} spreadsheetId
 * @param {string} sheetName - sheet tab name (used to look up gid)
 * @returns {Promise<Buffer>} XLSX file buffer
 */
async function exportSheetAsXlsx(spreadsheetId, sheetName) {
  const axios = require("axios");
  const sheetsApi = createSheets({ version: "v4", auth: getAuth() });

  const resp = await sheetsApi.spreadsheets.get({ spreadsheetId });
  const sheet = resp.data.sheets.find((s) => s.properties.title === sheetName);
  if (!sheet) throw new Error(`Sheet "${sheetName}" not found in spreadsheet`);
  const gid = sheet.properties.sheetId;

  const tokenResponse = await getAuth().getAccessToken();
  const accessToken = tokenResponse.token || tokenResponse;

  // Note: Google's export?format=xlsx exports the ENTIRE workbook by default.
  // To export only a single sheet, we use the gid parameter.
  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=xlsx&gid=${gid}`;

  const response = await axios.get(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    responseType: "arraybuffer",
    maxRedirects: 5,
    timeout: 120000,
  });

  return Buffer.from(response.data);
}

module.exports = {
  readGoogleSheet,
  readGoogleSheetRaw,
  batchGetGoogleSheets,
  writeArrayToGSheet,
  writeArrayToGSheetRow,
  updateExistingRow,
  duplicateSheet,
  updateCell,
  batchUpdateCells,
  batchUpdateRanges,
  writeStringCells,
  writeTimeCells,
  createNewSheet,
  renameSheet,
  clearDataKeepHeaders,
  clearSheet,
  addConditionalFormatRule,
  moveSheetToEnd,
  freezeRows,
  protectRange,
  setupHeaderRow,
  getSheetProperties,
  ensureColumnCount,
  ensureHeaderRowSetup,
  protectSheetWithDataAccess,
  hasSheetProtection,
  getSheetNames,
  sheetExists,
  insertRowsAt,
  insertColumnsAt,
  applyDateColumnFormat,
  setRowBackgroundColor,
  setRowBackgroundColorBatch,
  cloneRowFormat,
  columnIndexToLetter,
  deleteRow,
  deleteRows,
  collapseRowsToRanges,
  setRowsHidden,
  deleteSheet,
  extractPdfPageCount,
  exportSheetAsPdf,
  exportSheetAsXlsx,
  applyBorders,
  mergeCells,
  batchFormatSheet,
  getAuth, // Export getAuth for lazy initialization (AWS Secrets Manager compatibility)
  // Export mock for testing
  mockWriteArrayToGSheetRow,
};
