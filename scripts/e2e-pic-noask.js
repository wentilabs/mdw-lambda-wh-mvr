/* eslint-disable no-console */
/**
 * REAL handler test that a project with NO Novade credentials SKIPS the enrichment ask and
 * keeps the existing SILENT behavior: an unresolvable tag falls back through the 3-tier resolver
 * (Name List → whatsapp_listener pushname → raw "@id") and is stored in the PIC column as-is,
 * with NO message sent. Runs through the EXACT processMessageAgent handler + real sheet.
 *
 *   node scripts/e2e-pic-noask.js
 */
require("dotenv").config();

const sm = require("../utils/sendMessage");
let sent = [];
sm.sendWhatsAppReply = async (...a) => { sent.push(a); return { ok: true }; };
sm.sendWhatsAppMessage = async (...a) => { sent.push(a); return { ok: true }; };

const { processMessageAgent } = require("../usecases/health_safety/openai");
const { findExistingSafetyIssueRow } = require("../handlers/safety-handlers");
const adapter = require("../utils/pic-enrichment-adapter-whmbs");
const { readGoogleSheet, deleteRow } = require("../utils/gsheet");

const SS = process.env.SAFETY_SPREADSHEET_ID;
const GROUP = "120363426172368944@g.us";
const IMG_FILE = "87016d25-d4b4-4e99-969c-e05a33cbc73f-WendyCL.1781072414";
const GC = { spreadsheetId: SS, safetySheetName: "Safety" };
const BASE = `E2ENOASK${Math.floor(1000000 + process.uptime() * 1000)}`;

let pass = 0, fail = 0;
const ok = (c, n) => (c ? (pass++, console.log("  ✓", n)) : (fail++, console.error("  ✗", n)));
const cell = (rows, rn, name) => {
  const h = rows[0].map((x) => String(x).trim().toLowerCase());
  return String((rows[rn - 1] || [])[h.indexOf(name.toLowerCase())] ?? "").trim();
};
const mk = (body, id) => ({
  from: GROUP, chatId: GROUP, isGroup: true, type: "image", mediaFilename: IMG_FILE,
  sender: "E2E", phoneNumber: "6500000000", body, messageId: id,
  messageIdSerialized: `false_${GROUP}_${id}_1@lid`, quotedBody: false, parentMsgKey: null,
  timestamp: Math.floor(Date.now() / 1000), chatName: "MVR (E2E)",
});

async function check({ label, lid, expectPicMatch }) {
  sent = [];
  const stamp = `${BASE}${label}`;
  await processMessageAgent(mk(`Safety hazard: loose guardrail at slab edge, fall risk. PIC ${lid}`, stamp));
  const row = await findExistingSafetyIssueRow({ messageId: stamp, parentMessageId: stamp }, GC);
  ok(!!row, `[${label}] Safety row created (S/N ${row && row["S/N"]})`);
  if (!row) return;
  const enrichMsgs = sent.filter((a) => /\[ref:\s*PICENRICH-/.test(String(a[1] || "")));
  ok(enrichMsgs.length === 0, `[${label}] NO enrichment ask was sent (silent — no Novade)`);
  const rows = await readGoogleSheet(SS, "Safety");
  const pic = cell(rows, row.RowNumber, "PIC");
  ok(expectPicMatch(pic), `[${label}] PIC stored silently = "${pic}"`);
  try {
    const fresh = await findExistingSafetyIssueRow({ messageId: stamp, parentMessageId: stamp }, GC);
    if (fresh) { await deleteRow(SS, "Safety", fresh.RowNumber); console.log(`  [cleanup] removed Safety row ${fresh.RowNumber}`); }
  } catch (e) { console.warn(`  [cleanup ${label}]`, e.message); }
}

(async () => {
  console.log(`=== REAL no-Novade SKIP test (wh-mvr) on ${SS} / group ${GROUP} ===`);
  ok(adapter.hasNovade() === false, "adapter.hasNovade() === false (no Novade creds)");

  // RAW: not in Name List, not in whatsapp_listener → stored as the raw "@id"
  await check({ label: "RAW", lid: "@99999999999999", expectPicMatch: (p) => p === "@99999999999999" });
  // LISTENER: a real listener LID → silent resolver stores its pushname (NOT raw), per the 3-tier
  await check({ label: "LISTENER", lid: "@154885513306361", expectPicMatch: (p) => p !== "" && p !== "@154885513306361" });

  console.log(`\n${fail === 0 ? "✅ PASS" : "❌ FAIL"}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("FATAL", e.stack || e.message); process.exit(1); });
