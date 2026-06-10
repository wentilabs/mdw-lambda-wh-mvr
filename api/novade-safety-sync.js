// POST /novade-safety-sync — cron endpoint that pushes ticked safety issues
// to Novade and walks closed ones through the close lifecycle.
//
// No auth: this endpoint takes no secret/header. The Lambda is internal, the
// route is unique enough, and the body fields are all optional defaults.
//
// Body (all optional):
//   {
//     "date":      "YYYY-MM-DD",  // defaults to today (SGT)
//     "backfill":  false,
//     "dryRun":    false,
//     "batchSize": 10,
//     "limit":     null
//   }
// Spreadsheet, sheet name, and project name are env-only:
//   - spreadsheetId  ← SAFETY_SPREADSHEET_ID
//   - sheetName      ← "Safety" (current-month tab); backfill auto-discovers
//   - projectName    ← NOVADE_PROJECT_NAME (env, falls back to "MBS-IR2")

// NOTE: the sync handler chain (and its `fuzzball` dep) is required lazily
// inside the handler function so Lambda startup never depends on the Novade
// stack. If `fuzzball` were ever missing from the deploy bundle, the rest of
// the Lambda (soil disposal / manpower / safety webhook) still boots cleanly;
// only this dormant endpoint would fail when actually called.

async function processNovadeSafetySyncRequest(event, res) {
  try {
    let body = {};
    try {
      body = event?.body ? JSON.parse(event.body) : {};
    } catch (e) {
      return res.status(400).json({ success: false, error: "Invalid JSON body" });
    }

    // Lazy-require so Lambda startup doesn't pull in fuzzball / Novade chain.
    const { handler: syncHandler } = require("../usecases/safety_novade_sync");
    const result = await syncHandler(body);
    const statusCode = result?.success === false ? 400 : 200;
    return res.status(statusCode).json(result);
  } catch (error) {
    console.error("[NovadeSync API] Unhandled error:", error?.stack || error);
    return res.status(500).json({ success: false, error: error?.message || String(error) });
  }
}

module.exports = processNovadeSafetySyncRequest;
