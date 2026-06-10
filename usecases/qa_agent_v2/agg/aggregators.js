/**
 * Layer 4 — Aggregation engine.
 *
 * Pure-JS reducers. No LLM calls. No regex on user text. Every numeric value
 * the user sees in the final answer is produced here by deterministic reduce.
 *
 * Inputs: an array of normalized rows from a Layer-3 plugin.
 * Outputs: structured intermediate results { value | breakdown | series } that
 *          Layer 5 wraps into typed AnswerData.
 */

/** Group rows by one or more keys → Map<keyString, Row[]> with key parts preserved. */
function groupBy(rows, keys) {
  const out = new Map();
  for (const r of rows) {
    const keyParts = keys.map((k) => stringify(r[k.field]));
    const key = keyParts.join("␟"); // record-separator
    if (!out.has(key)) out.set(key, { keyParts, rows: [] });
    out.get(key).rows.push(r);
  }
  return out;
}

function stringify(v) {
  if (v === null || v === undefined) return "";
  return String(v);
}

/** count rows, optionally grouped. */
function aggCount(rows, group_keys = []) {
  if (group_keys.length === 0) return { value: rows.length };
  const grouped = groupBy(rows, group_keys);
  const breakdown = [];
  for (const { keyParts, rows: r } of grouped.values()) {
    breakdown.push({ keyParts, key: joinKey(keyParts, group_keys), value: r.length });
  }
  return { value: rows.length, breakdown };
}

/** sum a numeric field, optionally grouped. */
function aggSum(rows, field, group_keys = []) {
  const sumRows = (rs) => rs.reduce((s, r) => s + numeric(r[field]), 0);
  if (group_keys.length === 0) return { value: sumRows(rows) };
  const grouped = groupBy(rows, group_keys);
  const breakdown = [];
  for (const { keyParts, rows: r } of grouped.values()) {
    breakdown.push({ keyParts, key: joinKey(keyParts, group_keys), value: sumRows(r) });
  }
  return { value: sumRows(rows), breakdown };
}

/** avg a numeric field, optionally grouped. Skips null/empty. */
function aggAvg(rows, field, group_keys = []) {
  const avgRows = (rs) => {
    const vals = rs.map((r) => numericOrNull(r[field])).filter((v) => v !== null);
    if (vals.length === 0) return null;
    return vals.reduce((s, v) => s + v, 0) / vals.length;
  };
  if (group_keys.length === 0) return { value: avgRows(rows) };
  const grouped = groupBy(rows, group_keys);
  const breakdown = [];
  for (const { keyParts, rows: r } of grouped.values()) {
    breakdown.push({ keyParts, key: joinKey(keyParts, group_keys), value: avgRows(r) });
  }
  return { value: avgRows(rows), breakdown };
}

/** min/max a numeric field, optionally grouped. Skips null. */
function aggMinMax(rows, field, op, group_keys = []) {
  const mm = (rs) => {
    const vals = rs.map((r) => numericOrNull(r[field])).filter((v) => v !== null);
    if (vals.length === 0) return null;
    return op === "min" ? Math.min(...vals) : Math.max(...vals);
  };
  if (group_keys.length === 0) return { value: mm(rows) };
  const grouped = groupBy(rows, group_keys);
  const breakdown = [];
  for (const { keyParts, rows: r } of grouped.values()) {
    breakdown.push({ keyParts, key: joinKey(keyParts, group_keys), value: mm(r) });
  }
  return { value: mm(rows), breakdown };
}

/**
 * Logarithmic Leq aggregation for dBA (decibels). ARITHMETIC MEAN IS WRONG for
 * sound pressure — they combine on the energy domain, not the dB domain.
 *
 *   Leq = 10 * log10( mean(10^(L/10)) )
 *
 * Source: Singapore NEA construction-noise spec; mirror of
 * `usecases/noise_notification/calculator.js:106-127`.
 */
function aggLeq(rows, field, group_keys = []) {
  const compute = (rs) => {
    const vals = rs.map((r) => numericOrNull(r[field])).filter((v) => v !== null);
    if (vals.length === 0) return null;
    const energy = vals.reduce((s, v) => s + Math.pow(10, v / 10), 0) / vals.length;
    return 10 * Math.log10(energy);
  };
  if (group_keys.length === 0) return { value: compute(rows) };
  const grouped = groupBy(rows, group_keys);
  const breakdown = [];
  for (const { keyParts, rows: r } of grouped.values()) {
    breakdown.push({ keyParts, key: joinKey(keyParts, group_keys), value: compute(r) });
  }
  return { value: compute(rows), breakdown };
}

/** Single dispatch — pick the reducer for an op. */
function applyAgg(rows, op, field, group_keys = []) {
  switch (op) {
    case "count":
      return aggCount(rows, group_keys);
    case "sum":
      return aggSum(rows, field, group_keys);
    case "avg":
      return aggAvg(rows, field, group_keys);
    case "leq_avg":
      return aggLeq(rows, field, group_keys);
    case "min":
    case "max":
      return aggMinMax(rows, field, op, group_keys);
    default:
      return aggCount(rows, group_keys);
  }
}

/** Sort breakdown rows by a column, returning a new array. Stable for tie cases. */
function sortBreakdown(breakdown, by, dir = "desc") {
  const sign = dir === "asc" ? 1 : -1;
  const cmp = (a, b) => {
    const va = by === "value" ? a.value : a.key;
    const vb = by === "value" ? b.value : b.key;
    if (typeof va === "number" && typeof vb === "number") return (va - vb) * sign;
    return String(va || "").localeCompare(String(vb || "")) * sign;
  };
  return [...(breakdown || [])].sort(cmp);
}

/** Limit a breakdown to top N. */
function limitBreakdown(breakdown, n) {
  if (!Array.isArray(breakdown) || !n || n <= 0) return breakdown || [];
  return breakdown.slice(0, n);
}

/** Threshold split — count rows above/below a numeric threshold. */
function thresholdSplit(rows, field, filters) {
  let threshold = null;
  let op = null;
  for (const f of filters) {
    if (f.field === field && (f.op === ">=" || f.op === "<=")) {
      threshold = Number(f.value);
      op = f.op;
      break;
    }
  }
  if (threshold === null) return { over: 0, under: 0, threshold: 0 };
  let over = 0;
  let under = 0;
  for (const r of rows) {
    const v = numericOrNull(r[field]);
    if (v === null) continue;
    if (op === ">=" ? v >= threshold : v <= threshold) over++;
    else under++;
  }
  return { over, under, threshold };
}

/** ratio_compute — supports "open_rate = open_count / issue_count" style. */
function ratioCompute(rows, target_metric) {
  // Convention: target_metric encodes a ratio name. The aggregator does:
  //   - open_rate     = count(rows where Status='open') / count(rows)
  //   - closed_rate   = count(rows where Status='closed') / count(rows)
  //   - p1_rate       = count(rows where Severity='P1') / count(rows)
  //   - completion    = sum(Completed) / sum(Total)
  //   - utilization   = avg(value / target) per row
  switch (target_metric) {
    case "open_rate":
      return ratioCount(rows, (r) => /open/i.test(String(r.Status)));
    case "closed_rate":
      return ratioCount(rows, (r) => /closed/i.test(String(r.Status)));
    case "p1_rate":
      return ratioCount(rows, (r) => /p1/i.test(String(r.Severity)));
    case "completion":
      return ratioSum(rows, "Completed", "Total");
    default:
      return { numerator: 0, denominator: rows.length, ratio: 0, pct: 0 };
  }
}

function ratioCount(rows, predicate) {
  const numerator = rows.filter(predicate).length;
  const denominator = rows.length || 1;
  return { numerator, denominator, ratio: numerator / denominator, pct: (numerator / denominator) * 100 };
}

function ratioSum(rows, numField, denField) {
  const numerator = rows.reduce((s, r) => s + numeric(r[numField]), 0);
  const denominator = rows.reduce((s, r) => s + numeric(r[denField]), 0) || 1;
  return { numerator, denominator, ratio: numerator / denominator, pct: (numerator / denominator) * 100 };
}

/** Latest row per entity — used by status questions. */
function latestPerEntity(rows, entityField) {
  const map = new Map();
  for (const r of rows) {
    const key = String(r[entityField] ?? "");
    const prev = map.get(key);
    const currDate = String(r.Date || "");
    const prevDate = String(prev?.Date || "");
    if (!prev || currDate > prevDate) map.set(key, r);
  }
  return [...map.values()];
}

/** Compare two AggResult legs and emit a delta + pct change. */
function compare(baseline, current) {
  const b = baseline?.value ?? 0;
  const c = current?.value ?? 0;
  const delta = c - b;
  const pct_change = b === 0 ? null : (delta / b) * 100;
  return { baseline, current, delta, pct_change };
}

// ---------- helpers ----------

function numeric(v) {
  if (v === null || v === undefined || v === "") return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function numericOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function joinKey(keyParts, group_keys) {
  if (keyParts.length === 1) return keyParts[0];
  return keyParts.map((p, i) => `${group_keys[i].field}=${p}`).join(", ");
}

module.exports = {
  groupBy,
  aggCount,
  aggSum,
  aggAvg,
  aggMinMax,
  aggLeq,
  applyAgg,
  sortBreakdown,
  limitBreakdown,
  thresholdSplit,
  ratioCompute,
  latestPerEntity,
  compare,
  __test: { numeric, numericOrNull, joinKey },
};
