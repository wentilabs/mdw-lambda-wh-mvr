/* eslint-disable no-console */
/**
 * One-off migration for the PIC feature (run against the test SAFETY_SPREADSHEET_ID):
 *  1) Insert a "PIC" column at index 7 (between "Proposed Fix" and "Image") into every
 *     Safety tab (current + monthly archives). Existing data shifts right one column,
 *     getting a blank PIC cell — non-destructive (insertDimension).
 *  2) Create the "Name List (proposed)" tab and seed it with REAL @lid → name rows mined
 *     from the safety group's whatsapp_listener authors (so the E2E resolves real mentions).
 *
 * Idempotent: skips a tab that already has PIC at col 7; re-seeds the Name List.
 *
 *   node scripts/add-pic-column.js
 */
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const { sheets: createSheets, auth: googleAuth } = require("@googleapis/sheets");
const { readGoogleSheet, createNewSheet } = require("../utils/gsheet");

const SS = process.env.SAFETY_SPREADSHEET_ID;
const SAFETY_TAB_RE = /^Safety(-[A-Za-z]{3,} \d{4})?$/;
const NAME_LIST_TAB = "Novade Name List";

const auth = new googleAuth.JWT({
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.replace(/\\n/g, "\n"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const api = createSheets({ version: "v4", auth });

async function main() {
  console.log(`=== add-pic-column migration on ${SS} ===`);
  const meta = await api.spreadsheets.get({ spreadsheetId: SS });
  const allTabs = meta.data.sheets.map((s) => s.properties.title);
  const safetyTabs = meta.data.sheets.filter((s) => SAFETY_TAB_RE.test(s.properties.title));

  // 1) Insert PIC column into each Safety tab (idempotent + layout-checked)
  for (const t of safetyTabs) {
    const title = t.properties.title;
    const sheetId = t.properties.sheetId;
    const rows = await readGoogleSheet(SS, title);
    const headers = (rows[0] || []).map((h) => String(h || "").trim());
    if (headers[7] === "PIC") {
      console.log(`  [${title}] already has PIC at col H — skip`);
      continue;
    }
    if (headers.includes("PIC")) {
      console.log(`  [${title}] has PIC at col ${headers.indexOf("PIC")} (not 7) — skip, inspect manually`);
      continue;
    }
    // Safety check: PIC must go between "Proposed Fix" (idx 6) and "Image" (idx 7).
    if (headers[6] !== "Proposed Fix" || headers[7] !== "Image") {
      console.log(
        `  [${title}] unexpected layout (idx6="${headers[6]}", idx7="${headers[7]}") — SKIP (won't risk misalignment)`,
      );
      continue;
    }
    await api.spreadsheets.batchUpdate({
      spreadsheetId: SS,
      requestBody: {
        requests: [
          {
            insertDimension: {
              range: { sheetId, dimension: "COLUMNS", startIndex: 7, endIndex: 8 },
              inheritFromBefore: true,
            },
          },
        ],
      },
    });
    await api.spreadsheets.values.update({
      spreadsheetId: SS,
      range: `'${title}'!H1`,
      valueInputOption: "RAW",
      requestBody: { values: [["PIC"]] },
    });
    console.log(`  [${title}] inserted PIC column at H ✓`);
  }

  // 2) Build Name List rows from real author lids → names
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
  const groupIds = String(process.env.SAFETY_WA_GROUP_ID)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const { data: authors } = await sb
    .from("whatsapp_listener")
    .select("author,sender,phoneNumber")
    .in("from", groupIds)
    .not("author", "is", null)
    .limit(5000);
  const map = {};
  for (const a of authors || []) {
    const m = String(a.author || "").match(/^(\d{5,})@/);
    const name = String(a.sender || "").trim();
    if (m && name && name !== ".") {
      map["@" + m[1]] = { name, phone: String(a.phoneNumber || "").trim() };
    }
  }
  // NEVER overwrite a real "Novade Name List". Only seed a mock one when the tab is
  // missing entirely (fresh dev sheet). Headers match loadNameList's by-name lookup; the
  // Whatsapp ID is the bare LID (loadNameList accepts "@<digits>" or "<digits>").
  if (allTabs.includes(NAME_LIST_TAB)) {
    console.log(`  "${NAME_LIST_TAB}" already exists — leaving it untouched (real data).`);
  } else {
    const nlRows = [["Novade Name", "Whatsapp Name", "Phone Number", "Whatsapp ID"]];
    for (const [id, v] of Object.entries(map)) nlRows.push([v.name, v.name, v.phone, id]);
    await createNewSheet(SS, NAME_LIST_TAB);
    await api.spreadsheets.values.update({
      spreadsheetId: SS,
      range: `'${NAME_LIST_TAB}'!A1`,
      valueInputOption: "RAW",
      requestBody: { values: nlRows },
    });
    console.log(`  created + seeded mock "${NAME_LIST_TAB}" with ${nlRows.length - 1} people`);
  }
  console.log("\n✅ migration done.");
}

main().catch((e) => {
  console.error("FATAL", e?.response?.data ? JSON.stringify(e.response.data).slice(0, 300) : e.message);
  process.exit(1);
});
