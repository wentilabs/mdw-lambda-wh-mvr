/* eslint-disable no-console */
/**
 * READ-ONLY. Identifies safety rows corrupted by the old close-bug (status/after-image/etc
 * shifted one column left after the PIC insertion) and prints a per-row repair plan,
 * recovering the lost original Image + Created Timestamp from the listener via the messageId
 * stored in the (intact) Sender cell. Modifies nothing.
 *
 *   node scripts/identify-corrupted-safety-rows.js
 */
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const { readGoogleSheet } = require("../utils/gsheet");
const { retrieveImageFromSupabase } = require("../utils/action");
const { formatHumanReadableTimestamp } = require("../utils/date");

const SS = process.env.SAFETY_SPREADSHEET_ID;
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

const colLetter = (i) => (i < 26 ? String.fromCharCode(65 + i) : "A" + String.fromCharCode(65 + i - 26));

async function recoverOriginal(senderRaw) {
  let sender = {};
  try { sender = JSON.parse(senderRaw || "{}"); } catch (_) {}
  const messageId = sender.messageId || "";
  // Created Timestamp recovery from the intact Sender JSON timestamp
  let createdTs = "";
  if (sender.timestamp) {
    try {
      const t = typeof sender.timestamp === "number" || /^\d{10,13}$/.test(String(sender.timestamp))
        ? new Date(Number(sender.timestamp) < 1e11 ? Number(sender.timestamp) * 1000 : Number(sender.timestamp))
        : new Date(sender.timestamp);
      createdTs = "'" + formatHumanReadableTimestamp(t);
    } catch (_) {}
  }
  // Original Image recovery: messageId -> listener row -> mediaFilename -> signed url
  let origImage = "(unrecoverable — original overwritten)";
  if (messageId) {
    try {
      const { data } = await sb.from("whatsapp_listener").select("from,mediaFilename").eq("messageId", messageId).limit(1).maybeSingle();
      if (data && data.mediaFilename) {
        const url = await retrieveImageFromSupabase(data.from, data.mediaFilename);
        if (url) origImage = `=image("${url}",2)`;
      }
    } catch (_) {}
  }
  return { messageId, createdTs, origImage };
}

(async () => {
  for (const tab of ["Safety", "Safety-May 2026", "Safety-Apr 2026"]) {
    const rows = await readGoogleSheet(SS, tab);
    const H = rows[0].map((h) => String(h).trim());
    const ix = (n) => H.findIndex((h) => h.toLowerCase() === n.toLowerCase());
    const cImg = ix("Image"), cStatus = ix("Status"), cSender = ix("Sender"), cCreated = ix("Created Timestamp"),
      cImgAfter = ix("Image After Rectification"), cUpdTs = ix("Updated Timestamp"), cUpdBy = ix("Updated By");
    const corrupt = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i]; if (!r || !r[0]) continue;
      const img = String(r[cImg] ?? "").trim().toLowerCase();
      if (["closed", "open", "n/a"].includes(img) || String(r[cUpdTs] ?? "").trim().startsWith("{")) corrupt.push({ i, r });
    }
    console.log(`\n######## [${tab}] ${corrupt.length} corrupted row(s) ########`);
    for (const { i, r } of corrupt) {
      const rec = await recoverOriginal(r[cSender]);
      const afterImg = String(r[cCreated] ?? "");   // after-image currently sits in Created Timestamp
      const closeTs = String(r[cImgAfter] ?? "");    // close timestamp currently sits in Image After Rect
      const closerJson = String(r[cUpdTs] ?? "");    // closer JSON currently sits in Updated Timestamp
      console.log(`\n— sheet row ${i + 1}  S/N ${r[0]}  (messageId ${rec.messageId || "?"}) —`);
      const fix = (col, name, cur, correct) => console.log(`   ${colLetter(col)} ${name.padEnd(26)} now: ${JSON.stringify(String(cur).slice(0, 34))}  →  set: ${typeof correct === "string" && correct.length > 40 ? correct.slice(0, 40) + "…" : JSON.stringify(String(correct).slice(0, 40))}`);
      fix(cStatus, "Status", r[cStatus], "closed");
      fix(cImg, "Image", r[cImg], rec.origImage);
      fix(cCreated, "Created Timestamp", r[cCreated], rec.createdTs || "(recover manually from Date)");
      fix(cImgAfter, "Image After Rectification", r[cImgAfter], afterImg || "(empty)");
      fix(cUpdTs, "Updated Timestamp", r[cUpdTs], closeTs || "(empty)");
      fix(cUpdBy, "Updated By", r[cUpdBy], closerJson || "(empty)");
    }
  }
  console.log("\n(Read-only — nothing was changed. Apply the 'set:' values to each cell.)");
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
