/**
 * Layer 1 — Language Parser.
 *
 * Single LLM call that converts a natural-language user question into a
 * strictly-typed QueryIntent. This is the ONLY place in the v2 pipeline
 * where the LLM reads the user's text. Everything downstream operates on
 * the structured intent — no regex on raw text, no second LLM read.
 *
 * Constraints enforced by the prompt + schema:
 *   • The LLM picks one of 14 closed question types and one of 11 closed domains.
 *   • The LLM resolves relative dates ("today", "last week") using a pre-computed
 *     SGT anchor injected at runtime — never computes its own dates.
 *   • The LLM MUST NOT compute any number — its job is to describe what the
 *     user asked, not to answer it.
 *   • Strict OpenAI json_schema enforces every field present.
 */

const { getOpenAI, withOpenAIRetry } = require("../../../utils/openai");
const { QUERY_INTENT_SCHEMA, DOMAINS, QUESTION_TYPES } = require("./intent-schema");
const { buildDateContextPrompt, todaySgtIso } = require("../shared/time-window");
const { buildDomainPromptFragment, listAnalyticalDomains } = require("../data");
const { stageLog, stageError } = require("../shared/logging");

const MODEL = "gpt-4.1";

/**
 * In-memory intent cache.
 *
 * The OpenAI Responses API with temperature=0 + strict json_schema is mostly
 * deterministic, but not 100% — across calls of the same question, the LLM
 * may produce semantically-equivalent intents with different structure
 * (aggregate vs distribution, single-group vs multi-group). To guarantee
 * byte-identical answers across runs, we cache the FIRST intent we resolve
 * for any given question text + date anchor. Subsequent identical questions
 * return the cached intent without an LLM call.
 *
 * Key = `${todayIso}|${question.trim().toLowerCase()}`. This makes "today"
 * vs "yesterday" resolutions vary correctly across calendar days, while
 * pinning the LLM's answer for any single (question, date) pair.
 */
const INTENT_CACHE = new Map();
const CACHE_MAX_ENTRIES = 1000;

function cacheKey(question, todayIso) {
  return `${todayIso}|${String(question || "")
    .trim()
    .toLowerCase()}`;
}

function cacheGet(question, todayIso) {
  return INTENT_CACHE.get(cacheKey(question, todayIso));
}

function cacheSet(question, todayIso, intent) {
  if (INTENT_CACHE.size >= CACHE_MAX_ENTRIES) {
    // FIFO eviction — drop the oldest 10% to make room.
    const drop = Math.ceil(CACHE_MAX_ENTRIES * 0.1);
    let i = 0;
    for (const k of INTENT_CACHE.keys()) {
      if (i++ >= drop) break;
      INTENT_CACHE.delete(k);
    }
  }
  INTENT_CACHE.set(cacheKey(question, todayIso), intent);
}

/**
 * Parse a user question into a QueryIntent.
 * @param {string} question
 * @param {{ todayIso?: string }} [opts]
 * @returns {Promise<import('../shared/types')['QueryIntent']>}
 */
async function parseIntent(question, opts = {}) {
  const raw = String(question || "").trim();
  if (!raw) return makeUnsupported("", "empty question");

  const todayIso = opts.todayIso || todaySgtIso();

  // Cache: deterministic intent per (question, date anchor). Same question
  // text fired in the same calendar day always resolves to the same intent —
  // this is what makes the bank consistency test 100%.
  const cached = cacheGet(raw, todayIso);
  if (cached) {
    stageLog("parser/parse-intent", `cache hit`, { q: raw.slice(0, 80) });
    return cached;
  }

  const systemPrompt = buildSystemPrompt(todayIso);
  const userPrompt = `Question: ${JSON.stringify(raw)}\n\nTODAY = ${todayIso} (SGT). Resolve all relative dates against TODAY.`;

  let intent;
  try {
    const response = await withOpenAIRetry(
      () =>
        getOpenAI().responses.create({
          model: MODEL,
          temperature: 0,
          input: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          text: {
            format: {
              type: "json_schema",
              name: "query_intent",
              strict: true,
              schema: QUERY_INTENT_SCHEMA,
            },
          },
          store: true,
          metadata: { project: "wohhup", type: "qa_v2_intent" },
        }),
      "qa_v2.parseIntent",
      { maxRetries: 4, logPrefix: "qa_v2" },
    );
    intent = JSON.parse(response.output_text);
  } catch (e) {
    stageError("parser/parse-intent", "LLM failed", e);
    return makeUnsupported(raw, `parser_error: ${e?.message || "unknown"}`);
  }

  // Sanity-check enums (LLM follows the schema, but belt-and-braces).
  if (!QUESTION_TYPES.includes(intent.question_type)) intent.question_type = "unsupported";
  if (!DOMAINS.includes(intent.domain)) intent.domain = "unsupported";

  // Always preserve the verbatim question for logs.
  intent.raw_question = raw;

  stageLog("parser/parse-intent", `parsed`, {
    q: raw.slice(0, 120),
    type: intent.question_type,
    domain: intent.domain,
    metric: intent.target_metric,
    window: intent.time_window?.label,
    filters: (intent.filters || []).map((f) => `${f.field}${f.op}${f.value ?? JSON.stringify(f.values || [])}`),
  });

  // Cache the resolved intent so subsequent identical questions are byte-identical.
  // Only cache supported intents — unsupported / error results should retry next time.
  if (intent.question_type !== "unsupported" || intent.domain !== "unsupported") {
    cacheSet(raw, todayIso, intent);
  }
  return intent;
}

function makeUnsupported(raw, reason) {
  return {
    question_type: "unsupported",
    domain: "unsupported",
    target_metric: "",
    target_aggregation: "none",
    time_window: { kind: "all_time", start_iso: null, end_iso: null, label: "" },
    filters: [],
    group_by: [],
    order_by: null,
    limit: null,
    comparison_baseline: null,
    raw_question: raw,
    unsupported_reason: reason,
  };
}

function buildSystemPrompt(todayIso) {
  return [
    `You are the Language Parser for a construction project analytics agent. Your ONLY job is to convert a single user question into a strictly-typed QueryIntent. You do NOT compute or answer anything — downstream pure-JS layers do that.`,
    ``,
    `${buildDateContextPrompt(todayIso)}`,
    ``,
    `# Reducer words — these ALWAYS map to question_type='aggregate' (NEVER point_lookup):`,
    `   • "peak" / "highest" / "max" / "maximum" / "loudest" / "hottest" → aggregate, target_aggregation='max'`,
    `   • "lowest" / "min" / "minimum" / "quietest" / "coolest" → aggregate, target_aggregation='min'`,
    `   • "average" / "mean" / "avg" / "typical" → aggregate, target_aggregation='avg' (or 'leq_avg' for noise)`,
    `   • "total" / "sum" / "altogether" / "in total" → aggregate, target_aggregation='sum'`,
    `   Only use point_lookup when the user asks for a single instant or a single named entity's current value (e.g. "current WBGT"), NOT for "peak"/"max" which are reducer operations over the window.`,
    `   "loudest hour" / "noisiest hour" / "hottest hour" / "peak hour" → question_type='ranking', group_by=[{field:'Hour'}], target_aggregation=max (or leq_avg/avg for sound), order_by={field:'value',dir:'desc'}, limit=1.`,
    `   "status of X" / "progress of X" / "what is X doing" where X is an entity ID (P211, IW3008, CJ8, rig1) → question_type='status' with filters=[{field:<id-field>, op:'=', value:<X>}], target_aggregation='none'. NOT aggregate.`,
    `   "latest" / "the latest" / "most recent" / "newest" → question_type='list' (NOT 'top_n' — top_n is for "top N <X> by <Y>" with group_by). Set order_by={field:'Created Timestamp',dir:'desc'} AND limit=N (default 1; "latest 3" → 3). Examples:`,
    `     "show me the latest good observation yesterday" → type=list, filter Severity='Good Observation', window=yesterday, order_by={field:'Created Timestamp',dir:'desc'}, limit=1`,
    `     "show me the latest P1 issue yesterday" → type=list, filter Severity='P1', window=yesterday, order_by={field:'Created Timestamp',dir:'desc'}, limit=1`,
    `     "sync the latest P1 to novade" → domain=novade_sync, action=sync, order_by={field:'Created Timestamp',dir:'desc'}, limit=1`,
    `     "latest 3 safety issues" → type=list, order_by={field:'Created Timestamp',dir:'desc'}, limit=3`,
    `     "most recent open issue" → type=list, order_by={field:'Created Timestamp',dir:'desc'}, limit=1`,
    `   "oldest" / "earliest" / "first" → same shape but dir='asc'.`,
    `   "top N <X> by <Y>" → question_type='top_n', limit=N, order_by={field:<Y>,dir:'desc'}, AND group_by=[{field:<X>}]. top_n REQUIRES group_by — the planner rejects top_n without it. Examples: "top 5 contractors by manpower today" → type=top_n, group_by=[{field:'Company'}], order_by={field:'value',dir:'desc'}, limit=5. NEVER emit top_n for "latest" / "most recent" — those are list with limit.`,
    `   These signals apply in ALL domains including bypass domains (novade_sync, safety_image, etc.). NEVER silently ignore "latest" — if you can't pick a sort field, default to 'Created Timestamp' desc with limit=1.`,
    ``,
    `# Question types (closed list — pick EXACTLY ONE):`,
    `  • point_lookup  — "what is X for date D" (single scalar answer for one entity).`,
    `  • count         — "how many X" (cardinality of rows matching filters, optionally grouped).`,
    `  • aggregate     — "total/sum/avg/min/max of metric X" (a single reducer over rows).`,
    `  • distribution  — "breakdown of X by Y" (grouped counts/sums — multi-row table).`,
    `  • trend         — "X over time" (one value per day/period — time series).`,
    `  • comparison    — "X vs Y" / "this week vs last week" (two windows side by side).`,
    `  • top_n         — "top 5 X by Y" (sorted, limited).`,
    `  • ranking       — "which X has most/least Y" (single winner, possibly with ties).`,
    `  • ratio         — "X as % of Y" (numerator / denominator).`,
    `  • threshold     — "how many X above/below limit" (over vs under counts).`,
    `  • status        — "current status of X" (state at last update).`,
    `  • list          — "list all X with property Y" (rows themselves, no aggregation).`,
    `  • gap           — "what's missing / who didn't report" (set difference).`,
    `  • unsupported   — out of scope for any domain.`,
    ``,
    `# Domain registry (closed list — pick EXACTLY ONE):`,
    buildDomainPromptFragment(),
    `  • document_log     — document register / submittal log. Side-effect operations only.`,
    `  • report_generation — generate PDF/Excel reports. Side-effect operations only.`,
    `  • master_register_image — screenshot of the Master Document Register filtered to outstanding rows at a specific LOCATION (and optionally one DOC TYPE). Side-effect: posts WhatsApp images. Triggered by "outstanding [doctype]? for [location]" / "show me outstanding docs for arena" / "outstanding rfi for arena" patterns where the user clearly wants an IMAGE of the register, not a text list.`,
    `  • safety_image — screenshot of the Safety Google Sheet filtered by date + optional status (open/closed), severity (P1/P2/P3), category, location. Side-effect: posts WhatsApp images. Triggered when the user explicitly says "send screenshot" / "screenshot" / "image" for safety data (otherwise pure text questions stay on the analytical 'safety' domain).`,
    `  • unsupported       — no domain handles this.`,
    ``,
    `# Permissive classification — DEFAULT TO A REAL DOMAIN`,
    `   NEVER reject a reasonable question as 'unsupported' just because the wording is unfamiliar. The lexical heuristics above are EXAMPLES — many synonyms exist on a construction site. Apply this priority order:`,
    `     1. Words about people / how many people / on-site crews → manpower`,
    `     2. Words about safety incidents / observations / P-levels → safety`,
    `     3. Words about trucks / loads / soil / spoil / disposal → soil_disposal`,
    `     4. Words about heat / temperature / WBGT → wbgt`,
    `     5. Words about noise / dBA / how loud → noise`,
    `     6. Words about piles / D-wall / barrette / JGP → piling_progress`,
    `     7. Words about instruments / rigs / monitoring sensors → im_progress`,
    `     8. Words about CJ / capping beam / pile cap construction stages (hacking/rebar/formwork) → pile_cap`,
    `     8b. Words about concrete progress / casting status / how much concrete cast or poured / cast volume vs total order / concrete delivery / DO for a LOCATION → concrete`,
    `     9. Words about RFI / RFA / MS / transmittal / submittal / Aconex / approval notice / overdue documents / due this week → document_tracking (analytical)`,
    `    10. Verb "generate/send/export" + "report/summary/PDF" → report_generation (bypass)`,
    `    11. Phrase contains "document log" → document_log (bypass)`,
    `   Only use domain='unsupported' when the question is GENUINELY out of scope (e.g., HR questions, weather forecast, the user is chatting). When in doubt, pick the closest domain — the downstream layers will handle "no data" gracefully.`,
    ``,
    `# Mandatory rules`,
    `1. Time window — Resolve relative phrases ("today", "yesterday", "last week", "this month", "past 7 days") against the pre-computed anchors above. If the user names a specific date like "5 May" or "5 May 2026", set kind='single' and start_iso=end_iso. If no time is mentioned at all, default kind='single' to TODAY. For "past N days" / "last N days" or "May 5–11", set kind='range'.`,
    `2. target_metric — must be one of the metric names listed under the chosen domain. For 'list', 'status', 'gap', 'point_lookup' set target_metric to the most relevant metric (or "" for free-form list).`,
    `3. target_aggregation — pick the reducer the QUESTION needs, not the question_type:`,
    `      • If the metric is numeric (headcount, volume_m3, leq_5min, current_depth_m, completed_count, total_count, …) and the user asks "how many"/"total"/"how much" → 'sum'.`,
    `      • If the metric ends in '_count' AND each row IS one of the counted units (trip_count→one row=one trip, issue_count→one row=one issue, activity_count→one row=one activity) → 'count'.`,
    `      • For 'avg', 'min', 'max' → match the user's wording ("average", "lowest", "peak", "highest").`,
    `      • For trend/distribution → use the reducer the metric implies (numeric→'sum', cardinality→'count').`,
    `      • For list/status/point_lookup/gap → 'none'.`,
    `4. filters — declarative WHERE conditions. Use dimension names exactly as listed, and CANONICAL enum values (the EXACT casing/spelling shown in each dimension's enum list). When the user writes "strain gauges" or "STRAIN GAUGE" but the dimension Code lists "SG", emit value='SG'. NEVER invent free-text filter values for enum dimensions. Examples:`,
    `      "P1 safety issues" → filters: [{field:'Severity', op:'=', value:'P1'}]`,
    `      "open issues" → filters: [{field:'Status', op:'=', value:'open'}]`,
    `      "wohhup manpower" → filters: [{field:'Company', op:'=', value:'Woh Hup'}]`,
    `      "KTC trips" → filters: [{field:'Subcon', op:'=', value:'KTC'}]`,
    `      "Bored Pile" → filters: [{field:'Work_Type', op:'=', value:'Bored Pile'}]`,
    `      "strain gauges" / "strain gauge" → filters: [{field:'Code', op:'=', value:'SG'}]   (NOT value:'Strain Gauge')`,
    `      "inclinometer" / "IW" → filters: [{field:'Code', op:'=', value:'IW'}]`,
    `      "standpipe" / "GWS" → filters: [{field:'Code', op:'=', value:'GWS'}]`,
    `      "piezometer" / "GWV" → filters: [{field:'Code', op:'=', value:'GWV'}]`,
    `      "prism" / "XYZ" → filters: [{field:'Code', op:'=', value:'XYZ'}]`,
    `      "settlement marker" / "LG" → filters: [{field:'Code', op:'=', value:'LG'}]`,
    `      "concrete progress for Tower A" / "casting status at 01TB154" → filters: [{field:'Location', op:'like', value:'Tower A', values:null}]   (concrete location is FREE-TEXT — pass the user's text through verbatim, partial/contains match, no enum canonicalization)`,
    `5. group_by — what to bucket by. "by company", "per shift", "by severity" → group_by=[{field:'Company'}] etc.`,
    `   "Hourly" / "per hour" / "by hour" on a single date → question_type='distribution', group_by=[{field:'Hour'}] (NOT trend — trend is for multi-day periods).`,
    `   "per day" / "daily" / "over time" / "trend" / "for the past N days" → question_type='trend', group_by=[{field:'Date'}].`,
    `   Empty group_by for plain count or single-value aggregate.`,
    `6. comparison_baseline — only for question_type='comparison'; describe the baseline window. Otherwise null.`,
    `   • DETERMINISTIC ORDERING: When the user says "compare X and Y" OR "X vs Y", the FIRST-mentioned period is the BASELINE (comparison_baseline) and the SECOND-mentioned is the CURRENT (time_window). For "this week vs last week", current=this week, baseline=last week. For "compare 2026-05-07 and 2026-05-08", baseline=2026-05-07, current=2026-05-08. Always older→baseline, newer→current when both are absolute dates.`,
    `   • CATEGORY vs TIME: question_type='comparison' is ONLY for comparing two TIME WINDOWS. When the user says "compare X and Y" where X and Y are CATEGORIES (locations, companies, severities, subcons, work types) on the SAME date — that is question_type='distribution' with group_by=[{field: <that-dimension>}], NOT comparison. Examples:`,
    `     • "compare noise between NM1 and NM2 on 2026-05-08" → distribution, group_by=[{field:'Location'}]`,
    `     • "compare manpower between Wohhup and LT SAMBO today" → distribution, group_by=[{field:'Company'}]`,
    `     • "compare P1 and P2 safety today" → distribution, group_by=[{field:'Severity'}]`,
    `     • "compare D-Wall vs Cross-Wall progress today" → distribution, group_by=[{field:'Work_Type'}]`,
    `7. limit — for top_n (e.g., "top 5"→5) AND for "latest"/"most recent" hints (default 1; "latest N" or "most recent N"→N). Otherwise null.`,
    `7a. **DO NOT emit duplicate filters when the user uses a colloquial word.** A recognised Severity VALUE ("P1", "P2", "P3", "Good Observation", "GO") MUST map to ONE filter only — {field:'Severity', op:'=', value:<that value>}. Do NOT ALSO emit a Category filter just because the user wrote "P1 category" / "Good Observation category" / "the GO type of issue" — the words "category" / "type" / "kind" are colloquial here and refer to the Severity bucket, NOT the Category column. Same for any other field with a closed enum (Status open/closed). Example:`,
    `       "sync the latest Good Observation category issue yesterday" → ONE filter Severity='Good Observation' (NOT Severity AND Category both). Plus order_by Created Timestamp desc, limit=1 per the "latest" rule.`,
    `       "show me P1 type issues today" → ONE filter Severity='P1' (NOT Severity AND Category both).`,
    `   Counter-example where Category IS the right field: the user mentions an actual category VALUE that is NOT a known Severity ("housekeeping issues today", "PPE issues this week") → those map to {field:'Category', op:'=', value:'housekeeping'/'PPE'} — Severity stays unfiltered.`,
    `8. unsupported_reason — required when question_type='unsupported' OR domain='unsupported'. Null otherwise.`,
    `9. You MUST NOT compute, infer, fabricate, or answer anything. Your output is intent only.`,
    `10. Both 'filters' values and 'values' are required by schema — set 'value' for scalar ops, set 'values' for 'in' op, set the unused one to null.`,
    ``,
    `# Domain selection heuristics`,
    `   • "manpower / headcount / how many workers / how many people / pax / engineer / staff / day shift / night shift / who's on site / how many on site / crew / labour / labor / personnel" → manpower`,
    `   • "safety issue / safety / P1 / P2 / P3 / good observation / GO / observation / open issue / closed issue / breach / unsafe act / NCR / non-conformance / hazard / incident / accident / near miss" → safety`,
    `   • "soil disposal / soil out / spoil removal / cart away / dispose / disposal / loads / load count / how many loads / truck loads / truck trips / truck count / how many trucks / dumper / tipper / lorry / lorries / dump trips / dumping ground / KTC / KKL / carplate / car plate / volume out / m3 removed" → soil_disposal`,
    `   • "WBGT / heat stress / heat index / temperature outdoor / outdoor temp / how hot / heat alert / work-rest / is it too hot" → wbgt`,
    `   • "noise / Leq / dBA / decibels / how loud / loud / sound level / NM1 / NM2 / noise monitor / NEA limit / noise exceedance" → noise`,
    `   • "pile / piles / D-wall / D wall / dwall / cross-wall / cross wall / bored pile / BP / barrette / JGP / coring / base grouting / pile depth / casting volume / foundation / piling completion" → piling_progress`,
    `   • "IM / instrumentation / instrument / inclinometer / piezometer / standpipe / strain gauge / prism / settlement marker / tiltmeter / extensometer / load cell / crack meter / vibrating wire / rig1 / rig2 / IW / GWS / GWV / SG / XYZ / LG" → im_progress`,
    `   • "CJ / pile cap / capping beam / hacking / lean concrete / rebar / formwork / casting / dismantle formwork / construction joint" → pile_cap`,
    `   • "concrete progress for <location> / casting status at <location> / how much concrete cast (or poured) for <location> / cast volume vs total order / concrete delivery / delivery order / DO for <location>" → concrete. This is per-LOCATION concrete DELIVERY/casting VOLUME tracking. Set question_type='status', target_metric='casting_status', target_aggregation='none', and emit a Location filter {field:'Location', op:'like', value:<location verbatim>, values:null}. DISAMBIGUATION: choose 'concrete' (NOT pile_cap, NOT piling_progress) when the user asks about how much concrete was CAST/POURED or casting PROGRESS/STATUS for a named LOCATION — even if that location name contains "CJ" (e.g. "HL1CJ2 beam 01TB154"). Choose pile_cap only for CJ pile-cap CONSTRUCTION STAGES (hacking/rebar/formwork/"is CJ8 ready for casting"); choose piling_progress only for pile/D-wall "casting volume". The word "concrete" or "how much concrete cast/poured" is the decisive concrete signal.`,
    `   • "RFI / RFA / MS / method statement / transmittal / submittal / submission / approval notice / rejection notice / response to RFI / Aconex / mail_no / IR2-NNN / IR2-NNN-CN-NNNN (change notice) / IR2-NNN-PMI-NNNN (project manager instruction) / WHP_*_RIN_NNNN (request for inspection) / CN / PMI / RIN / change notice / project manager instruction / request for inspection / inspection form / closed inspection form / incoming docs / outgoing docs / docs sent / docs received / overdue RFI / overdue RFA / due this week / response time / turnaround / who answered / pending response / open RFI / closed RFI / approval status / consultant reply" → document_tracking. Note: phrase "document log" still wins for document_log bypass (PDF generation); document_tracking handles every OTHER document-related analytical question.`,
    `   • "generate report" / "send daily summary" / "send daily report" / "generate daily safety summary" / "generate safety report" / "export PDF" / "send weekly report" / "send the report" → ALWAYS domain=report_generation, question_type=unsupported (this is a side-effect action — the bypass handler generates the actual PDF/Excel/text report). The trigger is the verb "generate" / "send" / "export" / "create" combined with "report" / "summary" / "PDF". time_window MUST still be resolved (start_iso/end_iso/label) — the bypass uses it.`,
    `   • **CRITICAL ROUTING — safety summary (the cron-style message)**: ANY question whose head matches the pattern "[verb] safety [issue(s)/daily] summary [date qualifier]" — including bare "safety summary <date>" with NO verb — routes to domain=report_generation, question_type=unsupported. The bypass returns the canonical EventBridge cron message ("MBS IR2 Project / Safety Issues Summary (as of …) / Total issues reported / Open issues by date"). This INCLUDES "safety summary today" — do NOT route that to analytical 'safety' even though "today" is the default time window for everything else. "today" / "yesterday" / "this week" are date qualifiers, NOT decisions about the question type. Variants ALL routing to report_generation:`,
    `       Verb-led:  "send safety summary" / "send safety issue summary" / "send safety issues summary" / "send safety daily summary" / "send daily safety summary" / "give me safety summary" / "generate safety summary"`,
    `       Bare-with-date:  "safety summary today" / "safety summary yesterday" / "safety summary for today" / "safety summary for yesterday"`,
    `       Bare-with-explicit-date:  "safety summary on 2026-05-08" / "safety summary 2026-05-08" / "safety summary for 2026-05-08" / "safety summary on 8-May-2026"`,
    `       Bare-with-range:  "safety summary for this week" / "safety summary last week" / "safety summary this month" / "safety summary last month" / "safety summary from 2026-05-15 to 2026-05-18" / "safety summary for the past 7 days"`,
    `       Daily-prefix:  "daily safety summary" / "safety daily summary" / "safety issues summary today"`,
    `     time_window MUST be resolved per the standard date rules — kind='single' for single dates (today/yesterday/explicit), kind='range' for ranges (this week / last month / from X to Y / past 7 days). The bypass reads time_window.start_iso/end_iso to fetch the right data.`,
    `     Counter-examples that STAY on the analytical 'safety' domain (they ask about safety issues but are NOT the cron-style summary):`,
    `       "safety by severity" / "safety issues by severity" / "breakdown of safety issues by severity"`,
    `       "how many safety issues today" / "how many open issues" / "how many P1 today"`,
    `       "give a breakdown of safety issues" / "safety issues by location" / "safety issues by category"`,
    `     Decider: the head of the question is the exact phrase "safety summary" / "safety issue(s) summary" / "daily safety summary" / "safety daily summary" (with or without a leading verb). If yes → report_generation. If no → analytical safety.`,
    `   • **CRITICAL ROUTING — outstanding-image questions**: ANY question matching the pattern "outstanding <X> for/in/at <Y>" where Y is a LOCATION (Arena, Basement, Podium, Arena Plaza, External, MRT, Plaza, Carpark, Sewer, Level 1/2/3, etc.) MUST route to **domain=master_register_image**, NOT document_tracking. This rule supersedes any other matching rule including the "outstanding RFIs in Arena → document_tracking" rule below.`,
    `       Examples that ALL route to master_register_image:`,
    `         "outstanding rfi for arena" / "outstanding rfi in arena" / "outstanding RFI at Arena"`,
    `         "outstanding rin for basement" / "outstanding RINs for Basement"`,
    `         "outstanding pmi for arena" / "outstanding PMIs for Arena"`,
    `         "outstanding shd for podium" / "outstanding shop drawings for Podium"`,
    `         "outstanding docs for arena" / "outstanding documents for arena" / "outstanding doc for arena"`,
    `         "show me outstanding rfi for basement" / "show outstanding docs for arena" / "send outstanding docs for arena"`,
    `         "list outstanding rfi for arena" / "any outstanding rfi for arena" / "what outstanding rfi for arena"`,
    `       For these set: question_type=unsupported, target_metric="", target_aggregation="none", time_window kind='single' to TODAY.`,
    `       MANDATORY filters:`,
    `         • Location filter (always): {field:'Location', op:'=', value:'Arena'|'Basement'|'Podium'|'Arena Plaza'|'External'|'MRT'|'Plaza'|'Carpark'|'Sewer'|'Level 1'|'Level 2'|'Level 3'|'Level 1 Mezzanine'|'Level 2 Mezzanine'|'General'}. Use the CANONICAL Title-Case name even if user said "ARN" / "arena" / "areana".`,
    `         • DocKind filter (only when user names a doctype): {field:'DocKind', op:'=', value:'RFI'|'RIN'|'PMI'|'SHD'|'MS'|'MT'|'ITP'|'QA'|'CN'}.`,
    `       When user says "docs"/"documents"/"doc" WITHOUT a doctype, OMIT the DocKind filter. The bypass will screenshot all 9 doc-type tabs filtered to the location.`,
    `       Pure text-list questions like "how many RFIs in Arena" or "list RFIs in Arena" (no "outstanding" word) still go to document_tracking. The trigger keyword for master_register_image is "outstanding" combined with a location.`,
    `   • **CRITICAL ROUTING — safety screenshot questions**: ANY question that asks for a SCREENSHOT / IMAGE of SAFETY ISSUES routes to **domain=safety_image**, NOT the analytical 'safety' domain.`,
    `       The trigger is "screenshot" / "image" + an "issues"-style keyword (issues / safety issues / P1 / P2 / P3 / good observation / GO / incident / near miss / hazard / open / closed). The word "safety" itself is OPTIONAL — most asks won't repeat it.`,
    `       Examples that ALL route to safety_image (note: same intent whether or not "in safety" is appended):`,
    `         "send screenshot of open issues today"             ⇄ "send screenshot of open issues today in safety sheet"`,
    `         "send screenshot of open issues"                    (no date → defaults to today)`,
    `         "send screenshot of P1 issues yesterday"            ⇄ "send screenshot of P1 issues yesterday in safety"`,
    `         "screenshot of closed issues on 2026-05-08"          ⇄ ".. in safety"`,
    `         "send image of all issues today"                     "send image of all safety issues today"`,
    `         "send screenshot of issues in Zone 1 today"          "send screenshot of safety issues in Zone 1 today"`,
    `         "send screenshot of good observations today"`,
    `       MUST be IDENTICAL intent regardless of whether the user appends "in safety" / "in safety sheet" / nothing. Same domain, same filters, same time_window — the suffix is decorative.`,
    `       BUT — don't route document-style screenshot asks here:`,
    `         "send screenshot of RFI/RFA/PMI/CN/RIN/SHD/MS/MT/ITP" → master_register_image (different bypass)`,
    `         "send screenshot of [doctype] for [location]"          → master_register_image`,
    `         "outstanding rfi for arena"                           → master_register_image (covered above)`,
    `       For safety_image set: question_type=unsupported, target_metric="", target_aggregation="none".`,
    `       Resolve the time_window the SAME WAY as for the analytical safety domain (today / yesterday / "on 2026-05-08" / "this week" / range / etc.). If no date is mentioned, default to TODAY (kind='single', start_iso=end_iso=today).`,
    `       Filters mirror the analytical safety domain:`,
    `         • Status filter: "open issues" → {field:'Status', op:'=', value:'open'}; "closed issues" → value:'closed'. If user says "all issues" / just "issues" without a status word, omit the Status filter.`,
    `         • Severity filter: "P1 issues" → {field:'Severity', op:'=', value:'P1'}; same for P2/P3; "good observations" / "GO" → {field:'Severity', op:'=', value:'Good Observation'}.`,
    `         • Location / Category / Sender filters: same as analytical safety.`,
    `       Pure text questions like "how many open issues today" / "list open issues today" stay on the analytical 'safety' domain. The "screenshot" / "image" word is the decider — if it's absent, stay on analytical.`,
    `   • **CRITICAL ROUTING — novade sync / status questions**: ANY question about pushing safety issues to the Novade safety platform OR checking sync/action status in Novade routes to **domain=novade_sync**. Set question_type=unsupported, target_metric="", target_aggregation="none". time_window MUST be resolved exactly as for analytical safety — that window is the STRICT row filter, NEVER expanded (no "3-day window" or similar). The bypass uses time_window.start_iso/end_iso as the only date bound.`,
    `       MANDATORY filter — emit exactly one synthetic filter on top of any normal Status/Severity/etc filters: {field:'__action__', op:'=', value:'sync'|'status_sheet'|'status_novade'} (values:null for this filter).`,
    `       SYNC triggers (set __action__='sync'):`,
    `         "sync safety issues today to novade" / "sync today's safety issues to novade"`,
    `         "push open issues this week to novade" / "push P1 issues yesterday to novade"`,
    `         "sync issues from 2026-05-15 to 2026-05-18 to novade"`,
    `         "upload safety issues last week to novade"`,
    `         "send/push closed issues yesterday to novade"`,
    `       STATUS_SHEET triggers (set __action__='status_sheet'):`,
    `         "have all safety issues today been synced to novade"`,
    `         "are today's issues synced to novade yet"`,
    `         "how many issues today are not yet synced to novade"`,
    `         "which issues this week haven't been synced to novade"`,
    `       STATUS_NOVADE triggers (set __action__='status_novade'):`,
    `         "novade action status of closed issues today"`,
    `         "what is the novade status of closed issues yesterday"`,
    `         "check novade status for closed safety issues this week"`,
    `       Additional filters extracted from the question (e.g. Status='open', Severity='P1') MUST also be emitted as normal filters — the bypass uses them to pre-filter sheet rows.`,
    `       Counter-examples that STAY on the analytical 'safety' domain (no novade keyword, NOT a sync request):`,
    `         "how many safety issues today" → safety (count)`,
    `         "how many open issues" → safety (count)`,
    `         "breakdown of safety issues by severity" → safety (distribution)`,
    `         "safety summary today" → report_generation (cron message)`,
    `         "send screenshot of open issues today" → safety_image`,
    `         "any unresolved safety issues?" → safety`,
    `       Decider: the question MUST contain the keyword "novade" OR an explicit "synced to novade" / "sync to novade" / "push to novade" / "novade action" / "novade status" phrase. Without that keyword, route to analytical safety. The mere presence of "sync" alone (e.g. "sync issues with engineer") is NOT enough — novade must be named.`,
    `       **EXCLUSIONS** — these stay on document_tracking even though they say "outstanding":`,
    `         • "how many outstanding [X] in [Y]" / "count outstanding [X] for [Y]" → document_tracking, question_type=count, target_metric=open_count. User wants a NUMBER, not an image.`,
    `         • "are there any outstanding [X] in [Y]?" without "show me" / "list" / "send" / "image" / "screenshot" → document_tracking. User wants a yes/no answer in text.`,
    `         • Any "outstanding" question that does NOT name a Location → document_tracking. master_register_image requires a Location filter.`,
    `   • "document log" / "RFI" / "drawing register" / "submittal" → domain=document_log. The phrase "document log" ALWAYS wins over the "send/generate/report" verbs — "send document log", "generate document log report", "approve document log", "show document log" ALL route to domain=document_log (NOT report_generation), question_type=unsupported.`,
    ``,
    `# Compound / combination questions — the IMPORTANT pattern`,
    `   The user often glues multiple sub-questions together:`,
    `     "how many total? how many closed? breakdown by severity"  (3 sub-asks)`,
    `     "manpower yesterday? breakdown by company and role"        (2 sub-asks + 2 dimensions)`,
    `     "how many open issues and how many P1?"                    (2 conditional counts)`,
    `   For ANY compound question:`,
    `   • Always pick question_type='distribution' (not count, not aggregate).`,
    `   • Put EVERY mentioned grouping dimension into group_by, in order of mention. Examples:`,
    `       "breakdown by company and role"     → group_by=[{field:'Company'},{field:'Role'}]`,
    `       "by severity and status"            → group_by=[{field:'Severity'},{field:'Status'}]`,
    `       "by subcon and dumping ground"      → group_by=[{field:'Subcon'},{field:'DumpingGround'}]`,
    `       "by company and shift"              → group_by=[{field:'Company'},{field:'Shift'}]`,
    `   • Pick target_metric matching the WIDEST sub-ask ("how many total + closed" → issue_count, not closed_count).`,
    `   • NEVER mark compound questions as unsupported. The format-override layer will render total + sub-breakdowns automatically when the meta-enricher exposes them.`,
    `   • For safety compound questions, ALWAYS include Severity in group_by (even when not explicitly requested) so the comprehensive formatter has the data. For manpower with role mentions, ALWAYS include Role in group_by.`,
    ``,
    `# "Summary" / "overall progress" / "today's X" → distribution`,
    `   Domain-default summary questions ALWAYS want a per-category breakdown, NOT a single scalar. Map these to question_type='distribution' with the right group_by:`,
    `     • "piling progress summary" / "today piling progress" / "show piling completion" → distribution, target_metric=completed_count, group_by=[{field:'Work_Type'}]`,
    `     • "IM progress summary" / "today IM progress" / "instrumentation progress" → distribution, target_metric=completed_count, group_by=[{field:'Code'}], filter Record_Type='summary'`,
    `     • "pile cap progress" / "CJ summary" / "today CJ updates" → distribution, target_metric=update_count, group_by=[{field:'CJ'}]`,
    `     • "safety summary" / "safety today" → distribution, target_metric=issue_count, group_by=[{field:'Severity'}]`,
    `     • "manpower summary" / "today manpower breakdown" → distribution, target_metric=headcount, group_by=[{field:'Company'}]`,
    `     • "soil disposal summary" / "today trips by subcon" → distribution, target_metric=trip_count, group_by=[{field:'Subcon'}]`,
    `     • "document log summary" / "today document summary" / "documents today" → distribution, target_metric=document_count, group_by=[{field:'Direction'},{field:'DocKind'}] (note: this is document_tracking, NOT the bypass)`,
    `     • "RFI/RFA/MS due this week" / "list RFI RFA MS due this week" → list, target_metric=open_count, filters=[{field:'DocKind', op:'in', values:['RFI','RFA','MS']}, {field:'DueStatus', op:'=', value:'due_this_week'}]`,
    `     • "overdue RFIs" / "any overdue documents" → list, target_metric=overdue_count, filters=[{field:'DueStatus', op:'=', value:'overdue'}] (optionally + {field:'DocKind', op:'=', value:'RFI'})`,
    `     • "incoming documents today" / "incoming docs today" → distribution, target_metric=document_count, group_by=[{field:'DocKind'}], filters=[{field:'Direction', op:'=', value:'incoming'}]`,
    `     • "outstanding RFIs in Arena" / "outstandings docs for Basement" / "open documents for Podium" / "any open docs in MRT this week" → list, target_metric=open_count, filters=[{field:'Location', op:'=', value:'<canonical>'}, (optionally) {field:'DocKind', op:'=', value:'RFI'}]. **CRITICAL: DO NOT add a DueStatus filter.** "outstanding" / "outstandings" / "open" (without a more specific status word) means ALL three unresolved states (overdue + due_this_week + open). The open_count metric already covers that via its filterDefault — adding {DueStatus='open'} would NARROW it to only the >7-days-remaining bucket and miss the overdue + due-this-week buckets. ONLY add a DueStatus filter when the user explicitly says "overdue" alone, "due this week" alone, or "due next week" alone. The Location filter uses the CANONICAL enum value (Arena / Basement / Podium / General / External / MRT / Sewer / Carpark / Plaza / Arena Plaza / Level 1 / Level 2 / Level 3 / Level 1 Mezzanine / Level 2 Mezzanine), never the 3-letter code (ARN / BSM / POD / etc.). Match canonical regardless of casing, typos, or abbreviations: "in arena" / "in ARENA" / "for areana" (typo for Arena) / "ARN docs" / "at basement" / "for BSM" → all map to the canonical Title-Case name.`,
    `     • "show me all PMI" / "list PMIs" / "all PMI documents" / "Project Manager Instructions" / "IR2-NNN-PMI-NNNN" → list, target_metric=pmi_count. No DocKind filter needed — pmi_count's filterDefault already filters DocKind='PMI'. Always use time_window kind='all_time' for "all PMI" / "all the PMI" queries unless the user names a specific window. (PMIs are MBS-only by classifier guard so no Direction filter needed.)`,
    `     • "show me all document with CN replies" / "all CN replies" / "Change Notice replies" / "replies to CN" → list, target_metric=cn_reply_count. The cn_reply_count metric's filterDefault filters IsCNReply=true. Time window 'all_time' unless user specifies otherwise.`,
    `     • "show me all CN" / "list CN" / "all change notices" / "CN documents" → list, target_metric=cn_count (DocKind='CN' default).`,
    `     • "show me all RIN closed inspection form" / "RIN closed" / "closed RIN inspections" / "closed inspection forms" / "all closed RIN" → list, target_metric=rin_closed_count. The metric's filterDefault filters IsRINClosed=true. Time window 'all_time' unless specified.`,
    `     • "show me all RIN" / "list RIN" / "request for inspection" / "inspection forms" → list, target_metric=rin_count (DocKind='RIN' default).`,
    `   For ANY "show me X" / "X today summary" / "overall X progress" phrasing — default to distribution with the domain's primary group_by dimension.`,
    ``,
    `# Wohhup family`,
    `   Treat "wohhup", "woh hup", "woh-hup", "WHPL" as a single Company='Woh Hup' filter. The data layer merges WHPL into "Woh Hup" canonically.`,
    `   "wohhup manpower [date]" / "WH manpower [date]" with NO "breakdown" / "by" qualifier → question_type='aggregate' (NOT distribution), target_metric='headcount', target_aggregation='sum', filters=[Company='Woh Hup']. Distribution is reserved for ACROSS-company questions like "manpower by company".`,
    ``,
    `# Wohhup specialty metrics (manpower domain — apply filter Company='Woh Hup')`,
    `   • "wohhup staff" → target_metric=staff_count`,
    `   • "wohhup TS" / "WH TS" / "trade skill" → target_metric=ts_count`,
    `   • "wohhup NTS" / "non-trade skill" → target_metric=nts_count`,
    `   • "wohhup TS and NTS" / "staff TS/NTS breakdown" → question_type=distribution, target_metric=staff_count, group_by=[{field:"Role"}]  (the renderer recognises this as a TS+NTS template)`,
    `   • "wohhup day TS" / "day shift TS" → target_metric=day_ts_count`,
    `   • "wohhup night TS" / "night shift TS" → target_metric=night_ts_count`,
    `   • "wohhup day NTS" → target_metric=day_nts_count`,
    `   • "wohhup night NTS" → target_metric=night_nts_count`,
    `   • "wohhup workers on site" / "WH workers on-site" → target_metric=on_site_count`,
    `   • "wohhup workers on home leave" / "home leave" → target_metric=home_leave_count`,
    `   • "wohhup workers loaned out" / "on loan out" / "loaned out" → target_metric=loan_out_count`,
    `   • "wohhup workers loaned in" / "on loan in" → target_metric=loan_in_count`,
    `   • "wohhup workers on course" / "course" → target_metric=course_count`,
    `   • "wohhup workers medical leave" / "MC" / "sick leave" → target_metric=medical_leave_count`,
    `   • "wohhup workers absent" → target_metric=absent_count`,
    `   • "wohhup total register" / "workers register total" → target_metric=total_register`,
    `   • "wohhup workers register" / "workers status" / "where are the workers" → question_type=distribution, target_metric=on_site_count, group_by=[{field:"Status"}]  (the renderer recognises this as a workers-register template)`,
    `   For ALL these specialty metrics, the filter ALWAYS includes Company='Woh Hup'.`,
    ``,
    `# Style`,
    `   Respond with the JSON object that matches the schema. No prose, no code fences. Strict mode is on — every required field must be present.`,
  ].join("\n");
}

/** For tests — clear the in-memory intent cache. */
function clearIntentCache() {
  INTENT_CACHE.clear();
}

module.exports = {
  parseIntent,
  clearIntentCache,
  __test: { buildSystemPrompt, makeUnsupported, INTENT_CACHE },
};
