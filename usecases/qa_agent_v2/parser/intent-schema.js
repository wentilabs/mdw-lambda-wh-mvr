/**
 * Strict JSON schema for QueryIntent. Used by `parser/parse-intent.js` as the
 * `text.format.schema` argument of OpenAI's `responses.create`. The schema is
 * the contract between Layer 1 (LLM) and the rest of the system.
 *
 * Every field is required. The LLM cannot omit anything. Optional concepts
 * (like `comparison_baseline`) are modeled with explicit `null` to keep the
 * "all required" guarantee that OpenAI strict mode enforces.
 */

const QUESTION_TYPES = [
  "point_lookup",
  "count",
  "aggregate",
  "distribution",
  "trend",
  "comparison",
  "top_n",
  "ranking",
  "ratio",
  "threshold",
  "status",
  "list",
  "gap",
  "unsupported",
];

const DOMAINS = [
  "manpower",
  "safety",
  "wbgt",
  "noise",
  "report_generation",
  "unsupported",
];

const FILTER_OPS = ["=", "!=", "in", "like", ">=", "<="];
const AGG_OPS = ["count", "sum", "avg", "leq_avg", "min", "max"];
const TIME_KINDS = ["single", "range", "all_time"];

const TIME_WINDOW = {
  type: "object",
  properties: {
    kind: { type: "string", enum: TIME_KINDS },
    start_iso: { type: ["string", "null"], description: "YYYY-MM-DD, null only when kind='all_time'" },
    end_iso: { type: ["string", "null"], description: "YYYY-MM-DD, null only when kind='all_time'" },
    label: { type: "string", description: "User-facing display: 'today', 'last week', '5-Oct-2026'" },
  },
  required: ["kind", "start_iso", "end_iso", "label"],
  additionalProperties: false,
};

const FILTER = {
  type: "object",
  properties: {
    field: { type: "string" },
    op: { type: "string", enum: FILTER_OPS },
    value: { type: ["string", "number", "boolean", "null"] },
    values: { type: ["array", "null"], items: { type: ["string", "number", "boolean"] } },
  },
  required: ["field", "op", "value", "values"],
  additionalProperties: false,
};

const GROUP_KEY = {
  type: "object",
  properties: { field: { type: "string" } },
  required: ["field"],
  additionalProperties: false,
};

const ORDER_BY = {
  type: "object",
  properties: {
    field: { type: "string" },
    dir: { type: "string", enum: ["asc", "desc"] },
  },
  required: ["field", "dir"],
  additionalProperties: false,
};

const QUERY_INTENT_SCHEMA = {
  type: "object",
  properties: {
    question_type: { type: "string", enum: QUESTION_TYPES },
    domain: { type: "string", enum: DOMAINS },
    target_metric: {
      type: "string",
      description: "Metric name from the chosen domain (e.g. 'headcount'), or '' for list/status/gap/unsupported.",
    },
    target_aggregation: {
      type: "string",
      enum: [...AGG_OPS, "none"],
      description: "Reducer to apply ('sum', 'count', ...) or 'none' when the question is point_lookup/list/status.",
    },
    time_window: TIME_WINDOW,
    filters: { type: "array", items: FILTER },
    group_by: { type: "array", items: GROUP_KEY },
    order_by: { anyOf: [ORDER_BY, { type: "null" }] },
    limit: { type: ["integer", "null"], description: "For top_n / list. Null otherwise." },
    comparison_baseline: { anyOf: [TIME_WINDOW, { type: "null" }] },
    raw_question: { type: "string" },
    unsupported_reason: {
      type: ["string", "null"],
      description: "Filled when question_type='unsupported' or domain='unsupported'.",
    },
  },
  required: [
    "question_type",
    "domain",
    "target_metric",
    "target_aggregation",
    "time_window",
    "filters",
    "group_by",
    "order_by",
    "limit",
    "comparison_baseline",
    "raw_question",
    "unsupported_reason",
  ],
  additionalProperties: false,
};

module.exports = {
  QUESTION_TYPES,
  DOMAINS,
  FILTER_OPS,
  AGG_OPS,
  TIME_KINDS,
  QUERY_INTENT_SCHEMA,
};
