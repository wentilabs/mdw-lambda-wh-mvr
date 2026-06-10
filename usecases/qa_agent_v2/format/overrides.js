/**
 * Domain-specific format overrides.
 *
 * The generic renderer in `render.js` produces correct-but-bland output. For
 * domains where management expects a specific layout (Wohhup TS/NTS breakdown,
 * Piling daily summary, IM daily summary, Pile Cap status grid), we replicate
 * the legacy template verbatim so the cutover is invisible to users.
 *
 * Overrides return:
 *   - a string (use this as the message)
 *   - null (no override applies — fall through to generic)
 */

const { isoToDdMmm, formatDayLabel } = require("../shared/time-window");

/** Public dispatcher — called by render.js before its switch. */
function pickOverride(answer) {
  if (!answer || !answer.kind) return null;
  const domain = answer.meta?.domain;
  if (!domain) return null;
  const groupFields = (answer.meta?.intent?.group_by || []).map((g) => g.field);

  // ---------- Manpower / Wohhup specialty ----------
  if (domain === "manpower") {
    const m = answer.meta?.intent?.target_metric;
    const isWH = (answer.meta?.filters_applied || []).some(
      (f) =>
        f.field === "Company" &&
        String(f.value || "")
          .toLowerCase()
          .includes("woh"),
    );

    // Compound: group_by includes Role → render nested Company × Role.
    if (answer.kind === "distribution" && groupFields.includes("Role")) {
      return renderManpowerByCompanyRole(answer);
    }

    if (isWH) {
      // Single Wohhup specialty metric → bold-formatted line.
      if (answer.kind === "aggregate" && WH_SPECIALTY_METRIC_LABELS[m]) {
        return renderWohhupSingleMetric(answer, m);
      }
      if (answer.kind === "point_lookup" && WH_SPECIALTY_METRIC_LABELS[m]) {
        return renderWohhupSingleMetric(answer, m);
      }
      // Distribution → full breakdown templates.
      if (answer.kind === "distribution") {
        if (m === "staff_count" || m === "ts_count" || m === "nts_count") return renderWohhupStaffBreakdown(answer);
        if (
          m === "on_site_count" ||
          m === "home_leave_count" ||
          m === "loan_out_count" ||
          m === "loan_in_count" ||
          m === "course_count" ||
          m === "medical_leave_count" ||
          m === "absent_count" ||
          m === "total_register"
        ) {
          return renderWohhupWorkersRegister(answer);
        }
      }
    }
  }

  // ---------- Safety: comprehensive summary on distribution ----------
  // Compound safety questions ("how many total + how many closed + breakdown by severity")
  // are very common — render total/open/closed + the requested breakdown.
  if (domain === "safety" && answer.kind === "distribution") {
    return renderSafetyComprehensive(answer);
  }

  return null;
}

// ─────────────────────────── Wohhup specialty ──────────────────────────

const WH_SPECIALTY_METRIC_LABELS = {
  ts_count: { label: "Staff TS", note: "_(TS = Time Sheet — staff registered through the formal timesheet system)_" },
  nts_count: { label: "Staff NTS", note: "_(NTS = Non-Time Sheet — staff outside the formal timesheet system)_" },
  day_ts_count: { label: "Day Shift Staff TS" },
  day_nts_count: { label: "Day Shift Staff NTS" },
  night_ts_count: { label: "Night Shift Staff TS" },
  night_nts_count: { label: "Night Shift Staff NTS" },
  on_site_count: { label: "Workers on site" },
  home_leave_count: { label: "Workers on home leave" },
  loan_out_count: { label: "Workers loaned out" },
  loan_in_count: { label: "Workers loaned in" },
  course_count: { label: "Workers on course" },
  medical_leave_count: { label: "Workers on medical leave" },
  absent_count: { label: "Workers absent" },
  total_register: { label: "Total workers register" },
  engineer_count: { label: "Engineers on site" },
  staff_count: { label: "Staff total" },
  worker_count: { label: "Workers on site" },
};

function renderWohhupSingleMetric(answer, metric) {
  const def = WH_SPECIALTY_METRIC_LABELS[metric];
  const value = answer.value;
  const tw = answer.meta.time_window.label;
  if (value === null || value === undefined) {
    return `*Woh Hup ${def.label} on ${tw}:* (no message today)`;
  }
  const head = `*Woh Hup ${def.label} on ${tw}:* ${formatInt(value)}`;
  return def.note ? `${head}\n${def.note}` : head;
}

function renderWohhupStaffBreakdown(answer) {
  // The answer's rows contain only one effective Wohhup row per day. We pull
  // the underlying tracker values from meta.row_count > 0 + filters_applied.
  // Layer 4 hands us a single-group distribution; we use the meta context.
  const tw = answer.meta.time_window.label;
  // The aggregator gave us total via sum(Staff). We need the raw TS/NTS values
  // — they're in the rows that Layer 3 produced. But by the time we reach
  // Layer 5, raw rows are gone. Workaround: the distribution's `total` IS
  // sum(Staff) = TS+NTS, but we need TS and NTS separately.
  //
  // The cleanest way: read from breakdown rows if the LLM grouped by "Role"
  // (synthetic field). When the group_by is unknown to the data layer, the
  // aggregator falls back to a single bucket. In that case we render a
  // 2-line breakdown using the staff sub-fields exposed in `answer.meta.wh`.
  const wh = answer.meta?.wh || {};
  const ts = wh.staffTS;
  const nts = wh.staffNTS;
  const total = answer.total ?? (Number(ts) || 0) + (Number(nts) || 0);
  const lines = [`*Woh Hup Staff on ${tw}:*`];
  lines.push(`· TS (Time Sheet): ${ts == null ? "(no message)" : formatInt(ts)}`);
  lines.push(`· NTS (Non-Time Sheet): ${nts == null ? "(no message)" : formatInt(nts)}`);
  lines.push(`· *Total Staff: ${formatInt(total)}*`);
  return lines.join("\n");
}

function renderWohhupWorkersRegister(answer) {
  const tw = answer.meta.time_window.label;
  const wh = answer.meta?.wh || {};
  const lines = [`*Woh Hup Workers on ${tw}:*`];
  if (wh.totalRegister != null) lines.push(`· Total register: ${formatInt(wh.totalRegister)}`);
  if (wh.workersOnSite != null) lines.push(`· *Workers on site: ${formatInt(wh.workersOnSite)}*`);
  if (wh.homeLeave != null) lines.push(`· Home leave: ${formatInt(wh.homeLeave)}`);
  if (wh.loanOut != null) lines.push(`· Loan out: ${formatInt(wh.loanOut)}`);
  if (wh.loanIn != null && wh.loanIn > 0) lines.push(`· Loan in: ${formatInt(wh.loanIn)}`);
  if (wh.course != null && wh.course > 0) lines.push(`· Course: ${formatInt(wh.course)}`);
  if (wh.medicalLeave != null && wh.medicalLeave > 0) lines.push(`· Medical leave: ${formatInt(wh.medicalLeave)}`);
  if (wh.absent != null && wh.absent > 0) lines.push(`· Absent: ${formatInt(wh.absent)}`);
  if (lines.length === 1) lines.push(`(no workers register message today)`);
  return lines.join("\n");
}

// ──────────────────── Manpower by Company × Role ───────────────────────

function renderManpowerByCompanyRole(answer) {
  const tw = answer.meta.time_window.label;
  const rb = answer.meta?.roleBreakdown || {};
  const filterCtx = formatFilterCtx(answer.meta);
  // Sort companies by their total headcount (sum of role counts) descending.
  const companies = Object.keys(rb).sort((a, b) => {
    const aTotal = rb[a].reduce((s, x) => s + x.count, 0);
    const bTotal = rb[b].reduce((s, x) => s + x.count, 0);
    return bTotal - aTotal;
  });
  if (companies.length === 0) return `Manpower — no data for ${tw}.`;
  const grandTotal = companies.reduce((s, c) => s + rb[c].reduce((ss, x) => ss + x.count, 0), 0);
  const lines = [`Manpower — ${filterCtx}breakdown by company and role on ${tw} (total: ${grandTotal}):`, ``];
  for (const co of companies) {
    const roles = rb[co];
    const coTotal = roles.reduce((s, x) => s + x.count, 0);
    lines.push(`*${co}* (${coTotal}):`);
    for (const { label, count } of roles) {
      lines.push(`  • ${label}: ${count}`);
    }
    lines.push(``);
  }
  return lines.join("\n").replace(/\n+$/, "");
}

// ──────────────────── Safety comprehensive distribution ─────────────────

function renderSafetyComprehensive(answer) {
  const tw = answer.meta.time_window.label;
  const filterCtx = formatFilterCtx(answer.meta);
  const s = answer.meta?.safety || {
    total: answer.total,
    open: 0,
    closed: 0,
    severity: {},
    status: {},
    severityByStatus: { open: {}, closed: {}, "n/a": {} },
    date: {},
    category: {},
    location: {},
    sender: {},
  };
  // The user's REQUESTED grouping dimensions. The renderer MUST honour this.
  const groupFields = (answer.meta?.intent?.group_by || []).map((g) => g.field).filter(Boolean);
  const lines = [`Safety Issues — ${filterCtx}${tw}:`, ``];
  // Headline counts — always shown so compound questions ("total + closed + breakdown")
  // are fully answered. Severity breakdown is shown INLINE per status (P1/P2/P3/N/A)
  // so the user sees the most useful split (open-by-severity + closed-by-severity)
  // by default without having to ask a follow-up question.
  lines.push(`  • Total reported: ${s.total}`);
  lines.push(`  • Open: ${s.open}${formatInlineSeverityCounts(s.severityByStatus?.open)}`);
  lines.push(`  • Closed: ${s.closed}${formatInlineSeverityCounts(s.severityByStatus?.closed)}`);
  // Only mention N/A status when there ARE issues in that bucket — otherwise
  // it's noise. Same inline severity treatment.
  const naCount = (s.status?.["n/a"] || 0) + (s.status?.[""] || 0);
  if (naCount > 0) {
    lines.push(`  • Pending/Other status: ${naCount}${formatInlineSeverityCounts(s.severityByStatus?.["n/a"])}`);
  }

  // Decide which breakdown sections to render. Honour the user's group_by
  // dimensions. Skip the default Severity breakdown when nothing was
  // requested — the inline counts above already show severity per status.
  const requestedBreakdowns = groupFields.length > 0 ? groupFields : [];

  for (const field of requestedBreakdowns) {
    // Avoid printing duplicate sections that the headline already covers.
    if (field === "Severity" || field === "Status") continue;
    const section = buildSafetyBreakdownSection(field, s);
    if (!section || section.entries.length === 0) continue;
    lines.push(``);
    lines.push(`*${section.heading}*`);
    for (const e of section.entries) lines.push(`  • ${e.key}: ${e.value}`);
  }
  return lines.join("\n");
}

/**
 * Format the inline " (4 P1, 12 P2, 4 P3)" suffix shown after each status
 * count. Zeros are omitted to keep the line readable. Returns "" when there
 * are no non-zero severities (so the caller gets a clean "Open: 0" with no
 * trailing parens).
 */
function formatInlineSeverityCounts(sevMap) {
  if (!sevMap || typeof sevMap !== "object") return "";
  const order = ["P1", "P2", "P3", "N/A"];
  const parts = [];
  for (const k of order) {
    const v = sevMap[k];
    if (Number.isFinite(v) && v > 0) parts.push(`${v} ${k}`);
  }
  // Catch any other severity labels (e.g. "GOOD OBSERVATION") not in the canonical list.
  for (const k of Object.keys(sevMap)) {
    if (order.includes(k)) continue;
    const v = sevMap[k];
    if (Number.isFinite(v) && v > 0) parts.push(`${v} ${k}`);
  }
  if (parts.length === 0) return "";
  return ` (${parts.join(", ")})`;
}

function buildSafetyBreakdownSection(field, s) {
  switch (field) {
    case "Severity": {
      const sevOrder = ["P1", "P2", "P3", "N/A"];
      const keys = Object.keys(s.severity || {}).sort((a, b) => {
        const ai = sevOrder.indexOf(a);
        const bi = sevOrder.indexOf(b);
        if (ai !== -1 && bi !== -1) return ai - bi;
        if (ai !== -1) return -1;
        if (bi !== -1) return 1;
        return a.localeCompare(b);
      });
      return { heading: "By severity:", entries: keys.map((k) => ({ key: k, value: s.severity[k] })) };
    }
    case "Status": {
      const keys = Object.keys(s.status || {}).sort();
      return { heading: "By status:", entries: keys.map((k) => ({ key: k, value: s.status[k] })) };
    }
    case "Date": {
      // Dates as ISO — sort ascending. Convert to dd-Mmm for readability.
      const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const fmt = (iso) => {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
        return m ? `${m[3]}-${months[parseInt(m[2], 10) - 1]}-${m[1]}` : iso || "";
      };
      const keys = Object.keys(s.date || {}).sort();
      return {
        heading: "By date:",
        entries: keys.map((k) => ({ key: fmt(k), value: s.date[k] })),
      };
    }
    case "Category": {
      const keys = Object.keys(s.category || {}).sort((a, b) => (s.category[b] || 0) - (s.category[a] || 0));
      return { heading: "By category:", entries: keys.map((k) => ({ key: k, value: s.category[k] })) };
    }
    case "Location": {
      const keys = Object.keys(s.location || {}).sort((a, b) => (s.location[b] || 0) - (s.location[a] || 0));
      return { heading: "By location:", entries: keys.map((k) => ({ key: k, value: s.location[k] })) };
    }
    case "Sender":
    case "Reporter": {
      const keys = Object.keys(s.sender || {}).sort((a, b) => (s.sender[b] || 0) - (s.sender[a] || 0));
      return { heading: "By reporter:", entries: keys.slice(0, 10).map((k) => ({ key: k, value: s.sender[k] })) };
    }
    default:
      return null;
  }
}

function formatFilterCtx(meta) {
  const filters = meta?.filters_applied || [];
  if (filters.length === 0) return "";
  const parts = [];
  for (const f of filters) {
    if (f.op === "=") parts.push(`${f.value}`);
    else if (f.op === "in" && Array.isArray(f.values)) parts.push(f.values.join("/"));
  }
  return parts.length ? `${parts.join(" · ")} · ` : "";
}

/**
 * True when the user's requested group_by matches the dimensions this
 * override naturally renders (or when no group_by was requested at all,
 * meaning "give me the default summary"). Used by `pickOverride` to AVOID
 * substituting a hardcoded breakdown for the user's actual requested
 * dimension — e.g. don't show "by Work_Type" when user asked "by Date".
 *
 * @param {string[]} actualFields  - group_by fields from the user's intent
 * @param {string[]} nativeFields  - fields this override is designed to render
 * @returns {boolean}
 */
function matchesNativeGroupBy(actualFields, nativeFields) {
  if (!actualFields || actualFields.length === 0) return true;
  if (actualFields.length > nativeFields.length) return false;
  return actualFields.every((f) => nativeFields.includes(f));
}

// ─────────────────────────────── helpers ───────────────────────────────

function formatInt(n) {
  if (n === null || n === undefined) return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return v.toString();
}

function formatPct(completed, total) {
  const c = Number(completed) || 0;
  const t = Number(total) || 0;
  if (t === 0) return "0%";
  const p = (c / t) * 100;
  if (Number.isInteger(p)) return `${p}%`;
  return `${p.toFixed(1)}%`;
}

module.exports = { pickOverride, __test: { WH_SPECIALTY_METRIC_LABELS, formatPct, formatFilterCtx } };
