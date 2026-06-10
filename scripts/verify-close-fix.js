/* eslint-disable no-console */
// Verify the updateStructuredData close fix writes status/after-image/updated-* to the
// CORRECT (by-name) columns post-PIC-insertion, and does NOT clobber Image / Created Ts.
require("dotenv").config();
const sm = require("../utils/sendMessage");
sm.sendWhatsAppReply = async () => ({ ok: true }); // silence the PIC ask
const { createSafetyIssue, findExistingSafetyIssueRow } = require("../handlers/safety-handlers");
const { updateStructuredData } = require("../utils/action");
const { readGoogleSheet, deleteRow } = require("../utils/gsheet");

const SS = process.env.SAFETY_SPREADSHEET_ID;
const GROUP = String(process.env.SAFETY_WA_GROUP_ID).split(",")[0].trim();
const gc = { spreadsheetId: SS, safetySheetName: "Safety" };
const STAMP = `closefix${Math.floor(1781200000 + process.uptime() * 1000)}`;

const cell = (rows, rn, name) => {
  const h = rows[0].map((x) => String(x).trim().toLowerCase());
  return String((rows[rn - 1] || [])[h.indexOf(name.toLowerCase())] ?? "").trim();
};

(async () => {
  console.log("=== verify close-fix (by-name updateStructuredData) ===");
  const msg = { body: "Loose guardrail at edge of slab, fall hazard", from: GROUP, chatId: GROUP, messageId: STAMP, messageIdSerialized: `ser_${STAMP}`, chatName: "MBS (E2E)", type: "chat" };
  const sd = { name: "Reporter", phoneNumber: "6500000000", messageId: STAMP, messageIdSerialized: `ser_${STAMP}`, timestamp: 1781200000, chatName: "MBS (E2E)" };
  await createSafetyIssue(msg, null, null, sd, gc);
  const row = await findExistingSafetyIssueRow({ messageId: STAMP }, gc);
  if (!row) { console.error("❌ create failed"); process.exit(1); }

  let rows = await readGoogleSheet(SS, "Safety");
  const origImage = cell(rows, row.RowNumber, "Image");
  const origCreated = cell(rows, row.RowNumber, "Created Timestamp");
  console.log(`[1] created S/N ${row["S/N"]} row ${row.RowNumber}: Status=${cell(rows,row.RowNumber,"Status")} Image=${origImage?"(set)":"(empty)"} CreatedTs=${JSON.stringify(origCreated.slice(0,18))}`);

  // close it (the exact path the reply-to-close flow uses)
  const closer = { name: "PK.MANI", phoneNumber: "6500000001", messageId: `${STAMP}-close`, timestamp: 1781203600 };
  await updateStructuredData(
    { issueId: row["S/N"], rowIndex: row.RowNumber - 1, status: "closed", timestamp: "'11-Jun-2026 10:00", mediaUrl: '=image("https://example.com/after.jpg",2)', sheetName: "Safety" },
    closer, gc,
  );

  rows = await readGoogleSheet(SS, "Safety");
  const after = {
    Status: cell(rows, row.RowNumber, "Status"),
    Image: cell(rows, row.RowNumber, "Image"),
    "Created Timestamp": cell(rows, row.RowNumber, "Created Timestamp"),
    "Image After Rectification": cell(rows, row.RowNumber, "Image After Rectification"),
    "Updated Timestamp": cell(rows, row.RowNumber, "Updated Timestamp"),
    "Updated By": cell(rows, row.RowNumber, "Updated By"),
  };
  console.log("[2] after close:");
  Object.entries(after).forEach(([k, v]) => console.log(`     ${k} = ${JSON.stringify(v.slice(0, 30))}`));

  const checks = {
    "Status == closed": after.Status === "closed",
    "Image preserved (not 'closed')": after.Image === origImage && after.Image.toLowerCase() !== "closed",
    "Created Ts preserved": after["Created Timestamp"] === origCreated,
    "ImageAfterRect = after-image": after["Image After Rectification"].includes("example.com/after"),
    "Updated Ts = timestamp (not JSON)": after["Updated Timestamp"].includes("11-Jun-2026") && !after["Updated Timestamp"].startsWith("{"),
    "Updated By = closer JSON": after["Updated By"].includes("PK.MANI"),
  };
  let ok = true;
  for (const [k, v] of Object.entries(checks)) { console.log(`   ${v ? "✓" : "✗"} ${k}`); if (!v) ok = false; }
  console.log(`\n=== ${ok ? "✅ CLOSE FIX VERIFIED — columns aligned" : "❌ STILL BROKEN"} ===`);

  await deleteRow(SS, "Safety", row.RowNumber);
  console.log(`[cleanup] deleted test row ${row.RowNumber}`);
  process.exit(ok ? 0 : 2);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
