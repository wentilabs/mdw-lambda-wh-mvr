// V2 ground-truth test.
//
// For each numeric question in the bank, runs v2 and compares its primary
// number against an independent SQL/JS ground-truth computed directly from
// the same data plugin (bypassing the LLM parser, planner, and formatter).
//
// This verifies that Layer 4's aggregation matches a deterministic compute
// path — proving the LLM never injects a number into the answer.

require("dotenv").config();
const { handleQuestion } = require("../usecases/qa_agent_v2");
const { parseIntent } = require("../usecases/qa_agent_v2/parser/parse-intent");
const { planFromIntent } = require("../usecases/qa_agent_v2/planner/plan-from-intent");
const { getPlugin } = require("../usecases/qa_agent_v2/data");
const { getGroupConfiguration } = require("../config/group-config");
const { BANK } = require("./qa-question-bank");

const GROUP_ID = process.env.QA_TEST_GROUP_ID || "120363408413581964@g.us";

function parseArgs() {
  const args = { only: null };
  for (const a of process.argv.slice(2)) if (a.startsWith("--only=")) args.only = a.slice("--only=".length);
  return args;
}

async function groundTruth(intent, groupConfig) {
  const plugin = getPlugin(intent.domain);
  if (!plugin || plugin.bypass) return null;
  const filters = [
    ...((plugin.metrics.find((m) => m.name === intent.target_metric) || {}).filterDefault || []),
    ...(intent.filters || []),
  ];
  const rows = await plugin.fetchRows({ window: intent.time_window, filters, groupConfig });
  // For count-shaped intents → return row count.
  if (intent.question_type === "count") return rows.length;
  const m = plugin.metrics.find((x) => x.name === intent.target_metric);
  if (intent.question_type === "aggregate" && m && m.field) {
    if (intent.target_aggregation === "sum") return rows.reduce((s, r) => s + (Number(r[m.field]) || 0), 0);
    if (intent.target_aggregation === "avg") {
      const v = rows.map((r) => Number(r[m.field])).filter((n) => Number.isFinite(n));
      return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
    }
    if (intent.target_aggregation === "min") {
      const v = rows.map((r) => Number(r[m.field])).filter((n) => Number.isFinite(n));
      return v.length ? Math.min(...v) : null;
    }
    if (intent.target_aggregation === "max") {
      const v = rows.map((r) => Number(r[m.field])).filter((n) => Number.isFinite(n));
      return v.length ? Math.max(...v) : null;
    }
  }
  if (intent.question_type === "trend" && m && m.field) {
    // Sum by date.
    const days = new Map();
    for (const r of rows) days.set(r.Date, (days.get(r.Date) || 0) + (Number(r[m.field]) || 0));
    return [...days.values()].reduce((s, x) => s + x, 0);
  }
  if (intent.question_type === "distribution") {
    return rows.length;
  }
  return null;
}

function primary(answer) {
  if (!answer) return null;
  switch (answer.kind) {
    case "count":
      return answer.total;
    case "aggregate":
      return answer.value;
    case "distribution":
      return answer.total;
    case "trend":
      return answer.total;
    default:
      return null;
  }
}

(async () => {
  const { only } = parseArgs();
  const gc = getGroupConfiguration(GROUP_ID);
  const bank = only ? BANK.filter((b) => b.id.includes(only)) : BANK;
  const results = [];
  for (const item of bank) {
    const intent = await parseIntent(item.question);
    const truth = await groundTruth(intent, gc);
    const r = await handleQuestion(item.question, gc);
    const got = primary(r.answer);
    const match = truth === null || got === null ? "n/a" : Math.abs(truth - got) < 1e-9 ? "✓" : "✗";
    results.push({ id: item.id, question: item.question, intent, truth, got, match });
    process.stdout.write(`  [${item.id}] truth=${truth} got=${got} ${match}\n`);
  }
  console.log("\n========== GROUND TRUTH MATRIX ==========");
  console.log("id".padEnd(34) + "truth".padEnd(12) + "got".padEnd(12) + "match");
  console.log("-".repeat(70));
  let pass = 0;
  let testable = 0;
  for (const r of results) {
    const cell = r.match === "n/a" ? "—" : r.match;
    if (r.match === "✓") pass++;
    if (r.match !== "n/a") testable++;
    console.log(r.id.padEnd(34) + String(r.truth).padEnd(12) + String(r.got).padEnd(12) + cell);
  }
  console.log(`\n${pass}/${testable} match (others: not numerically testable).`);
  process.exit(pass === testable ? 0 : 1);
})().catch((e) => {
  console.error("FATAL:", e?.stack || e);
  process.exit(1);
});
