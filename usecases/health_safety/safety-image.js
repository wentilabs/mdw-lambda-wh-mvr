/**
 * Safety Sheet — screenshot primitive.
 *
 * Triggered by QA agent questions like:
 *   "@joey send screenshot of open issues today in safety sheet"
 *   "@joey send screenshot of P1 issues yesterday"
 *   "@joey send screenshot of closed issues on 2026-05-08"
 *
 * Flow (mirrors the MDR screenshot primitive):
 *   1. Read safety rows via the existing runSQLQuery('safety') path — same
 *      filter semantics the analytical safety domain uses (Date filter from
 *      window, Status / Severity / Category / Location filters from intent).
 *   2. Project each row to a canonical screenshot layout (skip JSON blob
 *      columns like Sender / Updated By — extract just `.name`).
 *   3. Create a temp tab on the safety spreadsheet, populate with title +
 *      header + colored data rows (severity-driven: P1 red, P2 yellow).
 *   4. Export as multi-page PDF (scale=2 fit-to-width so rows stay readable).
 *   5. Convert each PDF page → PNG at DPI 300.
 *   6. Delete the temp tab in `finally`.
 *
 * Returns { imageUrls, pageCount, pagesSent, truncated, counts, sections,
 *           tempTab, pdfUrl } — same shape as captureMasterRegisterImage so
 * the bypass handler + dispatch loop reuse the existing multi-image flow.
 */

const axios = require("axios");
const { v4: uuidv4 } = require("uuid");

const {
  createNewSheet,
  writeArrayToGSheet,
  setRowBackgroundColorBatch,
  mergeCells,
  deleteSheet,
  exportSheetAsPdf,
  extractPdfPageCount,
  batchFormatSheet,
  updateCell,
} = require("../../utils/gsheet");
const { runSQLQuery, normalizeDateForDisplay } = require("../../utils/action");

const SCRAPE_API_URL = process.env.SCRAPE_API_URL || "https://api.scrape.wentilabs.com";
const SUPABASE_BUCKET = "manpower-data-pdfs";

const RED_BG = Object.freeze({ red: 0.95, green: 0.3, blue: 0.3 });
const YELLOW_BG = Object.freeze({ red: 1.0, green: 0.95, blue: 0.55 });
const GREEN_BG = Object.freeze({ red: 0.78, green: 0.91, blue: 0.78 });
const HEADER_BG = Object.freeze({ red: 0.85, green: 0.85, blue: 0.85 });
const TITLE_BG = Object.freeze({ red: 0.23, green: 0.49, blue: 0.49 }); // #3a7d7d

const DEFAULT_MAX_IMAGES = 10;

// Canonical temp-sheet column layout. Picked from the safety sheet's most
// useful fields — drops JSON blob cols (raw Sender / Updated By dicts) and
// the binary Image columns. IMAGE AFTER (post-rectification photo) lives
// directly to the right of IMAGE so a reviewer can compare before/after at
// a glance for closed issues. Empty for open issues — that's fine.
const CANONICAL_COLS = Object.freeze({
  sn: 0, // A
  date: 1, // B
  severity: 2, // C
  status: 3, // D
  category: 4, // E
  location: 5, // F
  description: 6, // G — wide
  proposedFix: 7, // H — medium
  image: 8, // I — =IMAGE(url, 2) formula copied verbatim from source sheet
  imageAfter: 9, // J — =IMAGE(url, 2) formula, empty for open issues
  sender: 10, // K — extracted .name
  updatedBy: 11, // L — extracted .name
  updatedAt: 12, // M
});
const CANONICAL_HEADER = Object.freeze([
  "S/N",
  "DATE",
  "SEVERITY",
  "STATUS",
  "CATEGORY",
  "LOCATION",
  "DESCRIPTION",
  "PROPOSED FIX",
  "IMAGE",
  "IMAGE AFTER",
  "RAISED BY",
  "UPDATED BY",
  "UPDATED AT",
]);
const LAST_COL_EXCLUSIVE = CANONICAL_HEADER.length;

// ---------------------------------------------------------------------------
// Column LAYOUT profiles. captureSafetyImage renders whatever profile it's
// given (default = CANONICAL). A profile owns: the header labels, the SQL
// column list to SELECT, how a raw safety row maps to cells, and per-column
// pixel widths. rowColor() stays profile-agnostic (reads raw r.Severity/Status).
//
// CRITICAL: the Novade sync preview depends on the CANONICAL layout — its
// `readPreviewRows` reads the temp tab by FIXED column index (0..12) and the
// augmented cols 13-18 sit right after. Novade calls captureSafetyImage with NO
// layout arg → CANONICAL → byte-identical. Do NOT change CANONICAL_HEADER /
// CANONICAL_COLS / the canonical buildCells order. Add new profiles instead.
// ---------------------------------------------------------------------------
const CANONICAL_LAYOUT = Object.freeze({
  key: "canonical",
  header: CANONICAL_HEADER,
  sqlCols:
    "[S/N], [Date], [Description], [Category], [Location], [Severity], [Proposed Fix], [Status], [Image], [Image After Rectification], [Sender], [Updated Timestamp], [Updated By]",
  // Order MUST match CANONICAL_COLS exactly (readPreviewRows relies on it).
  buildCells: (r) => [
    r["S/N"] ?? "",
    r.Date ?? "",
    r.Severity ?? "",
    r.Status ?? "",
    r.Category ?? "",
    r.Location ?? "",
    r.Description ?? "",
    r["Proposed Fix"] ?? "",
    r.Image ?? "",
    r["Image After Rectification"] ?? "",
    extractName(r.Sender),
    extractName(r["Updated By"]),
    r["Updated Timestamp"] ?? "",
  ],
  columnWidths: [
    { colIdx: CANONICAL_COLS.sn, pixelSize: 55 },
    { colIdx: CANONICAL_COLS.date, pixelSize: 90 },
    { colIdx: CANONICAL_COLS.severity, pixelSize: 75 },
    { colIdx: CANONICAL_COLS.status, pixelSize: 75 },
    { colIdx: CANONICAL_COLS.category, pixelSize: 120 },
    { colIdx: CANONICAL_COLS.location, pixelSize: 95 },
    { colIdx: CANONICAL_COLS.description, pixelSize: 290 },
    { colIdx: CANONICAL_COLS.proposedFix, pixelSize: 200 },
    { colIdx: CANONICAL_COLS.image, pixelSize: 140 },
    { colIdx: CANONICAL_COLS.imageAfter, pixelSize: 140 },
    { colIdx: CANONICAL_COLS.sender, pixelSize: 120 },
    { colIdx: CANONICAL_COLS.updatedBy, pixelSize: 120 },
    { colIdx: CANONICAL_COLS.updatedAt, pixelSize: 130 },
  ],
  rowHeight: 100,
  // 13 wide cols fill an A3-landscape page; keep it exactly as-is (Novade).
  page: { size: "A3", orientation: "landscape", scale: 2, margin: 0.1 },
});

// COMPACT — used ONLY by the safety-issue SCREENSHOT paths (analytical "show me
// … as image" + "send screenshot of …"). Fewer columns so each photo is bigger
// and the table reads cleanly on a phone. Drops Category/Location/Proposed Fix/
// Image After/Updated By/Updated At; ADDS Created Timestamp (normalised from the
// sheet's Excel serial — the reader only humanises the Date column, not the
// timestamp columns). NOT used by Novade.
const COMPACT_LAYOUT = Object.freeze({
  key: "compact",
  header: ["S/N", "DATE", "CREATED", "SEVERITY", "STATUS", "DESCRIPTION", "RAISED BY", "IMAGE"],
  sqlCols: "[S/N], [Date], [Created Timestamp], [Severity], [Status], [Description], [Sender], [Image]",
  buildCells: (r) => [
    r["S/N"] ?? "",
    r.Date ?? "",
    normalizeDateForDisplay(r["Created Timestamp"]),
    r.Severity ?? "",
    r.Status ?? "",
    r.Description ?? "",
    extractName(r.Sender),
    r.Image ?? "",
  ],
  columnWidths: [
    { colIdx: 0, pixelSize: 55 }, // S/N
    { colIdx: 1, pixelSize: 90 }, // DATE
    { colIdx: 2, pixelSize: 140 }, // CREATED
    { colIdx: 3, pixelSize: 80 }, // SEVERITY
    { colIdx: 4, pixelSize: 80 }, // STATUS
    { colIdx: 5, pixelSize: 360 }, // DESCRIPTION (wider — room freed by dropped cols)
    { colIdx: 6, pixelSize: 130 }, // RAISED BY
    { colIdx: 7, pixelSize: 200 }, // IMAGE (bigger photo)
  ],
  // WHITE-SPACE TUNING. Two independent margins were eating the image:
  //  • Right white — the 8 narrow cols didn't fill an A3 page. Fixed by the
  //    tighter A4-landscape page + zero margins below.
  //  • Bottom white — the export page height is FIXED, so a chunk of rows only
  //    fills it if the rows are tall enough. Short rows (the earlier 85px try)
  //    left the bottom half empty. The screenshot chunks at 5 rows/image, so we
  //    size each row to ≈ (A4-landscape data height)/5 → a full 5-row image
  //    FILLS the page (no bottom white) AND the before-photo renders bigger.
  //    A partial last chunk (1-4 rows) still leaves some bottom white — inherent
  //    to a fixed page size without bitmap cropping. Env-tunable: if the page
  //    splits into 2 images lower it; if there's still bottom white raise it.
  rowHeight: Math.max(40, parseInt(process.env.QA_SAFETY_SCREENSHOT_ROW_HEIGHT || "140", 10)),
  page: {
    size: process.env.QA_SAFETY_SCREENSHOT_PAGE_SIZE || "A4",
    orientation: "landscape",
    scale: 2,
    margin: 0,
  },
});

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function todayLabelSGT() {
  const d = new Date();
  return `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

/**
 * Current SGT date+time formatted as "26-May-2026 5:30 PM" for the screenshot
 * TITLE ROW only — gives customers full context for "when was this snapshot
 * taken?". Includes the date because the customer may be viewing the image
 * days later and the time-of-day alone is ambiguous.
 *
 * MUST NOT be used in any field returned by the bypass handler (caption,
 * message, etc.) — would break the v2 consistency test (different H:MM per
 * run → different bytes). The temp tab is deleted after the PNG is rendered,
 * so this value lives only in the image pixels.
 */
function formatNowSGTDateTime() {
  // Build "DD-MMM-YYYY h:mm AM/PM" by formatting parts in Asia/Singapore.
  const now = new Date();
  // Date parts via en-GB (DD/MM/YYYY) for unambiguous day/month split.
  const datePartsRaw = now.toLocaleDateString("en-GB", { timeZone: "Asia/Singapore" }); // "26/05/2026"
  const [dd, mm, yyyy] = datePartsRaw.split("/");
  const dateStr = `${parseInt(dd, 10)}-${MONTHS[parseInt(mm, 10) - 1]}-${yyyy}`;
  const timeStr = now.toLocaleTimeString("en-US", {
    timeZone: "Asia/Singapore",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return `${dateStr} ${timeStr}`;
}

/**
 * Format an ISO date (YYYY-MM-DD) to DD-MMM-YYYY (e.g. "18-May-2026").
 * Used for the screenshot title row so customers always see the ACTUAL
 * calendar date, not the parser's natural-language label ("yesterday",
 * "today", "this week"). Title-side only — labels still flow through to
 * captions where they read more naturally.
 */
function formatIsoAsDDMMMYYYY(iso) {
  if (!iso || typeof iso !== "string") return "";
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  const [, y, mm, d] = m;
  const monthIdx = Math.max(0, Math.min(11, parseInt(mm, 10) - 1));
  return `${parseInt(d, 10)}-${MONTHS[monthIdx]}-${y}`;
}

/**
 * Build the title's date segment from the parser's dateWindow.
 *   single  →  "18-May-2026"
 *   range   →  "18-May-2026 → 25-May-2026"
 *   all_time / fallback → label or "all time"
 */
function formatDateWindowForTitle(dateWindow) {
  if (!dateWindow) return "";
  if (dateWindow.kind === "single" && dateWindow.start_iso) {
    return formatIsoAsDDMMMYYYY(dateWindow.start_iso);
  }
  if (dateWindow.kind === "range" && dateWindow.start_iso && dateWindow.end_iso) {
    return `${formatIsoAsDDMMMYYYY(dateWindow.start_iso)} → ${formatIsoAsDDMMMYYYY(dateWindow.end_iso)}`;
  }
  return dateWindow.label || "all time";
}

/**
 * The Sender / Updated By cells in the safety sheet are JSON-encoded dicts
 * with a `name` field plus chat metadata. Extract just the name for display.
 */
function extractName(jsonOrText) {
  if (jsonOrText == null) return "";
  const s = String(jsonOrText).trim();
  if (!s) return "";
  if (!s.startsWith("{")) return s; // plain text fallback
  try {
    const parsed = JSON.parse(s);
    return String(parsed?.name || "").trim();
  } catch {
    // Sender column sometimes has a Sheets-prefix tick or extra trailing chars
    // that break JSON.parse — fall back to the raw string (truncated).
    return s.length > 30 ? s.slice(0, 30) + "…" : s;
  }
}

/**
 * Build the WHERE clause to push to runSQLQuery. Mirrors what
 * usecases/qa_agent_v2/data/safety.js does so the screenshot uses the same
 * row scope as the analytical safety domain.
 */
function buildWhere(dateWindow, filters) {
  const parts = [];
  if (dateWindow?.kind === "single") {
    parts.push(`[Date] = '${dateWindow.start_iso}'`);
  } else if (dateWindow?.kind === "range") {
    parts.push(`[Date] >= '${dateWindow.start_iso}' AND [Date] <= '${dateWindow.end_iso}'`);
  }
  for (const f of filters || []) {
    if (!f?.field) continue;
    const fld = `[${f.field}]`;
    const escape = (v) => String(v ?? "").replace(/'/g, "''");
    switch (f.op) {
      case "=":
        parts.push(`UPPER(${fld}) = UPPER('${escape(f.value)}')`);
        break;
      case "!=":
        parts.push(`UPPER(${fld}) != UPPER('${escape(f.value)}')`);
        break;
      case "in":
        // AlaSQL chokes on `UPPER(col) IN (UPPER('a'), UPPER('b'))` (silently
        // returns 0 rows for multi-value IN) AND `UPPER(...)` returns null on
        // numeric columns like S/N. Use `CAST AS STRING IN (...)` instead —
        // sheet data is already case-normalised so dropping UPPER here is safe.
        if (Array.isArray(f.values) && f.values.length) {
          parts.push(`CAST(${fld} AS STRING) IN (${f.values.map((v) => `'${escape(v)}'`).join(", ")})`);
        }
        break;
      case "like":
        parts.push(`UPPER(${fld}) LIKE UPPER('%${escape(f.value)}%')`);
        break;
    }
  }
  return parts.length ? parts.join(" AND ") : "1=1";
}

/**
 * Severity → row background. Closed rows always get cleared (no highlight)
 * so the customer's at-a-glance "what needs attention" view stays clean.
 */
function rowColor(severity, status) {
  if (String(status || "").toLowerCase() === "closed") return null;
  const sev = String(severity || "").toUpperCase();
  if (sev === "P1") return RED_BG;
  if (sev === "P2") return YELLOW_BG;
  if (sev === "GOOD OBSERVATION" || sev === "GO") return GREEN_BG;
  return null;
}

async function populateTempSheet(spreadsheetId, tempTabName, title, rows, layout = CANONICAL_LAYOUT) {
  const lastCol = layout.header.length;
  const cells = [];
  // Row 1: title (merged after write)
  const titleRow = new Array(lastCol).fill("");
  titleRow[0] = title;
  cells.push(titleRow);
  // Row 2: header
  cells.push(layout.header.slice());

  const highlightEntries = [];
  for (const r of rows) {
    // r.Image arrives as the raw IMAGE formula string (e.g.
    // `=IMAGE("https://...",2)`) because readGoogleSheet uses
    // valueRenderOption=FORMULA. Writing it verbatim into the temp tab makes
    // the formula re-evaluate there → the photo renders inline in the PDF/PNG.
    cells.push(layout.buildCells(r));
    const dataRowNum = cells.length; // 1-based
    const color = rowColor(r.Severity, r.Status);
    if (color) {
      highlightEntries.push({ rowNumber: dataRowNum, startCol: 0, endCol: lastCol, color });
    }
  }

  await writeArrayToGSheet(spreadsheetId, tempTabName, cells, { skipFormatting: true });

  // Title row: merge across all cols + teal background.
  try {
    await mergeCells(spreadsheetId, tempTabName, {
      startRow: 0,
      endRow: 1,
      startCol: 0,
      endCol: lastCol,
    });
  } catch (e) {
    console.warn(`[safety-image] title merge failed: ${e?.message || e}`);
  }

  // Header row coloring + title-row coloring.
  await setRowBackgroundColorBatch(spreadsheetId, tempTabName, [
    { rowNumber: 1, startCol: 0, endCol: lastCol, color: TITLE_BG },
    { rowNumber: 2, startCol: 0, endCol: lastCol, color: HEADER_BG },
  ]);

  if (highlightEntries.length > 0) {
    await setRowBackgroundColorBatch(spreadsheetId, tempTabName, highlightEntries);
  }

  // Column widths + text wrap + date alignment.
  await applyTempSheetFormatting(spreadsheetId, tempTabName, cells.length, layout);

  return { totalRowsWritten: cells.length };
}

async function applyTempSheetFormatting(spreadsheetId, tempTabName, lastRowExclusive, layout = CANONICAL_LAYOUT) {
  // Single full-width format for ALL data cells: wrap text + top-align + LEFT
  // horizontal align. Sheets defaults numeric cells (S/N) to right-aligned
  // which looks inconsistent next to the left-aligned text columns — force
  // every column to LEFT so the customer's eye scans cleanly down each col.
  // The Image column is a formula rendering a photo; alignment is moot but
  // included so the format request stays a single range.
  const wrapItems = [
    {
      range: { startRow: 2, endRow: lastRowExclusive, startCol: 0, endCol: layout.header.length },
      format: { wrapStrategy: "WRAP", verticalAlignment: "TOP", horizontalAlignment: "LEFT" },
      fields:
        "userEnteredFormat.wrapStrategy,userEnteredFormat.verticalAlignment,userEnteredFormat.horizontalAlignment",
    },
  ];
  // Pixel widths tuned for A3 landscape at scale=2 (fit-to-width). Owned by the
  // active layout profile (canonical = 13 cols; compact = 8 cols, bigger photo).
  const columnWidths = layout.columnWidths;
  // Row heights: data rows (rows 3..N, 0-indexed = 2..lastRowExclusive) need
  // room for the IMAGE formula to render the photo at a readable size.
  // Default Sheets row height is 21px — way too short for an image cell.
  // 100px gives a square-ish thumbnail at the 140px column width.
  const rowPx = layout.rowHeight || 100;
  const rowHeights = lastRowExclusive > 2 ? [{ rowIdx: 2, endRowIdx: lastRowExclusive, pixelSize: rowPx }] : [];
  try {
    await batchFormatSheet(spreadsheetId, tempTabName, { cellFormats: wrapItems, columnWidths, rowHeights });
  } catch (e) {
    console.warn(`[safety-image] applyTempSheetFormatting failed (continuing): ${e?.message || e}`);
  }
}

async function exportAndConvertPages({
  spreadsheetId,
  tempTabName,
  lastRow,
  maxImagesPerSend,
  lastCol = LAST_COL_EXCLUSIVE,
  page = {},
}) {
  const { getSupabaseClient } = require("../../utils/common");
  const supabase = getSupabaseClient();

  const pdfBuffer = await exportSheetAsPdf(spreadsheetId, tempTabName, {
    lastRow,
    lastCol,
    orientation: page.orientation || "landscape",
    scale: page.scale || 2,
    size: page.size || "A3",
    margin: page.margin, // undefined → exportSheetAsPdf default (0.1)
  });
  const pageCount = extractPdfPageCount(pdfBuffer);
  const pagesToConvert = Math.min(pageCount, maxImagesPerSend);
  const truncated = pageCount > maxImagesPerSend;
  console.log(
    `[safety-image] PDF: ${pdfBuffer.length}B, ${pageCount} page(s)` +
      (truncated ? ` — TRUNCATING to first ${pagesToConvert} (cap=${maxImagesPerSend})` : ""),
  );

  const pdfFileName = `safety-image-${uuidv4().slice(0, 8)}.pdf`;
  const { error: upErr } = await supabase.storage
    .from(SUPABASE_BUCKET)
    .upload(pdfFileName, pdfBuffer, { contentType: "application/pdf", upsert: false });
  if (upErr) throw new Error(`PDF upload failed: ${upErr.message}`);
  const { data: signed, error: signErr } = await supabase.storage
    .from(SUPABASE_BUCKET)
    .createSignedUrl(pdfFileName, 3600);
  if (signErr) throw new Error(`Signed URL failed: ${signErr.message}`);
  const pdfUrl = signed.signedUrl;

  const imageUrls = [];
  for (let p = 1; p <= pagesToConvert; p++) {
    const conv = await axios.post(
      `${SCRAPE_API_URL}/api/pdf-to-image`,
      { pdfUrl, page: p, dpi: 300 },
      { timeout: 60000 },
    );
    if (!conv.data?.success || !conv.data?.imageUrl) {
      throw new Error(`PDF→image page ${p} failed: ${JSON.stringify(conv.data)}`);
    }
    imageUrls.push(conv.data.imageUrl);
  }
  return { pdfUrl, pageCount, pagesSent: pagesToConvert, truncated, imageUrls };
}

/**
 * MAIN ENTRY.
 *
 * @param {object} opts
 * @param {object} opts.groupConfig                  group config (must include safetySpreadsheetId)
 * @param {object} opts.dateWindow                   intent.time_window — kind: 'single' | 'range' | 'all_time'
 * @param {Array}  [opts.filters=[]]                 intent.filters — Status / Severity / Category / Location / etc.
 * @param {number} [opts.maxImagesPerSend=10]        hard cap; first N pages sent + `truncated:true` if exceeded
 * @returns {Promise<{imageUrls,pageCount,pagesSent,truncated,pdfUrl,tempTab,
 *                   counts:{total:number}, sections:Array<{...}>}>}
 */
async function captureSafetyImage({
  groupConfig,
  dateWindow,
  filters = [],
  maxImagesPerSend = DEFAULT_MAX_IMAGES,
  // Optional hooks for sibling bypass handlers (e.g. novade_sync preview):
  //   tabNameOverride — supply a deterministic tab name (no auto-uuid suffix).
  //                     Used so the marker [ref:<tabName>] embedded in the
  //                     reply caption can route the user's later "approve"
  //                     back to the exact tab.
  //   titlePrefixOverride — replace the auto-built "Safety <status> <sev> (N) · <date>"
  //                         title prefix. The `· captured <time>` suffix is
  //                         still appended right before the PDF export.
  //   keepTab — skip the finally{deleteSheet}. Caller becomes responsible for
  //             cleanup. The returned `tempTab` is the tab name to delete.
  //   skipImageExport — build + (with keepTab) keep the tab, but DON'T export it
  //             as a PDF or convert pages. Returns imageUrls:[]. The caller is
  //             rendering the images itself — typically in small CHUNKS — to
  //             avoid the monolithic photo PDF that times out the PDF→PNG
  //             converter at scale (a 100-row preview = ~83 MB / 10-page PDF and
  //             the 60s/page converter timed out — prod 2026-06-05). The
  //             novade_sync preview uses this: the tab's DATA (not an image of
  //             it) is the source of truth at approve time, and the WhatsApp
  //             preview images come from renderSafetyListPhotoImages (chunked).
  tabNameOverride,
  titlePrefixOverride,
  keepTab = false,
  skipImageExport = false,
  // Column LAYOUT profile (CANONICAL_LAYOUT default — Novade depends on it).
  // The safety SCREENSHOT paths pass COMPACT_LAYOUT for a fewer-column view.
  layout = CANONICAL_LAYOUT,
}) {
  const spreadsheetId = groupConfig?.safetySpreadsheetId || process.env.SAFETY_SPREADSHEET_ID;
  if (!spreadsheetId)
    throw new Error("captureSafetyImage: safetySpreadsheetId required (group config or SAFETY_SPREADSHEET_ID env)");

  // 1. Read filtered rows via the same runSQLQuery path the analytical safety
  //    domain uses. Pulling all useful columns including Proposed Fix +
  //    Updated Timestamp so the screenshot has the context the customer needs.
  const cols = layout.sqlCols;
  const where = buildWhere(dateWindow, filters);
  let rows = [];
  try {
    const query = `SELECT ${cols} FROM safetyData WHERE ${where} ORDER BY [Date] ASC, [S/N] ASC`;
    rows = (await runSQLQuery(query, "safety", { groupConfig })) || [];
  } catch (e) {
    throw new Error(`safety SQL failed: ${e?.message || e}`);
  }

  const counts = { total: rows.length };

  if (counts.total === 0) {
    return {
      imageUrls: [],
      pageCount: 0,
      pagesSent: 0,
      truncated: false,
      pdfUrl: null,
      tempTab: null,
      counts,
      sections: [],
      message: "no safety rows matched the filters — nothing to screenshot",
    };
  }

  // 2. Build temp tab name. Encode date + status filter for human-readable
  //    tab title; uuid suffix for collision safety on concurrent calls.
  const today = todayLabelSGT();
  // dateLabel (for the tab NAME) keeps the natural-language form for readability
  // when audits see leftover tabs. titleDate (for the TITLE ROW) is the actual
  // calendar date — customers want to see "18-May-2026", not "yesterday".
  const dateLabel = dateWindow?.label || today;
  const titleDate = formatDateWindowForTitle(dateWindow) || dateLabel;
  const statusFilter = (filters || []).find((f) => String(f.field).toLowerCase() === "status");
  const sevFilter = (filters || []).find((f) => String(f.field).toLowerCase() === "severity");
  const tagParts = [];
  if (statusFilter?.value) tagParts.push(String(statusFilter.value).toUpperCase());
  if (sevFilter?.value) tagParts.push(String(sevFilter.value).toUpperCase());
  const tagPart = tagParts.length ? `-${tagParts.join("-")}` : "";
  const suffix = uuidv4().slice(0, 8);
  const tempTabName =
    tabNameOverride || `Safety Screenshot${tagPart} — ${dateLabel.replace(/[^A-Za-z0-9_-]+/g, "-")}-${suffix}`;
  await createNewSheet(spreadsheetId, tempTabName);

  let result;
  try {
    // Build the title WITHOUT the captured-time first; the actual capture
    // moment is when Google Sheets renders the PDF, which is several seconds
    // AFTER the title row is initially written. We rewrite the title cell
    // RIGHT BEFORE exportSheetAsPdf so the timestamp matches the moment the
    // sheet snapshot is taken — that's what "captured" means to the customer.
    let titlePrefix;
    if (titlePrefixOverride) {
      titlePrefix = titlePrefixOverride;
    } else {
      const titleParts = ["Safety"];
      if (statusFilter?.value) titleParts.push(String(statusFilter.value));
      if (sevFilter?.value) titleParts.push(String(sevFilter.value));
      titleParts.push(`(${counts.total})`);
      titleParts.push("·");
      titleParts.push(titleDate);
      titlePrefix = titleParts.join(" ");
    }
    // Placeholder — gets overwritten below. Initial write triggers the
    // merge + background + col-widths in populateTempSheet without forcing
    // the wrong timestamp to render in case of an early exit.
    const titlePlaceholder = `${titlePrefix} · captured —`;

    const { totalRowsWritten } = await populateTempSheet(spreadsheetId, tempTabName, titlePlaceholder, rows, layout);

    let exported;
    if (skipImageExport) {
      // Caller keeps the tab for its DATA (e.g. novade_sync's persistent preview
      // tab) and renders any WhatsApp images itself in small chunks. Skip the
      // monolithic export entirely — that single big PDF is exactly what times
      // out the PDF→PNG converter at scale. No "captured" timestamp either: the
      // tab is never snapshotted here.
      exported = { imageUrls: [], pageCount: 0, pagesSent: 0, truncated: false, pdfUrl: null };
    } else {
      // NOW capture the exact moment of the PDF snapshot. This is the closest
      // we can get to the "moment the image was taken" — Google Sheets reads
      // the sheet state at the time of the export request below.
      const finalTitle = `${titlePrefix} · captured ${formatNowSGTDateTime()}`;
      try {
        // updateCell takes 1-based row + 0-based col → (row=1, col=0) = A1
        // which is the top-left anchor of the merged title row.
        await updateCell(spreadsheetId, tempTabName, 1, 0, finalTitle);
      } catch (e) {
        console.warn(`[safety-image] title rewrite failed (continuing with placeholder): ${e?.message || e}`);
      }

      exported = await exportAndConvertPages({
        spreadsheetId,
        tempTabName,
        lastRow: totalRowsWritten,
        maxImagesPerSend,
        lastCol: layout.header.length,
        page: layout.page,
      });
    }

    result = {
      ...exported,
      tempTab: tempTabName,
      counts,
      sections: [{ tabName: "Safety", count: counts.total }],
    };
  } finally {
    // Skip cleanup when the caller plans to keep the tab around (e.g. the
    // novade_sync preview flow uses the tab as the source of truth for a
    // later "approve" reply; it owns the cleanup after sync completes).
    if (!keepTab) {
      try {
        await deleteSheet(spreadsheetId, tempTabName);
      } catch (e) {
        console.warn(`[safety-image] cleanup failed for "${tempTabName}": ${e?.message || e}`);
      }
    }
  }
  return result;
}

module.exports = {
  captureSafetyImage,
  // Exposed for tests / future reuse.
  extractName,
  buildWhere,
  rowColor,
  CANONICAL_HEADER,
  CANONICAL_COLS,
  CANONICAL_LAYOUT,
  COMPACT_LAYOUT,
};
