// Multi-turn "PIC enrichment" conversation.
//
// When a tagged PIC "@<lid>" can't be resolved to a curated Name List person, we (a) gather
// the missing details, (b) fuzzy-match the person against the Novade people list, (c) ask the
// reporter to confirm the right one, then append a Name List record and set the safety issue's
// PIC — so the PIC becomes a real Novade name that bridges to the action assignee/created-by.
//
// State is STATELESS / marker-encoded: a compact base64url(JSON) payload inside a
// "[ref: PICENRICH-<payload>]" token that the bot embeds in every message. WhatsApp echoes the
// bot's full text back in `message.quotedBody` when the reporter reply-quotes, so we recover the
// exact conversation state (which safety issue, stage, queue, collected name/phone, candidate
// list) on each reply — no DB, anchored to the original issue's messageId. Candidates are
// carried in the marker so the numeric pick is deterministic and never re-queried.
//
// Gated on Novade by the per-repo adapter (adapter.hasNovade()). The adapter also supplies the
// fuzzy candidate provider, the Name List tab name, and the per-repo row layout.

const { getOpenAI } = require("./openai");
const { writeArrayToGSheetRow } = require("./gsheet");
const { loadNameList, invalidateNameListCache } = require("./name-list");
const { sendWhatsAppReply } = require("./sendMessage");

// Distinct namespace — never collides with "[ref: PIC-<id>]" (PICENRICH ≠ PIC-) or
// "[ref: Novade-Preview-...]". base64url charset [A-Za-z0-9_-] matches the capture (no padding).
const PICENRICH_MARKER_RE = /\[ref:\s*PICENRICH-([A-Za-z0-9_-]+)\s*\]/i;
const MAX_CANDIDATES = 5;
const MAX_RETRY = 2;

// ─────────────────────────── marker encode/decode ───────────────────────────
function encodeEnrichState(state) {
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
}

function decodeEnrichState(token) {
  try {
    const json = Buffer.from(String(token || ""), "base64url").toString("utf8");
    const s = JSON.parse(json);
    return s && typeof s === "object" ? s : null;
  } catch (_) {
    return null;
  }
}

/** Structured-token parse (NOT NLP). Returns the base64url payload, or null. */
function parsePicEnrichRef(text) {
  if (!text || typeof text !== "string") return null;
  const m = text.match(PICENRICH_MARKER_RE);
  return m ? m[1] : null;
}

// ─────────────────────────── small helpers ───────────────────────────
function lidLabel(lid) {
  return String(lid || "").replace(/^@/, "");
}

/** A name is "usable" for fuzzy matching only if it has a real alphabetic run (filters
 *  emoji/decorative-unicode pushnames like "~꧁ jAhID꧂" → escalate to ASK for a real name). */
function hasUsableName(name) {
  return /[A-Za-zÀ-ɏ]{2,}/.test(String(name || "").normalize("NFKC"));
}

function marker(state) {
  return `[ref: PICENRICH-${encodeEnrichState(state)}]`;
}

/** Read JSON text out of a Responses-API result (works for both `output_text` and
 *  the `output[].content` shapes used across these repos). */
function readResponseText(response) {
  if (response && typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text;
  }
  const out = response && response.output;
  if (Array.isArray(out)) {
    for (const item of out) {
      const content = item && item.content;
      if (typeof content === "string" && content.trim()) return content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c && typeof c.text === "string" && c.text.trim()) return c.text;
        }
      }
    }
  }
  return "";
}

// ─────────────────────────── message builders ───────────────────────────
function buildAskMessage(state) {
  const cur = state.q[0];
  const lines = [];
  if (cur.s === "L" && cur.n) {
    lines.push(
      `👤 To record the PIC for this safety issue, I need the *Novade name* of *${cur.n}*${cur.p ? "" : " and their phone number"}.`,
    );
  } else {
    lines.push(`👤 I couldn't identify the person you tagged (@${lidLabel(cur.i)}).`);
  }
  lines.push("");
  lines.push(
    `Please *reply to this message* with their full *Novade name*${cur.s === "L" && cur.p ? "" : " and *phone number*"}.`,
  );
  lines.push("Example: `Mohamed Shafiee 6591234567`");
  lines.push("");
  lines.push(marker(state));
  return lines.join("\n");
}

function buildConfirmMessage(state) {
  const cur = state.q[0];
  const cands = cur.m || [];
  const label = cur.qn || cur.n || `@${lidLabel(cur.i)}`;
  const lines = [];
  if (cands.length) {
    lines.push(`🔎 Closest Novade matches for *${label}*:`);
    lines.push("");
    cands.forEach((c, i) => lines.push(`${i + 1}. ${c.n}`));
    lines.push("");
    lines.push(
      `Please *reply to this message* with the *number* (1-${cands.length}) of the correct person, or reply *none* if they're not in the list.`,
    );
  } else {
    lines.push(`🔎 I couldn't find a close Novade match for *${label}*.`);
    lines.push("");
    lines.push("Please *reply to this message* with the person's *exact Novade name*.");
  }
  lines.push("");
  lines.push(marker(state));
  return lines.join("\n");
}

function buildDoneMessage(pic, sn) {
  return `✅ PIC set: ${pic}${sn ? ` (S/N ${sn})` : ""}`;
}

// ─────────────────────────── LLM reply parsers (no regex for NLP) ───────────────────────────
async function extractNameAndPhone(replyText) {
  const text = String(replyText || "").trim();
  if (!text) return { novadeName: "", phone: "" };
  try {
    const response = await getOpenAI().responses.create({
      model: "gpt-4.1",
      temperature: 0,
      input: [
        {
          role: "system",
          content:
            "Extract a single person's NAME and PHONE NUMBER from the user's message. " +
            "Return the name exactly as a person's name (no titles, no extra words). " +
            "phone = the phone number as digits only (keep country-code digits if present); empty string if none.",
        },
        { role: "user", content: text },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "name_phone",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: { novadeName: { type: "string" }, phone: { type: "string" } },
            required: ["novadeName", "phone"],
          },
        },
      },
      store: true,
      metadata: { type: "pic_enrich_name_phone" },
    });
    const out = JSON.parse(readResponseText(response) || "{}");
    return {
      novadeName: String(out.novadeName || "").trim(),
      phone: String(out.phone || "").replace(/[^\d]/g, ""),
    };
  } catch (e) {
    console.warn("[pic-enrich] extractNameAndPhone failed (fail-soft → use raw text as name):", e.message);
    return { novadeName: text, phone: "" };
  }
}

/** Returns 1..maxChoice for a pick, or null for "none"/unclear. (0 sentinel = none, to keep
 *  the json_schema strict-friendly without a nullable type.) */
async function extractNumericChoice(replyText, maxChoice) {
  const text = String(replyText || "").trim();
  if (!text || !maxChoice) return null;
  try {
    const response = await getOpenAI().responses.create({
      model: "gpt-4.1",
      temperature: 0,
      input: [
        {
          role: "system",
          content:
            `The user was shown a numbered list from 1 to ${maxChoice}. Decide which item they picked. ` +
            `Return that number. Return 0 if they said "none"/"not listed"/none-of-them, or did not clearly pick one.`,
        },
        { role: "user", content: text },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "numeric_choice",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: { choice: { type: "integer" } },
            required: ["choice"],
          },
        },
      },
      store: true,
      metadata: { type: "pic_enrich_choice" },
    });
    const out = JSON.parse(readResponseText(response) || "{}");
    const c = out.choice;
    return Number.isInteger(c) && c >= 1 && c <= maxChoice ? c : null;
  } catch (e) {
    console.warn("[pic-enrich] extractNumericChoice failed (fail-soft → none):", e.message);
    return null;
  }
}

// ─────────────────────────── queue / candidate plumbing ───────────────────────────
function buildQueueItem(e) {
  // e = resolvePicFromMentions entry: { id, novadeName, whatsappName, phone, display, source }
  if (e.source === "listener") {
    return { i: e.id, s: "L", n: e.whatsappName || e.display || "", p: e.phone || "" };
  }
  return { i: e.id, s: "R" }; // raw — nothing known yet
}

async function safeGetCandidates(adapter, query, phone) {
  try {
    const c = await adapter.getCandidates(query, phone, MAX_CANDIDATES);
    return Array.isArray(c) ? c.slice(0, MAX_CANDIDATES) : [];
  } catch (e) {
    console.warn("[pic-enrich] adapter.getCandidates failed (fail-soft):", e.message);
    return [];
  }
}

/** Decide the starting stage for q[0] and (for CONFIRM) pre-fill its candidate list. */
async function primeCurrentItem(state, adapter) {
  const cur = state.q[0];
  state.r = 0;
  delete cur.m;
  delete cur.qn;
  if (cur.s === "L" && hasUsableName(cur.n)) {
    const cands = await safeGetCandidates(adapter, cur.n, cur.p);
    if (cands.length) {
      cur.m = cands;
      cur.qn = cur.n;
      state.st = "CONFIRM";
      return;
    }
  }
  // raw, or weird/garbage listener name, or no candidates → ask the reporter for the Novade name
  state.st = "ASK";
}

async function sendStateMessage(state, message) {
  const text = state.st === "CONFIRM" ? buildConfirmMessage(state) : buildAskMessage(state);
  const replyTo = message.messageIdSerialized || message.messageId || null;
  await sendWhatsAppReply(message.chatId || message.from, text, undefined, undefined, replyTo);
}

async function safeReply(message, text) {
  try {
    const replyTo = message.messageIdSerialized || message.messageId || null;
    await sendWhatsAppReply(message.chatId || message.from, text, undefined, undefined, replyTo);
  } catch (e) {
    console.warn("[pic-enrich] reply failed (non-blocking):", e.message);
  }
}

function rowStatus(existingRow) {
  return String((existingRow && (existingRow.Status || existingRow.status)) || "")
    .trim()
    .toLowerCase();
}

async function writePic(existingRow, pic, groupConfig) {
  // Lazy require avoids a load-time circular dependency with safety-handlers.
  const { updateExistingSafetyIssueRow } = require("../handlers/safety-handlers");
  await updateExistingSafetyIssueRow({
    existingRow,
    issueData: { pic },
    senderDetails: null, // preserve the original messageId in the Sender column
    messageDate: null,
    groupConfig,
    isAlbumUpdate: true, // partial update — only the PIC cell
  });
}

/** Append one Name List record, unless this @lid is already mapped (dedup against replays). */
async function appendNameListIfNew(spreadsheetId, adapter, rec) {
  try {
    invalidateNameListCache(spreadsheetId);
    const map = await loadNameList(spreadsheetId);
    if (map && map.has(rec.lid)) {
      console.log(`[pic-enrich] ${rec.lid} already in Name List — skip append (still set PIC).`);
      return;
    }
  } catch (_) {
    // fall through — better to append than to silently drop the mapping
  }
  await writeArrayToGSheetRow(spreadsheetId, adapter.nameListSheetName, adapter.buildNameListRow(rec));
  invalidateNameListCache(spreadsheetId);
  console.log(`[pic-enrich] appended Name List "${rec.novadeName}" (${rec.lid}) to "${adapter.nameListSheetName}"`);
}

function currentPic(state) {
  return [state.b, ...(state.d || [])].filter(Boolean).join(", ");
}

async function commitConfirmed(state, chosenName, message, groupConfig, adapter, existingRow) {
  const cur = state.q[0];
  await appendNameListIfNew(groupConfig.spreadsheetId, adapter, {
    novadeName: chosenName,
    whatsappName: cur.n || chosenName,
    phone: cur.p || "",
    lid: cur.i,
  }).catch((e) => console.warn("[pic-enrich] Name List append failed (non-blocking):", e.message));

  state.d = state.d || [];
  state.d.push(chosenName);
  state.q.shift();
  const pic = currentPic(state);
  await writePic(existingRow, pic, groupConfig);
  console.log(`[pic-enrich] committed "${chosenName}" → PIC "${pic}" (row ${existingRow.RowNumber})`);

  if (state.q.length) {
    await primeCurrentItem(state, adapter);
    await sendStateMessage(state, message);
    return { enriched: true, committed: chosenName, next: true };
  }
  await safeReply(message, buildDoneMessage(pic, existingRow["S/N"]));
  return { enriched: true, committed: chosenName, done: true, pic };
}

async function skipCurrentAndAdvance(state, message, groupConfig, adapter, existingRow) {
  const cur = state.q[0];
  const fallback = cur.s === "L" && cur.n ? cur.n : `@${lidLabel(cur.i)}`;
  state.d = state.d || [];
  state.d.push(fallback);
  state.q.shift();
  const pic = currentPic(state);
  await writePic(existingRow, pic, groupConfig);
  console.warn(`[pic-enrich] gave up on ${cur.i} after ${MAX_RETRY} retries → stored "${fallback}"`);

  if (state.q.length) {
    await primeCurrentItem(state, adapter);
    await sendStateMessage(state, message);
    return { enriched: true, skipped: cur.i, next: true };
  }
  await safeReply(message, buildDoneMessage(pic, existingRow["S/N"]));
  return { enriched: true, skipped: cur.i, done: true, pic };
}

// ─────────────────────────── stage handlers ───────────────────────────
async function handleAskReply(state, body, message, groupConfig, adapter, existingRow) {
  const cur = state.q[0];
  const { novadeName, phone } = await extractNameAndPhone(body);
  const name = novadeName || "";
  const finalPhone = phone || cur.p || "";

  if (!name || !hasUsableName(name)) {
    state.r = (state.r || 0) + 1;
    if (state.r > MAX_RETRY) return skipCurrentAndAdvance(state, message, groupConfig, adapter, existingRow);
    await sendStateMessage(state, message); // re-ask, state unchanged
    return { enriched: true, stage: "ASK", retried: true };
  }

  cur.n = name;
  cur.qn = name;
  cur.p = finalPhone;
  const cands = await safeGetCandidates(adapter, name, finalPhone);
  if (!cands.length) {
    // Novade directory unavailable/empty → nothing to confirm against; commit the typed name.
    return commitConfirmed(state, name, message, groupConfig, adapter, existingRow);
  }
  cur.m = cands;
  state.st = "CONFIRM";
  state.r = 0;
  await sendStateMessage(state, message);
  return { enriched: true, stage: "CONFIRM" };
}

async function handleConfirmReply(state, body, message, groupConfig, adapter, existingRow) {
  const cur = state.q[0];
  const cands = cur.m || [];
  const choice = await extractNumericChoice(body, cands.length);
  if (choice && cands[choice - 1]) {
    return commitConfirmed(state, cands[choice - 1].n, message, groupConfig, adapter, existingRow);
  }

  // Not a number → maybe they typed a (different) name. Re-match on it; else re-ask.
  state.r = (state.r || 0) + 1;
  if (state.r > MAX_RETRY) return skipCurrentAndAdvance(state, message, groupConfig, adapter, existingRow);

  const { novadeName, phone } = await extractNameAndPhone(body);
  if (novadeName && hasUsableName(novadeName)) {
    cur.n = novadeName;
    cur.qn = novadeName;
    if (phone) cur.p = phone;
    const cands2 = await safeGetCandidates(adapter, novadeName, cur.p);
    if (cands2.length) {
      cur.m = cands2;
      state.st = "CONFIRM";
      state.r = 0; // genuine progress — reset the failure counter
      await sendStateMessage(state, message);
      return { enriched: true, stage: "CONFIRM", reMatched: true };
    }
    return commitConfirmed(state, novadeName, message, groupConfig, adapter, existingRow);
  }

  state.st = "ASK";
  await sendStateMessage(state, message);
  return { enriched: true, stage: "ASK", retried: true };
}

// ─────────────────────────── public entry points ───────────────────────────
/**
 * Begin enrichment for a freshly-created (or followup-targeted) safety issue that has
 * unresolved (listener/raw) PIC mentions. Sends the first ASK/CONFIRM message. Non-blocking —
 * never throws into the create path.
 */
async function startPicEnrichment({
  message,
  senderDetails,
  groupConfig,
  anchorId,
  baseNames,
  unresolvedMentions,
  adapter,
}) {
  try {
    if (!adapter || !adapter.hasNovade()) return null;
    if (!anchorId || !groupConfig?.spreadsheetId) return null;
    const unresolved = (unresolvedMentions || []).filter((e) => e && e.id);
    if (!unresolved.length) return null;

    const state = {
      v: 1,
      a: anchorId,
      b: (baseNames || []).filter(Boolean).join(", "),
      d: [],
      q: unresolved.map(buildQueueItem),
      st: "ASK",
      r: 0,
    };
    await primeCurrentItem(state, adapter);
    await sendStateMessage(state, message);
    console.log(`[pic-enrich] started for anchor ${anchorId} (queue ${state.q.length}, stage ${state.st})`);
    return { enrichStarted: true, anchor: anchorId, queue: state.q.length };
  } catch (e) {
    console.warn("[pic-enrich] startPicEnrichment failed (non-blocking):", e.message);
    return null;
  }
}

/**
 * Handle a reporter's reply that quotes one of our enrichment messages (carries the PICENRICH
 * marker). Returns null if there is no marker (let normal processing continue), otherwise an
 * `{ enriched: true, ... }` result. NEVER returns a `message` key (we send explicitly).
 */
async function handlePicEnrichmentReply(message, senderDetails, groupConfig, adapter) {
  const quotedBody = typeof message === "object" ? message.quotedBody : null;
  const token = parsePicEnrichRef(quotedBody);
  if (!token) return null;

  const state = decodeEnrichState(token);
  if (!state || !state.a || !Array.isArray(state.q) || !state.q.length || !state.st) {
    console.warn("[pic-enrich] reply had a PICENRICH marker but undecodable/empty state — ignoring.");
    return { enriched: true, badState: true };
  }
  if (!adapter || !adapter.hasNovade() || !groupConfig?.spreadsheetId) {
    return { enriched: true, novadeDisabled: true };
  }

  const { findExistingSafetyIssueRow } = require("../handlers/safety-handlers");
  const existingRow = await findExistingSafetyIssueRow({ messageId: state.a, parentMessageId: state.a }, groupConfig);
  if (!existingRow) {
    await safeReply(
      message,
      "⚠️ I couldn't find the original safety issue (it may have been deleted) — PIC was not updated.",
    );
    return { enriched: true, notFound: true };
  }
  if (rowStatus(existingRow) === "closed") {
    await safeReply(message, "ℹ️ That safety issue is already closed — PIC was not changed.");
    return { enriched: true, closed: true };
  }

  const body = typeof message === "object" ? message.body : message;
  if (state.st === "CONFIRM") {
    return handleConfirmReply(state, body, message, groupConfig, adapter, existingRow);
  }
  return handleAskReply(state, body, message, groupConfig, adapter, existingRow);
}

module.exports = {
  PICENRICH_MARKER_RE,
  encodeEnrichState,
  decodeEnrichState,
  parsePicEnrichRef,
  hasUsableName,
  buildAskMessage,
  buildConfirmMessage,
  buildDoneMessage,
  extractNameAndPhone,
  extractNumericChoice,
  startPicEnrichment,
  handlePicEnrichmentReply,
  // exported for tests
  _internals: { primeCurrentItem, handleAskReply, handleConfirmReply, buildQueueItem, MAX_RETRY, MAX_CANDIDATES },
};
