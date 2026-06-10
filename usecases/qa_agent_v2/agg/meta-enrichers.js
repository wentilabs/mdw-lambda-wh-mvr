/**
 * Per-domain meta enrichers.
 *
 * The format-override templates (`format/overrides.js`) need richer context
 * than the generic AnswerData carries — TS/NTS values for Wohhup, per-work-type
 * Completed/Total for Piling, per-CJ stage list for Pile Cap, etc.
 *
 * Each enricher takes the raw `rows` returned by the data plugin and the
 * `intent`, and returns a small object that gets merged into `meta`. The
 * generic templates don't read these fields, so adding them is harmless.
 */

function enrichMeta(domain, rows, intent) {
  rows = rows || [];
  if (rows.length === 0) return {};
  switch (domain) {
    case "manpower":
      return enrichManpower(rows, intent);
    case "safety":
      return enrichSafety(rows, intent);
    default:
      return {};
  }
}

function enrichManpower(rows, intent) {
  const out = {};

  // 1) WH bundle (only when Company=Woh Hup filter is in play).
  const isWH = (intent?.filters || []).some(
    (f) =>
      f.field === "Company" &&
      String(f.value || "")
        .toLowerCase()
        .includes("woh"),
  );
  if (isWH) {
    const r = rows.find((row) => row.Source === "wohhup_tracker");
    if (r) {
      out.wh = {
        total: r.Total,
        engineer: r.Engineer,
        staff: r.Staff,
        worker: r.Worker,
        staffTS: r.StaffTS,
        staffNTS: r.StaffNTS,
        dayStaffTS: r.DayStaffTS,
        dayStaffNTS: r.DayStaffNTS,
        nightStaffTS: r.NightStaffTS,
        nightStaffNTS: r.NightStaffNTS,
        totalRegister: r.TotalRegister,
        workersOnSite: r.WorkersOnSite,
        homeLeave: r.HomeLeave,
        loanOut: r.LoanOut,
        loanIn: r.LoanIn,
        course: r.Course,
        medicalLeave: r.MedicalLeave,
        absent: r.Absent,
        dayOnSite: r.DayOnSite,
        nightOnSite: r.NightOnSite,
      };
    }
  }

  // 2) Role breakdown — parse Details JSON and aggregate per (Company, Role).
  //    Emitted ONLY when the parser group_bys by "Role". Otherwise it's noise
  //    in meta and the format override never reads it.
  const wantsRole = (intent?.group_by || []).some((g) => g.field === "Role");
  if (wantsRole) {
    out.roleBreakdown = computeRoleBreakdown(rows);
  }
  return out;
}

/**
 * Parse the Details JSON column on each sheet row and aggregate per
 * (Company, normalized-role). For Wohhup canonical rows (Source='wohhup_tracker'),
 * synthesize role buckets from the tracker subfields (Engineer / Staff TS /
 * Staff NTS / Worker on-site).
 *
 * Output shape:
 *   { 'LT SAMBO': [{label:'Site Supervisor', count:7}, ...], ... }
 * Each company's roles are sorted by count desc.
 */
function computeRoleBreakdown(rows) {
  const byCompany = new Map();

  for (const r of rows) {
    const company = r.Company;
    if (!company) continue;
    if (!byCompany.has(company)) byCompany.set(company, new Map());
    const roleMap = byCompany.get(company);

    if (r.Source === "wohhup_tracker") {
      // Wohhup: use tracker subfields as role buckets.
      // Prefer the most granular available subfields.
      const addRole = (label, count) => {
        if (count === null || count === undefined || count === 0) return;
        const key = label.toLowerCase();
        const prev = roleMap.get(key);
        roleMap.set(key, { label: prev?.label || label, count: (prev?.count || 0) + Number(count) });
      };
      if (r.Engineer != null && r.Engineer > 0) addRole("Engineer", r.Engineer);
      // Staff split into TS / NTS when both present, otherwise show single Staff.
      if (r.StaffTS != null && r.StaffTS > 0) addRole("Staff TS", r.StaffTS);
      if (r.StaffNTS != null && r.StaffNTS > 0) addRole("Staff NTS", r.StaffNTS);
      if (r.StaffTS == null && r.StaffNTS == null && r.Staff != null && r.Staff > 0) addRole("Staff", r.Staff);
      if (r.WorkersOnSite != null && r.WorkersOnSite > 0) addRole("Worker (on site)", r.WorkersOnSite);
      else if (r.Worker != null && r.Worker > 0) addRole("Worker", r.Worker);
      continue;
    }

    // Sheet row: parse Details JSON. Field-value parsing — regex on data is allowed.
    const details = r.Details;
    if (!details) continue;
    let parsed;
    try {
      parsed = typeof details === "string" ? JSON.parse(details) : details;
    } catch (_) {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    for (const [role, cnt] of Object.entries(parsed)) {
      const c = Number(cnt);
      if (!Number.isFinite(c) || c === 0) continue;
      const trimmed = String(role).trim();
      if (!trimmed) continue;
      // Normalize key for case/spacing-insensitive merge; keep first-seen label as display form.
      const key = trimmed.toLowerCase().replace(/\s+/g, " ");
      const prev = roleMap.get(key);
      roleMap.set(key, { label: prev?.label || trimmed, count: (prev?.count || 0) + c });
    }
  }

  // Convert to sorted array per company.
  const out = {};
  for (const [co, m] of byCompany.entries()) {
    const list = [...m.values()].sort((a, b) => b.count - a.count);
    if (list.length > 0) out[co] = list;
  }
  return out;
}

/**
 * Safety enrichment — always compute open + closed counts + breakdowns by
 * Severity / Status / Date / Category / Location / Sender. The formatter
 * decides WHICH breakdown(s) to render based on intent.group_by; this enricher
 * just computes them all so any compound shape is renderable.
 */
function enrichSafety(rows, intent) {
  const out = {
    safety: {
      total: rows.length,
      open: 0,
      closed: 0,
      severity: {},
      status: {},
      // 2D severity-by-status (status → severity → count). Used by the
      // comprehensive renderer to show "Open: 20 (4 P1, 12 P2, 4 P3)"
      // inline. Keys are the bucketed status ("open" / "closed" / "n/a").
      severityByStatus: { open: {}, closed: {}, "n/a": {} },
      date: {},
      category: {},
      location: {},
      sender: {},
    },
  };
  for (const r of rows) {
    const statusRaw = String(r.Status || "").toLowerCase();
    let statusBucket = "n/a";
    if (/open/.test(statusRaw)) {
      out.safety.open++;
      statusBucket = "open";
    } else if (/closed/.test(statusRaw)) {
      out.safety.closed++;
      statusBucket = "closed";
    }
    out.safety.status[statusRaw || "n/a"] = (out.safety.status[statusRaw || "n/a"] || 0) + 1;
    const sev = String(r.Severity || "N/A").toUpperCase();
    out.safety.severity[sev] = (out.safety.severity[sev] || 0) + 1;
    // 2D cross-tab
    out.safety.severityByStatus[statusBucket][sev] = (out.safety.severityByStatus[statusBucket][sev] || 0) + 1;
    const date = String(r.Date || "").trim();
    if (date) out.safety.date[date] = (out.safety.date[date] || 0) + 1;
    const cat = String(r.Category || "Uncategorized").trim() || "Uncategorized";
    out.safety.category[cat] = (out.safety.category[cat] || 0) + 1;
    const loc = String(r.Location || "").trim();
    if (loc) out.safety.location[loc] = (out.safety.location[loc] || 0) + 1;
    const sender = String(r.Sender || "").trim();
    if (sender) out.safety.sender[sender] = (out.safety.sender[sender] || 0) + 1;
  }
  return out;
}

module.exports = { enrichMeta };
