/* eslint-disable no-console */
/**
 * E2E for the missing-PIC follow-up flow in wh-mbs (writes to the TEST SAFETY_SPREADSHEET_ID,
 * cleans up). sendWhatsAppReply is SPIED (no real WhatsApp send).
 *
 *   node scripts/e2e-pic-followup.js
 *
 * 1. Create a real hazard with NO @mention → expect a blank-PIC row + a "please tag the PIC"
 *    reply carrying [ref: PIC-<messageId>] quoted via the SERIALIZED id.
 * 2. Simulate the reporter's reply (quoting the bot ask, @mentioning a real seeded Name List
 *    person) → expect the PIC cell filled with the resolved name + an ack.
 * 3. Delete the test row.
 */
require("dotenv").config();

// SPY sendWhatsAppReply BEFORE requiring the handler so its destructured binding is the spy.
const sm = require("../utils/sendMessage");
const captured = [];
sm.sendWhatsAppReply = async (chatId, text, c, t, quoted) => {
  captured.push({ chatId, text, quoted });
  console.log(`\n📤 [sendWhatsAppReply] (quoting ${quoted}):\n${text}\n`);
  return { ok: true };
};

const { createSafetyIssue, handlePicFollowupReply, findExistingSafetyIssueRow } = require("../handlers/safety-handlers");
const { readGoogleSheet, deleteRow } = require("../utils/gsheet");
const { loadNameList } = require("../utils/name-list");

const SS = process.env.SAFETY_SPREADSHEET_ID;
const GROUP = String(process.env.SAFETY_WA_GROUP_ID).split(",")[0].trim();
const groupConfig = { spreadsheetId: SS, safetySheetName: "Safety" };
const STAMP = process.env.E2E_STAMP || `demo${Math.floor(1781000000 + process.uptime() * 1000)}`;
const ORIG_ID = `E2E-PIC-${STAMP}`;
const REPLY_ID = `E2E-REPLY-${STAMP}`;
const nowSec = 1781000000 + Math.floor(process.uptime());

async function readPicCell(rowNumber) {
  const sheet = await readGoogleSheet(SS, "Safety");
  const hdr = (sheet[0] || []).map((h) => String(h).trim().toLowerCase());
  const picCol = hdr.indexOf("pic");
  return String((sheet[rowNumber - 1] || [])[picCol] ?? "").trim();
}

(async () => {
  console.log(`=== E2E missing-PIC follow-up (wh-mbs, sheet ${SS}) ===`);
  console.log(`group=${GROUP} origMessageId=${ORIG_ID}\n`);

  // pick a real seeded tag + expected name
  const nl = await loadNameList(SS);
  const [TAG, entry] = [...nl.entries()][0];
  const expectedName = entry.whatsappName || entry.phone || entry.novadeName;
  console.log(`[0] will tag ${TAG} → expect PIC "${expectedName}"`);

  // 1) create a hazard with NO @mention
  const message = {
    body: "Electrical cable hanging exposed at Zone 1, needs to be secured immediately",
    from: GROUP,
    chatId: GROUP,
    messageId: ORIG_ID,
    messageIdSerialized: `ser_${ORIG_ID}`,
    chatName: "MBS Safety (E2E)",
    type: "chat",
  };
  const senderDetails = {
    name: "E2E Tester",
    phoneNumber: "6500000000",
    messageId: ORIG_ID,
    messageIdSerialized: `ser_${ORIG_ID}`,
    timestamp: nowSec,
    chatName: "MBS Safety (E2E)",
  };

  console.log("[1] creating hazard issue (no @mention)…");
  await createSafetyIssue(message, null, null, senderDetails, groupConfig);

  const row1 = await findExistingSafetyIssueRow({ messageId: ORIG_ID }, groupConfig);
  if (!row1) {
    console.error("❌ issue NOT created (LLM may have classified it as FYI/Good Obs). Aborting.");
    process.exit(1);
  }
  const pic1 = await readPicCell(row1.RowNumber);
  console.log(`[1] row created → RowNumber=${row1.RowNumber} S/N=${row1["S/N"]} Status=${row1.Status} PIC=${JSON.stringify(pic1)}`);
  const askCall = captured.find((c) => /\[ref:\s*PIC-/.test(c.text || ""));
  console.log(`[1] asked for PIC: ${!!askCall} | ref matches origId: ${!!askCall && askCall.text.includes(`[ref: PIC-${ORIG_ID}]`)} | quoted with serialized id: ${askCall && askCall.quoted === `ser_${ORIG_ID}`}`);

  // 2) simulate the reporter's reply
  const reply = {
    from: GROUP,
    chatId: GROUP,
    messageId: REPLY_ID,
    messageIdSerialized: `ser_${REPLY_ID}`,
    body: TAG,
    quotedMessageId: "E2E-BOT",
    quotedBody: askCall ? askCall.text : `[ref: PIC-${ORIG_ID}]`,
    type: "chat",
    sender: "E2E Tester",
    timestamp: nowSec + 60,
  };
  console.log(`\n[2] reporter replies tagging ${TAG} (quoting the bot ask)…`);
  const res = await handlePicFollowupReply(reply, { name: "E2E Tester", messageId: REPLY_ID }, groupConfig);
  console.log(`[2] handlePicFollowupReply →`, JSON.stringify(res));

  const pic2 = await readPicCell(row1.RowNumber);
  console.log(`[2] actual PIC cell in sheet (row ${row1.RowNumber}) = ${JSON.stringify(pic2)}`);

  // 3) verdict
  const ok = res && res.pic && pic2 === String(res.pic).trim() && pic2 === expectedName;
  console.log(`\n=== VERDICT: ${ok ? '✅ PIC updated to "' + pic2 + '"' : "❌ PIC not updated as expected"} ===`);

  // 4) cleanup
  try {
    await deleteRow(SS, "Safety", row1.RowNumber);
    console.log(`[cleanup] deleted test row ${row1.RowNumber}`);
  } catch (e) {
    console.warn(`[cleanup] failed to delete row ${row1.RowNumber}: ${e.message} (please remove S/N ${row1["S/N"]} manually)`);
  }
  process.exit(ok ? 0 : 2);
})().catch((e) => {
  console.error("FATAL", e?.message || e);
  process.exit(1);
});
