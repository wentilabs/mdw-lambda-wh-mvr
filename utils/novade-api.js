// Novade HTTP client for safety-action sync.
// Ported from mdw-lambda-boustead-safety/utils/novade-api.js, simplified for the
// "actions only" flow (no inspection-form helpers).

const axios = require("axios");
const path = require("path");

const DEFAULT_BASE_URL = "https://s1api.novade.net";
const DEFAULT_NOVADE_STATUS = 1; // open

let cachedToken = null;
let cachedAtMs = 0;

let cachedCompanies = null;
let cachedCompaniesAtMs = 0;
const COMPANIES_CACHE_TTL_MS = 5 * 60 * 1000;

let cachedProjects = null;
let cachedProjectsAtMs = 0;
const PROJECTS_CACHE_TTL_MS = 5 * 60 * 1000;

let cachedUnitsByProject = new Map();
const UNITS_CACHE_TTL_MS = 5 * 60 * 1000;

function readEnv(name) {
  const direct = process.env[name];
  if (direct) return direct;
  const lower = process.env[name.toLowerCase()];
  if (lower) return lower;
  return undefined;
}

function getNovadeBaseUrl() {
  return readEnv("NOVADE_BASE_URL") || DEFAULT_BASE_URL;
}

function getTokenUrl() {
  const explicit = readEnv("NOVADE_TOKEN_URL");
  if (explicit) return explicit;
  const baseUrl = getNovadeBaseUrl();
  const tokenPath = readEnv("NOVADE_TOKEN_PATH") || "/token";
  return `${baseUrl}${tokenPath.startsWith("/") ? "" : "/"}${tokenPath}`;
}

function getTimeoutMs() {
  const raw = readEnv("NOVADE_TIMEOUT_MS");
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30000;
}

function getTokenTtlMs() {
  const raw = readEnv("NOVADE_TOKEN_TTL_MS");
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function getCredentials() {
  const username = readEnv("NOVADE_EMAIL") || readEnv("NOVADE_USERNAME");
  const password = readEnv("NOVADE_PASSWORD") || readEnv("NOVADE_PASSWRD");
  return { username, password };
}

function isTokenExpired() {
  const ttlMs = getTokenTtlMs();
  if (!ttlMs) return false;
  if (!cachedAtMs) return true;
  return Date.now() - cachedAtMs > ttlMs;
}

async function genAccessToken({ forceRefresh = false } = {}) {
  if (!forceRefresh && cachedToken && !isTokenExpired()) {
    return cachedToken;
  }

  const { username, password } = getCredentials();
  if (!username || !password) {
    throw new Error("Missing Novade credentials: set NOVADE_EMAIL/NOVADE_PASSWORD.");
  }

  const tokenUrl = getTokenUrl();
  const authHeader = Buffer.from(`${username}:${password}`).toString("base64");

  const response = await axios.get(tokenUrl, {
    headers: {
      Authorization: `Basic ${authHeader}`,
      Accept: "application/json",
    },
    timeout: getTimeoutMs(),
  });

  const token =
    response?.data?.token ||
    response?.data?.access_token ||
    response?.data?.data?.token ||
    response?.data?.data?.access_token;

  if (!token) {
    throw new Error("Novade token response did not include a token.");
  }

  cachedToken = token;
  cachedAtMs = Date.now();
  return token;
}

function clearCachedToken() {
  cachedToken = null;
  cachedAtMs = 0;
}

async function novadeRequest(method, urlPath, { params, data, headers } = {}) {
  const baseUrl = getNovadeBaseUrl();
  const url = urlPath.startsWith("http") ? urlPath : `${baseUrl}${urlPath.startsWith("/") ? "" : "/"}${urlPath}`;

  const sendOnce = async (forceRefresh) => {
    const token = await genAccessToken({ forceRefresh });
    return axios({
      method,
      url,
      params,
      data,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(data ? { "Content-Type": "application/json" } : {}),
        ...(headers || {}),
      },
      timeout: getTimeoutMs(),
    });
  };

  try {
    const response = await sendOnce(false);
    return response.data;
  } catch (error) {
    const status = error?.response?.status;
    if (status === 401 || status === 403) {
      // Token may have expired (TTL is 0 by default — cached forever otherwise).
      // Force a refresh and retry once. Any caller-level retry can still wrap us.
      console.warn(`[Novade] ${status} on ${method} ${urlPath} — refreshing token and retrying once.`);
      clearCachedToken();
      const response = await sendOnce(true);
      return response.data;
    }
    throw error;
  }
}

function extractNovadeRecId(response) {
  if (!response) return null;
  if (Array.isArray(response)) {
    return extractNovadeRecId(response[0]);
  }
  const candidates = [
    response.recid,
    response.recId,
    response.id,
    response.recordid,
    response.recordId,
    response?.data?.recid,
    response?.data?.recId,
    response?.data?.id,
    response?.data?.recordid,
    response?.data?.recordId,
    response?.data?.data?.recid,
    response?.data?.data?.recId,
    response?.data?.data?.id,
  ];
  return candidates.find((value) => value) || null;
}

function parseTimestampToMs(rawTimestamp) {
  if (rawTimestamp === null || rawTimestamp === undefined || rawTimestamp === "") return Date.now();
  if (typeof rawTimestamp === "number") {
    return rawTimestamp < 10000000000 ? rawTimestamp * 1000 : rawTimestamp;
  }
  let str = String(rawTimestamp).trim();
  // Strip surrounding apostrophes/quotes. Google Sheets uses a LEADING apostrophe
  // to force-text a value ('02-Jan-2025 14:03). This safety sheet's timestamps
  // also carry a TRAILING apostrophe ("18-May-2026 11:23'") — without stripping
  // it, `new Date("18-May-2026 11:23' +0800")` is Invalid Date and the function
  // silently falls back to Date.now() (today), corrupting EVERY Novade create
  // date + confirmation date (both the cron and the QA-bypass sync). Strip both
  // ends so the real timestamp survives.
  str = str.replace(/^['"`‘’\s]+|['"`‘’\s]+$/g, "");

  // If it's a SGT-formatted human timestamp (DD-MMM-YYYY HH:MM[:SS]), append +08:00 so it parses as SGT
  if (/^\d{2}-[A-Za-z]{3}-\d{4}/.test(str) && !/[+-]\d{2}:?\d{2}$/.test(str)) {
    str = str + " +0800";
  }

  const asNumber = Number(str);
  if (Number.isFinite(asNumber)) {
    return asNumber < 10000000000 ? asNumber * 1000 : asNumber;
  }
  const parsed = new Date(str);
  return Number.isNaN(parsed.getTime()) ? Date.now() : parsed.getTime();
}

function extractFilenameFromUrl(mediaUrl) {
  if (!mediaUrl) return "";
  try {
    const url = new URL(mediaUrl);
    const base = path.basename(url.pathname || "");
    return base && base !== "/" ? base : "";
  } catch (error) {
    return "";
  }
}

function ensureFilenameHasExtension(filename, extension) {
  if (!filename) return "";
  const allowedExtensions = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "tiff"]);
  const ext = path.extname(filename || "");
  const extClean = ext.replace(/^\./, "").trim().toLowerCase();
  if (extClean && allowedExtensions.has(extClean)) return filename;
  if (!extension) return filename;
  return `${filename}.${extension}`;
}

function extensionFromContentType(contentType, fallbackExtension = "") {
  if (!contentType) return "";
  const normalized = contentType.split(";")[0].trim().toLowerCase();
  switch (normalized) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/bmp":
      return "bmp";
    case "image/tiff":
      return "tiff";
    default:
      if (!fallbackExtension) return "";
      return fallbackExtension.replace(/^\./, "").trim().toLowerCase();
  }
}

async function fetchMediaAsBase64(mediaUrl) {
  const response = await axios.get(mediaUrl, {
    responseType: "arraybuffer",
    timeout: getTimeoutMs(),
    // Some image hosts (Wikimedia, Supabase signed URLs behind WAFs) reject
    // requests without a real User-Agent. Set one to avoid 403s.
    headers: {
      "User-Agent": "wentilabs-novade-sync/1.0 (+https://wentilabs.com)",
      Accept: "image/*",
    },
  });

  const contentType = response?.headers?.["content-type"] || "";
  const base64 = Buffer.from(response.data || "").toString("base64");
  return { base64, contentType };
}

// Safety: Projects -------------------------------------------------------

function listSafetyProjects() {
  return novadeRequest("get", "/safety/projects");
}

async function listProjectsCached({ forceRefresh = false } = {}) {
  if (!forceRefresh && cachedProjects && Date.now() - cachedProjectsAtMs < PROJECTS_CACHE_TTL_MS) {
    return cachedProjects;
  }
  const result = await listSafetyProjects();
  cachedProjects = Array.isArray(result) ? result : result?.data || [];
  cachedProjectsAtMs = Date.now();
  return cachedProjects;
}

async function resolveProjectIdByName(projectName) {
  if (!projectName) return null;
  const target = String(projectName).trim().toLowerCase();
  const projects = await listProjectsCached();
  // Try exact match first (case-insensitive), then includes match
  const exact = projects.find(
    (p) =>
      String(p?.name || p?.projectName || "")
        .trim()
        .toLowerCase() === target,
  );
  if (exact) return exact.id || exact.recid || exact.projectid || null;
  const fuzzy = projects.find((p) =>
    String(p?.name || p?.projectName || "")
      .trim()
      .toLowerCase()
      .includes(target),
  );
  if (fuzzy) return fuzzy.id || fuzzy.recid || fuzzy.projectid || null;
  return null;
}

// Quality: Units ---------------------------------------------------------

function listQualityUnits() {
  return novadeRequest("get", "/quality/units");
}

async function listUnitsForProjectCached(projectId, { forceRefresh = false } = {}) {
  if (!projectId) return [];
  const cached = cachedUnitsByProject.get(projectId);
  if (!forceRefresh && cached && Date.now() - cached.atMs < UNITS_CACHE_TTL_MS) {
    return cached.units;
  }
  const all = await listQualityUnits();
  const arr = Array.isArray(all) ? all : all?.data || [];
  // Units in Novade typically reference a project via projectid/projectId
  const filtered = arr.filter((u) => {
    const pid = u?.projectid || u?.projectId || u?.project || "";
    return String(pid) === String(projectId);
  });
  // If filter yields none (some Novade tenants don't expose projectid on units), fall back to all units
  const units = filtered.length ? filtered : arr;
  cachedUnitsByProject.set(projectId, { units, atMs: Date.now() });
  return units;
}

/**
 * GET /projects/{id} — returns the full project record. The `options` field is
 * a JSON string; callers can parse it for embedded settings like
 * `projNCRAfterFolderId` (the After-Rectification photo folder).
 */
function getProjectById(projectId) {
  if (!projectId) throw new Error("getProjectById: projectId required");
  return novadeRequest("get", `/projects/${encodeURIComponent(projectId)}`);
}

async function resolveUnitIdForProject(projectId) {
  const envOverride = readEnv("NOVADE_UNIT_ID");
  const units = await listUnitsForProjectCached(projectId);
  if (envOverride) {
    // Only honor the override if it's actually a unit on THIS project. The env
    // value is project-specific (test project 110-122 vs prod 97-109), so a
    // stale override silently corrupts created actions when the project changes.
    const isValid = units.some(
      (u) =>
        String(u?.id) === String(envOverride) ||
        String(u?.recid) === String(envOverride) ||
        String(u?.unitid) === String(envOverride),
    );
    if (isValid) return envOverride;
    console.warn(
      `[novade-api] NOVADE_UNIT_ID=${envOverride} is not a unit of project ${projectId}; ` +
        `falling back to the first unit. Update or unset the env var to silence this warning.`,
    );
  }
  if (!units.length) return null;
  const first = units[0];
  return first?.id || first?.recid || first?.unitid || null;
}

// People: Companies ------------------------------------------------------

async function listCompanies({ forceRefresh = false } = {}) {
  if (!forceRefresh && cachedCompanies && Date.now() - cachedCompaniesAtMs < COMPANIES_CACHE_TTL_MS) {
    return cachedCompanies;
  }
  const result = await novadeRequest("get", "/people/companies");
  cachedCompanies = Array.isArray(result) ? result : result?.data || [];
  cachedCompaniesAtMs = Date.now();
  return cachedCompanies;
}

// Safety: Action-history-derived actor list -----------------------------
// Novade exposes no /people/users endpoint (probed 40+ paths, all 404).
// Closest proxy for "valid actor names" is the set of distinct strings already
// used in the action records' lodgedby / confirmedby / completedby / closedby
// fields.
//
// CRITICAL: actor validity is PER-PROJECT — Novade rejects close PATCHes when
// the actor isn't assigned to the action's project. So we MUST filter the
// account-wide action history by projectId; otherwise actors from one project
// (e.g., a test-only "Ali Ahammad" lodgedby) leak into another project's
// fuzzy-match list and break closes there.
//
// Cache is keyed by projectId. Pass `projectId: null` to get the unfiltered
// (account-wide) list — useful for diagnostics, never for the close flow.

const _cachedNovadeActors = new Map(); // key: String(projectId || "*")  → { list, atMs }
const NOVADE_ACTORS_CACHE_TTL_MS = 5 * 60 * 1000;
const NOVADE_ACTORS_LOOKBACK_MS = 365 * 24 * 60 * 60 * 1000; // 1 year

async function listNovadeActorsFromHistory({ forceRefresh = false, projectId = null } = {}) {
  const cacheKey = String(projectId || "*");
  const cached = _cachedNovadeActors.get(cacheKey);
  if (!forceRefresh && cached && Date.now() - cached.atMs < NOVADE_ACTORS_CACHE_TTL_MS) {
    return cached.list;
  }

  const fromMs = Date.now() - NOVADE_ACTORS_LOOKBACK_MS;
  let actions = [];
  try {
    const r = await novadeRequest("get", `/safety/since/actions/${fromMs}`);
    actions = Array.isArray(r) ? r : r?.data || [];
  } catch (e) {
    console.warn(`[novade-api] listNovadeActorsFromHistory failed:`, e?.message || e);
    _cachedNovadeActors.set(cacheKey, { list: [], atMs: Date.now() });
    return [];
  }

  // Filter to the requested project so actors from other projects don't leak in.
  if (projectId) {
    actions = actions.filter((a) => String(a?.projectid) === String(projectId));
  }

  // CRITICAL: only collect from fields Novade actually validates against the
  // project's assigned-people list. `lodgedby` is lenient — any string is
  // accepted on POST — so it can contain names that aren't valid closers.
  // Including `lodgedby` here would pollute the closer-fuzzy-match list.
  const fields = ["confirmedby", "completedby", "closedby"];
  const set = new Set();
  for (const a of actions) {
    for (const f of fields) {
      const v = a?.[f];
      if (typeof v === "string" && v.trim()) {
        // Novade sometimes returns "Name|contractorid" — split and keep the head
        const head = v.split("|")[0].trim();
        if (head) set.add(head);
      }
    }
  }
  const list = [...set];
  _cachedNovadeActors.set(cacheKey, { list, atMs: Date.now() });
  return list;
}

// Safety: Actions --------------------------------------------------------

function getSafetyActionById(id) {
  return novadeRequest("get", `/safety/actions/${encodeURIComponent(id)}`);
}

function listSafetyIssueTypes() {
  return novadeRequest("get", "/safety/issuetypes");
}

let cachedSafetyIssueTypes = null;
let cachedSafetyIssueTypesAtMs = 0;
const SAFETY_ISSUE_TYPES_TTL_MS = 5 * 60 * 1000;

async function listSafetyIssueTypesCached({ forceRefresh = false } = {}) {
  if (!forceRefresh && cachedSafetyIssueTypes && Date.now() - cachedSafetyIssueTypesAtMs < SAFETY_ISSUE_TYPES_TTL_MS) {
    return cachedSafetyIssueTypes;
  }
  const r = await listSafetyIssueTypes();
  cachedSafetyIssueTypes = Array.isArray(r) ? r : r?.data || [];
  cachedSafetyIssueTypesAtMs = Date.now();
  return cachedSafetyIssueTypes;
}

function createSafetyAction(payload) {
  return novadeRequest("post", "/safety/newaction", { data: payload });
}

function patchSafetyAction(actionId, payload) {
  return novadeRequest("patch", `/safety/actions/${encodeURIComponent(actionId)}`, { data: payload });
}

async function closeSafetyAction(
  actionId,
  {
    timestampMs, // legacy single-ts arg — used as a fallback when the new ones are missing
    createdTimestampMs,
    closedTimestampMs,
    confirmedBy,
    completedBy,
    closedBy,
    contractorId,
    actionType,
    rootType,
    rootCause,
    subType,
    correctiveAction,
  } = {},
) {
  if (!actionId) return { skipped: true, reason: "missing_action_id" };
  // Resolve both timestamps. Either may be absent for older callers — fall back
  // to the legacy single `timestampMs`.
  const fallbackTs = Number.isFinite(timestampMs) ? timestampMs : parseTimestampToMs(timestampMs);
  const createdMs = Number.isFinite(createdTimestampMs) ? createdTimestampMs : fallbackTs;
  const closedMs = Number.isFinite(closedTimestampMs) ? closedTimestampMs : fallbackTs;
  // Confirmation rides with the original report time so Novade's lifecycle
  // dates line up with the sheet (issue raised → confirmed at the same instant
  // for backfill). Target completion sits 4h after — a realistic in-day
  // rectification window — so the UI doesn't show "target = same instant as
  // confirmation".
  const TARGET_OFFSET_MS = 4 * 60 * 60 * 1000;
  const fallbackActor = readEnv("NOVADE_DEFAULT_ACTOR") || "WL API";
  const fallbackContractor = readEnv("NOVADE_DEFAULT_CONTRACTOR_ID");
  const fallbackRootType = readEnv("NOVADE_DEFAULT_ROOTTYPE") || "Unsafe Conditions";
  const fallbackRootCause = readEnv("NOVADE_DEFAULT_ROOTCAUSE") || "Absence of Safety Means";
  const fallbackSubType = readEnv("NOVADE_DEFAULT_SUBTYPE") || "Unsafe Condition";

  const resolvedContractor = contractorId || fallbackContractor;
  const resolvedActionType = actionType || readEnv("NOVADE_DEFAULT_ACTION_TYPE") || "General";

  // Status 1 → 2 (WIP/Confirmed). Novade requires roottype/rootcause/contractorid
  // here when NCR has not been pre-set on the action (i.e. Non-Conformity not
  // enabled at the project level).
  const payloads = [
    {
      status: 2,
      confirmationdate: createdMs,
      targetcompletion: createdMs + TARGET_OFFSET_MS,
      confirmedby: confirmedBy || fallbackActor,
      type: resolvedActionType,
      roottype: rootType || fallbackRootType,
      rootcause: rootCause || fallbackRootCause,
      subtype: subType || fallbackSubType,
      ...(correctiveAction ? { correctiveaction: correctiveAction } : {}),
      ...(resolvedContractor ? { contractorid: resolvedContractor } : {}),
    },
    {
      status: 5,
      completiondate: closedMs,
      completedby: completedBy || fallbackActor,
    },
    {
      status: 7,
      closingdate: closedMs,
      closedby: closedBy || fallbackActor,
    },
  ];

  let updated = null;
  for (const payload of payloads) {
    updated = await patchSafetyAction(actionId, payload);
  }
  return updated;
}

// Files ------------------------------------------------------------------

function uploadFile(payload) {
  return novadeRequest("post", "/files/upload", { data: payload });
}

async function uploadFileFromUrl(
  mediaUrl,
  { description = "", linkedTable, linkedRecId, kind, folderId, geo, extension } = {},
) {
  if (!mediaUrl) throw new Error("Missing mediaUrl for Novade upload.");
  if (!linkedTable) throw new Error("Missing linkedTable for Novade upload.");
  if (!linkedRecId) throw new Error("Missing linkedRecId for Novade upload.");

  const { base64, contentType } = await fetchMediaAsBase64(mediaUrl);
  if (!base64) throw new Error("Novade upload failed: media download returned empty content.");

  const filenameFromUrl = extractFilenameFromUrl(mediaUrl);
  const extensionFromHint = extension ? extension.replace(/^\./, "").trim().toLowerCase() : "";
  const resolvedExtension = extensionFromContentType(contentType, extensionFromHint);
  const filename = filenameFromUrl
    ? ensureFilenameHasExtension(filenameFromUrl, resolvedExtension)
    : `safety-${Date.now()}${resolvedExtension ? `.${resolvedExtension}` : ""}`;

  const uploadPayload = {
    filename,
    linkedtable: linkedTable,
    linkedrecid: linkedRecId,
    content: base64,
    description,
  };
  if (Number.isFinite(Number(kind)) && Number(kind) >= 0) uploadPayload.kind = Number(kind);
  if (folderId) uploadPayload.folderid = folderId;
  if (geo) uploadPayload.geo = geo;
  return uploadFile(uploadPayload);
}

function listFilesSince(timestampMs) {
  if (!Number.isFinite(timestampMs)) {
    throw new Error("listFilesSince requires a numeric timestamp (ms).");
  }
  return novadeRequest("get", `/files/since/${encodeURIComponent(timestampMs)}`);
}

module.exports = {
  // Auth
  genAccessToken,
  clearCachedToken,
  novadeRequest,
  // Helpers
  extractNovadeRecId,
  parseTimestampToMs,
  extractFilenameFromUrl,
  fetchMediaAsBase64,
  // Projects / Units / Companies
  listSafetyProjects,
  listProjectsCached,
  resolveProjectIdByName,
  listQualityUnits,
  listUnitsForProjectCached,
  resolveUnitIdForProject,
  getProjectById,
  listCompanies,
  listNovadeActorsFromHistory,
  // Actions
  listSafetyIssueTypes,
  listSafetyIssueTypesCached,
  getSafetyActionById,
  createSafetyAction,
  patchSafetyAction,
  closeSafetyAction,
  // Files
  uploadFile,
  uploadFileFromUrl,
  listFilesSince,
  // Constants
  DEFAULT_NOVADE_STATUS,
};
