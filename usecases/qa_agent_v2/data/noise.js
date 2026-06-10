/**
 * Noise-monitoring domain plugin. Backed by `runSQLQuery('noise')`.
 * Source: wohhup.ir2_noise_data_daily (timestamp, location, leq_5min).
 */

const { runSQLQuery } = require("../../../utils/action");
const { stageLog, stageWarn } = require("../shared/logging");

async function fetchRows({ window, filters = [], groupConfig }) {
  const where = buildTimestampWhere(window, filters);
  let rows = [];
  try {
    const query = `SELECT [timestamp], [location], [leq_5min] FROM noiseData WHERE ${where}`;
    rows = (await runSQLQuery(query, "noise", { groupConfig })) || [];
  } catch (e) {
    stageWarn("data/noise", "SQL failed", e?.message || e);
    return [];
  }
  rows = rows.map((r) => ({
    Timestamp: r.timestamp,
    Date: extractDate(r.timestamp),
    Hour: extractHour(r.timestamp),
    Location: shortLocation(r.location),
    LocationFull: r.location,
    Leq5min: Number(r.leq_5min) || null,
  }));
  stageLog("data/noise", `fetched ${rows.length} rows`, { window: window.label });
  return rows;
}

/** "NM1: Marina Bay Sands Tower 1, Level 6 balcony" → "NM1". Pure data normalization. */
function shortLocation(loc) {
  const s = String(loc || "").trim();
  if (!s) return s;
  const m = s.match(/^(NM\d+)\b/i);
  return m ? m[1].toUpperCase() : s;
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
    // The Supabase noise table stores Location as a verbose string
    // ("NM1: Marina Bay Sands Tower 1, Level 6 balcony"). When the user/LLM
    // filters by short code ("NM1"), match by prefix on the underlying column.
    if (f.field === "Location") {
      if (f.op === "=") {
        parts.push(`UPPER([location]) LIKE UPPER('${escapeStr(f.value)}%')`);
      } else if (f.op === "in" && Array.isArray(f.values)) {
        const ors = f.values.map((v) => `UPPER([location]) LIKE UPPER('${escapeStr(v)}%')`).join(" OR ");
        parts.push(`(${ors})`);
      }
      continue;
    }
    // Hour is derived in JS after fetch — skip pushdown.
    if (f.field === "Hour") continue;
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
  name: "noise",
  displayName: "Noise Monitoring",
  description:
    "5-minute Leq noise readings at site monitors (NM1, NM2) — averages, peaks, threshold breaches against daytime/evening dBA limits.",
  metrics: [
    // `leq_avg` is logarithmic dBA averaging — arithmetic mean is incorrect for sound.
    // `min` / `max` use raw readings directly. The first listed op is the planner default.
    { name: "leq_5min", field: "Leq5min", unit: "dBA", aggregations: ["leq_avg", "min", "max"] },
    { name: "reading_count", aggregations: ["count"] },
  ],
  dimensions: [
    { name: "Date", semantic_type: "date" },
    { name: "Hour", semantic_type: "numeric_bucket" },
    { name: "Location", semantic_type: "category", enum: ["NM1", "NM2"] },
  ],
  fetchRows,
};
