/**
 * Safety Image bypass handler ("send screenshot of safety issues …").
 *
 * Triggered when the parser routes a question to domain='safety_image'
 * (see usecases/qa_agent_v2/data/safety_image.js for the marker plugin and
 * usecases/qa_agent_v2/parser/parse-intent.js for routing rules).
 *
 * SCALE — this MUST NOT call captureSafetyImage monolithically. A large set
 * (e.g. "send screenshot of all safety issues last month") would put hundreds of
 * photo-bearing rows into ONE sheet and export a single ~80 MB / multi-page PDF.
 * The PDF→PNG converter re-downloads the whole PDF per page and times out at
 * 60s/page (the exact prod failure fixed for the Novade preview on 2026-06-05).
 * Instead we resolve the matching S/Ns once (window + filters) and render the
 * screenshot in small CHUNKS via renderSafetyListPhotoImages — each chunk is its
 * own ~7 MB single-page PDF that converts in seconds, well under the timeout.
 *
 * Returns {message, imageUrls, imageCaptions} for the QA agent dispatcher to send
 * each chunk as a separate WA image.
 */

const { buildWhere } = require("../../health_safety/safety-image");
const { renderSafetyListPhotoImages, SAFETY_SCREENSHOT_RENDER } = require("../safety_list_image");
const { runSQLQuery } = require("../../../utils/action");

function tagsFromFilters(filters) {
  const statusFilter = filters.find((f) => String(f.field || "").toLowerCase() === "status");
  const sevFilter = filters.find((f) => String(f.field || "").toLowerCase() === "severity");
  const tags = [];
  if (statusFilter?.value) tags.push(String(statusFilter.value));
  if (sevFilter?.value) tags.push(String(sevFilter.value));
  return tags;
}

async function handleSafetyImage(intent, _chatId, groupConfig) {
  const dateWindow = intent?.time_window || { kind: "all_time", start_iso: null, end_iso: null, label: "all time" };
  const filters = intent?.filters || [];
  const tags = tagsFromFilters(filters);

  // 1. Resolve the matching S/Ns ONCE (same window + filters captureSafetyImage
  //    would have used). renderSafetyListPhotoImages re-queries each chunk by
  //    S/N-IN within the window, so the pre-filter here fully encodes the
  //    status/severity/etc. filters.
  let sns = [];
  try {
    const where = buildWhere(dateWindow, filters);
    const rows =
      (await runSQLQuery(`SELECT [S/N] FROM safetyData WHERE ${where} ORDER BY [Date] ASC, [S/N] ASC`, "safety", {
        groupConfig,
      })) || [];
    sns = rows
      .map((r) => r["S/N"])
      .filter((s) => s !== null && s !== undefined && String(s).trim() !== "")
      .map(String);
  } catch (e) {
    console.error(`[QA Agent] safety-image bypass S/N query failed:`, e?.stack || e);
    return { message: `Sorry, I couldn't generate the safety screenshot: ${e?.message || "unknown error"}.` };
  }

  if (!sns.length) {
    const tagPart = tags.length ? `${tags.join(" ")} ` : "";
    return { message: `✅ No ${tagPart}safety issues for ${dateWindow.label || "today"}.` };
  }

  // 2. Render in chunks (small PDFs → no 60s/page converter timeout at scale).
  const tagSuffix = tags.length ? ` (${tags.join(" / ")})` : "";
  const titlePrefix = `Safety${tagSuffix} — ${dateWindow.label || "today"}`;
  let rendered;
  try {
    rendered = await renderSafetyListPhotoImages({
      sns,
      dateWindow,
      groupConfig,
      titlePrefix,
      ...SAFETY_SCREENSHOT_RENDER, // compact columns + 5 issues/image
    });
  } catch (e) {
    console.error(`[QA Agent] safety-image bypass render failed:`, e?.stack || e);
    return { message: `Sorry, I couldn't generate the safety screenshot: ${e?.message || "unknown error"}.` };
  }

  const imageUrls = (rendered && rendered.imageUrls) || [];
  if (!imageUrls.length) {
    return { message: `Sorry, I couldn't generate the safety screenshot (no images were produced).` };
  }

  // 3. Captions — one per image, page-numbered when multi-image. Mirror the old
  //    truncation note but point at the chunked-render cap (not a PDF page cap).
  const total = imageUrls.length;
  const baseCaption = `📋 Safety${tagSuffix} — ${dateWindow.label || "today"} (${sns.length} total)`;
  const captions = total === 1 ? [baseCaption] : imageUrls.map((_, i) => `${baseCaption} — Page ${i + 1} of ${total}`);

  if (rendered.truncated) {
    const spreadsheetId = groupConfig?.safetySpreadsheetId || process.env.SAFETY_SPREADSHEET_ID;
    const sheetUrl = spreadsheetId ? `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit` : null;
    captions[captions.length - 1] +=
      `\n⚠️ Showing the first ${total} image(s) — narrow the date range or filter to see the rest.` +
      (sheetUrl ? `\nFull sheet: ${sheetUrl}` : "");
  }

  return {
    message: captions[0],
    imageUrls,
    imageCaptions: captions,
    counts: { total: sns.length },
    truncated: !!rendered.truncated,
  };
}

module.exports = { handleSafetyImage };
