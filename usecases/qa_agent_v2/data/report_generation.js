/**
 * Report-Generation marker plugin.
 *
 * Report generation (PDF/Excel exports) is a side-effect action, not an
 * analytical question. The executor short-circuits to the bypass handler
 * at `usecases/qa_agent/bypass/report_generation.js` — there is no
 * aggregation here.
 */

module.exports = {
  name: "report_generation",
  displayName: "Report Generation",
  description: "Generate PDF/Excel reports (daily safety summary, manpower summary, etc.) — side-effect operations.",
  metrics: [],
  dimensions: [],
  bypass: true,
  async fetchRows() {
    return [];
  },
};
