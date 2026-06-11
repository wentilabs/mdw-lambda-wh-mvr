// Note: dotenv is loaded in index.js handler, secrets come from AWS Secrets Manager

const { getOpenAI } = require("../utils/openai");
const {
  writeGenericData,
  runSQLQuery,
  loadData,
  updateStructuredData,
  updateCell,
  invalidateSafetyCache,
} = require("../utils/action");
const {
  formatDateTimeForSheet,
  formatHumanReadableTimestamp,
  convertToSingaporeTime,
  checkIfNewMonth,
  formatSheetArchiveName,
} = require("../utils/date");
const {
  batchUpdateCells,
  renameSheet,
  readGoogleSheet,
  duplicateSheet,
  clearDataKeepHeaders,
  getSheetNames,
  createNewSheet,
  writeArrayToGSheetRow,
  setupHeaderRow,
  ensureHeaderRowSetup,
  deleteRow,
} = require("../utils/gsheet");
const { getSupabaseClient } = require("../utils/common");
const { resolvePicFromMentions, stripMentionIds, extractMentionIds } = require("../utils/name-list");
const { startPicEnrichment } = require("../utils/pic-enrichment");
const picEnrichAdapter = require("../utils/pic-enrichment-adapter-whmbs");
const { previousMonthSafetyTab } = require("../utils/safety-sheets");
const { sendWhatsAppReply, sendWhatsAppMessage } = require("../utils/sendMessage");
const { writeToMonthlyMonitoringSheet } = require("./wbgt-monthly-handlers");

// Import optimized prompts
const { safetyExtractionPrompt, validationPrompt } = require("./prompts/safety-prompts");

const metadata = {
  project: "wohhup",
  type: "safety",
};

const DEFAULT_SAFETY_SHEET_NAME = "Safety";

// ── Missing-PIC follow-up marker ──
// When a hazard is created without a resolvable PIC, the bot replies asking the reporter
// to tag the person, embedding "[ref: PIC-<originalMessageId>]" in that reply. On the
// reporter's follow-up reply, WhatsApp carries the bot's text verbatim in `quotedBody`, so
// we read the original message id back from there — stateless, no DB of outgoing ids. The
// distinct "PIC-" namespace never collides with the Novade-Preview "[ref:]" marker.
const PIC_REF_MARKER_RE = /\[ref:\s*PIC-([A-Za-z0-9_-]+)\s*\]/i;

/**
 * Extract the original safety message id from a "[ref: PIC-<messageId>]" marker.
 * Structured-token parse (not NLP). Returns null when no marker is present.
 * @param {string} text
 * @returns {string|null}
 */
function parsePicRef(text) {
  if (!text || typeof text !== "string") return null;
  const m = text.match(PIC_REF_MARKER_RE);
  return m ? m[1] : null;
}

/**
 * The bot's reply asking the reporter to tag the PIC. Ends with the [ref: PIC-<id>] marker
 * carrying the ORIGINAL message id so the follow-up reply can be traced back to the row.
 * @param {string} originalMessageId
 * @returns {string}
 */
function buildPicRequestMessage(originalMessageId) {
  return [
    "⚠️ Who will be in charge of this safety issue?",
    "",
    "Please *reply to this message* and *@mention* the person responsible for following up on it (you can tag more than one).",
    "",
    `[ref: PIC-${originalMessageId}]`,
  ].join("\n");
}

/**
 * Resolve a quotedMessageId to the album parent's messageId via whatsapp_listener.
 * When a user replies to the 2nd image of an album, quotedMessageId = MSG_B,
 * but the issue row was created by MSG_A. This finds MSG_B's parentMsgKey in the DB,
 * which is MSG_A — the actual messageId stored in the sheet's Sender column.
 * @param {string} quotedMessageId - The messageId being quoted
 * @param {string} chatId - WhatsApp group ID to scope the query
 * @returns {Promise<string|null>} - The album parent's messageId, or null if not an album child
 */
async function resolveAlbumParentMessageId(quotedMessageId, chatId) {
  if (!quotedMessageId || !chatId) return null;

  try {
    const { data, error } = await getSupabaseClient()
      .from("whatsapp_listener")
      .select("parentMsgKey")
      .eq("messageId", quotedMessageId)
      .eq("from", chatId)
      .not("parentMsgKey", "is", null)
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error("[Album Resolve] Error looking up parentMsgKey:", error.message);
      return null;
    }

    if (data?.parentMsgKey) {
      console.log(`[Album Resolve] quotedMessageId ${quotedMessageId} is album child → parent: ${data.parentMsgKey}`);
      return data.parentMsgKey;
    }

    return null;
  } catch (error) {
    console.error("[Album Resolve] Error:", error.message);
    return null;
  }
}

/**
 * Find an existing safety issue row by messageId or parent message identifiers stored in Sender JSON
 * @param {object} identifiers - Identifiers to search for
 * @param {string} [identifiers.messageId] - WhatsApp messageId
 * @param {string} [identifiers.parentMessageId] - Parent message identifier (album parent)
 * @param {object} groupConfig - Optional group configuration overrides
 * @returns {Promise<object|null>}
 */
async function findExistingSafetyIssueRow({ messageId, parentMessageId } = {}, groupConfig = null) {
  const hasMessageId = typeof messageId === "string" && messageId.trim().length > 0;
  const hasParentMessageId = typeof parentMessageId === "string" && parentMessageId.trim().length > 0;

  if (!hasMessageId && !hasParentMessageId) {
    return null;
  }

  try {
    const conditions = [];

    if (hasMessageId) {
      const sanitized = messageId.replace(/'/g, "''");
      conditions.push(`getMessageId(Sender) = '${sanitized}'`);
    }

    if (hasParentMessageId) {
      const sanitizedParent = parentMessageId.replace(/'/g, "''");
      conditions.push(`getParentMessageId(Sender) = '${sanitizedParent}'`);
    }

    const whereClause = conditions.length ? `WHERE (${conditions.join(" OR ")})` : "";
    const query = `SELECT TOP 1 RowNumber, [S/N], [Date], [Status], [Description], [Category], [Location], [Severity], [Proposed Fix], [Image], [Sender], [Created Timestamp]
      FROM safetyData
      ${whereClause}
      ORDER BY RowNumber DESC`;

    // Edit/delete/close of a WhatsApp safety message only looks back to the PREVIOUS month
    // (nobody edits a 2-month-old message). Search the current "Safety" tab first, then the
    // previous-month archive; return the first hit tagged with its source tab so the writeback
    // (updateSafetyIssueRow / handleDeletedSafetyMessage) targets the correct tab.
    for (const tab of safetyEditDeleteTabs(groupConfig)) {
      const existingRows = await runSQLQuery(query, "safety", { groupConfig, sheetName: tab });
      if (Array.isArray(existingRows) && existingRows.length > 0 && !existingRows.error) {
        return { ...existingRows[0], __SourceSheet__: tab };
      }
    }

    return null;
  } catch (error) {
    console.error("Error while finding existing safety issue row via SQL:", error);
    return null;
  }
}

// Tabs an edit/delete/close lookup may touch: the current month + the immediately-PREVIOUS
// month ONLY (older issues are intentionally out of scope per product decision). Returns
// [current] when there is no valid previous-month archive name.
function safetyEditDeleteTabs(groupConfig) {
  const current = groupConfig?.safetySheetName || DEFAULT_SAFETY_SHEET_NAME;
  const todayIso = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10); // SGT calendar date
  const prev = previousMonthSafetyTab(todayIso);
  return prev && prev !== current ? [current, prev] : [current];
}

/**
 * Format a sender timestamp into Singapore time string for Google Sheets storage
 * @param {string|number|undefined} rawTimestamp - Original timestamp value from senderDetails
 * @returns {string} - Formatted timestamp value suitable for sheet storage
 */
function formatSenderTimestamp(rawTimestamp) {
  let processedTimestamp = new Date().toISOString();

  if (rawTimestamp) {
    try {
      if (typeof rawTimestamp === "number" || /^\d{10,13}$/.test(String(rawTimestamp))) {
        const unixTimestamp = typeof rawTimestamp === "number" ? rawTimestamp : parseInt(rawTimestamp, 10);
        const millis = unixTimestamp < 10000000000 ? unixTimestamp * 1000 : unixTimestamp;
        const convertedDate = new Date(millis);

        if (!isNaN(convertedDate.getTime())) {
          processedTimestamp = convertedDate.toISOString();
        }
      } else {
        const parsed = new Date(rawTimestamp);
        if (!isNaN(parsed.getTime())) {
          processedTimestamp = parsed.toISOString();
        }
      }
    } catch (error) {
      console.error("Error formatting sender timestamp:", error);
    }
  }

  const sgTime = convertToSingaporeTime(processedTimestamp, { format: "human" });
  return `'${sgTime}'`;
}

/**
 * Update an existing safety sheet row with newly extracted issue details
 * @param {object} params - Parameters for the update
 * @param {object} params.existingRow - Existing row returned from SQL lookup (includes RowNumber and sheet values)
 * @param {object} params.issueData - Newly extracted issue data from OpenAI
 * @param {object} params.senderDetails - Sender metadata
 * @param {string} params.messageDate - Date string (YYYY-MM-DD) derived from message timestamp
 * @param {object} params.groupConfig - Optional group configuration overrides
 */
async function updateExistingSafetyIssueRow({
  existingRow,
  issueData,
  senderDetails,
  messageDate,
  groupConfig = null,
  isAlbumUpdate = false,
}) {
  if (!existingRow || !issueData) {
    return;
  }

  const rowNumber = existingRow.RowNumber;

  if (!rowNumber) {
    console.warn("Existing safety issue does not include RowNumber metadata; skipping update.");
    return;
  }

  // Write back to the tab the row actually lives in (current month OR the previous-month archive),
  // resolved by findExistingSafetyIssueRow. RowNumber is per that source tab.
  const targetSheetName = existingRow.__SourceSheet__ || groupConfig?.safetySheetName || DEFAULT_SAFETY_SHEET_NAME;
  const targetSpreadsheetId = groupConfig?.spreadsheetId;

  if (!targetSpreadsheetId) {
    console.warn("No spreadsheetId provided in groupConfig. Skipping safety issue row update.");
    return;
  }

  let sheetData;
  try {
    sheetData = await loadData(targetSheetName, groupConfig);
  } catch (error) {
    console.error("Unable to load safety sheet data for update:", error);
    return;
  }

  if (!sheetData || sheetData.length <= 1 || rowNumber > sheetData.length) {
    console.warn(`Invalid sheet data or row number ${rowNumber} for safety issue update.`);
    return;
  }

  const headers = sheetData[0];
  const columnLookup = (name) => headers.findIndex((header) => String(header).toLowerCase() === name.toLowerCase());

  const normalizeImageValue = (candidate, fallback = "") => {
    const normalize = (value) => {
      if (!value) return "";
      if (typeof value === "string") {
        let trimmed = value.trim();
        if (trimmed.startsWith("'")) {
          trimmed = trimmed.slice(1);
        }
        if (trimmed.toLowerCase().startsWith("=image(")) {
          return trimmed;
        }
        return `=image("${trimmed}",2)`;
      }
      return value;
    };

    const primary = normalize(candidate);
    if (primary) {
      return primary;
    }

    return normalize(fallback);
  };

  let existingSenderPayload = {};
  try {
    if (existingRow.Sender) {
      existingSenderPayload = JSON.parse(existingRow.Sender);
    }
  } catch (error) {
    console.warn("Failed to parse existing Sender payload while updating safety issue row:", error?.message);
    existingSenderPayload = {};
  }

  let mergedSenderDetails;
  if (senderDetails && typeof senderDetails === "object") {
    mergedSenderDetails = { ...existingSenderPayload, ...senderDetails };
    const newParentValue = senderDetails.parentMsgKey;
    if (
      (newParentValue === null || newParentValue === undefined || newParentValue === "") &&
      existingSenderPayload?.parentMsgKey
    ) {
      mergedSenderDetails.parentMsgKey = existingSenderPayload.parentMsgKey;
    }
  } else {
    mergedSenderDetails = existingSenderPayload;
  }

  const createdTimestampValue = senderDetails?.timestamp
    ? formatSenderTimestamp(senderDetails.timestamp)
    : existingRow["Created Timestamp"] || "";

  const normalizedValues = {
    Image: normalizeImageValue(issueData.mediaUrl, existingRow.Image),
    Sender: JSON.stringify(mergedSenderDetails || {}),
  };

  if (isAlbumUpdate) {
    // Album update: only update content fields IF new values are present
    // DO NOT update: Date, Status, Created Timestamp, Updated Timestamp, Updated By, Image After Rectification
    if (issueData.description) normalizedValues.Description = issueData.description;
    if (issueData.category) normalizedValues.Category = issueData.category;
    if (issueData.location) normalizedValues.Location = issueData.location;
    if (issueData.severity) normalizedValues.Severity = issueData.severity;
    if (issueData.proposed_fix) normalizedValues["Proposed Fix"] = issueData.proposed_fix;
    if (issueData.pic) normalizedValues.PIC = issueData.pic;
  } else {
    // Full update (for edit operations)
    normalizedValues.Date = messageDate || existingRow.Date || "";
    normalizedValues.Description = issueData.description || "";
    normalizedValues.Category = issueData.category || "";
    normalizedValues.Location = issueData.location || "";
    normalizedValues.Severity = issueData.severity || "";
    normalizedValues["Proposed Fix"] = issueData.proposed_fix || "";
    normalizedValues.PIC = typeof issueData.pic === "string" ? issueData.pic : "";
    normalizedValues.Status = issueData.status || existingRow.Status || "open";
    normalizedValues["Created Timestamp"] = createdTimestampValue;
    // ChatGroup: prefer the (re-)edited message's chatName; preserve existing
    // value if the new message somehow lacks it (defensive — shouldn't happen
    // since edits come from the same group).
    normalizedValues.ChatGroup = senderDetails?.chatName || existingRow.ChatGroup || "";
  }

  const batchUpdates = [];
  const formulaUpdates = [];

  Object.entries(normalizedValues).forEach(([columnName, value]) => {
    const colIndex = columnLookup(columnName);
    if (colIndex === -1) {
      return;
    }

    const normalizedValue = value === undefined || value === null ? "" : value;

    if (columnName === "Image" || columnName === "Date") {
      // Image (formula) and Date (needs USER_ENTERED to stay as date, not text) go through updateCell
      formulaUpdates.push({ row: rowNumber, col: colIndex, value: normalizedValue });
    } else {
      batchUpdates.push({ row: rowNumber, col: colIndex, value: normalizedValue });
    }
  });

  if (!batchUpdates.length && !formulaUpdates.length) {
    console.log(`No updates prepared for safety issue row ${rowNumber}`);
    return;
  }

  try {
    console.log(`Replacing safety issue row ${rowNumber} for message ${senderDetails?.messageId}`);
    if (batchUpdates.length) {
      await batchUpdateCells(targetSpreadsheetId, targetSheetName, batchUpdates);
    }

    for (const update of formulaUpdates) {
      await updateCell(targetSpreadsheetId, targetSheetName, update.row, update.col, update.value);
    }
  } catch (error) {
    console.error("Error updating existing safety issue row:", error);
  }
}

/**
 * Retry wrapper for OpenAI API calls with exponential backoff
 * @param {Function} apiCall - The OpenAI API call function to retry
 * @param {string} operationName - Name of the operation for logging
 * @param {number} maxRetries - Maximum number of retries (default: 2)
 * @returns {Promise} - Result of the API call
 */
async function withOpenAIRetry(apiCall, operationName, maxRetries = 2) {
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await apiCall();
      if (attempt > 0) {
        console.log(`✅ [OPENAI RETRY SUCCESS] ${operationName} succeeded on attempt ${attempt + 1}`);
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
        (error.status === 400 && error.message && error.message.includes("Timeout while downloading")) || // Image download timeout
        error.status === 429 || // Rate limit
        error.status === 500 || // Internal server error
        error.status === 502 || // Bad gateway
        error.status === 503 || // Service unavailable
        error.status === 504 || // Gateway timeout
        (error.message &&
          (error.message.includes("timeout") ||
            error.message.includes("network") ||
            error.message.includes("connection") ||
            error.message.includes("downloading")));

      if (!isRetryable) {
        console.error(`❌ [OPENAI NON-RETRYABLE] ${operationName} failed:`, error.message);
        throw error;
      }

      // Calculate delay with exponential backoff + jitter
      const delay = 2000 * Math.pow(2, attempt) + Math.random() * 1000;

      console.warn(
        `⚠️ [OPENAI RETRY ${attempt + 1}/${maxRetries}] ${operationName} failed: ${
          error.message
        }. Retrying in ${Math.round(delay)}ms...`,
      );

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  console.error(
    `❌ [OPENAI RETRY EXHAUSTED] ${operationName} failed after ${maxRetries + 1} attempts:`,
    lastError.message,
  );
  throw lastError;
}

// Fixed headers for Safety sheet (16 cols: S/N..Novade Action Id).
// "In Report?" is still auto-appended by safety_novade_sync if a customer
// enables it. Novade Action Id is in the template so fresh/recovered sheets
// have it from day one and downstream sync doesn't have to insert a column.
const SAFETY_SHEET_HEADERS = [
  "S/N",
  "Date",
  "Description",
  "Category",
  "Location",
  "Severity",
  "Proposed Fix",
  "PIC",
  "Image",
  "Status",
  "Sender",
  "Created Timestamp",
  "Image After Rectification",
  "Updated Timestamp",
  "Updated By",
  "ChatGroup",
  "Novade Action Id",
];

// Parse a "Safety-<Mon> <YYYY>" tab name to a sortable yyyymm number.
// Returns null for names that don't match the archive pattern.
const ARCHIVE_NAME_RE = /^Safety-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})$/;
const MONTH_TO_NUM = {
  Jan: 1,
  Feb: 2,
  Mar: 3,
  Apr: 4,
  May: 5,
  Jun: 6,
  Jul: 7,
  Aug: 8,
  Sep: 9,
  Oct: 10,
  Nov: 11,
  Dec: 12,
};
function archiveSortKey(name) {
  const m = ARCHIVE_NAME_RE.exec(name);
  if (!m) return null;
  return parseInt(m[2], 10) * 100 + MONTH_TO_NUM[m[1]];
}
function pickMostRecentSafetyArchive(sheetNames) {
  let best = null;
  let bestKey = -1;
  for (const name of sheetNames) {
    const key = archiveSortKey(name);
    if (key != null && key > bestKey) {
      best = name;
      bestKey = key;
    }
  }
  return best;
}

/**
 * Ensure the Safety sheet exists - handles recovery scenarios:
 * 1. If Safety sheet exists - do nothing
 * 2. If Safety sheet missing but ANY "Safety-<Mon> <YYYY>" archive exists - clone the most recent one
 * 3. If nothing exists - create fresh Safety sheet with headers
 * @param {object} groupConfig - Configuration object containing spreadsheetId
 * @param {Date} mockDate - Optional mock date for testing (overrides current date)
 * @returns {Promise<boolean>} - True if sheet was created/recovered, false if already exists
 */
async function ensureSafetySheetExists(groupConfig, mockDate = null) {
  try {
    const spreadsheetId = groupConfig?.spreadsheetId;
    if (!spreadsheetId) {
      console.warn("[SAFETY RECOVERY] No spreadsheetId provided in groupConfig - skipping recovery check");
      return false;
    }

    const safetySheetName = groupConfig?.safetySheetName || DEFAULT_SAFETY_SHEET_NAME;

    console.log(`[SAFETY RECOVERY] Checking if "${safetySheetName}" sheet exists...`);

    // Get all sheet names in the spreadsheet
    const sheetNames = await getSheetNames(spreadsheetId);
    console.log(`[SAFETY RECOVERY] Found sheets: ${sheetNames.join(", ")}`);

    // Check if Safety sheet already exists
    if (sheetNames.includes(safetySheetName)) {
      console.log(`[SAFETY RECOVERY] "${safetySheetName}" sheet already exists - no recovery needed`);
      return false;
    }

    console.log(`⚠️ [SAFETY RECOVERY] "${safetySheetName}" sheet is MISSING!`);

    // Find the most recent Safety-<Mon> <YYYY> archive and CLONE it. We never
    // rebuild Safety from a 15-col template when an archive exists — that
    // discards column widths, bold, filters, and any extra columns the
    // customer added downstream (e.g. "Novade Action Id").
    const mostRecentArchive = pickMostRecentSafetyArchive(sheetNames);
    if (mostRecentArchive) {
      console.log(`✅ [SAFETY RECOVERY] Cloning most-recent archive "${mostRecentArchive}" → "${safetySheetName}"`);
      await duplicateSheet(spreadsheetId, mostRecentArchive, safetySheetName, true);
      await clearDataKeepHeaders(spreadsheetId, safetySheetName);
      await ensureHeaderRowSetup(spreadsheetId, safetySheetName, { warningOnly: false });
      invalidateSafetyCache(spreadsheetId); // tab set changed (new live "Safety" cloned from archive)
      console.log(
        `🎉 [SAFETY RECOVERY] Recovered "${safetySheetName}" from "${mostRecentArchive}" (archive preserved)`,
      );
      return true;
    }

    // No archive at all - this is a brand-new spreadsheet. Build from template.
    console.log(`[SAFETY RECOVERY] No archive found - creating fresh "${safetySheetName}" sheet with headers`);

    // Create new sheet
    await createNewSheet(spreadsheetId, safetySheetName);
    console.log(`✅ [SAFETY RECOVERY] Created new sheet "${safetySheetName}"`);

    // Write headers to row 1
    await writeArrayToGSheetRow(spreadsheetId, safetySheetName, [SAFETY_SHEET_HEADERS]);
    console.log(`✅ [SAFETY RECOVERY] Added headers to "${safetySheetName}": ${SAFETY_SHEET_HEADERS.join(", ")}`);

    // Setup header row - freeze and protect
    await setupHeaderRow(spreadsheetId, safetySheetName, {
      freeze: true,
      protect: true,
      warningOnly: false, // Strict protection - no editing allowed
    });
    console.log(`✅ [SAFETY RECOVERY] Header row frozen and protected`);

    invalidateSafetyCache(spreadsheetId); // tab set changed (fresh "Safety" created)
    console.log(`🎉 [SAFETY RECOVERY] Successfully created fresh "${safetySheetName}" sheet with headers`);
    return true;
  } catch (error) {
    console.error("[SAFETY RECOVERY] Error during sheet recovery:", error);
    // Re-throw to surface the error - this is a critical issue
    throw error;
  }
}

/**
 * Check if we need to rotate the Safety sheet for a new month
 * If the last item in the current sheet is from a different month than today,
 * rename the current sheet to "Safety - Oct 2025" format and create a new empty "Safety" sheet
 * @param {object} groupConfig - Configuration object containing spreadsheetId
 * @param {Date} mockDate - Optional mock date for testing (overrides current date)
 * @returns {Promise<void>}
 */
async function checkAndRotateSheetIfNewMonth(groupConfig, mockDate = null) {
  try {
    const spreadsheetId = groupConfig?.spreadsheetId;
    if (!spreadsheetId) {
      console.warn("[MONTHLY ROTATION] No spreadsheetId provided in groupConfig - skipping rotation check");
      return;
    }
    const safetySheetName = groupConfig?.safetySheetName || DEFAULT_SAFETY_SHEET_NAME;

    // First, ensure the Safety sheet exists (handles recovery scenarios)
    const wasRecovered = await ensureSafetySheetExists(groupConfig, mockDate);
    if (wasRecovered) {
      console.log("[MONTHLY ROTATION] Sheet was just recovered/created - skipping rotation check for this call");
      return;
    }

    console.log("[MONTHLY ROTATION] Checking if sheet rotation is needed...");

    // Load current Safety sheet
    const sheetData = await readGoogleSheet(spreadsheetId, safetySheetName);

    if (!sheetData || sheetData.length < 2) {
      console.log("[MONTHLY ROTATION] Sheet is empty or only has headers - no rotation needed");
      return;
    }

    // Get headers and last row
    const headers = sheetData[0];
    const lastRow = sheetData[sheetData.length - 1];
    const dateIndex = headers.indexOf("Date");

    if (dateIndex === -1) {
      console.warn("[MONTHLY ROTATION] Date column not found - skipping rotation check");
      return;
    }

    const lastItemDate = lastRow[dateIndex];
    if (!lastItemDate) {
      console.warn("[MONTHLY ROTATION] Last item has no date - skipping rotation check");
      return;
    }

    // Check if we're in a new month — IN SINGAPORE TIME, not the Lambda's UTC.
    // The Lambda runtime is UTC, so a raw `new Date()` reads as the previous day
    // for the first 8h of every SGT day (00:00–08:00 SGT == 16:00–24:00 UTC the
    // day before). On the 1st of a month that means "today" looks like the last
    // day of the PREVIOUS month, so checkIfNewMonth returns false and rotation
    // silently never fires (the 1-Jun-2026 02:44 SGT bug: new Date() was still
    // 31-May UTC). The Date column itself is written in SGT, so we must compare
    // against the SGT calendar date. A mockDate (tests) is honoured as-is.
    const today = mockDate || convertToSingaporeTime(new Date(), { format: "iso" }).split("T")[0];
    if (mockDate) {
      const mockStr = mockDate instanceof Date ? mockDate.toISOString().split("T")[0] : String(mockDate);
      console.log(`🎭 [MOCK MODE] Using mocked date: ${mockStr}`);
    }
    console.log(`[MONTHLY ROTATION] Comparing last item date "${lastItemDate}" against SGT today "${today}"`);
    const isNewMonth = checkIfNewMonth(lastItemDate, today);

    if (!isNewMonth) {
      console.log("[MONTHLY ROTATION] Still in same month - no rotation needed");
      return;
    }

    // `today` is an SGT "YYYY-MM-DD" string (or a mockDate Date in tests).
    const todayStr = today instanceof Date ? today.toISOString().split("T")[0] : String(today);
    console.log(`🔄 [MONTHLY ROTATION] New month detected! Last item: ${lastItemDate}, Today: ${todayStr}`);

    // Generate archive name from last item's date
    const archiveName = formatSheetArchiveName(lastItemDate);
    console.log(`[MONTHLY ROTATION] Archiving current sheet as: ${archiveName}`);

    // Rename current sheet to archive name
    await renameSheet(spreadsheetId, safetySheetName, archiveName);
    console.log(`✅ [MONTHLY ROTATION] Sheet renamed to: ${archiveName}`);

    // Duplicate the archived sheet (preserves formatting, column widths, formulas)
    // Insert right after the archived sheet to keep them adjacent
    await duplicateSheet(spreadsheetId, archiveName, safetySheetName, true);
    console.log(`✅ [MONTHLY ROTATION] Sheet duplicated: ${archiveName} → ${safetySheetName} (positioned right after)`);

    // Clear all data rows but keep the header row
    const clearResult = await clearDataKeepHeaders(spreadsheetId, safetySheetName);
    console.log(`✅ [MONTHLY ROTATION] Data cleared: ${clearResult.rowCount} rows removed, headers preserved`);

    // The safety tab set just changed (Safety → archive, fresh empty Safety). Drop the merged
    // multi-tab cache so no stale __SourceSheet__/RowNumber survives → prevents a Novade-Id
    // writeback within the 5-min TTL from landing on the wrong (just-renamed) tab.
    invalidateSafetyCache(spreadsheetId);

    console.log(`🎉 [MONTHLY ROTATION] Sheet rotation completed successfully!`);
    console.log(`   - Archived: ${archiveName}`);
    console.log(`   - New sheet: ${safetySheetName} (ready for new month)`);
  } catch (error) {
    console.error("[MONTHLY ROTATION] Error during sheet rotation:", error);
    // Don't throw - allow the safety issue creation to continue even if rotation fails
    console.warn("[MONTHLY ROTATION] Continuing with safety issue creation despite rotation error");
  }
}

/**
 * Creates a safety issue from a message
 * @param {string|object} message - The message to process
 * @param {string} mediaUrl - URL of any media attached to the message
 * @param {string} caption - Caption of any media attached to the message
 * @param {object} senderDetails - Details about the sender
 * @returns {object} - The processed result
 */
async function createSafetyIssue(message, mediaUrl = null, caption = null, senderDetails = null, groupConfig = null) {
  const messageContent = typeof message === "object" ? message.body : message;

  // Check if we need to rotate the sheet for a new month
  await checkAndRotateSheetIfNewMonth(groupConfig);

  const tools = [
    {
      type: "function",
      name: "extract_safety_issue",
      description: "Extract structured safety issue data from messages",
      parameters: {
        type: "object",
        properties: {
          description: {
            type: "string",
            description: "Description of the safety issue or observation",
          },
          category: {
            type: "string",
            enum: [
              "FYI",
              "Good Observation",
              "Access",
              "Working at Height/Falling hazard",
              "Overhead/Falling object hazard",
              "Cranes/ heavy equipment",
              "Excavation/Trenching/Confined Spaces",
              "Fire/Explosion Hazard",
              "Scaffolds/ supports",
              "Equipment",
              "Electrical hazard",
              "Security /facilities",
              "Trips/slips/Protruding hazards",
              "Personal protective equipment",
              "Health hazard",
              "Public safety",
              "Vehicular hazard",
              "Other hazards",
            ],
            description:
              "Category - use FYI for informational items, Good Observation for positive behaviors, or specific hazard category for problems",
          },
          location: {
            type: "string",
            description: "Location of the safety issue or observation",
          },
          severity: {
            type: "string",
            enum: ["P1", "P2", "P3", "N/A"],
            description:
              "Priority level (P1: High risk/immediate, P2: Medium risk/24hrs, P3: Low risk/1week, N/A: ONLY for FYI and Good Observation)",
          },
          proposed_fix: {
            type: "string",
            description:
              'Suggested solution or fix for the safety issue, if mentioned in the caption or message. MUST ALWAYS USE "Not specified" for FYI and Good Observation.',
          },
          pic: {
            type: "string",
            description:
              'Person-in-charge (PIC) — extract ONLY when the message explicitly mentions one (e.g. "*Person-in-charge:* Bongsi", "PIC: John", "in-charge: Ali"). Copy the name VERBATIM from the message. Return an empty string "" if no PIC is mentioned. NEVER infer or make up a name.',
          },
        },
        required: ["description", "category", "location", "severity", "proposed_fix", "pic"],
      },
    },
  ];

  const input = [
    {
      role: "system",
      content: safetyExtractionPrompt,
    },
    {
      role: "user",
      content: mediaUrl
        ? [
            {
              type: "input_text",
              text: `Analyze this safety issue and extract all structured data.

        Do not reply with a text summary. Only call the function with the extracted data.

        Message: "${messageContent}"
        ${caption ? `Caption: "${caption}"` : ""}`,
            },
            {
              type: "input_image",
              image_url: mediaUrl,
            },
          ]
        : [
            {
              type: "input_text",
              text: `Analyze this safety issue and extract all structured data.

        Do not reply with a text summary. Only call the function with the extracted data.

        Message: "${messageContent}"`,
            },
          ],
    },
  ];

  try {
    console.log("Calling OpenAI with function definitions for safety issue");

    const response = await withOpenAIRetry(
      async () => {
        return await getOpenAI().responses.create({
          model: "gpt-4.1",
          temperature: 0,
          input,
          tools,
          store: true,
          metadata,
        });
      },
      `createSafetyIssue(${senderDetails?.name || "unknown"})`,
    );

    console.log("OpenAI response received for safety issue");

    if (response.output && response.output.length > 0) {
      const functionCalls = [];

      for (const toolCall of response.output) {
        if (toolCall.type !== "function_call") {
          continue;
        }
        const name = toolCall.name;
        const args = JSON.parse(toolCall.arguments);
        functionCalls.push({
          functionName: name,
          arguments: args,
        });
      }

      let safetyItemsWithImage = functionCalls
        .map((item) => {
          if (item.functionName === "extract_safety_issue") {
            const category = item.arguments?.category || "";

            // Skip FYI category - do not write to sheet
            if (category === "FYI") {
              console.log(`⏭️ [FYI] Skipping FYI entry - not writing to sheet`);
              return null;
            }

            const isGoodObservation = category === "Good Observation";
            const status = isGoodObservation ? "N/A" : "open";

            if (isGoodObservation) {
              console.log(`📝 [GOOD OBS] Creating Good Observation entry (Status: N/A)`);
            }

            return {
              ...item.arguments,
              pic: typeof item.arguments?.pic === "string" ? item.arguments.pic : "",
              mediaUrl: mediaUrl ? `=image("${mediaUrl}",2)` : "",
              status: status,
            };
          }
          return item;
        })
        .filter(Boolean);

      // HARD GUARD: Never create more than one safety issue per message.
      // If LLM returned multiple, merge them into the first entry.
      if (safetyItemsWithImage.length > 1) {
        console.warn(
          `⚠️ [MULTI-ISSUE GUARD] LLM returned ${safetyItemsWithImage.length} issues for a single message. Merging into one.`,
        );
        const primary = safetyItemsWithImage[0];
        const extras = safetyItemsWithImage.slice(1);
        // Merge descriptions
        const allDescriptions = [primary.description, ...extras.map((e) => e.description)].filter(Boolean);
        primary.description = allDescriptions.join("; ");
        // Merge proposed fixes
        const allFixes = [primary.proposed_fix, ...extras.map((e) => e.proposed_fix)].filter(
          (f) => f && f !== "Not specified",
        );
        primary.proposed_fix = allFixes.length > 0 ? allFixes.join("; ") : "Not specified";
        safetyItemsWithImage = [primary];
      }

      // If all items were FYI (filtered out), skip sheet writing
      if (safetyItemsWithImage.length === 0) {
        console.log(`⏭️ [FYI] All extracted items were FYI category - skipping sheet write`);
        return {
          functionCalls,
          skipped: true,
          reason: "FYI category - not written to sheet",
        };
      }

      // PIC resolution: a safety message designates the person-in-charge by @mentioning
      // them ("@<lid digits>"). Resolve each mention to a real name — Name List first, then
      // whatsapp_listener history (latest pushname), and as a LAST RESORT the raw "@id" itself
      // (so a tagged PIC is never dropped and we never re-ask). We strip "@<digits>" from the
      // LLM-extracted pic first (leaving any explicit "PIC: name" text), then override with the
      // resolved value when the body has mentions.
      // NOTE: do NOT add a new key to the item — writeGenericData maps columns by
      // Object.values() insertion order, so an extra property would shift a column.
      const llmPic = safetyItemsWithImage[0].pic;
      let resolvedPic = stripMentionIds(llmPic);
      // Hoisted so the post-write block can start the Novade enrichment conversation.
      let picEnrichUnresolved = [];
      let picEnrichBaseNames = [];
      if (groupConfig?.spreadsheetId) {
        try {
          const { picText, resolved } = await resolvePicFromMentions(messageContent, groupConfig.spreadsheetId);
          if (picText) resolvedPic = picText;
          const resolvedArr = resolved || [];
          picEnrichUnresolved = resolvedArr.filter((e) => e.source === "listener" || e.source === "raw");
          picEnrichBaseNames = resolvedArr
            .filter((e) => e.source === "namelist")
            .map((e) => e.novadeName || e.display)
            .filter(Boolean);
          // When Novade enrichment will run for the unresolved tags, store ONLY the already-
          // bridgeable Name List names at create time; the listener/raw ones are filled in
          // after the reporter confirms each person via the enrichment conversation.
          if (picEnrichUnresolved.length && picEnrichAdapter.hasNovade()) {
            resolvedPic = picEnrichBaseNames.join(", ");
          }
        } catch (e) {
          console.warn("[PIC @mention] resolution failed (non-blocking):", e.message);
        }
      }
      if (resolvedPic !== llmPic) {
        console.log(`[PIC] "${llmPic}" → "${resolvedPic}"`);
      }
      safetyItemsWithImage[0].pic = resolvedPic;

      // Extract date from message timestamp, or use current date as fallback
      let messageDate;
      try {
        const messageTimestamp = senderDetails?.timestamp || new Date().toISOString();
        // Convert to Singapore timezone and extract date part (YYYY-MM-DD format)
        const sgDateTime = convertToSingaporeTime(messageTimestamp, { format: "iso" });
        messageDate = sgDateTime.split("T")[0]; // Extract YYYY-MM-DD part
      } catch (error) {
        console.error("Error extracting date from message timestamp:", error);
        messageDate = new Date().toISOString().split("T")[0]; // Fallback to current date
      }

      const messageId = senderDetails?.messageId || null;
      const parentMsgKey = senderDetails?.parentMsgKey || null;
      const hasTextContent = Boolean((caption || messageContent || "").trim());

      // Note: Edit handling is now done BEFORE intent classification in openai.js
      // via handleEditedSafetyMessage. This block only handles album (parentMsgKey) deduplication.
      if (parentMsgKey) {
        console.log(
          `Album message detected (parentMsgKey=${parentMsgKey}). Checking for existing issue to avoid duplicates.`,
        );
        const existingRow = await findExistingSafetyIssueRow(
          {
            parentMessageId: parentMsgKey,
          },
          groupConfig,
        );

        if (existingRow) {
          const [primaryIssue, ...additionalIssues] = safetyItemsWithImage;

          if (!primaryIssue) {
            console.warn("Album follow-up message produced no structured data. Skipping duplicate creation.");
            return {
              functionCalls,
              duplicate: true,
              duplicateRowNumber: existingRow.RowNumber,
              duplicateSource: "parent_message",
            };
          }

          if (!hasTextContent) {
            console.log(`Image-only album message - updating image on existing issue (row ${existingRow.RowNumber}).`);
            await updateExistingSafetyIssueRow({
              existingRow,
              issueData: { mediaUrl: mediaUrl ? `=image("${mediaUrl}",2)` : "" },
              senderDetails,
              messageDate: null,
              groupConfig,
              isAlbumUpdate: true,
            });
            return {
              functionCalls,
              imageOnly: true,
              updatedRowIndex: existingRow.RowNumber,
              duplicateSource: "parent_message",
            };
          }

          await updateExistingSafetyIssueRow({
            existingRow,
            issueData: primaryIssue,
            senderDetails,
            messageDate,
            groupConfig,
            isAlbumUpdate: true,
          });

          if (additionalIssues.length > 0) {
            console.warn(
              `Multiple safety issues detected for album parent ${parentMsgKey}. Only the first entry was used for the update.`,
            );
          }

          return {
            functionCalls,
            updatedRowIndex: existingRow.RowNumber,
            duplicateSource: "parent_message",
          };
        }
      }

      // FINAL CHECK: Prevent duplicate messageId insertion (handles race condition where edit arrives before original)
      if (messageId) {
        const existingRowByMessageId = await findExistingSafetyIssueRow({ messageId }, groupConfig);
        if (existingRowByMessageId) {
          console.log(
            `Found existing issue with same messageId (row ${existingRowByMessageId.RowNumber}). Skipping insert to prevent duplicate.`,
          );
          // Only update image if current message has one, otherwise just skip insert
          const [primaryIssue] = safetyItemsWithImage;
          if (primaryIssue?.mediaUrl) {
            await updateExistingSafetyIssueRow({
              existingRow: existingRowByMessageId,
              issueData: { mediaUrl: primaryIssue.mediaUrl }, // Only update image, nothing else
              senderDetails,
              messageDate: null,
              groupConfig,
              isAlbumUpdate: true,
            });
          }
          return {
            functionCalls,
            updatedRowIndex: existingRowByMessageId.RowNumber,
            duplicateSource: "message_id_race_condition",
          };
        }
      }

      // appendFields fills the four columns AFTER Created Timestamp (col 10):
      //   col 11 Image After Rectification — empty until close
      //   col 12 Updated Timestamp          — empty until close
      //   col 13 Updated By                 — empty until close
      //   col 14 ChatGroup                  — populated now from chatName
      const count = await writeGenericData(
        safetyItemsWithImage,
        groupConfig?.safetySheetName || "Safety",
        null,
        senderDetails,
        {
          includeSerialNumber: true,
          prependFields: [messageDate],
          appendFields: ["", "", "", senderDetails?.chatName || ""],
          spreadsheetId: groupConfig?.spreadsheetId,
        },
      );

      // Missing-PIC follow-up: if a real hazard (status "open") was created with no
      // resolvable PIC, reply to the ORIGINAL message asking the reporter to tag the PIC.
      // (Good Observation has status "N/A" → skipped.) Non-blocking — a send failure must
      // never fail the create. The reporter's reply is handled by handlePicFollowupReply.
      const created = safetyItemsWithImage[0];
      const enrichAnchorId = senderDetails?.messageId;
      if (
        created &&
        created.status === "open" &&
        groupConfig?.spreadsheetId &&
        enrichAnchorId &&
        picEnrichUnresolved.length &&
        picEnrichAdapter.hasNovade()
      ) {
        // Novade + an unresolvable (listener/raw) tag → start the multi-turn enrichment flow.
        await startPicEnrichment({
          message,
          senderDetails,
          groupConfig,
          anchorId: enrichAnchorId,
          baseNames: picEnrichBaseNames,
          unresolvedMentions: picEnrichUnresolved,
          adapter: picEnrichAdapter,
        });
      } else if (
        created &&
        created.status === "open" &&
        !String(created.pic || "").trim() &&
        extractMentionIds(messageContent).length === 0 &&
        groupConfig?.spreadsheetId &&
        senderDetails?.messageId
      ) {
        try {
          // sendWhatsAppReply MUST get the SERIALIZED message id (messageIdSerialized) to
          // actually quote the original — the short messageId does NOT quote. The [ref:]
          // marker still carries the plain messageId (that's what the Sender column stores
          // and findExistingSafetyIssueRow matches on).
          const replyToSerialized =
            (typeof message === "object" && (message.messageIdSerialized || message.messageId)) ||
            senderDetails?.messageIdSerialized ||
            senderDetails?.messageId ||
            null;
          await sendWhatsAppReply(
            (typeof message === "object" && (message.chatId || message.from)) || groupConfig?.chatId,
            buildPicRequestMessage(senderDetails.messageId),
            undefined,
            undefined,
            replyToSerialized,
          );
          console.log(`[PIC ask] requested PIC for new issue (messageId ${senderDetails.messageId})`);
        } catch (e) {
          console.warn("[PIC ask] reply failed (non-blocking):", e.message);
        }
      }

      return {
        functionCalls,
        // message: `Successfully processed ${count} safety issues`,
      };
    }

    return {
      functionName: null,
      arguments: null,
      resultMsg: "No relevant function was called or an error occurred.",
    };
  } catch (error) {
    console.error("Error in createSafetyIssue:", error);
    return {
      functionName: null,
      arguments: null,
      resultMsg: "No relevant function was called or an error occurred in catch.",
    };
  }
}

/**
 * Updates safety issues based on a message
 * @param {string|object} message - The message to process
 * @param {string} mediaUrl - URL of any media attached to the message
 * @param {string} caption - Caption of any media attached to the message
 * @param {object} senderDetails - Details about the sender
 * @returns {object} - The processed result
 */
async function updateSafetyIssues(message, mediaUrl = null, caption = null, senderDetails = null, groupConfig = null) {
  try {
    const messageContent = typeof message === "object" ? message.body : message;
    const quotedMessageId = typeof message === "object" ? message.quotedMessageId : null;

    if (!quotedMessageId) {
      return {
        functionName: "update_safety_issues",
        arguments: null,
        // message: "Safety issues can only be closed by replying to the original issue message. Please reply to the specific issue you want to close."
      };
    }

    const tools = [
      {
        type: "function",
        name: "validate_image_correspondence",
        description: "Validate that the current image and caption correspond to the original safety issue",
        strict: true,
        parameters: {
          type: "object",
          properties: {
            isValid: {
              type: "boolean",
              description: "Whether the current image and caption correspond to the original safety issue",
            },
            confidence: {
              type: "number",
              description: "Confidence score for the validation (0-100)",
            },
            reason: {
              type: "string",
              description: "Explanation of why the validation passed or failed",
            },
          },
          required: ["isValid", "confidence", "reason"],
          additionalProperties: false,
        },
      },
    ];

    console.log(`Quoted message ID found: ${quotedMessageId}. Querying original issue...`);

    // Build list of IDs to search: the quotedMessageId itself, plus its album parent if it's an album child
    const chatId = typeof message === "object" ? message.from : null;
    const albumParentId = await resolveAlbumParentMessageId(quotedMessageId, chatId);
    const searchIds = [quotedMessageId];
    if (albumParentId) searchIds.push(albumParentId);

    // Resolve which tab the quoted issue lives in: the current month, else the previous-month
    // archive (close/clone of an older issue is out of scope, like edit/delete). All reads +
    // writes in this flow then target that tab so closing a last-month issue updates its archive.
    let closeSheetName = groupConfig?.safetySheetName || DEFAULT_SAFETY_SHEET_NAME;
    try {
      const idList = searchIds.map((x) => `'${String(x).replace(/'/g, "''")}'`).join(", ");
      const probe = `SELECT TOP 1 RowNumber FROM safetyData WHERE getMessageId(Sender) IN (${idList}) OR getParentMessageId(Sender) IN (${idList})`;
      for (const tab of safetyEditDeleteTabs(groupConfig)) {
        const hit = await runSQLQuery(probe, "safety", { groupConfig, sheetName: tab });
        if (Array.isArray(hit) && hit.length > 0 && !hit.error) {
          closeSheetName = tab;
          break;
        }
      }
    } catch (e) {
      console.warn(`[Safety Close] tab probe failed, defaulting to "${closeSheetName}": ${e?.message || e}`);
    }

    let rawTable;
    try {
      rawTable = await loadData(closeSheetName, groupConfig);
      console.log(`Loaded data from "${closeSheetName}":`, rawTable ? "Data available" : "No data");

      if (!rawTable || rawTable.length <= 1) {
        console.log("No Data loaded");
        return {
          filters: "",
          resultMsg: `Error loading data`,
        };
      }
    } catch (error) {
      console.error("Error loading data:", error);
      return {
        resultMsg: "Error loading safety issues database.",
      };
    }

    // Try to find the open issue by any of the resolved IDs
    let originalIssue = null;
    for (const id of searchIds) {
      if (originalIssue && originalIssue.length > 0) break;
      const sanitizedId = String(id).replace(/'/g, "''");
      const query = `SELECT * FROM safetyData WHERE getMessageId(Sender) = '${sanitizedId}' AND Status = 'open'`;
      originalIssue = await runSQLQuery(query, "safety", {
        groupConfig: groupConfig,
        sheetName: closeSheetName,
      });
      console.log(`Issue lookup by messageId=${id}:`, originalIssue?.length || 0, "results");

      if (!originalIssue || originalIssue.length === 0) {
        const parentQuery = `SELECT * FROM safetyData WHERE getParentMessageId(Sender) = '${sanitizedId}' AND Status = 'open'`;
        originalIssue = await runSQLQuery(parentQuery, "safety", {
          groupConfig: groupConfig,
          sheetName: closeSheetName,
        });
        console.log(`Issue lookup by parentMessageId=${id}:`, originalIssue?.length || 0, "results");
      }
    }

    if (!originalIssue || originalIssue.length === 0) {
      // ── CLOSED ISSUE IMAGE FALLBACK ──
      // Check if the issue exists but is closed, and needs a rectification image
      console.log("No open issue found. Checking for closed issues that may need rectification image...");

      let closedIssue = null;
      for (const id of searchIds) {
        if (closedIssue && closedIssue.length > 0) break;
        const sanitizedId = String(id).replace(/'/g, "''");
        const closedQuery = `SELECT * FROM safetyData WHERE getMessageId(Sender) = '${sanitizedId}' AND Status = 'closed'`;
        closedIssue = await runSQLQuery(closedQuery, "safety", {
          groupConfig: groupConfig,
          sheetName: closeSheetName,
        });

        if (!closedIssue || closedIssue.length === 0) {
          const closedParentQuery = `SELECT * FROM safetyData WHERE getParentMessageId(Sender) = '${sanitizedId}' AND Status = 'closed'`;
          closedIssue = await runSQLQuery(closedParentQuery, "safety", {
            groupConfig: groupConfig,
            sheetName: closeSheetName,
          });
        }
      }

      if (closedIssue && closedIssue.length > 0) {
        const issue = closedIssue[0];

        // No image in reply → nothing to update
        if (!mediaUrl) {
          console.log(`📸 [CLOSED IMAGE] Issue #${issue["S/N"]} is closed, reply has no image. Ignoring.`);
          return {
            filters: { quotedMessageId },
            resultMsg: `Issue #${issue["S/N"]} is already closed. No image provided to add.`,
          };
        }

        // Already has rectification image → skip
        const afterImage = issue["Image After Rectification"];
        if (afterImage && afterImage !== "no image provided") {
          console.log(`📸 [CLOSED IMAGE] Issue #${issue["S/N"]} already has rectification image. Ignoring.`);
          return {
            filters: { quotedMessageId },
            resultMsg: `Issue #${issue["S/N"]} is already closed with rectification image.`,
          };
        }

        // Insert rectification image into closed issue (in its source tab — current or previous month)
        console.log(
          `📸 [CLOSED IMAGE] Inserting rectification image into closed issue #${issue["S/N"]} on "${closeSheetName}"`,
        );
        const safetySheetName = closeSheetName;
        const spreadsheetId = groupConfig?.spreadsheetId;
        const sheetRow = issue.RowNumber;
        const imageFormula = `=image("${mediaUrl}",2)`;

        // Format timestamp same way as the close flow
        let messageTimestamp;
        try {
          const rawTimestamp = senderDetails?.timestamp || new Date().toISOString();
          let processedTimestamp;
          if (
            typeof rawTimestamp === "number" ||
            (typeof rawTimestamp === "string" && /^\d{10,13}$/.test(rawTimestamp))
          ) {
            const unixTimestamp = typeof rawTimestamp === "number" ? rawTimestamp : parseInt(rawTimestamp, 10);
            const milliseconds = unixTimestamp < 10000000000 ? unixTimestamp * 1000 : unixTimestamp;
            processedTimestamp = new Date(milliseconds);
          } else {
            processedTimestamp = new Date(rawTimestamp);
          }
          messageTimestamp = `'${formatHumanReadableTimestamp(processedTimestamp)}`;
        } catch (error) {
          messageTimestamp = `'${formatHumanReadableTimestamp(new Date())}`;
        }

        // Resolve column indices from the actual header row instead of hard-coding
        // 11/12/13 — guards against sheets where extra columns were inserted earlier
        // (e.g., a ChatGroup migration ordering quirk).
        const sheetForHeaders = await loadData(safetySheetName, { spreadsheetId });
        const headers = (sheetForHeaders && sheetForHeaders[0]) || [];
        const colImage = headers.indexOf("Image After Rectification");
        const colUpdatedTs = headers.indexOf("Updated Timestamp");
        const colUpdatedBy = headers.indexOf("Updated By");
        if (colImage < 0 || colUpdatedTs < 0 || colUpdatedBy < 0) {
          console.warn(
            `[CLOSED IMAGE] Header lookup failed (image=${colImage}, ts=${colUpdatedTs}, by=${colUpdatedBy}); aborting fallback write to avoid corrupting other columns.`,
          );
          return {
            filters: { quotedMessageId },
            resultMsg: `Issue #${issue["S/N"]} is already closed; could not write rectification image (sheet headers unrecognized).`,
          };
        }
        await updateCell(spreadsheetId, safetySheetName, sheetRow, colImage, imageFormula);
        await updateCell(spreadsheetId, safetySheetName, sheetRow, colUpdatedTs, messageTimestamp);
        await updateCell(spreadsheetId, safetySheetName, sheetRow, colUpdatedBy, JSON.stringify(senderDetails));

        console.log(`📸 [CLOSED IMAGE] Successfully added rectification image to issue #${issue["S/N"]}`);
        return {
          filters: { quotedMessageId },
          resultMsg: `Rectification image added to closed issue #${issue["S/N"]}: ${issue.Description}`,
        };
      }

      // Neither open nor closed issue found
      return {
        filters: { quotedMessageId },
        resultMsg: `No safety issue found for the quoted message.`,
      };
    }

    if (originalIssue.length > 1) {
      console.warn(`Multiple issues found for quoted message ID: ${quotedMessageId}`);
    }

    const originalIssueData = originalIssue[0];
    console.log(`Found original issue for quoted message ID: ${quotedMessageId}`);

    // Check if the original issue is FYI or Good Observation (Status = "N/A")
    const originalStatus = String(originalIssueData.Status || "").trim();
    if (originalStatus === "N/A") {
      const originalCategory = originalIssueData.Category || "Unknown";
      console.log(`⚠️ [UPDATE REJECTED] Cannot update ${originalCategory} issues (Status: N/A)`);
      return {
        filters: { quotedMessageId },
        resultMsg: `This is a ${originalCategory} entry and cannot be updated or closed. FYI and Good Observation entries are for logging purposes only.`,
      };
    }

    const headers = rawTable[0];
    const structuredData = rawTable.slice(1).map((row, index) => {
      const item = {};
      headers.forEach((header, i) => {
        item[header] = row[i];
      });
      item.rowIndex = index + 1;
      return item;
    });

    // const originalMediaUrl = originalIssueData.Image
    //   ? originalIssueData.Image.replace('=image("', '').replace('",2)', '')
    //   : null;

    // LLM VALIDATION FOR ALL CASES
    let validationResult = null;

    const input = [
      {
        role: "system",
        content: validationPrompt,
      },
    ];

    // Case 1: Text only - validate text
    if (messageContent && !mediaUrl) {
      console.log("Text-only message, validating text content");
      input.push({
        role: "user",
        content: [
          {
            type: "input_text",
            text: `A user is replying to close a safety issue. Validate the closure based on the provided information.

            Original issue details:
            ${JSON.stringify(originalIssueData, null, 2)}

            User message: """${messageContent}"""

            No image provided. Validate that the message indicates the safety issue has been properly resolved.`,
          },
        ],
      });
    }
    // Case 2: Image only - auto-close without LLM validation
    else if (!messageContent && mediaUrl) {
      console.log("Image-only message, auto-closing without LLM validation");
      validationResult = {
        isValid: true,
        confidence: 95,
        reason: "Image-only reply provided as evidence of issue resolution - auto-approved.",
      };
    }
    // Case 3: Both text and image - PRIORITIZE TEXT ONLY (skip image)
    else if (messageContent && mediaUrl) {
      console.log("Both text and image present, validating TEXT ONLY (skipping image)");
      input.push({
        role: "user",
        content: [
          {
            type: "input_text",
            text: `A user is replying to close a safety issue. Validate the closure based on the provided information.

            Original issue details:
            ${JSON.stringify(originalIssueData, null, 2)}

            User message: """${messageContent}"""

            Note: An image was also provided, but focus only on the text message to validate if the safety issue has been properly resolved.`,
          },
        ],
      });
    }
    // Fallback case
    else {
      console.log("Fallback validation case");
      input.push({
        role: "user",
        content: [
          {
            type: "input_text",
            text: `A user is replying to close a safety issue. Validate the closure based on the provided information.

            Original issue details:
            ${JSON.stringify(originalIssueData, null, 2)}

            User message: """${messageContent || "(no text)"}"""

            ${
              mediaUrl ? "An image is provided. " : "No image provided. "
            }Validate that the message indicates the safety issue has been properly resolved.`,
          },
        ],
      });
    }

    // Only run LLM validation if we haven't already set validationResult (image-only case)
    if (!validationResult) {
      try {
        console.log("Calling OpenAI for validation");

        const response = await withOpenAIRetry(
          async () => {
            return await getOpenAI().responses.create({
              model: "gpt-4.1",
              input,
              tools,
              tool_choice: "auto",
              store: true,
              metadata,
            });
          },
          `validateSafetyIssue(${senderDetails?.name || "unknown"})`,
        );

        console.log("OpenAI response received");

        if (response.output && response.output.length > 0) {
          for (const toolCall of response.output) {
            if (toolCall.type === "function_call" && toolCall.name === "validate_image_correspondence") {
              validationResult = JSON.parse(toolCall.arguments);
              console.log(`Validation result:`, validationResult);
              break;
            }
          }
        }

        if (!validationResult) {
          validationResult = {
            isValid: false,
            confidence: 0,
            reason:
              "Could not process the validation. Please try again with a clear message showing the resolved issue.",
          };
        }
      } catch (error) {
        console.error("Error in validation:", error);
        validationResult = {
          isValid: false,
          confidence: 0,
          reason: "An error occurred while validating the issue closure. Please try again.",
        };
      }
    }

    // Common processing logic for both text-based and image-based validation
    console.log(`Final validation result:`, validationResult);

    if (validationResult && validationResult.isValid) {
      const rowIndex = structuredData.findIndex((item) => item["S/N"] === originalIssueData["S/N"]);

      if (rowIndex >= 0) {
        // Use message timestamp instead of current timestamp
        let messageTimestamp;
        try {
          const rawTimestamp = senderDetails?.timestamp || new Date().toISOString();

          // Handle Unix timestamps (seconds) that need to be converted to milliseconds
          let processedTimestamp;
          if (
            typeof rawTimestamp === "number" ||
            (typeof rawTimestamp === "string" && /^\d{10,13}$/.test(rawTimestamp))
          ) {
            // Convert to number if it's a string
            const unixTimestamp = typeof rawTimestamp === "number" ? rawTimestamp : parseInt(rawTimestamp, 10);

            // Unix timestamps are typically 10 digits for seconds, 13+ digits for milliseconds
            const milliseconds = unixTimestamp < 10000000000 ? unixTimestamp * 1000 : unixTimestamp;
            processedTimestamp = new Date(milliseconds);
            console.log(`Converted Unix timestamp ${rawTimestamp} to Date object: ${processedTimestamp.toISOString()}`);
          } else {
            // Use as-is for ISO strings or other date formats
            processedTimestamp = new Date(rawTimestamp);
          }

          // Format to match Created Timestamp style (24-hour, Singapore time, leading apostrophe)
          messageTimestamp = `'${formatHumanReadableTimestamp(processedTimestamp)}`;
        } catch (error) {
          console.error("Error formatting message timestamp:", error);
          messageTimestamp = `'${formatHumanReadableTimestamp(new Date())}`; // Fallback to current time
        }

        const updateData = {
          issueId: originalIssueData["S/N"],
          rowIndex: rowIndex + 1,
          status: "closed",
          timestamp: messageTimestamp,
          mediaUrl: mediaUrl ? `=image("${mediaUrl}",2)` : "",
          sheetName: closeSheetName, // write the close to the issue's tab (current or previous month)
        };

        const rowNumber = await updateStructuredData(updateData, senderDetails, groupConfig);

        if (rowNumber) {
          return {
            filters: { quotedMessageId },
            resultMsg: `Successfully validated and closed issue #${originalIssueData["S/N"]}: ${originalIssueData.Description}`,
          };
        } else {
          return {
            filters: { quotedMessageId },
            resultMsg: `Found the issue but couldn't update it. Please try again.`,
          };
        }
      } else {
        return {
          filters: { quotedMessageId },
          resultMsg: `Could not find the issue to update in the database.`,
        };
      }
    } else if (validationResult && !validationResult.isValid) {
      return {
        filters: { quotedMessageId },
        resultMsg: `Validation failed: ${validationResult.reason}\n\nPlease provide a clearer image showing that the safety issue has been properly resolved.`,
      };
    } else {
      return {
        filters: { quotedMessageId },
        resultMsg: `Could not validate the issue closure. Please provide a clearer image or description showing that the safety issue has been fixed.`,
      };
    }
  } catch (error) {
    console.error("Error in updateSafetyIssues:", error);
    return {
      functionName: null,
      arguments: null,
      resultMsg: "An error occurred while processing your request. Please try again.",
    };
  }
}

// =============================================================================
// COMMENTED OUT: createWBGTReading - replaced by API-triggered processWBGTReadingFromAPI
// WhatsApp message/image-triggered WBGT tracking is no longer used.
// The new flow: API request -> fetch from Supabase -> processWBGTReadingFromAPI
// =============================================================================
/*
 * Creates WBGT reading entries from messages
 * @param {string|object} message - The message content or message object
 * @param {string} mediaUrl - URL of any attached media
 * @param {string} caption - Caption text for media
 * @param {object} senderDetails - Details about the message sender
 * @returns {Promise<object>} - Result of the WBGT reading creation

async function createWBGTReading(message, mediaUrl = null, caption = null, senderDetails = null, groupConfig = null) {
  const messageContent = typeof message === 'object' ? message.body : message;

  const tools = [
    {
      type: 'function',
      name: 'extract_wbgt_reading',
      description: 'Extract structured WBGT reading data from messages',
      parameters: {
        type: 'object',
        properties: {
          reading_value: {
            type: 'number',
            description: 'WBGT temperature reading in Celsius',
          },
        },
        required: ['reading_value'],
      },
    },
  ];

  const input = [
    {
      role: 'system',
      content: `You are an assistant that extracts structured WBGT (Wet Bulb Globe Temperature) reading data from messages.
      
      Guidelines for extraction:
      - Extract the numerical WBGT temperature value in Celsius`,
    },
    {
      role: 'user',
      content: mediaUrl
        ? [
            {
              type: 'input_text',
              text: `Analyze this WBGT reading and extract all structured data.
        Do not reply with a text summary. Only call the function with the extracted data.
        Message: "${messageContent}"
        ${caption ? `Caption: "${caption}"` : ''}`,
            },
            {
              type: 'input_image',
              image_url: mediaUrl,
            },
          ]
        : [
            {
              type: 'input_text',
              text: `Analyze this WBGT reading and extract all structured data.
        Do not reply with a text summary. Only call the function with the extracted data.
        Message: "${messageContent}"`,
            },
          ],
    },
  ];

  try {
    console.log('Calling OpenAI with function definitions for WBGT reading');

    const response = await withOpenAIRetry(async () => {
      return await getOpenAI().responses.create({
        model: 'gpt-4.1',
        input,
        tools,
        store: true,
        metadata,
      });
    }, `createWBGTReading(${senderDetails?.name || 'unknown'})`);

    console.log('OpenAI response received for WBGT reading');

    if (response.output && response.output.length > 0) {
      for (const toolCall of response.output) {
        if (toolCall.type === 'function_call' && toolCall.name === 'extract_wbgt_reading') {
          const wbgtData = JSON.parse(toolCall.arguments);
          console.log('Extracted WBGT data:', wbgtData);

          // Validate temperature range
          const temperature = wbgtData.reading_value;
          if (temperature < 20 || temperature > 50) {
            console.warn(`⚠️ WBGT temperature ${temperature}°C is outside normal range (20-50°C)`);
          }

          // Determine heat stress level and follow-up action
          const heatStressInfo = determineHeatStressLevel(temperature);
          console.log(`Heat stress level determined: ${heatStressInfo.level} for temperature ${temperature}°C`);

          const followUpMessage = heatStressInfo.message;

          // Use message timestamp instead of current timestamp
          let messageTimestamp;
          try {
            const rawTimestamp = senderDetails?.timestamp || new Date().toISOString();

            const convertToDate = (value) => {
              if (value === null || value === undefined) {
                return new Date();
              }

              if (typeof value === 'number' && Number.isFinite(value)) {
                const millis = value < 1e12 ? value * 1000 : value;
                return new Date(millis);
              }

              if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
                const numeric = Number(value.trim());
                const millis = numeric < 1e12 ? numeric * 1000 : numeric;
                return new Date(millis);
              }

              const parsed = new Date(value);
              return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
            };

            const timestampDate = convertToDate(rawTimestamp);
            messageTimestamp = formatDateTimeForSheet(timestampDate);
          } catch (error) {
            console.error('Error formatting message timestamp for WBGT:', error);
            messageTimestamp = formatDateTimeForSheet(new Date()); // Fallback to current time
          }

          const wbgtItemsWithMetadata = [
            {
              timestamp: messageTimestamp,
              ...wbgtData,
              mediaUrl: mediaUrl ? `=image("${mediaUrl}",2)` : '',
              messageContent: messageContent || followUpMessage, // Fallback to heat stress message if no text
            },
          ];

          console.log('Writing WBGT data to sheet');
          const count = await writeGenericData(
            wbgtItemsWithMetadata,
            groupConfig?.wbgtSheetName || 'WBGT',
            null,
            senderDetails,
            {
              includeSerialNumber: true,
              spreadsheetId: groupConfig?.wbgtSpreadsheetId,
            },
          );

          // Write to monthly monitoring sheet
          console.log('[WBGT] Writing to monthly monitoring sheet');
          try {
            const rawTimestamp = senderDetails?.timestamp || new Date().toISOString();
            const convertToDate = (value) => {
              if (value === null || value === undefined) {
                return new Date();
              }
              if (typeof value === 'number' && Number.isFinite(value)) {
                const millis = value < 1e12 ? value * 1000 : value;
                return new Date(millis);
              }
              if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
                const numeric = Number(value.trim());
                const millis = numeric < 1e12 ? numeric * 1000 : numeric;
                return new Date(millis);
              }
              const parsed = new Date(value);
              return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
            };
            const timestampDate = convertToDate(rawTimestamp);
            await writeToMonthlyMonitoringSheet(temperature, timestampDate, groupConfig);
          } catch (error) {
            console.error('[WBGT] Monthly write failed (non-blocking):', error);
            // Continue - don't fail main WBGT write
          }

          // Send WhatsApp reply to the thermometer image
          let followUpSent = false;
          try {
            const chatId = typeof message === 'object' ? message.from : null;
            const quotedMessageId = senderDetails?.messageIdSerialized || null;
            if (chatId && quotedMessageId && !process.env.USE_LOCAL_ENV) {
              await sendWhatsAppReply(
                chatId,
                followUpMessage,
                '6587842038',
                30000,
                quotedMessageId, // Quote the thermometer image message
              );
              console.log('✅ WBGT follow-up action sent successfully');
              followUpSent = true;
            } else {
              console.warn('⚠️ Cannot send follow-up: missing chatId or messageIdSerialized');
            }
          } catch (error) {
            console.error('❌ Error sending WBGT follow-up action:', error);
            // Don't fail the whole operation if reply fails
          }

          return {
            success: true,
            message: `Successfully recorded ${count} WBGT reading(s)${
              followUpSent ? ' and sent follow-up action' : ''
            }`,
            data: wbgtItemsWithMetadata,
            heatStressLevel: heatStressInfo.level,
            followUpSent,
          };
        }
      }
    }

    return {
      success: false,
      message: 'No WBGT reading data could be extracted from the message',
    };
  } catch (error) {
    console.error('Error in createWBGTReading:', error);
    return {
      success: false,
      message: 'Error processing WBGT reading',
      error: error.message,
    };
  }
}
*/
// END OF COMMENTED OUT createWBGTReading function
// =============================================================================

/**
 * Determines heat stress level and follow-up action based on WBGT temperature
 * Temperature thresholds:
 * - 31 and below: Low (green)
 * - 31 to 32.9: Medium (orange)
 * - 33 and above: High (red)
 * @param {number} temperature - WBGT temperature in Celsius
 * @returns {object} - { level, displayLevel, message }
 */
function determineHeatStressLevel(temperature) {
  if (temperature < 31) {
    return {
      level: "LOW",
      displayLevel: `${temperature.toFixed(1)}°C (Low)`,
      message: `🟢 *WBGT Reading:* ${temperature.toFixed(1)}°C (Below 31°C)
*Heat Stress Level:* Low

*Health Advisory:*
1) Rehydrate regularly.
2) Provide cool or cold drinking water supply work areas.
3) Ensure workers get adequate rest under shade for recovery from heat.
4) Rest area to be near work areas, where feasible.
5) Monitor WBGT every hourly.
6) Identify workers vulnerable for heat stress.`,
    };
  } else if (temperature >= 31 && temperature < 32) {
    return {
      level: "MODERATE",
      displayLevel: `${temperature.toFixed(1)}°C (Moderate)`,
      message: `🟡 *WBGT Reading:* ${temperature.toFixed(1)}°C (31°C to <32°C)
*Heat Stress Level:* Moderate

*Health Advisory:*
1) Provide cool or cold drinking water supply work areas.
2) Rehydrate at least hourly. (Recommended intake of 300ml per hour).
3) Monitor WBGT every hourly.
4) Identify workers vulnerable for heat stress.`,
    };
  } else if (temperature >= 32 && temperature < 33) {
    return {
      level: "MODERATE",
      displayLevel: `${temperature.toFixed(1)}°C (Moderate)`,
      message: `🟠 *WBGT Reading:* ${temperature.toFixed(1)}°C (32°C to <33°C)
*Heat Stress Level:* Moderate

*Health Advisory:*
1) Provide cool or cold drinking water supply work areas.
2) Rehydrate at least hourly. (Recommended intake of 300ml per hour).
3) Provide hourly rest breaks of a minimum of 10 minutes for heavy physical works activity.
4) Monitor WBGT every hourly.
5) Implement Buddy system; workers to look out for each other for sign of heat related illnesses.`,
    };
  } else {
    // >= 33
    return {
      level: "HIGH",
      displayLevel: `${temperature.toFixed(1)}°C (High)`,
      message: `🔴 *WBGT Reading:* ${temperature.toFixed(1)}°C (33°C and above)
*Heat Stress Level:* High

*Health Advisory:*
1) Provide cool or cold drinking water supply work areas.
2) Rehydrate at least hourly. (Recommended intake of 300ml per hour).
3) Provide hourly rest breaks of a minimum of 15 minutes for heavy physical works activity.
4) Ensure workers get adequate rest under shade for recovery from heat.
5) Rest area to be near work areas, where feasible.
6) Monitor WBGT every hourly.
7) Reschedule outdoor physical work to cooler parts of the day.
8) Close monitoring of workers health condition, particularly for vulnerable workers.
9) Implement Buddy system; workers to look out for each other for sign of heat related illnesses.
10) Longer rest periods recommended as WBGT increase.`,
    };
  }
}

/**
 * Process WBGT reading from API request (not from WhatsApp message/image)
 * Fetches reading value from external source and applies the same processing logic
 * @param {number} readingValue - WBGT temperature reading in Celsius
 * @param {Date} timestamp - Timestamp for the reading (typically current server time)
 * @param {string} chatId - WhatsApp group ID to send notification to
 * @param {object} groupConfig - Group configuration for spreadsheet IDs and sheet names
 * @param {string} readingTimestamp - Formatted timestamp of when the reading was recorded (e.g., "05-Jan-2026 11:04")
 * @returns {Promise<object>} - Result of the processing operation
 */
async function processWBGTReadingFromAPI(readingValue, timestamp, chatId, groupConfig, readingTimestamp = "") {
  try {
    console.log(`[WBGT API] Processing WBGT reading: ${readingValue}°C for chatId: ${chatId}`);

    // Validate temperature range
    if (readingValue < 20 || readingValue > 50) {
      console.warn(`⚠️ WBGT temperature ${readingValue}°C is outside normal range (20-50°C)`);
    }

    // Determine heat stress level and follow-up action
    const heatStressInfo = determineHeatStressLevel(readingValue);
    console.log(`[WBGT API] Heat stress level determined: ${heatStressInfo.level} for temperature ${readingValue}°C`);

    // Add reading timestamp to the message
    let followUpMessage = heatStressInfo.message;
    if (readingTimestamp) {
      followUpMessage += `\n\n_Updated at: ${readingTimestamp}_`;
    }

    // Format timestamp for sheet
    const messageTimestamp = formatDateTimeForSheet(timestamp);

    const wbgtItemsWithMetadata = [
      {
        timestamp: messageTimestamp,
        reading_value: readingValue,
        mediaUrl: "",
        messageContent: followUpMessage,
      },
    ];

    // Write to WBGT sheet
    console.log("[WBGT API] Writing WBGT data to sheet");
    const count = await writeGenericData(
      wbgtItemsWithMetadata,
      groupConfig?.wbgtSheetName || "WBGT",
      null,
      null, // No sender details for API-triggered
      {
        includeSerialNumber: true,
        spreadsheetId: groupConfig?.wbgtSpreadsheetId,
      },
    );

    // Write to monthly monitoring sheet
    console.log("[WBGT API] Writing to monthly monitoring sheet");
    try {
      await writeToMonthlyMonitoringSheet(readingValue, timestamp, groupConfig);
    } catch (error) {
      console.error("[WBGT API] Monthly write failed (non-blocking):", error);
      // Continue - don't fail main WBGT write
    }

    // Send WhatsApp message (using sendWhatsAppMessage, not sendWhatsAppReply which requires quotedMessageId)
    let messageSent = false;
    try {
      if (chatId && !process.env.USE_LOCAL_ENV) {
        await sendWhatsAppMessage(chatId, followUpMessage, "6587842038", 30000);
        console.log("[WBGT API] ✅ WBGT message sent successfully");
        messageSent = true;
      } else if (!chatId) {
        console.warn("[WBGT API] ⚠️ Cannot send message: missing chatId");
      }
    } catch (error) {
      console.error("[WBGT API] ❌ Error sending WBGT message:", error);
      // Don't fail the whole operation if message fails
    }

    return {
      success: true,
      message: `Successfully processed WBGT reading${messageSent ? " and sent notification" : ""}`,
      data: {
        readingValue,
        heatStressLevel: heatStressInfo.level,
        timestamp: messageTimestamp,
        sheetUpdated: count > 0,
        messageSent,
      },
    };
  } catch (error) {
    console.error("[WBGT API] Error in processWBGTReadingFromAPI:", error);
    return {
      success: false,
      message: "Error processing WBGT reading",
      error: error.message,
    };
  }
}

/**
 * Clones an existing safety issue with new sender details
 * Used when a user replies "Same" to an existing safety issue
 * @param {object} existingIssueRow - The existing safety issue row data from sheet
 * @param {object} senderDetails - Details about the new sender
 * @param {object} groupConfig - Optional group configuration overrides
 * @returns {Promise<object>} - Result of the clone operation
 */
async function cloneSafetyIssue(existingIssueRow, senderDetails, groupConfig = null) {
  try {
    console.log(`🔄 [CLONE] Cloning safety issue #${existingIssueRow["S/N"]} for new sender: ${senderDetails?.name}`);

    // Extract date from message timestamp
    let messageDate;
    try {
      const messageTimestamp = senderDetails?.timestamp || new Date().toISOString();
      const sgDateTime = convertToSingaporeTime(messageTimestamp, { format: "iso" });
      messageDate = sgDateTime.split("T")[0]; // Extract YYYY-MM-DD part
    } catch (error) {
      console.error("Error extracting date from message timestamp:", error);
      messageDate = new Date().toISOString().split("T")[0]; // Fallback to current date
    }

    // Extract image URL from existing issue (strip =image() formula if present)
    let imageUrl = "";
    if (existingIssueRow.Image) {
      const imageValue = String(existingIssueRow.Image);
      if (imageValue.toLowerCase().startsWith("=image(")) {
        // Extract URL from =image("url",2) format
        const match = imageValue.match(/=image\("([^"]+)"[,\s]*\d*\)/i);
        imageUrl = match ? match[1] : "";
      } else {
        imageUrl = imageValue;
      }
    }

    // Create cloned issue data
    const clonedIssueData = {
      description: existingIssueRow.Description || "",
      category: existingIssueRow.Category || "",
      location: existingIssueRow.Location || "",
      severity: existingIssueRow.Severity || "",
      proposed_fix: existingIssueRow["Proposed Fix"] || "Not specified",
      mediaUrl: imageUrl ? `=image("${imageUrl}",2)` : "",
      status: "open", // Always open for cloned issues
    };

    console.log(`📋 [CLONE] Cloned data:`, {
      description: clonedIssueData.description?.substring(0, 50),
      category: clonedIssueData.category,
      location: clonedIssueData.location,
      severity: clonedIssueData.severity,
      hasImage: !!imageUrl,
    });

    // Write cloned issue to sheet. Mirrors createSafetyIssue's appendFields so col 14
    // (ChatGroup) is populated from the cloning sender's chatName, not left blank.
    const count = await writeGenericData(
      [clonedIssueData],
      groupConfig?.safetySheetName || "Safety",
      null,
      senderDetails,
      {
        includeSerialNumber: true,
        prependFields: [messageDate],
        appendFields: ["", "", "", senderDetails?.chatName || ""],
        spreadsheetId: groupConfig?.spreadsheetId,
      },
    );

    console.log(`✅ [CLONE] Successfully cloned safety issue. New S/N will be auto-generated.`);

    return {
      success: true,
      message: `Cloned safety issue from #${existingIssueRow["S/N"]}`,
      clonedFrom: existingIssueRow["S/N"],
      clonedData: clonedIssueData,
    };
  } catch (error) {
    console.error("❌ [CLONE] Error cloning safety issue:", error);
    return {
      success: false,
      error: error.message,
      message: "Failed to clone safety issue",
    };
  }
}

/**
 * Handle a deleted WhatsApp message by removing the corresponding safety issue row from the sheet.
 * Called BEFORE intent classification — no LLM call needed.
 * @param {object} message - The deletion event message (contains parentMsgKey referencing the original)
 * @param {object} groupConfig - Group configuration overrides
 * @returns {Promise<object|null>} - Result of the deletion or null if not found on safety sheet
 */
async function handleDeletedSafetyMessage(message, groupConfig = null) {
  const parentMsgKey = message?.parentMsgKey;

  if (!parentMsgKey) {
    console.log("[Safety Delete] No parentMsgKey in deleted message, skipping");
    return null;
  }

  try {
    // Look up the original message in Supabase to get its messageId
    const { data: originalMessages, error } = await getSupabaseClient()
      .from("whatsapp_listener")
      .select("messageId")
      .eq("messageIdSerialized", parentMsgKey)
      .eq("from", message.from)
      .order("created_at", { ascending: false })
      .limit(1);

    if (error) {
      console.error("[Safety Delete] Error querying Supabase for original message:", error);
      return null;
    }

    if (!originalMessages || originalMessages.length === 0) {
      console.log(`[Safety Delete] Original message not found in DB for parentMsgKey: ${parentMsgKey}`);
      return null;
    }

    const messageId = originalMessages[0].messageId;
    console.log(`[Safety Delete] Found original messageId: ${messageId}`);

    // Find the corresponding row on the safety sheet
    const existingRow = await findExistingSafetyIssueRow({ messageId }, groupConfig);

    if (!existingRow) {
      console.log(`[Safety Delete] No safety issue row found for messageId: ${messageId}`);
      return null;
    }

    const rowNumber = existingRow.RowNumber;
    const targetSpreadsheetId = groupConfig?.spreadsheetId;
    // Delete from the tab the row actually lives in (current OR previous month).
    const targetSheetName = existingRow.__SourceSheet__ || groupConfig?.safetySheetName || DEFAULT_SAFETY_SHEET_NAME;

    if (!targetSpreadsheetId || !targetSheetName) {
      console.warn("[Safety Delete] No spreadsheet ID or sheet name available. Skipping deletion.");
      return null;
    }

    console.log(`[Safety Delete] Deleting row ${rowNumber} from "${targetSheetName}" for messageId: ${messageId}`);
    await deleteRow(targetSpreadsheetId, targetSheetName, rowNumber);

    return {
      deleted: true,
      rowNumber,
      messageId,
    };
  } catch (error) {
    console.error("[Safety Delete] Error handling deleted message:", error);
    return null;
  }
}

/**
 * Handle an edited WhatsApp message by re-extracting safety data and updating the sheet row.
 * Called BEFORE intent classification — uses its own extraction LLM call.
 * @param {object} message - The edited message object
 * @param {object} senderDetails - Sender metadata
 * @param {object} groupConfig - Group configuration overrides
 * @returns {Promise<object|null>} - Result of the update or null if not found on safety sheet
 */
async function handleEditedSafetyMessage(message, senderDetails, groupConfig = null) {
  const messageId = senderDetails?.messageId;

  if (!messageId) {
    console.log("[Safety Edit] No messageId in edited message, skipping");
    return null;
  }

  try {
    // Find the corresponding row on the safety sheet
    const existingRow = await findExistingSafetyIssueRow({ messageId }, groupConfig);

    if (!existingRow) {
      console.log(`[Safety Edit] No safety issue row found for messageId: ${messageId}`);
      return null;
    }

    console.log(`[Safety Edit] Found existing issue at row ${existingRow.RowNumber} for messageId: ${messageId}`);

    // Mirror the creation-gate rule: a safety issue requires BOTH image and text.
    // The image attached to the original message can't be removed via a WhatsApp
    // edit (only text is editable), and edit events frequently arrive WITHOUT
    // mediaFilename even when the original image is still present — so we can't
    // reliably check for image here. The only edit-driven rule violation we
    // can detect is the user clearing the text. In that case, delete the row.
    const editedBody = ((typeof message === "object" ? message.body : message) || "").toString().trim();
    if (!editedBody) {
      const targetSpreadsheetId = groupConfig?.spreadsheetId;
      const targetSheetName = existingRow.__SourceSheet__ || groupConfig?.safetySheetName || DEFAULT_SAFETY_SHEET_NAME;
      if (!targetSpreadsheetId || !targetSheetName) {
        console.warn(`[Safety Edit] Edit cleared text but no spreadsheet/sheet name available — leaving row untouched`);
        return null;
      }
      console.log(`[Safety Edit] Edit cleared text — deleting row ${existingRow.RowNumber} (image+text rule)`);
      await deleteRow(targetSpreadsheetId, targetSheetName, existingRow.RowNumber);
      return {
        edited: true,
        deleted: true,
        rowNumber: existingRow.RowNumber,
        messageId,
        reason: "edit cleared text",
      };
    }

    const messageContent = typeof message === "object" ? message.body : message;

    // Call OpenAI to re-extract safety data from the edited text (text only, no image)
    const tools = [
      {
        type: "function",
        name: "extract_safety_issue",
        description: "Extract structured safety issue data from messages",
        parameters: {
          type: "object",
          properties: {
            description: {
              type: "string",
              description: "Description of the safety issue or observation",
            },
            category: {
              type: "string",
              enum: [
                "FYI",
                "Good Observation",
                "Access",
                "Working at Height/Falling hazard",
                "Overhead/Falling object hazard",
                "Cranes/ heavy equipment",
                "Excavation/Trenching/Confined Spaces",
                "Fire/Explosion Hazard",
                "Scaffolds/ supports",
                "Equipment",
                "Electrical hazard",
                "Security /facilities",
                "Trips/slips/Protruding hazards",
                "Personal protective equipment",
                "Health hazard",
                "Public safety",
                "Vehicular hazard",
                "Other hazards",
              ],
              description:
                "Category - use FYI for informational items, Good Observation for positive behaviors, or specific hazard category for problems",
            },
            location: {
              type: "string",
              description: "Location of the safety issue or observation",
            },
            severity: {
              type: "string",
              enum: ["P1", "P2", "P3", "N/A"],
              description:
                "Priority level (P1: High risk/immediate, P2: Medium risk/24hrs, P3: Low risk/1week, N/A: ONLY for FYI and Good Observation)",
            },
            proposed_fix: {
              type: "string",
              description:
                'Suggested solution or fix for the safety issue, if mentioned in the caption or message. MUST ALWAYS USE "Not specified" for FYI and Good Observation.',
            },
          },
          required: ["description", "category", "location", "severity", "proposed_fix"],
        },
      },
    ];

    const input = [
      {
        role: "system",
        content: safetyExtractionPrompt,
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `Analyze this safety issue and extract all structured data.

        Do not reply with a text summary. Only call the function with the extracted data.

        Message: "${messageContent}"`,
          },
        ],
      },
    ];

    const response = await withOpenAIRetry(
      async () => {
        return await getOpenAI().responses.create({
          model: "gpt-4.1",
          temperature: 0,
          input,
          tools,
          store: true,
          metadata,
        });
      },
      `handleEditedSafetyMessage(${senderDetails?.name || "unknown"})`,
    );

    if (!response.output || response.output.length === 0) {
      console.warn("[Safety Edit] No function calls in OpenAI response");
      return null;
    }

    let extractedData = null;
    for (const toolCall of response.output) {
      if (toolCall.type === "function_call" && toolCall.name === "extract_safety_issue") {
        extractedData = JSON.parse(toolCall.arguments);
        break;
      }
    }

    if (!extractedData) {
      console.warn("[Safety Edit] No extract_safety_issue function call in response");
      return null;
    }

    // Build issueData from extracted fields — this project's schema (no contract, no type_of_observation)
    const issueData = {
      description: extractedData.description || "",
      category: extractedData.category || "",
      location: extractedData.location || "",
      severity: extractedData.severity || "",
      proposed_fix: extractedData.proposed_fix || "",
      pic: typeof extractedData.pic === "string" ? extractedData.pic : "",
    };

    // PIC resolution from @mentions in the edited body (same as create path): strip any
    // raw mention id, then override with resolved real names when available. Non-blocking.
    let resolvedEditPic = stripMentionIds(issueData.pic);
    if (groupConfig?.spreadsheetId) {
      try {
        const { picText } = await resolvePicFromMentions(messageContent, groupConfig.spreadsheetId);
        if (picText) resolvedEditPic = picText;
      } catch (e) {
        console.warn("[PIC @mention edit] resolution failed (non-blocking):", e.message);
      }
    }
    issueData.pic = resolvedEditPic;

    // Calculate messageDate from senderDetails.timestamp
    let messageDate;
    try {
      const messageTimestamp = senderDetails?.timestamp || new Date().toISOString();
      const sgDateTime = convertToSingaporeTime(messageTimestamp, { format: "iso" });
      messageDate = sgDateTime.split("T")[0];
    } catch (error) {
      console.error("[Safety Edit] Error extracting date from timestamp:", error);
      messageDate = new Date().toISOString().split("T")[0];
    }

    // Update the existing row — full update (not album update), preserves Image, S/N, Image After Rectification
    await updateExistingSafetyIssueRow({
      existingRow,
      issueData,
      senderDetails,
      messageDate,
      groupConfig,
      isAlbumUpdate: false,
    });

    console.log(`[Safety Edit] Successfully updated row ${existingRow.RowNumber} for messageId: ${messageId}`);

    return {
      edited: true,
      rowNumber: existingRow.RowNumber,
      messageId,
    };
  } catch (error) {
    console.error("[Safety Edit] Error handling edited message:", error);
    return null;
  }
}

/**
 * Handle a reply to the bot's "please tag the PIC" ask. The reply's `quotedBody` carries the
 * "[ref: PIC-<originalMessageId>]" marker; we trace it to the exact issue row and fill its
 * PIC from the reply's @mentions — the SAME flow as the create path (resolvePicFromMentions).
 *
 * Returns a result object when this IS a PIC follow-up (caller should stop processing), or
 * null when `quotedBody` has no PIC marker (let normal processing continue).
 */
async function handlePicFollowupReply(message, senderDetails = null, groupConfig = null) {
  const quotedBody = typeof message === "object" ? message.quotedBody : null;
  const originalMessageId = parsePicRef(quotedBody);
  if (!originalMessageId) return null; // not a PIC follow-up

  console.log(`[PIC followup] reply detected → original messageId ${originalMessageId}`);

  const existingRow = await findExistingSafetyIssueRow(
    { messageId: originalMessageId, parentMessageId: originalMessageId },
    groupConfig,
  );
  if (!existingRow) {
    console.warn(`[PIC followup] no safety row found for messageId ${originalMessageId} — ignoring.`);
    return { picFollowup: true, notFound: true };
  }

  const body = typeof message === "object" ? message.body : message;
  let picText = "";
  let resolvedArr = [];
  try {
    ({ picText, resolved: resolvedArr } = await resolvePicFromMentions(body, groupConfig?.spreadsheetId));
    resolvedArr = resolvedArr || [];
  } catch (e) {
    console.warn("[PIC followup] resolvePicFromMentions failed (non-blocking):", e.message);
  }

  // If the reporter tagged someone we can't bridge to Novade (listener/raw) and Novade is
  // enabled, pivot into the multi-turn enrichment flow instead of writing a raw @id / bare name.
  const followupUnresolved = resolvedArr.filter((e) => e.source === "listener" || e.source === "raw");
  if (followupUnresolved.length && picEnrichAdapter.hasNovade() && groupConfig?.spreadsheetId) {
    const baseNames = resolvedArr
      .filter((e) => e.source === "namelist")
      .map((e) => e.novadeName || e.display)
      .filter(Boolean);
    if (baseNames.length) {
      await updateExistingSafetyIssueRow({
        existingRow,
        issueData: { pic: baseNames.join(", ") },
        senderDetails: null,
        messageDate: null,
        groupConfig,
        isAlbumUpdate: true,
      });
    }
    await startPicEnrichment({
      message,
      senderDetails,
      groupConfig,
      anchorId: originalMessageId,
      baseNames,
      unresolvedMentions: followupUnresolved,
      adapter: picEnrichAdapter,
    });
    return { picFollowup: true, enrichStarted: true };
  }

  if (!picText) {
    // Decision: give up silently — leave PIC blank, send no message.
    console.log(`[PIC followup] no resolvable PIC in reply "${body}" — leaving blank (silent).`);
    return { picFollowup: true, unresolved: true };
  }

  await updateExistingSafetyIssueRow({
    existingRow,
    issueData: { pic: picText },
    senderDetails: null, // preserve the original messageId in the Sender column
    messageDate: null,
    groupConfig,
    isAlbumUpdate: true, // partial update — only the PIC cell is written
  });
  console.log(`[PIC followup] row ${existingRow.RowNumber} (S/N ${existingRow["S/N"]}) PIC → "${picText}"`);

  try {
    // Quote the reporter's reply — sendWhatsAppReply needs the SERIALIZED id to quote.
    const replyToSerialized = message.messageIdSerialized || message.messageId || null;
    await sendWhatsAppReply(
      message.chatId || message.from,
      `✅ PIC recorded: ${picText} (S/N ${existingRow["S/N"]})`,
      undefined,
      undefined,
      replyToSerialized,
    );
  } catch (e) {
    console.warn("[PIC followup] ack reply failed (non-blocking):", e.message);
  }

  return { picFollowup: true, updatedRow: existingRow.RowNumber, pic: picText };
}

module.exports = {
  createSafetyIssue,
  updateSafetyIssues,
  parsePicRef,
  buildPicRequestMessage,
  handlePicFollowupReply,
  // createWBGTReading, // Commented out - replaced by API-triggered processWBGTReadingFromAPI
  processWBGTReadingFromAPI,
  determineHeatStressLevel,
  findExistingSafetyIssueRow,
  cloneSafetyIssue,
  checkAndRotateSheetIfNewMonth,
  ensureSafetySheetExists,
  SAFETY_SHEET_HEADERS,
  handleDeletedSafetyMessage,
  handleEditedSafetyMessage,
  updateExistingSafetyIssueRow,
  resolveAlbumParentMessageId,
};
