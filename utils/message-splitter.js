/**
 * WhatsApp message splitter.
 *
 * WhatsApp's per-message limit is ~4096 characters. When the QA agent's
 * answer is longer than that, we split it into multiple sequential messages
 * at NATURAL boundaries — paragraph break first, then line break, then word
 * break — so each part is readable on its own. The user always sees the
 * COMPLETE answer; nothing gets truncated.
 *
 * Each part (except the last) ends with "(more ↓)" so the reader knows
 * to scroll for the rest. Subsequent parts begin with "(...continued)" so
 * a chunk picked up mid-scroll has context.
 *
 * Usage:
 *   const parts = splitForWhatsApp(longMessage);
 *   for (const p of parts) await sendWhatsAppReply(chatId, p, ...);
 */

// Safely below WhatsApp's hard limit so the threading marker fits.
const DEFAULT_MAX_CHARS = 3800;

/**
 * Split text into chunks ≤ maxChars. Splits at natural boundaries:
 *   1. Paragraph break (\n\n)
 *   2. Single newline (\n)
 *   3. Sentence boundary (`. ` / `? ` / `! `)
 *   4. Word boundary (space)
 *   5. Hard split (worst case)
 *
 * @param {string} text
 * @param {number} [maxChars]
 * @returns {string[]} — at least one element; ≥2 only when input exceeded maxChars
 */
function splitForWhatsApp(text, maxChars = DEFAULT_MAX_CHARS) {
  const s = String(text || "");
  if (s.length <= maxChars) return [s];

  const parts = [];
  let remaining = s;
  while (remaining.length > maxChars) {
    const cut = findCutPoint(remaining, maxChars);
    parts.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) parts.push(remaining);

  // Add continuation markers when there's more than one part.
  if (parts.length > 1) {
    for (let i = 0; i < parts.length; i++) {
      const continuationHeader = i > 0 ? `_(...continued ${i + 1}/${parts.length})_\n\n` : "";
      const moreFooter = i < parts.length - 1 ? "\n\n_(more ↓)_" : "";
      parts[i] = `${continuationHeader}${parts[i]}${moreFooter}`;
    }
  }
  return parts;
}

/**
 * Find the best place to cut within the first `maxChars` of text.
 * Order of preference: paragraph break > newline > sentence > space > hard.
 *
 * @param {string} text
 * @param {number} maxChars
 * @returns {number} character index to cut at
 */
function findCutPoint(text, maxChars) {
  // Search backwards from maxChars for the best natural boundary.
  const halfMax = Math.floor(maxChars / 2);
  // 1. Paragraph break
  const para = text.lastIndexOf("\n\n", maxChars);
  if (para >= halfMax) return para;
  // 2. Line break
  const line = text.lastIndexOf("\n", maxChars);
  if (line >= halfMax) return line;
  // 3. Sentence boundary
  for (const marker of [". ", "? ", "! "]) {
    const idx = text.lastIndexOf(marker, maxChars);
    if (idx >= halfMax) return idx + 1;
  }
  // 4. Word break
  const space = text.lastIndexOf(" ", maxChars);
  if (space >= halfMax) return space;
  // 5. Hard split (text has no natural breaks in this window)
  return maxChars;
}

module.exports = { splitForWhatsApp, __test: { findCutPoint, DEFAULT_MAX_CHARS } };
