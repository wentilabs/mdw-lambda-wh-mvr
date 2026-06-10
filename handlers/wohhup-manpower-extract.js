/**
 * Wohhup (Woh Hup / WHPL) Manpower Extractor
 *
 * Handles compact "MBS- IR2 MANPOWER" format messages that the standard
 * manpower extractor cannot parse correctly. The standard extractor expects
 * 5+ role-count pairs and a "Total Manpower" line; Wohhup messages have
 * only 1-3 lines and use idiosyncratic phrasing ("Workers: T= 06",
 * "WH Total = 06", "WHE Total = 02", "WH Engineering Workers =T 02").
 *
 * Two sub-formats:
 *   "WH Workers Manpower" → extract workers + optional engineers
 *   "WH Staff Manpower"   → SKIP (consumed by utils/wh-staff-tracker.js)
 *
 * Detection is deterministic regex; extraction is GPT-4.1 with strict JSON
 * schema and temperature 0 for 100% consistency.
 */

const { getOpenAI } = require("../utils/openai");

const VALID_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Get current date info in Singapore timezone for relative-date conversion.
 * @returns {{today: string, tomorrow: string, yesterday: string}} DD-MMM-YYYY
 */
function getSingaporeDateInfo() {
  const now = new Date();
  const sg = { timeZone: "Asia/Singapore" };
  const fmt = (d) => {
    const day = d.toLocaleDateString("en-GB", { ...sg, day: "2-digit" });
    const month = d.toLocaleDateString("en-GB", { ...sg, month: "short" });
    const year = d.toLocaleDateString("en-GB", { ...sg, year: "numeric" });
    return `${day}-${month}-${year}`;
  };
  return {
    today: fmt(now),
    tomorrow: fmt(new Date(now.getTime() + 86400000)),
    yesterday: fmt(new Date(now.getTime() - 86400000)),
  };
}

/**
 * Validate DD-MMM-YYYY format.
 */
function validateDateFormat(dateStr) {
  if (!dateStr || typeof dateStr !== "string") return { isValid: false };
  const m = dateStr.trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) return { isValid: false };
  const monthCap = m[2].charAt(0).toUpperCase() + m[2].slice(1).toLowerCase();
  if (!VALID_MONTHS.includes(monthCap)) return { isValid: false };
  const day = parseInt(m[1], 10);
  const year = parseInt(m[3], 10);
  if (day < 1 || day > 31) return { isValid: false };
  if (year < 2020 || year > 2030) return { isValid: false };
  return { isValid: true };
}

/**
 * Strip markdown bold (`*`) and trim — Wohhup messages frequently bold every line.
 */
function stripMarkdown(text) {
  return String(text || "")
    .replace(/\*/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/**
 * Deterministically detect whether a message is a Wohhup compact-format manpower report.
 *
 * Returns:
 *   "workers"     — "WH Workers Manpower" sub-format (run extractor; produces Worker + optional Engineer)
 *   "engineering" — "WH Engineering" / "WH Engineering Manpower" sub-format (run extractor;
 *                   ALL counts are interpreted as Engineer; company is typically "Woh Hup Engineering")
 *   "staff"       — "WH Staff Manpower" sub-format (skip — handled downstream by wh-staff-tracker)
 *   null          — not a Wohhup compact format (let the standard pipeline handle it)
 *
 * Three strict signals must match (the section header anchor is precise enough that
 * we do NOT need to cap the role-count count — standard Wohhup TBM-style reports
 * never use those exact section names):
 *   1. Header contains "MBS- IR2 MANPOWER" (or "MBS-IR2 MANPOWER", spacing-tolerant)
 *   2. "Company:" line names Woh Hup / Woh Hup Engineering / WHPL / Wohhup variant
 *   3. Section header contains "WH Workers Manpower" OR "WH Staff Manpower" OR
 *      "WH Engineering" (with optional "Manpower" suffix)
 */
function detectWohhupManpowerFormat(messageBody) {
  if (!messageBody || typeof messageBody !== "string") return null;
  const clean = stripMarkdown(messageBody);
  const lower = clean.toLowerCase();

  // Signal 1: MBS-IR2 MANPOWER header (spacing/dash tolerant)
  const hasIr2Header = /mbs[\s\-]*ir2\s+manpower/i.test(clean);
  if (!hasIr2Header) return null;

  // Signal 2: Company is Woh Hup / Woh Hup Engineering / WHPL
  const hasWohhupCompany = /company\s*:\s*(woh[\s\-_]*hup|wohhup|whpl)\b/i.test(clean);
  if (!hasWohhupCompany) return null;

  // Signal 3: which section?
  // Order matters — check the more specific sections first.
  const hasWorkersSection = /\bwh\s+workers\s+manpower\b/i.test(lower);
  const hasStaffSection = /\bwh\s+staff\s+manpower\b/i.test(lower);
  // "WH Engineering" with optional "Manpower" suffix; must NOT be inside "WH Engineering Workers"
  // (which is a per-line count token in the WH Workers section, not a section header).
  const hasEngineeringSection = /(?:^|\n)\s*[\W_]*wh\s+engineering(?:\s+manpower)?\s*[\W_]*\s*(?:\n|$)/i.test(lower);

  if (hasStaffSection && !hasWorkersSection && !hasEngineeringSection) return "staff";
  if (hasWorkersSection) return "workers";
  if (hasEngineeringSection) return "engineering";
  return null;
}

/**
 * Extract structured worker data from a Wohhup compact-format message.
 *
 * Two section types are accepted (from detectWohhupManpowerFormat):
 *   - "workers"     → "WH Workers Manpower" section. Extract Worker + optional Engineer counts.
 *   - "engineering" → "WH Engineering" section. ALL counts (Workers/Worker/Total) are Engineer counts.
 *
 * Uses GPT-4.1 with strict JSON schema and temperature 0 for 100% consistency.
 *
 * @param {string} messageBody
 * @param {"workers"|"engineering"} [sectionType="workers"] - Section context for interpretation.
 * @returns {Promise<{
 *   isValid: boolean,
 *   rejectionReason: string | null,
 *   date: string,                  // "DD-MMM-YYYY"
 *   totalWorkers: number,
 *   workerBreakdown: Array<{role: "Worker"|"Engineer", count: number}>,
 * } | null>}
 */
async function extractWohhupWorkersManpower(messageBody, sectionType = "workers") {
  const dateInfo = getSingaporeDateInfo();

  const schema = {
    type: "object",
    properties: {
      isValid: { type: "boolean" },
      rejectionReason: { type: ["string", "null"] },
      date: { type: "string" },
      totalWorkers: { type: "integer" },
      workerBreakdown: {
        type: "array",
        items: {
          type: "object",
          properties: {
            role: { type: "string", enum: ["Worker", "Engineer"] },
            count: { type: "integer" },
          },
          required: ["role", "count"],
          additionalProperties: false,
        },
      },
    },
    required: ["isValid", "rejectionReason", "date", "totalWorkers", "workerBreakdown"],
    additionalProperties: false,
  };

  const systemPrompt = `<role_and_objective>
You extract structured worker data from "MBS- IR2 MANPOWER" Wohhup compact-format messages.
The pre-classifier has confirmed the section type, which is provided in <section_context>.
Output role names canonically as "Worker" or "Engineer" (Title Case, exactly).
Return ONLY valid JSON matching the schema. NEVER fabricate data not present in the message.
</role_and_objective>

<section_context>
Section type for THIS message: ${sectionType.toUpperCase()}

${
  sectionType === "engineering"
    ? `This message is from a "WH Engineering" section. The company is typically "Woh Hup Engineering".
Engineer counts in this section refer to ENGINEERS (we save them with role="Engineer"). Do NOT output any role="Worker" entries for a WH Engineering message.

PRIORITY RULE — "ON SITE" line wins:
If the message contains a "Worker on site" / "Workers on site" line, that is the AUTHORITATIVE on-site Engineer count.
When that line is present, IGNORE every other count line in the section ("Workers", "Total", "Workers = N") because they are register/total figures, NOT on-site.

ON-SITE PATTERNS (use as Engineer count, highest priority):
   - "Worker on site = NN" / "Worker on site= NN" / "Worker on site: NN" → {role: "Engineer", count: NN}
   - "Workers on site = NN" / "Workers on site: NN" → {role: "Engineer", count: NN}
   - "* Worker on site: NN" / "* Workers on site: NN" (bullet-prefixed) → {role: "Engineer", count: NN}

LEGACY/SIMPLE PATTERNS (use as Engineer count ONLY when NO "Worker on site" line exists):
   - "Workers = NN" / "Worker = NN" → {role: "Engineer", count: NN}
   - "Workers: NN" / "Worker: NN" → {role: "Engineer", count: NN}
   - "Workers: T= NN" → {role: "Engineer", count: NN}
   - "Total: NN" / "Total = NN" → {role: "Engineer", count: NN}
   - "WH Engineering = NN" / "WH Engineering: NN" → {role: "Engineer", count: NN}

EXPLICITLY IGNORE these non-on-site lines (do NOT include in workerBreakdown — never appear as a role):
   - "Absent: NN" / "Absent = NN" / "Absent =NN"   (engineers absent — register accounting, NOT on-site)
   - "Home leave: NN" / "H/Leave: NN" / "HL: NN"
   - "Loan out: NN" / "Loan to ANY: NN"
   - "Loan in: NN" / "Loan from ANY: NN"
   - "Course: NN"
   - "Medical leave: NN" / "MC: NN"
   - When "Worker on site" line is present: ALSO ignore "Workers = NN" / "Total: NN" (those become register figures, not on-site).

These ignored lines may be tracked separately for the daily image — never in the manpower sheet.`
    : `This message is from a "WH Workers Manpower" section. Output Worker counts and (optionally) Engineer counts as detailed below.`
}
</section_context>

<rules>
1. The section type has already been confirmed by the pre-classifier (see <section_context> above). If the message body's actual section header contradicts the declared sectionType (e.g., declared "workers" but body says "WH Staff Manpower"), set isValid=false with rejectionReason describing the mismatch. (Pre-classifier already filters this; this rule is a safety net.)

2. RECOGNIZE THESE LINE PATTERNS as Worker count (these are the ON-SITE worker count):
   - "Workers: T= NN" → {role: "Worker", count: NN}
   - "Workers : T = NN" → {role: "Worker", count: NN}
   - "Worker: T= NN" → {role: "Worker", count: NN}
   - "Workers on site: NN" → {role: "Worker", count: NN}    (THIS IS THE ON-SITE COUNT — what we save)
   - "Workers on site : NN" → {role: "Worker", count: NN}
   - "Worker on site: NN" → {role: "Worker", count: NN}
   - "* Workers on site: NN" → {role: "Worker", count: NN} (bullet-prefixed)
   - "WH Total = NN" → {role: "Worker", count: NN}   (in WH Workers section, "WH" alone means worker — only when no "Workers on site" line is present)
   - "WH Total= NN" → {role: "Worker", count: NN}

3. RECOGNIZE THESE LINE PATTERNS as Engineer count:
   - "WHE Total = NN" → {role: "Engineer", count: NN}   (WHE = WH Engineering)
   - "WHE Total= NN" → {role: "Engineer", count: NN}
   - "WH Engineering Workers =T NN" → {role: "Engineer", count: NN}
   - "WH Engineering Workers = T NN" → {role: "Engineer", count: NN}
   - "WH Engineering = NN" → {role: "Engineer", count: NN}
   - "WH Engineering: NN" → {role: "Engineer", count: NN}
   - "Engineering: T= NN" → {role: "Engineer", count: NN}
   - "Engineer: T= NN" → {role: "Engineer", count: NN}

4. "WH Grand Total = NN" or "WH Grand Total= NN":
   - This is a SUM CHECK only. NEVER include it as a role.
   - Use it to verify Worker+Engineer = NN. If they don't match, still extract verbatim values from the lines (do not modify counts to make sums match).

4a. EXPLICITLY IGNORE these non-on-site lines (do NOT include in workerBreakdown — they are NOT on-site workers; they are tracked separately on the daily image, not in the manpower sheet):
   - "Total: NN" / "Total : NN" / "* Total: NN"  (this is TOTAL REGISTER — total count in the company, including absences. The on-site count is only "Workers on site: NN".)
   - "Total Register: NN"
   - "Home leave: NN" / "* ⁠Home leave: NN" / "H/Leave: NN" / "HL: NN"
   - "Loan out: NN" / "* Loan out: NN" / "Loan to ANY: NN"
   - "Loan in: NN" / "Loan from ANY: NN"
   - "Course: NN"
   - "Medical leave: NN" / "MC: NN"
   - "Absent: NN"
   - These are NOT on-site categories — they are accounting metadata for the WHPL register and must NEVER appear in workerBreakdown.

4b. PRIORITY: when BOTH a "Workers on site: NN" line AND a "Total: NN" line exist, USE the "Workers on site" value as the Worker count. Total: NN is the register count and must be ignored for the worker breakdown.

5. "Workers: T= 00" (or any zero count):
   - SKIP zero-count lines from workerBreakdown.
   - If all counts are zero (no Worker, no Engineer) → isValid=false, rejectionReason="Zero workers reported — nothing to record".

6. totalWorkers = sum of counts in workerBreakdown.
   - If workerBreakdown is empty (no positive counts) → totalWorkers=0 and isValid=false.

7. NEVER fabricate. If a line is unrecognized, IGNORE it. Do NOT invent role names.
   - Lines like "Date: DD/MM/YYYY", "Day: FRIDAY", "Company: Woh Hup", "MBS- IR2 MANPOWER" are headers — ignore them.
   - Section header line "WH Workers Manpower" is the section marker — ignore it.

8. Date extraction:
   - Look for "Date: DD/MM/YYYY" or "Date: DD/MM/YY" or "Date - DD/MM/YYYY".
   - Convert to DD-MMM-YYYY (e.g., "24/04/2026" → "24-Apr-2026", "26/04/26" → "26-Apr-2026").
   - If no date present → use today: "${dateInfo.today}".
   - 2-digit year → 20XX.

9. Order of workerBreakdown: preserve the order in which counts appear in the message (Worker first if it appears first, then Engineer; or vice versa).
</rules>

<examples>

<example id="A" title="Format A — Workers only (positive)">
<input>
*MBS- IR2 MANPOWER*
*Company: Woh Hup*
*Date: 24/04/2026*
*Day: FRIDAY*

· *WH Workers Manpower*

Workers: T= 06
</input>
<expected_output>
{"isValid":true,"rejectionReason":null,"date":"24-Apr-2026","totalWorkers":6,"workerBreakdown":[{"role":"Worker","count":6}]}
</expected_output>
</example>

<example id="B" title="Format B — Workers zero (REJECT, do not record)">
<input>
*MBS- IR2 MANPOWER*
*Company: Woh Hup*
*Date: 26/04/2026*
*Day: SUNDAY*

· *WH Workers Manpower*

Workers: T= 00
</input>
<expected_output>
{"isValid":false,"rejectionReason":"Zero workers reported — nothing to record","date":"","totalWorkers":0,"workerBreakdown":[]}
</expected_output>
</example>

<example id="C" title="Format C — WH Total + WHE Total (both positive)">
<input>
*MBS- IR2 MANPOWER*
*Company: Woh Hup*
*Date: 27/04/2026*
*Day: MONDAY*

· *WH Workers Manpower*

WH Total = 06
WHE Total = 02

WH Grand Total= 08
</input>
<reasoning>
"WH Total = 06" in WH Workers section → Worker:6.
"WHE Total = 02" → Engineer:2.
"WH Grand Total= 08" is sum check only — verify 6+2=8 ✓. Do NOT include as role.
</reasoning>
<expected_output>
{"isValid":true,"rejectionReason":null,"date":"27-Apr-2026","totalWorkers":8,"workerBreakdown":[{"role":"Worker","count":6},{"role":"Engineer","count":2}]}
</expected_output>
</example>

<example id="D" title="Format D — Workers + WH Engineering Workers (different language, same data)">
<input>
*MBS- IR2 MANPOWER*
*Company: Woh Hup*
*Date: 27/04/2026*
*Day: MONDAY*

· *WH Workers Manpower*

Workers: T= 06

WH Engineering Workers =T 02
</input>
<expected_output>
{"isValid":true,"rejectionReason":null,"date":"27-Apr-2026","totalWorkers":8,"workerBreakdown":[{"role":"Worker","count":6},{"role":"Engineer","count":2}]}
</expected_output>
</example>

<example id="E" title="Format E — WH Staff Manpower (REJECT — not handled by this extractor)">
<input>
*MBS- IR2 MANPOWER*
*Company: Woh Hup*
*Date: 28/04/2026*
*Day: Tuesday*

* WH Staff Manpower

Staff TS= 17
Staff NTS= 05
</input>
<expected_output>
{"isValid":false,"rejectionReason":"Staff manpower section — handled by wh-staff-tracker, not by this extractor","date":"","totalWorkers":0,"workerBreakdown":[]}
</expected_output>
</example>

<example id="F" title="Edge case — only Engineers (no Workers line)">
<input>
*MBS- IR2 MANPOWER*
*Company: Woh Hup*
*Date: 30/04/2026*

· *WH Workers Manpower*

WH Engineering = 03
</input>
<reasoning>
Only Engineers reported. No Worker line. Engineer count > 0, so the message is valid.
</reasoning>
<expected_output>
{"isValid":true,"rejectionReason":null,"date":"30-Apr-2026","totalWorkers":3,"workerBreakdown":[{"role":"Engineer","count":3}]}
</expected_output>
</example>

<example id="G" title="NEW FORMAT — Workers on site + Total register + non-on-site lines">
<input>
*MBS- IR2 MANPOWER*
*Company: Woh Hup*
*Date: 29/04/2026*
*Day: WEDNESDAY*

 *WH Workers Manpower*
Total: 27
* Workers on site: 6
* ⁠Home leave: 1
* ⁠Loan out: 20
</input>
<reasoning>
"Workers on site: 6" is the ON-SITE worker count → {role: "Worker", count: 6}.
"Total: 27" is the TOTAL REGISTER count (NOT on-site) → IGNORE per rule 4a.
"Home leave: 1" → IGNORE per rule 4a (non-on-site).
"Loan out: 20" → IGNORE per rule 4a (non-on-site).
Sanity check: Total Register (27) = On site (6) + Home leave (1) + Loan out (20) ✓ — but we save only the on-site count.
The Total/Home leave/Loan out values are tracked separately by wh-worker-breakdown-tracker for the daily image — NOT by this extractor.
</reasoning>
<expected_output>
{"isValid":true,"rejectionReason":null,"date":"29-Apr-2026","totalWorkers":6,"workerBreakdown":[{"role":"Worker","count":6}]}
</expected_output>
<wrong_output>
{"workerBreakdown":[{"role":"Worker","count":27}]} ← WRONG: used Total Register, not on-site
{"workerBreakdown":[{"role":"Worker","count":6},{"role":"HomeLeave","count":1}]} ← WRONG: invented a HomeLeave role / non-on-site lines must NOT appear
{"totalWorkers":27} ← WRONG: totalWorkers must equal on-site sum, not Total Register
</wrong_output>
</example>

<example id="H" title="NEW FORMAT — Workers on site zero (REJECT)">
<input>
*MBS- IR2 MANPOWER*
*Company: Woh Hup*
*Date: 30/04/2026*

 *WH Workers Manpower*
Total: 27
* Workers on site: 0
* ⁠Home leave: 1
* ⁠Loan out: 26
</input>
<reasoning>
"Workers on site: 0" → no on-site workers. Even though Total: 27 is non-zero, on-site is what counts. Reject.
</reasoning>
<expected_output>
{"isValid":false,"rejectionReason":"Zero workers reported — nothing to record","date":"","totalWorkers":0,"workerBreakdown":[]}
</expected_output>
</example>

<example id="I" title="NEW FORMAT — Workers on site + Engineering">
<input>
*MBS- IR2 MANPOWER*
*Company: Woh Hup*
*Date: 02/05/2026*

 *WH Workers Manpower*
Total: 30
* Workers on site: 6
* WH Engineering: 2
* ⁠Home leave: 1
* ⁠Loan out: 21
</input>
<reasoning>
"Workers on site: 6" → Worker:6 (on-site). "WH Engineering: 2" → Engineer:2. Total/Home leave/Loan out → ignore (non-on-site).
Total on-site = 6 + 2 = 8.
</reasoning>
<expected_output>
{"isValid":true,"rejectionReason":null,"date":"02-May-2026","totalWorkers":8,"workerBreakdown":[{"role":"Worker","count":6},{"role":"Engineer","count":2}]}
</expected_output>
</example>

<example id="J" title="WH ENGINEERING SECTION — Workers count means Engineers (sectionType=engineering)">
<input>
*MBS- IR2 MANPOWER*
*Company: Woh Hup Engineering*
*Date: 29/04/2026*
*Day: WEDNESDAY*

 *WH Engineering*

Workers = 2
</input>
<reasoning>
sectionType is "engineering". The company is "Woh Hup Engineering" and the section is "WH Engineering" — this is a separate engineering manpower message. Per the engineering section_context, "Workers = 2" means Engineer:2 (NOT Worker:2). Engineers are the on-site count for engineering staff.
</reasoning>
<expected_output>
{"isValid":true,"rejectionReason":null,"date":"29-Apr-2026","totalWorkers":2,"workerBreakdown":[{"role":"Engineer","count":2}]}
</expected_output>
<wrong_output>
{"workerBreakdown":[{"role":"Worker","count":2}]} ← WRONG: in WH Engineering section, "Workers" means engineers
{"workerBreakdown":[]} ← WRONG: a count IS present, even if labeled "Workers"
</wrong_output>
</example>

<example id="K" title="WH ENGINEERING SECTION — zero workers (REJECT, sectionType=engineering)">
<input>
*MBS- IR2 MANPOWER*
*Company: Woh Hup Engineering*
*Date: 30/04/2026*

 *WH Engineering*

Workers = 0
</input>
<expected_output>
{"isValid":false,"rejectionReason":"Zero workers reported — nothing to record","date":"","totalWorkers":0,"workerBreakdown":[]}
</expected_output>
</example>

<example id="L" title="WH ENGINEERING SECTION — Workers + Absent + Worker on site (use ON-SITE only)">
<input>
*MBS- IR2 MANPOWER*
*Company: Woh Hup Engineering*
*Date: 04/05/2026*
*Day: MONDAY*

 *WH Engineering*

Workers = 02
Absent =01
Worker on site= 01
</input>
<reasoning>
sectionType is "engineering". The message contains a "Worker on site" line, so the PRIORITY RULE kicks in: that's the authoritative on-site Engineer count = 1. The "Workers = 02" line is now the register/total (NOT on-site) and must be ignored. "Absent =01" is non-on-site accounting — also ignored. Sanity check: 2 (register) − 1 (absent) = 1 (on-site) ✓ — but only the on-site count is saved.
</reasoning>
<expected_output>
{"isValid":true,"rejectionReason":null,"date":"04-May-2026","totalWorkers":1,"workerBreakdown":[{"role":"Engineer","count":1}]}
</expected_output>
<wrong_output>
{"workerBreakdown":[{"role":"Engineer","count":2}]} ← WRONG: used "Workers = 02" register count; should use "Worker on site= 01"
{"workerBreakdown":[{"role":"Engineer","count":2},{"role":"Engineer","count":1}]} ← WRONG: combining register + on-site; only on-site should appear
{"workerBreakdown":[{"role":"Engineer","count":1},{"role":"Absent","count":1}]} ← WRONG: invented an "Absent" role; non-on-site lines must NEVER appear
</wrong_output>
</example>

<example id="M" title="WH ENGINEERING SECTION — Worker on site zero (REJECT, sectionType=engineering)">
<input>
*MBS- IR2 MANPOWER*
*Company: Woh Hup Engineering*
*Date: 05/05/2026*

 *WH Engineering*

Workers = 02
Absent =02
Worker on site= 00
</input>
<reasoning>
"Worker on site= 00" is the on-site count → 0. Even though Workers register is 2, no engineers are actually on site today. Reject — nothing to record on the manpower sheet.
</reasoning>
<expected_output>
{"isValid":false,"rejectionReason":"Zero workers reported — nothing to record","date":"","totalWorkers":0,"workerBreakdown":[]}
</expected_output>
</example>

</examples>

<final_reminders>
- Return ONLY valid JSON matching the schema — no markdown, no commentary.
- Counts MUST match the message verbatim. If "Workers: T= 06" then count=6, never 5 or 7.
- "WH Grand Total" is informational only — never a role.
- SKIP zero-count entries from workerBreakdown.
- If workerBreakdown ends up empty → isValid=false.
- Date today (if message has no date): ${dateInfo.today}
</final_reminders>`;

  const userPrompt = `Extract the worker data from this Wohhup manpower message:\n\n${messageBody}`;

  try {
    const response = await getOpenAI().responses.create({
      model: "gpt-4.1",
      temperature: 0,
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "wohhup_workers_extraction",
          strict: true,
          schema,
        },
      },
      store: true,
      metadata: { project: "wohhup", type: "wohhup_manpower" },
    });

    if (!response.output_text) return null;
    const result = JSON.parse(response.output_text);

    // Code-side double-guard: if breakdown empty and isValid, force isValid=false
    if (result.isValid && (!result.workerBreakdown || result.workerBreakdown.length === 0)) {
      result.isValid = false;
      result.rejectionReason = result.rejectionReason || "Empty workerBreakdown — nothing to record";
      result.totalWorkers = 0;
    }

    // Code-side double-guard: validate the date format when valid
    if (result.isValid) {
      const dv = validateDateFormat(result.date);
      if (!dv.isValid) {
        // Fall back to today
        result.date = dateInfo.today;
      }
      // Recompute totalWorkers from breakdown to guarantee consistency
      const sum = result.workerBreakdown.reduce((a, b) => a + (parseInt(b.count, 10) || 0), 0);
      result.totalWorkers = sum;
    }

    return result;
  } catch (error) {
    console.error("[Wohhup Extract] Error:", error.message);
    return null;
  }
}

module.exports = {
  detectWohhupManpowerFormat,
  extractWohhupWorkersManpower,
};
