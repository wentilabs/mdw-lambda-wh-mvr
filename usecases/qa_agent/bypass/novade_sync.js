/**
 * Novade Sync — bypass handler (TWO-STEP approval flow).
 *
 * On-demand Novade operations from the WhatsApp QA agent. The `sync` action
 * no longer pushes to Novade immediately; instead it:
 *
 *   Step 1 (PREVIEW): freezes the eligible rows into a NEW persistent
 *     `Novade-Preview-<...>` tab in the Safety spreadsheet, screenshots it,
 *     sends the screenshot with a caption ending in `[ref: <previewTabName>]`
 *     and asks the user to reply approve/cancel.
 *
 *   Step 2 (APPROVAL): when the user replies (quoting the bot's screenshot),
 *     the lambda's main router detects the `[ref: Novade-Preview-...]` marker
 *     in `quotedBody` and calls handleNovadeSyncConfirmation here. The
 *     confirmation handler LLM-classifies the reply (approve / cancel /
 *     ambiguous), and on approve runs the actual per-row Novade pipeline
 *     (create + patch + upload-before + close-walk + upload-after) against
 *     the rows in the preview tab, writes back Novade Action Ids to the LIVE
 *     Safety sheet, then deletes the preview tab.
 *
 * The other two sub-actions are unchanged and read-only:
 *   status_sheet  → count synced vs unsynced from sheet only
 *   status_novade → GET /safety/actions/{id} for closed rows, flag drift
 *
 * SAFETY-CRITICAL invariants enforced here:
 *
 *   1. EVERY query that selects rows uses `[Date] BETWEEN start_iso AND
 *      end_iso` (or `=` for single date). No row outside that window is
 *      ever touched. Idempotency keeps already-synced rows untouched too.
 *   2. The user APPROVES exactly the rows they saw in the screenshot — the
 *      approval handler reads from the FROZEN preview tab, not from the live
 *      sheet (so rows added/edited between preview and approve don't leak
 *      into the sync).
 *   3. The cron's helpers are imported from utils/novade-api.js directly;
 *      `processSheet()` and `handler()` in usecases/safety_novade_sync are
 *      NOT called, so the cron path stays completely untouched.
 *   4. Per-batch writeback (same as cron line 559) means a Lambda timeout
 *      can orphan at most one batch of Novade creates, not the entire run.
 *   5. VERIFY-before-report: each created action is re-fetched
 *      (getSafetyActionById) and only reported as "Synced & verified" once its
 *      Novade status matches the expectation (open→1, closed→7). A created-
 *      but-unverified row is surfaced separately with its id (manual close).
 *   6. The Novade Action Id is written back for EVERY created action (even if
 *      its close failed) so a retry can't create a DUPLICATE — and the preview
 *      tab is deleted after ANY completed run (success OR partial), because a
 *      second 'approve' on it would re-create everything (strict mode does no
 *      approve-time idempotency). Retry = re-issue the sync question, NOT
 *      reply 'approve' again. A fresh preview skips rows that already carry an
 *      id at build time.
 *   7. The cron API `api/novade-safety-sync.js` is unaffected.
 */

const crypto = require("crypto");
const { runSQLQuery } = require("../../../utils/action");
const { batchUpdateCells, readGoogleSheet, getSheetNames, deleteSheet } = require("../../../utils/gsheet");
const { getOpenAI } = require("../../../utils/openai");
const {
  createSafetyAction,
  patchSafetyAction,
  closeSafetyAction,
  uploadFileFromUrl,
  getSafetyActionById,
  extractNovadeRecId,
  parseTimestampToMs,
  resolveProjectIdByName,
  resolveUnitIdForProject,
  listUnitsForProjectCached,
  listSafetyIssueTypesCached,
  listCompanies,
  listNovadeActorsFromHistory,
  getProjectById,
} = require("../../../utils/novade-api");
const { resolvePICToContractorId } = require("../../../utils/pic-company-mapping");
const { resolveNovadeActor } = require("../../../utils/novade-user-mapping");
const { refreshSignedUrl } = require("../../../utils/supabase-storage");
const { getKnownAssigneesForProject } = require("../../../config/novade-assignees");
const { classifyIssuesForNovade } = require("../../safety_novade_sync/llm-classify");
const { captureSafetyImage } = require("../../health_safety/safety-image");
// Chunked safety-list image renderer (small per-chunk PDFs → under the 60s/page
// PDF→PNG converter timeout). The preview screenshot is rendered through this
// instead of one monolithic captureSafetyImage export, which at the 100-row
// batch cap produced an ~83 MB / 10-page PDF that timed out (prod 2026-06-05).
const { renderSafetyListPhotoImages } = require("../safety_list_image");
const { snapshotFooter } = require("./safety_summary");

// ---------------------------------------------------------------------------
// Constants — same as cron except DEFAULT_BATCH_SIZE (smaller for QA latency)
// ---------------------------------------------------------------------------

const SAFETY_SHEET_NAME = "Safety";
const NOVADE_ACTION_ID_HEADER = "Novade Action Id";
const LINKED_TABLE = "novadesafety.nonconformities";
const DEFAULT_BATCH_SIZE = 5;
const STATUS_NOVADE_CAP = 20;
const DEFAULT_PROJECT_NAME = "MBS-IR2";

// Preview-tab naming + reply-marker pattern. The bot-generated marker is
// `[ref: Novade-Preview-<YYYYMMDD>-<HHMM>-<6charHex>]` and is appended to
// the screenshot caption. The lambda's main router detects this marker in
// the user's reply `quotedBody` and dispatches to handleNovadeSyncConfirmation.
const PREVIEW_TAB_PREFIX = "Novade-Preview-";
const PREVIEW_TAB_NAME_RE = /Novade-Preview-\d{8}-\d{4}-[0-9A-F]{6}/;
const REF_MARKER_PATTERN = "\\[ref:\\s*(Novade-Preview-\\d{8}-\\d{4}-[0-9A-F]{6})\\s*\\]";
const REF_MARKER_RE = new RegExp(REF_MARKER_PATTERN, "i");

const NOVADE_STATUS_LABELS = {
  1: "Open",
  2: "Confirmed",
  5: "Completed",
  7: "Closed",
  8: "Rejected",
};

// ---------------------------------------------------------------------------
// Local helpers (duplicated from cron rather than importing — per
// [[feedback_qa_agent_modularization]] "prefer duplication over shared
// helpers" so the cron stays self-contained)
// ---------------------------------------------------------------------------

const MONTHS_LC = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function isoToCronDisplay(iso) {
  if (!iso || typeof iso !== "string") return "";
  const [y, m, d] = iso.split("-").map(Number);
  const mmm = MONTHS_LC[m - 1];
  if (!mmm || !Number.isFinite(d) || !Number.isFinite(y)) return iso;
  return `${String(d).padStart(2, "0")}-${mmm.charAt(0).toUpperCase()}${mmm.slice(1)}-${y}`;
}

function severityToRiskLevel(severity) {
  const max = Number.isFinite(Number(process.env.NOVADE_MAX_RISK_LEVEL))
    ? Number(process.env.NOVADE_MAX_RISK_LEVEL)
    : 1;
  const s = String(severity || "")
    .trim()
    .toUpperCase();
  if (s === "P1" || s === "P2" || s === "P3") return max;
  return 0;
}

function unitIdForLevelName(levelName, units) {
  if (!levelName || !Array.isArray(units)) return null;
  const target = String(levelName).trim().toLowerCase();
  const match = units.find(
    (u) =>
      String(u?.name || "")
        .trim()
        .toLowerCase() === target,
  );
  return match ? match.id || match.recid || match.unitid : null;
}

function extractImageUrl(rawValue) {
  if (!rawValue || typeof rawValue !== "string") return "";
  const trimmed = rawValue.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const m1 = trimmed.match(/image\s*\(\s*"([^"]+)"/i);
  if (m1?.[1]) return m1[1].trim();
  const m2 = trimmed.match(/image\s*\(\s*'([^']+)'/i);
  if (m2?.[1]) return m2[1].trim();
  return "";
}

function parseSenderName(raw) {
  if (!raw) return "";
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return parsed?.name || parsed?.senderName || parsed?.from || "";
  } catch (_) {
    return "";
  }
}

// Same one-shot Supabase-URL refresh wrapper the cron uses (lines 86–103) —
// covers the case where the sheet's signed image URL has expired.
async function uploadFileWithSupabaseRetry(mediaUrl, opts) {
  try {
    return await uploadFileFromUrl(mediaUrl, opts);
  } catch (firstErr) {
    let fresh;
    try {
      fresh = await refreshSignedUrl(mediaUrl);
    } catch (_) {
      throw firstErr;
    }
    if (!fresh || fresh === mediaUrl) throw firstErr;
    return uploadFileFromUrl(fresh, opts);
  }
}

function truncate(str, n) {
  const s = String(str || "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// ---------------------------------------------------------------------------
// Pre-flight payload validation — run BEFORE any create/close call to Novade.
// Novade actions CANNOT be deleted via API, so we must never create one we
// can't complete. Mirrors what Novade actually accepts:
//   - description + before-photo are required to create
//   - `date` / `confirmationdate` / `completiondate` / `closingdate` must be
//     real epoch-ms in a sane window (a junk/empty timestamp that defaulted to
//     ~now sets a wrong Novade date)
//   - the close lifecycle must be coherent: created ≤ closed (Novade rejects
//     confirmation-after-closing with a 400 — this is what killed S/N 1733)
// A row that fails is NOT sent to Novade; it's reported as a `validation`
// failure so the user fixes the sheet instead of getting a half-synced orphan.
// ---------------------------------------------------------------------------

const NOVADE_TS_MIN_MS = Date.UTC(2020, 0, 1); // anything older is junk
function validateRowForNovade(issue) {
  if (!issue || !String(issue.description || "").trim()) return { ok: false, reason: "missing description" };
  if (!issue.imageUrl) return { ok: false, reason: "missing before-photo (Novade requires an image)" };

  const tsMaxMs = Date.now() + 2 * 86400000; // +2d slack for clock skew
  const created = issue.createdTimestampMs;
  if (!Number.isFinite(created) || created < NOVADE_TS_MIN_MS || created > tsMaxMs) {
    return {
      ok: false,
      reason: `Created Timestamp invalid/out-of-range (raw=${created}) — would set a wrong Novade date. Fix the sheet's Created Timestamp.`,
    };
  }
  if (issue.status === "closed") {
    const closed = issue.updatedTimestampMs;
    if (!Number.isFinite(closed) || closed < NOVADE_TS_MIN_MS || closed > tsMaxMs) {
      return {
        ok: false,
        reason: `closed row but Updated Timestamp invalid (raw=${closed}) — no valid close date. Fix the sheet's Updated Timestamp.`,
      };
    }
    if (closed < created) {
      return {
        ok: false,
        reason: `close lifecycle backwards — Updated (${new Date(closed).toISOString().slice(0, 16)}) is before Created (${new Date(created).toISOString().slice(0, 16)}); Novade rejects this. Fix the timestamps.`,
      };
    }
  }
  return { ok: true, reason: "" };
}

// ---------------------------------------------------------------------------
// Pre-flight: env vars + spreadsheet + time window
// ---------------------------------------------------------------------------

function resolveSpreadsheetId(groupConfig) {
  return groupConfig?.safetySpreadsheetId || groupConfig?.spreadsheetId || process.env.SAFETY_SPREADSHEET_ID;
}

function preflight(intent, groupConfig) {
  const spreadsheetId = resolveSpreadsheetId(groupConfig);
  if (!spreadsheetId) {
    return { ok: false, error: "Novade sync: SAFETY_SPREADSHEET_ID not configured for this group." };
  }
  if (!process.env.NOVADE_EMAIL || !process.env.NOVADE_PASSWORD) {
    return { ok: false, error: "Novade sync: NOVADE_EMAIL / NOVADE_PASSWORD env vars not set." };
  }
  const tw = intent?.time_window;
  if (!tw?.start_iso || !tw?.end_iso) {
    return { ok: false, error: "Novade sync: couldn't resolve the date window from your question." };
  }
  return { ok: true, spreadsheetId, startIso: tw.start_iso, endIso: tw.end_iso, label: tw.label || "" };
}

// ---------------------------------------------------------------------------
// Strict-window row fetch (the ONLY place we read Safety rows for sync ops)
//
// Uses runSQLQuery — same pipeline as analytical safety and safety_summary —
// so date filtering is uniform across QA features. Pulls every column we
// might need for sync OR status replies.
// ---------------------------------------------------------------------------

async function fetchRowsInWindow({ startIso, endIso, groupConfig, extraFilters = [] }) {
  const where = [];
  where.push(startIso === endIso ? `[Date] = '${startIso}'` : `[Date] >= '${startIso}' AND [Date] <= '${endIso}'`);
  for (const f of extraFilters) {
    if (!f?.field) continue;
    const fld = `[${f.field}]`;
    const escape = (v) => String(v ?? "").replace(/'/g, "''");
    // Always coerce the column to string before comparing — Status/Severity are
    // already normalised on the sheet (UPPER for severity, lower for status)
    // and S/N is numeric. AlaSQL chokes on `UPPER(CAST(...)) IN (UPPER(...),
    // UPPER(...))` (the multi-value IN form silently returns 0 rows) so we use
    // CAST without UPPER for the IN case; the literal data on the sheet is
    // case-normalised so this loses nothing in practice.
    switch (f.op) {
      case "=":
        where.push(`UPPER(CAST(${fld} AS STRING)) = UPPER('${escape(f.value)}')`);
        break;
      case "!=":
        where.push(`UPPER(CAST(${fld} AS STRING)) != UPPER('${escape(f.value)}')`);
        break;
      case "in":
        if (Array.isArray(f.values) && f.values.length) {
          where.push(`CAST(${fld} AS STRING) IN (${f.values.map((v) => `'${escape(v)}'`).join(", ")})`);
        }
        break;
      case "like":
        where.push(`UPPER(CAST(${fld} AS STRING)) LIKE UPPER('%${escape(f.value)}%')`);
        break;
    }
  }
  // SELECT every column we need across all three sub-actions (sync needs
  // mediaUrl + sender + timestamps; status_novade needs novade id + status;
  // status_sheet just needs counts but we read the same columns for free).
  // __SourceSheet__ + RowNumber come from the multi-tab safety merge (utils/action.js): each row
  // knows which monthly tab it lives in and its 1-based row there — so the Novade Action Id
  // writeback can target the correct (possibly archived) tab/row for historical issues.
  const cols =
    "[S/N], [Date], [Description], [Category], [Location], [Severity], [Status], [Image], [Image After Rectification], [Sender], [Updated By], [Created Timestamp], [Updated Timestamp], [Novade Action Id], [__SourceSheet__], [RowNumber]";
  const sql = `SELECT ${cols} FROM safetyData WHERE ${where.join(" AND ")} ORDER BY [Date] ASC, [S/N] ASC`;
  const raw = (await runSQLQuery(sql, "safety", { groupConfig })) || [];
  return raw.map((r) => ({
    sn: r["S/N"],
    date: String(r.Date || "").trim(),
    sourceSheet: String(r.__SourceSheet__ || "").trim() || SAFETY_SHEET_NAME,
    liveRowNumber: Number(r.RowNumber) || null,
    description: String(r.Description || "").trim(),
    category: String(r.Category || "").trim(),
    location: String(r.Location || "").trim(),
    severity: String(r.Severity || "")
      .trim()
      .toUpperCase(),
    status: String(r.Status || "")
      .trim()
      .toLowerCase(),
    imageUrl: extractImageUrl(r.Image),
    imageAfterUrl: extractImageUrl(r["Image After Rectification"]),
    senderName: parseSenderName(r.Sender),
    updatedByName: parseSenderName(r["Updated By"]),
    createdTimestampMs: parseTimestampToMs(r["Created Timestamp"]),
    updatedTimestampMs: parseTimestampToMs(r["Updated Timestamp"]),
    novadeId: String(r["Novade Action Id"] || "").trim(),
  }));
}

// ---------------------------------------------------------------------------
// Resolve (and auto-create if absent) the `Novade Action Id` column index on a SPECIFIC tab —
// the current "Safety" tab OR a monthly archive ("Safety-MMM YYYY"). Returns the 0-based col
// index. Used so the writeback lands the action id on the issue's own monthly tab. Read at
// PREVIEW build time (live reads allowed there); approve uses only the stored coordinate.
async function resolveNovadeIdColForTab(spreadsheetId, tab) {
  const sheetData = await readGoogleSheet(spreadsheetId, tab);
  const headers = (sheetData && sheetData[0]) || [];
  const norm = (h) =>
    String(h || "")
      .trim()
      .toLowerCase();
  const target = norm(NOVADE_ACTION_ID_HEADER);
  let idx = headers.findIndex((h) => norm(h) === target);
  if (idx === -1) {
    idx = headers.length;
    await batchUpdateCells(spreadsheetId, tab, [{ row: 1, col: idx, value: NOVADE_ACTION_ID_HEADER }]);
  }
  return idx;
}

// ---------------------------------------------------------------------------
// Resolve Novade metadata (projectId, unitId, companies, actors, units,
// issueTypes, afterRectFolderId, defaultActor). Pure resolver; no writes.
// Cached internally by utils/novade-api.js.
// ---------------------------------------------------------------------------

// Resolve the project's MAIN CONTRACTOR id from the live Novade companies list.
// PROVEN NECESSARY (2026-05-29): Novade's status-1→2 (WIP) transition ALWAYS
// requires a contractorid for this project — the NCR-fields patch does NOT
// satisfy it (verified by replaying the cron's exact create→patch→close with
// no env var → 400 "contractorid is/are required"). The real Lambda has NO
// NOVADE_DEFAULT_CONTRACTOR_ID and the PIC→company map is empty, so the ONLY
// reliable source is Novade itself. Novade marks each company with `type`
// (0 = main contractor, 1 = subcontractor) and a pipe-delimited `projectids`.
// We take the first type-0 company on this project (e.g. "Woh Hup Pte Ltd" for
// MBS-IR2), falling back to any company on the project. NO env, NO hardcode.
function resolveProjectMainContractorId(projectId, companies) {
  if (!projectId || !Array.isArray(companies)) return null;
  const onProject = companies.filter((c) =>
    String(c?.projectids || "")
      .split("|")
      .filter(Boolean)
      .includes(projectId),
  );
  const mainCon = onProject.find((c) => Number(c?.type) === 0);
  return (mainCon || onProject[0])?.id || null;
}

async function resolveNovadeMetadata() {
  const projectName = process.env.NOVADE_PROJECT_NAME || DEFAULT_PROJECT_NAME;
  const projectId = await resolveProjectIdByName(projectName);
  if (!projectId) throw new Error(`Novade project "${projectName}" not found.`);
  const unitId = await resolveUnitIdForProject(projectId);
  if (!unitId) throw new Error(`Novade unit not resolved for project ${projectId}.`);
  const defaultActor = process.env.NOVADE_DEFAULT_ACTOR || "WL API";

  let novadeCompanies = [];
  try {
    novadeCompanies = await listCompanies();
  } catch (_) {}
  let novadeActors = [];
  try {
    novadeActors = await listNovadeActorsFromHistory({ projectId });
  } catch (_) {}
  const hardcodedAssignees = getKnownAssigneesForProject(projectId);
  if (hardcodedAssignees.length) {
    const seen = new Set(novadeActors.map((a) => String(a).toLowerCase()));
    for (const name of hardcodedAssignees) {
      if (!seen.has(String(name).toLowerCase())) novadeActors.push(name);
    }
  }
  let units = [];
  try {
    units = await listUnitsForProjectCached(projectId);
  } catch (_) {}
  let issueTypes = [];
  try {
    issueTypes = await listSafetyIssueTypesCached();
  } catch (_) {}
  let afterRectFolderId = process.env.NOVADE_AFTER_RECTIFICATION_FOLDER_ID;
  if (!afterRectFolderId) {
    try {
      const project = await getProjectById(projectId);
      const opts = project?.options ? JSON.parse(project.options) : {};
      if (opts?.projNCRAfterFolderId) afterRectFolderId = opts.projNCRAfterFolderId;
    } catch (_) {}
  }
  // API-derived default contractor (project main contractor) — used when the
  // reporter doesn't map to a specific subcon. This is the contractorid source
  // for the Novade close (status-2 requires it); NO env, NO hardcode.
  const defaultContractorId = resolveProjectMainContractorId(projectId, novadeCompanies);

  return {
    projectId,
    unitId,
    defaultActor,
    defaultContractorId,
    novadeCompanies,
    novadeActors,
    units,
    issueTypes,
    afterRectFolderId,
  };
}

// ---------------------------------------------------------------------------
// Novade write pipeline — mirrors cron processSheet's create + close branches
// but operates on a CALLER-PROVIDED, pre-filtered set of rows (no internal
// time-window filter, no idempotency filter — the caller's job).
//
// Used in step 2 (approval). The caller passes the rows from the preview tab
// (re-checked against the live sheet for last-second idempotency). Writeback
// target is the LIVE Safety sheet (not the preview tab).
// ---------------------------------------------------------------------------

async function runNovadeSyncOnRows({ rows, groupConfig, novadeIdCol0Based }) {
  // Start the time budget at the VERY TOP so it bounds the whole invocation —
  // metadata resolution + LLM classification (several seconds) count against it
  // too, not just the per-row loop. (See the TIME-BUDGET GUARD below.)
  const runStartMs = Date.now();
  const spreadsheetId = resolveSpreadsheetId(groupConfig);
  if (!rows.length) {
    return { created: [], closedInRun: [], failures: [] };
  }
  if (!Number.isFinite(novadeIdCol0Based) || novadeIdCol0Based < 0) {
    throw new Error(
      "runNovadeSyncOnRows: novadeIdCol0Based not provided — preview tab missing NOVADE COL metadata. Cannot write back without a live-sheet read (strict rule: no live reads at approve time).",
    );
  }

  const {
    projectId,
    unitId,
    defaultActor,
    defaultContractorId,
    novadeCompanies,
    novadeActors,
    units,
    issueTypes,
    afterRectFolderId,
  } = await resolveNovadeMetadata();

  // LLM classification — same call the cron uses (level / type / NCR fields).
  const classifications = await classifyIssuesForNovade(
    rows.map((i) => ({
      rowNumber: i.sn,
      description: i.description,
      location: i.location,
      category: i.category,
      severity: i.severity,
      status: i.status,
    })),
    units,
    issueTypes,
  );

  // Writeback target derived from preview tab metadata — NO live-sheet read.
  const novadeIdIdx = novadeIdCol0Based;

  // Walk per-batch, write back after each batch (matches cron line 556–569).
  const created = []; // { sn, novadeId, severity, description, status }
  const closed = []; // sn list (subset of created — closed in same run)
  const failures = []; // { sn, kind, error }
  const toCreate = rows; // alias for clarity; the existing loop uses `toCreate`

  // TIME-BUDGET GUARD. The Lambda hard-stops at 15 min; a per-row pipeline is
  // ~3-12s (closed). The budget is checked PER ROW (not per batch) so we can
  // never overrun by a whole batch (~80-200s for 5 closed rows) and get killed
  // mid-create — which would orphan a created action (id not written back) and
  // duplicate on retry. Once the budget (default 13 min, ~2 min headroom) is
  // used, we stop starting new rows, write back what's done, and report the
  // remainder as deferred — the user re-issues and the next run picks them up.
  // runStartMs is set at the top of the function (includes metadata+classify).
  const TIME_BUDGET_MS =
    Number(process.env.NOVADE_SYNC_TIME_BUDGET_MS) > 0
      ? Number(process.env.NOVADE_SYNC_TIME_BUDGET_MS)
      : 13 * 60 * 1000;
  let deferredForTime = 0;
  let processedRows = 0; // rows we entered the pipeline for (created or validation-rejected)
  let timeUp = false;

  for (let i = 0; i < toCreate.length && !timeUp; i += DEFAULT_BATCH_SIZE) {
    const batch = toCreate.slice(i, i + DEFAULT_BATCH_SIZE);
    for (const issue of batch) {
      // Per-row budget check — before starting ANY work on this row.
      if (Date.now() - runStartMs > TIME_BUDGET_MS) {
        timeUp = true;
        break;
      }
      processedRows++;
      // PRE-FLIGHT VALIDATION — refuse to create anything Novade can't accept
      // or we can't close. No create call happens for an invalid row, so no
      // un-deletable orphan is ever produced.
      const valid = validateRowForNovade(issue);
      if (!valid.ok) {
        console.warn(
          `[NovadeSync(QA)] S/N ${issue.sn} FAILED pre-flight validation: ${valid.reason} — NOT created in Novade.`,
        );
        failures.push({ sn: issue.sn, kind: "validation", error: valid.reason });
        continue;
      }
      try {
        // Contractor: the reporter's mapped subcon if known, else the project's
        // main contractor (resolved from the live Novade API). Novade's 1→2
        // (WIP) transition REQUIRES a contractorid (proven — the NCR patch does
        // NOT satisfy it), and the Lambda has no env default, so the API maincon
        // is the real source.
        const contractorId = resolvePICToContractorId(issue.senderName, novadeCompanies) || defaultContractorId;
        // A CLOSED row must reach Novade status 7. If we still have NO contractor
        // (project has zero companies in Novade — should never happen), the close
        // would 400, so reject up front rather than create an un-closeable orphan
        // (Novade actions can't be deleted).
        if (issue.status === "closed" && !contractorId) {
          console.warn(
            `[NovadeSync(QA)] S/N ${issue.sn}: closed row but no Novade contractor resolvable (no sender match + no project main contractor) — NOT created (close would 400).`,
          );
          failures.push({
            sn: issue.sn,
            kind: "validation",
            error: `closed row but no Novade contractor could be resolved (sender "${issue.senderName}" unmapped + project has no main contractor) — the close (status→2 WIP) requires one.`,
          });
          continue;
        }
        const lodgedBy = resolveNovadeActor(issue.senderName, novadeActors) || defaultActor;
        const cls = classifications.get(issue.sn);
        const resolvedUnitId = (cls?.level ? unitIdForLevelName(cls.level, units) : null) || unitId;
        const resolvedLocation = cls?.residualLocation || issue.location;
        const resolvedType = cls?.issueType || issue.category || "Others. Please explain in description.";
        const riskLevel = severityToRiskLevel(issue.severity);

        const payload = {
          projectid: projectId,
          unitid: resolvedUnitId,
          description: issue.description,
          location: resolvedLocation,
          lodgedby: lodgedBy,
          type: resolvedType,
          date: issue.createdTimestampMs,
          status: 1,
          risklevel: riskLevel,
          ...(contractorId ? { contractorid: contractorId } : {}),
          ...(process.env.NOVADE_DEFAULT_CCIDS ? { ccids: process.env.NOVADE_DEFAULT_CCIDS } : {}),
        };

        const createResp = await createSafetyAction(payload);
        const recId = extractNovadeRecId(createResp);
        if (!recId) throw new Error("could not extract Novade Action Id from create response");

        // EAGER WRITEBACK — persist the id the INSTANT the action exists, BEFORE
        // the slow patch/close/upload (the close-walk alone is 3 PATCHes and can
        // run minutes if Novade is slow). If the Lambda is SIGTERM-killed during
        // that work, the id is already on the sheet → a re-issued sync skips this
        // row → NO duplicate (the action exists, possibly unclosed = drift caught
        // by status_novade — far better than an undeletable duplicate). Retries
        // 3× (transient Sheets errors); on permanent failure, surfaces the
        // orphaned S/N→id so it can be recorded by hand.
        if (issue.liveRowNumber) {
          // Write the Novade Action Id back to the issue's OWN monthly tab (current OR archive) and
          // its per-tab Novade column. Use the row's OWN column; only fall back to the run-level
          // column when the row is on the live "Safety" tab (where that column was resolved) — NEVER
          // guess a column for an archive tab (a wrong-column write would silently corrupt the
          // archive). The approve guard (allRowsHaveNovadeCol) normally guarantees a per-row column.
          const wbSheet = issue.sourceSheet || SAFETY_SHEET_NAME;
          const wbCol =
            Number.isFinite(issue.novadeIdCol0Based) && issue.novadeIdCol0Based >= 0
              ? issue.novadeIdCol0Based
              : wbSheet === SAFETY_SHEET_NAME
                ? novadeIdIdx
                : -1;
          if (!Number.isFinite(wbCol) || wbCol < 0) {
            console.error(
              `[NovadeSync(QA)] no Novade Action Id column for S/N ${issue.sn} on "${wbSheet}" — NOT writing back (would corrupt the archive)`,
            );
            failures.push({
              sn: issue.sn,
              kind: "writeback",
              error: `created action but no Novade Action Id column resolved for "${wbSheet}" — record manually to avoid a duplicate: ${issue.sn}→${recId}`,
            });
          } else {
            let wbErr = null;
            for (let attempt = 1; attempt <= 3; attempt++) {
              try {
                await batchUpdateCells(spreadsheetId, wbSheet, [
                  { row: issue.liveRowNumber, col: wbCol, value: recId },
                ]);
                wbErr = null;
                break;
              } catch (e) {
                wbErr = e;
                console.error(
                  `[NovadeSync(QA)] eager writeback attempt ${attempt}/3 failed for S/N ${issue.sn}: ${e?.message || e}`,
                );
                if (attempt < 3) await new Promise((res) => setTimeout(res, 500 * attempt));
              }
            }
            if (wbErr) {
              console.error(
                `[NovadeSync(QA)] EAGER WRITEBACK GAVE UP — orphaned (created, id not on sheet): ${issue.sn}→${recId}`,
              );
              failures.push({
                sn: issue.sn,
                kind: "writeback",
                error: `created action but its Novade Action Id could not be written to the sheet after 3 tries (${wbErr?.message || wbErr}) — record manually to avoid a duplicate: ${issue.sn}→${recId}`,
              });
            }
          }
        }

        try {
          await patchSafetyAction(recId, {
            roottype: cls?.roottype || "Unsafe Conditions",
            rootcause: cls?.rootcause || "Absence of Safety Means",
            subtype: cls?.subtype || "Unsafe Condition",
          });
        } catch (e) {
          console.warn(`[NovadeSync(QA)] patch failed for ${recId}: ${e?.message || e}`);
        }

        if (issue.imageUrl) {
          try {
            await uploadFileWithSupabaseRetry(issue.imageUrl, {
              description: issue.description,
              linkedTable: LINKED_TABLE,
              linkedRecId: recId,
            });
          } catch (e) {
            console.warn(`[NovadeSync(QA)] before-photo failed for ${recId}: ${e?.message || e}`);
          }
        }

        // Close-walk if the sheet row is already closed (same-run close —
        // matches cron lines 522–541). Resolves actor, walks 1→2→5→7,
        // uploads after-photo. Failures here are non-fatal (action exists
        // on Novade with id, status will be 1, the cron will close it later).
        let closedOk = false;
        if (issue.status === "closed") {
          try {
            const resolvedCloser = resolveNovadeActor(issue.updatedByName, novadeActors) || undefined;
            // Lifecycle dates must be coherent: confirmation ≤ completion ≤
            // closing. If the row's Created Timestamp didn't survive into the
            // sync (createdTimestampMs missing/empty → defaulted to ~now) it
            // can land AFTER the close time, and Novade rejects a backwards
            // lifecycle with a 400. Clamp createdMs down to closedMs in that
            // case (and log it so the data bug is visible).
            const closedMs = Number.isFinite(issue.updatedTimestampMs)
              ? issue.updatedTimestampMs
              : issue.createdTimestampMs;
            let createdMs = issue.createdTimestampMs;
            if (!Number.isFinite(createdMs) || (Number.isFinite(closedMs) && createdMs > closedMs)) {
              console.warn(
                `[NovadeSync(QA)] S/N ${issue.sn}: createdTimestampMs (${createdMs}) invalid or after closedMs (${closedMs}); clamping to closedMs. ` +
                  `Likely the Created Timestamp didn't survive the preview round-trip.`,
              );
              createdMs = Number.isFinite(closedMs) ? closedMs : createdMs;
            }
            await closeSafetyAction(recId, {
              createdTimestampMs: createdMs,
              closedTimestampMs: closedMs,
              actionType: resolvedType,
              confirmedBy: resolvedCloser,
              completedBy: resolvedCloser,
              closedBy: resolvedCloser,
              // Novade's 1→2 (WIP) transition REQUIRES a contractorid. Pass the
              // SAME contractor resolved for the create (the close-walk's status-2
              // patch must carry it explicitly — it's not inherited from the
              // create). Falls back to NOVADE_DEFAULT_CONTRACTOR_ID inside
              // closeSafetyAction if null (and the pre-create guard above already
              // rejected closed rows that have neither).
              contractorId,
              rootType: cls?.roottype,
              rootCause: cls?.rootcause,
              subType: cls?.subtype,
            });
            closed.push(issue.sn);
            closedOk = true;
            if (issue.imageAfterUrl) {
              try {
                await uploadFileWithSupabaseRetry(issue.imageAfterUrl, {
                  description: "After rectification",
                  linkedTable: LINKED_TABLE,
                  linkedRecId: recId,
                  ...(afterRectFolderId ? { folderId: afterRectFolderId } : {}),
                });
              } catch (e) {
                console.warn(`[NovadeSync(QA)] after-photo failed for ${recId}: ${e?.message || e}`);
              }
            }
          } catch (e) {
            // Surface the Novade response body (not just "status code 400") so
            // CloudWatch shows WHY the close failed. Mirrors the create catch.
            const body = e?.response?.data ? JSON.stringify(e.response.data) : "";
            console.error(
              `[NovadeSync(QA)] close FAILED for S/N ${issue.sn} (action ${recId}): ${e?.message || e}` +
                (body ? ` — Novade response: ${body}` : ""),
            );
            failures.push({ sn: issue.sn, kind: "close", error: body || e?.message || String(e) });
          }
        }

        // VERIFY before declaring success. Re-fetch the action from Novade and
        // confirm it actually reached the expected TERMINAL status — open row
        // → 1, closed row → 7. We never tell the user "synced" (and never count
        // it as synced) for a row we haven't confirmed in Novade. This is the
        // guard that was missing when S/N 1733 reported "complete" while its
        // close had 400'd and the action sat open.
        const expectedStatus = issue.status === "closed" ? 7 : 1;
        let verifiedStatus = null;
        try {
          const check = await getSafetyActionById(recId);
          const a = check?.data?.data || check?.data || check;
          verifiedStatus = Number(a?.status);
        } catch (e) {
          console.warn(`[NovadeSync(QA)] verify GET failed for ${recId}: ${e?.message || e}`);
        }
        const verifiedOk = verifiedStatus === expectedStatus;
        if (!verifiedOk) {
          console.error(
            `[NovadeSync(QA)] VERIFY FAILED S/N ${issue.sn} (action ${recId}): expected status ${expectedStatus}, ` +
              `Novade reports ${verifiedStatus ?? "unknown"}. Action created but NOT reported as synced.`,
          );
          failures.push({
            sn: issue.sn,
            kind: "verify",
            error: `created action ${recId} is at Novade status ${verifiedStatus ?? "unknown"}, expected ${expectedStatus} (${issue.status === "closed" ? "close did not take" : "not open"}). Needs manual close in Novade.`,
          });
        }

        created.push({
          sn: issue.sn,
          novadeId: recId,
          severity: issue.severity,
          description: issue.description,
          status: issue.status,
          closedOk,
          verifiedStatus,
          verifiedOk,
        });
        // (Novade Action Id was already written to the sheet EAGERLY, right
        // after create above — no per-batch writeback needed.)
      } catch (error) {
        failures.push({
          sn: issue.sn,
          kind: "create",
          error: error?.response?.data ? JSON.stringify(error.response.data) : error?.message || String(error),
        });
      }
    }
  }

  if (timeUp) {
    deferredForTime = toCreate.length - processedRows;
    console.warn(
      `[NovadeSync(QA)] time budget (${Math.round(TIME_BUDGET_MS / 60000)}min) reached after ${processedRows} row(s) — deferring ${deferredForTime} to the next run.`,
    );
  }

  return { created, closedInRun: closed, failures, deferredForTime };
}

// ---------------------------------------------------------------------------
// Preview step — build the persistent preview tab + screenshot + caption.
//
// Reuses captureSafetyImage with overrides so we share the entire PDF→PNG→
// Supabase upload pipeline (and the title-row "captured <time>" stamp) with
// the safety_image bypass. The `keepTab` flag prevents captureSafetyImage's
// finally{deleteSheet} so the tab survives until the user approves/cancels.
// ---------------------------------------------------------------------------

function generatePreviewTabName() {
  // SGT date+time so users browsing tabs see a consistent timestamp regardless
  // of where the Lambda is running. 6-char hex suffix prevents collision when
  // two users in the same chat ask within the same minute.
  const sgtParts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (t) => sgtParts.find((p) => p.type === t)?.value || "00";
  const yyyymmdd = `${get("year")}${get("month")}${get("day")}`;
  const hhmm = `${get("hour")}${get("minute")}`;
  const suffix = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `${PREVIEW_TAB_PREFIX}${yyyymmdd}-${hhmm}-${suffix}`;
}

async function performPreview({ startIso, endIso, label, groupConfig, extraFilters, orderBy, limit }) {
  const spreadsheetId = resolveSpreadsheetId(groupConfig);
  const rows = await fetchRowsInWindow({ startIso, endIso, groupConfig, extraFilters });

  // Idempotency — skip rows already on Novade. The eligibility rules are
  // IDENTICAL to the prior immediate-sync code path: needs description AND
  // photo (Novade requires the before-photo; rows without one are skipped by
  // the cron too — see usecases/safety_novade_sync/index.js lines 395–402).
  const alreadySynced = rows.filter((r) => r.novadeId);
  let toCreate = rows.filter((r) => !r.novadeId && r.description && r.imageUrl);
  const skippedNoImage = rows.filter((r) => !r.novadeId && r.description && !r.imageUrl);
  const skippedNoDescription = rows.filter((r) => !r.novadeId && !r.description);

  // Pre-flight validation at PREVIEW time too — so the user never approves a
  // row that Novade would reject (bad/backwards timestamps). Same validator
  // used as the hard guard before create. Invalid rows are excluded from the
  // preview and reported so the user can fix the sheet.
  const invalidRows = toCreate.filter((r) => !validateRowForNovade(r).ok);
  if (invalidRows.length) {
    for (const r of invalidRows) {
      console.warn(`[NovadeSync(QA)] S/N ${r.sn} excluded from preview: ${validateRowForNovade(r).reason}`);
    }
    toCreate = toCreate.filter((r) => validateRowForNovade(r).ok);
  }
  const skippedInvalid = invalidRows.map((r) => ({ sn: r.sn, reason: validateRowForNovade(r).reason }));

  // Respect intent.order_by + intent.limit ("the latest GO to novade",
  // "sync the top 3 P1 issues this week", etc.). When orderBy is set the
  // parser asked us to sort + slice; without it, sync everything matching the
  // window+filters. Default sort field maps the human label "Created Timestamp"
  // (parser-canonical) to our internal `createdTimestampMs`.
  if (orderBy?.field) {
    const dir = orderBy.dir === "asc" ? 1 : -1;
    const fieldMap = {
      "Created Timestamp": "createdTimestampMs",
      "Updated Timestamp": "updatedTimestampMs",
      "S/N": "sn",
      Date: "date",
    };
    const key = fieldMap[orderBy.field] || "createdTimestampMs";
    toCreate.sort((a, b) => {
      const av = a[key] ?? 0;
      const bv = b[key] ?? 0;
      if (av === bv) return 0;
      return av < bv ? -dir : dir;
    });
  }
  if (Number.isFinite(Number(limit)) && Number(limit) > 0) {
    toCreate = toCreate.slice(0, Number(limit));
  }

  // BATCH CAP. Each closed issue is ~8 Novade API calls; a whole month can be
  // hundreds of issues — far past the 15-min Lambda ceiling. So a single run
  // syncs at most NOVADE_SYNC_MAX_BATCH (default 100) eligible rows, oldest
  // first (toCreate is already Date↑/S/N↑ ordered). Anything beyond is synced
  // on the NEXT run: the user re-issues the SAME request and the idempotency
  // filter (rows that now carry a Novade Action Id are excluded above) auto-
  // pages to the next batch. eligibleTotal is the pre-cap count, surfaced so
  // the messages can say "first 100 of 700" + how many remain.
  const eligibleTotal = toCreate.length;
  const MAX_BATCH = Number(process.env.NOVADE_SYNC_MAX_BATCH) > 0 ? Number(process.env.NOVADE_SYNC_MAX_BATCH) : 100;
  const batchCapped = eligibleTotal > MAX_BATCH;
  if (batchCapped) toCreate = toCreate.slice(0, MAX_BATCH);

  if (!toCreate.length) {
    return {
      kind: "preview_empty",
      startIso,
      endIso,
      totalInWindow: rows.length,
      alreadySynced: alreadySynced.length,
      skippedNoImage: skippedNoImage.length,
      skippedNoDescription: skippedNoDescription.length,
      skippedInvalid,
    };
  }

  // Build a persistent preview tab with EXACTLY the toCreate S/Ns. Reuse the
  // safety_image pipeline (createNewSheet + writeArrayToGSheet + format +
  // exportSheetAsPdf + PDF→PNG + Supabase upload) via captureSafetyImage's
  // `keepTab` + `tabNameOverride` + `titlePrefixOverride` options.
  const previewTabName = generatePreviewTabName();
  const dateWindow =
    startIso === endIso
      ? { kind: "single", start_iso: startIso, end_iso: endIso, label: isoToCronDisplay(startIso) }
      : {
          kind: "range",
          start_iso: startIso,
          end_iso: endIso,
          label: label || `${isoToCronDisplay(startIso)} to ${isoToCronDisplay(endIso)}`,
        };
  const snFilter = { field: "S/N", op: "in", value: null, values: toCreate.map((r) => String(r.sn)) };

  const previewTitlePrefix = `Novade Sync Preview · ${toCreate.length} pending · ${dateWindow.label}`;
  const snap = await captureSafetyImage({
    groupConfig,
    dateWindow,
    filters: [snFilter, ...extraFilters],
    tabNameOverride: previewTabName,
    titlePrefixOverride: previewTitlePrefix,
    keepTab: true,
    // Build + keep the persistent preview tab (its DATA is the approve-time
    // source of truth), but DON'T export it as one giant PDF. At the batch cap
    // (~100 photo rows) that PDF is ~83 MB / 10 pages and the PDF→PNG converter
    // times out at 60s/page (prod 2026-06-05). The WhatsApp preview images are
    // rendered below in small chunks instead.
    skipImageExport: true,
  });

  // Rows are shown chronologically (Date↑, S/N↑) in BOTH the persistent tab and
  // the screenshot — independent of any order_by used to SELECT the batch. Built
  // once here so the tab augmentation and the chunked image render agree.
  const orderedForTab = [...toCreate].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return (Number(a.sn) || 0) - (Number(b.sn) || 0);
  });

  // STRICT-PREVIEW augmentation. captureSafetyImage writes 13 visible columns
  // (S/N … UPDATED AT). The screenshot stops at col 12 so the augmented cols
  // 13-16 stay invisible to the user. We append:
  //   col 13 CREATED TS  — Novade action's `date` + confirmation date
  //   col 14 LIVE ROW    — live Safety sheet's 1-based row index per S/N
  //                       (so writeback knows where to put Novade Action Id
  //                       without ANY live-sheet read at approve time)
  //   col 15 NOVADE COL  — live Safety sheet's 1-based column index of
  //                       `Novade Action Id` header (same value per row;
  //                       read from row 3 at approve time)
  //   col 16 UPDATED TS  — Novade completion/closing date for closed rows.
  //                       MUST come from fetchRowsInWindow's parseTimestampToMs
  //                       (SGT-aware, +0800) — NOT the canonical UPDATED AT cell
  //                       (col 12), whose Excel-serial round-trip drops the SGT
  //                       offset and lands the close 8h off (diverging from the
  //                       cron, which uses parseTimestampToMs). Created TS (col
  //                       13) already uses this path; Updated TS must match.
  // The pre-resolve also auto-creates the Novade Action Id header on the live
  // sheet if absent (one-time setup; permitted under rule 1 because it's the
  // Novade Action Id column itself).
  // Pre-resolve the Novade Action Id column PER SOURCE TAB (current month + any monthly archive
  // a historical issue lives in). Each issue already carries its source tab + 1-based live row
  // from the multi-tab safety merge, so LIVE ROW is per-tab and the writeback targets the issue's
  // own tab — no live read at approve time.
  const novadeColByTab = new Map(); // tab → 0-based col index
  for (const r of toCreate) {
    const tab = r.sourceSheet || SAFETY_SHEET_NAME;
    if (novadeColByTab.has(tab)) continue;
    try {
      novadeColByTab.set(tab, await resolveNovadeIdColForTab(spreadsheetId, tab));
    } catch (e) {
      console.error(`[NovadeSync(QA)] failed to resolve Novade Action Id col on "${tab}": ${e?.message || e}`);
      novadeColByTab.set(tab, -1);
    }
  }
  try {
    const headerExtras = [
      { row: 2, col: 13, value: "CREATED TS" },
      { row: 2, col: 14, value: "LIVE ROW" },
      { row: 2, col: 15, value: "NOVADE COL" },
      { row: 2, col: 16, value: "UPDATED TS" },
      { row: 2, col: 17, value: "BATCH TOTAL" },
      { row: 2, col: 18, value: "LIVE SHEET" },
    ];
    const rowExtras = [];
    for (let i = 0; i < orderedForTab.length; i++) {
      const r = orderedForTab[i];
      const rowNumber = i + 3; // 1-based; row 1=title, row 2=header
      const tab = r.sourceSheet || SAFETY_SHEET_NAME;
      const novadeCol0 = novadeColByTab.has(tab) ? novadeColByTab.get(tab) : -1;
      rowExtras.push({ row: rowNumber, col: 13, value: r.createdTimestampMs || "" });
      rowExtras.push({ row: rowNumber, col: 14, value: r.liveRowNumber || "" }); // per-tab 1-based live row
      rowExtras.push({ row: rowNumber, col: 15, value: novadeCol0 >= 0 ? novadeCol0 + 1 : "" }); // per-tab Novade col (1-based)
      // Only carry a real Updated Timestamp (closed rows). Open rows have no
      // [Updated Timestamp] → parseTimestampToMs returned ~now; storing that
      // would be misleading, and closedMs isn't used for open rows anyway.
      rowExtras.push({ row: rowNumber, col: 16, value: r.status === "closed" ? r.updatedTimestampMs || "" : "" });
      // Total eligible (pre-cap) for THIS window — so the approve reply can say
      // "synced N, M still unsynced — run the same request again" without a
      // live-sheet read.
      rowExtras.push({ row: rowNumber, col: 17, value: eligibleTotal });
      rowExtras.push({ row: rowNumber, col: 18, value: tab }); // source tab for the writeback
    }
    await batchUpdateCells(spreadsheetId, previewTabName, [...headerExtras, ...rowExtras]);
  } catch (e) {
    // Augmentation failure leaves the preview tab without metadata. The
    // confirmation handler will detect missing LIVE ROW + abort the writeback
    // rather than guessing (no live reads allowed at approve time).
    console.error(`[NovadeSync(QA)] preview-tab augmentation failed for "${previewTabName}": ${e?.message || e}`);
  }

  // Render the WhatsApp preview images by CHUNKING the rows into small PDFs
  // (each ≈ CHUNK_ROWS rows, a few MB, converts well under the 60s/page
  // timeout) — the same proven path the QA safety-list-image flow uses. This
  // replaces the single monolithic captureSafetyImage export that timed out at
  // the 100-row batch cap (prod 2026-06-05: ~83 MB / 10-page PDF). Failure here
  // is non-fatal: the persistent preview tab is already built; handleNovadeSync
  // surfaces a "screenshot failed" message + cleans the tab up if no images come
  // back. S/Ns are passed in the SAME chronological order as the tab rows.
  try {
    const rendered = await renderSafetyListPhotoImages({
      sns: orderedForTab.map((r) => String(r.sn)),
      dateWindow,
      groupConfig,
      titlePrefix: previewTitlePrefix,
    });
    snap.imageUrls = (rendered && rendered.imageUrls) || [];
  } catch (e) {
    console.error(`[NovadeSync(QA)] chunked preview image render failed: ${e?.message || e}`);
    snap.imageUrls = [];
  }

  return {
    kind: "preview_ready",
    startIso,
    endIso,
    previewTabName,
    toCreateCount: toCreate.length,
    eligibleTotal,
    batchCapped,
    maxBatch: MAX_BATCH,
    alreadySynced: alreadySynced.length,
    skippedNoImage: skippedNoImage.length,
    skippedNoDescription: skippedNoDescription.length,
    skippedInvalid,
    snap,
  };
}

// ---------------------------------------------------------------------------
// Status sub-actions
// ---------------------------------------------------------------------------

async function performStatusSheet({ startIso, endIso, groupConfig, extraFilters }) {
  const rows = await fetchRowsInWindow({ startIso, endIso, groupConfig, extraFilters });
  const synced = rows.filter((r) => r.novadeId);
  const unsynced = rows.filter((r) => !r.novadeId);
  return { kind: "status_sheet", startIso, endIso, total: rows.length, synced, unsynced };
}

async function performStatusNovade({ startIso, endIso, groupConfig, extraFilters }) {
  const rows = await fetchRowsInWindow({ startIso, endIso, groupConfig, extraFilters });
  const candidates = rows.filter((r) => r.novadeId && r.status === "closed");
  const capped = candidates.slice(0, STATUS_NOVADE_CAP);
  const results = [];
  for (const r of capped) {
    try {
      const action = await getSafetyActionById(r.novadeId);
      const novadeStatus = Number(action?.status ?? action?.data?.status ?? action?.data?.data?.status);
      results.push({ sn: r.sn, novadeId: r.novadeId, sheetStatus: r.status, novadeStatus });
    } catch (e) {
      results.push({ sn: r.sn, novadeId: r.novadeId, sheetStatus: r.status, error: e?.message || String(e) });
    }
  }
  return {
    kind: "status_novade",
    startIso,
    endIso,
    totalCandidates: candidates.length,
    capped: candidates.length > STATUS_NOVADE_CAP,
    results,
  };
}

// ---------------------------------------------------------------------------
// Reply formatters
// ---------------------------------------------------------------------------

function headerLine(label, startIso, endIso) {
  const range =
    startIso === endIso ? isoToCronDisplay(startIso) : `${isoToCronDisplay(startIso)} to ${isoToCronDisplay(endIso)}`;
  return `${label} — ${range}`;
}

function formatInvalidLines(skippedInvalid) {
  // Surface rows that were REJECTED before any Novade write (bad data → would
  // create a trash action). One line per row + reason so the user fixes the
  // sheet. Capped to keep the message readable.
  const lines = [];
  if (Array.isArray(skippedInvalid) && skippedInvalid.length) {
    lines.push("");
    lines.push(`⛔ ${skippedInvalid.length} rejected (invalid data — NOT sent to Novade):`);
    for (const s of skippedInvalid.slice(0, 10)) {
      lines.push(`  • S/N ${s.sn} — ${truncate(s.reason, 90)}`);
    }
    if (skippedInvalid.length > 10) lines.push(`  …and ${skippedInvalid.length - 10} more`);
  }
  return lines;
}

function formatPreviewEmptyReply(result) {
  const { startIso, endIso, totalInWindow, alreadySynced, skippedNoImage, skippedNoDescription, skippedInvalid } =
    result;
  const lines = [headerLine("Novade Sync", startIso, endIso), ""];
  if (!totalInWindow) {
    lines.push("No safety issues found in this window. Nothing to sync.");
  } else if (alreadySynced === totalInWindow) {
    lines.push(`All ${alreadySynced} issue(s) in this window are already synced to Novade. Nothing to do.`);
  } else {
    lines.push("Nothing eligible to sync.");
    const noted = [];
    if (alreadySynced) noted.push(`${alreadySynced} already synced`);
    if (skippedNoImage) noted.push(`${skippedNoImage} without photo`);
    if (skippedNoDescription) noted.push(`${skippedNoDescription} without description`);
    if (noted.length) lines.push(noted.join(", ") + ".");
  }
  lines.push(...formatInvalidLines(skippedInvalid));
  lines.push("");
  lines.push(snapshotFooter());
  return lines.join("\n");
}

function formatPreviewReadyCaption(result) {
  const { startIso, endIso, previewTabName, toCreateCount, alreadySynced, skippedNoImage, skippedInvalid } = result;
  const eligibleTotal = result.eligibleTotal ?? toCreateCount;
  const batchCapped = !!result.batchCapped;
  const range = headerLine("", startIso, endIso).replace(/^—\s*/, "");
  const lines = [`📋 Novade Sync — preview ready (${range})`, ""];
  if (batchCapped) {
    // Large backlog — this run handles the first chunk; the rest is paged.
    lines.push(
      `Found *${eligibleTotal}* unsynced safety issues — too many for one run, so I'll sync the *first ${toCreateCount}* (oldest first) now.`,
    );
  } else {
    lines.push(`Found *${toCreateCount}* safety issue${toCreateCount === 1 ? "" : "s"} ready to sync to Novade.`);
  }
  const noted = [];
  if (alreadySynced) noted.push(`${alreadySynced} already synced`);
  if (skippedNoImage) noted.push(`${skippedNoImage} without photo (skipped — only issues with photos sync)`);
  if (noted.length) lines.push(noted.join(", ") + ".");
  lines.push(...formatInvalidLines(skippedInvalid));
  lines.push("");
  lines.push(`Please review the screenshot. Reply *approve* to this image to start the sync, or *cancel* to abort.`);
  if (batchCapped) {
    lines.push(
      `Once these ${toCreateCount} finish, just send the same request again to sync the next ${toCreateCount}.`,
    );
  }
  lines.push("");
  lines.push(snapshotFooter());
  lines.push("");
  // The marker is the ONLY load-bearing piece of state — the confirmation
  // handler extracts the preview tab name from it on the user's reply.
  lines.push(`[ref: ${previewTabName}]`);
  return lines.join("\n");
}

// Build the per-page captions for a multi-page preview. The [ref:] marker MUST
// appear on EVERY page — users naturally scroll to the last image (most recent
// issues are last) and reply there; if page 2/3 lacks the marker, index.js's
// NOVADE_REF_MARKER_RE misses it and the approval is misrouted to the safety
// handler (silently dropped). Page 1 = full caption (ends with the marker via
// formatPreviewReadyCaption); pages 2+ = compact reminder + the same marker.
function buildPreviewCaptions(result, total) {
  const page1 = formatPreviewReadyCaption(result);
  if (!Number.isFinite(total) || total <= 1) return [page1];
  return Array.from({ length: total }, (_, i) =>
    i === 0
      ? page1
      : `📋 Page ${i + 1} of ${total} · Reply *approve* to start the sync or *cancel* to abort.\n\n[ref: ${result.previewTabName}]`,
  );
}

function formatSyncCompleteReply({
  startIso,
  endIso,
  created,
  failures,
  skippedAlreadySynced,
  previewTabName,
  remainingInWindow = 0,
  deferredForTime = 0,
}) {
  const lines = [headerLine("Novade Sync — complete", startIso, endIso), ""];
  // Only rows VERIFIED in Novade (re-fetched, status confirmed) count as
  // synced. A created-but-unverified row (e.g. close didn't take) is NOT
  // reported as synced — it's surfaced separately so the message never lies.
  const verified = created.filter((c) => c.verifiedOk);
  const createdNotVerified = created.filter((c) => !c.verifiedOk);

  if (verified.length) {
    lines.push(`✅ Synced & verified ${verified.length} issue(s) in Novade:`);
    lines.push("");
    for (const c of verified) {
      const sev = c.severity || "N/A";
      const desc = truncate(c.description, 60);
      lines.push(`S/N ${c.sn} · ${sev} · ${desc}`);
      // Customer-facing: the Novade Action Id (a UUID) means nothing to site
      // users — show only the human-readable outcome. The id is still written
      // to the sheet's "Novade Action Id" column for the record.
      lines.push(`  → ${c.status === "closed" ? "Closed in Novade ✓" : "Open in Novade ✓"}`);
      lines.push("");
    }
  } else {
    lines.push("No issues were synced & verified.");
    lines.push("");
  }

  // Created but NOT verified at the expected status — the action exists in
  // Novade (id recorded on the sheet so a retry won't duplicate it) but it did
  // not reach the expected state. These need manual attention in Novade.
  if (createdNotVerified.length) {
    lines.push(`⚠️ ${createdNotVerified.length} created in Novade but NOT verified closed:`);
    for (const c of createdNotVerified) {
      lines.push(`  • S/N ${c.sn} — created in Novade but not confirmed ${c.status === "closed" ? "closed" : "open"}`);
    }
    lines.push(
      `Please close these in Novade manually — re-issuing the sync will NOT re-close them (they already have an id).`,
    );
    lines.push("");
  }

  // Hard failures (create errors, writeback errors). The verify-kind failures
  // are already itemised above, so only show non-verify failures here.
  const otherFailures = failures.filter((f) => f.kind !== "verify");
  if (otherFailures.length) {
    lines.push(`❌ ${otherFailures.length} failure(s):`);
    for (const f of otherFailures) {
      lines.push(`  ✗ S/N ${f.sn} — ${f.kind} failed: ${truncate(f.error, 100)}`);
    }
    lines.push("");
    lines.push(
      `To retry the failed ones, re-issue your sync request (a fresh preview is built; anything already created is skipped automatically). Do NOT reply 'approve' to the old preview — that would create duplicates.`,
    );
    lines.push("");
  } else if (skippedAlreadySynced > 0) {
    lines.push(`(${skippedAlreadySynced} row(s) from the preview were already synced by another run — skipped.)`);
    lines.push("");
  }

  // Paging prompt: more unsynced issues remain in this window (batch cap hit,
  // or the time-budget deferred some). The user re-issues the SAME request and
  // the idempotency filter pages to the next batch.
  if (remainingInWindow > 0) {
    if (deferredForTime > 0) {
      lines.push(`⏱️ Stopped at the time limit — *${remainingInWindow}* issue(s) still unsynced for this window.`);
    } else {
      lines.push(`*${remainingInWindow}* more issue(s) still unsynced for this window.`);
    }
    lines.push(`Send the same sync request again to do the next batch.`);
    lines.push("");
  }

  lines.push(snapshotFooter());
  return lines.join("\n");
}

function formatStatusSheetReply(result) {
  const { startIso, endIso, total, synced, unsynced } = result;
  const lines = [headerLine("Novade Sync Status", startIso, endIso), ""];
  lines.push(`Total issues: ${total}`);
  lines.push(`Synced to Novade: ${synced.length}`);
  lines.push(
    `Not yet synced: ${unsynced.length}` +
      (unsynced.length ? ` (${unsynced.map((r) => `S/N ${r.sn}`).join(", ")})` : ""),
  );
  lines.push("");
  lines.push(snapshotFooter());
  return lines.join("\n");
}

function formatStatusNovadeReply(result) {
  const { startIso, endIso, totalCandidates, capped, results } = result;
  const lines = [headerLine("Novade Action Status — closed issues", startIso, endIso), ""];
  if (!totalCandidates) {
    lines.push("No closed issues with a Novade Action Id in this window.");
    lines.push("");
    lines.push(snapshotFooter());
    return lines.join("\n");
  }
  for (const r of results) {
    if (r.error) {
      lines.push(`S/N ${r.sn} · ${r.novadeId} → ⚠️ fetch failed: ${truncate(r.error, 80)}`);
      continue;
    }
    const label = NOVADE_STATUS_LABELS[r.novadeStatus] || `Status ${r.novadeStatus}`;
    if (r.novadeStatus === 7) {
      lines.push(`S/N ${r.sn} · ${r.novadeId} → ${label} (${r.novadeStatus}) ✓`);
    } else {
      lines.push(
        `S/N ${r.sn} · ${r.novadeId} → ${label} (${r.novadeStatus}) ⚠️ drift — sheet says closed, Novade still ${label.toLowerCase()}`,
      );
    }
  }
  if (capped) {
    lines.push("");
    lines.push(`(Capped at ${STATUS_NOVADE_CAP} actions. Narrow with severity / shorter window if you need more.)`);
  }
  lines.push("");
  lines.push(snapshotFooter());
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Confirmation step — triggered by [ref: Novade-Preview-…] in quotedBody.
// LLM-classifies the user's reply (approve / cancel / ambiguous) and on
// approve runs the actual Novade pipeline against the rows in the preview tab.
// ---------------------------------------------------------------------------

function extractPreviewTabName(quotedBody) {
  if (!quotedBody) return null;
  const m = String(quotedBody).match(REF_MARKER_RE);
  if (!m) return null;
  const candidate = m[1];
  return PREVIEW_TAB_NAME_RE.test(candidate) ? candidate : null;
}

/**
 * Classify the user's reply into one of three buckets. ONE LLM call, strict
 * json_schema. The reply text is short and unstructured ("approve" / "yes
 * please" / "go ahead!!" / "wait" / "cancel" / "huh??") so deterministic
 * regex is too brittle — follows the project rule "no regex on NLP".
 */
async function classifyConfirmationIntent(replyText) {
  const text = String(replyText || "").trim();
  if (!text) return { decision: "ambiguous", reason: "empty reply" };

  const systemPrompt = `You classify a single short WhatsApp reply into one of three buckets:

- "approve" — user wants to proceed with the proposed Novade sync. Trigger words: approve / approved / yes / confirm / confirmed / proceed / go / ok / okay / start / do it / 👍 / ✓.
- "cancel"  — user wants to abort. Trigger words: cancel / cancelled / no / abort / stop / reject / nope / nah / 👎 / ✗ / skip.
- "ambiguous" — anything else (questions, partial requests like "sync only S/N 12", edits like "regenerate with P1 only", chat that isn't an approve/cancel decision).

The reply may be in English, Singlish, or have typos. The decision MUST be one of the three exact strings.`;

  const schema = {
    type: "object",
    properties: {
      decision: { type: "string", enum: ["approve", "cancel", "ambiguous"] },
      reason: { type: "string", description: "Short explanation of why this bucket was chosen." },
    },
    required: ["decision", "reason"],
    additionalProperties: false,
  };

  try {
    const response = await getOpenAI().responses.create({
      model: "gpt-4.1",
      temperature: 0,
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: text },
      ],
      text: {
        format: { type: "json_schema", name: "novade_confirmation_intent", strict: true, schema },
      },
      store: true,
      metadata: { project: "wohhup", type: "qa_novade_confirmation" },
    });
    return JSON.parse(response.output_text);
  } catch (e) {
    console.warn(`[NovadeSync(QA)] confirmation classify failed: ${e?.message || e}`);
    return { decision: "ambiguous", reason: "classifier_error" };
  }
}

// Google Sheets stores dates as serial numbers (days since 1899-12-30) and
// datetimes as serial + fractional day. When readGoogleSheet uses
// valueRenderOption:FORMULA, date cells come back as those numbers, NOT as
// the display string. The preview tab's DATE (col 1) and UPDATED AT (col 11)
// columns get auto-typed this way by Google because captureSafetyImage
// writes the underlying ISO/Date value with USER_ENTERED. We convert back
// in the strict-preview reader so downstream code gets ISO strings + ms.
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
function excelSerialOrIsoToDate(val) {
  if (typeof val === "number" && val > 0 && val < 100000) {
    const ms = EXCEL_EPOCH_MS + Math.floor(val) * 86400000;
    return new Date(ms).toISOString().slice(0, 10);
  }
  return String(val || "").trim();
}
function excelSerialOrStringToMs(val) {
  if (typeof val === "number") {
    // Heuristic: < 100000 = days-since-1899 (Excel serial); >= 1e11 = ms
    // since epoch (raw ms we wrote ourselves into CREATED TS).
    if (val > 0 && val < 100000) return EXCEL_EPOCH_MS + Math.round(val * 86400000);
    return val;
  }
  return parseTimestampToMs(val);
}

/**
 * STRICT-PREVIEW reader. Reads ALL fields the sync pipeline needs (including
 * the live-sheet row + col coordinates for writeback) from the preview tab.
 * NO live Safety-sheet read at approve time — the preview is the single
 * source of truth.
 *
 * Column layout on the preview tab (positional, set by captureSafetyImage's
 * CANONICAL + the augmentation in performPreview):
 *   0: S/N            6: DESCRIPTION         11: UPDATED BY
 *   1: DATE           7: PROPOSED FIX        12: UPDATED AT (ms or serial)
 *   2: SEVERITY       8: IMAGE (=IMAGE() formula, BEFORE)
 *   3: STATUS         9: IMAGE AFTER (=IMAGE() formula, post-rectification)
 *   4: CATEGORY      10: RAISED BY (sender, extracted .name)
 *   5: LOCATION      13: CREATED TS (ms, augmented — SGT-aware)
 *                    14: LIVE ROW (1-based row index on live Safety sheet)
 *                    15: NOVADE COL (1-based col index of `Novade Action Id`
 *                                    on live Safety sheet — same per row)
 *                    16: UPDATED TS (ms, augmented — SGT-aware; close date)
 *
 * readGoogleSheet uses valueRenderOption:FORMULA so cols 8/9 come back as
 * the `=IMAGE(url,2)` formula text — extractImageUrl pulls the URL out.
 * createdTimestampMs/updatedTimestampMs come from the augmented cols 13/16
 * (SGT-aware parseTimestampToMs values), NOT the canonical UPDATED AT (col 12)
 * Excel serial — that serial has no SGT offset and would land the Novade close
 * 8h off, diverging from the cron. Col 12 is kept only as a legacy fallback.
 *
 * Returns: { rows: [...], novadeIdCol1Based, allRowsHaveLiveRow }
 */
async function readPreviewRows(spreadsheetId, previewTabName) {
  const previewRows = (await readGoogleSheet(spreadsheetId, previewTabName)) || [];
  if (previewRows.length <= 2) return { rows: [], novadeIdCol1Based: 0, allRowsHaveLiveRow: true };
  const out = [];
  let novadeIdCol1Based = 0;
  let allRowsHaveLiveRow = true;
  let allRowsHaveNovadeCol = true;
  let batchTotal = 0; // pre-cap eligible count for this window (col 17)
  for (let i = 2; i < previewRows.length; i++) {
    const row = previewRows[i];
    if (!row) continue;
    const sn = String(row[0] ?? "").trim();
    if (!sn) continue;
    const liveRowRaw = row[14];
    const liveRow = Number(liveRowRaw);
    const novadeCol = Number(row[15]);
    const bt = Number(row[17]);
    if (Number.isFinite(bt) && bt > batchTotal) batchTotal = bt;
    if (!Number.isFinite(liveRow) || liveRow <= 0) allRowsHaveLiveRow = false;
    // Each row must carry its OWN per-tab Novade column (multi-tab). If any is missing — e.g. a
    // transient error resolved one source tab's col during preview — abort the whole run rather
    // than guess a column (a wrong-column writeback corrupts the archive silently).
    if (!Number.isFinite(novadeCol) || novadeCol <= 0) allRowsHaveNovadeCol = false;
    if (Number.isFinite(novadeCol) && novadeCol > 0 && !novadeIdCol1Based) novadeIdCol1Based = novadeCol;
    out.push({
      sn,
      date: excelSerialOrIsoToDate(row[1]),
      severity: String(row[2] ?? "")
        .trim()
        .toUpperCase(),
      status: String(row[3] ?? "")
        .trim()
        .toLowerCase(),
      category: String(row[4] ?? "").trim(),
      location: String(row[5] ?? "").trim(),
      description: String(row[6] ?? "").trim(),
      // proposedFix at col 7 — not needed by sync
      imageUrl: extractImageUrl(row[8]),
      imageAfterUrl: extractImageUrl(row[9]),
      senderName: parseSenderName(row[10]),
      updatedByName: parseSenderName(row[11]),
      // SGT-aware augmented timestamps (cols 13/16). Fall back to the canonical
      // UPDATED AT serial (col 12) only for legacy previews lacking col 16.
      updatedTimestampMs:
        row[16] !== undefined && String(row[16]).trim() !== ""
          ? excelSerialOrStringToMs(row[16])
          : excelSerialOrStringToMs(row[12]),
      createdTimestampMs: excelSerialOrStringToMs(row[13]),
      liveRowNumber: Number.isFinite(liveRow) && liveRow > 0 ? liveRow : null,
      // Per-row writeback target (multi-tab): the issue's own monthly tab (col 18) + its Novade
      // Action Id column on that tab (col 15). Legacy previews lack col 18 → default to "Safety".
      sourceSheet: String(row[18] ?? "").trim() || SAFETY_SHEET_NAME,
      novadeIdCol0Based: Number.isFinite(novadeCol) && novadeCol > 0 ? novadeCol - 1 : null,
      novadeId: "",
    });
  }
  return { rows: out, novadeIdCol1Based, allRowsHaveLiveRow, allRowsHaveNovadeCol, batchTotal };
}

async function handleNovadeSyncConfirmation(message, groupConfig) {
  const previewTabName = extractPreviewTabName(message?.quotedBody);
  if (!previewTabName) {
    // Should never happen — router only calls us when the marker is present.
    return { message: "Novade confirmation: couldn't parse the preview tab name from the quoted message." };
  }

  // Pre-flight: env + spreadsheet must be configured.
  const spreadsheetId = resolveSpreadsheetId(groupConfig);
  if (!spreadsheetId) {
    return { message: "Novade confirmation: SAFETY_SPREADSHEET_ID not configured." };
  }
  if (!process.env.NOVADE_EMAIL || !process.env.NOVADE_PASSWORD) {
    return { message: "Novade confirmation: NOVADE_EMAIL / NOVADE_PASSWORD env vars not set." };
  }

  // Verify the preview tab still exists. If it's gone, this confirmation is
  // a late-reply / double-tap / already-processed — explain and return.
  let tabs;
  try {
    tabs = await getSheetNames(spreadsheetId);
  } catch (e) {
    return { message: `Novade confirmation: couldn't read the spreadsheet (${e?.message || e}).` };
  }
  if (!tabs.includes(previewTabName)) {
    return {
      message: `This Novade sync was already processed or cancelled (preview tab "${previewTabName}" no longer exists).`,
    };
  }

  // Classify the user's reply.
  const { decision, reason } = await classifyConfirmationIntent(message?.body);
  if (decision === "ambiguous") {
    return {
      message: `Sorry, I couldn't tell if that was an approval or a cancel. Please reply *approve* to start the Novade sync, or *cancel* to abort. (Reason: ${reason}.)`,
    };
  }
  if (decision === "cancel") {
    try {
      await deleteSheet(spreadsheetId, previewTabName);
    } catch (e) {
      console.warn(`[NovadeSync(QA)] cancel — deleteSheet failed: ${e?.message || e}`);
    }
    return {
      message: `❌ Novade sync cancelled. Preview tab "${previewTabName}" deleted. No issues were sent to Novade.`,
    };
  }

  // APPROVE — STRICT MODE: read EVERYTHING (incl. writeback coords) from the
  // preview tab; ZERO live Safety-sheet lookup. The preview is the single
  // source of truth — what the user saw on the screenshot is exactly what
  // gets synced, and the writeback row+col come from the preview metadata
  // that was pre-resolved at preview-build time.
  const {
    rows: previewRows,
    novadeIdCol1Based,
    allRowsHaveLiveRow,
    allRowsHaveNovadeCol,
    batchTotal,
  } = await readPreviewRows(spreadsheetId, previewTabName);
  if (!previewRows.length) {
    try {
      await deleteSheet(spreadsheetId, previewTabName);
    } catch (_) {}
    return {
      message: `Novade confirmation: preview tab "${previewTabName}" had no recognisable S/Ns. Nothing synced. Tab deleted.`,
    };
  }

  // Refuse to run if the preview is missing the live-sheet writeback metadata.
  // This happens for preview tabs built before the strict-no-live-read change
  // (no LIVE ROW / NOVADE COL cols). The user must re-issue the sync request
  // to generate a fresh, fully-augmented preview.
  if (!novadeIdCol1Based || !allRowsHaveLiveRow || !allRowsHaveNovadeCol) {
    return {
      message: `Novade confirmation: preview tab "${previewTabName}" is missing live-sheet writeback metadata (LIVE ROW / NOVADE COL). This preview was built before the strict-no-live-read upgrade. Please re-issue your sync request to get a fresh preview, then approve.`,
    };
  }

  const eligible = previewRows.filter((r) => r.description && r.imageUrl);
  const skippedAlreadySynced = 0;

  const dates = previewRows
    .map((r) => r.date)
    .filter(Boolean)
    .sort();
  const startIso = dates[0] || "";
  const endIso = dates[dates.length - 1] || startIso;

  if (!eligible.length) {
    try {
      await deleteSheet(spreadsheetId, previewTabName);
    } catch (_) {}
    return {
      message: formatSyncCompleteReply({
        startIso,
        endIso,
        created: [],
        failures: [],
        skippedAlreadySynced,
        previewTabName,
      }),
    };
  }

  // DELETE THE PREVIEW TAB NOW — BEFORE the multi-minute Novade pipeline.
  // All preview data (incl. writeback coords) is already captured in `eligible`
  // / previewRows, so the tab is no longer needed. Deleting it up front means a
  // re-delivered "approve" (gateway-timeout retry, or the listener's double-
  // delivery) hits the tab-existence check at the top of THIS function, finds
  // the tab gone, and returns "already processed" — it can NOT re-run the
  // pipeline and create duplicates. (Previously the delete ran only at the END
  // of the pipeline, leaving a ~minutes-long window where a re-delivery would
  // re-create everything.) No async/early-202 plumbing needed.
  //
  // ATOMIC CLAIM: deleteSheet returns `false` (not throws) when the tab is
  // already gone — meaning a concurrent invocation (same Lambda cold-start or
  // the listener's double-delivery) beat us to the delete. In that case the
  // other invocation is already running the Novade pipeline; we must NOT
  // proceed or we will create duplicate actions. Bail out immediately.
  // Note: a module-level Map is NOT sufficient here — concurrent Lambda
  // container instances do not share in-process state, so the deleteSheet
  // return value is the only cross-invocation mutex available.
  let tabDeletedByUs;
  try {
    tabDeletedByUs = await deleteSheet(spreadsheetId, previewTabName);
  } catch (e) {
    console.warn(`[NovadeSync(QA)] pre-run deleteSheet failed for "${previewTabName}": ${e?.message || e}`);
    // Network error — we don't know who holds the tab. Bail conservatively.
    return {
      message: `Novade sync could not start: failed to claim the preview tab (${e?.message || e}). Please retry.`,
    };
  }
  if (!tabDeletedByUs) {
    // Another invocation already deleted the tab and is running the pipeline.
    console.warn(
      `[NovadeSync(QA)] pre-run deleteSheet returned false for "${previewTabName}" — concurrent invocation already claimed the tab. Aborting to prevent duplicate Novade actions.`,
    );
    return {
      message: `This Novade sync was already processed or cancelled (preview tab "${previewTabName}" no longer exists).`,
    };
  }

  // Run the Novade pipeline. novadeIdCol0Based = NOVADE COL value (1-based) - 1.
  let runResult;
  try {
    runResult = await runNovadeSyncOnRows({
      rows: eligible,
      groupConfig,
      novadeIdCol0Based: novadeIdCol1Based - 1,
    });
  } catch (e) {
    console.error(`[NovadeSync(QA)] confirmation run uncaught: ${e?.stack || e}`);
    // The preview tab was already deleted before the run, so re-approve is
    // impossible. The user retries by re-issuing the sync request; a fresh
    // preview skips rows that already carry an id (already created).
    return {
      message: `Novade sync error: ${e?.message || "unknown"}. Some rows may have been created. Re-issue your sync request to retry (already-created rows are skipped).`,
    };
  }
  const { created, failures, deferredForTime } = runResult;

  // (Preview tab already deleted up front — nothing to clean up here.)

  // Remaining unsynced in this window AFTER this run = the pre-cap total minus
  // what we just verified-synced (and minus any time-deferred rows, which are
  // also still unsynced). Used to tell the user to re-issue for the next batch.
  const verifiedCount = created.filter((c) => c.verifiedOk).length;
  const remainingInWindow = Math.max(0, (Number(batchTotal) || created.length) - verifiedCount);

  return {
    message: formatSyncCompleteReply({
      startIso,
      endIso,
      created,
      failures,
      skippedAlreadySynced,
      previewTabName,
      remainingInWindow,
      deferredForTime: deferredForTime || 0,
    }),
    // Structured result for programmatic consumers (E2E verification). The
    // customer-facing `message` no longer prints the Novade Action Id (a UUID
    // means nothing to site users), so tests read the ids from here instead of
    // scraping the reply text. Extra keys are ignored by the listener (which
    // only auto-sends `message`).
    synced: created.map((c) => ({ sn: c.sn, novadeId: c.novadeId, status: c.status, verifiedOk: c.verifiedOk })),
    failures,
  };
}

// ---------------------------------------------------------------------------
// Public bypass entry — invoked by usecases/qa_agent/index.js dispatcher
// ---------------------------------------------------------------------------

async function handleNovadeSync(intent, chatId, groupConfig) {
  const pre = preflight(intent, groupConfig);
  if (!pre.ok) return { message: pre.error };

  // Extract the synthetic __action__ filter; pass the remaining filters
  // through as sheet-row filters (Status='closed', Severity='P1', etc.).
  const allFilters = intent?.filters || [];
  const actionFilter = allFilters.find((f) => f?.field === "__action__");
  const action = actionFilter?.value || "sync"; // safe default
  const extraFilters = allFilters.filter((f) => f?.field !== "__action__");

  try {
    if (action === "status_sheet") {
      const result = await performStatusSheet({ ...pre, groupConfig, extraFilters });
      return { message: formatStatusSheetReply(result) };
    }
    if (action === "status_novade") {
      const result = await performStatusNovade({ ...pre, groupConfig, extraFilters });
      return { message: formatStatusNovadeReply(result) };
    }
    // Default = sync → now produces a PREVIEW (no Novade writes). The actual
    // sync runs on the user's confirming reply via handleNovadeSyncConfirmation.
    // intent.order_by + intent.limit ("the latest GO", "sync top 3 P1 this
    // week") are passed through so the preview tab + screenshot reflect
    // exactly what would be synced.
    const result = await performPreview({
      ...pre,
      groupConfig,
      extraFilters,
      orderBy: intent?.order_by || null,
      limit: intent?.limit || null,
    });
    if (result.kind === "preview_empty") {
      return { message: formatPreviewEmptyReply(result) };
    }
    const caption = formatPreviewReadyCaption(result);
    const snap = result.snap;
    const total = snap?.imageUrls?.length || 0;
    if (!total) {
      // Screenshot pipeline failed (e.g. PDF→PNG service unavailable). Still
      // produced a preview tab — delete it so we don't orphan, tell user.
      try {
        await deleteSheet(resolveSpreadsheetId(groupConfig), result.previewTabName);
      } catch (_) {}
      return {
        message: `Novade Sync: preview built but screenshot failed. Please try again. (Preview tab cleaned up.)`,
      };
    }
    const captions = buildPreviewCaptions(result, total);
    return { message: caption, imageUrls: snap.imageUrls, imageCaptions: captions };
  } catch (e) {
    console.error(`[NovadeSync(QA)] uncaught: ${e?.stack || e}`);
    return { message: `Novade sync error: ${e?.message || "unknown"}.` };
  }
}

module.exports = {
  handleNovadeSync,
  handleNovadeSyncConfirmation,
  // Exposed for the lambda main router so it can detect the marker BEFORE
  // dispatching to per-group handlers (saves an extra LLM call in the safety
  // group's normal intent-classification path).
  REF_MARKER_RE,
  extractPreviewTabName,
  // Exposed for the regression test (scripts/novade-timestamp-regression.js).
  validateRowForNovade,
  formatSyncCompleteReply,
  buildPreviewCaptions,
  // Exposed for the offline failure-paths test (scripts/novade-failure-paths-test.js).
  runNovadeSyncOnRows,
};
