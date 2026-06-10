/**
 * Layer 5 — Formatter.
 *
 * Renders typed AnswerData into a user-facing message string. Pure template
 * code — no LLM call, no math. The same AnswerData input always produces
 * byte-identical output, which is what makes the consistency tests pass.
 *
 * The formatter relies entirely on `meta` (window, domain, sources) and the
 * AnswerData fields (total, breakdown, series, ...). It never touches raw
 * rows — Layer 4 has already produced every number.
 */

const { getPlugin } = require("../data");
const { pickOverride } = require("./overrides");
const { maybePolish } = require("./polish");

/**
 * Render an AnswerData into a user-facing message.
 *
 * Always produces a DETERMINISTIC base message (overrides + generic templates).
 * Then OPTIONALLY runs an LLM polish pass (gpt-4o-mini, temperature=0) that
 * makes the prose more natural while GUARANTEEING every number is preserved.
 * The polish layer caches by deterministic-output hash so byte-identical
 * consistency tests still pass.
 */
async function renderAnswer(answer) {
  const deterministic = renderDeterministic(answer);
  return maybePolish(deterministic, answer);
}

function renderDeterministic(answer) {
  if (!answer || !answer.kind) return "Sorry, I couldn't produce an answer for that.";
  // Domain-specific override (Wohhup TS/NTS, Piling summary, IM summary, Pile Cap grid).
  const override = pickOverride(answer);
  if (override) return override;
  switch (answer.kind) {
    case "point_lookup":
      return renderPointLookup(answer);
    case "count":
      return renderCount(answer);
    case "aggregate":
      return renderAggregate(answer);
    case "distribution":
      return renderDistribution(answer);
    case "trend":
      return renderTrend(answer);
    case "comparison":
      return renderComparison(answer);
    case "top_n":
      return renderTopN(answer);
    case "ranking":
      return renderRanking(answer);
    case "ratio":
      return renderRatio(answer);
    case "threshold":
      return renderThreshold(answer);
    case "status":
      return renderStatus(answer);
    case "list":
      return renderList(answer);
    case "gap":
      return renderGap(answer);
    case "unsupported":
      return renderUnsupported(answer);
    case "bypass":
      // Bypass — the entry point routes to the legacy handler before reaching here.
      return "(bypass handler should have handled this)";
    default:
      return `Unsupported answer kind: ${answer.kind}`;
  }
}

// ---------- per-kind templates ----------

function renderPointLookup(a) {
  const { meta } = a;
  if (a.value === null || a.value === undefined) {
    return `No data found for ${labelDomain(meta)} on ${meta.time_window.label}.`;
  }
  const metricLabel = humanizeMetric(a.label, meta);
  const filterCtx = formatFilterContext(meta);
  return `${labelDomain(meta)} — ${filterCtx}${metricLabel}: ${formatNumber(a.value)} (${meta.time_window.label}).${notesLine(meta)}`;
}

function renderCount(a) {
  const lines = [];
  const filterCtx = formatFilterContext(a.meta);
  lines.push(`${labelDomain(a.meta)} — ${filterCtx}${a.total} on ${a.meta.time_window.label}.`);
  if (Array.isArray(a.breakdown) && a.breakdown.length > 0) {
    lines.push(``);
    for (const b of a.breakdown) lines.push(`  • ${b.key}: ${formatNumber(b.value)}`);
  }
  lines.push(notesLine(a.meta));
  return lines.filter(Boolean).join("\n");
}

function renderAggregate(a) {
  const lines = [];
  const opLabel =
    {
      sum: "Total",
      avg: "Average",
      leq_avg: "Average",
      min: "Min",
      max: "Max",
      count: "Count",
    }[a.op] || "Count";
  const display = humanizeMetric(a.field || a.op, a.meta);
  const filterCtx = formatFilterContext(a.meta);
  lines.push(
    `${labelDomain(a.meta)} — ${filterCtx}${opLabel} ${display}: ${formatNumber(a.value)} (${a.meta.time_window.label}).`,
  );
  if (Array.isArray(a.breakdown) && a.breakdown.length > 0) {
    lines.push(``);
    for (const b of a.breakdown) lines.push(`  • ${b.key}: ${formatNumber(b.value)}`);
  }
  lines.push(notesLine(a.meta));
  return lines.filter(Boolean).join("\n");
}

function renderDistribution(a) {
  const lines = [];
  const filterCtx = formatFilterContext(a.meta);
  lines.push(
    `${labelDomain(a.meta)} — ${filterCtx}breakdown on ${a.meta.time_window.label} (total: ${formatNumber(a.total)}):`,
  );
  lines.push(``);
  for (const r of a.rows) lines.push(`  • ${r.key}: ${formatNumber(r.value)}`);
  lines.push(notesLine(a.meta));
  return lines.filter(Boolean).join("\n");
}

function renderTrend(a) {
  const lines = [];
  const filterCtx = formatFilterContext(a.meta);
  lines.push(
    `${labelDomain(a.meta)} — ${filterCtx}${a.meta.time_window.label} (${a.series.length} day${a.series.length === 1 ? "" : "s"}):`,
  );
  lines.push(``);
  for (const p of a.series) lines.push(`  • ${p.period_label}: ${formatNumber(p.value)}`);
  lines.push(``);
  lines.push(`Total: ${formatNumber(a.total)} · Avg/day: ${formatNumber(a.avg_per_period)}`);
  lines.push(notesLine(a.meta));
  return lines.filter(Boolean).join("\n");
}

function renderComparison(a) {
  const curLabel = a.current?.meta?.time_window?.label || "current";
  const baseLabel = a.baseline?.meta?.time_window?.label || "baseline";
  const cur = a.current?.value ?? a.current?.total ?? 0;
  const base = a.baseline?.value ?? a.baseline?.total ?? 0;
  const sign = a.delta >= 0 ? "+" : "";
  const pct = a.pct_change === null ? "n/a" : `${sign}${formatNumber(a.pct_change)}%`;
  const filterCtx = formatFilterContext(a.meta);
  const lines = [];
  lines.push(`${labelDomain(a.meta)} — ${filterCtx}${curLabel} vs ${baseLabel}.`);
  lines.push(``);
  lines.push(`  • ${curLabel}: ${formatNumber(cur)}`);
  lines.push(`  • ${baseLabel}: ${formatNumber(base)}`);
  lines.push(`  • Δ: ${sign}${formatNumber(a.delta)} (${pct})`);
  lines.push(notesLine(a.meta));
  return lines.filter(Boolean).join("\n");
}

function renderTopN(a) {
  const lines = [];
  const filterCtx = formatFilterContext(a.meta);
  lines.push(`${labelDomain(a.meta)} — ${filterCtx}top ${a.rows.length} (${a.meta.time_window.label}):`);
  lines.push(``);
  for (const r of a.rows) lines.push(`  ${r.rank}. ${r.key}: ${formatNumber(r.value)}`);
  lines.push(notesLine(a.meta));
  return lines.filter(Boolean).join("\n");
}

function renderRanking(a) {
  const lines = [];
  const filterCtx = formatFilterContext(a.meta);
  if (a.winners.length === 0) return `${labelDomain(a.meta)} — ${filterCtx}no entries for ${a.meta.time_window.label}.`;
  const w = a.winners[0];
  lines.push(
    `${labelDomain(a.meta)} — ${filterCtx}leader on ${a.meta.time_window.label}: ${w.key} (${formatNumber(w.value)}).`,
  );
  if (a.winners.length > 1) {
    lines.push(``);
    for (const r of a.winners) lines.push(`  ${r.rank}. ${r.key}: ${formatNumber(r.value)}`);
  }
  lines.push(notesLine(a.meta));
  return lines.filter(Boolean).join("\n");
}

function renderRatio(a) {
  const filterCtx = formatFilterContext(a.meta);
  return `${labelDomain(a.meta)} — ${filterCtx}${formatNumber(a.numerator)} of ${formatNumber(a.denominator)} (${formatNumber(a.pct)}%) on ${a.meta.time_window.label}.${notesLine(a.meta)}`;
}

function renderThreshold(a) {
  const filterCtx = formatFilterContext(a.meta);
  return `${labelDomain(a.meta)} — ${filterCtx}${a.over} above ${a.threshold}, ${a.under} at/below on ${a.meta.time_window.label}.${notesLine(a.meta)}`;
}

function renderStatus(a) {
  const lines = [];
  lines.push(`${labelDomain(a.meta)} — status on ${a.meta.time_window.label}:`);
  lines.push(``);
  for (const r of a.rows) {
    const summary = Object.entries(r)
      .filter(([k]) => !["Source", "Sender", "ChatGroup", "MessageId"].includes(k))
      .map(([k, v]) => `${k}: ${formatVal(v)}`)
      .join(" · ");
    lines.push(`  • ${summary}`);
  }
  lines.push(notesLine(a.meta));
  return lines.filter(Boolean).join("\n");
}

// Above this row count, append a one-line hint that lets the user ask for the
// same data as a screenshot image instead of a wall-of-text list. The hint is
// COUNT-DRIVEN (deterministic) and only fires for the `safety` domain — the
// only domain where a `safety_image` bypass exists. Threshold chosen to be
// generous: small lists fit cleanly in WhatsApp, larger ones don't.
const SAFETY_LIST_SCREENSHOT_HINT_THRESHOLD = 5;

function renderList(a) {
  const lines = [];
  lines.push(`${labelDomain(a.meta)} — ${a.total} item${a.total === 1 ? "" : "s"} on ${a.meta.time_window.label}:`);
  lines.push(``);
  for (const r of a.rows) {
    const summary = Object.entries(r)
      // ChatGroup / Source / MessageId are pure internals. Keep Sender +
      // UpdatedBy — they're useful ("who raised / who closed"). formatVal
      // extracts `.name` from the JSON-blob shape so we get "GANESH K"
      // instead of the entire {"name":"…","phoneNumber":"…",…} dump.
      .filter(([k]) => !["Source", "ChatGroup", "MessageId"].includes(k))
      .map(([k, v]) => [k, formatVal(v)])
      // Skip fields whose formatted value is empty / "—" / dash-only — no
      // point printing "UpdatedBy: —" when there's no updater on the row.
      .filter(([, fv]) => fv && fv !== "—" && String(fv).trim() !== "")
      .map(([k, fv]) => `${k}: ${fv}`)
      .join(" · ");
    lines.push(`  • ${summary}`);
  }
  if (a.truncated) lines.push(`(truncated)`);
  lines.push(notesLine(a.meta));
  // Self-documenting hint: only for safety (only domain with a screenshot
  // bypass) and only when the list is long enough that a screenshot would
  // actually be friendlier than text. Count-driven → consistency-safe.
  if (a?.meta?.domain === "safety" && Array.isArray(a.rows) && a.rows.length > SAFETY_LIST_SCREENSHOT_HINT_THRESHOLD) {
    lines.push(``);
    lines.push(`💡 Tip: add "screenshot" to your question to get this as an image.`);
  }
  return lines.filter(Boolean).join("\n");
}

function renderGap(a) {
  if (!a.missing_keys || a.missing_keys.length === 0) {
    return `${labelDomain(a.meta)} — no gaps detected on ${a.meta.time_window.label}.`;
  }
  return `${labelDomain(a.meta)} — missing on ${a.meta.time_window.label}: ${a.missing_keys.join(", ")}.${notesLine(a.meta)}`;
}

function renderUnsupported(a) {
  return `Sorry, I can't answer that. ${a.reason || ""}`.trim();
}

// ---------- helpers ----------

function labelDomain(meta) {
  const p = getPlugin(meta?.domain);
  return p?.displayName || meta?.domain || "Result";
}

function labelMetric(name, meta) {
  const p = getPlugin(meta?.domain);
  const m = (p?.metrics || []).find((mm) => mm.name === name || mm.field === name);
  if (!m) return humanize(name);
  return m.unit ? `${humanize(m.name)} (${m.unit})` : humanize(m.name);
}

function humanizeMetric(name, meta) {
  const p = getPlugin(meta?.domain);
  const m = (p?.metrics || []).find((mm) => mm.name === name || mm.field === name);
  if (!m) return humanize(name);
  // Strip trailing _<unit-suffix> when the unit is already shown parenthetically.
  // e.g. volume_m3 + unit='m³' → "Volume (m³)" not "Volume M3 (m³)".
  let stem = m.name;
  if (m.unit) {
    stem = stem.replace(/_(m3|m2|m|km|sec|min|hr|pct|kg|usd|sgd|dba|c)$/i, "");
  }
  return m.unit ? `${humanize(stem)} (${m.unit})` : humanize(stem);
}

function humanize(s) {
  if (!s) return "";
  return String(s)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatFilterContext(meta) {
  const filters = meta?.filters_applied || [];
  if (filters.length === 0) return "";
  const parts = [];
  for (const f of filters) {
    if (!f) continue;
    switch (f.op) {
      case "=":
        parts.push(`${f.value}`);
        break;
      case "!=":
        parts.push(`not ${f.value}`);
        break;
      case "in":
        if (Array.isArray(f.values)) parts.push(f.values.join("/"));
        break;
      case ">=":
        parts.push(`≥${f.value}`);
        break;
      case "<=":
        parts.push(`≤${f.value}`);
        break;
      case "like":
        parts.push(`like ${f.value}`);
        break;
    }
  }
  return parts.length ? `${parts.join(" · ")} · ` : "";
}

function formatNumber(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  if (typeof n !== "number") return String(n);
  if (!Number.isFinite(n)) return "—";
  // Integers: render as integer. Floats: 1 decimal unless tiny.
  if (Number.isInteger(n)) return n.toString();
  const abs = Math.abs(n);
  if (abs >= 100) return n.toFixed(0);
  if (abs >= 1) return n.toFixed(1);
  return n.toFixed(2);
}

function formatVal(v) {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") return formatNumber(v);
  if (typeof v === "string") {
    // Sender / UpdatedBy fields on the Safety sheet are stored as JSON
    // blobs: `{"name":"GANESH K","text":"…","phoneNumber":"…","messageId":"…",
    // "timestamp":…,"chatName":"…"}`. The user only wants the name. Detect
    // JSON-shaped strings starting with { and extract `.name` if present
    // (fall through to raw on parse fail — safer than crashing on edge cases).
    const trimmed = v.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object") {
          if (typeof parsed.name === "string" && parsed.name.trim()) return parsed.name.trim();
          if (typeof parsed.text === "string" && parsed.text.trim()) return parsed.text.trim();
        }
      } catch (_) {}
    }
    return v;
  }
  if (typeof v === "object") {
    if (typeof v.name === "string") return v.name;
  }
  return String(v);
}

function notesLine(meta) {
  if (!meta?.notes || meta.notes.length === 0) return "";
  return `\n(${meta.notes.join("; ")})`;
}

module.exports = { renderAnswer, renderDeterministic };
