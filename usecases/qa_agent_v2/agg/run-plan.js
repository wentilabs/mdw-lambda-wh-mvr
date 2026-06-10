/**
 * Plan executor.
 *
 * Walks the ExecutionPlan steps produced by Layer 2, calls the appropriate
 * Layer-3 data plugin, then runs Layer-4 reducers. Returns a typed AnswerData
 * (the same shape Layer 5's templates expect). All numbers in AnswerData come
 * from `aggregators.js` reduce calls — never from anywhere else.
 */

const { getPlugin } = require("../data");
const {
  applyAgg,
  sortBreakdown,
  limitBreakdown,
  thresholdSplit,
  ratioCompute,
  latestPerEntity,
  compare,
} = require("./aggregators");
const { formatDayLabel, todaySgtIso } = require("../shared/time-window");
const { stageLog } = require("../shared/logging");
const { enrichMeta } = require("./meta-enrichers");

async function runPlan(plan, { groupConfig } = {}) {
  if (!plan) return makeUnsupported("Empty plan.");
  if (plan.answer_shape === "unsupported") return makeUnsupported(plan.unsupported_reason || "Out of scope.");
  if (plan.answer_shape === "bypass")
    return { kind: "bypass", domain: plan.intent?.domain, meta: makeMeta(plan, [], []) };

  // Comparison branch: run both legs, return a comparison answer.
  if (plan.steps[0]?.kind === "compare") {
    const baseline = await runPlan(plan.steps[0].baseline_plan, { groupConfig });
    const current = await runPlan(plan.steps[0].current_plan, { groupConfig });
    const cmp = compare({ value: baseline.value ?? baseline.total }, { value: current.value ?? current.total });
    return {
      kind: "comparison",
      baseline,
      current,
      delta: cmp.delta,
      pct_change: cmp.pct_change,
      meta: makeMeta(plan, [], unionSources(baseline, current)),
    };
  }

  // Step 1: fetch_rows (always first for non-comparison plans).
  let rows = [];
  let sources = [];
  let plugin = null;
  for (const step of plan.steps) {
    if (step.kind !== "fetch_rows") continue;
    plugin = getPlugin(step.domain);
    if (!plugin) return makeUnsupported(`No plugin for domain '${step.domain}'.`);
    rows = await plugin.fetchRows({
      window: step.window,
      filters: step.filters || [],
      select: step.select,
      groupConfig,
    });
    sources.push(plugin.name);
    break;
  }

  const meta = makeMeta(plan, rows, sources);
  // Merge domain-specific context for format overrides (Wohhup TS/NTS,
  // Piling Work_Type Completed/Total, IM rigs, CJ stage lists). The generic
  // templates ignore these — they're only consumed by `format/overrides.js`.
  Object.assign(meta, enrichMeta(plan.intent?.domain, rows, plan.intent));
  // Carry intent through to the formatter so overrides can read target_metric.
  meta.intent = plan.intent;

  // No data → return a zero-shaped answer so the formatter has a clean shape.
  if (!rows || rows.length === 0) return zeroAnswer(plan, meta);

  // Walk the remaining steps.
  let intermediate = { rows };
  for (const step of plan.steps) {
    if (step.kind === "fetch_rows") continue;
    intermediate = await applyStep(step, intermediate, plan);
  }

  // Wrap the intermediate into the final AnswerData by answer_shape.
  return finalizeAnswer(plan, intermediate, meta);
}

async function applyStep(step, prev, plan) {
  switch (step.kind) {
    case "aggregate": {
      const agg = applyAgg(prev.rows, step.op, step.field, step.group_by || []);
      return { ...prev, agg };
    }
    case "sort": {
      // Distribution-style answers carry breakdowns to sort; LIST-style
      // answers carry raw `rows`. Apply to whichever exists. Without this
      // branch, planList's sort step is a silent no-op for list answers —
      // "show me the latest X" returns ALL matching rows in arbitrary
      // order rather than the latest 1.
      if (prev.agg?.breakdown) {
        const breakdown = sortBreakdown(prev.agg.breakdown, step.by, step.dir);
        return { ...prev, agg: { ...prev.agg, breakdown } };
      }
      if (Array.isArray(prev.rows)) {
        return { ...prev, rows: sortRows(prev.rows, step.by, step.dir) };
      }
      return prev;
    }
    case "limit": {
      if (prev.agg?.breakdown) {
        const breakdown = limitBreakdown(prev.agg.breakdown, step.n);
        return { ...prev, agg: { ...prev.agg, breakdown } };
      }
      if (Array.isArray(prev.rows)) {
        const n = Number(step.n) > 0 ? Number(step.n) : prev.rows.length;
        return { ...prev, rows: prev.rows.slice(0, n) };
      }
      return prev;
    }
    case "ratio_compute": {
      const ratio = ratioCompute(prev.rows, step.target_metric);
      return { ...prev, ratio };
    }
    case "threshold_split": {
      const split = thresholdSplit(prev.rows, step.field, step.filters || []);
      return { ...prev, threshold: split };
    }
    case "latest_per_entity": {
      const latest = latestPerEntity(prev.rows, step.entity_field || "Date");
      return { ...prev, latest };
    }
    case "gap_compute": {
      // For now produce a placeholder; richer gap logic added per domain on demand.
      return { ...prev, gap: { missing_keys: [], expected_universe: "" } };
    }
    case "passthrough":
    default:
      return prev;
  }
}

function finalizeAnswer(plan, x, meta) {
  switch (plan.answer_shape) {
    case "point_lookup":
      return {
        kind: "point_lookup",
        value: x.agg ? x.agg.value : x.rows[0] ? coerceNumber(x.rows[0]) : null,
        label: plan.intent?.target_metric || "value",
        meta,
      };
    case "count":
      return {
        kind: "count",
        total: x.agg?.value ?? x.rows.length,
        breakdown: x.agg?.breakdown || null,
        meta,
      };
    case "aggregate":
      return {
        kind: "aggregate",
        value: x.agg?.value ?? null,
        op: planAggOp(plan),
        field: planAggField(plan),
        breakdown: x.agg?.breakdown || null,
        meta,
      };
    case "distribution":
      return {
        kind: "distribution",
        total: x.agg?.value ?? 0,
        rows: x.agg?.breakdown || [],
        meta,
      };
    case "trend": {
      const series = (x.agg?.breakdown || []).map((b) => ({
        period_iso: b.keyParts?.[0] || b.key,
        period_label: b.keyParts?.[0] ? formatDayLabel(b.keyParts[0]) : b.key,
        value: b.value,
      }));
      const total = series.reduce((s, p) => s + (Number(p.value) || 0), 0);
      const avg_per_period = series.length ? total / series.length : 0;
      return { kind: "trend", series, total, avg_per_period, meta };
    }
    case "top_n":
      return {
        kind: "top_n",
        rows: (x.agg?.breakdown || []).map((b, i) => ({ rank: i + 1, key: b.key, value: b.value })),
        total_universe: x.agg?.value ?? 0,
        meta,
      };
    case "ranking": {
      const winners = (x.agg?.breakdown || []).map((b, i) => ({ rank: i + 1, key: b.key, value: b.value }));
      return { kind: "ranking", winners, meta };
    }
    case "ratio":
      return {
        kind: "ratio",
        numerator: x.ratio?.numerator ?? 0,
        denominator: x.ratio?.denominator ?? 0,
        ratio: x.ratio?.ratio ?? 0,
        pct: x.ratio?.pct ?? 0,
        meta,
      };
    case "threshold":
      return {
        kind: "threshold",
        over: x.threshold?.over ?? 0,
        under: x.threshold?.under ?? 0,
        threshold: x.threshold?.threshold ?? 0,
        meta,
      };
    case "status": {
      const latestRows = x.latest || x.rows || [];
      return {
        kind: "status",
        rows: latestRows,
        meta,
      };
    }
    case "list":
      return {
        kind: "list",
        rows: x.rows,
        total: x.rows.length,
        truncated: false,
        meta,
      };
    case "gap":
      return {
        kind: "gap",
        missing_keys: x.gap?.missing_keys || [],
        expected_universe: x.gap?.expected_universe || "",
        meta,
      };
    default:
      return makeUnsupported(`Unhandled answer_shape: ${plan.answer_shape}`);
  }
}

function zeroAnswer(plan, meta) {
  switch (plan.answer_shape) {
    case "count":
      return { kind: "count", total: 0, breakdown: null, meta };
    case "aggregate":
      return { kind: "aggregate", value: 0, op: planAggOp(plan), field: planAggField(plan), breakdown: null, meta };
    case "distribution":
      return { kind: "distribution", total: 0, rows: [], meta };
    case "trend":
      return { kind: "trend", series: [], total: 0, avg_per_period: 0, meta };
    case "top_n":
      return { kind: "top_n", rows: [], total_universe: 0, meta };
    case "ranking":
      return { kind: "ranking", winners: [], meta };
    case "ratio":
      return { kind: "ratio", numerator: 0, denominator: 0, ratio: 0, pct: 0, meta };
    case "threshold":
      return { kind: "threshold", over: 0, under: 0, threshold: 0, meta };
    case "list":
      return { kind: "list", rows: [], total: 0, truncated: false, meta };
    case "point_lookup":
      return { kind: "point_lookup", value: null, label: plan.intent?.target_metric || "value", meta };
    case "status":
      return { kind: "status", rows: [], meta };
    case "gap":
      return { kind: "gap", missing_keys: [], expected_universe: "", meta };
    default:
      return { kind: "unsupported", reason: "no_data", meta };
  }
}

function planAggOp(plan) {
  const agg = plan.steps?.find((s) => s.kind === "aggregate");
  return agg?.op || "count";
}
function planAggField(plan) {
  const agg = plan.steps?.find((s) => s.kind === "aggregate");
  return agg?.field;
}

function coerceNumber(row) {
  for (const k of Object.keys(row || {})) {
    if (typeof row[k] === "number") return row[k];
  }
  return null;
}

/**
 * Sort raw rows by a field name (case-insensitive, also tolerant of camelCase
 * variants like Created Timestamp → createdTimestampMs). Used by the `sort`
 * step in run-plan when the answer shape is `list` (raw rows, no breakdown).
 *
 * Field-name fallback order (first match wins per row):
 *   1. exact field name as-given ("Created Timestamp")
 *   2. lowercased + spaces stripped ("createdtimestamp" → fuzzy match key)
 *   3. specific safety-domain alias: Created Timestamp → S/N (proxy when
 *      timestamp not selected; S/N is monotonic, so S/N desc = newer first).
 *
 * Returns a NEW sorted array (doesn't mutate prev.rows).
 */
function sortRows(rows, by, dir) {
  if (!Array.isArray(rows) || rows.length <= 1) return rows;
  const direction = dir === "asc" ? 1 : -1;
  const target = String(by || "").trim();
  const targetLower = target.toLowerCase().replace(/\s+/g, "");
  // Resolve the field name on the FIRST row that has any candidate match.
  // Field key chosen ONCE so all rows sort by the same key (consistency).
  let key = null;
  const sample = rows[0];
  if (sample) {
    if (target in sample) key = target;
    else {
      for (const k of Object.keys(sample)) {
        if (k.toLowerCase().replace(/\s+/g, "") === targetLower) {
          key = k;
          break;
        }
      }
      // Domain-specific fallback: "Created Timestamp" → S/N (monotonic
      // proxy when the timestamp column wasn't included in the data SELECT).
      if (!key && targetLower === "createdtimestamp") {
        if ("SN" in sample) key = "SN";
        else if ("S/N" in sample) key = "S/N";
      }
    }
  }
  if (!key) return rows; // give up cleanly — preserves input order
  const out = rows.slice();
  out.sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    if (av === bv) return 0;
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * direction;
    return String(av) < String(bv) ? -direction : direction;
  });
  return out;
}

function makeMeta(plan, rows, sources) {
  // Include the metric's filterDefault in filters_applied so the formatter
  // can render filter-context words like "overdue", "open", "closed". The
  // filterDefault is a real semantic filter (e.g. open_count → Status='open'),
  // not just a planning hint — losing it from the rendered message changes
  // the answer's meaning.
  //
  // Conflict resolution: if the LLM intent produces ANY filter on the same
  // field as the metric's filterDefault, the LLM's filter is MORE SPECIFIC
  // (the user explicitly mentioned the value) → drop the filterDefault for
  // that field entirely. Otherwise we'd render "open/due_this_week/overdue ·
  // due_this_week" — same field, redundant + ugly.
  const plugin = plan.intent?.domain ? getPlugin(plan.intent.domain) : null;
  const metric = (plugin?.metrics || []).find((m) => m.name === plan.intent?.target_metric);
  const filterDefault = metric?.filterDefault || [];
  const intentFilters = plan.intent?.filters || [];
  const intentFields = new Set(intentFilters.map((f) => f?.field).filter(Boolean));
  const filteredDefault = filterDefault.filter((fd) => !intentFields.has(fd.field));
  return {
    domain: plan.intent?.domain || "unsupported",
    time_window: plan.intent?.time_window || { kind: "all_time", label: "" },
    filters_applied: [...filteredDefault, ...intentFilters],
    sources: sources || [],
    generated_at_sgt: todaySgtIso(),
    row_count: rows?.length || 0,
    notes: [],
  };
}

function makeUnsupported(reason) {
  return {
    kind: "unsupported",
    reason,
    meta: {
      domain: "unsupported",
      time_window: { kind: "all_time", label: "" },
      filters_applied: [],
      sources: [],
      generated_at_sgt: todaySgtIso(),
      row_count: 0,
      notes: [],
    },
  };
}

function unionSources(a, b) {
  const out = new Set([...(a?.meta?.sources || []), ...(b?.meta?.sources || [])]);
  return [...out];
}

module.exports = { runPlan };
