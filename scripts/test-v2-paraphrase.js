// V2 paraphrase invariance test.
//
// For each bank question, asks the LLM to produce 3 alternate phrasings, then
// runs v2 on each. Asserts:
//   • All paraphrases route to the same QueryIntent (question_type, domain,
//     target_metric, time_window kind+start_iso+end_iso).
//   • All paraphrases produce the same final numeric answer (the primary
//     number — depending on AnswerData.kind).
//
// This catches the "regex-on-user-text" class of bugs the user has been
// finding manually.
//
// Run: node scripts/test-v2-paraphrase.js [--only=<idSubstring>]

require("dotenv").config();
const { getOpenAI } = require("../utils/openai");
const { handleQuestion } = require("../usecases/qa_agent_v2");
const { parseIntent } = require("../usecases/qa_agent_v2/parser/parse-intent");
const { getGroupConfiguration } = require("../config/group-config");
const { BANK } = require("./qa-question-bank");

const GROUP_ID = process.env.QA_TEST_GROUP_ID || "120363408413581964@g.us";
const PARAPHRASES = 3;

function parseArgs() {
  const args = { only: null };
  for (const a of process.argv.slice(2)) if (a.startsWith("--only=")) args.only = a.slice("--only=".length);
  return args;
}

async function paraphrase(q) {
  const resp = await getOpenAI().responses.create({
    model: "gpt-4.1",
    temperature: 0,
    input: [
      {
        role: "system",
        content: `Produce ${PARAPHRASES} alternate phrasings of the following construction site question. Preserve the analytical intent EXACTLY — same domain, same metric, same date scope. Vary surface phrasing (synonyms, word order, formal vs. informal). Return JSON array of ${PARAPHRASES} strings, no commentary.`,
      },
      { role: "user", content: q },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "paraphrases",
        strict: true,
        schema: {
          type: "object",
          properties: { phrasings: { type: "array", items: { type: "string" }, minItems: PARAPHRASES, maxItems: PARAPHRASES } },
          required: ["phrasings"],
          additionalProperties: false,
        },
      },
    },
  });
  return JSON.parse(resp.output_text).phrasings;
}

function primaryNumber(answer) {
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
    case "comparison":
      return answer.delta;
    case "ratio":
      return answer.pct;
    case "threshold":
      return answer.over;
    case "top_n":
      return answer.rows.length;
    case "ranking":
      return answer.winners[0]?.value ?? null;
    case "list":
      return answer.total;
    default:
      return null;
  }
}

function intentFingerprint(intent) {
  if (!intent) return "";
  const tw = intent.time_window || {};
  return JSON.stringify({
    qt: intent.question_type,
    d: intent.domain,
    m: intent.target_metric,
    twk: tw.kind,
    s: tw.start_iso,
    e: tw.end_iso,
    f: (intent.filters || []).map((f) => `${f.field}${f.op}${JSON.stringify(f.value ?? f.values)}`).sort(),
    g: (intent.group_by || []).map((g) => g.field).sort(),
  });
}

(async () => {
  const { only } = parseArgs();
  const gc = getGroupConfiguration(GROUP_ID);
  const bank = only ? BANK.filter((b) => b.id.includes(only)) : BANK;

  console.log(`Paraphrase invariance: ${bank.length} questions × ${PARAPHRASES + 1} phrasings each.\n`);
  const results = [];
  for (const item of bank) {
    let phrasings = [];
    try {
      phrasings = await paraphrase(item.question);
    } catch (e) {
      results.push({ id: item.id, error: `paraphrase_failed: ${e.message}` });
      continue;
    }
    const variants = [item.question, ...phrasings];
    const fingerprints = [];
    const primaryNumbers = [];
    for (const v of variants) {
      try {
        const intent = await parseIntent(v);
        const r = await handleQuestion(v, gc);
        fingerprints.push(intentFingerprint(intent));
        primaryNumbers.push(primaryNumber(r.answer));
      } catch (e) {
        fingerprints.push(`ERR:${e.message}`);
        primaryNumbers.push(null);
      }
    }
    const intentSet = new Set(fingerprints);
    const numSet = new Set(primaryNumbers.map((n) => (n === null ? "null" : String(n))));
    results.push({
      id: item.id,
      question: item.question,
      variants,
      sameIntent: intentSet.size === 1,
      sameNumber: numSet.size === 1,
      fingerprints,
      primaryNumbers,
    });
    process.stdout.write(`  [${item.id}] intent:${intentSet.size === 1 ? "✓" : "✗"} num:${numSet.size === 1 ? "✓" : "✗"}\n`);
  }

  console.log("\n========== PARAPHRASE MATRIX ==========");
  console.log("id".padEnd(34) + "intent invariant".padEnd(20) + "number invariant".padEnd(20) + "verdict");
  console.log("-".repeat(85));
  let pass = 0;
  for (const r of results) {
    if (r.error) {
      console.log(r.id.padEnd(34) + `(error: ${r.error})`);
      continue;
    }
    const ok = r.sameIntent && r.sameNumber;
    if (ok) pass++;
    console.log(
      r.id.padEnd(34) + (r.sameIntent ? "✓" : "✗").padEnd(20) + (r.sameNumber ? "✓" : "✗").padEnd(20) + (ok ? "✓" : "✗"),
    );
  }
  console.log(`\n${pass}/${results.length} pass.`);

  const fails = results.filter((r) => !r.sameIntent || !r.sameNumber);
  if (fails.length > 0) {
    console.log("\n========== FAILING DETAIL ==========");
    for (const r of fails) {
      console.log(`\n--- [${r.id}] "${r.question}" ---`);
      for (let i = 0; i < r.variants.length; i++) {
        console.log(`  ${i === 0 ? "ORIG " : `PARA${i}`}: "${r.variants[i]}"`);
        console.log(`         fp: ${r.fingerprints[i]}`);
        console.log(`         num: ${r.primaryNumbers[i]}`);
      }
    }
  }
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => {
  console.error("FATAL:", e?.stack || e);
  process.exit(1);
});
