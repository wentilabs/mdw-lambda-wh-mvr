/**
 * Domain plugin registry.
 *
 * Adding a new domain is one edit here plus one new file under data/.
 * Layer 1 (parser) reads `listDomains()` to build its prompt; Layer 2
 * (planner) calls `getPlugin(domain)` for `fetchRows`, metrics, dimensions.
 *
 * This base template covers 5 domains:
 *   safety, manpower, wbgt, noise, report_generation (bypass)
 */

const manpower = require("./manpower");
const safety = require("./safety");
const wbgt = require("./wbgt");
const noise = require("./noise");
const reportGeneration = require("./report_generation");

const REGISTRY = Object.freeze({
  manpower,
  safety,
  wbgt,
  noise,
  report_generation: reportGeneration,
});

function getPlugin(domain) {
  return REGISTRY[domain] || null;
}

function listDomains() {
  return Object.keys(REGISTRY);
}

function listAnalyticalDomains() {
  return Object.keys(REGISTRY).filter((d) => !REGISTRY[d].bypass);
}

function listMetrics(domain) {
  const p = getPlugin(domain);
  return p?.metrics || [];
}

function listDimensions(domain) {
  const p = getPlugin(domain);
  return p?.dimensions || [];
}

function isBypass(domain) {
  return Boolean(getPlugin(domain)?.bypass);
}

/**
 * Build the per-domain "metrics + dimensions" prompt fragment Layer 1 injects
 * into the system prompt. Deterministic — drives the LLM's understanding of
 * what each domain can answer.
 */
function buildDomainPromptFragment() {
  const lines = [];
  for (const name of listAnalyticalDomains()) {
    const p = REGISTRY[name];
    const metricNames = p.metrics.map((m) => m.name).join(", ") || "(none)";
    const dimNames = p.dimensions.map((d) => `${d.name}${d.enum ? `(${d.enum.join("|")})` : ""}`).join(", ");
    lines.push(`  • ${name}  — ${p.description}`, `      metrics:    ${metricNames}`, `      dimensions: ${dimNames}`);
  }
  return lines.join("\n");
}

module.exports = {
  REGISTRY,
  getPlugin,
  listDomains,
  listAnalyticalDomains,
  listMetrics,
  listDimensions,
  isBypass,
  buildDomainPromptFragment,
};
