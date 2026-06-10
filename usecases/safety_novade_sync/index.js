// Safety Novade Sync — scans the safety sheet(s), creates Novade actions for
// every unsynced row, and walks already-synced rows whose status flipped to
// "closed" through the 3-step Novade close lifecycle.
//
// Two operating modes (selected via request body):
//   - Daily mode (default):
//       Looks at one sheet (default "Safety"), only creates actions for rows
//       whose Date matches today (or `body.date`).
//   - Backfill mode (`body.backfill: true`):
//       Iterates every "Safety" + "Safety-MMM YYYY" tab in the spreadsheet
//       (auto-discovered via getSheetNames if `body.sheetNames` not passed)
//       and creates actions for every unsynced row regardless of date.
//
// Cross-day close support: any row with a Novade Action Id whose status is
// now "closed" gets closed on Novade in either mode (no date filter on close).
// Idempotency via GET /safety/actions/{id} pre-check.
//
// Actor handling: `lodgedby`, `confirmedby`, `completedby`, `closedby` are all
// forced to NOVADE_DEFAULT_ACTOR (defaults to "WL API"). Real Novade actions
// in this project only use a small set of API/admin accounts ("WL API",
// "Novade Admin Woh Hup", "wh.mbs.wlapi"); WhatsApp display names from the
// sheet's "Sender" / "Updated By" columns 400 the close PATCH because they
// aren't valid Novade users. See scripts/novade-inspect-actions.js.

const { readGoogleSheet, batchUpdateCells, getSheetNames } = require("../../utils/gsheet");
const {
  resolveProjectIdByName,
  resolveUnitIdForProject,
  listUnitsForProjectCached,
  listSafetyIssueTypesCached,
  listCompanies,
  listNovadeActorsFromHistory,
  getProjectById,
  createSafetyAction,
  patchSafetyAction,
  closeSafetyAction,
  uploadFileFromUrl,
  getSafetyActionById,
  extractNovadeRecId,
  parseTimestampToMs,
} = require("../../utils/novade-api");
const { resolvePICToContractorId } = require("../../utils/pic-company-mapping");
const { resolveNovadeActor } = require("../../utils/novade-user-mapping");
const { refreshSignedUrl } = require("../../utils/supabase-storage");
const { getKnownAssigneesForProject } = require("../../config/novade-assignees");
const { classifyIssuesForNovade } = require("./llm-classify");

// Sheet "Severity" → Novade `risklevel` (numeric, 0..max). Higher = more
// dangerous in Novade. Customer's mental model: any real safety issue (P1/P2/P3)
// is "dangerous" and should sit at the highest available risklevel. Only Good
// Observations / FYI items (Severity = N/A or blank) are non-dangerous.
//
// MBS projects today only have 2 risk levels enabled (max=1):
//   P1 / P2 / P3 → 1   (dangerous)
//   N/A / blank  → 0   (good observation)
// If the admin enables more levels, set NOVADE_MAX_RISK_LEVEL=2 (or higher);
// real issues still bucket to `max`, observations stay at 0.
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

// Map a level name (e.g., "Basement 01") back to its Novade unit ID.
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

// Wrap uploadFileFromUrl with a one-shot retry that refreshes the Supabase
// signed URL when the first fetch fails (e.g., the JWT in the sheet's
// `=image("URL", 2)` formula has expired). Best-effort: if the URL isn't a
// Supabase Storage URL or re-signing fails, the original error is rethrown.
async function uploadFileWithSupabaseRetry(mediaUrl, opts) {
  try {
    return await uploadFileFromUrl(mediaUrl, opts);
  } catch (firstErr) {
    let fresh;
    try {
      fresh = await refreshSignedUrl(mediaUrl);
    } catch (refreshErr) {
      console.warn(
        `[NovadeSync] refreshSignedUrl failed for ${opts?.linkedRecId || "?"}: ${refreshErr?.message || refreshErr}`,
      );
      throw firstErr;
    }
    if (!fresh || fresh === mediaUrl) throw firstErr;
    console.log(`[NovadeSync] retrying upload with refreshed Supabase URL for ${opts?.linkedRecId || "?"}`);
    return uploadFileFromUrl(fresh, opts);
  }
}

const DEFAULT_SHEET_NAME = "Safety";
const DEFAULT_PROJECT_NAME = "MBS-IR2";
const NOVADE_ACTION_ID_HEADER = "Novade Action Id";
const LINKED_TABLE = "novadesafety.nonconformities";
const DEFAULT_BATCH_SIZE = 10;
// Matches "Safety" and any monthly archive like "Safety-Apr 2026"
const SAFETY_TAB_PATTERN = /^Safety(-[A-Za-z]{3} \d{4})?$/;
// Daily mode only: closes older than this window are assumed to have been
// already propagated to Novade by a prior daily run, so we don't re-walk the
// 1→2→5→7 lifecycle (avoids ~30 GETs per closed issue per month). Backfill
// mode bypasses this filter and walks every close found, no matter how old.
const MAX_CLOSE_AGE_DAYS = 3;
const MONTH_ABBR_3 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Returns the safety-archive tab name for the month BEFORE the given date.
// E.g. "2026-05-01" → "Safety-Apr 2026". Used on day-1 of each month so the
// daily sync still sees closes that landed late in the just-archived month.
function previousMonthSafetyTab(targetDateIso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(targetDateIso || ""));
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const lastMonth = month === 1 ? 12 : month - 1;
  const lastYear = month === 1 ? year - 1 : year;
  return `Safety-${MONTH_ABBR_3[lastMonth - 1]} ${lastYear}`;
}

function getTodaySGT() {
  const nowUtc = new Date();
  const sgtString = nowUtc.toLocaleString("en-US", { timeZone: "Asia/Singapore" });
  return new Date(sgtString).toISOString().slice(0, 10);
}

function normalizeHeader(h) {
  return String(h || "")
    .trim()
    .toLowerCase();
}

function normalizeDateValue(rawValue) {
  if (!rawValue) return "";
  if (rawValue instanceof Date) return rawValue.toISOString().slice(0, 10);
  let str = String(rawValue).trim();
  if (str.startsWith("'")) str = str.slice(1).trim();
  if (!str) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const parsed = new Date(str);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return "";
}

function extractImageUrl(rawValue) {
  if (!rawValue) return "";
  if (typeof rawValue !== "string") return "";
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
  } catch (e) {
    return "";
  }
}

// Sort tabs so "Safety" (current) processes first, then archives newest → oldest.
function compareSafetyTabs(a, b) {
  if (a === DEFAULT_SHEET_NAME) return -1;
  if (b === DEFAULT_SHEET_NAME) return 1;
  // Both archives — parse "Safety-MMM YYYY" and sort by year/month desc
  const monthOrder = {
    Jan: 1,
    Feb: 2,
    Mar: 3,
    Apr: 4,
    May: 5,
    Jun: 6,
    Jul: 7,
    Aug: 8,
    Sep: 9,
    Oct: 10,
    Nov: 11,
    Dec: 12,
  };
  const parse = (name) => {
    const m = name.match(/^Safety-([A-Za-z]{3}) (\d{4})$/);
    if (!m) return [0, 0];
    return [Number(m[2]) || 0, monthOrder[m[1]] || 0];
  };
  const [yA, mA] = parse(a);
  const [yB, mB] = parse(b);
  if (yA !== yB) return yB - yA;
  return mB - mA;
}

async function discoverSafetyTabs(spreadsheetId) {
  const all = await getSheetNames(spreadsheetId);
  return all.filter((name) => SAFETY_TAB_PATTERN.test(name)).sort(compareSafetyTabs);
}

// Resolve the project's MAIN CONTRACTOR id from the live Novade companies list.
// Novade's status-1→2 (WIP) transition ALWAYS requires a contractorid (the NCR
// patch does NOT satisfy it), and the Lambda has NO NOVADE_DEFAULT_CONTRACTOR_ID
// + the PIC→company map is empty — so without this the close 400s. Novade marks
// each company with `type` (0 = main contractor, 1 = subcon) and a pipe-delimited
// `projectids`; take the first type-0 company on this project (e.g. "Woh Hup Pte
// Ltd" for MBS-IR2), else any company on the project. NO env, NO hardcode.
// (Duplicated from the QA bypass per the "cron stays self-contained" rule.)
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

// Process a single sheet tab: read, classify, optionally create/close, writeback.
// Returns { scanned, toCreate, toClose, created, closed, skipped, failures, createdNovadeIdHeader }.
async function processSheet({
  spreadsheetId,
  sheetName,
  targetDate,
  backfill,
  dryRun,
  batchSize,
  projectId,
  unitId,
  units,
  issueTypes,
  novadeCompanies,
  novadeActors,
  defaultActor,
  afterRectFolderId,
  limit,
}) {
  const result = {
    sheetName,
    scanned: 0,
    created: 0,
    closed: 0,
    matched: 0,
    skipped: [],
    failures: [],
    toCreate: [],
    toClose: [],
    createdNovadeIdHeader: false,
    error: null,
  };

  // Project main contractor (from the live Novade API) — the contractorid the
  // status-2 (WIP) transition requires. Resolved once per sheet; used as the
  // fallback when the reporter doesn't map to a specific subcon.
  const defaultContractorId = resolveProjectMainContractorId(projectId, novadeCompanies);

  let sheetData;
  try {
    sheetData = await readGoogleSheet(spreadsheetId, sheetName);
  } catch (e) {
    result.error = `Failed to read sheet "${sheetName}": ${e?.message || e}`;
    return result;
  }
  if (!sheetData || sheetData.length <= 1) {
    return result; // No data rows
  }

  const headers = sheetData[0] || [];
  const headerIdx = new Map();
  headers.forEach((h, i) => headerIdx.set(normalizeHeader(h), i));

  // Auto-create "Novade Action Id" header if missing
  let novadeIdIdx = headerIdx.get(normalizeHeader(NOVADE_ACTION_ID_HEADER));
  if (novadeIdIdx === undefined) {
    novadeIdIdx = headers.length;
    if (!dryRun) {
      try {
        await batchUpdateCells(spreadsheetId, sheetName, [
          { row: 1, col: novadeIdIdx, value: NOVADE_ACTION_ID_HEADER },
        ]);
      } catch (e) {
        result.error = `Failed to add "${NOVADE_ACTION_ID_HEADER}" header on "${sheetName}": ${e?.message || e}`;
        return result;
      }
    }
    result.createdNovadeIdHeader = true;
  }

  const dateIdx = headerIdx.get("date");
  const descIdx = headerIdx.get("description");
  const locationIdx = headerIdx.get("location");
  const categoryIdx = headerIdx.get("category");
  const severityIdx = headerIdx.get("severity");
  const imageIdx = headerIdx.get("image");
  const imageAfterIdx = headerIdx.get("image after rectification");
  const statusIdx = headerIdx.get("status");
  const senderIdx = headerIdx.get("sender");
  const updatedByIdx = headerIdx.get("updated by");
  const createdTsIdx = headerIdx.get("created timestamp");
  const updatedTsIdx = headerIdx.get("updated timestamp");

  if (dateIdx === undefined) {
    result.error = `Missing 'Date' column in sheet "${sheetName}"`;
    return result;
  }

  // Classify rows (apply --limit if requested, for cautious test runs)
  const allRows = sheetData.slice(1);
  const rows = Number.isFinite(Number(limit)) && Number(limit) > 0 ? allRows.slice(0, Number(limit)) : allRows;
  result.scanned = rows.length;

  rows.forEach((row, idx) => {
    const rowNumber = idx + 2;
    const novadeId = String(row[novadeIdIdx] || "").trim();
    const description = descIdx !== undefined ? String(row[descIdx] || "").trim() : "";
    const status =
      statusIdx !== undefined
        ? String(row[statusIdx] || "")
            .trim()
            .toLowerCase()
        : "";

    if (!description) {
      result.skipped.push({ sheetName, rowNumber, reason: "Missing description" });
      return;
    }

    if (novadeId && status === "closed") {
      const afterMediaUrl = imageAfterIdx !== undefined ? extractImageUrl(row[imageAfterIdx]) : "";
      const updatedTsRaw = updatedTsIdx !== undefined ? row[updatedTsIdx] : "";
      const createdTsRaw = createdTsIdx !== undefined ? row[createdTsIdx] : "";
      // Guard: parseTimestampToMs() returns Date.now() for blank inputs (so the
      // age math would always read "0ms old" and let blank-timestamp rows
      // bypass the filter forever). Resolve to null up-front so blank/missing
      // values become Infinity → skipped in daily mode.
      const hasUpdatedTs = updatedTsRaw !== null && updatedTsRaw !== undefined && String(updatedTsRaw).trim() !== "";
      const closedTsMs = hasUpdatedTs ? parseTimestampToMs(updatedTsRaw) : null;

      // Daily-mode close-age filter: an issue is expected to be closed within
      // MAX_CLOSE_AGE_DAYS of when this row was first synced. Anything closed
      // longer ago than that window has either already been propagated to
      // Novade by a prior daily run (then would no-op via the GET pre-check
      // anyway), or was closed pre-Novade-integration. Skip to save the
      // ~30-GET-per-closed-issue-per-month overhead. Backfill bypasses.
      if (!backfill) {
        const ageMs = Number.isFinite(closedTsMs) ? Date.now() - closedTsMs : Infinity;
        if (ageMs > MAX_CLOSE_AGE_DAYS * 24 * 60 * 60 * 1000) {
          result.skipped.push({
            sheetName,
            rowNumber,
            reason: hasUpdatedTs
              ? `Closed > ${MAX_CLOSE_AGE_DAYS} days ago — assume already propagated`
              : `Status=closed but no Updated Timestamp — cannot determine close age`,
          });
          return;
        }
      }

      const updatedByName = updatedByIdx !== undefined ? parseSenderName(row[updatedByIdx]) : "";
      result.toClose.push({
        sheetName,
        rowNumber,
        novadeId,
        afterMediaUrl,
        // closedTimestampMs = when the issue was closed on the sheet (used for
        // completion/closing dates in Novade).
        // createdTimestampMs = when the issue was first reported (used for
        // confirmation date and target = created + 4h).
        closedTimestampMs: closedTsMs,
        createdTimestampMs: parseTimestampToMs(createdTsRaw),
        category: categoryIdx !== undefined ? String(row[categoryIdx] || "").trim() : "",
        updatedByName,
      });
      return;
    }

    if (novadeId) {
      result.skipped.push({
        sheetName,
        rowNumber,
        reason: "Already synced (Novade Action Id present, status not closed)",
      });
      return;
    }

    // Create-flow: skip stale rows in daily mode, sync everything in backfill.
    if (!backfill) {
      const rowDate = normalizeDateValue(row[dateIdx]);
      if (rowDate !== targetDate) {
        result.skipped.push({
          sheetName,
          rowNumber,
          reason: `Date mismatch (row=${rowDate}, target=${targetDate})`,
        });
        return;
      }
    }

    // Real-time create path already blocks empty-image issues upstream, so by
    // the time a row reaches the sheet without an image it is data-only chatter
    // (or a placeholder) — never a real safety issue worth creating in Novade.
    // Backfill must apply the same guard so historical noise rows don't get
    // pushed across.
    const rowMediaUrl = imageIdx !== undefined ? extractImageUrl(row[imageIdx]) : "";
    if (!rowMediaUrl) {
      result.skipped.push({
        sheetName,
        rowNumber,
        reason: "Missing image URL — only issues with photos are synced to Novade",
      });
      return;
    }

    result.toCreate.push({
      sheetName,
      rowNumber,
      description,
      location: locationIdx !== undefined ? String(row[locationIdx] || "").trim() : "",
      category: categoryIdx !== undefined ? String(row[categoryIdx] || "").trim() : "",
      severity: severityIdx !== undefined ? String(row[severityIdx] || "").trim() : "",
      mediaUrl: rowMediaUrl,
      afterMediaUrl: imageAfterIdx !== undefined ? extractImageUrl(row[imageAfterIdx]) : "",
      reporterName: senderIdx !== undefined ? parseSenderName(row[senderIdx]) : "",
      updatedByName: updatedByIdx !== undefined ? parseSenderName(row[updatedByIdx]) : "",
      timestampMs: parseTimestampToMs(createdTsIdx !== undefined ? row[createdTsIdx] : ""),
      updatedTimestampMs: parseTimestampToMs(updatedTsIdx !== undefined ? row[updatedTsIdx] : ""),
      status: status || "open",
    });
  });

  result.matched = result.toCreate.length + result.toClose.length;

  if (dryRun) return result;

  // LLM batch classification — derives level / residualLocation / issueType /
  // subtype / roottype / rootcause for every toCreate row in one call. The map
  // is keyed by rowNumber; absent entries fall back to defaults below.
  let classifications = new Map();
  if (result.toCreate.length) {
    classifications = await classifyIssuesForNovade(
      result.toCreate.map((i) => ({
        rowNumber: i.rowNumber,
        description: i.description,
        location: i.location,
        category: i.category,
        severity: i.severity,
        status: i.status,
      })),
      units,
      issueTypes,
    );
    console.log(
      `[NovadeSync] LLM classified ${classifications.size}/${result.toCreate.length} rows for "${sheetName}".`,
    );
  }

  // Create flow (batched)
  const createResults = [];
  const safeBatch =
    Number.isFinite(Number(batchSize)) && Number(batchSize) > 0 ? Number(batchSize) : DEFAULT_BATCH_SIZE;

  for (let i = 0; i < result.toCreate.length; i += safeBatch) {
    const batch = result.toCreate.slice(i, i + safeBatch);
    const batchResults = [];
    for (const issue of batch) {
      try {
        // Reporter's mapped subcon if known, else the project's main contractor
        // (from the live Novade API). The status-2 (WIP) close transition
        // REQUIRES a contractorid — env default is absent in prod, so the API
        // maincon is the real source.
        const contractorId = resolvePICToContractorId(issue.reporterName, novadeCompanies) || defaultContractorId;
        // Fuzzy-match the WhatsApp reporter against known Novade actors;
        // fall back to NOVADE_DEFAULT_ACTOR (verified valid) on no match.
        const lodgedBy = resolveNovadeActor(issue.reporterName, novadeActors) || defaultActor;

        // LLM enrichment: level → unitid, residualLocation, issueType, etc.
        // Falls back to handler defaults when classification missing for this row.
        const cls = classifications.get(issue.rowNumber);
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
          date: issue.timestampMs,
          status: 1,
          risklevel: riskLevel,
          ...(contractorId ? { contractorid: contractorId } : {}),
          ...(process.env.NOVADE_DEFAULT_CCIDS ? { ccids: process.env.NOVADE_DEFAULT_CCIDS } : {}),
        };

        const createResp = await createSafetyAction(payload);
        const recId = extractNovadeRecId(createResp);
        if (!recId) throw new Error("Could not extract Novade Action Id from create response");

        // NCR-fields PATCH — sets subtype/roottype/rootcause from LLM (or fallbacks).
        // We DO NOT send isNCR:1 here: this project doesn't have Non-Conformity
        // enabled, and including the flag makes the entire PATCH 400, which would
        // also drop the three NCR fields. With isNCR omitted, the three fields
        // succeed even though the action ends up with isNCR:0.
        try {
          await patchSafetyAction(recId, {
            roottype: cls?.roottype || "Unsafe Conditions",
            rootcause: cls?.rootcause || "Absence of Safety Means",
            subtype: cls?.subtype || "Unsafe Condition",
          });
        } catch (e) {
          console.warn(`[NovadeSync] NCR-fields patch failed for ${recId}:`, e?.message || e);
        }

        if (issue.mediaUrl) {
          try {
            await uploadFileWithSupabaseRetry(issue.mediaUrl, {
              description: issue.description,
              linkedTable: LINKED_TABLE,
              linkedRecId: recId,
            });
          } catch (e) {
            console.warn(`[NovadeSync] before-photo upload failed for ${recId}:`, e?.message || e);
          }
        }

        createResults.push({ rowNumber: issue.rowNumber, recId });
        batchResults.push({ rowNumber: issue.rowNumber, recId });

        // Same-run close: if the sheet row is already "closed", queue the
        // freshly-created action for the close-lifecycle pass below so Novade
        // state matches the sheet in a single backfill run. Pass the
        // LLM-derived NCR fields through so closeSafetyAction doesn't overwrite
        // them with the generic fallbacks.
        if (issue.status === "closed") {
          result.toClose.push({
            sheetName,
            rowNumber: issue.rowNumber,
            novadeId: recId,
            afterMediaUrl: issue.afterMediaUrl,
            // closedTimestampMs = when the issue was closed (Updated Timestamp).
            // createdTimestampMs = when it was first reported (Created Timestamp,
            // i.e., issue.timestampMs).
            closedTimestampMs: Number.isFinite(issue.updatedTimestampMs) ? issue.updatedTimestampMs : issue.timestampMs,
            createdTimestampMs: issue.timestampMs,
            category: resolvedType,
            updatedByName: issue.updatedByName,
            contractorId, // carry the resolved contractor into the close (status-2 needs it)
            rootType: cls?.roottype,
            rootCause: cls?.rootcause,
            subType: cls?.subtype,
            freshlyCreated: true, // skip the GET pre-check — we know it's status=1
          });
        }
      } catch (error) {
        result.failures.push({
          kind: "create",
          sheetName,
          rowNumber: issue.rowNumber,
          error: error?.response?.data ? JSON.stringify(error.response.data) : error?.message || String(error),
        });
      }
    }

    // Per-batch writeback. Persist this batch's Novade IDs before processing
    // the next batch so a Lambda timeout or partial failure leaves at most
    // `safeBatch` orphan actions (vs. the entire run if the writeback only
    // happened at the end of all batches).
    if (batchResults.length) {
      const batchUpdates = batchResults.map((r) => ({ row: r.rowNumber, col: novadeIdIdx, value: r.recId }));
      try {
        await batchUpdateCells(spreadsheetId, sheetName, batchUpdates);
      } catch (error) {
        console.error(`[NovadeSync] per-batch writeback on "${sheetName}" failed:`, error?.message || error);
        result.failures.push({
          kind: "writeback",
          sheetName,
          rowNumbers: batchResults.map((r) => r.rowNumber),
          error: error?.message || String(error),
        });
      }
    }
  }

  // Close flow — handles BOTH:
  //   (a) previously-synced rows whose status is now "closed" (cross-day close)
  //   (b) freshly-created rows whose sheet status was already "closed" at backfill time
  for (const closeRow of result.toClose) {
    try {
      let alreadyClosed = false;
      // Skip pre-check for freshly-created actions — we know they're at status=1
      if (!closeRow.freshlyCreated) {
        try {
          const action = await getSafetyActionById(closeRow.novadeId);
          const currentStatus = Number(action?.status ?? action?.data?.status ?? action?.data?.data?.status);
          if (currentStatus === 7) alreadyClosed = true;
        } catch (e) {
          console.warn(`[NovadeSync] could not GET action ${closeRow.novadeId}:`, e?.message || e);
        }
      }

      if (alreadyClosed) {
        result.skipped.push({
          sheetName,
          rowNumber: closeRow.rowNumber,
          reason: "Novade action already closed (status=7)",
        });
        continue;
      }

      // Resolve the closer's name: fuzzy-match the sheet's "Updated By" (e.g.,
      // "Ali Ahammad") against known Novade actors. If no match, closeSafetyAction
      // falls back to NOVADE_DEFAULT_ACTOR (currently "WL API", verified valid).
      const resolvedActor = resolveNovadeActor(closeRow.updatedByName, novadeActors) || undefined;
      await closeSafetyAction(closeRow.novadeId, {
        // confirmation/target anchor on Created Timestamp; completion/closing
        // anchor on Updated Timestamp. Falls back to a single timestamp if
        // either is missing so older callers stay compatible.
        createdTimestampMs: closeRow.createdTimestampMs,
        closedTimestampMs: closeRow.closedTimestampMs,
        actionType: closeRow.category,
        confirmedBy: resolvedActor,
        completedBy: resolvedActor,
        closedBy: resolvedActor,
        // Novade's status-1→2 (WIP) transition REQUIRES a contractorid. Use the
        // same-run create's resolved contractor when present, else the project's
        // main contractor (from the API). Cross-day closes (no carried id) fall
        // straight to defaultContractorId.
        contractorId: closeRow.contractorId || defaultContractorId,
        // LLM-derived NCR fields (only set for same-run closes; cross-day
        // closes leave these undefined → closeSafetyAction's existing fallback
        // values kick in).
        rootType: closeRow.rootType,
        rootCause: closeRow.rootCause,
        subType: closeRow.subType,
      });
      result.closed += 1;

      if (closeRow.afterMediaUrl) {
        try {
          await uploadFileWithSupabaseRetry(closeRow.afterMediaUrl, {
            description: "After rectification",
            linkedTable: LINKED_TABLE,
            linkedRecId: closeRow.novadeId,
            ...(afterRectFolderId ? { folderId: afterRectFolderId } : {}),
          });
        } catch (e) {
          console.warn(`[NovadeSync] after-photo upload failed for ${closeRow.novadeId}:`, e?.message || e);
        }
      }
    } catch (error) {
      result.failures.push({
        kind: "close",
        sheetName,
        rowNumber: closeRow.rowNumber,
        novadeId: closeRow.novadeId,
        error: error?.response?.data ? JSON.stringify(error.response.data) : error?.message || String(error),
      });
    }
  }

  // Writeback now happens per-batch above (right after each batch of creates),
  // not in a single end-of-run flush. This caps the orphan-action blast radius
  // to one batch if the Lambda dies mid-run.
  result.created = createResults.length;

  return result;
}

async function handler(requestBody = {}) {
  const startMs = Date.now();
  const {
    date,
    backfill = false,
    dryRun = false,
    batchSize = DEFAULT_BATCH_SIZE,
    limit, // cap N rows per sheet (test-mode safety; falsy = unlimited)
  } = requestBody;

  // Spreadsheet, sheet name, and project name are env-only (no body overrides).
  // Spreadsheet → SAFETY_SPREADSHEET_ID env.
  // Sheet → "Safety" current-month tab in daily mode; auto-discovered in backfill.
  // Project → NOVADE_PROJECT_NAME env (e.g. "[TESTING] MBS-IR2"), falls back to
  //           DEFAULT_PROJECT_NAME ("MBS-IR2") when env is unset. To switch
  //           between test and prod: edit .env / Lambda env config.
  const spreadsheetId = process.env.SAFETY_SPREADSHEET_ID;
  const targetDate = (date && normalizeDateValue(date)) || getTodaySGT();
  const projectName = process.env.NOVADE_PROJECT_NAME || DEFAULT_PROJECT_NAME;
  const defaultActor = process.env.NOVADE_DEFAULT_ACTOR || "WL API";

  if (!spreadsheetId) {
    return { success: false, error: "SAFETY_SPREADSHEET_ID env var is not set" };
  }

  // 1. Resolve sheet list
  let sheetNames;
  if (backfill) {
    try {
      sheetNames = await discoverSafetyTabs(spreadsheetId);
    } catch (e) {
      return { success: false, error: `Failed to list sheet tabs: ${e?.message || e}` };
    }
    if (!sheetNames.length) {
      return { success: false, error: "No tabs matching /^Safety(-MMM YYYY)?$/ found in spreadsheet" };
    }
  } else {
    // Daily mode: current "Safety" tab. On the 1st of the month, ALSO scan
    // the just-archived previous-month tab so closes that landed in the last
    // few days of the previous month still get propagated even after the
    // monthly rotation moved them out of "Safety".
    sheetNames = [DEFAULT_SHEET_NAME];
    if (/-01$/.test(targetDate)) {
      const prevTab = previousMonthSafetyTab(targetDate);
      if (prevTab) {
        try {
          const allTabs = await getSheetNames(spreadsheetId);
          if (allTabs.includes(prevTab)) sheetNames.push(prevTab);
        } catch (e) {
          console.warn(`[NovadeSync] could not list tabs to add previous-month tab "${prevTab}":`, e?.message || e);
        }
      }
    }
  }

  // 2. Resolve project / unit / companies once (cached internally too).
  const projectId = await resolveProjectIdByName(projectName);
  if (!projectId) {
    return {
      success: false,
      error: `Could not resolve Novade project ID for name "${projectName}".`,
    };
  }
  const unitId = await resolveUnitIdForProject(projectId);
  if (!unitId) {
    return {
      success: false,
      error: `Could not resolve Novade unit ID for project ${projectId}. Set NOVADE_UNIT_ID env var as fallback.`,
    };
  }
  let novadeCompanies = [];
  try {
    novadeCompanies = await listCompanies();
  } catch (e) {
    console.warn(`[NovadeSync] listCompanies failed (PIC resolution disabled):`, e?.message || e);
  }

  // Build the implicit Novade user list from action history (no /people/users
  // endpoint exists). Used for fuzzy-matching sheet "Sender" / "Updated By"
  // names → real Novade actor strings. Empty list ⇒ everyone falls back to
  // NOVADE_DEFAULT_ACTOR.
  let novadeActors = [];
  try {
    // Pass projectId so the actor list is per-project — actors from other
    // projects (e.g., a name only used on the test project) would otherwise
    // fuzzy-match here and then 400 the close PATCH with "person not assigned
    // to the project".
    novadeActors = await listNovadeActorsFromHistory({ projectId });
  } catch (e) {
    console.warn(`[NovadeSync] listNovadeActorsFromHistory failed:`, e?.message || e);
  }
  // Merge in the hardcoded per-project assignee list (config/novade-assignees.js).
  // This is the primary fuzzy-match source — it covers everyone Novade has
  // assigned to the project, not just those who happen to have closed something
  // recently. Action history acts as a complement (catches any new assignees
  // who aren't in the hardcoded list yet).
  const hardcodedAssignees = getKnownAssigneesForProject(projectId);
  if (hardcodedAssignees.length) {
    const seen = new Set(novadeActors.map((a) => String(a).toLowerCase()));
    for (const name of hardcodedAssignees) {
      if (!seen.has(String(name).toLowerCase())) {
        novadeActors.push(name);
        seen.add(String(name).toLowerCase());
      }
    }
  }

  // Pre-fetch units (for level-name → unitid mapping) and issue types
  // (for sheet category → Novade type matching). Both used by the LLM
  // classifier to constrain its enum outputs.
  let units = [];
  try {
    units = await listUnitsForProjectCached(projectId);
  } catch (e) {
    console.warn(`[NovadeSync] listUnitsForProjectCached failed:`, e?.message || e);
  }
  let issueTypes = [];
  try {
    issueTypes = await listSafetyIssueTypesCached();
  } catch (e) {
    console.warn(`[NovadeSync] listSafetyIssueTypesCached failed:`, e?.message || e);
  }

  // Resolve the After-Rectification photo folder ID dynamically from project
  // options (Novade stores it as projNCRAfterFolderId). Env var still wins for
  // explicit overrides. Without this, after-photos land in "Before Rectification".
  let afterRectFolderId = process.env.NOVADE_AFTER_RECTIFICATION_FOLDER_ID;
  if (!afterRectFolderId) {
    try {
      const project = await getProjectById(projectId);
      const opts = project?.options ? JSON.parse(project.options) : {};
      if (opts?.projNCRAfterFolderId) afterRectFolderId = opts.projNCRAfterFolderId;
    } catch (e) {
      console.warn(`[NovadeSync] could not auto-resolve projNCRAfterFolderId:`, e?.message || e);
    }
  }

  // 3. Process each sheet, aggregate
  const perSheet = [];
  let createdTotal = 0;
  let closedTotal = 0;
  let scannedTotal = 0;
  let matchedTotal = 0;
  const skipped = [];
  const failures = [];
  const toCreate = [];
  const toClose = [];
  const headerCreatedOn = [];

  for (const sheetName of sheetNames) {
    const r = await processSheet({
      spreadsheetId,
      sheetName,
      targetDate,
      backfill,
      dryRun,
      batchSize,
      projectId,
      unitId,
      units,
      issueTypes,
      novadeCompanies,
      novadeActors,
      defaultActor,
      afterRectFolderId,
      limit,
    });

    if (r.error) {
      failures.push({ kind: "sheet", sheetName, error: r.error });
    }
    if (r.createdNovadeIdHeader) headerCreatedOn.push(sheetName);

    scannedTotal += r.scanned;
    matchedTotal += r.matched;
    createdTotal += r.created;
    closedTotal += r.closed;
    skipped.push(...r.skipped);
    failures.push(...r.failures);
    if (dryRun) {
      toCreate.push(...r.toCreate);
      toClose.push(...r.toClose);
    }
    perSheet.push({
      sheetName: r.sheetName,
      scanned: r.scanned,
      matched: r.matched,
      created: r.created,
      closed: r.closed,
      skipped: r.skipped.length,
      failures: r.failures.length,
      createdNovadeIdHeader: r.createdNovadeIdHeader,
      error: r.error,
    });
  }

  return {
    success: true,
    mode: backfill ? "backfill" : "daily",
    targetDate: backfill ? null : targetDate,
    projectId,
    unitId,
    sheetNames,
    perSheet,
    scanned: scannedTotal,
    matched: matchedTotal,
    created: createdTotal,
    closed: closedTotal,
    skipped,
    failures,
    headerCreatedOn,
    novadeActorsKnown: novadeActors.length,
    afterRectFolderIdResolved: afterRectFolderId || null,
    unitsKnown: units.length,
    issueTypesKnown: issueTypes.length,
    ...(limit ? { limit } : {}),
    ...(dryRun ? { dryRun: true, toCreate, toClose } : {}),
    durationMs: Date.now() - startMs,
  };
}

module.exports = { handler };
