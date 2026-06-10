/**
 * Water Parade handler.
 *
 * A "water parade" (hydration parade) is the routine where site workers are
 * gathered to drink/receive water for heat-stress prevention. As of this
 * feature, water-parade WhatsApp messages are NO LONGER logged as safety issues
 * (Good Observation). They are classified upstream as the `water_parade_entry`
 * intent and routed here, which writes them onto the WBGT log sheet.
 *
 * Placement model (per product owner):
 *   - Find the WBGT row whose column G ("Created Timestamp", the WBGT-sent time,
 *     SGT) is CLOSEST in time to the water parade.
 *   - The first water parade on that row fills the 4-column block H/I/J/K
 *     (Image of Water Parade / Water Parade Timestamp / Sender / Message ID).
 *   - If another water parade maps to the SAME row, append rightward into the
 *     next 4-column block L/M/N/O, then P/Q/R/S, etc. Never overwrite.
 *
 * Timestamp priority (column I): the timestamp embedded in the image watermark
 * is used first (as-is, no TZ conversion — the watermark is already SGT). If the
 * image has no readable timestamp (or there is no image), fall back to the
 * WhatsApp message timestamp converted to SGT.
 *
 * Message ID (column K) is stored so later edits/deletes of the WhatsApp message
 * update / clear the same block.
 *
 * The handler is SILENT — it returns a plain result object with NO `message`
 * key, so the wenti-listener does not auto-send anything to the chat.
 */

const { readGoogleSheet, batchUpdateCells, ensureColumnCount } = require("../../utils/gsheet");
const { retrieveImageFromSupabase } = require("../../utils/action");
const { extractTimestampFromImage, formatHumanReadableTimestamp } = require("../../utils/date");

// ── Column geometry ────────────────────────────────────────────────────────
// 0-based column indices. The WBGT sheet's water-parade blocks start at H (7)
// and repeat every 4 columns: H/I/J/K, then L/M/N/O, P/Q/R/S, ...
const FIRST_BLOCK_START_COL = 7; // H
const BLOCK_WIDTH = 4;
const COL_G_INDEX = 6; // "Created Timestamp"

// Offsets within a 4-column block
const OFFSET_IMAGE = 0; // Image of Water Parade
const OFFSET_TS = 1; // Water Parade Timestamp
const OFFSET_SENDER = 2; // Sender
const OFFSET_ID = 3; // Message ID

const BASE_HEADERS = ["Image of Water Parade", "Water Parade Timestamp", "Sender", "Message ID"];

// Near-duplicate suppression window for album siblings / rapid re-sends from the
// same sender (distinct messageIds, seconds apart).
const NEAR_DUP_WINDOW_MS = 90 * 1000;

const MONTHS = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

/**
 * Parse a WBGT column-G "Created Timestamp" cell into absolute epoch ms.
 *
 * The cell is SGT wall-clock text in the form `DD-MMM-YYYY HH:MM` (optionally
 * with seconds), and the live sheet stores it with a leading/trailing apostrophe
 * (Google-Sheets text marker), e.g. `04-Apr-2026 17:05'`. We strip any
 * surrounding quote/apostrophe noise and interpret the wall-clock as SGT (+08:00).
 *
 * Returns null for anything unparseable (header rows, blanks, junk) — callers
 * skip those rows rather than crash. We deliberately do NOT use the shared
 * parseTimestampToMs() here because it has a history of silently returning
 * Date.now() for apostrophe-suffixed sheet dates.
 *
 * @param {*} cell
 * @returns {number|null} epoch ms, or null
 */
function parseWbgtCreatedTimestamp(cell) {
  if (cell === null || cell === undefined) return null;
  let s = String(cell).trim();
  // Strip surrounding apostrophes / quotes / smart-quotes / backticks / spaces.
  s = s.replace(/^['"`‘’\s]+|['"`‘’\s]+$/g, "").trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})-([A-Za-z]{3,})-(\d{4})[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
  if (mon === undefined) return null;
  const year = parseInt(m[3], 10);
  const hour = parseInt(m[4], 10);
  const minute = parseInt(m[5], 10);
  const second = m[6] ? parseInt(m[6], 10) : 0;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const iso =
    `${year}-${String(mon + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}` +
    `T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}+08:00`;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d.getTime();
}

/**
 * Normalise a WhatsApp message timestamp (unix seconds, unix ms, or ISO string)
 * to absolute epoch ms. Used for the fallback when the image has no watermark.
 * @param {*} ts
 * @returns {number} epoch ms
 */
function normalizeMessageTsMs(ts) {
  if (ts === null || ts === undefined || ts === "") return Date.now();
  if (typeof ts === "number") return ts < 1e11 ? ts * 1000 : ts;
  const str = String(ts).trim();
  if (/^\d{10}$/.test(str)) return parseInt(str, 10) * 1000;
  if (/^\d{13}$/.test(str)) return parseInt(str, 10);
  const d = new Date(str);
  return isNaN(d.getTime()) ? Date.now() : d.getTime();
}

// Max plausible drift between the image-watermark date and the WhatsApp message
// date. Water-parade photos are taken minutes before they are sent, so a large
// drift means the watermark date is wrong (ambiguous MM/DD vs DD/MM camera
// format, or a stale / re-sent photo). Using it would misplace the record onto
// an unrelated day's WBGT row, so we fall back to the message timestamp.
const MAX_IMAGE_DRIFT_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * Resolve the water-parade timestamp.
 *
 * Priority: the image-watermark timestamp (used as-is, no TZ shift —
 * formatHumanReadableTimestamp re-renders the SGT-anchored Date in SGT, so the
 * wall-clock is preserved), provided it is within MAX_IMAGE_DRIFT_MS of the WA
 * message timestamp. Otherwise (no image, no readable watermark, or an
 * implausibly-distant watermark date) fall back to the WA message timestamp,
 * converted to SGT.
 *
 * @param {object} message - needs `.timestamp`
 * @param {string} mediaUrl - signed image URL (may be empty)
 * @param {object} [opts]
 * @param {number} [opts.maxDriftMs=MAX_IMAGE_DRIFT_MS]
 * @returns {Promise<{ms:number, display:string, source:'image'|'message'|'message_drift_fallback'}>}
 */
async function resolveWaterParadeTimestamp(message, mediaUrl, opts = {}) {
  const maxDriftMs = opts.maxDriftMs ?? MAX_IMAGE_DRIFT_MS;
  const messageMs = normalizeMessageTsMs(message && message.timestamp);

  if (mediaUrl) {
    try {
      const imgDate = await extractTimestampFromImage(mediaUrl);
      if (imgDate && !isNaN(imgDate.getTime())) {
        const imgMs = imgDate.getTime();
        if (Math.abs(imgMs - messageMs) <= maxDriftMs) {
          return { ms: imgMs, display: formatHumanReadableTimestamp(imgDate), source: "image" };
        }
        console.warn(
          `[water_parade] image timestamp ${formatHumanReadableTimestamp(imgDate)} drifts >${Math.round(
            maxDriftMs / 86400000,
          )}d from message ${formatHumanReadableTimestamp(new Date(messageMs))} — using message timestamp`,
        );
        return {
          ms: messageMs,
          display: formatHumanReadableTimestamp(new Date(messageMs)),
          source: "message_drift_fallback",
        };
      }
    } catch (e) {
      console.warn(`[water_parade] image timestamp extraction failed: ${e?.message || e}`);
    }
  }
  return { ms: messageMs, display: formatHumanReadableTimestamp(new Date(messageMs)), source: "message" };
}

/**
 * SGT calendar-day key (YYYY-MM-DD) for an absolute epoch-ms value.
 * en-CA locale renders as YYYY-MM-DD; Asia/Singapore anchors it to SGT.
 */
function sgtDayKey(ms) {
  return new Date(ms).toLocaleDateString("en-CA", { timeZone: "Asia/Singapore" });
}

/** 0-based column indices for block N (0 = H/I/J/K). */
function blockCols(blockIndex) {
  const start = FIRST_BLOCK_START_COL + blockIndex * BLOCK_WIDTH;
  return {
    start,
    image: start + OFFSET_IMAGE,
    ts: start + OFFSET_TS,
    sender: start + OFFSET_SENDER,
    id: start + OFFSET_ID,
  };
}

function cellEmpty(v) {
  return v === undefined || v === null || String(v).trim() === "";
}

/**
 * Find the 1-based sheet row whose column G is closest in time to tsMs,
 * RESTRICTED to the SAME SGT calendar day as tsMs. A water parade is never
 * matched onto a different day's WBGT reading — if the sheet has no row on the
 * water parade's day, this returns null (the caller leaves it unplaced).
 * Ties resolve to the FIRST (lowest-index) matching row, deterministically.
 * @returns {number|null} 1-based row index, or null if no same-day parseable G found
 */
function findClosestRowIndex(rows, tsMs) {
  const wpDay = sgtDayKey(tsMs);
  let bestRow = null;
  let bestDiff = Infinity;
  for (let i = 1; i < rows.length; i++) {
    const gms = parseWbgtCreatedTimestamp(rows[i] && rows[i][COL_G_INDEX]);
    if (gms === null) continue;
    if (sgtDayKey(gms) !== wpDay) continue; // SAME SGT DAY ONLY
    const diff = Math.abs(gms - tsMs);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestRow = i + 1; // 1-based
    }
  }
  return bestRow;
}

/** First block index on a row whose Message-ID cell is empty. */
function firstFreeBlockIndex(rowArr) {
  const arr = rowArr || [];
  let b = 0;
  while (b < 4096) {
    const { id } = blockCols(b);
    if (cellEmpty(arr[id])) return b;
    b++;
  }
  return b;
}

/**
 * Scan the whole sheet for a block whose Message-ID cell equals messageId.
 * @returns {{row:number, col:number, blockIndex:number}|null} 1-based row, 0-based start col
 */
function findBlockByMessageId(rows, messageId) {
  if (!messageId) return null;
  const target = String(messageId).trim();
  if (!target) return null;
  for (let i = 1; i < rows.length; i++) {
    const arr = rows[i] || [];
    for (let b = 0; ; b++) {
      const { id, start } = blockCols(b);
      if (id >= arr.length) break;
      if (String(arr[id] || "").trim() === target) {
        return { row: i + 1, col: start, blockIndex: b };
      }
    }
  }
  return null;
}

/**
 * True if the target row already holds a block from the same sender within the
 * dedup window — collapses album siblings / rapid re-sends (distinct messageIds).
 */
function isNearDuplicateOnRow(rowArr, wp, windowMs = NEAR_DUP_WINDOW_MS) {
  if (!rowArr || !wp.senderName) return false;
  const senderLc = wp.senderName.trim().toLowerCase();
  for (let b = 0; ; b++) {
    const { id, sender, ts } = blockCols(b);
    if (id >= rowArr.length) break;
    if (cellEmpty(rowArr[id])) break; // no further filled blocks
    const existingSender = String(rowArr[sender] || "")
      .trim()
      .toLowerCase();
    if (existingSender && existingSender === senderLc) {
      const existingTsMs = parseWbgtCreatedTimestamp(rowArr[ts]);
      if (existingTsMs !== null && Math.abs(existingTsMs - wp.tsMs) <= windowMs) return true;
    }
  }
  return false;
}

/**
 * Place one water-parade record onto the WBGT sheet.
 * @param {object} p
 * @param {string} p.spreadsheetId
 * @param {string} p.sheetName
 * @param {{messageId:string, senderName:string, imageFormula:string, tsDisplay:string, tsMs:number}} p.wp
 * @param {any[][]} [p.rows] - pre-read sheet rows (backfill reuses one read)
 * @returns {Promise<object>} result (never throws on a "can't place" condition)
 */
async function placeWaterParade({ spreadsheetId, sheetName, wp, rows }) {
  const sheet = rows || (await readGoogleSheet(spreadsheetId, sheetName));
  if (!sheet || sheet.length < 2) return { ok: false, reason: "no_rows" };

  // Idempotent: same messageId already written anywhere → no-op.
  const existing = findBlockByMessageId(sheet, wp.messageId);
  if (existing) {
    return { ok: true, deduped: "message_id", row: existing.row, blockStartCol: existing.col };
  }

  const targetRow = findClosestRowIndex(sheet, wp.tsMs);
  if (!targetRow) return { ok: false, reason: "no_same_day_wbgt_row" };

  const rowArr = sheet[targetRow - 1] || [];

  // Album / rapid re-send suppression (distinct messageId, same sender + minute).
  if (isNearDuplicateOnRow(rowArr, wp)) {
    return { ok: true, deduped: "near_duplicate", row: targetRow };
  }

  const blockIndex = firstFreeBlockIndex(rowArr);
  const cols = blockCols(blockIndex);

  const updates = [];

  // New block to the right of H/I/J/K → give it suffixed headers if missing.
  if (blockIndex > 0) {
    const headerRow = sheet[0] || [];
    if (cellEmpty(headerRow[cols.id])) {
      const n = blockIndex + 1;
      updates.push({ row: 1, col: cols.image, value: `${BASE_HEADERS[OFFSET_IMAGE]} ${n}` });
      updates.push({ row: 1, col: cols.ts, value: `${BASE_HEADERS[OFFSET_TS]} ${n}` });
      updates.push({ row: 1, col: cols.sender, value: `${BASE_HEADERS[OFFSET_SENDER]} ${n}` });
      updates.push({ row: 1, col: cols.id, value: `${BASE_HEADERS[OFFSET_ID]} ${n}` });
    }
  }

  if (wp.imageFormula) updates.push({ row: targetRow, col: cols.image, value: wp.imageFormula });
  updates.push({ row: targetRow, col: cols.ts, value: wp.tsDisplay });
  updates.push({ row: targetRow, col: cols.sender, value: wp.senderName || "" });
  updates.push({ row: targetRow, col: cols.id, value: wp.messageId });

  // The grid must be wide enough — blocks spill rightward past column Z.
  await ensureColumnCount(spreadsheetId, sheetName, cols.id + 1);
  await batchUpdateCells(spreadsheetId, sheetName, updates);
  return { ok: true, row: targetRow, blockStartCol: cols.start, blockIndex };
}

/** Resolve {spreadsheetId, sheetName} from group config / env. */
function resolveWbgtTarget(groupConfig) {
  const spreadsheetId = (groupConfig && groupConfig.wbgtSpreadsheetId) || process.env.WBGT_SPREADSHEET_ID;
  const sheetName = (groupConfig && groupConfig.wbgtSheetName) || "WBGT";
  return { spreadsheetId, sheetName };
}

/**
 * Live handler: a message classified as `water_parade_entry`.
 * @returns {Promise<object>} result with NO `message` key
 */
async function handleWaterParade(message, mediaUrl, caption, senderDetails, groupConfig) {
  const { spreadsheetId, sheetName } = resolveWbgtTarget(groupConfig);
  if (!spreadsheetId) {
    console.warn("[water_parade] No WBGT spreadsheet id configured — skipping");
    return { ok: false, reason: "no_spreadsheet" };
  }

  // Phantom image webhook guard: the listener fires a phantom image event with
  // no mediaFilename ~T+0 before the real one. Drop it; the real webhook follows.
  if (message && message.type === "image" && !message.mediaFilename) {
    console.log("[water_parade] dropping phantom image webhook (image type, no mediaFilename)");
    return { ok: false, reason: "phantom_image" };
  }

  const senderName = (senderDetails && senderDetails.name) || (message && message.sender) || "";
  const { ms, display, source } = await resolveWaterParadeTimestamp(message, mediaUrl);
  const wp = {
    messageId: (message && message.messageId) || "",
    senderName,
    imageFormula: mediaUrl ? `=IMAGE("${mediaUrl}", 2)` : "",
    tsDisplay: display,
    tsMs: ms,
  };

  const res = await placeWaterParade({ spreadsheetId, sheetName, wp });
  console.log(
    `💧 [water_parade] messageId=${wp.messageId} sender="${senderName}" ts=${display} (${source}) → ${JSON.stringify(
      res,
    )}`,
  );
  return res; // NO `message` key — handler is silent.
}

/**
 * Edit handler: a previously-written water parade was edited. Returns null if
 * this messageId is NOT a water-parade block (so the caller's other edit
 * handlers / normal flow can take over).
 */
async function handleEditedWaterParadeMessage(message, senderDetails, groupConfig) {
  const { spreadsheetId, sheetName } = resolveWbgtTarget(groupConfig);
  if (!spreadsheetId || !message || !message.messageId) return null;

  const rows = await readGoogleSheet(spreadsheetId, sheetName);
  const found = findBlockByMessageId(rows, message.messageId);
  if (!found) return null;

  let mediaUrl = "";
  if (message.mediaFilename) {
    try {
      mediaUrl = await retrieveImageFromSupabase(message.from, message.mediaFilename);
    } catch (e) {
      console.warn(`[water_parade] edit: failed to resolve media: ${e?.message || e}`);
    }
  }

  const senderName = (senderDetails && senderDetails.name) || message.sender || "";
  const { display } = await resolveWaterParadeTimestamp(message, mediaUrl);
  const cols = blockCols(found.blockIndex);

  const updates = [];
  if (mediaUrl) updates.push({ row: found.row, col: cols.image, value: `=IMAGE("${mediaUrl}", 2)` });
  updates.push({ row: found.row, col: cols.ts, value: display });
  if (senderName) updates.push({ row: found.row, col: cols.sender, value: senderName });

  await batchUpdateCells(spreadsheetId, sheetName, updates);
  console.log(`✏️ [water_parade] EDIT messageId=${message.messageId} → row ${found.row}, block col ${cols.start}`);
  return { ok: true, edited: true, row: found.row, blockStartCol: cols.start };
}

/**
 * Delete handler: clears the water-parade block for a deleted message. Returns
 * null if the message is not a water-parade block (caller continues its chain).
 */
async function handleDeletedWaterParadeMessage(message, groupConfig) {
  const { spreadsheetId, sheetName } = resolveWbgtTarget(groupConfig);
  // Deletion webhooks carry the original id in messageId and/or parentMsgKey.
  const targetId = (message && message.messageId) || (message && message.parentMsgKey);
  if (!spreadsheetId || !targetId) return null;

  const rows = await readGoogleSheet(spreadsheetId, sheetName);
  const found = findBlockByMessageId(rows, targetId);
  if (!found) return null;

  const cols = blockCols(found.blockIndex);
  const updates = [
    { row: found.row, col: cols.image, value: "" },
    { row: found.row, col: cols.ts, value: "" },
    { row: found.row, col: cols.sender, value: "" },
    { row: found.row, col: cols.id, value: "" },
  ];
  await batchUpdateCells(spreadsheetId, sheetName, updates);
  console.log(`🗑️ [water_parade] DELETE cleared messageId=${targetId} → row ${found.row}, block col ${cols.start}`);
  return { ok: true, deleted: true, row: found.row, blockStartCol: cols.start };
}

module.exports = {
  handleWaterParade,
  handleEditedWaterParadeMessage,
  handleDeletedWaterParadeMessage,
  // Helpers exported for unit tests / backfill reuse:
  parseWbgtCreatedTimestamp,
  normalizeMessageTsMs,
  resolveWaterParadeTimestamp,
  findClosestRowIndex,
  firstFreeBlockIndex,
  findBlockByMessageId,
  isNearDuplicateOnRow,
  blockCols,
  placeWaterParade,
  resolveWbgtTarget,
};
