// V2 consistency test — fires the v2 pipeline against the question bank,
// 5 times per question, asserts byte-identical answers and no error.
//
// This is the architectural acceptance bar: same NL question → same answer
// every time, regardless of LLM run-to-run wobble.
//
// Subsetting (faster iteration; full bank is still the pre-deploy gate):
//   --only=<idSubstring>     filter by id/question substring (legacy)
//   --tag=<tag[,tag,...]>    OR within one --tag (entry matches ANY tag)
//                            Repeat --tag for AND (every flag must match)
//                            Auto-derived tags: domain:<X>, type:<Y>,
//                                               metric:<Z>, bypass
//                            Explicit tags: smoke (via SMOKE_IDS) + any
//                                            custom labels on bank entries.
//   --smoke                  alias for --tag=smoke (curated cross-cutting set)
//   --affected=<file[,file]> dep-map lookup (see scripts/qa-bank-tags.json),
//                            entries matching ANY of the derived tags are kept
//   --runs=N                 runs per question (default 5)
//
// Examples:
//   node scripts/test-v2-consistency.js --smoke                       # ~21 q, ~3 min
//   node scripts/test-v2-consistency.js --tag=domain:novade_sync      # all novade
//   node scripts/test-v2-consistency.js --tag=domain:safety,type:list # safety OR lists
//   node scripts/test-v2-consistency.js --tag=domain:safety --tag=type:count
//                                                                     # safety AND counts
//   node scripts/test-v2-consistency.js --affected=$(git diff --name-only | tr '\n' ',')
//   node scripts/test-v2-consistency.js                               # full bank

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { handleQuestion } = require("../usecases/qa_agent_v2");
const { getGroupConfiguration } = require("../config/group-config");
const { BANK, SMOKE_IDS } = require("./qa-question-bank");

const GROUP_ID = process.env.QA_TEST_GROUP_ID || "120363408413581964@g.us";

// Bypass-domain marker used to auto-derive the `bypass` tag.
const BYPASS_DOMAIN_NAMES = new Set([
  "report_generation",
  "document_log",
  "master_register_image",
  "safety_image",
  "novade_sync",
]);

/**
 * Auto-derive tags for a bank entry from its existing fields, then merge
 * any explicit `tags` array. Keeps the bank lightweight (most tags are
 * implicit) while letting individual entries opt in to extra labels.
 *
 * Auto-derived:
 *   - domain:<X>      from entry.domain
 *   - type:<X>        from entry.expected_type (if set)
 *   - metric:<X>      from entry.expected_metric (if non-empty)
 *   - bypass          when domain is one of the bypass plugins
 *
 * Explicit:
 *   - smoke           manually flagged via entry.smoke = true OR tags includes 'smoke'
 *   - any other tag   from entry.tags = ["window:past-7d", "filter:Status", ...]
 */
function tagsForEntry(entry) {
  const out = new Set();
  if (entry.domain) out.add(`domain:${entry.domain}`);
  if (entry.expected_type) out.add(`type:${entry.expected_type}`);
  if (entry.expected_metric) out.add(`metric:${entry.expected_metric}`);
  if (BYPASS_DOMAIN_NAMES.has(entry.domain)) out.add("bypass");
  if (entry.smoke === true || (SMOKE_IDS && SMOKE_IDS.has(entry.id))) out.add("smoke");
  for (const t of entry.tags || []) out.add(String(t));
  return out;
}

function loadDepMap() {
  const p = path.join(__dirname, "qa-bank-tags.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    console.warn(`[--affected] failed to read qa-bank-tags.json: ${e?.message || e}`);
    return null;
  }
}

function tagsFromAffectedFiles(files, depMap) {
  if (!depMap) return [];
  const tags = new Set();
  for (const raw of files) {
    const f = String(raw || "").trim();
    if (!f) continue;
    // Exact match first
    if (depMap[f]) for (const t of depMap[f]) tags.add(t);
    // Prefix matches (e.g. dep map key "usecases/qa_agent_v2/" matches
    // any file under it) — purely additive, no conflict resolution needed.
    for (const k of Object.keys(depMap)) {
      if (k.endsWith("/") && f.startsWith(k)) {
        for (const t of depMap[k]) tags.add(t);
      }
    }
  }
  return [...tags];
}

function parseArgs() {
  // tagGroups is an array of arrays — each inner array is an OR-group
  // (entry must match ANY tag inside). Across groups it's AND (entry must
  // match every group). So:
  //   --tag=a,b       → one group [a, b]      → match a OR b
  //   --tag=a --tag=b → two groups [a], [b]   → match a AND b
  //   --smoke         → one group [smoke]
  //   --affected=…    → one group (auto-derived from dep map)
  const args = { only: null, runs: 5, tagGroups: [], affected: null };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith("--only=")) args.only = a.slice("--only=".length);
    else if (a.startsWith("--runs=")) args.runs = parseInt(a.slice("--runs=".length), 10) || 5;
    else if (a.startsWith("--tag=")) {
      const group = a
        .slice("--tag=".length)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (group.length) args.tagGroups.push(group);
    } else if (a === "--smoke") args.tagGroups.push(["smoke"]);
    else if (a.startsWith("--affected=")) args.affected = a.slice("--affected=".length);
  }
  return args;
}

function selectBank(args) {
  let entries = BANK;
  if (args.only) {
    entries = entries.filter(
      (b) => b.id.includes(args.only) || b.question.toLowerCase().includes(args.only.toLowerCase()),
    );
  }
  if (args.affected) {
    const depMap = loadDepMap();
    const files = args.affected
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const derivedTags = tagsFromAffectedFiles(files, depMap);
    if (derivedTags.length) {
      console.log(`[--affected] derived tags from ${files.length} file(s): ${derivedTags.join(", ")}`);
      args.tagGroups.push(derivedTags); // OR-group: entry matches any
    } else {
      console.log(`[--affected] no matching tags for the given files — running full bank as a precaution.`);
    }
  }
  if (args.tagGroups.length) {
    entries = entries.filter((b) => {
      const tags = tagsForEntry(b);
      // Every group must match (AND across groups; OR within a group).
      return args.tagGroups.every((group) => group.some((t) => tags.has(t)));
    });
    const description = args.tagGroups.map((g) => (g.length === 1 ? g[0] : `(${g.join("|")})`)).join(" AND ");
    console.log(`[--tag] filtering: ${description} → ${entries.length} entries`);
  }
  return entries;
}

(async () => {
  const args = parseArgs();
  const { runs } = args;
  const gc = getGroupConfiguration(GROUP_ID);
  const bank = selectBank(args);

  if (!bank.length) {
    console.log("No bank entries matched the selectors. Exiting.");
    process.exit(0);
  }

  console.log(`Testing v2: ${bank.length} questions × ${runs} runs = ${bank.length * runs} total handler calls.\n`);

  const results = [];
  for (const item of bank) {
    const answers = [];
    const errors = [];
    for (let i = 0; i < runs; i++) {
      const t0 = Date.now();
      let msg = "";
      // Up to 3 attempts per run — empty/error messages are typically
      // transient OpenAI rate-limit hits during the 500-call burst.
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await handleQuestion(item.question, gc);
          msg = (r && r.message) || "";
          if (msg) break;
        } catch (e) {
          if (attempt === 2) {
            errors.push(e?.message || String(e));
            msg = `<<ERROR: ${e?.message || e}>>`;
            break;
          }
        }
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
      answers.push(msg);
      process.stdout.write(`  [${item.id}] run ${i + 1}/${runs} (${Date.now() - t0}ms)\n`);
    }
    const set = new Set(answers);
    results.push({
      id: item.id,
      domain: item.domain,
      question: item.question,
      byteIdentical: set.size === 1,
      uniqueCount: set.size,
      errors,
      firstAnswer: answers[0],
      allAnswers: answers,
    });
  }

  console.log("\n========== ANSWER SAMPLES (first run of each question) ==========\n");
  for (const r of results) {
    console.log(`--- [${r.id}] ${r.domain} — "${r.question}" ---`);
    console.log(r.firstAnswer || "<empty>");
    console.log();
  }

  console.log("========== MATRIX ==========");
  console.log("id".padEnd(34) + "domain".padEnd(16) + "5/5 identical".padEnd(16) + "verdict");
  console.log("-".repeat(80));
  let pass = 0;
  for (const r of results) {
    const ok = r.byteIdentical && r.errors.length === 0;
    if (ok) pass++;
    const cell = r.byteIdentical ? "✓" : `✗ (${r.uniqueCount} variants)`;
    console.log(r.id.padEnd(34) + r.domain.padEnd(16) + cell.padEnd(16) + (ok ? "✓" : "✗"));
  }
  console.log();
  console.log(`${pass}/${results.length} pass (${runs} runs each).`);

  const fails = results.filter((r) => !r.byteIdentical || r.errors.length > 0);
  if (fails.length > 0) {
    console.log("\n========== FAILING DETAIL ==========");
    for (const r of fails) {
      console.log(`\n--- [${r.id}] ${r.question} (${r.uniqueCount} variants) ---`);
      for (let i = 0; i < r.allAnswers.length; i++) {
        console.log(`  run ${i + 1}: ${(r.allAnswers[i] || "").slice(0, 200).replace(/\n/g, " ⏎ ")}`);
      }
      if (r.errors.length > 0) console.log(`  errors: ${r.errors.join(" | ")}`);
    }
  }

  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => {
  console.error("FATAL:", e?.stack || e);
  process.exit(1);
});
