// Note: dotenv is loaded in index.js handler, secrets come from AWS Secrets Manager
const { sheets: createSheets } = require("@googleapis/sheets");
const { readNoiseData } = require("../../utils/common");
const { readGoogleSheet, getAuth } = require("../../utils/gsheet");
const { findOrCreateSheet } = require("./sheets-integration");
const { updateAnalysisSheets } = require("./sheets-analysis");

// Column mapping for noise monitoring points (NM) to Google Sheet columns
const COLUMN_MAPPINGS = {
  NM1: "B", // Column B
  NM2: "H", // Column H
};

// Column indices (0-based) for programmatic access
const COLUMN_INDICES = {
  NM1: 1, // Column B (index 1)
  NM2: 7, // Column H (index 7)
};

// Mapping for the location field in Supabase to short codes
const LOCATION_MAPPINGS = {
  // Map the full location names to short codes based on actual ir2_noise_data_daily data
  "NM1: Marina Bay Sands Tower 1, Level 6 balcony": "NM1",
  "NM2: Marina Bay Residences, Level 27": "NM2",
  // Keep partial matches for flexibility
  NM1: "NM1",
  NM2: "NM2",
};

/**
 * Update a specific cell in a Google Sheet directly
 *
 * @param {string} spreadsheetId - Google Sheet ID
 * @param {string} sheetName - Name of the sheet (e.g. "28/07/25")
 * @param {string} cellRef - Cell reference (e.g. "H4")
 * @param {*} value - Value to write
 * @returns {Promise<object>} - Result of the operation
 */
async function updateDirectCell(spreadsheetId, sheetName, cellRef, value) {
  try {
    console.log(`Updating cell ${sheetName}!${cellRef} with value: ${value}`);

    // Initialize the Google Sheets API
    const sheets = createSheets({ version: "v4", auth: getAuth() });

    // Build the range string
    const range = `${sheetName}!${cellRef}`;

    // First read the current value to verify we can access the cell
    console.log(`Reading current value of ${range}`);
    try {
      const readResult = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range,
      });

      const currentValue = readResult.data.values?.[0]?.[0] || "empty";
      console.log(`Current value: ${currentValue}`);
    } catch (readError) {
      console.warn(`Could not read current value: ${readError.message}`);
    }

    // Update the cell with the new value
    const updateResult = await sheets.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: "USER_ENTERED",
      resource: {
        values: [[value]],
      },
    });

    console.log(`Cell updated successfully: ${range} = ${value}`);
    console.log(`Updated ${updateResult.data.updatedCells} cell(s)`);

    return {
      success: true,
      message: `Cell ${range} updated successfully`,
      cell: cellRef,
      value: value,
    };
  } catch (error) {
    console.error(`Error updating cell ${sheetName}!${cellRef}:`, error.message);
    if (error.errors) {
      console.error("Detailed errors:", JSON.stringify(error.errors, null, 2));
    }

    return {
      success: false,
      message: `Error updating cell: ${error.message}`,
      cell: cellRef,
      value: value,
    };
  }
}

/**
 * Map a time to a specific cell reference for noise readings
 * This uses a hardcoded mapping from time to cell references
 *
 * @param {string|Date} time - Time as string "HH:MM" or Date object
 * @returns {string|null} - Cell reference (e.g., "H4" for 7:00 PM) or null if not found
 */
function mapTimeToCellReference(time) {
  // Convert Date object to hour:minute string
  let timeStr = time;
  if (time instanceof Date) {
    const hours = time.getHours();
    const minutes = time.getMinutes();
    timeStr = `${hours}:${minutes.toString().padStart(2, "0")}`;
  }

  // Normalize the time string (remove any AM/PM and ensure consistent format)
  const normalizedTime = timeStr.toLowerCase().replace(/\s+/g, "");

  // Direct mapping of times to cell references for column H
  const timeMap = {
    // 7:00 AM - 7:55 AM (H4 to H15)
    "07:00": "H4",
    "7:00am": "H4",
    "7:00": "H4",
    "07:05": "H5",
    "7:05am": "H5",
    "7:05": "H5",
    "07:10": "H6",
    "7:10am": "H6",
    "7:10": "H6",
    "07:15": "H7",
    "7:15am": "H7",
    "7:15": "H7",
    "07:20": "H8",
    "7:20am": "H8",
    "7:20": "H8",
    "07:25": "H9",
    "7:25am": "H9",
    "7:25": "H9",
    "07:30": "H10",
    "7:30am": "H10",
    "7:30": "H10",
    "07:35": "H11",
    "7:35am": "H11",
    "7:35": "H11",
    "07:40": "H12",
    "7:40am": "H12",
    "7:40": "H12",
    "07:45": "H13",
    "7:45am": "H13",
    "7:45": "H13",
    "07:50": "H14",
    "7:50am": "H14",
    "7:50": "H14",
    "07:55": "H15",
    "7:55am": "H15",
    "7:55": "H15",

    // 8:00 AM - 8:55 AM (H18 to H29)
    "08:00": "H18",
    "8:00am": "H18",
    "8:00": "H18",
    "08:05": "H19",
    "8:05am": "H19",
    "8:05": "H19",
    "08:10": "H20",
    "8:10am": "H20",
    "8:10": "H20",
    "08:15": "H21",
    "8:15am": "H21",
    "8:15": "H21",
    "08:20": "H22",
    "8:20am": "H22",
    "8:20": "H22",
    "08:25": "H23",
    "8:25am": "H23",
    "8:25": "H23",
    "08:30": "H24",
    "8:30am": "H24",
    "8:30": "H24",
    "08:35": "H25",
    "8:35am": "H25",
    "8:35": "H25",
    "08:40": "H26",
    "8:40am": "H26",
    "8:40": "H26",
    "08:45": "H27",
    "8:45am": "H27",
    "8:45": "H27",
    "08:50": "H28",
    "8:50am": "H28",
    "8:50": "H28",
    "08:55": "H29",
    "8:55am": "H29",
    "8:55": "H29",

    // 9:00 AM - 9:55 AM (H32 to H43)
    "09:00": "H32",
    "9:00am": "H32",
    "9:00": "H32",
    "09:05": "H33",
    "9:05am": "H33",
    "9:05": "H33",
    "09:10": "H34",
    "9:10am": "H34",
    "9:10": "H34",
    "09:15": "H35",
    "9:15am": "H35",
    "9:15": "H35",
    "09:20": "H36",
    "9:20am": "H36",
    "9:20": "H36",
    "09:25": "H37",
    "9:25am": "H37",
    "9:25": "H37",
    "09:30": "H38",
    "9:30am": "H38",
    "9:30": "H38",
    "09:35": "H39",
    "9:35am": "H39",
    "9:35": "H39",
    "09:40": "H40",
    "9:40am": "H40",
    "9:40": "H40",
    "09:45": "H41",
    "9:45am": "H41",
    "9:45": "H41",
    "09:50": "H42",
    "9:50am": "H42",
    "9:50": "H42",
    "09:55": "H43",
    "9:55am": "H43",
    "9:55": "H43",

    // 10:00 AM - 10:55 AM (H46 to H57)
    "10:00": "H46",
    "10:00am": "H46",
    "10:05": "H47",
    "10:05am": "H47",
    "10:10": "H48",
    "10:10am": "H48",
    "10:15": "H49",
    "10:15am": "H49",
    "10:20": "H50",
    "10:20am": "H50",
    "10:25": "H51",
    "10:25am": "H51",
    "10:30": "H52",
    "10:30am": "H52",
    "10:35": "H53",
    "10:35am": "H53",
    "10:40": "H54",
    "10:40am": "H54",
    "10:45": "H55",
    "10:45am": "H55",
    "10:50": "H56",
    "10:50am": "H56",
    "10:55": "H57",
    "10:55am": "H57",

    // 11:00 AM - 11:55 AM (H60 to H71)
    "11:00": "H60",
    "11:00am": "H60",
    "11:05": "H61",
    "11:05am": "H61",
    "11:10": "H62",
    "11:10am": "H62",
    "11:15": "H63",
    "11:15am": "H63",
    "11:20": "H64",
    "11:20am": "H64",
    "11:25": "H65",
    "11:25am": "H65",
    "11:30": "H66",
    "11:30am": "H66",
    "11:35": "H67",
    "11:35am": "H67",
    "11:40": "H68",
    "11:40am": "H68",
    "11:45": "H69",
    "11:45am": "H69",
    "11:50": "H70",
    "11:50am": "H70",
    "11:55": "H71",
    "11:55am": "H71",

    // 12:00 PM - 12:55 PM (H74 to H85)
    "12:00": "H74",
    "12:00pm": "H74",
    "12:05": "H75",
    "12:05pm": "H75",
    "12:10": "H76",
    "12:10pm": "H76",
    "12:15": "H77",
    "12:15pm": "H77",
    "12:20": "H78",
    "12:20pm": "H78",
    "12:25": "H79",
    "12:25pm": "H79",
    "12:30": "H80",
    "12:30pm": "H80",
    "12:35": "H81",
    "12:35pm": "H81",
    "12:40": "H82",
    "12:40pm": "H82",
    "12:45": "H83",
    "12:45pm": "H83",
    "12:50": "H84",
    "12:50pm": "H84",
    "12:55": "H85",
    "12:55pm": "H85",

    // 1:00 PM - 1:55 PM (H88 to H99)
    "13:00": "H88",
    "1:00pm": "H88",
    "13:05": "H89",
    "1:05pm": "H89",
    "13:10": "H90",
    "1:10pm": "H90",
    "13:15": "H91",
    "1:15pm": "H91",
    "13:20": "H92",
    "1:20pm": "H92",
    "13:25": "H93",
    "1:25pm": "H93",
    "13:30": "H94",
    "1:30pm": "H94",
    "13:35": "H95",
    "1:35pm": "H95",
    "13:40": "H96",
    "1:40pm": "H96",
    "13:45": "H97",
    "1:45pm": "H97",
    "13:50": "H98",
    "1:50pm": "H98",
    "13:55": "H99",
    "1:55pm": "H99",

    // 2:00 PM - 2:55 PM (H102 to H113)
    "14:00": "H102",
    "2:00pm": "H102",
    "14:05": "H103",
    "2:05pm": "H103",
    "14:10": "H104",
    "2:10pm": "H104",
    "14:15": "H105",
    "2:15pm": "H105",
    "14:20": "H106",
    "2:20pm": "H106",
    "14:25": "H107",
    "2:25pm": "H107",
    "14:30": "H108",
    "2:30pm": "H108",
    "14:35": "H109",
    "2:35pm": "H109",
    "14:40": "H110",
    "2:40pm": "H110",
    "14:45": "H111",
    "2:45pm": "H111",
    "14:50": "H112",
    "2:50pm": "H112",
    "14:55": "H113",
    "2:55pm": "H113",

    // 3:00 PM - 3:55 PM (H116 to H127)
    "15:00": "H116",
    "3:00pm": "H116",
    "15:05": "H117",
    "3:05pm": "H117",
    "15:10": "H118",
    "3:10pm": "H118",
    "15:15": "H119",
    "3:15pm": "H119",
    "15:20": "H120",
    "3:20pm": "H120",
    "15:25": "H121",
    "3:25pm": "H121",
    "15:30": "H122",
    "3:30pm": "H122",
    "15:35": "H123",
    "3:35pm": "H123",
    "15:40": "H124",
    "3:40pm": "H124",
    "15:45": "H125",
    "3:45pm": "H125",
    "15:50": "H126",
    "3:50pm": "H126",
    "15:55": "H127",
    "3:55pm": "H127",

    // 4:00 PM - 4:55 PM (H130 to H141)
    "16:00": "H130",
    "4:00pm": "H130",
    "16:05": "H131",
    "4:05pm": "H131",
    "16:10": "H132",
    "4:10pm": "H132",
    "16:15": "H133",
    "4:15pm": "H133",
    "16:20": "H134",
    "4:20pm": "H134",
    "16:25": "H135",
    "4:25pm": "H135",
    "16:30": "H136",
    "4:30pm": "H136",
    "16:35": "H137",
    "4:35pm": "H137",
    "16:40": "H138",
    "4:40pm": "H138",
    "16:45": "H139",
    "4:45pm": "H139",
    "16:50": "H140",
    "4:50pm": "H140",
    "16:55": "H141",
    "4:55pm": "H141",

    // 5:00 PM - 5:55 PM (H144 to H155)
    "17:00": "H144",
    "5:00pm": "H144",
    "17:05": "H145",
    "5:05pm": "H145",
    "17:10": "H146",
    "5:10pm": "H146",
    "17:15": "H147",
    "5:15pm": "H147",
    "17:20": "H148",
    "5:20pm": "H148",
    "17:25": "H149",
    "5:25pm": "H149",
    "17:30": "H150",
    "5:30pm": "H150",
    "17:35": "H151",
    "5:35pm": "H151",
    "17:40": "H152",
    "5:40pm": "H152",
    "17:45": "H153",
    "5:45pm": "H153",
    "17:50": "H154",
    "5:50pm": "H154",
    "17:55": "H155",
    "5:55pm": "H155",

    // 6:00 PM - 6:55 PM (H158 to H169)
    "18:00": "H158",
    "6:00pm": "H158",
    "18:05": "H159",
    "6:05pm": "H159",
    "18:10": "H160",
    "6:10pm": "H160",
    "18:15": "H161",
    "6:15pm": "H161",
    "18:20": "H162",
    "6:20pm": "H162",
    "18:25": "H163",
    "6:25pm": "H163",
    "18:30": "H164",
    "6:30pm": "H164",
    "18:35": "H165",
    "6:35pm": "H165",
    "18:40": "H166",
    "6:40pm": "H166",
    "18:45": "H167",
    "6:45pm": "H167",
    "18:50": "H168",
    "6:50pm": "H168",
    "18:55": "H169",
    "6:55pm": "H169",

    // 7:00 PM - 7:55 PM (H172 to H183)
    "19:00": "H172",
    "7:00pm": "H172",
    "19:05": "H173",
    "7:05pm": "H173",
    "19:10": "H174",
    "7:10pm": "H174",
    "19:15": "H175",
    "7:15pm": "H175",
    "19:20": "H176",
    "7:20pm": "H176",
    "19:25": "H177",
    "7:25pm": "H177",
    "19:30": "H178",
    "7:30pm": "H178",
    "19:35": "H179",
    "7:35pm": "H179",
    "19:40": "H180",
    "7:40pm": "H180",
    "19:45": "H181",
    "7:45pm": "H181",
    "19:50": "H182",
    "7:50pm": "H182",
    "19:55": "H183",
    "7:55pm": "H183",

    // 8:00 PM - 8:55 PM (H186 to H197)
    "20:00": "H186",
    "8:00pm": "H186",
    "20:05": "H187",
    "8:05pm": "H187",
    "20:10": "H188",
    "8:10pm": "H188",
    "20:15": "H189",
    "8:15pm": "H189",
    "20:20": "H190",
    "8:20pm": "H190",
    "20:25": "H191",
    "8:25pm": "H191",
    "20:30": "H192",
    "8:30pm": "H192",
    "20:35": "H193",
    "8:35pm": "H193",
    "20:40": "H194",
    "8:40pm": "H194",
    "20:45": "H195",
    "8:45pm": "H195",
    "20:50": "H196",
    "8:50pm": "H196",
    "20:55": "H197",
    "8:55pm": "H197",

    // 9:00 PM - 9:55 PM (H200 to H211)
    "21:00": "H200",
    "9:00pm": "H200",
    "21:05": "H201",
    "9:05pm": "H201",
    "21:10": "H202",
    "9:10pm": "H202",
    "21:15": "H203",
    "9:15pm": "H203",
    "21:20": "H204",
    "9:20pm": "H204",
    "21:25": "H205",
    "9:25pm": "H205",
    "21:30": "H206",
    "9:30pm": "H206",
    "21:35": "H207",
    "9:35pm": "H207",
    "21:40": "H208",
    "9:40pm": "H208",
    "21:45": "H209",
    "9:45pm": "H209",
    "21:50": "H210",
    "9:50pm": "H210",
    "21:55": "H211",
    "9:55pm": "H211",

    // 10:00 PM - 10:55 PM (H214 to H225)
    "22:00": "H214",
    "10:00pm": "H214",
    "22:05": "H215",
    "10:05pm": "H215",
    "22:10": "H216",
    "10:10pm": "H216",
    "22:15": "H217",
    "10:15pm": "H217",
    "22:20": "H218",
    "10:20pm": "H218",
    "22:25": "H219",
    "10:25pm": "H219",
    "22:30": "H220",
    "10:30pm": "H220",
    "22:35": "H221",
    "10:35pm": "H221",
    "22:40": "H222",
    "10:40pm": "H222",
    "22:45": "H223",
    "10:45pm": "H223",
    "22:50": "H224",
    "10:50pm": "H224",
    "22:55": "H225",
    "10:55pm": "H225",
  };

  // Look for an exact match in the map
  for (const [mapTime, cellRef] of Object.entries(timeMap)) {
    if (normalizedTime === mapTime.toLowerCase().replace(/\s+/g, "")) {
      return cellRef;
    }
  }

  // If no exact match, try to find the closest time
  console.log(`No exact match for time ${timeStr} in map. Looking for closest match.`);

  // Extract hours and minutes from the input time
  let inputHours, inputMinutes;
  if (normalizedTime.includes(":")) {
    [inputHours, inputMinutes] = normalizedTime.split(":").map(Number);
  } else {
    console.error(`Unable to parse time: ${timeStr}`);
    return null;
  }

  // Convert to total minutes for comparison
  const inputTotalMinutes = inputHours * 60 + inputMinutes;

  // Find the closest time in the map
  let closestTime = null;
  let closestDiff = Infinity;
  let closestCell = null;

  for (const [mapTime, cellRef] of Object.entries(timeMap)) {
    // Only process entries with a colon (time format)
    if (mapTime.includes(":")) {
      const [mapHours, mapMinutes] = mapTime.split(":").map(Number);
      const mapTotalMinutes = mapHours * 60 + mapMinutes;

      const diff = Math.abs(mapTotalMinutes - inputTotalMinutes);
      if (diff < closestDiff) {
        closestDiff = diff;
        closestTime = mapTime;
        closestCell = cellRef;
      }
    }
  }

  // Only use closest match if it's within 7 minutes (to avoid wrong mappings)
  if (closestDiff <= 7) {
    console.log(`Closest match: ${closestTime} → ${closestCell} (diff: ${closestDiff} minutes)`);
    return closestCell;
  }

  console.log(`No suitable match found for time ${timeStr}`);
  return null;
}

/**
 * Format a date as DD/MM/YY for sheet name
 *
 * @param {Date} date - Date object to format
 * @returns {string} - Formatted date string (e.g., "28/07/25")
 */
function formatSheetName(date) {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");

  // Use last 2 digits of year (YY format)
  const year = String(date.getFullYear()).slice(-2);

  return `${day}/${month}/${year}`;
}

/**
 * Update a noise reading for a specific date and time
 *
 * @param {object} options - Update options
 * @param {Date|string} options.date - Date for the reading (or ISO date string)
 * @param {string} options.time - Time for the reading (e.g., "19:30" or "7:30 PM")
 * @param {number} options.value - Noise reading value (dBA)
 * @returns {Promise<object>} - Result of the operation
 */
async function updateNoiseReading({ date, time, value }) {
  try {
    console.log(`\n=== DIRECT NOISE READING UPDATE ===`);

    // Get spreadsheet ID from environment
    const spreadsheetId = process.env.NOISE_SPREADSHEET_ID;
    if (!spreadsheetId) {
      return {
        success: false,
        message: "NOISE_SPREADSHEET_ID environment variable not set",
      };
    }

    // Parse date if it's a string
    let dateObj = date;
    if (typeof date === "string") {
      dateObj = new Date(date);
      if (isNaN(dateObj.getTime())) {
        return {
          success: false,
          message: `Invalid date format: ${date}`,
        };
      }
    }

    // Generate sheet name from date
    const sheetName = formatSheetName(dateObj);
    console.log(`Using sheet name: "${sheetName}"`);

    // Map time to cell reference
    const cellRef = mapTimeToCellReference(time);
    if (!cellRef) {
      return {
        success: false,
        message: `Could not map time ${time} to a cell reference`,
      };
    }
    console.log(`Mapped time ${time} to cell reference ${cellRef}`);

    // Validate value is a number
    const numValue = parseFloat(value);
    if (isNaN(numValue)) {
      return {
        success: false,
        message: `Invalid value (not a number): ${value}`,
      };
    }

    // Update the cell
    const updateResult = await updateDirectCell(spreadsheetId, sheetName, cellRef, numValue);

    return {
      ...updateResult,
      sheetName,
      time,
      date: dateObj.toISOString().split("T")[0],
    };
  } catch (error) {
    console.error("Error updating noise reading:", error);
    return {
      success: false,
      message: `Error updating noise reading: ${error.message}`,
    };
  }
}

/**
 * Fetch noise data from Supabase for a specific date and time range
 *
 * @param {object} options - Query options
 * @param {Date} options.date - Date object for the specific date to fetch data
 * @param {boolean} options.timeRangeFilter - Whether to apply time range filtering
 * @param {number} [options.startHour=7] - Starting hour (0-23) for filtering, defaults to 7am if not specified
 * @param {number} [options.endHour=23] - Ending hour (0-23) for filtering, defaults to 11pm if not specified
 * @returns {Promise<object>} - Fetched noise data grouped by location
 */
async function fetchNoiseDataForDateRange(options) {
  try {
    console.log("Fetching noise data from Supabase with options:", options);

    // Create a date range for the specified date (entire day)
    const date = options.date;

    // Start of the day
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);

    // End of the day
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);

    // If we need to apply time range filtering
    let startTime = startOfDay;
    let endTime = endOfDay;

    if (options.timeRangeFilter) {
      // Get start hour (default to 7am if not specified)
      const startHour = options.startHour !== undefined ? options.startHour : 7;

      // Get end hour (default to 11pm if not specified)
      const endHour = options.endHour !== undefined ? options.endHour : 23;

      // Set to startHour:00
      startTime = new Date(date);
      startTime.setHours(startHour, 0, 0, 0);

      // Set to endHour:55
      endTime = new Date(date);
      endTime.setHours(endHour, 55, 59, 999);
    }

    console.log(`Date range: ${startTime.toISOString()} - ${endTime.toISOString()}`);

    // Fetch data from Supabase
    // Format dates as YYYY-MM-DDThh:mm:ss to match Supabase timestamp format
    // The timestamp column format in Supabase is '2025-07-28T12:40:00'
    const formatLocalTime = (date) => {
      return (
        date.getFullYear() +
        "-" +
        String(date.getMonth() + 1).padStart(2, "0") +
        "-" +
        String(date.getDate()).padStart(2, "0") +
        "T" +
        String(date.getHours()).padStart(2, "0") +
        ":" +
        String(date.getMinutes()).padStart(2, "0") +
        ":" +
        String(date.getSeconds()).padStart(2, "0")
      );
    };

    const startTimeStr = formatLocalTime(startTime);
    const endTimeStr = formatLocalTime(endTime);

    console.log(`Local time range: ${startTimeStr} - ${endTimeStr}`);

    const { data, error } = await readNoiseData({
      startTime: startTimeStr,
      endTime: endTimeStr,
      orderBy: "timestamp",
    });

    if (error) {
      console.error("Error fetching noise data:", error);
      return {
        success: false,
        message: `Error fetching noise data: ${error.message}`,
        data: null,
      };
    }

    // Process the data
    if (data && data.length > 0) {
      console.log(`Processing ${data.length} records from Supabase`);

      // Log all unique locations for debugging
      const uniqueLocations = new Set();
      data.forEach((record) => {
        if (record.location) uniqueLocations.add(record.location);
      });
      console.log("All unique locations in data:", Array.from(uniqueLocations));

      // Group by location
      const groupedData = {};

      // Initialize with empty arrays for all known locations
      Object.keys(COLUMN_MAPPINGS).forEach((location) => {
        groupedData[location] = [];
      });

      // Process each record
      data.forEach((record) => {
        const location = record.location;
        if (!location) {
          console.warn("Record missing location field:", record);
          return;
        }

        // Find the matching NM code for this location
        let nmCode = null;

        // Check if the location is a direct match for our codes
        if (Object.keys(COLUMN_MAPPINGS).includes(location)) {
          nmCode = location;
          console.log(`Direct match for location: ${location}`);
        } else {
          // Try to find a matching prefix in the location mappings
          console.log(`Checking location mappings for: ${location}`);
          for (const [locationPrefix, code] of Object.entries(LOCATION_MAPPINGS)) {
            if (location.startsWith(locationPrefix)) {
              nmCode = code;
              console.log(`Matched location by prefix: ${locationPrefix} → ${code}`);
              break;
            }
          }

          // If not found by prefix, try to extract NM code from the location string
          if (!nmCode) {
            console.log(`No prefix match, trying to extract NM code from: ${location}`);
            // Look for patterns like "NM01", "NM02", etc.
            const nmMatch = location.match(/NM\d+/);
            if (nmMatch) {
              nmCode = nmMatch[0];
              console.log(`Extracted ${nmCode} from location ${location}`);
            } else {
              // Try alternate format with space
              const altMatch = location.match(/NM\s*0[1-5]/);
              if (altMatch) {
                // Clean up the matched pattern
                const matchedText = altMatch[0].replace(/\s+/g, "");
                nmCode = matchedText;
                console.log(`Extracted ${nmCode} from location ${location} (alternate format)`);
              }
            }
          }
        }

        if (!nmCode) {
          console.warn(`Could not map location to NM code: ${location}`);
          return;
        }

        // Extract timestamp and value
        const timestamp = new Date(record.timestamp);
        const value = record.Leq5min || record.leq5min || record.leq_5min || record.leq || record.value || null;

        if (value !== null) {
          console.log(`Found reading for ${nmCode} (from ${location}): ${value} at ${timestamp}`);

          groupedData[nmCode].push({
            timestamp,
            value,
            timeStr: timestamp.toLocaleTimeString("en-US", {
              hour: "numeric",
              minute: "2-digit",
              hour12: true,
            }),
            originalLocation: location,
          });
        }
      });

      return {
        success: true,
        message: `Successfully fetched noise data for ${startTime.toLocaleDateString()}`,
        data: groupedData,
        date: date,
        startTime: startTime,
        endTime: endTime,
        totalRecords: data ? data.length : 0,
      };
    } else {
      // No data found
      return {
        success: true,
        message: `No noise data found for ${startTime.toLocaleDateString()}`,
        data: {},
        date: date,
        startTime: startTime,
        endTime: endTime,
        totalRecords: 0,
      };
    }
  } catch (error) {
    console.error("Error in fetchNoiseDataForDateRange:", error);
    return {
      success: false,
      message: `Error fetching noise data: ${error.message}`,
      data: null,
    };
  }
}

/**
 * Create a mapping of time values to row numbers from sheet data
 *
 * @param {Array<Array<string>>} sheetData - 2D array of sheet data
 * @returns {Object} - Mapping of time strings to row numbers
 */
function createTimeToRowMapping(sheetData) {
  if (!sheetData || sheetData.length <= 1) {
    console.warn("Sheet data is empty or has only headers");
    return {};
  }

  const timeMapping = {};

  console.log("\nCreating time-to-row mapping:");

  // Start from row 1 (after header in row 0)
  for (let rowIndex = 1; rowIndex < sheetData.length; rowIndex++) {
    const row = sheetData[rowIndex];
    if (!row || row.length === 0) {
      console.log(`Row ${rowIndex + 1}: Empty row, skipping`);
      continue;
    }

    // Get the time value from column A (index 0)
    const timeValue = row[0];
    if (!timeValue) {
      console.log(`Row ${rowIndex + 1}: No time value in column A, skipping`);
      continue;
    }

    // Convert to string and normalize for matching
    const timeStr = String(timeValue).toLowerCase().trim();
    const timeStrNoSpaces = timeStr.replace(/\s+/g, "");

    console.log(`Row ${rowIndex + 1}: Time value: "${timeValue}" (type: ${typeof timeValue})`);

    // Handle Excel numeric time values
    if (typeof timeValue === "number" || (!isNaN(timeValue) && timeValue.toString().includes("."))) {
      // This might be an Excel time value (e.g., 0.7916 for 7:00 PM)
      const numericTime = parseFloat(timeValue);
      if (numericTime > 0 && numericTime < 1) {
        const totalMinutes = numericTime * 24 * 60;
        const hours = Math.floor(totalMinutes / 60);
        const minutes = Math.round(totalMinutes % 60);

        // Create multiple formats for matching
        const militaryFormat = `${hours}:${minutes.toString().padStart(2, "0")}`;
        const hour12 = hours > 12 ? hours - 12 : hours;
        const ampm = hours >= 12 ? "pm" : "am";
        const hour12Format = `${hour12}:${minutes.toString().padStart(2, "0")}${ampm}`;

        console.log(`  Excel time ${numericTime} → ${militaryFormat} (${hour12Format})`);

        timeMapping[militaryFormat] = rowIndex + 1;
        timeMapping[hour12Format] = rowIndex + 1;
        timeMapping[hour12Format.replace(/\s+/g, "")] = rowIndex + 1;

        // Continue to next row since we've handled this special case
        continue;
      }
    }

    // Store various formats for better matching
    timeMapping[timeStr] = rowIndex + 1;
    timeMapping[timeStrNoSpaces] = rowIndex + 1;

    // Try to parse and create variations for easier matching
    // Match patterns like "7:00 PM", "7:00PM", "19:00"
    const timePattern1 = /(\d+):(\d+)\s*(am|pm)?/i;
    const timePattern2 = /(\d+)(am|pm)/i;

    let hours, minutes, period;

    const match1 = timeStr.match(timePattern1);
    const match2 = timeStr.match(timePattern2);

    if (match1) {
      hours = parseInt(match1[1]);
      minutes = parseInt(match1[2]);
      period = match1[3] ? match1[3].toLowerCase() : null;

      console.log(`  Parsed time: ${hours}:${minutes} ${period || ""}`);

      if (period === "pm" && hours < 12) {
        // Convert to 24-hour format
        const militaryHours = hours + 12;
        const militaryFormat = `${militaryHours}:${minutes.toString().padStart(2, "0")}`;
        timeMapping[militaryFormat] = rowIndex + 1;
        console.log(`  Adding 24h format: ${militaryFormat}`);
      } else if (!period && hours >= 12) {
        // Might be 24-hour format, add 12-hour format too
        const pmHours = hours > 12 ? hours - 12 : 12;
        const pmFormat = `${pmHours}:${minutes.toString().padStart(2, "0")}pm`;
        timeMapping[pmFormat] = rowIndex + 1;
        timeMapping[pmFormat.replace(/\s+/g, "")] = rowIndex + 1;
        console.log(`  Adding 12h format: ${pmFormat}`);
      }
    } else if (match2) {
      hours = parseInt(match2[1]);
      minutes = 0;
      period = match2[2].toLowerCase();

      console.log(`  Parsed time: ${hours}:00 ${period}`);

      if (period === "pm" && hours < 12) {
        const militaryHours = hours + 12;
        const militaryFormat = `${militaryHours}:00`;
        timeMapping[militaryFormat] = rowIndex + 1;
        console.log(`  Adding 24h format: ${militaryFormat}`);
      }
    }
  }

  console.log(`\nCreated time mapping with ${Object.keys(timeMapping).length} entries.`);
  console.log("Time formats available:", Object.keys(timeMapping).slice(0, 10).join(", ") + "...");
  return timeMapping;
}

/**
 * Find the best matching row for a given time
 *
 * @param {Date|string} time - The time to match
 * @param {Object} timeToRowMapping - Mapping of time strings to row numbers
 * @returns {number|null} - The best matching row number or null if no match found
 */
function findBestMatchingRow(time, timeToRowMapping) {
  if (!timeToRowMapping || Object.keys(timeToRowMapping).length === 0) {
    return null;
  }

  // Convert time to string formats for matching
  let timeStr;
  let hours;
  let minutes;

  if (time instanceof Date) {
    hours = time.getHours();
    minutes = time.getMinutes();
    // Create multiple string representations for matching
    const militaryTime = `${hours}:${minutes.toString().padStart(2, "0")}`;
    const pmHours = hours > 12 ? hours - 12 : hours;
    const ampmTime = `${pmHours}:${minutes.toString().padStart(2, "0")}${hours >= 12 ? "pm" : "am"}`;

    // Try exact matches first
    if (timeToRowMapping[militaryTime]) {
      console.log(`Found exact match for ${militaryTime} at row ${timeToRowMapping[militaryTime]}`);
      return timeToRowMapping[militaryTime];
    }

    if (timeToRowMapping[militaryTime.toLowerCase()]) {
      console.log(
        `Found exact match for ${militaryTime.toLowerCase()} at row ${timeToRowMapping[militaryTime.toLowerCase()]}`,
      );
      return timeToRowMapping[militaryTime.toLowerCase()];
    }

    if (timeToRowMapping[ampmTime]) {
      console.log(`Found exact match for ${ampmTime} at row ${timeToRowMapping[ampmTime]}`);
      return timeToRowMapping[ampmTime];
    }

    if (timeToRowMapping[ampmTime.toLowerCase()]) {
      console.log(`Found exact match for ${ampmTime.toLowerCase()} at row ${timeToRowMapping[ampmTime.toLowerCase()]}`);
      return timeToRowMapping[ampmTime.toLowerCase()];
    }

    // No exact match, try normalized versions
    const normalizedMilitary = militaryTime.replace(/\s+/g, "");
    const normalizedAmPm = ampmTime.toLowerCase().replace(/\s+/g, "");

    for (const [mapTime, rowNum] of Object.entries(timeToRowMapping)) {
      const normalizedMapTime = mapTime.toLowerCase().replace(/\s+/g, "");
      if (normalizedMapTime === normalizedMilitary || normalizedMapTime === normalizedAmPm) {
        console.log(`Found normalized match for ${time} at row ${rowNum}`);
        return rowNum;
      }
    }
  } else if (typeof time === "string") {
    timeStr = time.toLowerCase().trim();

    // Try exact match
    if (timeToRowMapping[timeStr]) {
      console.log(`Found exact match for ${timeStr} at row ${timeToRowMapping[timeStr]}`);
      return timeToRowMapping[timeStr];
    }

    // Try normalized version
    const normalizedTimeStr = timeStr.replace(/\s+/g, "");
    for (const [mapTime, rowNum] of Object.entries(timeToRowMapping)) {
      const normalizedMapTime = mapTime.toLowerCase().replace(/\s+/g, "");
      if (normalizedMapTime === normalizedTimeStr) {
        console.log(`Found normalized match for ${timeStr} at row ${rowNum}`);
        return rowNum;
      }
    }

    // Parse the time string to extract hours and minutes
    const match1 = timeStr.match(/(\d+):(\d+)\s*(am|pm)?/i);
    const match2 = timeStr.match(/(\d+)(am|pm)/i);

    if (match1) {
      hours = parseInt(match1[1]);
      minutes = parseInt(match1[2]);
      const period = match1[3] ? match1[3].toLowerCase() : "";

      if (period === "pm" && hours < 12) {
        hours += 12;
      }
    } else if (match2) {
      hours = parseInt(match2[1]);
      minutes = 0;
      const period = match2[2].toLowerCase();

      if (period === "pm" && hours < 12) {
        hours += 12;
      }
    } else {
      return null; // Unable to parse time string
    }
  } else {
    return null; // Unsupported time format
  }

  // If we get here, we need to find the closest time based on hours and minutes
  const targetMinutes = hours * 60 + minutes;
  let bestMatch = null;
  let minDifference = Infinity;

  for (const [mapTime, rowNum] of Object.entries(timeToRowMapping)) {
    // Try to parse the mapTime to compare
    let mapHours, mapMinutes;

    const match1 = mapTime.match(/(\d+):(\d+)\s*(am|pm)?/i);
    const match2 = mapTime.match(/(\d+)(am|pm)/i);

    if (match1) {
      mapHours = parseInt(match1[1]);
      mapMinutes = parseInt(match1[2]);
      const period = match1[3] ? match1[3].toLowerCase() : "";

      if (period === "pm" && mapHours < 12) {
        mapHours += 12;
      }
    } else if (match2) {
      mapHours = parseInt(match2[1]);
      mapMinutes = 0;
      const period = match2[2].toLowerCase();

      if (period === "pm" && mapHours < 12) {
        mapHours += 12;
      }
    } else {
      continue; // Unable to parse map time
    }

    const mapTotalMinutes = mapHours * 60 + mapMinutes;
    const difference = Math.abs(targetMinutes - mapTotalMinutes);

    if (difference < minDifference) {
      minDifference = difference;
      bestMatch = rowNum;
    }
  }

  // Only use closest match if it's within 10 minutes (to avoid wrong mappings)
  if (bestMatch !== null && minDifference <= 10) {
    console.log(`Found closest time match with difference of ${minDifference} minutes at row ${bestMatch}`);
    return bestMatch;
  }

  console.log(`No suitable time match found for ${timeStr || hours + ":" + minutes}`);
  return null;
}

/**
 * Group readings by timestamp
 *
 * @param {Object} noiseData - Noise data grouped by location
 * @returns {Object} - Data grouped by timestamp (ISO string)
 */
function groupReadingsByTime(noiseData) {
  const timeGroups = {};

  // Process each location
  Object.keys(noiseData).forEach((location) => {
    const readings = noiseData[location];
    if (!readings || readings.length === 0) return;

    // Group readings by timestamp
    readings.forEach((reading) => {
      if (reading.value === null) return;

      const timeKey = reading.timestamp.toISOString();
      if (!timeGroups[timeKey]) {
        timeGroups[timeKey] = {
          timestamp: reading.timestamp,
          timeStr: reading.timeStr,
          readings: {},
        };
      }

      timeGroups[timeKey].readings[location] = reading.value;
    });
  });

  return timeGroups;
}

/**
 * Group timeGroups by hour for efficient batch processing
 * Preserves all 5-minute readings but groups them by hour for batched API calls
 *
 * @param {Object} timeGroups - Time groups from groupReadingsByTime
 * @returns {Object} - Time groups organized by hour keys
 */
function groupTimePointsByHour(timeGroups) {
  const hourlyBatches = {};

  Object.keys(timeGroups).forEach((timeKey) => {
    const timeData = timeGroups[timeKey];
    const timestamp = timeData.timestamp;

    // Create an hourly key (YYYY-MM-DDTHH) by truncating the minutes/seconds
    const hourDate = new Date(timestamp);
    hourDate.setMinutes(0, 0, 0);
    const hourKey = hourDate.toISOString().substring(0, 13); // Format: YYYY-MM-DDTHH

    // Initialize the hour batch if needed
    if (!hourlyBatches[hourKey]) {
      hourlyBatches[hourKey] = {};
    }

    // Add this time point to the hourly batch
    hourlyBatches[hourKey][timeKey] = timeData;
  });

  return hourlyBatches;
}

/**
 * Update multiple cells in a Google Sheet in a single batch request
 *
 * @param {string} spreadsheetId - Google Sheet ID
 * @param {string} sheetName - Name of the sheet (e.g. "28/07/25")
 * @param {Array<{range: string, value: any}>} updates - Array of updates with range and value
 * @returns {Promise<object>} - Result of the operation
 */
async function batchUpdateCells(spreadsheetId, sheetName, updates) {
  try {
    if (!updates || updates.length === 0) {
      return {
        success: true,
        message: "No updates to perform",
        updatedCells: 0,
      };
    }

    console.log(`Performing batch update of ${updates.length} cells in ${sheetName}`);

    // Initialize the Google Sheets API
    const sheets = createSheets({ version: "v4", auth: getAuth() });

    // Format the data for valueRanges
    const valueRanges = updates.map((update) => ({
      range: `${sheetName}!${update.range}`,
      values: [[update.value]],
    }));

    // Perform batch update
    const batchResult = await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      resource: {
        valueInputOption: "USER_ENTERED",
        data: valueRanges,
      },
    });

    const totalUpdated = batchResult.data.totalUpdatedCells || 0;
    console.log(`Batch update successful, updated ${totalUpdated} cells`);

    return {
      success: true,
      message: `Successfully updated ${totalUpdated} cells in batch`,
      updatedCells: totalUpdated,
      details: batchResult.data,
    };
  } catch (error) {
    console.error(`Error in batch update for sheet ${sheetName}:`, error.message);
    if (error.errors) {
      console.error("Detailed errors:", JSON.stringify(error.errors, null, 2));
    }

    return {
      success: false,
      message: `Error in batch update: ${error.message}`,
      updatedCells: 0,
    };
  }
}

/**
 * Update Google Sheet with noise monitoring data for a specific date
 * Maps NM01-NM05 data to appropriate columns (B, H, N, T, Z)
 * Groups updates by time window for efficient batch operations
 * Only updates cells that are empty to avoid overwriting existing data
 *
 * @param {Date} date - Date to process data for
 * @param {number} [startHour=7] - Starting hour (0-23) for filtering, defaults to 7am if not specified
 * @param {number} [endHour=23] - Ending hour (0-23) for filtering, defaults to 11pm if not specified
 * @param {boolean} [batchByHour=false] - If true, batch all updates for a single hour into one API call
 * @param {boolean} [timeRangeFilter=true] - If true, apply time range filtering based on startHour and endHour
 * @returns {Promise<object>} - Result of the update operation
 */
async function updateNoiseDataForDate(
  date = new Date(),
  startHour = 7,
  endHour = 24,
  batchByHour = false,
  timeRangeFilter = true,
) {
  try {
    console.log(`\n=== UPDATING NOISE DATA FOR ${date.toLocaleDateString()} ===`);

    // Get spreadsheet ID from environment
    const spreadsheetId = process.env.NOISE_SPREADSHEET_ID;
    if (!spreadsheetId) {
      return {
        success: false,
        message: "NOISE_SPREADSHEET_ID environment variable not set",
      };
    }

    // Fetch noise data from Supabase for the date with configurable time range filtering
    const fetchResult = await fetchNoiseDataForDateRange({
      date: date,
      timeRangeFilter: timeRangeFilter, // Use the provided timeRangeFilter parameter
      startHour: startHour, // Use the provided startHour (defaults to 7am)
      endHour: endHour, // Use the provided endHour (defaults to 11pm)
    });

    if (!fetchResult.success) {
      return fetchResult; // Return the error from fetch
    }

    const noiseData = fetchResult.data;
    if (!noiseData) {
      return {
        success: false,
        message: "No noise data returned from Supabase",
      };
    }

    // Get the sheet name for this date
    const sheetName = formatSheetName(date);
    console.log(`Using sheet name: "${sheetName}"`);

    // Check if sheet exists and create it if it doesn't
    console.log(`Checking if sheet "${sheetName}" exists and creating if needed...`);
    const sheetExists = await findOrCreateSheet(spreadsheetId, sheetName);

    if (!sheetExists) {
      return {
        success: false,
        message: `Failed to find or create sheet "${sheetName}"`,
      };
    }

    // Read the sheet data first to understand its structure
    console.log(`Reading sheet "${sheetName}" to understand its structure...`);
    const sheetData = await readGoogleSheet(spreadsheetId, sheetName);

    if (!sheetData || sheetData.length <= 1) {
      return {
        success: false,
        message: `Unable to read sheet "${sheetName}" or sheet is empty`,
      };
    }

    console.log(`Successfully read sheet with ${sheetData.length} rows`);

    // Enhanced debugging: Print the first few rows to understand the structure
    console.log("\nSheet structure (first few rows):");
    console.log("Headers:", JSON.stringify(sheetData[0]));
    for (let i = 1; i < Math.min(5, sheetData.length); i++) {
      console.log(`Row ${i + 1}:`, JSON.stringify(sheetData[i]));
    }

    // Create a mapping from time values to row numbers
    const timeToRowMapping = createTimeToRowMapping(sheetData);
    console.log(`Created time-to-row mapping with ${Object.keys(timeToRowMapping).length} entries`);

    // Create a map of cells that already have data to avoid overwriting
    const filledCells = new Map();

    // Scan through sheet data to identify filled cells
    for (let rowIndex = 1; rowIndex < sheetData.length; rowIndex++) {
      const row = sheetData[rowIndex];
      if (!row) continue;

      // Check each column for NM01-NM05 (B, H, N, T, Z)
      Object.entries(COLUMN_INDICES).forEach(([location, colIndex]) => {
        if (row[colIndex] !== undefined && row[colIndex] !== null && row[colIndex] !== "") {
          const cellRef = `${COLUMN_MAPPINGS[location]}${rowIndex + 1}`; // +1 because rowIndex is 0-based
          filledCells.set(cellRef, row[colIndex]);
          console.log(`Cell ${cellRef} already has data: ${row[colIndex]}`);
        }
      });
    }

    console.log(`Found ${filledCells.size} cells with existing data`);

    // Group readings by time rather than by location
    const timeGroups = groupReadingsByTime(noiseData);
    const timeKeys = Object.keys(timeGroups);

    if (timeKeys.length === 0) {
      return {
        success: true,
        message: "No noise data found for the specified date and time range",
        date: date.toISOString().split("T")[0],
        dataUpdated: false,
        recordsProcessed: 0,
      };
    }

    console.log(`Found ${timeKeys.length} unique time points with data`);

    // Track successes and failures
    const results = {
      success: [],
      failure: [],
      skipped: [],
    };

    // If batch by hour is enabled, group timepoints by hour first
    if (batchByHour) {
      console.log("\nBatch by hour mode enabled - processing all time points for each hour in a single API call");
      const hourlyBatches = groupTimePointsByHour(timeGroups);
      const hourKeys = Object.keys(hourlyBatches);
      console.log(`Grouped ${timeKeys.length} time points into ${hourKeys.length} hourly batches`);

      // Process each hour batch
      for (const hourKey of hourKeys) {
        console.log(`\nProcessing hour batch: ${hourKey}`);
        const hourTimePoints = hourlyBatches[hourKey];
        const hourTimeKeys = Object.keys(hourTimePoints);
        console.log(`This batch contains ${hourTimeKeys.length} time points`);

        // Prepare a large batch update for all cells in this hour
        const hourBatchUpdates = [];
        const hourTimeReport = [];

        // Process each time point in this hour
        for (const timeKey of hourTimeKeys) {
          const timeGroup = hourTimePoints[timeKey];
          const { timestamp, timeStr, readings } = timeGroup;

          // Find the matching row for this time
          const rowNumber = findBestMatchingRow(timestamp, timeToRowMapping);
          if (!rowNumber) {
            console.warn(`Could not find matching row for time ${timeStr}, skipping`);
            // Add all readings at this time to failures
            Object.keys(readings).forEach((location) => {
              results.failure.push({
                location,
                time: timeStr,
                reason: "No matching row for time",
              });
            });
            continue;
          }

          // Add this time point to the report for this hour
          hourTimeReport.push(`${timeStr} (Row ${rowNumber}): ${Object.keys(readings).length} readings`);

          // Process each location in this time window
          for (const location of Object.keys(readings)) {
            const value = readings[location];

            // Get the column for this location
            const column = COLUMN_MAPPINGS[location];
            if (!column) {
              console.warn(`No column mapping for location ${location}, skipping`);
              results.failure.push({
                location,
                time: timeStr,
                reason: "No column mapping for location",
              });
              continue;
            }

            // Construct cell reference
            const cellRef = `${column}${rowNumber}`;

            // Check if cell already has data - skip if it does
            if (filledCells.has(cellRef)) {
              results.skipped.push({
                location,
                time: timeStr,
                cell: cellRef,
                existingValue: filledCells.get(cellRef),
                newValue: value,
                reason: "Cell already has data",
              });
              continue;
            }

            // Add to hourly batch if cell is empty
            hourBatchUpdates.push({
              range: cellRef,
              value: value,
            });

            // Track in results for reporting
            results.success.push({
              location,
              time: timeStr,
              value,
              cell: cellRef,
              row: rowNumber,
              inBatch: true,
              hourBatch: hourKey,
            });
          }
        }

        // Print the time report for this hour
        console.log("Time points in this batch:\n" + hourTimeReport.join("\n"));

        // Perform the batch update for the entire hour if we have any updates
        if (hourBatchUpdates.length > 0) {
          try {
            console.log(`Sending batch update with ${hourBatchUpdates.length} cells for hour ${hourKey}`);
            const batchResult = await batchUpdateCells(spreadsheetId, sheetName, hourBatchUpdates);

            if (!batchResult.success) {
              console.error(`Hour batch update failed for ${hourKey}: ${batchResult.message}`);
              // Mark all as failed
              results.success = results.success.filter((r) => r.hourBatch !== hourKey || !r.inBatch);
              hourBatchUpdates.forEach((update) => {
                results.failure.push({
                  hourBatch: hourKey,
                  cell: update.range,
                  reason: `Hour batch update failed: ${batchResult.message}`,
                });
              });
            } else {
              console.log(`Successfully updated ${batchResult.updatedCells} cells for hour ${hourKey}`);

              // Add newly updated cells to filledCells map
              hourBatchUpdates.forEach((update) => {
                filledCells.set(update.range, update.value);
              });
            }
          } catch (error) {
            console.error(`Error in hour batch update for ${hourKey}:`, error);
            // Mark all as failed
            results.success = results.success.filter((r) => r.hourBatch !== hourKey || !r.inBatch);
            hourBatchUpdates.forEach((update) => {
              results.failure.push({
                hourBatch: hourKey,
                cell: update.range,
                reason: `Hour batch error: ${error.message}`,
              });
            });
          }
        } else {
          console.log(`No updates needed for hour ${hourKey} - all cells already have data`);
        }
      }
    } else {
      // Original processing - one time point at a time
      // Process each time window
      for (const timeKey of timeKeys) {
        const timeGroup = timeGroups[timeKey];
        const { timestamp, timeStr, readings } = timeGroup;

        // Find the matching row for this time
        const rowNumber = findBestMatchingRow(timestamp, timeToRowMapping);
        if (!rowNumber) {
          console.warn(`Could not find matching row for time ${timeStr}, skipping`);
          // Add all readings at this time to failures
          Object.keys(readings).forEach((location) => {
            results.failure.push({
              location,
              time: timeStr,
              reason: "No matching row for time",
            });
          });
          continue;
        }

        console.log(`\nProcessing time window: ${timeStr} (Row ${rowNumber})`);
        console.log(`Found ${Object.keys(readings).length} location readings for this time window`);

        // Prepare batch update for this time window
        const batchUpdates = [];

        // Process each location in this time window
        for (const location of Object.keys(readings)) {
          const value = readings[location];

          // Get the column for this location
          const column = COLUMN_MAPPINGS[location];
          if (!column) {
            console.warn(`No column mapping for location ${location}, skipping`);
            results.failure.push({
              location,
              time: timeStr,
              reason: "No column mapping for location",
            });
            continue;
          }

          // Construct cell reference
          const cellRef = `${column}${rowNumber}`;

          // Check if cell already has data - skip if it does
          if (filledCells.has(cellRef)) {
            console.log(
              `Skipping ${location} at ${timeStr}: Cell ${cellRef} already has value ${filledCells.get(cellRef)}`,
            );
            results.skipped.push({
              location,
              time: timeStr,
              cell: cellRef,
              existingValue: filledCells.get(cellRef),
              newValue: value,
              reason: "Cell already has data",
            });
            continue;
          }

          // Add to batch only if cell is empty
          console.log(`Adding to batch: ${location} at ${timeStr} with value ${value} to cell ${cellRef}`);

          batchUpdates.push({
            range: cellRef,
            value: value,
          });

          // Track in results for reporting
          results.success.push({
            location,
            time: timeStr,
            value,
            cell: cellRef,
            row: rowNumber,
            inBatch: true,
          });
        }

        // Perform batch update if we have any updates
        if (batchUpdates.length > 0) {
          try {
            console.log(`Sending batch update with ${batchUpdates.length} cells for time ${timeStr}`);
            const batchResult = await batchUpdateCells(spreadsheetId, sheetName, batchUpdates);

            if (!batchResult.success) {
              console.error(`Batch update failed for time ${timeStr}: ${batchResult.message}`);
              // Mark all as failed
              results.success = results.success.filter((r) => r.time !== timeStr || !r.inBatch);
              batchUpdates.forEach((update) => {
                results.failure.push({
                  time: timeStr,
                  cell: update.range,
                  reason: `Batch update failed: ${batchResult.message}`,
                });
              });
            } else {
              console.log(`Successfully updated ${batchResult.updatedCells} cells for time ${timeStr}`);

              // Add newly updated cells to filledCells map
              batchUpdates.forEach((update) => {
                filledCells.set(update.range, update.value);
              });
            }
          } catch (error) {
            console.error(`Error in batch update for time ${timeStr}:`, error);
            // Mark all as failed
            results.success = results.success.filter((r) => r.time !== timeStr || !r.inBatch);
            batchUpdates.forEach((update) => {
              results.failure.push({
                time: timeStr,
                cell: update.range,
                reason: `Batch error: ${error.message}`,
              });
            });
          }
        } else {
          console.log(`No updates needed for time window ${timeStr} - all cells already have data`);
        }
      }
    }

    // Write to analysis sheets (NM01/NM02) — non-blocking
    let analysisResults = {};
    try {
      analysisResults = await updateAnalysisSheets(date, noiseData);
      console.log(
        `[Analysis] Results: NM01=${analysisResults.NM01?.written || 0} written, NM02=${analysisResults.NM02?.written || 0} written`,
      );
    } catch (analysisError) {
      console.error("[Analysis] Error (non-blocking):", analysisError.message);
    }

    // Summarize the results
    return {
      success: results.failure.length === 0 && (results.success.length > 0 || results.skipped.length > 0),
      message: `Updated ${results.success.length} readings, skipped ${results.skipped.length} existing readings, failed ${results.failure.length} readings`,
      date: date.toISOString().split("T")[0],
      sheetName: sheetName,
      dataUpdated: results.success.length > 0,
      successful: results.success,
      skipped: results.skipped,
      failed: results.failure,
      totalProcessed: results.success.length + results.skipped.length + results.failure.length,
      batchCount: timeKeys.length,
      analysisResults,
    };
  } catch (error) {
    console.error("Error updating noise data to Google Sheets:", error);
    return {
      success: false,
      message: `Error updating noise data: ${error.message}`,
      date: date ? date.toISOString().split("T")[0] : null,
    };
  }
}

module.exports = {
  updateNoiseReading,
  mapTimeToCellReference,
  formatSheetName,
  updateDirectCell,
  fetchNoiseDataForDateRange,
  updateNoiseDataForDate,
  batchUpdateCells,
  groupReadingsByTime,
  groupTimePointsByHour,
  COLUMN_MAPPINGS,
  COLUMN_INDICES,
  LOCATION_MAPPINGS,
};
