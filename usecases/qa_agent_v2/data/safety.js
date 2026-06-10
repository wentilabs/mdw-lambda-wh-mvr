/**
 * Safety domain plugin.
 *
 * Backed by `runSQLQuery('safety')` — wraps the existing Safety Google Sheet.
 * Returns normalized rows with stable field names so aggregators don't have
 * to know the column naming.
 */

const { runSQLQuery } = require("../../../utils/action");
const { isoDaysInRange } = require("../shared/time-window");
const { stageLog, stageWarn } = require("../shared/logging");

async function fetchRows({ window, filters = [], select, groupConfig }) {
  const where = buildWhere(window, filters);
  const cols =
    "[S/N], [Date], [Description], [Category], [Location], [Severity], [Status], [ChatGroup], [Sender], [Updated By]";
  let rows = [];
  try {
    const query = `SELECT ${cols} FROM safetyData WHERE ${where}`;
    rows = (await runSQLQuery(query, "safety", { groupConfig })) || [];
  } catch (e) {
    stageWarn("data/safety", "SQL failed", e?.message || e);
    return [];
  }
  rows = rows.map((r) => ({
    SN: r["S/N"],
    Date: String(r.Date || "").trim(),
    Description: r.Description,
    Category: String(r.Category || "Uncategorized").trim() || "Uncategorized",
    Location: r.Location,
    Severity: String(r.Severity || "")
      .trim()
      .toUpperCase(),
    Status: String(r.Status || "")
      .trim()
      .toLowerCase(),
    ChatGroup: r.ChatGroup,
    Sender: r.Sender,
    UpdatedBy: r["Updated By"],
  }));
  stageLog("data/safety", `fetched ${rows.length} rows`, { window: window.label });
  return rows;
}

function buildWhere(window, filters) {
  const parts = [];
  if (window.kind === "single") {
    parts.push(`[Date] = '${window.start_iso}'`);
  } else if (window.kind === "range") {
    const days = isoDaysInRange(window.start_iso, window.end_iso, 400);
    if (days.length <= 31) parts.push(`[Date] IN (${days.map((d) => `'${d}'`).join(", ")})`);
    else parts.push(`[Date] >= '${window.start_iso}' AND [Date] <= '${window.end_iso}'`);
  }
  for (const f of filters || []) {
    if (!f?.field) continue;
    const fld = `[${f.field}]`;
    switch (f.op) {
      case "=":
        parts.push(`UPPER(${fld}) = UPPER('${escapeStr(f.value)}')`);
        break;
      case "!=":
        parts.push(`UPPER(${fld}) != UPPER('${escapeStr(f.value)}')`);
        break;
      case "in":
        if (Array.isArray(f.values) && f.values.length) {
          parts.push(`UPPER(${fld}) IN (${f.values.map((v) => `UPPER('${escapeStr(v)}')`).join(", ")})`);
        }
        break;
      case "like":
        parts.push(`UPPER(${fld}) LIKE UPPER('%${escapeStr(f.value)}%')`);
        break;
    }
  }
  return parts.length ? parts.join(" AND ") : "1=1";
}

function escapeStr(s) {
  return String(s ?? "").replace(/'/g, "''");
}

module.exports = {
  name: "safety",
  displayName: "Safety Issues",
  description:
    "Safety issue counts, severity (P1/P2/P3/Good Observation), status (open/closed), category, location, reporter, closer.",
  metrics: [
    { name: "issue_count", aggregations: ["count"] },
    { name: "open_count", aggregations: ["count"], filterDefault: [{ field: "Status", op: "=", value: "open" }] },
    { name: "closed_count", aggregations: ["count"], filterDefault: [{ field: "Status", op: "=", value: "closed" }] },
  ],
  dimensions: [
    { name: "Date", semantic_type: "date" },
    { name: "Severity", semantic_type: "category", enum: ["P1", "P2", "P3", "N/A"] },
    { name: "Status", semantic_type: "category", enum: ["open", "closed", "n/a"] },
    { name: "Category", semantic_type: "category" },
    { name: "Location", semantic_type: "category" },
    { name: "ChatGroup", semantic_type: "category" },
    { name: "Sender", semantic_type: "text" },
    { name: "UpdatedBy", semantic_type: "text" },
  ],
  fetchRows,
};
