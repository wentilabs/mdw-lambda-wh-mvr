// Note: dotenv is loaded in index.js handler, secrets come from AWS Secrets Manager
const { readGoogleSheet, writeArrayToGSheetRow, updateCell, getSheetNames } = require("./gsheet");
const { parse, format } = require("date-fns");
const alasql = require("alasql");
const { getSupabaseClient } = require("./common");
const { convertToSingaporeTime } = require("./date");
const { getSpreadsheetConfig, getSoilDisposalSubcon } = require("../config/group-config");
const { discoverSafetyTabs } = require("./safety-sheets");

/**
 * Gets the next serial number atomically using Supabase
 * @param {string} sheetName - The sheet name (e.g., "Safety", "Manpower")
 * @param {string} spreadsheetId - The spreadsheet ID to create unique key
 * @returns {Promise<number>} - The next serial number
 */
async function getNextSerialNumber(sheetName, spreadsheetId) {
  const maxRetries = 5;
  const sheetKey = `${spreadsheetId}_${sheetName}`;
  // Create a minimal groupConfig for loadData
  const groupConfig = { spreadsheetId };

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // First, try to get existing record
      const { data: existingRecord, error: selectError } = await getSupabaseClient()
        .from("serial_numbers")
        .select("current_sn")
        .eq("sheet_key", sheetKey)
        .maybeSingle();

      if (selectError) {
        console.error("Error reading serial number:", selectError);
        throw selectError;
      }

      let nextSN;

      if (!existingRecord) {
        // No record exists, need to initialize from sheet data
        console.log(`Initializing serial number for ${sheetKey} from sheet data`);

        const existingData = await loadData(sheetName, groupConfig);
        let maxSN = 0;

        if (existingData && existingData.length > 1) {
          // Check length > 1 to account for header
          for (let i = 1; i < existingData.length; i++) {
            const row = existingData[i];
            if (!row || row.every((cell) => cell === null || cell === undefined || cell === "")) {
              continue;
            }
            const snValue = parseInt(row[0]);
            if (!isNaN(snValue) && snValue > maxSN) {
              maxSN = snValue;
            }
          }
        }

        nextSN = maxSN + 1;
        console.log(`Found max S/N in sheet: ${maxSN}, initializing to: ${nextSN}`);

        // Insert new record with the next S/N
        const { data: insertData, error: insertError } = await getSupabaseClient()
          .from("serial_numbers")
          .upsert(
            {
              sheet_key: sheetKey,
              current_sn: nextSN,
              updated_at: new Date().toISOString(),
            },
            {
              onConflict: "sheet_key",
            },
          )
          .select("current_sn")
          .single();

        if (insertError) {
          console.error("Error inserting serial number:", insertError);
          throw insertError;
        }

        return insertData.current_sn;
      } else {
        // Record exists, increment it atomically
        const newSN = existingRecord.current_sn + 1;

        const { data: updateData, error: updateError } = await getSupabaseClient()
          .from("serial_numbers")
          .update({
            current_sn: newSN,
            updated_at: new Date().toISOString(),
          })
          .eq("sheet_key", sheetKey)
          .eq("current_sn", existingRecord.current_sn) // Ensure no one else updated it
          .select("current_sn")
          .single();

        if (updateError) {
          console.error("Error updating serial number:", updateError);
          throw updateError;
        }

        if (!updateData) {
          // Someone else updated it, retry
          console.log(`Serial number conflict for ${sheetKey}, retrying...`);
          await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 100));
          continue;
        }

        console.log(`Got next S/N for ${sheetKey}: ${updateData.current_sn}`);
        return updateData.current_sn;
      }
    } catch (error) {
      console.error(`Attempt ${attempt + 1} failed for ${sheetKey}:`, error.message);

      if (attempt === maxRetries - 1) {
        console.error(
          `All ${maxRetries} attempts failed for ${sheetKey}, falling back to original sheet counting method`,
        );

        // Fallback to original method: count from sheet data
        const existingData = await loadData(sheetName, groupConfig);
        let maxSN = 0;

        if (existingData && existingData.length > 1) {
          // Check length > 1 to account for header
          for (let i = 1; i < existingData.length; i++) {
            const row = existingData[i];
            if (!row || row.every((cell) => cell === null || cell === undefined || cell === "")) {
              continue;
            }
            const snValue = parseInt(row[0]);
            if (!isNaN(snValue) && snValue > maxSN) {
              maxSN = snValue;
            }
          }
        }

        const fallbackSN = maxSN + 1;
        console.log(`Fallback: Found max S/N in sheet: ${maxSN}, using: ${fallbackSN}`);
        return fallbackSN;
      }

      // Wait before retry with exponential backoff
      await new Promise((resolve) => setTimeout(resolve, 100 * Math.pow(2, attempt) + Math.random() * 100));
    }
  }
}

/**
 * Evaluates Excel formula strings to numeric values for SQL operations
 * @param {string} formulaString - Excel formula like "=7.5", "=10+8+37", "=7.5 m³"
 * @returns {number|null} - Numeric value or null if cannot be evaluated
 */
function evaluateExcelFormula(formulaString) {
  if (!formulaString || typeof formulaString !== "string") {
    return null;
  }

  // Handle cases like "(no volume data)", "NA", empty strings
  const cleaned = formulaString.trim();
  if (!cleaned || cleaned.toLowerCase().includes("no volume") || cleaned.toUpperCase() === "NA") {
    return null;
  }

  // Remove units like "m³" from the string
  let processedString = cleaned.replace(/\s*(m³|m3|cubic|cu).*$/i, "").trim();

  // Handle Excel formulas that start with "="
  if (processedString.startsWith("=")) {
    processedString = processedString.substring(1); // Remove the "=" prefix
  }

  // Handle simple numeric values (e.g., "7.5")
  const simpleNumMatch = processedString.match(/^([0-9]+\.?[0-9]*)$/);
  if (simpleNumMatch) {
    const value = parseFloat(simpleNumMatch[1]);
    return isNaN(value) ? null : value;
  }

  // Handle addition formulas (e.g., "10+8+37", "7.5+2.3")
  const additionMatch = processedString.match(/^([0-9]+\.?[0-9]*(?:\+[0-9]+\.?[0-9]*)*)$/);
  if (additionMatch) {
    try {
      const parts = processedString.split("+");
      let sum = 0;
      for (const part of parts) {
        const num = parseFloat(part.trim());
        if (isNaN(num)) {
          return null; // If any part is invalid, return null
        }
        sum += num;
      }
      return sum;
    } catch (e) {
      console.warn("Failed to evaluate addition formula:", processedString, e.message);
      return null;
    }
  }

  // Handle more complex mathematical expressions (with basic safety)
  // Only allow numbers, +, -, *, /, (, ), and decimal points
  if (/^[0-9+\-*/()\. ]+$/.test(processedString)) {
    try {
      // Use Function constructor for safe evaluation (no access to global scope)
      const result = new Function("return " + processedString)();
      return typeof result === "number" && !isNaN(result) ? result : null;
    } catch (e) {
      console.warn("Failed to evaluate mathematical expression:", processedString, e.message);
      return null;
    }
  }

  // If we can't parse it, log for debugging and return null
  console.warn("Unable to parse Volume formula:", formulaString);
  return null;
}

// USECASE DEPENDENT - Sheet names (spreadsheet IDs should come from groupConfig)
const dailyUpdateSheetName = "Daily Update";
const manpowerSheetName = "Manpower";
const safetySheetName = "Safety";
const sheetName = "Safety";

// Process-level cache for the merged multi-tab safety load (current "Safety" + monthly archives).
// Mirrors data/soil_disposal.js — guarantees burst determinism (the QA consistency test fires 5× back
// to back) and avoids re-reading N tabs per call. Keyed on spreadsheetId; TTL 5 min; only non-empty cached.
const SAFETY_SHEET_CACHE = new Map();
const SAFETY_CACHE_TTL_MS = 5 * 60 * 1000;

// Invalidate the merged-safety cache for a spreadsheet. MUST be called whenever the set of safety
// tabs changes (monthly rotation, archive recovery) — otherwise a cached row's __SourceSheet__ /
// RowNumber points at a tab that was just renamed/cleared, and a Novade-Id writeback within the
// 5-min TTL would land on the WRONG tab. Pass no arg to clear everything.
function invalidateSafetyCache(spreadsheetId) {
  if (spreadsheetId) SAFETY_SHEET_CACHE.delete(spreadsheetId);
  else SAFETY_SHEET_CACHE.clear();
}
const pilingDataSheetName = "Pile Information";

// Date columns that need normalization for proper SQL ordering
const DATE_COLUMNS = [
  "Starting Date and Time (Boring Start)",
  "Ending Date and Time (Boring Completion)",
  "Data and Time of Kingpost Placement",
  "Date and Time of lowering rebar cage",
  "Casting Start Time",
  "Casting Complete Time",
  "Pull Out Casing Time",
  "Airlift Start Time",
  "Airlift End Time",
];

function isExcelSerial(value) {
  return typeof value === "number" && value > 1 && value < 100000;
}

function isStringDate(value) {
  return typeof value === "string" && /^\d{2}-\w{3,4}-\d{4}/.test(value);
}

// Convert Excel serial number back to readable date string
function excelSerialToString(serial) {
  try {
    if (!isExcelSerial(serial)) return null;

    // Excel uses January 1, 1900 as day 1, but has a leap year bug for 1900
    // More accurate: Use 1899-12-30 as the epoch to match Excel's behavior
    const excelEpoch = new Date(1899, 11, 30, 0, 0, 0, 0);
    const msPerDay = 24 * 60 * 60 * 1000;

    // Round to avoid floating point precision issues
    const roundedSerial = Math.round(serial * 100000) / 100000;
    const jsDate = new Date(excelEpoch.getTime() + roundedSerial * msPerDay);

    if (isNaN(jsDate.getTime())) return null;

    // Format as DD-MMM-YYYY HH:MM
    const day = jsDate.getDate().toString().padStart(2, "0");
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const month = monthNames[jsDate.getMonth()];
    const year = jsDate.getFullYear();
    const hours = jsDate.getHours().toString().padStart(2, "0");
    const minutes = jsDate.getMinutes().toString().padStart(2, "0");

    return `${day}-${month}-${year} ${hours}:${minutes}`;
  } catch (e) {
    return null;
  }
}

// Enhanced function to normalize date for display column (always returns readable string)
function normalizeDateForDisplay(value) {
  if (!value || value === "" || String(value).toUpperCase() === "NA") {
    return ""; // Keep empty/NA as empty
  }

  if (isExcelSerial(value)) {
    // Convert Excel serial to readable string
    const readable = excelSerialToString(value);
    return readable !== null ? readable : value;
  } else if (isStringDate(value)) {
    return value; // Already a readable string
  }

  return value; // Return as-is for other formats
}

// Enhanced function to normalize date for sort column (always returns ISO datetime string)
function normalizeDateForSort(value) {
  if (!value || value === "" || String(value).toUpperCase() === "NA") {
    return ""; // Keep empty/NA as empty for filtering
  }

  if (isExcelSerial(value)) {
    // Convert Excel serial to ISO datetime string
    const readable = excelSerialToString(value);
    if (readable) {
      // Convert "DD-MMM-YYYY HH:MM" to "YYYY-MM-DD HH:MM:SS"
      return convertToISODateTime(readable);
    }
    return value;
  } else if (isStringDate(value)) {
    // Convert "DD-MMM-YYYY HH:MM" to "YYYY-MM-DD HH:MM:SS"
    return convertToISODateTime(value);
  }

  return value; // Return as-is for other formats
}

// Convert DD-MMM-YYYY HH:MM format to ISO YYYY-MM-DD HH:MM:SS format for AlaSQL
function convertToISODateTime(dateStr) {
  try {
    const [datePart, timePart = "00:00"] = String(dateStr).split(" ");
    const [day, month, year] = datePart.split("-");

    // Convert month name to number (handle both 3-letter and 4-letter abbreviations)
    const monthMap = {
      Jan: 0,
      Feb: 1,
      Mar: 2,
      Apr: 3,
      May: 4,
      Jun: 5,
      Jul: 6,
      Aug: 7,
      Sep: 8,
      Sept: 8,
      Oct: 9,
      Nov: 10,
      Dec: 11,
    };
    const monthIndex = monthMap[month];

    if (monthIndex === undefined) return dateStr; // Keep original if month not found

    const monthNum = (monthIndex + 1).toString().padStart(2, "0");
    const dayNum = day.padStart(2, "0");
    const timeWithSeconds = timePart.includes(":")
      ? timePart.split(":").length === 2
        ? `${timePart}:00`
        : timePart
      : `${timePart}:00:00`;

    return `${year}-${monthNum}-${dayNum} ${timeWithSeconds}`;
  } catch (e) {
    return dateStr; // Return original if conversion fails
  }
}

async function loadData(sheetNameParam = null, groupConfig = null) {
  // Load data from gsheet - spreadsheetId MUST come from groupConfig
  const targetSpreadsheetId = groupConfig?.spreadsheetId;
  if (!targetSpreadsheetId) {
    console.error("No spreadsheetId provided in groupConfig for loadData");
    return [];
  }
  const targetSheet = sheetNameParam || sheetName;
  console.log(`Loading data from sheet: ${targetSheet}, spreadsheet: ${targetSpreadsheetId}`);
  const data = await readGoogleSheet(targetSpreadsheetId, targetSheet);
  console.log(`Found ${data.length} rows of data`);
  return data;
}

/**
 * Format a raw sheet `data` array ([headers, ...rows]) into AlaSQL row objects.
 * Mirrors the per-row normalization used by the generic single-tab load (Date,
 * pile-cap Timestamp, DATE_COLUMNS + _sort, Volume, generic) and attaches the
 * 1-based sheet RowNumber. Extracted so the safety multi-tab merge can format
 * each tab independently (correct per-tab RowNumber) and reuse identical logic.
 */
function formatSheetRows(data, { isPileCapQuery = false } = {}) {
  if (!data || data.length < 2) return [];
  const headers = data[0];
  return data.slice(1).map((row, rowIdx) => {
    const obj = {};
    headers.forEach((header, index) => {
      if (header === "Date") {
        obj[header] = normalizeDateString(row[index]);
      } else if (header === "Timestamp" && isPileCapQuery) {
        const rawTs = row[index];
        if (rawTs && typeof rawTs === "number") {
          const epoch = new Date(Date.UTC(1899, 11, 30));
          const msPerDay = 24 * 60 * 60 * 1000;
          const dt = new Date(epoch.getTime() + rawTs * msPerDay);
          const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
          const dd = String(dt.getUTCDate()).padStart(2, "0");
          const mmm = months[dt.getUTCMonth()];
          const yyyy = dt.getUTCFullYear();
          const hh = String(dt.getUTCHours()).padStart(2, "0");
          const mm = String(dt.getUTCMinutes()).padStart(2, "0");
          obj[header] = `${dd}-${mmm}-${yyyy} ${hh}:${mm}`;
        } else {
          obj[header] = String(rawTs || "").replace(/^'/, "");
        }
      } else if (DATE_COLUMNS.includes(header)) {
        const rawValue = row[index];
        obj[header] = normalizeDateForDisplay(rawValue);
        obj[header + "_sort"] = normalizeDateForSort(rawValue);
      } else if (header === "Volume") {
        let value = row[index];
        if (value === null || value === undefined) value = "";
        if (typeof value === "string" && value.trim()) {
          const numericValue = evaluateExcelFormula(value);
          obj[header] = numericValue !== null ? numericValue : 0;
        } else {
          obj[header] = 0;
        }
      } else {
        let value = row[index];
        if (value === null || value === undefined) value = "";
        if (typeof value === "string" && value.trim() === "") value = "";
        obj[header] = value;
      }
    });
    obj.RowNumber = rowIdx + 2;
    return obj;
  });
}

async function runSQLQuery(query, queryType = null, options = {}) {
  // Register custom AlaSQL functions
  alasql.fn.getMessageId = function (senderJson) {
    try {
      return JSON.parse(senderJson).messageId;
    } catch (e) {
      return null;
    }
  };

  alasql.fn.getParentMessageId = function (senderJson) {
    try {
      const parsed = JSON.parse(senderJson);
      return parsed?.parentMsgKey || null;
    } catch (e) {
      return null;
    }
  };

  // JSON_EXTRACT function for safety subcontractor queries (case-sensitive)
  alasql.fn.JSON_EXTRACT = function (jsonString, path) {
    try {
      if (!jsonString) return null;
      const obj = typeof jsonString === "string" ? JSON.parse(jsonString) : jsonString;

      // Handle simple paths like '$.name'
      if (path === "$.name") {
        return obj.name || null;
      }

      // Handle other simple paths
      const pathKey = path.replace("$.", "");
      return obj[pathKey] || null;
    } catch (e) {
      return null;
    }
  };

  // JSON_EXTRACT_CI — case-insensitive version for querying role/machine breakdowns
  // Usage: JSON_EXTRACT_CI([Details], 'rigger') returns the count for key "Rigger", "rigger", "RIGGER", etc.
  alasql.fn.JSON_EXTRACT_CI = function (jsonString, key) {
    try {
      if (!jsonString || !key) return null;
      const obj = typeof jsonString === "string" ? JSON.parse(jsonString) : jsonString;
      const lowerKey = key.toLowerCase();
      for (const k of Object.keys(obj)) {
        if (k.toLowerCase() === lowerKey) {
          return obj[k];
        }
      }
      return null;
    } catch (e) {
      return null;
    }
  };

  // JSON_KEYS — returns comma-separated list of all keys in a JSON object
  // Usage: JSON_KEYS([Details]) returns "Supervisor,Worker,Rigger" etc.
  alasql.fn.JSON_KEYS = function (jsonString) {
    try {
      if (!jsonString) return "";
      const obj = typeof jsonString === "string" ? JSON.parse(jsonString) : jsonString;
      return Object.keys(obj).join(", ");
    } catch (e) {
      return "";
    }
  };

  // Safe pile number normalization function
  alasql.fn.normalizePileNumber = function (pileNumber) {
    if (!pileNumber) return "";

    // Convert to string safely
    let normalized;
    try {
      normalized = String(pileNumber).trim();
    } catch (e) {
      return "";
    }

    // Replace spaces with hyphens
    normalized = normalized.replace(/\s+/g, "-");

    // Convert to uppercase for consistency
    return normalized.toUpperCase();
  };

  console.log("query: ", query);
  // USECASE DEPENDENT
  try {
    const isSafetyQuery = query.toLowerCase().includes("safetydata") || queryType === "safety";
    const isManpowerQuery = query.toLowerCase().includes("manpowerdata") || queryType === "manpower";
    const isPilingData = query.toLowerCase().includes("pilingdata") || queryType === "piling";
    const isWbgtQuery = query.toLowerCase().includes("wbgtdata") || queryType === "wbgt";
    const isDoInfoQuery = query.toLowerCase().includes("doinfodata") || queryType === "doinfo";
    const isMachinesQuery = query.toLowerCase().includes("machinesdata") || queryType === "machines";
    const isRigQuery = query.toLowerCase().includes("rigdata") || queryType === "rig";
    const isDailyMessageQuery = query.toLowerCase().includes("dailymessagedata") || queryType === "dailymessage";
    const isDocumentQuery = query.toLowerCase().includes("documentdata") || queryType === "document";
    const isSoilDisposalQuery = query.toLowerCase().includes("soildisposaldata") || queryType === "soil_disposal";
    const isPilingProgressQuery = query.toLowerCase().includes("pilingprogressdata") || queryType === "piling_progress";
    const isIMProgressQuery = query.toLowerCase().includes("improgressdata") || queryType === "im_progress";
    const isNoiseQuery = query.toLowerCase().includes("noisedata") || queryType === "noise";
    const isPileCapQuery = query.toLowerCase().includes("pilecapdata") || queryType === "pile_cap";

    // Register math functions for noise Leq calculations
    alasql.fn.LOG10 = Math.log10;
    alasql.fn.POW = Math.pow;

    // WBGT data: load from Supabase (same pattern as noise)
    const isWbgtSupabaseQuery = query.toLowerCase().includes("wbgtdata") || queryType === "wbgt_supabase";
    if (isWbgtSupabaseQuery) {
      // Supabase returns max 1000 rows per request — paginate to get all data
      const allWbgtRows = [];
      const PAGE_SIZE = 1000;
      let offset = 0;
      let hasMore = true;
      while (hasMore) {
        const { data: page, error: wbgtError } = await getSupabaseClient()
          .schema("wohhup")
          .from("ir2_wbgt")
          .select("timestamp, location, wbgt_outdoor")
          .order("timestamp", { ascending: true })
          .range(offset, offset + PAGE_SIZE - 1);

        if (wbgtError) throw new Error(`Supabase WBGT query error: ${wbgtError.message}`);
        if (!page || page.length === 0) break;
        allWbgtRows.push(...page);
        offset += page.length;
        hasMore = page.length === PAGE_SIZE;
      }

      alasql("DROP TABLE IF EXISTS wbgtData");
      alasql("CREATE TABLE wbgtData ([timestamp] STRING, [location] STRING, [wbgt_outdoor] NUMBER)");
      alasql.tables.wbgtData.data = allWbgtRows;

      console.log(`Loaded WBGT data: ${allWbgtRows.length} rows from Supabase`);
      return alasql(query);
    }

    // Noise data: load from Supabase instead of Google Sheets (with pagination)
    if (isNoiseQuery) {
      const allNoiseRows = [];
      const NOISE_PAGE = 1000;
      let noiseOffset = 0;
      let noiseHasMore = true;
      while (noiseHasMore) {
        const { data: page, error: noiseError } = await getSupabaseClient()
          .schema("wohhup")
          .from("ir2_noise_data_daily")
          .select("timestamp, location, leq_5min")
          .order("timestamp", { ascending: true })
          .range(noiseOffset, noiseOffset + NOISE_PAGE - 1);

        if (noiseError) throw new Error(`Supabase noise query error: ${noiseError.message}`);
        if (!page || page.length === 0) break;
        allNoiseRows.push(...page);
        noiseOffset += page.length;
        noiseHasMore = page.length === NOISE_PAGE;
      }

      alasql("DROP TABLE IF EXISTS noiseData");
      alasql("CREATE TABLE noiseData ([timestamp] STRING, [location] STRING, [leq_5min] NUMBER)");
      alasql.tables.noiseData.data = allNoiseRows;

      console.log(`Loaded noise data: ${allNoiseRows.length} rows from Supabase`);
      return alasql(query);
    }

    // Get target sheet name from options, or determine from query type
    let targetSheet = options.sheetName || null;
    const groupConfig = options.groupConfig;

    // Only determine sheet name if not provided in options
    if (!targetSheet) {
      // USECASE DEPENDENT - use group-specific sheet names if available
      if (isSafetyQuery) {
        // Safety uses MONTHLY archive tabs ("Safety" + "Safety-MMM YYYY"). Leave targetSheet
        // null so the multi-sheet merge loader below reads + merges ALL of them (full history).
        // (When a caller passes options.sheetName — only the edit/delete find loop — targetSheet
        // is already set above and we use that single tab, capping the search at that month.)
      } else if (isManpowerQuery) {
        targetSheet = groupConfig?.manpowerSheetName || manpowerSheetName;
      } else if (isPilingData) {
        targetSheet = groupConfig?.informationSheetName || pilingDataSheetName;
      } else if (isWbgtQuery) {
        targetSheet = groupConfig?.wbgtSheetName || "WBGT";
      } else if (isDoInfoQuery) {
        targetSheet = groupConfig?.doInformationSheetName || "DO Information";
      } else if (isMachinesQuery) {
        targetSheet = groupConfig?.machinesSheetName || "Machines";
      } else if (isRigQuery) {
        targetSheet = groupConfig?.rigSheetName || "Rig";
      } else if (isDailyMessageQuery) {
        targetSheet = groupConfig?.dailyMessageSheetName || "Daily Message";
      } else if (isDocumentQuery) {
        targetSheet = "Document Log"; // Document register always uses "Document Log" sheet
      } else if (isPilingProgressQuery) {
        targetSheet = groupConfig?.pilingProgressSheetName || "Piling Progress";
      } else if (isIMProgressQuery) {
        targetSheet = groupConfig?.imProgressSheetName || "IM Progress";
      } else if (isPileCapQuery) {
        targetSheet = groupConfig?.pileCapSheetName || "CJ Tracking";
      }
    }

    // Soil disposal uses date-named sheets — targetSheet is resolved in the multi-sheet loader below
    if (!targetSheet && !isSoilDisposalQuery && !isSafetyQuery) {
      throw new Error("Unable to determine target sheet name. Please provide sheetName in options.");
    }

    // Use domain-specific spreadsheet IDs when available (pattern from cache.js and daily-summary.js)
    // This ensures queries use the correct spreadsheet for each domain
    let configForLoad = options.groupConfig;

    // Document queries use spreadsheetId directly from options (not groupConfig)
    if (isDocumentQuery && options.spreadsheetId) {
      configForLoad = {
        spreadsheetId: options.spreadsheetId,
      };
    } else if (groupConfig) {
      if (isPilingData) {
        // Piling queries use pileInfoSpreadsheetId, falling back to domain default
        const pilingDomainConfig = getSpreadsheetConfig("pileInfo");
        configForLoad = {
          ...groupConfig,
          spreadsheetId:
            groupConfig.pileInfoSpreadsheetId || pilingDomainConfig?.spreadsheetId || groupConfig.spreadsheetId,
        };
      } else if (isManpowerQuery) {
        // Manpower queries use manpowerSpreadsheetId, falling back to domain default
        const manpowerDomainConfig = getSpreadsheetConfig("manpower");
        configForLoad = {
          ...groupConfig,
          spreadsheetId:
            groupConfig.manpowerSpreadsheetId || manpowerDomainConfig?.spreadsheetId || groupConfig.spreadsheetId,
        };
      } else if (isWbgtQuery) {
        // WBGT queries use wbgtSpreadsheetId, falling back to domain default
        const wbgtDomainConfig = getSpreadsheetConfig("wbgt");
        configForLoad = {
          ...groupConfig,
          spreadsheetId: groupConfig.wbgtSpreadsheetId || wbgtDomainConfig?.spreadsheetId || groupConfig.spreadsheetId,
        };
      } else if (isMachinesQuery) {
        // Machines queries use machinesSpreadsheetId, falling back to domain default
        const machinesDomainConfig = getSpreadsheetConfig("machines");
        configForLoad = {
          ...groupConfig,
          spreadsheetId:
            groupConfig.machinesSpreadsheetId || machinesDomainConfig?.spreadsheetId || groupConfig.spreadsheetId,
        };
      } else if (isRigQuery) {
        // Rig queries use rigSpreadsheetId, falling back to domain default
        const rigDomainConfig = getSpreadsheetConfig("rig");
        configForLoad = {
          ...groupConfig,
          spreadsheetId: groupConfig.rigSpreadsheetId || rigDomainConfig?.spreadsheetId || groupConfig.spreadsheetId,
        };
      } else if (isDailyMessageQuery) {
        // Daily message queries use dailyMessageSpreadsheetId, falling back to domain default
        const dailyMsgDomainConfig = getSpreadsheetConfig("dailyMessage");
        configForLoad = {
          ...groupConfig,
          spreadsheetId:
            groupConfig.dailyMessageSpreadsheetId || dailyMsgDomainConfig?.spreadsheetId || groupConfig.spreadsheetId,
        };
      } else if (isDoInfoQuery) {
        // DO Info queries use doInformationSpreadsheetId, falling back to domain default
        const doInfoDomainConfig = getSpreadsheetConfig("doInfo");
        configForLoad = {
          ...groupConfig,
          spreadsheetId:
            groupConfig.doInformationSpreadsheetId || doInfoDomainConfig?.spreadsheetId || groupConfig.spreadsheetId,
        };
      } else if (isSafetyQuery) {
        // Safety queries use safetySpreadsheetId, falling back to domain default
        const safetyDomainConfig = getSpreadsheetConfig("safety");
        configForLoad = {
          ...groupConfig,
          spreadsheetId:
            groupConfig.safetySpreadsheetId || safetyDomainConfig?.spreadsheetId || groupConfig.spreadsheetId,
        };
      } else if (isPilingProgressQuery) {
        // Piling progress queries use pilingProgressSpreadsheetId
        const pilingProgressDomainConfig = getSpreadsheetConfig("pilingProgress");
        configForLoad = {
          ...groupConfig,
          spreadsheetId:
            groupConfig.pilingProgressSpreadsheetId ||
            pilingProgressDomainConfig?.spreadsheetId ||
            groupConfig.spreadsheetId,
        };
      } else if (isSoilDisposalQuery) {
        // Soil disposal queries use soilDisposalSpreadsheetId
        const soilDomainConfig = getSpreadsheetConfig("soilDisposal");
        configForLoad = {
          ...groupConfig,
          spreadsheetId:
            groupConfig.soilDisposalSpreadsheetId || soilDomainConfig?.spreadsheetId || groupConfig.spreadsheetId,
        };
      } else if (isIMProgressQuery) {
        // IM progress queries use imProgressSpreadsheetId
        const imProgressDomainConfig = getSpreadsheetConfig("imProgress");
        configForLoad = {
          ...groupConfig,
          spreadsheetId:
            groupConfig.imProgressSpreadsheetId || imProgressDomainConfig?.spreadsheetId || groupConfig.spreadsheetId,
        };
      } else if (isPileCapQuery) {
        // Pile cap queries use manpower spreadsheet (CJ Tracking tab)
        const pileCapDomainConfig = getSpreadsheetConfig("pileCap");
        configForLoad = {
          ...groupConfig,
          spreadsheetId:
            groupConfig.pileCapSpreadsheetId || pileCapDomainConfig?.spreadsheetId || groupConfig.spreadsheetId,
        };
      }
    }

    // SOIL DISPOSAL: Multi-sheet loading — daily date sheets merged into one dataset
    if (isSoilDisposalQuery && !targetSheet) {
      const spreadsheetId = configForLoad?.spreadsheetId;
      if (!spreadsheetId) {
        throw new Error("No spreadsheetId for soil disposal query");
      }

      const allSheetNames = await getSheetNames(spreadsheetId);
      // Filter for date-formatted sheets (DD-MMM-YYYY), skip "Template" and other non-date sheets
      const dateSheetPattern = /^\d{1,2}-[A-Z][a-z]{2}-\d{4}$/;
      const dateSheets = allSheetNames.filter((name) => dateSheetPattern.test(name));
      console.log(`[SOIL DISPOSAL QA] Found ${dateSheets.length} date sheets: ${dateSheets.join(", ")}`);

      if (dateSheets.length === 0) {
        console.log("[SOIL DISPOSAL QA] No date sheets found");
        return [];
      }

      // Load all date sheets and merge with a virtual Date column.
      //
      // ⚠️ Schema-heterogeneity guard: different sheets may have different column
      // counts (e.g., older sheets have 7 columns S/N..MessageID; newer sheets
      // added a "Source" column at index 7). To be safe across both old and new
      // data, we use the WIDEST header row across all sheets as the canonical
      // schema, then pad shorter rows with empty strings and slice longer rows.
      // The virtual "Date" column is ALWAYS appended last so the SQL filter
      // `WHERE [Date] = ...` works reliably regardless of sheet schema.
      const loadedSheets = []; // [{ sheetName, headers, rows, dateIso }]

      for (const sheetName of dateSheets) {
        try {
          const sheetData = await loadData(sheetName, configForLoad);
          if (!sheetData || sheetData.length < 2) continue;
          loadedSheets.push({
            sheetName,
            headers: sheetData[0],
            rows: sheetData.slice(1),
            dateIso: normalizeDateString(sheetName),
          });
        } catch (err) {
          console.warn(`[SOIL DISPOSAL QA] Failed to load sheet "${sheetName}": ${err.message}`);
        }
      }

      // Pick the widest header set (preserves the Source/DumpingGround columns
      // when present). Tie-breaker: when two sheets have the same number of
      // headers, prefer the one whose headers explicitly include the newer
      // columns (DumpingGround). This matters during the deploy-day window
      // when some sheets predate the column and others have it.
      // We always append two virtual columns: [Date] (from sheet name) and
      // [Subcon] (derived from [Source] via getSoilDisposalSubcon). [Subcon]
      // is the canonical filter/group key for the QA agent — KTC vs KKL.
      let mergedHeaders = null;
      const mergedRows = [];

      if (loadedSheets.length > 0) {
        // Pick the sheet with the most-complete header. Tie-break by preferring
        // headers that include "DumpingGround" (matters during the deploy-day
        // window when some sheets predate the column).
        const widest = loadedSheets.reduce((best, s) => {
          if (s.headers.length > best.headers.length) return s;
          if (
            s.headers.length === best.headers.length &&
            s.headers.includes("DumpingGround") &&
            !best.headers.includes("DumpingGround")
          ) {
            return s;
          }
          return best;
        }, loadedSheets[0]);
        const baseColumnCount = widest.headers.length;
        const sourceIdx = widest.headers.indexOf("Source");

        // Legacy-data guard: if NONE of the loaded sheets have DumpingGround
        // (e.g. range contains only pre-2026-05-06 sheets), the merged schema
        // would miss the column and AlaSQL queries on `[DumpingGround]` would
        // error. Synthesize it at the canonical position right after Source —
        // legacy rows get "" for that cell.
        const dgPresent = widest.headers.includes("DumpingGround");
        const dgInsertAt = dgPresent ? -1 : sourceIdx >= 0 ? sourceIdx + 1 : widest.headers.length;
        const baseHeaders = dgPresent
          ? widest.headers
          : [...widest.headers.slice(0, dgInsertAt), "DumpingGround", ...widest.headers.slice(dgInsertAt)];
        mergedHeaders = [...baseHeaders, "Date", "Subcon"];

        for (const { rows, dateIso } of loadedSheets) {
          for (const raw of rows) {
            const arr = raw || [];
            const normalized = arr.slice(0, baseColumnCount);
            while (normalized.length < baseColumnCount) normalized.push("");
            const sourceValue = sourceIdx >= 0 ? normalized[sourceIdx] : "";
            const subcon = getSoilDisposalSubcon(sourceValue);
            const aligned = dgPresent
              ? normalized
              : [...normalized.slice(0, dgInsertAt), "", ...normalized.slice(dgInsertAt)];
            mergedRows.push([...aligned, dateIso, subcon]);
          }
        }
      }

      if (!mergedHeaders || mergedRows.length === 0) {
        console.log("[SOIL DISPOSAL QA] No data found across date sheets");
        return [];
      }

      // Reconstruct as a standard data array (headers + rows) and continue normal flow
      const data = [mergedHeaders, ...mergedRows];
      console.log(`[SOIL DISPOSAL QA] Merged ${mergedRows.length} rows from ${dateSheets.length} sheets`);

      // Process the merged data through the normal formatting pipeline
      const headers = data[0];
      const formattedData = data.slice(1).map((row, rowIdx) => {
        const obj = {};
        headers.forEach((header, index) => {
          if (header === "Date") {
            obj[header] = normalizeDateString(row[index]);
          } else if (header === "Volume") {
            let value = row[index];
            if (value === null || value === undefined) value = "";
            if (typeof value === "string" && value.trim()) {
              const numericValue = evaluateExcelFormula(value);
              obj[header] = numericValue !== null ? numericValue : 0;
            } else if (typeof value === "number") {
              obj[header] = value;
            } else {
              obj[header] = 0;
            }
          } else {
            let value = row[index];
            if (value === null || value === undefined) value = "";
            if (typeof value === "string" && value.trim() === "") value = "";
            obj[header] = value;
          }
        });
        obj.RowNumber = rowIdx + 2;
        return obj;
      });

      const tableName = "soilDisposalData";
      try {
        alasql(`DROP TABLE IF EXISTS ${tableName}`);
        alasql(`CREATE TABLE ${tableName}`);
        alasql.tables[tableName].data = formattedData;
        // Force AlaSQL to recognize columns
        if (formattedData.length > 0) {
          const testQuery = `SELECT ${headers.map((h) => `[${h}]`).join(", ")} FROM ${tableName} WHERE 1=0`;
          alasql(testQuery);
        }
        const result = alasql(query);
        console.log(`Query executed successfully: ${query}`);
        return result;
      } catch (alasqlError) {
        console.error(`AlaSQL error: ${alasqlError.message}`);
        return { error: `SQL execution error: ${alasqlError.message}` };
      }
    }

    // SAFETY: Multi-sheet loading — current "Safety" + monthly archives ("Safety-MMM YYYY")
    // merged into ONE dataset so every safety read spans history. Each merged row carries its
    // source tab (__SourceSheet__) + per-tab RowNumber so the write path can target the right
    // tab. Process-level TTL cache keeps the consistency-test burst byte-identical. Only runs
    // when no explicit sheetName (the edit/delete find loop passes one to cap its search).
    if (isSafetyQuery && !targetSheet) {
      const spreadsheetId = configForLoad?.spreadsheetId;
      if (!spreadsheetId) throw new Error("No spreadsheetId for safety query");

      let formattedData = null;
      const cached = SAFETY_SHEET_CACHE.get(spreadsheetId);
      if (
        cached &&
        Date.now() - cached.t <= SAFETY_CACHE_TTL_MS &&
        Array.isArray(cached.rows) &&
        cached.rows.length > 0
      ) {
        formattedData = cached.rows;
        console.log(`[SAFETY QA] cache hit ${formattedData.length} rows`);
      } else {
        const tabs = await discoverSafetyTabs(spreadsheetId);
        console.log(`[SAFETY QA] Found ${tabs.length} safety tabs: ${tabs.join(", ")}`);
        formattedData = [];
        for (const tab of tabs) {
          try {
            const tabData = await loadData(tab, configForLoad);
            if (!tabData || tabData.length < 2) continue;
            const tabRows = formatSheetRows(tabData, { isPileCapQuery: false });
            for (const r of tabRows) {
              r.__SourceSheet__ = tab;
              formattedData.push(r);
            }
          } catch (err) {
            console.warn(`[SAFETY QA] Failed to load safety tab "${tab}": ${err?.message || err}`);
          }
        }
        if (formattedData.length > 0) SAFETY_SHEET_CACHE.set(spreadsheetId, { t: Date.now(), rows: formattedData });
        console.log(`[SAFETY QA] Merged ${formattedData.length} rows from ${tabs.length} tabs`);
      }

      if (!formattedData || formattedData.length === 0) return [];

      const tableName = "safetyData";
      try {
        alasql(`DROP TABLE IF EXISTS ${tableName}`);
        alasql(`CREATE TABLE ${tableName}`);
        alasql.tables[tableName].data = formattedData;
        const allColumns = Object.keys(formattedData[0]);
        alasql(`SELECT ${allColumns.map((c) => `[${c}]`).join(", ")} FROM ${tableName} LIMIT 1`);
        const result = alasql(query);
        console.log(`Query executed successfully (safety multi-tab): ${query}`);
        return result;
      } catch (alasqlError) {
        console.error(`AlaSQL error (safety merge): ${alasqlError.message}`);
        return { error: `SQL execution error: ${alasqlError.message}` };
      }
    }

    const data = await loadData(targetSheet, configForLoad);
    console.log(`Loaded ${targetSheet} `); //and ${data}``)

    if (!data || !data.length) {
      console.log("No data available for query");
      return [];
    }

    const headers = data[0];

    const formattedData = data.slice(1).map((row, rowIdx) => {
      const obj = {};
      headers.forEach((header, index) => {
        if (header === "Date") {
          obj[header] = normalizeDateString(row[index]);
        } else if (header === "Timestamp" && isPileCapQuery) {
          // Convert Timestamp serial to readable string for pile_cap queries
          // Google Sheets stores dates as serial numbers (days since 1899-12-30)
          const rawTs = row[index];
          if (rawTs && typeof rawTs === "number") {
            const epoch = new Date(Date.UTC(1899, 11, 30));
            const msPerDay = 24 * 60 * 60 * 1000;
            const dt = new Date(epoch.getTime() + rawTs * msPerDay);
            const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
            const dd = String(dt.getUTCDate()).padStart(2, "0");
            const mmm = months[dt.getUTCMonth()];
            const yyyy = dt.getUTCFullYear();
            const hh = String(dt.getUTCHours()).padStart(2, "0");
            const mm = String(dt.getUTCMinutes()).padStart(2, "0");
            obj[header] = `${dd}-${mmm}-${yyyy} ${hh}:${mm}`;
          } else {
            // Already a string (e.g., "'08-Apr-2026 17:39") — strip leading quote
            obj[header] = String(rawTs || "").replace(/^'/, "");
          }
        } else if (DATE_COLUMNS.includes(header)) {
          // ENHANCED: Handle mixed input types (Excel serial numbers + strings)
          const rawValue = row[index];

          // Display column: Always readable string (convert Excel serial → string if needed)
          obj[header] = normalizeDateForDisplay(rawValue);

          // Sort column: Always Excel serial number (convert string → serial if needed)
          obj[header + "_sort"] = normalizeDateForSort(rawValue);
        } else if (header === "Volume") {
          // Special handling for Volume column - evaluate Excel formulas to numeric values
          let value = row[index];
          // Convert null/undefined to empty string to avoid SQL issues
          if (value === null || value === undefined) {
            value = "";
          }

          // If it's a formula string, try to evaluate it to a number
          if (typeof value === "string" && value.trim()) {
            const numericValue = evaluateExcelFormula(value);
            if (numericValue !== null) {
              obj[header] = numericValue; // Store as numeric value for SQL SUM operations
            } else {
              obj[header] = 0; // Default to 0 for invalid/empty volumes to allow SUM operations
            }
          } else {
            obj[header] = 0; // Default to 0 for empty values
          }
        } else {
          // Ensure all values are properly typed for SQL operations
          let value = row[index];
          // Convert null/undefined to empty string to avoid SQL issues
          if (value === null || value === undefined) {
            value = "";
          }
          // Ensure numeric values that look like strings are properly handled
          if (typeof value === "string" && value.trim() === "") {
            value = "";
          }
          obj[header] = value;
        }
      });

      // Preserve the original sheet row number (1-based, including header)
      obj.RowNumber = rowIdx + 2;
      return obj;
    });

    // Get table name from options or determine from query type
    const tableName =
      options.tableName ||
      (isSafetyQuery
        ? "safetyData"
        : isManpowerQuery
          ? "manpowerData"
          : isPilingData
            ? "pilingData"
            : isWbgtQuery
              ? "wbgtData"
              : isDoInfoQuery
                ? "doInfoData"
                : isMachinesQuery
                  ? "machinesData"
                  : isRigQuery
                    ? "rigData"
                    : isDailyMessageQuery
                      ? "dailyMessageData"
                      : isDocumentQuery
                        ? "documentData"
                        : isSoilDisposalQuery
                          ? "soilDisposalData"
                          : isPilingProgressQuery
                            ? "pilingProgressData"
                            : isIMProgressQuery
                              ? "imProgressData"
                              : isPileCapQuery
                                ? "pileCapData"
                                : "genericData"); // fallback

    // Create and populate table with error handling
    try {
      // Drop and recreate table to ensure proper column structure
      alasql(`DROP TABLE IF EXISTS ${tableName}`);
      alasql(`CREATE TABLE ${tableName}`);

      // Use direct data assignment but ensure table recognizes all columns
      if (formattedData.length > 0) {
        // Insert data rows one by one to ensure all columns are recognized
        alasql.tables[tableName].data = formattedData;

        // Force AlaSQL to recognize all columns by running a test query
        const firstRow = formattedData[0];
        const allColumns = Object.keys(firstRow);
        const testQuery = `SELECT ${allColumns.map((col) => `[${col}]`).join(", ")} FROM ${tableName} LIMIT 1`;
        alasql(testQuery); // This will force column recognition
      }
    } catch (tableError) {
      console.error("Error setting up table:", tableError);
      return { error: `Table setup failed: ${tableError.message}` };
    }

    // Execute query with enhanced error handling
    try {
      const result = alasql(query);
      console.log(`Query executed successfully: ${query}`);
      return result;
    } catch (queryError) {
      console.error("Error executing SQL query:", queryError);
      // Provide more specific error messages
      if (queryError.message && queryError.message.includes("substr")) {
        return { error: "Date conversion error - check date format and use LIKE operations instead of CAST" };
      }
      return { error: `Query execution failed: ${queryError.message}` };
    }
  } catch (error) {
    console.error("Error executing SQL query:", error);
    return { error: error.message };
  }
}

async function writeStructuredData(data, senderDetails, groupConfig = null) {
  if (!data || !data.length) return 0;

  const targetSpreadsheetId = groupConfig?.spreadsheetId;
  if (!targetSpreadsheetId) {
    console.log("No spreadsheetId available in groupConfig, skipping write to Google Sheets");
    return 0;
  }

  const actualDate = getFormattedToday();
  const existingData = await loadData(sheetName, groupConfig);
  const highestSerialNumber = existingData ? existingData.length : 1;
  let nextSerialNumber = highestSerialNumber;

  const allRowData = data.map((update) => [
    nextSerialNumber++, // Assign and increment serial number
    actualDate,
    ...Object.values(update),
    senderDetails ? JSON.stringify(senderDetails) : "",
    new Date().toISOString(),
  ]);

  await writeArrayToGSheetRow(targetSpreadsheetId, sheetName, allRowData);
  return allRowData.length;
}

async function updateStructuredData(data, senderDetails, groupConfig = null) {
  try {
    // Prefer an explicit per-call sheet (the close flow passes the issue's source tab — current
    // OR previous-month archive); otherwise the group default / "Safety".
    const targetSheetName = data?.sheetName || groupConfig?.safetySheetName || sheetName;

    // Load data using the appropriate sheet name and group config
    const sheetData = await loadData(targetSheetName, groupConfig);
    if (!sheetData || sheetData.length <= 1) {
      console.log(`No data available for update in sheet ${targetSheetName}`);
      return null;
    }

    let rowIndex = data.rowIndex;

    console.log(`Updating row number ${rowIndex} in sheet ${targetSheetName}`);

    if (rowIndex === undefined && data.issueId) {
      for (let i = 1; i < sheetData.length; i++) {
        if (sheetData[i][0] === data.issueId.toString()) {
          rowIndex = i;
          break;
        }
      }
    }

    if (rowIndex === undefined) {
      console.log(`Could not find row with S/N ${data.issueId} to update in ${targetSheetName}`);
      return null;
    }

    const updateData = [];

    updateData.push([rowIndex + 1, 8, data.status]); // +1 for header row, 8 for column I (0-indexed)

    if (data.mediaUrl) {
      updateData.push([rowIndex + 1, 11, data.mediaUrl]); // 11 for column L
    } else {
      updateData.push([rowIndex + 1, 11, "no image provided"]);
    }

    updateData.push([rowIndex + 1, 12, data.timestamp]); // 12 for column M
    updateData.push([rowIndex + 1, 13, JSON.stringify(senderDetails)]); // 13 for column N

    // Use group-specific spreadsheet ID - required
    const targetSpreadsheetId = groupConfig?.spreadsheetId;

    if (targetSpreadsheetId) {
      for (const [row, col, value] of updateData) {
        await updateCell(targetSpreadsheetId, targetSheetName, row, col, value);
      }
      console.log(`Successfully updated row ${rowIndex + 1} in sheet ${targetSheetName}`);
      return rowIndex + 1;
    } else {
      console.log("No spreadsheetId available, skipping update to Google Sheets");
      return null;
    }
  } catch (error) {
    console.error("Error in updateExistingRow:", error);
    return null;
  }
}

function getFormattedToday() {
  const today = new Date();
  // Example: "14-May"
  const day = today.getDate();
  const month = today.toLocaleString("en-US", { month: "short" });
  return `${day}-${month}`;
}

function normalizeDateString(dateStr) {
  if (!dateStr) return "";
  let parsed;
  // Primary format: DD-MMM-YYYY (e.g., "08-Oct-2025", "8-Sep-2025")
  parsed = parse(dateStr, "dd-MMM-yyyy", new Date());
  if (!isNaN(parsed)) return format(parsed, "yyyy-MM-dd");
  parsed = parse(dateStr, "d-MMM-yyyy", new Date());
  if (!isNaN(parsed)) return format(parsed, "yyyy-MM-dd");
  // 2-digit year format (e.g., "08-Oct-25")
  parsed = parse(dateStr, "dd-MMM-yy", new Date());
  if (!isNaN(parsed)) return format(parsed, "yyyy-MM-dd");
  parsed = parse(dateStr, "d-MMM-yy", new Date());
  if (!isNaN(parsed)) return format(parsed, "yyyy-MM-dd");
  // Legacy: Full month name formats (e.g., "08-October-2025")
  parsed = parse(dateStr, "d-MMMM-yyyy", new Date());
  if (!isNaN(parsed)) return format(parsed, "yyyy-MM-dd");
  parsed = parse(dateStr, "dd-MMMM-yyyy", new Date());
  if (!isNaN(parsed)) return format(parsed, "yyyy-MM-dd");
  // ISO format
  parsed = parse(dateStr, "yyyy-MM-dd", new Date());
  if (!isNaN(parsed)) return format(parsed, "yyyy-MM-dd");
  // Fallback: return original
  return dateStr;
}

/**
 * Retrieves an image from Supabase storage with retry mechanism
 * @param {string} whatsappGroupId - The WhatsApp group ID used as the folder name
 * @param {string} mediaFilename - Optional specific filename to retrieve
 * @returns {Promise<string>} - A signed URL for the image
 */
async function retrieveImageFromSupabase(whatsappGroupId, mediaFilename = null, expiresInSeconds = 3600000) {
  const maxRetries = 3;
  const baseDelay = 1000; // 1 second

  /**
   * Check if error is retryable (includes network, auth, and service issues)
   * @param {Error} error - The error to check
   * @returns {boolean} - Whether the error is retryable
   */
  const isRetryableError = (error) => {
    const errorMessage = error.message?.toLowerCase() || "";
    const errorStatus = error.status || error.statusCode;

    // Check for specific StorageUnknownError conditions
    const isStorageError = error.__isStorageError || false;
    const hasJsonParseError =
      errorMessage.includes("unexpected token") ||
      errorMessage.includes("not valid json") ||
      errorMessage.includes("<html>");

    // Retry on transient/server errors:
    return (
      errorStatus === 400 || // Bad request (non-404)
      errorStatus === 429 || // Rate limit
      errorStatus === 500 || // Internal server error
      errorStatus === 502 || // Bad gateway
      errorStatus === 503 || // Service unavailable
      errorStatus === 504 || // Gateway timeout
      errorMessage.includes("not found") ||
      errorMessage.includes("does not exist") ||
      errorMessage.includes("no signed url") ||
      errorMessage.includes("no images found") ||
      errorMessage.includes("timeout") ||
      errorMessage.includes("network") ||
      errorMessage.includes("connection") ||
      (isStorageError && hasJsonParseError) // Supabase returning HTML instead of JSON
    );
  };

  /**
   * Sleep for specified milliseconds
   * @param {number} ms - Milliseconds to sleep
   */
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * Core logic for retrieving image from Supabase
   */
  const retrieveImageCore = async () => {
    const bucketName = whatsappGroupId;

    console.log(`bucketName: `, bucketName);

    if (mediaFilename) {
      // If mediaFilename is provided, use it to create a signed URL
      // Use a shorter expiry time (1 hour = 3600000ms) to reduce URL size
      const { data, error } = await getSupabaseClient()
        .storage.from(bucketName)
        .createSignedUrl(mediaFilename, expiresInSeconds);

      if (error) {
        console.error("Error creating signed URL:", error);
        // Provide more specific error message for common issues
        if (error.__isStorageError && error.message?.includes("not valid JSON")) {
          throw new Error(
            `Supabase authentication or service error (HTML response received instead of JSON). Please check service status and credentials.`,
          );
        }
        throw new Error(`Error retrieving image: ${error.message}`);
      }

      if (!data || !data.signedUrl) {
        throw new Error("No signed URL returned from Supabase");
      }

      console.log(`Successfully retrieved image URL for ${mediaFilename}`);
      return data.signedUrl;
    } else {
      // Fallback to the original method if mediaFilename is not provided
      const folderPath = "";

      // List all files in the folder
      const { data: files, error: listError } = await getSupabaseClient()
        .storage.from(bucketName)
        .list(folderPath, { limit: 5, sortBy: { column: "created_at", order: "desc" } });

      if (listError) {
        console.error("Error listing files:", listError);
        throw new Error(`Error listing images: ${listError.message}`);
      }

      if (!files || files.length === 0) {
        throw new Error("No images found in the folder");
      }

      // Sort files by created_at descending (latest first)
      const sortedFiles = files
        .filter((file) => file.metadata && file.metadata.mimetype && file.metadata.mimetype.startsWith("image/"))
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

      const latestFile = sortedFiles[0];

      if (!latestFile) {
        throw new Error("No image files found in the folder");
      }

      const filePath = latestFile.name;

      // Create a signed URL for the latest image
      const { data, error } = await getSupabaseClient()
        .storage.from(bucketName)
        .createSignedUrl(filePath, expiresInSeconds);

      if (error) {
        console.error("Error creating signed URL:", error);
        // Provide more specific error message for common issues
        if (error.__isStorageError && error.message?.includes("not valid JSON")) {
          throw new Error(
            `Supabase authentication or service error (HTML response received instead of JSON). Please check service status and credentials.`,
          );
        }
        throw new Error(`Error retrieving image: ${error.message}`);
      }

      if (!data || !data.signedUrl) {
        throw new Error("No signed URL returned from Supabase");
      }

      console.log(`Successfully retrieved latest image URL for ${filePath}`);
      return data.signedUrl;
    }
  };

  // Retry mechanism with exponential backoff
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await retrieveImageCore();
    } catch (error) {
      lastError = error;

      // If this is the last attempt or error is not retryable, throw the error
      if (attempt === maxRetries || !isRetryableError(error)) {
        console.error(`Error in retrieveImageFromSupabase (attempt ${attempt + 1}/${maxRetries + 1}):`, error);
        // Add specific guidance for HTML/JSON parsing errors
        if (error.__isStorageError && error.message?.includes("not valid JSON")) {
          console.error(
            "💡 This error typically indicates Supabase authentication issues or service unavailability. Check your credentials and service status.",
          );
        }
        throw error;
      }

      // Calculate exponential backoff delay: baseDelay * 2^attempt
      const delay = baseDelay * Math.pow(2, attempt);
      const errorType = error.__isStorageError ? "StorageError" : "Generic";
      console.warn(
        `⚠️ [SUPABASE RETRY ${attempt + 1}/${maxRetries + 1}] ${errorType} failed, retrying in ${delay}ms:`,
        error.message,
      );

      await sleep(delay);
    }
  }

  // This should never be reached, but just in case
  throw lastError;
}

/**
 * Writes inventory data to Google Sheets using the generic data writing function
 * @param {Object} inventoryData - The inventory data object with materials, fittings, and equipment arrays
 * @param {string} date - Date string (will be normalized)
 * @param {object} senderDetails - Details about the message sender
 * @returns {Promise<number>} - Number of rows written
 */
async function writeInventoryData(inventoryData, date, senderDetails) {
  if (
    !inventoryData ||
    (!inventoryData.materials?.length && !inventoryData.fittings?.length && !inventoryData.equipment?.length)
  )
    return 0;

  console.log(inventoryData);

  const flattenedData = flattenData(inventoryData, {
    arrayFields: ["materials", "fittings", "equipment"],
    itemTransform: (item, category) => {
      const categoryName = category ? category.charAt(0).toUpperCase() + category.slice(1, -1) : "";

      return {
        name: item.name || "",
        quantity: item.quantity || "",
        unit: item.unit || "",
        description: item.description || "",
        category: categoryName,
      };
    },
  });

  console.log(flattenedData);

  return await writeGenericData(flattenedData, inventorySheetName, date, senderDetails);
}

/**
 * Writes progress data to the Daily Update tab with dates as rows and pile sizes as columns
 * @param {Array} progressItems - Array of progress items
 * @param {string} date - Date string
 * @param {object} senderDetails - Details about the message sender
 * @returns {Promise<number>} - Number of rows written (0 or 1)
 */
async function writeDailyProgressUpdate(progressItems, date, senderDetails, groupConfig = null) {
  if (!progressItems) return 0;

  // Use domain-specific spreadsheet ID for Daily Message
  const targetSpreadsheetId = groupConfig?.dailyMessageSpreadsheetId || groupConfig?.spreadsheetId;
  if (!targetSpreadsheetId) {
    console.log("No spreadsheetId available in groupConfig for writeDailyProgressUpdate");
    return 0;
  }

  const actualDate = date && date.toLowerCase() === "today" ? getFormattedToday() : date;

  // Define default headers for the Daily Update sheet
  const defaultHeaders = [];

  // Try to load headers from the sheet, otherwise use defaults
  let headers = defaultHeaders;
  try {
    const sheetData = await loadData(dailyUpdateSheetName, groupConfig);
    if (sheetData && sheetData.length > 0) {
      headers = sheetData[0];
    }
  } catch (error) {
    console.error("Error reading Daily Update sheet headers, using defaults:", error);
  }

  // Build the row for the Daily Update sheet
  const row = [actualDate];
  for (let i = 1; i < headers.length - 2; i++) {
    const header = headers[i];
    row.push(progressItems[header] || "");
  }
  row.push(senderDetails ? JSON.stringify(senderDetails) : "");
  row.push(new Date().toISOString());

  await writeArrayToGSheetRow(targetSpreadsheetId, dailyUpdateSheetName, [row]);
  return 1;
}

/**
 * Generic function to write data to Google Sheets
 * @param {Array} dataItems - Array of data items to write
 * @param {string} sheetName - Name of the sheet to write to
 * @param {string} date - Date string (will be normalized)
 * @param {object} senderDetails - Details about the message sender
 * @param {object} options - Additional options
 * @param {boolean} options.includeSerialNumber - Whether to include a serial number column
 * @param {Array} options.prependFields - Fields to prepend before the data items
 * @returns {Promise<number>} - Number of rows written
 */
async function writeGenericData(dataItems, sheetName, date, senderDetails, options = {}) {
  if (!dataItems || !dataItems.length) return 0;

  const actualDate = date && date.toLowerCase() === "today" ? getFormattedToday() : normalizeDateString(date);

  const {
    includeSerialNumber = false,
    prependFields = [],
    appendFields = [],
    spreadsheetId: customSpreadsheetId,
  } = options;

  const targetSpreadsheetId = customSpreadsheetId;

  if (!targetSpreadsheetId) {
    console.error("writeGenericData: No spreadsheetId provided in options");
    return 0;
  }

  let nextSerialNumber = 1; // Default to 1 if no existing data

  if (includeSerialNumber) {
    // Use atomic serial number generation from Supabase
    nextSerialNumber = await getNextSerialNumber(sheetName, targetSpreadsheetId);
    console.log(`Got atomic S/N for ${sheetName}: ${nextSerialNumber}`);
  }

  const allRowData = dataItems.map((item, index) => {
    const row = [];

    if (includeSerialNumber) {
      row.push(nextSerialNumber++);
    }

    // row.push(actualDate);

    if (typeof prependFields === "function") {
      row.push(...prependFields(index));
    } else if (Array.isArray(prependFields)) {
      row.push(...prependFields);
    }

    row.push(...Object.values(item));

    row.push(senderDetails ? JSON.stringify(senderDetails) : "");

    // Get the original timestamp from senderDetails if available, otherwise use current time
    let rawTimestamp = senderDetails && senderDetails.timestamp ? senderDetails.timestamp : new Date().toISOString();

    // Ensure timestamp is in proper format - check for Unix timestamp
    let processedTimestamp;
    try {
      // IMPORTANT: First check if it looks like a Unix timestamp (seconds since epoch)
      // This needs to come before the Date constructor test because JS will interpret
      // numeric timestamps directly as milliseconds since epoch
      if (typeof rawTimestamp === "number" || (typeof rawTimestamp === "string" && /^\d{10,13}$/.test(rawTimestamp))) {
        // Convert to number if it's a string
        const unixTimestamp = typeof rawTimestamp === "number" ? rawTimestamp : parseInt(rawTimestamp, 10);

        // Unix timestamps are typically 10 digits for seconds
        const milliseconds = unixTimestamp < 10000000000 ? unixTimestamp * 1000 : unixTimestamp;
        const convertedDate = new Date(milliseconds);

        if (!isNaN(convertedDate.getTime())) {
          processedTimestamp = convertedDate.toISOString();
          console.log(`Converted Unix timestamp ${rawTimestamp} to ISO ${processedTimestamp}`);
        } else {
          console.error("Failed to convert Unix timestamp:", rawTimestamp);
          processedTimestamp = new Date().toISOString(); // Fallback
        }
      } else {
        // Test if it's a valid ISO string or similar date format
        const testDate = new Date(rawTimestamp);
        if (!isNaN(testDate.getTime())) {
          // It's already a valid date string
          processedTimestamp = testDate.toISOString();
        } else {
          // If both conversion attempts failed
          console.error("Invalid timestamp format:", rawTimestamp);
          processedTimestamp = new Date().toISOString(); // Fallback
        }
      }
    } catch (error) {
      console.error("Error processing timestamp:", error);
      processedTimestamp = new Date().toISOString(); // Fallback to current time
    }

    // Format the timestamp to be human-readable for Google Sheets
    // Use ISO string timestamp to ensure proper date handling
    // Google Sheets may convert some date formats to Excel serial numbers

    // Make sure we're sending Singapore timezone timestamp format to prevent conversion to Excel serial date
    // And quote the string to ensure it's treated as a string, not a date value

    // Format the timestamp for Singapore timezone with human-readable format
    const sgTime = convertToSingaporeTime(processedTimestamp, { format: "human" });

    // Add the formatted timestamp to the row
    row.push(`'${sgTime}'`); // Use Singapore time with proper formatting

    // Append any extra fields after timestamp
    if (Array.isArray(appendFields) && appendFields.length > 0) {
      row.push(...appendFields);
    }

    return row;
  });

  if (targetSpreadsheetId) {
    console.log(`Writing to spreadsheet: ${targetSpreadsheetId}, sheet: ${sheetName}`);
    await writeArrayToGSheetRow(targetSpreadsheetId, sheetName, allRowData);
    return allRowData.length;
  } else {
    console.log("No spreadsheetId available, skipping write to Google Sheets");
    return 0;
  }
}

/**
 * Flattens nested data structures into an array of objects suitable for Google Sheets
 * @param {Object} data - The data object to flatten
 * @param {Object} options - Options for flattening
 * @param {Array} options.arrayFields - Fields that contain arrays to be flattened
 * @param {Object} options.baseFields - Fields to include in each flattened item
 * @param {Function} options.itemTransform - Function to transform each item
 * @returns {Array} - Flattened array of objects
 */
function flattenData(data, options = {}) {
  const { arrayFields = [], baseFields = {}, itemTransform = (item) => item } = options;

  if (Array.isArray(data)) {
    return data.map((item) => {
      const transformedItem = itemTransform(item);
      return {
        ...baseFields,
        ...transformedItem,
      };
    });
  }

  // Extract base fields from the data object if not provided
  const extractedBaseFields = { ...baseFields };
  Object.keys(data).forEach((key) => {
    if (!arrayFields.includes(key) && typeof data[key] !== "object") {
      extractedBaseFields[key] = data[key] || "";
    }
  });

  const flattened = [];
  arrayFields.forEach((field) => {
    if (data[field] && Array.isArray(data[field]) && data[field].length > 0) {
      data[field].forEach((item) => {
        const transformedItem = itemTransform(item, field);
        flattened.push({
          ...extractedBaseFields,
          category: field, // Include the category/field name
          ...transformedItem,
        });
      });
    }
  });

  return flattened.length > 0 ? flattened : [extractedBaseFields];
}

/**
 * Retrieve image from Supabase with duplicate messageId fallback.
 * When the exact mediaFilename doesn't exist in storage (UUID mismatch between
 * listener rows), looks up the same messageId in whatsapp_listener to find a
 * duplicate row with a different (correct) mediaFilename.
 *
 * @param {string} groupId - WhatsApp group ID (Supabase bucket name)
 * @param {string} mediaFilename - Original media filename from webhook
 * @param {string} messageId - WhatsApp message ID for duplicate lookup
 * @returns {Promise<string>} - Signed image URL or empty string if all attempts fail
 */
async function retrieveImageWithFallback(groupId, mediaFilename, messageId) {
  /**
   * Check if an error is a "not found" type (file doesn't exist in bucket)
   * vs an infrastructure/auth error that should be rethrown
   */
  const isNotFoundError = (error) => {
    const msg = error.message?.toLowerCase() || "";
    return msg.includes("not found") || msg.includes("does not exist") || error.statusCode === "404";
  };

  // First attempt: exact filename
  try {
    return await retrieveImageFromSupabase(groupId, mediaFilename);
  } catch (imgError) {
    if (!isNotFoundError(imgError)) {
      // Auth, network, or infrastructure error — don't swallow, rethrow
      console.error(`[Image Fallback] Non-recoverable error for ${mediaFilename}: ${imgError.message}`);
      throw imgError;
    }
    console.log(`[Image Fallback] File not found: ${mediaFilename}, trying duplicate lookup`);
  }

  // Fallback: find duplicate row with same messageId but different mediaFilename
  if (messageId) {
    try {
      const { data: duplicates } = await getSupabaseClient()
        .from("whatsapp_listener")
        .select("mediaFilename")
        .eq("messageId", messageId)
        .neq("mediaFilename", mediaFilename)
        .not("mediaFilename", "is", null)
        .limit(5);

      if (duplicates && duplicates.length > 0) {
        for (const dup of duplicates) {
          try {
            console.log(`[Image Fallback] Trying duplicate: ${dup.mediaFilename}`);
            const url = await retrieveImageFromSupabase(groupId, dup.mediaFilename);
            if (url) {
              console.log(`[Image Fallback] Success via duplicate: ${dup.mediaFilename}`);
              return url;
            }
          } catch (dupErr) {
            if (!isNotFoundError(dupErr)) throw dupErr;
            console.log(`[Image Fallback] Duplicate not found: ${dup.mediaFilename}`);
          }
        }
      } else {
        console.log("[Image Fallback] No duplicates found in whatsapp_listener");
      }
    } catch (lookupErr) {
      // Rethrow non-lookup errors (e.g. auth failures from duplicate attempts)
      if (lookupErr.message && !lookupErr.message.includes("Duplicate lookup")) {
        throw lookupErr;
      }
      console.error("[Image Fallback] Duplicate lookup failed:", lookupErr.message);
    }
  }

  return "";
}

module.exports = {
  runSQLQuery,
  invalidateSafetyCache,
  writeStructuredData,
  loadData,
  retrieveImageFromSupabase,
  retrieveImageWithFallback,
  updateStructuredData,
  writeInventoryData,
  writeGenericData,
  flattenData,
  normalizeDateString,
  writeDailyProgressUpdate,
  getNextSerialNumber,
  updateCell: require("./gsheet").updateCell,
  writeArrayToGSheetRow: require("./gsheet").writeArrayToGSheetRow,
  // Enhanced date conversion functions for mixed format handling
  excelSerialToString,
  normalizeDateForDisplay,
  normalizeDateForSort,
  convertToISODateTime,
  isExcelSerial,
  isStringDate,
};
