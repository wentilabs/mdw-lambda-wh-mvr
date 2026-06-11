/* eslint-disable no-console */
/**
 * Unit tests for the PIC @mention/Name-List resolution (wh-mbs node-script style).
 *   node tests/test-name-list.js
 * Pure functions are checked inline; resolvePicFromMentions runs against the LIVE seeded
 * "Name List (proposed)" tab in SAFETY_SPREADSHEET_ID (expected ids picked dynamically, so
 * the test stays robust if the seed names change).
 */
require("dotenv").config();
const { extractMentionIds, resolvePicFromMentions, stripMentionIds, loadNameList } = require("../utils/name-list");
const { parsePicRef, buildPicRequestMessage } = require("../handlers/safety-handlers");

let pass = 0;
let fail = 0;
const fails = [];
function ok(cond, name) {
  if (cond) pass++;
  else {
    fail++;
    fails.push(name);
    console.error("  ✗", name);
  }
}
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), `${name} (got ${JSON.stringify(a)})`);

(async () => {
  console.log("== extractMentionIds ==");
  eq(extractMentionIds("@42714070515919 worker"), ["@42714070515919"], "single");
  eq(extractMentionIds("@111111111111 @222222222222 x"), ["@111111111111", "@222222222222"], "multi");
  eq(extractMentionIds("@111111111111@222222222222"), ["@111111111111", "@222222222222"], "no-space run");
  eq(extractMentionIds("@111111111111 @111111111111 dup"), ["@111111111111"], "dedup");
  eq(extractMentionIds("meet @2pm price @99"), [], "short tokens ignored");
  eq(extractMentionIds(null), [], "null");

  console.log("== stripMentionIds ==");
  eq(stripMentionIds("@63969863663674"), "", "lone id → empty");
  eq(stripMentionIds("Mr Tan @123456789"), "Mr Tan", "keeps name, strips id");
  eq(stripMentionIds("Ali (Site)"), "Ali (Site)", "plain unchanged");

  console.log("== parsePicRef / buildPicRequestMessage ==");
  eq(parsePicRef("x\n[ref: PIC-ABC123]"), "ABC123", "matches PIC marker");
  eq(parsePicRef("[ref: Novade-Preview-20260610-2000-AB12CD]"), null, "ignores Novade-Preview marker");
  eq(parsePicRef("no marker"), null, "no marker");
  ok(/\[ref:\s*PIC-Z9\]/.test(buildPicRequestMessage("Z9")), "buildPicRequestMessage embeds PIC ref");

  console.log("== resolvePicFromMentions (live Name List) ==");
  const ss = process.env.SAFETY_SPREADSHEET_ID;
  const nl = await loadNameList(ss);
  if (nl.size > 0) {
    ok(true, `Name List loaded (${nl.size} entries)`);
    const entries = [...nl.entries()];
    const [id0, e0] = entries[0];
    const disp0 = e0.novadeName || e0.whatsappName || e0.phone; // PIC = Novade Name (col A) first
    const r0 = await resolvePicFromMentions(`hazard ${id0} please fix`, ss);
    ok(r0.picText === disp0, `single mention ${id0} → "${disp0}" (got "${r0.picText}")`);
    if (entries.length > 1) {
      const [id1, e1] = entries[1];
      const disp1 = e1.novadeName || e1.whatsappName || e1.phone;
      const r2 = await resolvePicFromMentions(`${id0} ${id1}`, ss);
      eq(r2.picText, `${disp0}, ${disp1}`, "two mentions joined in order");
    }
  } else {
    console.log("  ⚠ Name List tab not seeded in this SAFETY_SPREADSHEET_ID — skipping seeded-resolution checks (run scripts/add-pic-column.js).");
  }
  // Unmatched mention: not in the Name List and (for this fabricated all-9s LID) no
  // whatsapp_listener row either → the mention is never dropped; it falls back to the raw "@id".
  const rNone = await resolvePicFromMentions("@99999999999999 unknown person", ss);
  ok(/^@\d{5,}$/.test(rNone.picText), `unmatched mention → raw @id fallback (got "${rNone.picText}")`);
  const rPlain = await resolvePicFromMentions("no mention here", ss);
  eq(rPlain.picText, "", "no mention → empty");

  console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"}: ${pass} passed, ${fail} failed`);
  if (fail) {
    console.log("failed:", fails);
    process.exit(1);
  }
})().catch((e) => {
  console.error("FATAL", e.message);
  process.exit(1);
});
