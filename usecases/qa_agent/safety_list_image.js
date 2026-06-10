/**
 * QA-agent safety LIST → image flow (WITH before/after photos).
 *
 * "show me first 100 issues this month" produces a v2 `list` answer with many
 * rows. As text it walls into 7 "(...continued X/7)" messages — unreadable on a
 * phone. The user wants the SAME thing "send screenshot" gives: the safety rows
 * rendered as an image, WITH the before/after photos (an issue without its photo
 * is useless).
 *
 * THE SCALE PROBLEM (the prod bug on 2026-05-30): `captureSafetyImage` embeds
 * each row's before+after photos via `=IMAGE()` formulas. Rendering ALL 100 rows
 * into ONE sheet produced a 71 MB / 10-page PDF, and the PDF→PNG converter
 * (which downloads the whole PDF per page) hit its 60s timeout → the handler
 * fell back to the text wall. "send screenshot" has the SAME ceiling — it only
 * works today because people screenshot small FILTERED sets (a handful of rows).
 *
 * THE FIX: keep the EXACT screenshot pipeline (so photos are identical to
 * "send screenshot"), but render the rows in small CHUNKS — each chunk is its
 * own small PDF (≈ chunkRows × ~0.7 MB/row), which converts well under the
 * timeout. We call `captureSafetyImage` once per chunk with an S/N-IN filter
 * (exactly how the novade preview + the screenshot sn_list path already do it),
 * and concatenate the resulting image URLs in order.
 *
 * Architecture: lives in the dispatcher layer (usecases/qa_agent/index.js), NOT
 * the pure/deterministic v2 formatter — image rendering is async + Supabase/PDF
 * IO + non-deterministic URLs, which the formatter contract (and the
 * byte-identical consistency test) forbid. The consistency test calls v2
 * directly and never reaches this code. Mirrors how document_tracking_image.js
 * turns big doc lists into an image at the dispatcher.
 *
 * Uses the v2 answer.rows' S/Ns DIRECTLY (the analytical layer already applied
 * sort + limit), so the image set is exactly the rows the user asked for.
 *
 * Falls back to text (returns null) on any failure or zero images.
 */

const { captureSafetyImage, COMPACT_LAYOUT } = require("../health_safety/safety-image");
const { splitForWhatsApp } = require("../../utils/message-splitter");

// Rows per chunk. TWO constraints set this:
//  1) SIZE — each chunk is its own PDF; keep it small so it converts well under
//     the 60s/page timeout. ~0.7 MB/row (2 photos) ⇒ 10 rows ≈ 7 MB ≈ seconds
//     (the 71 MB / 100-row single PDF is what timed out in prod).
//  2) PAGE FIT — captureSafetyImage renders ~100px-tall rows; a portrait page
//     holds ~11 before it spills to a 2nd page. A chunk LARGER than that page
//     capacity orphans its extra row(s) onto a near-empty trailing image (the
//     bug: CHUNK_ROWS=12 → every chunk = 1 full page + 1 one-row image).
//     10 sits one under the ~11 capacity, so a chunk of 10 real consecutive
//     rows reliably renders as exactly ONE full page = ONE clean image
//     (measured: 3/3 consecutive real chunks = 1 page). With MAX_IMAGES=10 that
//     also covers a full 100-row "first 100" ask in 10 clean images.
// Long-description rows are taller, so a chunk that happens to contain several
// could still spill to 2 pages; perChunkMaxImages (below) keeps that LOSSLESS
// (emits both pages) rather than dropping rows. Tunable via env.
const CHUNK_ROWS = parseInt(process.env.QA_SAFETY_IMAGE_CHUNK_ROWS || "10", 10);
// Hard cap on total images sent for one list, so a huge ask can't spam the chat
// or blow the Lambda budget. Photos are heavy; beyond this we truncate + tell
// the user to narrow the question. Mirrors the "send screenshot" path's
// DEFAULT_MAX_IMAGES (10) so the two flows behave consistently. Tunable via env.
const MAX_IMAGES = parseInt(process.env.QA_SAFETY_IMAGE_MAX_IMAGES || "10", 10);
// How many chunks to render concurrently. captureSafetyImage uses uuid-suffixed
// temp tabs, so parallel chunks don't collide. Small to respect Sheets / scrape
// API limits. Tunable via env.
const CONCURRENCY = Math.max(1, parseInt(process.env.QA_SAFETY_IMAGE_CONCURRENCY || "3", 10));

// SAFETY SCREENSHOT preset — the "show me … as image" + "send screenshot of …"
// paths render the COMPACT column layout (S/N, Date, Created, Severity, Status,
// Description, Raised By, Image) and fewer issues per image so each photo is
// bigger and the table reads cleanly on a phone. The Novade preview does NOT use
// this — it calls renderSafetyListPhotoImages with no layout/chunkRows, so it
// keeps the canonical 13-col layout + default 10-row chunks (unchanged).
const SAFETY_SCREENSHOT_ROWS_PER_IMAGE = Math.max(
  1,
  parseInt(process.env.QA_SAFETY_SCREENSHOT_ROWS_PER_IMAGE || "5", 10),
);
const SAFETY_SCREENSHOT_RENDER = Object.freeze({
  layout: COMPACT_LAYOUT,
  chunkRows: SAFETY_SCREENSHOT_ROWS_PER_IMAGE,
});

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/**
 * Render the given S/Ns (already the analytical answer's sorted+limited set) as
 * one or more safety-sheet screenshot images WITH photos, by chunking the rows.
 *
 * @returns {Promise<{ imageUrls: string[], renderedRows: number, truncated: boolean }>}
 */
async function renderSafetyListPhotoImages({
  sns,
  dateWindow,
  groupConfig,
  titlePrefix,
  layout,
  chunkRows,
  maxImages,
}) {
  // chunkRows / maxImages / layout are OPTIONAL. Callers that omit them (e.g. the
  // Novade preview) get the defaults → canonical 13-col layout, 10 rows/chunk,
  // 10-image cap (unchanged). The safety-screenshot paths pass the COMPACT
  // preset (8 cols, 5 rows/image). captureSafetyImage's own default is canonical,
  // so passing layout:undefined is equivalent to "canonical".
  const rowsPerChunk = Number.isFinite(chunkRows) && chunkRows > 0 ? chunkRows : CHUNK_ROWS;
  const imageCap = Number.isFinite(maxImages) && maxImages > 0 ? maxImages : MAX_IMAGES;
  // A chunk can't produce more pages than it has rows, so capping per-chunk
  // images at rowsPerChunk guarantees a chunk NEVER self-truncates (which would
  // silently drop rows inside the chunk). Global limiting is done by imageCap.
  const perChunkMaxImages = rowsPerChunk;
  const chunks = chunk(
    sns.map((s) => String(s)),
    rowsPerChunk,
  );

  const results = new Array(chunks.length).fill(null); // null = not attempted
  let anyFailure = false;
  let stoppedEarly = false;
  // Process chunks in concurrency-limited waves; preserve chunk order in output.
  for (let i = 0; i < chunks.length; i += CONCURRENCY) {
    const wave = chunks.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      wave.map((snChunk) =>
        captureSafetyImage({
          groupConfig,
          dateWindow,
          filters: [{ field: "S/N", op: "in", value: null, values: snChunk }],
          maxImagesPerSend: perChunkMaxImages,
          titlePrefixOverride: titlePrefix,
          layout,
        }),
      ),
    );
    for (let j = 0; j < settled.length; j++) {
      const idx = i + j;
      if (settled[j].status === "fulfilled") {
        results[idx] = settled[j].value?.imageUrls || [];
      } else {
        anyFailure = true; // a failed chunk drops its rows — must surface, not hide
        console.error(
          `[QA Safety Image] chunk ${idx + 1}/${chunks.length} failed: ${settled[j].reason?.message || settled[j].reason}`,
        );
        results[idx] = [];
      }
    }
    // Early stop once we already have enough images for the cap.
    const got = results.reduce((a, r) => a + (r ? r.length : 0), 0);
    if (got >= imageCap && i + CONCURRENCY < chunks.length) {
      stoppedEarly = true;
      break;
    }
  }

  const ordered = results.filter(Boolean).flat();
  const cappedOut = ordered.length > imageCap;
  const imageUrls = ordered.slice(0, imageCap);
  // truncated = the user is NOT seeing every requested row: we hit the image
  // cap, stopped early before rendering all chunks, OR a chunk failed.
  const truncated = cappedOut || stoppedEarly || anyFailure;
  return { imageUrls, truncated, renderedRows: sns.length };
}

/**
 * @param {object} v2Result  v2 handleQuestion result ({ applies, message, intent, answer, ... })
 * @param {object} groupConfig
 * @returns {Promise<null | { message:string, imageUrls:string[], imageCaptions:string[] }>}
 */
async function maybeRenderSafetyListImage(v2Result, groupConfig) {
  if (!v2Result?.applies) return null;
  const ans = v2Result.answer;
  if (ans?.meta?.domain !== "safety") return null;
  if (ans?.kind !== "list") return null;

  const rows = Array.isArray(ans.rows) ? ans.rows : [];
  if (!rows.length) return null;

  // Trigger: only when the text answer would wall into multiple WhatsApp
  // messages. Small lists stay as (copyable, searchable) text. An optional
  // row-count threshold lets the operator switch to image sooner.
  const threshold = parseInt(process.env.QA_SAFETY_IMAGE_THRESHOLD || "0", 10);
  const wouldWall = splitForWhatsApp(v2Result.message || "").length > 1;
  const overRowThreshold = threshold > 0 && rows.length > threshold;
  if (!wouldWall && !overRowThreshold) return null;

  const intent = v2Result.intent || {};
  const sns = rows.map((r) => r.SN ?? r["S/N"]).filter((s) => s !== null && s !== undefined && String(s).trim() !== "");
  if (!sns.length) return null; // can't address rows by S/N → let text handle it

  const windowLabel = intent.time_window?.label || "";
  const titlePrefix = `Safety Issues${windowLabel ? ` · ${windowLabel}` : ""}`;

  try {
    const { imageUrls, truncated } = await renderSafetyListPhotoImages({
      sns,
      dateWindow: intent.time_window,
      groupConfig,
      titlePrefix,
      ...SAFETY_SCREENSHOT_RENDER, // compact columns + 5 issues/image
    });
    if (!imageUrls.length) return null; // nothing rendered → caller keeps text path

    const filterParts = (intent.filters || [])
      .filter((f) => f && f.field && (f.value != null || (Array.isArray(f.values) && f.values.length)))
      .map((f) => `${f.field}=${f.value != null ? f.value : (f.values || []).join("/")}`)
      .slice(0, 4);
    const filterSuffix = filterParts.length ? ` · ${filterParts.join(", ")}` : "";
    const baseCaption = `📸 Safety Issues${windowLabel ? ` — ${windowLabel}` : ""} (${sns.length})${filterSuffix}`;
    // Mirror the "send screenshot" truncation wording so the two flows feel the
    // same to users.
    const truncNote = truncated
      ? `\n(showing the first ${imageUrls.length} image(s) — narrow the date range or filter to see the rest)`
      : "";

    const total = imageUrls.length;
    const imageCaptions = imageUrls.map((_, i) => (i === 0 ? `${baseCaption}${truncNote}` : `📋 (${i + 1}/${total})`));

    return { message: `${baseCaption}${truncNote}`, imageUrls, imageCaptions };
  } catch (e) {
    console.error(`[QA Safety Image] render failed (falling back to text): ${e?.stack || e}`);
    return null;
  }
}

module.exports = { maybeRenderSafetyListImage, renderSafetyListPhotoImages, SAFETY_SCREENSHOT_RENDER };
