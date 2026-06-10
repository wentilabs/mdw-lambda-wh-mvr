/**
 * WBGT (heat-stress) domain plugin. Backed by `runSQLQuery('wbgt_supabase')`.
 * Source table: wohhup.ir2_wbgt (timestamp, location, wbgt_outdoor).
 */

const { runSQLQuery } = require("../../../utils/action");
const { stageLog, stageWarn } = require("../shared/logging");

async function fetchRows({ window, filters = [], groupConfig }) {
  const where = buildTimestampWhere(window, filters);
  let rows = [];
  try {
    const query = `SELECT [timestamp], [location], [wbgt_outdoor] FROM wbgtData WHERE ${where}`;
    rows = (await runSQLQuery(query, "wbgt_supabase", { groupConfig })) || [];
  } catch (e) {
    stageWarn("data/wbgt", "SQL failed", e?.message || e);
    return [];
  }
  rows = rows.map((r) => ({
    Timestamp: r.timestamp,
    Date: extractDate(r.timestamp),
    Hour: extractHour(r.timestamp),
    Location: r.location,
    WBGT: Number(r.wbgt_outdoor) || null,
  }));
  stageLog("data/wbgt", `fetched ${rows.length} rows`, { window: window.label });
  return rows;
}

function extractDate(ts) {
  const m = String(ts || "").match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}
function extractHour(ts) {
  const m = String(ts || "").match(/[T ](\d{2}):/);
  return m ? parseInt(m[1], 10) : null;
}

function buildTimestampWhere(window, filters) {
  const parts = [];
  if (window.kind === "single") parts.push(`SUBSTR([timestamp], 1, 10) = '${window.start_iso}'`);
  else if (window.kind === "range")
    parts.push(
      `SUBSTR([timestamp], 1, 10) >= '${window.start_iso}' AND SUBSTR([timestamp], 1, 10) <= '${window.end_iso}'`,
    );
  for (const f of filters || []) {
    if (!f?.field) continue;
    const fld = `[${f.field}]`;
    switch (f.op) {
      case "=":
        parts.push(`${fld} = '${escapeStr(f.value)}'`);
        break;
      case "in":
        if (Array.isArray(f.values)) parts.push(`${fld} IN (${f.values.map((v) => `'${escapeStr(v)}'`).join(", ")})`);
        break;
    }
  }
  return parts.length ? parts.join(" AND ") : "1=1";
}

function escapeStr(s) {
  return String(s ?? "").replace(/'/g, "''");
}

module.exports = {
  name: "wbgt",
  displayName: "WBGT (Heat Stress)",
  description:
    "Outdoor Wet Bulb Globe Temperature readings — current value, daily averages, peaks, hourly distribution, threshold breaches.",
  metrics: [
    { name: "wbgt_outdoor", field: "WBGT", unit: "°C", aggregations: ["avg", "min", "max"] },
    { name: "reading_count", aggregations: ["count"] },
  ],
  dimensions: [
    { name: "Date", semantic_type: "date" },
    { name: "Hour", semantic_type: "numeric_bucket" },
    { name: "Location", semantic_type: "category" },
  ],
  fetchRows,
  __test: { extractDate, extractHour },
};
