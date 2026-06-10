/**
 * Layer 2 — Query Planner.
 *
 * Takes a QueryIntent (from Layer 1) and produces an ExecutionPlan (a series
 * of typed steps the executor will run). Pure code — no LLM calls.
 *
 * The planner is a closed switch on `question_type × domain`. If a combination
 * isn't supported, it returns `answer_shape: 'unsupported'` with a reason —
 * the formatter renders a polite reply.
 *
 * Plan steps:
 *   { kind: 'fetch_rows', domain, window, filters, select? }
 *   { kind: 'aggregate',  op, field?, group_by? }
 *   { kind: 'sort',       by, dir }
 *   { kind: 'limit',      n }
 *   { kind: 'pivot',      row_key, col_key, value }   // reserved for ratio/threshold
 *   { kind: 'compare',    baseline_plan, current_plan } // recursive for comparison
 */

const { getPlugin } = require("../data");
const { stageLog } = require("../shared/logging");

/**
 * @param {object} intent - QueryIntent from Layer 1
 * @returns {object} ExecutionPlan
 */
function planFromIntent(intent) {
  // Bypass domains FIRST — even when the parser marked question_type='unsupported',
  // a bypass-domain intent should still route to its bypass handler (report
  // generation is inherently "no analytical answer expected").
  if (intent && intent.domain && intent.domain !== "unsupported") {
    const earlyPlugin = getPlugin(intent.domain);
    if (earlyPlugin && earlyPlugin.bypass) {
      return {
        steps: [{ kind: "bypass", domain: intent.domain }],
        answer_shape: "bypass",
        intent,
      };
    }
  }

  if (!intent || intent.question_type === "unsupported" || intent.domain === "unsupported") {
    return unsupportedPlan(intent?.unsupported_reason || "Out of scope.");
  }

  const plugin = getPlugin(intent.domain);
  if (!plugin) return unsupportedPlan(`Unknown domain: ${intent.domain}`);
  if (plugin.bypass) {
    // (already handled above; defensive)
    return {
      steps: [{ kind: "bypass", domain: intent.domain }],
      answer_shape: "bypass",
      intent,
    };
  }

  // Validate target_metric (when set) belongs to this domain.
  if (intent.target_metric && intent.target_metric !== "") {
    const ok = (plugin.metrics || []).some((m) => m.name === intent.target_metric);
    if (!ok) {
      return unsupportedPlan(
        `Metric '${intent.target_metric}' is not defined for domain '${intent.domain}'. Available: ${plugin.metrics.map((m) => m.name).join(", ")}.`,
        intent,
      );
    }
  }

  const metric = (plugin.metrics || []).find((m) => m.name === intent.target_metric) || null;

  // Filters: include the metric's filterDefault (e.g. open_count → Status='open').
  const filters = [...(metric?.filterDefault || []), ...(intent.filters || [])];

  switch (intent.question_type) {
    case "point_lookup":
      // Same disambiguation as 'count': when the user asks for a "point" value
      // of a numeric SUMMABLE metric on a single date with a single filter
      // (e.g. "wohhup engineers on 2026-05-08", "total volume on 2026-05-08"),
      // promote to aggregate(sum) so the formatter prefixes "Total".
      if (shouldPromoteToAggregate(metric, intent)) {
        return planAggregate({ ...intent, target_aggregation: pickSumOp(metric) }, plugin, metric, filters);
      }
      return planPointLookup(intent, plugin, metric, filters);
    case "count":
      // Disambiguation: when the user asks "how many X" but X is a NUMERIC
      // metric (e.g. headcount=sum(Total), volume_m3=sum(Volume)), they mean
      // the metric total — NOT the row count. We promote this to aggregate.
      if (shouldPromoteToAggregate(metric, intent)) {
        return planAggregate({ ...intent, target_aggregation: pickSumOp(metric) }, plugin, metric, filters);
      }
      return planCount(intent, plugin, metric, filters);
    case "aggregate":
      return planAggregate(intent, plugin, metric, filters);
    case "distribution":
      return planDistribution(intent, plugin, metric, filters);
    case "trend":
      return planTrend(intent, plugin, metric, filters);
    case "comparison":
      return planComparison(intent, plugin, metric, filters);
    case "top_n":
      return planTopN(intent, plugin, metric, filters);
    case "ranking":
      return planRanking(intent, plugin, metric, filters);
    case "ratio":
      return planRatio(intent, plugin, metric, filters);
    case "threshold":
      return planThreshold(intent, plugin, metric, filters);
    case "status":
      return planStatus(intent, plugin, metric, filters);
    case "list":
      return planList(intent, plugin, metric, filters);
    case "gap":
      return planGap(intent, plugin, metric, filters);
    default:
      return unsupportedPlan(`Unknown question_type: ${intent.question_type}`, intent);
  }
}

function unsupportedPlan(reason, intent) {
  return {
    steps: [],
    answer_shape: "unsupported",
    unsupported_reason: reason,
    intent: intent || null,
  };
}

/** A plain (single-source) plan: fetch + aggregate (optionally). */
function basePlan(intent, plugin, filters, extraSteps = []) {
  const steps = [
    {
      kind: "fetch_rows",
      domain: intent.domain,
      window: intent.time_window,
      filters,
    },
    ...extraSteps,
  ];
  return { steps, intent };
}

function planPointLookup(intent, plugin, metric, filters) {
  // Single row/value for a single date.
  const plan = basePlan(intent, plugin, filters, [
    metric
      ? {
          kind: "aggregate",
          op: chooseOp(intent, metric),
          field: metric.field,
          group_by: [],
        }
      : { kind: "passthrough" },
  ]);
  plan.answer_shape = "point_lookup";
  return plan;
}

function planCount(intent, plugin, metric, filters) {
  const groupBy = (intent.group_by || []).map((g) => ({ field: g.field }));
  const steps = [
    { kind: "fetch_rows", domain: intent.domain, window: intent.time_window, filters },
    { kind: "aggregate", op: "count", group_by: groupBy },
  ];
  return { steps, answer_shape: "count", intent };
}

function planAggregate(intent, plugin, metric, filters) {
  if (!metric || !metric.field) {
    // Metric is cardinality-only (no underlying numeric field — e.g. trip_count,
    // issue_count). The LLM likely picked 'aggregate' because of the "how many"
    // phrasing, but the right op for a no-field metric is count. Downgrade
    // rather than reject — same intent, semantically correct route.
    return planCount(intent, plugin, metric, filters);
  }
  const op = chooseOp(intent, metric);
  const groupBy = (intent.group_by || []).map((g) => ({ field: g.field }));
  const steps = [
    { kind: "fetch_rows", domain: intent.domain, window: intent.time_window, filters },
    { kind: "aggregate", op, field: metric.field, group_by: groupBy },
  ];
  return { steps, answer_shape: "aggregate", intent };
}

function planDistribution(intent, plugin, metric, filters) {
  // Always grouped — pick the first group_by, fall back to a reasonable dimension.
  const groupBy = (intent.group_by || []).map((g) => ({ field: g.field }));
  if (groupBy.length === 0) {
    return unsupportedPlan(`A distribution requires a group_by dimension.`, intent);
  }
  const op = chooseOp(intent, metric);
  const steps = [
    { kind: "fetch_rows", domain: intent.domain, window: intent.time_window, filters },
    { kind: "aggregate", op, field: metric?.field, group_by: groupBy },
    { kind: "sort", by: "value", dir: "desc" },
  ];
  return { steps, answer_shape: "distribution", intent };
}

function planTrend(intent, plugin, metric, filters) {
  // Trend = group by Date. If user provided extra group_by dims, pass them through.
  const userGroups = (intent.group_by || []).filter((g) => g.field !== "Date");
  const groupBy = [{ field: "Date" }, ...userGroups];
  const op = chooseOp(intent, metric);
  const steps = [
    { kind: "fetch_rows", domain: intent.domain, window: intent.time_window, filters },
    { kind: "aggregate", op, field: metric?.field, group_by: groupBy },
    { kind: "sort", by: "Date", dir: "asc" },
  ];
  return { steps, answer_shape: "trend", intent };
}

function planComparison(intent, plugin, metric, filters) {
  if (!intent.comparison_baseline) {
    return unsupportedPlan(`Comparison requires a baseline time window.`, intent);
  }
  // Build two sub-plans — current = the intent's own time_window, baseline = comparison_baseline.
  const op = chooseOp(intent, metric);
  const group_by = [];
  const buildLeg = (window) => ({
    steps: [
      { kind: "fetch_rows", domain: intent.domain, window, filters },
      { kind: "aggregate", op, field: metric?.field, group_by },
    ],
    answer_shape: "aggregate",
    intent: { ...intent, time_window: window },
  });
  return {
    steps: [
      {
        kind: "compare",
        baseline_plan: buildLeg(intent.comparison_baseline),
        current_plan: buildLeg(intent.time_window),
      },
    ],
    answer_shape: "comparison",
    intent,
  };
}

function planTopN(intent, plugin, metric, filters) {
  const n = intent.limit && intent.limit > 0 ? intent.limit : 5;
  const groupBy = (intent.group_by || []).map((g) => ({ field: g.field }));
  if (groupBy.length === 0) {
    return unsupportedPlan(`top_n requires a group_by dimension (e.g. by Company, by Pile_ID).`, intent);
  }
  const op = chooseOp(intent, metric);
  const dir = intent.order_by?.dir || "desc";
  const steps = [
    { kind: "fetch_rows", domain: intent.domain, window: intent.time_window, filters },
    { kind: "aggregate", op, field: metric?.field, group_by: groupBy },
    { kind: "sort", by: "value", dir },
    { kind: "limit", n },
  ];
  return { steps, answer_shape: "top_n", intent };
}

function planRanking(intent, plugin, metric, filters) {
  const groupBy = (intent.group_by || []).map((g) => ({ field: g.field }));
  if (groupBy.length === 0) {
    return unsupportedPlan(`Ranking requires a group_by dimension.`, intent);
  }
  const op = chooseOp(intent, metric);
  const dir = intent.order_by?.dir || "desc";
  const steps = [
    { kind: "fetch_rows", domain: intent.domain, window: intent.time_window, filters },
    { kind: "aggregate", op, field: metric?.field, group_by: groupBy },
    { kind: "sort", by: "value", dir },
    { kind: "limit", n: 1 },
  ];
  return { steps, answer_shape: "ranking", intent };
}

function planRatio(intent, plugin, metric, filters) {
  // For now ratios are computed via aggregator's compute path (sum(field) / sum(otherField))
  // We pass a single fetch and let the aggregator interpret target_metric as numerator/denominator.
  const steps = [
    { kind: "fetch_rows", domain: intent.domain, window: intent.time_window, filters },
    { kind: "ratio_compute", target_metric: intent.target_metric },
  ];
  return { steps, answer_shape: "ratio", intent };
}

function planThreshold(intent, plugin, metric, filters) {
  // The aggregator splits rows by a single threshold filter — Layer 4 reads
  // intent.filters for >= or <= predicates and produces { over, under }.
  const steps = [
    { kind: "fetch_rows", domain: intent.domain, window: intent.time_window, filters: [] }, // raw rows; threshold split done in aggregator
    { kind: "threshold_split", field: metric?.field, filters: intent.filters || [] },
  ];
  return { steps, answer_shape: "threshold", intent };
}

function planStatus(intent, plugin, metric, filters) {
  // Status: the data plugin returns rows for the latest available date — aggregator
  // picks the latest row per entity.
  const steps = [
    { kind: "fetch_rows", domain: intent.domain, window: intent.time_window, filters },
    { kind: "latest_per_entity", entity_field: pickEntityField(intent) },
  ];
  return { steps, answer_shape: "status", intent };
}

function planList(intent, plugin, metric, filters) {
  const steps = [{ kind: "fetch_rows", domain: intent.domain, window: intent.time_window, filters }];
  if (intent.order_by) steps.push({ kind: "sort", by: intent.order_by.field, dir: intent.order_by.dir });
  if (intent.limit) steps.push({ kind: "limit", n: intent.limit });
  return { steps, answer_shape: "list", intent };
}

function planGap(intent, plugin, metric, filters) {
  const steps = [
    { kind: "fetch_rows", domain: intent.domain, window: intent.time_window, filters },
    { kind: "gap_compute", group_by: intent.group_by || [] },
  ];
  return { steps, answer_shape: "gap", intent };
}

function chooseOp(intent, metric) {
  const requested = intent.target_aggregation;
  // If the LLM picked an op the metric supports, use it.
  if (requested && requested !== "none" && (!metric || metric.aggregations?.includes(requested))) {
    return requested;
  }
  // Otherwise fall back to the metric's first supported op.
  if (metric?.aggregations?.[0]) return metric.aggregations[0];
  return "count";
}

/**
 * True when the LLM picked question_type='count' but the metric is numeric
 * (e.g. headcount, volume_m3, completed_count). "How many X" with a summable
 * metric means SUM of the underlying field, NOT row cardinality.
 *
 * Promote whenever the metric exposes a numeric `field` AND its aggregations
 * include 'sum'. Cardinality metrics like 'trip_count' (no field) and
 * 'issue_count' (no field) stay as row-count.
 */
function shouldPromoteToAggregate(metric, intent) {
  if (!metric || !metric.field) return false;
  if (!Array.isArray(metric.aggregations) || !metric.aggregations.includes("sum")) return false;
  return true;
}

function pickSumOp(metric) {
  if (!metric) return "sum";
  // Prefer 'sum' when available; otherwise the first listed aggregation.
  return metric.aggregations?.includes("sum") ? "sum" : metric.aggregations?.[0] || "sum";
}

function pickEntityField(intent) {
  // Domain-aware default — the executor falls back to the first dim if absent.
  if (intent.domain === "pile_cap") return "CJ";
  if (intent.domain === "im_progress") return "Instrument_ID";
  if (intent.domain === "piling_progress") return "Pile_ID";
  if (intent.domain === "manpower") return "Company";
  if (intent.domain === "safety") return "SN";
  if (intent.domain === "concrete") return "Location";
  return "Date";
}

module.exports = { planFromIntent, __test: { chooseOp, pickEntityField } };
