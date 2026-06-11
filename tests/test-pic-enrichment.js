/* eslint-disable no-console */
/**
 * Node-script tests for the multi-turn PIC enrichment flow (wh-mbs family, no Jest).
 *   node tests/test-pic-enrichment.js
 *
 * The core state machine (utils/pic-enrichment.js) is byte-identical to obayashi's (covered by
 * its jest suite); here we exercise it end-to-end against the wh-mbs require paths by stubbing
 * the I/O boundaries in the require cache, plus the real fuzzball-based wh-mbs adapter.
 */
const path = require("path");

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

// ── require-cache mock plumbing ──
function mockModule(relFromHere, exportsObj) {
  const abs = require.resolve(relFromHere);
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: exportsObj };
  return abs;
}
function freshPicEnrichment({ llmQueue = [], nameListMap = new Map(), existingRow = { RowNumber: 2, "S/N": 99, Status: "open" } } = {}) {
  const state = { sent: [], appended: [], updated: [], llm: [...llmQueue] };
  mockModule("../utils/openai", {
    getOpenAI: () => ({
      responses: {
        create: async () => {
          const next = state.llm.length ? state.llm.shift() : {};
          if (next && next.__throw) throw new Error("llm boom");
          return { output_text: JSON.stringify(next) };
        },
      },
    }),
  });
  mockModule("../utils/gsheet", { writeArrayToGSheetRow: async (_s, sheet, row) => state.appended.push({ sheet, row }) });
  mockModule("../utils/name-list", { loadNameList: async () => nameListMap, invalidateNameListCache: () => {} });
  mockModule("../utils/sendMessage", { sendWhatsAppReply: async (chatId, text, _c, _t, quoted) => state.sent.push({ chatId, text, quoted }) });
  mockModule("../handlers/safety-handlers", {
    findExistingSafetyIssueRow: async () => existingRow,
    updateExistingSafetyIssueRow: async ({ issueData }) => state.updated.push({ pic: issueData.pic }),
  });
  // bust the cached pic-enrichment so it re-binds to the fresh mocks
  delete require.cache[require.resolve("../utils/pic-enrichment")];
  state.pe = require("../utils/pic-enrichment");
  return state;
}
function stubAdapter({ candidates = [], hasNovade = true } = {}) {
  return {
    hasNovade: () => hasNovade,
    getCandidates: async (_q, _p, limit = 5) => candidates.slice(0, limit),
    nameListSheetName: "Novade Name List",
    buildNameListRow: ({ novadeName, whatsappName, phone, lid }) => [novadeName, whatsappName || "", phone || "", lid],
  };
}
const groupConfig = { spreadsheetId: "SS" };
const reply = (tok, body) => ({ from: "G", chatId: "G", messageId: "R1", messageIdSerialized: "ser_R1", body, quotedBody: `p\n[ref: PICENRICH-${tok}]`, type: "chat" });
const lastTok = (s) => s.pe.parsePicEnrichRef(s.sent[s.sent.length - 1].text);

(async () => {
  // ── marker + namespace ──
  {
    const s = freshPicEnrichment();
    const st = { v: 1, a: "A", b: "", d: [], q: [{ i: "@1", s: "R" }], st: "ASK", r: 0 };
    eq(s.pe.decodeEnrichState(s.pe.encodeEnrichState(st)), st, "marker roundtrip");
    ok(s.pe.decodeEnrichState("$$$") === null, "bad token → null");
    const tok = s.pe.encodeEnrichState({ q: [1] });
    ok(s.pe.parsePicEnrichRef(`[ref: PICENRICH-${tok}]`) === tok, "parses PICENRICH");
    ok(s.pe.parsePicEnrichRef("[ref: PIC-ORIG]") === null, "ignores PIC- marker");
    ok(s.pe.parsePicEnrichRef("[ref: Novade-Preview-20260610-2000-AB12CD]") === null, "ignores Novade-Preview");
    ok(s.pe.hasUsableName("Mohamed") && !s.pe.hasUsableName("🦁") && !s.pe.hasUsableName("659912345"), "hasUsableName");
  }

  // ── start: listener (good name) → CONFIRM ; raw → ASK ──
  {
    const s = freshPicEnrichment();
    const r = await s.pe.startPicEnrichment({
      message: { chatId: "G", messageIdSerialized: "ser_O" }, senderDetails: { messageId: "ORIG" }, groupConfig,
      anchorId: "ORIG", baseNames: ["Larry"], unresolvedMentions: [{ id: "@111", source: "listener", whatsappName: "Sahi", phone: "65" }],
      adapter: stubAdapter({ candidates: [{ n: "Sahi One" }, { n: "Sahi Two" }] }),
    });
    ok(r && r.enrichStarted && /1\. Sahi One/.test(s.sent[0].text) && s.sent[0].quoted === "ser_O", "listener → CONFIRM with candidates");
  }
  {
    const s = freshPicEnrichment();
    await s.pe.startPicEnrichment({
      message: { chatId: "G" }, senderDetails: { messageId: "ORIG" }, groupConfig, anchorId: "ORIG", baseNames: [],
      unresolvedMentions: [{ id: "@222", source: "raw" }], adapter: stubAdapter({ candidates: [] }),
    });
    ok(/couldn't identify/i.test(s.sent[0].text) && /PICENRICH-/.test(s.sent[0].text), "raw → ASK");
  }

  // ── CONFIRM pick 1 → append (4-col) + set PIC + done ──
  {
    const s = freshPicEnrichment({ llmQueue: [{ choice: 1 }] });
    const adapter = stubAdapter({ candidates: [{ n: "Sahi One" }, { n: "Sahi Two" }] });
    await s.pe.startPicEnrichment({ message: { chatId: "G" }, senderDetails: { messageId: "ORIG" }, groupConfig, anchorId: "ORIG", baseNames: ["Larry"], unresolvedMentions: [{ id: "@111", source: "listener", whatsappName: "Sahi", phone: "65" }], adapter });
    const r = await s.pe.handlePicEnrichmentReply(reply(lastTok(s), "1"), {}, groupConfig, adapter);
    ok(r && r.committed === "Sahi One" && r.done, "CONFIRM pick → committed+done");
    eq(s.appended[0].row, ["Sahi One", "Sahi", "65", "@111"], "Name List row is 4-col (no Company)");
    eq(s.updated.pop().pic, "Larry, Sahi One", "PIC = base + confirmed");
    ok(/✅ PIC set: Larry, Sahi One/.test(s.sent[s.sent.length - 1].text), "done ack");
  }

  // ── ASK → name+phone → CONFIRM ──
  {
    const s = freshPicEnrichment({ llmQueue: [{ novadeName: "Mohamed Shafiee", phone: "65999" }] });
    const adapter = stubAdapter({ candidates: [{ n: "Mohamed Shafiee Bin X" }] });
    await s.pe.startPicEnrichment({ message: { chatId: "G" }, senderDetails: { messageId: "ORIG" }, groupConfig, anchorId: "ORIG", baseNames: [], unresolvedMentions: [{ id: "@333", source: "raw" }], adapter });
    const r = await s.pe.handlePicEnrichmentReply(reply(lastTok(s), "shafiee 65999"), {}, groupConfig, adapter);
    ok(r && r.stage === "CONFIRM" && /1\. Mohamed Shafiee Bin X/.test(s.sent[s.sent.length - 1].text), "ASK → CONFIRM");
  }

  // ── queue of 2 → second prompt after first confirm ──
  {
    const s = freshPicEnrichment({ llmQueue: [{ choice: 1 }] });
    const adapter = stubAdapter({ candidates: [{ n: "Person A" }] });
    await s.pe.startPicEnrichment({ message: { chatId: "G" }, senderDetails: { messageId: "ORIG" }, groupConfig, anchorId: "ORIG", baseNames: [], unresolvedMentions: [{ id: "@111", source: "listener", whatsappName: "AAA", phone: "1" }, { id: "@222", source: "raw" }], adapter });
    const r = await s.pe.handlePicEnrichmentReply(reply(lastTok(s), "1"), {}, groupConfig, adapter);
    ok(r && r.committed === "Person A" && r.next && /couldn't identify/i.test(s.sent[s.sent.length - 1].text), "queue advances to 2nd item");
  }

  // ── not-found / closed / dup ──
  {
    const s = freshPicEnrichment({ existingRow: null });
    const tok = s.pe.encodeEnrichState({ v: 1, a: "ORIG", b: "", d: [], q: [{ i: "@1", s: "R" }], st: "ASK", r: 0 });
    const r = await s.pe.handlePicEnrichmentReply(reply(tok, "John 65"), {}, groupConfig, stubAdapter({ candidates: [{ n: "X" }] }));
    ok(r && r.notFound && s.appended.length === 0 && s.updated.length === 0, "deleted row → notFound, no writes");
  }
  {
    const s = freshPicEnrichment({ existingRow: { RowNumber: 2, "S/N": 5, Status: "closed" } });
    const tok = s.pe.encodeEnrichState({ v: 1, a: "ORIG", b: "", d: [], q: [{ i: "@1", s: "R" }], st: "ASK", r: 0 });
    const r = await s.pe.handlePicEnrichmentReply(reply(tok, "John 65"), {}, groupConfig, stubAdapter({ candidates: [{ n: "X" }] }));
    ok(r && r.closed && s.appended.length === 0, "closed row → closed, no append");
  }
  {
    const s = freshPicEnrichment({ llmQueue: [{ choice: 1 }], nameListMap: new Map([["@111", { novadeName: "Sahi One" }]]) });
    const adapter = stubAdapter({ candidates: [{ n: "Sahi One" }] });
    await s.pe.startPicEnrichment({ message: { chatId: "G" }, senderDetails: { messageId: "ORIG" }, groupConfig, anchorId: "ORIG", baseNames: [], unresolvedMentions: [{ id: "@111", source: "listener", whatsappName: "Sahi", phone: "1" }], adapter });
    const r = await s.pe.handlePicEnrichmentReply(reply(lastTok(s), "1"), {}, groupConfig, adapter);
    ok(r && r.committed === "Sahi One" && s.appended.length === 0 && s.updated.pop().pic === "Sahi One", "duplicate lid → skip append, still set PIC");
  }
  {
    const s = freshPicEnrichment();
    ok((await s.pe.handlePicEnrichmentReply({ quotedBody: "no marker" }, {}, groupConfig, stubAdapter())) === null, "no marker → null");
  }

  // ── real wh-mbs adapter: fuzzball top-5 + 4-col row (gatherNames mocked) ──
  {
    delete require.cache[require.resolve("../utils/pic-enrichment-adapter-whmbs")];
    mockModule("../config/novade-assignees", { getKnownAssigneesForProject: () => ["PACKIASAMY MANI", "Mohamed Shafiee", "Roslan bin Mohamed", "Zulkarnain", "Nguyen Pham Tuan Ngoc", "Ahmad Fauzi"] });
    mockModule("../utils/novade-api", { listNovadeActorsFromHistory: async () => ["Mohamad Shafie"] });
    const ad = require("../utils/pic-enrichment-adapter-whmbs");
    const cands = await ad.getCandidates("shafiee", "", 5);
    ok(cands.length > 0 && cands.length <= 5 && /Shafi/i.test(cands[0].n), `whmbs adapter fuzzy top-5 (best="${cands[0] && cands[0].n}")`);
    eq(ad.buildNameListRow({ novadeName: "Mohamed Shafiee", whatsappName: "Shafiee", phone: "65", lid: "@1" }), ["Mohamed Shafiee", "Shafiee", "65", "@1"], "whmbs row = 4 cols");
  }

  console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"}: ${pass} passed, ${fail} failed`);
  if (fail) {
    console.log("failed:", fails);
    process.exit(1);
  }
})().catch((e) => {
  console.error("FATAL", e.stack || e.message);
  process.exit(1);
});
