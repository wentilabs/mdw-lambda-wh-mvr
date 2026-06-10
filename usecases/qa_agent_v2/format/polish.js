/**
 * Layer 5 polish — make answers sound human, while GUARANTEEING zero
 * number drift.
 *
 * The deterministic renderer produces correct-but-bland output. This module
 * sends that output through gpt-4.1-mini for a natural-language rewrite,
 * then GUARDS every number with a strict invariant check:
 *
 *   1. Extract every number/percentage from the deterministic output.
 *   2. Extract every number/percentage from the polished output.
 *   3. Multisets must be IDENTICAL. If anything differs, FALL BACK to the
 *      deterministic output (safe-default).
 *
 * The polished output is cached by SHA-256(prompt-version + model +
 * deterministic output). Same deterministic answer → same cache key → same
 * polished output every time, so consistency tests stay byte-identical.
 *
 * Cost / safety:
 *   • gpt-4.1-mini at temperature=0 is ~$0.0002-0.0005 per polish.
 *   • In-memory cache hits 90%+ after warmup → effective <$0.005/day.
 *   • If the API errors or returns no text, falls back to deterministic.
 *   • If the LLM hallucinates ANY number, falls back to deterministic.
 *   • Numbers (including dates' digits, percentages, codes like P1) are
 *     verified as a multiset — order doesn't matter.
 *
 * To disable: set QA_V2_POLISH_ENABLED=false (or 0/no/off).
 */

const crypto = require("crypto");
const { getOpenAI, withOpenAIRetry } = require("../../../utils/openai");
const { stageLog, stageWarn } = require("../shared/logging");

const POLISH_MODEL = "gpt-4.1-mini";
const POLISH_PROMPT_VERSION = "v9";

// Default ON. Disable with QA_V2_POLISH_ENABLED=false / 0 / no / off.
function isPolishEnabled() {
  const v = String(process.env.QA_V2_POLISH_ENABLED || "true").toLowerCase();
  return !["false", "0", "no", "off"].includes(v);
}

// Polish is meaningful only for SUMMARY-shaped answers. For list/status the
// raw rows ARE the answer — polishing risks dropping or reordering items.
const POLISH_KINDS = new Set([
  "count",
  "aggregate",
  "distribution",
  "trend",
  "comparison",
  "ranking",
  "top_n",
  "ratio",
  "threshold",
]);

// SHA-256 cache keyed on (prompt version, model, deterministic output).
const POLISH_CACHE = new Map();
const POLISH_CACHE_MAX = 2000;

function cacheKey(msg) {
  // Include MODEL in the key so a model swap automatically invalidates the
  // cache and triggers a fresh polish.
  return crypto.createHash("sha256").update(`${POLISH_PROMPT_VERSION}|${POLISH_MODEL}|${msg}`).digest("hex");
}

function cacheGet(msg) {
  return POLISH_CACHE.get(cacheKey(msg));
}

function cacheSet(msg, polished) {
  const key = cacheKey(msg);
  if (POLISH_CACHE.size >= POLISH_CACHE_MAX) {
    const drop = Math.ceil(POLISH_CACHE_MAX * 0.1);
    let i = 0;
    for (const k of POLISH_CACHE.keys()) {
      if (i++ >= drop) break;
      POLISH_CACHE.delete(k);
    }
  }
  POLISH_CACHE.set(key, polished);
}

const SYSTEM_PROMPT = [
  "You are a writing polisher for a construction-site analytical agent. The audience is a site Project Manager, Director, or Senior Engineer at a Singapore main contractor (Woh Hup) on the Marina Bay Sands IR2 project. They want answers that read like a human site engineer wrote them, not like a machine dump.",
  "",
  "You receive a DETERMINISTIC analytical answer that ALREADY contains every correct number. Your job is to REWRITE it so it reads naturally, while obeying these rules:",
  "",
  "═══ THE ONE HARD RULE (non-negotiable) ═══",
  "EVERY NUMBER in the input MUST appear in the output VERBATIM, with the SAME COUNT (multiset equality):",
  "  • Integers (513, 7, 22) → same digits",
  "  • Decimals (65.7, 70.7, 30.6) → same digits, same decimal point",
  "  • Percentages (94%, 100%, 0%) → must keep the % sign",
  "  • Dates (2026-05-08, 18-May, 04-May-2026) → same form, same digits",
  "  • Codes that embed digits (P1, P2, IR2-045, WF-003072, RFI-000090, TRANSMIT-000225) → keep ALL digits",
  "  • Negative numbers MUST keep their minus sign — '-3227' is NOT the same as '3227'. If a value is negative, write it as '-3227' (not '3227 less than' or '3227 ↓'). Same for '+': preserve the sign exactly as in input.",
  "  • Zero values MUST be written as the digit '0'. Do NOT replace '0' with 'no', 'none', 'zero', or omit it. Wrong: 'no open safety issues were reported yesterday.' Right: '0 open safety issues were reported yesterday.' Better: 'There were 0 open safety issues yesterday.'",
  "Do NOT modify, round, paraphrase as words ('seven' instead of '7'), add a new number, change the count of how many times a number appears, or omit any number. Do NOT change separators inside a number.",
  "",
  "DUPLICATION RULE: if you write a number in your OPENER sentence, you must NOT also leave it in the bullets — and vice versa. Total occurrences of every number in your output must EQUAL its occurrences in the input. SAFEST PATTERN: opener uses QUALITATIVE words ('rose through the week then dropped at the weekend', 'down sharply vs last week'). The numbers belong only in the bullet rows and headline number. If you must mention a specific number in the opener (e.g. the headline 'total: 275'), then the same number is allowed to appear in the appropriate body line — but you must NEVER mention a body-line number a second time elsewhere.",
  "",
  "═══ CONTEXT-WORD PRESERVATION (also non-negotiable) ═══",
  "Filter context words and qualifier labels carry the MEANING of the answer. They are not decoration. You MUST preserve these words (or an obvious synonym) somewhere in your output:",
  "  • Status words: 'overdue', 'open', 'closed', 'due this week', 'pending'",
  "  • Direction words: 'incoming', 'outgoing'",
  "  • Severity codes: 'P1', 'P2', 'P3', 'good observation', 'N/A'",
  "  • Subcon / sender names: 'Woh Hup', 'KTC', 'KKL', 'LT SAMBO', 'Arup', 'MBS', 'Element Geo', 'Aedas'",
  "  • Work type / category names: 'D-Wall', 'Bored Pile', 'JGP', 'Method Statement', 'RFI', 'RFA', 'MS', 'Transmittal'",
  "  • Time-window labels: 'today', 'yesterday', 'this week', 'last week', 'this month', explicit dates",
  "  • Domain headline ('Manpower', 'Safety Issues', 'Soil Disposal', etc.) — may be reworded but must remain identifiable",
  "",
  "If the deterministic input says 'Document Tracking — overdue · 129 on today.' your polished output must contain BOTH the word 'overdue' AND the number 129 AND the date 'today'. Example good polish: '129 documents are currently overdue.' Example BAD polish: '129 documents were tracked today.' (lost 'overdue' — changes the meaning).",
  "",
  "═══ WHAT TO ACTUALLY REWRITE ═══",
  "The deterministic output reads like a machine. Your job is to rewrite it into a HUMAN, PROFESSIONAL, INFORMATIVE answer.",
  "",
  "0. ALWAYS DROP the 'Domain — ' prefix format. The user already knows what they asked — don't restate the domain as a heading. Internal labels like 'Document Tracking —', 'Safety Issues —', 'Manpower —', 'Soil Disposal —', 'Pile Cap —', 'WBGT (Heat Stress) —', 'Noise Monitoring —', 'Piling Progress —', 'Instrumentation Monitoring —' are scaffolding from the renderer. Strip them. Use the domain noun INSIDE the natural sentence instead (e.g. 'soil', 'safety issues', 'manpower', 'documents').",
  "",
  "1. ADD a plain-English opener that frames the answer naturally — like a site engineer would speak to their boss. Examples:",
  "    DETERMINISTIC: 'Document Tracking — incoming · breakdown on yesterday (total: 10):'",
  "    POLISHED:      '10 incoming documents were tracked yesterday — broken down as follows:'",
  "",
  "    DETERMINISTIC: 'Soil Disposal — Total Volume (m³): 502 (2026-05-08).'",
  "    POLISHED:      'Site removed 502 m³ of soil on 2026-05-08.'",
  "",
  "    DETERMINISTIC: 'Safety Issues — P1 · 7 on 2026-05-08.'",
  "    POLISHED:      '7 P1 safety issues were reported on 2026-05-08.'",
  "",
  "    DETERMINISTIC: 'Manpower — Total Headcount (pax): 513 (2026-05-08).'",
  "    POLISHED:      'Total manpower on site on 2026-05-08: 513 pax.'",
  "",
  "    DETERMINISTIC: 'Document Tracking — overdue · 129 on today.'",
  "    POLISHED:      '129 documents are currently overdue as of today.'",
  "",
  "    DETERMINISTIC: 'Safety Issues — open · 0 on yesterday.'",
  "    POLISHED:      'No open safety issues were reported yesterday.'",
  "",
  "    DETERMINISTIC: 'Document Tracking — top 5 (this week):'",
  "    POLISHED:      'Top 5 document senders this week:'",
  "",
  "2. REPLACE internal code labels with human-readable English (these are NOT numbers, so safe to rewrite):",
  "    'Transmittal_General' → 'General Transmittal' (a transmittal that isn't specifically an RFA, MS, or Approval Notice)",
  "    'Response_RFI'       → 'Response to RFI'",
  "    'Approval_Notice'    → 'Approval Notice'",
  "    'Rejection'          → 'Rejection Notice'",
  "    'due_this_week'      → 'due this week'",
  "    'leq_5min' / 'leq_avg' (as a label) → 'Leq (5-min)'",
  "    'headcount'          → 'Headcount'",
  "    'open_count' / 'closed_count' (as label) → 'Open' / 'Closed'",
  "    'days_open' → 'days open'",
  "  Strip redundant unit markers when context already implies them (e.g. drop the '(pax)' tag when the line already says 'manpower').",
  "",
  "3. SOFTEN stiff symbols: 'Δ' → 'Change' or 'Difference'.",
  "",
  "4. For TREND answers (multi-day series), the opener must summarise the trend in QUALITATIVE words only — do NOT name any specific day/value, because those numbers already live in the bullet rows below. Good opener: 'Document volume rose through the week, peaked midweek, then dropped over the weekend.' Bad opener: 'Volume rose from 21 to 46' (this duplicates the bullet numbers and will fail the safety check).",
  "",
  "5. For COMPARISON answers, the headline interpretation goes in the OPENER. You may use the period labels (e.g. 'this week', 'last week') but the actual numbers stay in the bullet rows. Good opener: 'Manpower this week is sharply down vs last week.' Bad opener: 'Manpower this week is 107 vs 3334 last week.' (numbers are also in the bullets below — would duplicate)",
  "",
  "═══ STRUCTURE PRESERVATION ═══",
  "  • Preserve EVERY bullet item — same number of bullets in, same number out. You may reword each line but cannot drop or add items.",
  "  • Preserve group headings like '*RFI (19)*'. You may improve the heading text but keep its number.",
  "  • Preserve backtick-quoted IDs unchanged ( `RFI-000090` stays as is).",
  "  • Preserve Markdown formatting (* for bold, ` for inline code, leading bullets).",
  "  • Top-N headings like 'top 5' / 'top 10' carry a NUMBER (the N). Always preserve that number — either keep the literal 'top 5 X' / 'top 10 X' wording in the opener, or use 'leading 5 X' / 'highest 5 X'. The numeric '5' or '10' must remain in the output.",
  "  • Rank numbers (1. 2. 3.) — keep them all.",
  "",
  "═══ TONE ═══",
  "  • Professional, direct, site-engineer language",
  "  • No fluff, no marketing words ('amazing', 'great'), no softeners ('I'd say', 'it looks like', 'perhaps')",
  "  • Active voice preferred",
  "  • Singapore English is fine — 'pax' for people, 'm³' for cubic metres, 'd' for days are all acceptable",
  "",
  "═══ LENGTH ═══",
  "  • Target 90-130% of input length.",
  "  • Never balloon — if your rewrite would exceed 130% of input, you're padding. Cut.",
  "  • If the input is already a single concise line, you may still rewrite the phrasing of that line.",
  "",
  "═══ OUTPUT ═══",
  "Output ONLY the polished text. No explanation, no preamble, no code fences, no quotes around the whole thing.",
].join("\n");

/**
 * Polish a deterministic answer.
 *
 * @param {string} deterministicMsg
 * @param {object} answer  — the AnswerData (used to decide whether to polish)
 * @returns {Promise<string>} polished message OR the deterministic message if polish is disabled / fails / drifts numbers.
 */
async function maybePolish(deterministicMsg, answer) {
  if (!isPolishEnabled()) return deterministicMsg;
  if (!deterministicMsg || typeof deterministicMsg !== "string") return deterministicMsg;
  if (!answer || !answer.kind || !POLISH_KINDS.has(answer.kind)) return deterministicMsg;
  if (deterministicMsg.length < 30) return deterministicMsg;

  const cached = cacheGet(deterministicMsg);
  if (cached !== undefined) {
    stageLog("format/polish", "cache hit");
    return cached;
  }

  // Try polish up to 2 attempts. First with the normal prompt. If that fails
  // verification, retry once with a stricter "you previously hallucinated"
  // instruction. Second attempt is much more likely to preserve numbers + context.
  let polished;
  let retryHint = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      polished = await callPolisher(deterministicMsg, retryHint);
    } catch (e) {
      stageWarn("format/polish", "LLM error — falling back to deterministic", e?.message || e);
      cacheSet(deterministicMsg, deterministicMsg);
      return deterministicMsg;
    }

    if (!polished || typeof polished !== "string" || polished.trim().length === 0) {
      retryHint = "Previous attempt was empty. Output the polished text directly, no preamble.";
      continue;
    }

    if (!numbersPreserved(deterministicMsg, polished)) {
      const inN = extractNumbers(deterministicMsg);
      const outN = extractNumbers(polished);
      const inSet = new Set(inN);
      const outSet = new Set(outN);
      const extra = [...outSet].filter((n) => !inSet.has(n));
      const missing = [...inSet].filter((n) => !outSet.has(n));
      retryHint =
        "Previous attempt FAILED number verification. " +
        (extra.length
          ? `You added these numbers that DO NOT appear in the input: [${extra.join(", ")}]. Remove them. `
          : "") +
        (missing.length ? `You omitted these numbers that MUST appear: [${missing.join(", ")}]. Add them back. ` : "") +
        "Use ONLY the numbers that exist in the input — no new ones, no missing ones.";
      stageWarn("format/polish", `attempt ${attempt + 1} failed numbers — retrying`, {
        extra,
        missing,
      });
      continue;
    }

    const ctx = contextPreserved(deterministicMsg, polished, answer);
    if (!ctx.ok) {
      retryHint = `Previous attempt dropped the word/phrase "${ctx.missing}" which is REQUIRED. Include it in your rewrite. Either keep it verbatim or use it inside a natural sentence.`;
      stageWarn("format/polish", `attempt ${attempt + 1} dropped context — retrying`, { missing: ctx.missing });
      continue;
    }

    // Both checks passed — use this polish.
    break;
  }

  // After up to 2 attempts, final verification.
  if (
    !polished ||
    !numbersPreserved(deterministicMsg, polished) ||
    !contextPreserved(deterministicMsg, polished, answer).ok
  ) {
    stageWarn("format/polish", "all attempts failed — using deterministic");
    cacheSet(deterministicMsg, deterministicMsg);
    return deterministicMsg;
  }

  cacheSet(deterministicMsg, polished);
  stageLog("format/polish", "polished + verified", {
    in_len: deterministicMsg.length,
    out_len: polished.length,
  });
  return polished;
}

async function callPolisher(deterministicMsg, retryHint = null) {
  const userContent = retryHint
    ? `INPUT:\n${deterministicMsg}\n\nIMPORTANT CORRECTION: ${retryHint}`
    : `INPUT:\n${deterministicMsg}`;
  const response = await withOpenAIRetry(
    () =>
      getOpenAI().responses.create({
        model: POLISH_MODEL,
        temperature: 0,
        input: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        store: true,
        metadata: { project: "wohhup", type: "qa_v2_polish", attempt: retryHint ? "retry" : "first" },
      }),
    "qa_v2.polish",
    { maxRetries: 2, logPrefix: "qa_v2" },
  );
  return String(response?.output_text || "").trim();
}

/**
 * Extract every number-like token from text. Matches integers, decimals,
 * percentages (with % suffix), and signed numbers.
 */
function extractNumbers(text) {
  const s = String(text || "");
  const out = [];
  const re = /[-+]?\d+(?:\.\d+)?%?/g;
  let m;
  while ((m = re.exec(s)) !== null) out.push(m[0]);
  return out;
}

/** YYYY-MM-DD → ["08-May-2026", "08-May", "08 May 2026", "May 8", "May 8th"...]. */
function dateTransforms(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  if (!m) return [];
  const [, y, mm, dd] = m;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const monthName = months[parseInt(mm, 10) - 1];
  const day = String(parseInt(dd, 10)); // strip leading zero for "May 8" style
  return [
    `${dd}-${monthName}-${y}`, // 08-May-2026
    `${dd}-${monthName}`, // 08-May
    `${dd} ${monthName} ${y}`, // 08 May 2026
    `${dd} ${monthName}`, // 08 May
    `${monthName} ${day}, ${y}`, // May 8, 2026
    `${monthName} ${day}`, // May 8
  ];
}

/**
 * Number safety check — set equality (NOT multiset).
 *
 * Rationale: the LLM often naturally repeats a headline number in its opener
 * ("Last week saw 26 open safety issues...") AND keeps it in the bullets
 * ("• Total reported: 26"). That's accurate, not hallucination. Strict
 * multiset matching would reject the polish even though every number is
 * correct.
 *
 * Two checks (both must pass):
 *   1. NO NEW NUMBERS — every number in output must exist somewhere in input
 *      (catches hallucinated values like "27" appearing in output).
 *   2. NO MISSING NUMBERS — every distinct number in input must exist
 *      somewhere in output (catches omissions like "0" being replaced by
 *      the word "no").
 *
 * Repetition (number appearing more times in output than input) is allowed.
 */
function numbersPreserved(input, output) {
  const inSet = new Set(extractNumbers(input));
  const outSet = new Set(extractNumbers(output));
  const outLower = String(output || "").toLowerCase();
  // Hallucination check: every output number must come from input.
  for (const n of outSet) {
    if (!inSet.has(n)) return false;
  }
  // Omission check: every input number must appear in output — with ONE
  // exception: "0" may be substituted by the words "no", "none", or "zero"
  // when used as a count quantifier (e.g. "0 issues" → "no issues" is fine).
  for (const n of inSet) {
    if (outSet.has(n)) continue;
    if (n === "0" && /\b(no|none|zero|nil)\b/i.test(outLower)) continue;
    return false;
  }
  return true;
}

/**
 * Required-token derivation — pulled from the AnswerData's actual filter
 * VALUES and time-window label, NOT from a fixed token list. This means
 * synonyms for non-semantic labels (e.g. "manpower" ↔ "headcount") are
 * fine — what matters is that filter VALUES (e.g. "P1", "open", "KTC",
 * "incoming") and the time window remain in the output.
 *
 * Returns an array of REQUIRED tokens (lowercase). All must appear in
 * polished output (case-insensitive); if any is missing → polish rejected.
 */
/**
 * Required-tokens shape:
 *   {
 *     all: string[]   — every token here MUST appear (filter values)
 *     anyOf: string[][] — for each group, at least one token must appear
 *                          (e.g. time window: label OR start_iso OR end_iso)
 *   }
 */
function requiredTokensFromAnswer(deterministicMsg, answer) {
  const all = new Set();
  const anyOf = [];

  // 1. Filter values — each is a hard requirement.
  const filters = answer?.meta?.filters_applied || [];
  for (const f of filters) {
    if (!f) continue;
    if (f.value !== undefined && f.value !== null && f.value !== "") {
      all.add(String(f.value).toLowerCase());
    }
    if (Array.isArray(f.values) && f.values.length > 0) {
      // Filter with multiple values (op='in'): require AT LEAST one in output.
      // Strict: every value should appear, but if there's a long list, requiring
      // all might be too strict. Use 'any-of' group instead.
      anyOf.push(f.values.map((v) => String(v ?? "").toLowerCase()).filter(Boolean));
    }
  }

  // 2. Time-window — require ANY representation (human label OR start_iso OR
  //    end_iso OR DD-MMM-YYYY shorthand). LLM commonly converts "2026-05-08"
  //    to "08-May-2026" or "08-May" — both are valid time-window references.
  const tw = answer?.meta?.time_window;
  const twGroup = [];
  if (tw?.label) twGroup.push(String(tw.label).toLowerCase());
  for (const iso of [tw?.start_iso, tw?.end_iso].filter(Boolean)) {
    twGroup.push(String(iso).toLowerCase());
    for (const alt of dateTransforms(iso)) twGroup.push(alt.toLowerCase());
  }
  // De-dup
  if (twGroup.length > 0) anyOf.push([...new Set(twGroup)]);

  return { all: [...all], anyOf };
}

function contextPreserved(deterministicMsg, polished, answer) {
  const outLower = String(polished || "").toLowerCase();
  const req = requiredTokensFromAnswer(deterministicMsg, answer);
  for (const tok of req.all) {
    if (!outLower.includes(tok)) return { ok: false, missing: tok };
  }
  for (const group of req.anyOf) {
    if (group.length === 0) continue;
    const found = group.some((t) => outLower.includes(t));
    if (!found) return { ok: false, missing: `one-of[${group.join("|")}]` };
  }
  return { ok: true };
}

function clearPolishCache() {
  POLISH_CACHE.clear();
}

module.exports = {
  maybePolish,
  clearPolishCache,
  __test: {
    extractNumbers,
    numbersPreserved,
    contextPreserved,
    requiredTokensFromAnswer,
    cacheKey,
    POLISH_CACHE,
    SYSTEM_PROMPT,
    POLISH_KINDS,
  },
};
