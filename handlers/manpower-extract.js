const { getOpenAI } = require("../utils/openai");

/**
 * Get current date info in Singapore timezone for LLM context
 * Format: DD-MMM-YYYY (e.g., "21-Sep-2025")
 */
function getSingaporeDateInfo() {
  const now = new Date();
  const sgOptions = { timeZone: "Asia/Singapore" };

  const day = now.toLocaleDateString("en-GB", { ...sgOptions, day: "2-digit" });
  const month = now.toLocaleDateString("en-GB", { ...sgOptions, month: "short" });
  const year = now.toLocaleDateString("en-GB", { ...sgOptions, year: "numeric" });

  const todayFormatted = `${day}-${month}-${year}`;

  // Calculate tomorrow
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const tomorrowDay = tomorrow.toLocaleDateString("en-GB", { ...sgOptions, day: "2-digit" });
  const tomorrowMonth = tomorrow.toLocaleDateString("en-GB", { ...sgOptions, month: "short" });
  const tomorrowYear = tomorrow.toLocaleDateString("en-GB", { ...sgOptions, year: "numeric" });
  const tomorrowFormatted = `${tomorrowDay}-${tomorrowMonth}-${tomorrowYear}`;

  // Calculate yesterday
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const yesterdayDay = yesterday.toLocaleDateString("en-GB", { ...sgOptions, day: "2-digit" });
  const yesterdayMonth = yesterday.toLocaleDateString("en-GB", { ...sgOptions, month: "short" });
  const yesterdayYear = yesterday.toLocaleDateString("en-GB", { ...sgOptions, year: "numeric" });
  const yesterdayFormatted = `${yesterdayDay}-${yesterdayMonth}-${yesterdayYear}`;

  return {
    today: todayFormatted,
    tomorrow: tomorrowFormatted,
    yesterday: yesterdayFormatted,
  };
}

const metadata = {
  project: "wohhup",
  type: "manpower",
};

// Valid short month names (3-letter abbreviations)
const VALID_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Validate date format is DD-MMM-YYYY (e.g., "08-Oct-2025")
 * @param {string} dateStr - The date string to validate
 * @returns {{ isValid: boolean, reason?: string }} Validation result
 */
function validateDateFormat(dateStr) {
  if (!dateStr || typeof dateStr !== "string") {
    return { isValid: false, reason: "Date is missing or not a string" };
  }

  const trimmed = dateStr.trim();

  // Reject relative date words
  const relativeWords = ["today", "tomorrow", "yesterday", "now", "next", "last"];
  if (relativeWords.some((word) => trimmed.toLowerCase().includes(word))) {
    return {
      isValid: false,
      reason: `Date contains relative word "${trimmed}" - must be converted to actual date (DD-MMM-YYYY format, e.g., "21-Sep-2025")`,
    };
  }

  // Check format: DD-MMM-YYYY (e.g., "21-Sep-2025")
  const dateRegex = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/;
  const match = trimmed.match(dateRegex);

  if (!match) {
    return {
      isValid: false,
      reason: `Date "${trimmed}" is not in DD-MMM-YYYY format (e.g., "21-Sep-2025")`,
    };
  }

  const [, day, month, year] = match;

  // Validate month is a valid 3-letter abbreviation
  const monthCapitalized = month.charAt(0).toUpperCase() + month.slice(1).toLowerCase();
  if (!VALID_MONTHS.includes(monthCapitalized)) {
    return {
      isValid: false,
      reason: `Date "${trimmed}" has invalid month "${month}" - must be 3-letter abbreviation (Jan, Feb, Mar, Apr, May, Jun, Jul, Aug, Sep, Oct, Nov, Dec)`,
    };
  }

  // Validate day is reasonable
  const dayNum = parseInt(day, 10);
  if (dayNum < 1 || dayNum > 31) {
    return { isValid: false, reason: `Date "${trimmed}" has invalid day ${day}` };
  }

  // Validate year is reasonable (2020-2030 range)
  const yearNum = parseInt(year, 10);
  if (yearNum < 2020 || yearNum > 2030) {
    return { isValid: false, reason: `Date "${trimmed}" has unusual year ${year}` };
  }

  return { isValid: true };
}

/**
 * Extract and validate manpower data from a message using OpenAI.
 * This is the shared extraction logic used by both createManpowerData and handleEditedManpowerMessage.
 * Returns the validated extraction result or null if extraction failed.
 * @param {string} messageContent - The raw message text to extract from
 * @returns {Promise<{args: object, functionCalls: Array}|null>} - Validated extraction or null
 */
async function extractManpowerFromMessage(messageContent) {
  const schema = {
    type: "object",
    properties: {
      isValidReport: { type: "boolean" },
      rejectionReason: { type: ["string", "null"] },
      date: { type: "string" },
      shift: {
        type: "string",
        enum: ["Day", "Night"],
        description:
          "Shift type: 'Night' if message mentions night shift, evening time (1900hrs, 7PM+), or NIGHT SHIFT TBM. Otherwise 'Day'.",
      },
      companies: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            location: { type: "string" },
            totalWorkers: { type: "integer" },
            workerBreakdown: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  role: { type: "string" },
                  count: { type: "integer" },
                },
                required: ["role", "count"],
                additionalProperties: false,
              },
            },
            activity: { type: "string" },
            totalMachines: { type: "integer" },
            machineBreakdown: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  count: { type: "integer" },
                },
                required: ["name", "count"],
                additionalProperties: false,
              },
            },
          },
          required: [
            "name",
            "location",
            "totalWorkers",
            "workerBreakdown",
            "activity",
            "totalMachines",
            "machineBreakdown",
          ],
          additionalProperties: false,
        },
      },
    },
    required: ["isValidReport", "rejectionReason", "date", "shift", "companies"],
    additionalProperties: false,
  };

  // Get current date info for relative date handling
  const dateInfo = getSingaporeDateInfo();

  const input = [
    {
      role: "system",
      content: `<role_and_objective>
You are a construction manpower data extraction system.
Your ONLY task: extract structured data from WhatsApp manpower reports and return it as JSON.
NEVER fabricate data not present in the source message. If data is missing, use 0 or empty array — never guess.
</role_and_objective>

<report_validation>
A VALID manpower report requires ALL of: (1) a date or implying today, (2) a company/contractor name (a real name, not a placeholder), (3) AT LEAST ONE role name with a worker count (not just activity descriptions).

⚠️ **One role is enough.** Small subcontractors often deploy a single trade for the day (e.g. a welding crew of 2 pax). Do NOT reject a report just because it lists only one role — a single explicit "Role : N pax" with a company name and date is a VALID report. Never invent a "minimum number of roles" rule.

INVALID — reject with isValidReport=false:
- Operational instructions: "gather at rest area", "send 3 workers"
- Casual company-level headcount with no role breakdown: "ABC Co - 5 workers today" (no role named)
- MISSING COMPANY NAME: No company or contractor name is present (e.g., just a numbered role list with a date but no entity name). REJECT even if it has role-count pairs and a date — a company/contractor identity is mandatory.
- TEMPLATE / PLACEHOLDER messages: Any field value contains placeholder tokens such as "XXX", "XX/XXX/XX", "N/A", "TBD", or blank underscores ("____"). These are unfilled form templates, not real reports. Do NOT extract placeholder values as real data.
- ACTIVITY-ONLY reports: The message contains ONLY descriptions of work activities, site locations, or shift narratives (e.g., "Excavation at CW18", "Bound wall setup at P123") with NO numeric role-count pairs. Activity codes like "CW18", "P123", "B95" are location/task identifiers, NOT worker roles.

If INVALID: set isValidReport=false, rejectionReason="<explanation>", date="", companies=[].
</report_validation>

<extraction_workflow>
Follow these steps IN ORDER for each message:

STEP 1: VALIDATE
- Does this message meet the valid report criteria above?
- If NO → return isValidReport=false with rejectionReason, date="", companies=[]. Stop here.

STEP 2: EXTRACT DATE
- Parse the date into DD-MMM-YYYY format (e.g., "08-Oct-2025").
- See <date_parsing> section for conversion rules.

STEP 2B: DETERMINE SHIFT TYPE
- Set shift = "Night" if ANY of these are true:
  • Message contains "night shift" or "NIGHT SHIFT" (case-insensitive)
  • Message contains "NIGHT SHIFT TBM"
  • Message time is 6:00 PM or later (e.g., 1900 Hours, 0645PM, 0715PM, 7:00PM, 1800hrs — any PM time where hour >= 6, or 24h format >= 18:00)
  • Message explicitly mentions night activities
- Otherwise set shift = "Day" (this is the default)

STEP 3: IDENTIFY COMPANY
- Each message is ONE report from ONE company. ALWAYS extract exactly ONE company entry — never split into multiple entries.
- Extract the company name and work location.
- Location MUST come from the "Work location:" section of the message only. If multiple zones/locations are listed, combine them into a single location string (e.g., "Zone A, Zone B, Zone C").
- Do NOT use parenthetical notes in worker entries as location (e.g., "Electrician : 1(LOYANG DATA CENTER)LOAN" — "LOYANG DATA CENTER" is the loan destination, not a work location).
- Do NOT duplicate the company entry for each location/zone — there is always exactly ONE company with ONE set of workers per message.

STEP 4: DETERMINE totalWorkers (per company)
Use this STRICT priority order:
  Priority 1: "Manpower on site" → use this value. Evaluate arithmetic expressions ("8+2+1" = 11).
  Priority 2: "Total manpower" is given but NO "Manpower on site" → take "Total manpower" and SUBTRACT all non-on-site roles (Home Leave, Off Day, MC, Medical Leave, HL).
  Priority 3: Neither total is given → sum all on-site role counts from the breakdown.
NEVER use "Total manpower" directly as totalWorkers when "Manpower on site" exists.

STEP 5: EXTRACT workerBreakdown (per company)
- Every role/worker type mentioned with count > 0 → add to workerBreakdown as {role: "RoleName", count: N}.
- Formats to recognize: "Role : Count", "Role - Count", "Role: Count", "Role-Count", comma-separated lists.
- EXCLUDE these non-on-site categories entirely (do NOT add them to workerBreakdown):
  Home Leave, HL, Off Day, Off day, MC, Medical Leave, Loan to [any company]
- SKIP roles with count = 0 (e.g., "WSHC - 00" → do not include).
- If only a total is given with no individual roles listed, set workerBreakdown to [].
- SPECIAL RULE — Role-attributed absence (e.g., "Absent - 1 (MSE)"): subtract that count from the named role's count in workerBreakdown. Do NOT add "Absent" as its own entry. Example: "MSE Worker : 4" and "Absent - 1 (MSE)" → workerBreakdown entry for MSE Worker = 3 (4 - 1).

STEP 6: EXTRACT machineBreakdown (per company)
- Every machine/equipment type with count > 0 → add to machineBreakdown as {name: "MachineName", count: N}.
- Preserve identifiers in parentheses: "Excavator (Ex-858) - 1" → {name: "Excavator (Ex-858)", count: 1}.
- If no machinery data exists, set totalMachines=0 and machineBreakdown=[].
- SECTION HEADERS to recognise (all equivalent — look for any of these to find the machinery block): "Machinery", "Machineries", "Machinery and Equipment", "Machineries and Equipment", "Machineries and Equipment's", "Machine & Equipment", "Machines", "Equipment", or any similar variation. The header may be wrapped in asterisks/bold markers (e.g., "*Machineries and Equipment's*:").
- EMOJI BULLET POINTS: Lines may begin with emoji decorators (🔹, ✅, ▪, •, →, **, etc.). Strip the leading emoji/symbol and extract only the machine name and count. Example: "🔹Service Crane :-06" → {name: "Service Crane", count: 6}. "🔹Grab crane :-03" → {name: "Grab crane", count: 3}. Do NOT include the emoji in the machine name.
- SEPARATOR FORMATS: Counts may be separated by " - ", " : ", " :- ", " :-", "=", or similar variations. Always parse as integer. Leading zeroes are fine ("06" → 6, "03" → 3, "01" → 1).

STEP 7: EXTRACT activity (per company)
- Look for a section with header like "Work Activity", "Work Activities", "Work activities:", "Activities:", or similar variations (including typos like "Wokr activties").
- Extract the COMPLETE activity text EXACTLY as written in the message — preserve numbering, bullet points, line breaks.
- Include everything from the activity header until the next section header or end of company block.
- Do NOT include the section header itself (e.g., "Work Activities" or "Work activities:").
- If no activity section exists: set activity = "" (empty string). NEVER fabricate activities.
- The activity field is a plain text string, NOT an array — just copy the raw text content.

STEP 8: SELF-CHECK (mandatory before returning)
- Verify every role name and count matches EXACTLY what is written in the source message. NEVER change a number.
- If "Lifting Supervisor:-14" is written, the count MUST be 14. Never reduce it to make sums match.
- If the message says "Total Manpower = 103" but the individual roles sum to 108, STILL extract totalWorkers=103 AND every role with its exact count. The sender's arithmetic error is NOT your problem — extract verbatim.
- Verify totalMachines and each machineBreakdown count matches the source message exactly.
- Evaluate all arithmetic expressions to integers — never return strings like "8+2+1".
- If workerBreakdown is empty [] and totalWorkers > 0: re-read EVERY role line in the message and confirm each one is an excluded category (LOAN, HOME LEAVE, MC, Off Day, etc.). If ANY non-excluded role line exists, it MUST be added to workerBreakdown.
</extraction_workflow>

<exclusion_rules>
These categories represent workers NOT physically present on site. EXCLUDE them from BOTH workerBreakdown AND totalWorkers:
- Home Leave / HL
- Off Day / Off day
- MC / Medical Leave
- Loan to [any company name]
- Generic "Absent" with no role specified — exclude entirely
When using Priority 2 (Total manpower minus exclusions), subtract the sum of ALL excluded categories.

Role-attributed absences like "Absent - 1 (MSE)" are NOT excluded — they REDUCE the named role's count in workerBreakdown (see STEP 5 SPECIAL RULE). The "Manpower on site" total already accounts for these, so do NOT subtract again.
</exclusion_rules>

<examples>
<example id="1" title="Standard report with Manpower on site AND Total manpower">
<input>
Manpower on site : 8+2+1 (Tanglin)
Chargehand : 01
General Worker : 06
Tanglin Operater : 02
Traffic controller : 01
Home Leave : 02
Supplier worker : 01
Total manpower : 10+2+1 (Tanglin)
</input>
<reasoning>
1. "Manpower on site : 8+2+1" → Priority 1 → evaluate: 8+2+1 = 11 → totalWorkers = 11
2. "Total manpower : 10+2+1" = 13 → IGNORE (Priority 1 takes precedence)
3. On-site roles: Chargehand(1), General Worker(6), Tanglin Operater(2), Traffic controller(1), Supplier worker(1) = 11
4. Home Leave(2) → EXCLUDED (not on site)
5. Self-check: 1+6+2+1+1 = 11 = totalWorkers ✓
</reasoning>
<expected_output>
totalWorkers: 11
workerBreakdown: [{"role":"Chargehand","count":1},{"role":"General Worker","count":6},{"role":"Tanglin Operater","count":2},{"role":"Traffic controller","count":1},{"role":"Supplier worker","count":1}]
activity: "" (no Work Activities section in message)
</expected_output>
<wrong_output>
totalWorkers: 13 ← WRONG: used "Total manpower" instead of "Manpower on site"
workerBreakdown includes {"role":"Home Leave","count":2} ← WRONG: Home Leave is not on site
activity: "Chargehand, General Worker..." ← WRONG: fabricated activity from role list — roles are NOT activities
</wrong_output>
</example>

<example id="2" title="Only Total manpower given (no Manpower on site)">
<input>
Total manpower : 15
Supervisor : 02
General Worker : 10
Home Leave : 03
</input>
<reasoning>
1. No "Manpower on site" → Priority 2 → Total manpower = 15
2. Subtract non-on-site: Home Leave = 3 → totalWorkers = 15 - 3 = 12
3. workerBreakdown: Supervisor(2) + General Worker(10) = 12 ✓
4. Home Leave EXCLUDED from breakdown
</reasoning>
<expected_output>
totalWorkers: 12
workerBreakdown: [{"role":"Supervisor","count":2},{"role":"General Worker","count":10}]
activity: "" (no Work Activities section in message)
</expected_output>
</example>

<example id="3" title="No totals given — only role list">
<input>
Supervisor : 02
General Worker : 08
Traffic controller : 01
</input>
<reasoning>
1. No total field → Priority 3 → sum on-site roles: 2+8+1 = 11
2. totalWorkers = 11
</reasoning>
<expected_output>
totalWorkers: 11
workerBreakdown: [{"role":"Supervisor","count":2},{"role":"General Worker","count":8},{"role":"Traffic controller","count":1}]
activity: "" (no Work Activities section in message)
</expected_output>
</example>

<example id="4" title="Multi-company report">
<input>
Date: 15/01/26

ABC Construction - Bishan Site
Manpower on site: 8
Supervisor - 1
General Worker - 5
Safety Officer - 2
Crane - 1

XYZ Engineering - Toa Payoh
Total manpower: 10
Foreman: 2
Welder: 5
Off Day: 3
Excavator (EX-200) - 1
</input>
<reasoning>
Company 1 (ABC): "Manpower on site: 8" → Priority 1 → totalWorkers = 8. Breakdown: 1+5+2 = 8 ✓
Company 2 (XYZ): No "Manpower on site" → Priority 2 → 10 - Off Day(3) = 7 → totalWorkers = 7. Breakdown: 2+5 = 7 ✓
Date: "15/01/26" → DD/MM/YY → 15-Jan-2026
</reasoning>
<expected_output>
date: "15-Jan-2026"
companies: [
  {name: "ABC Construction", location: "Bishan Site", totalWorkers: 8, workerBreakdown: [{"role":"Supervisor","count":1},{"role":"General Worker","count":5},{"role":"Safety Officer","count":2}], activity: "", totalMachines: 1, machineBreakdown: [{"name":"Crane","count":1}]},
  {name: "XYZ Engineering", location: "Toa Payoh", totalWorkers: 7, workerBreakdown: [{"role":"Foreman","count":2},{"role":"Welder","count":5}], activity: "", totalMachines: 1, machineBreakdown: [{"name":"Excavator (EX-200)","count":1}]}
]
(Both companies have no Work Activities section → activity: "")
</expected_output>
</example>

<example id="5" title="Role-attributed absence — Absent subtracts from role count">
<input>
Manpower on site : 4
MSE Worker : 4
Vector control: 1
Absent - 1 (MSE)
Total manpower : 5
</input>
<reasoning>
1. "Manpower on site : 4" → Priority 1 → totalWorkers = 4
2. "Total manpower : 5" → IGNORE (Priority 1 takes precedence)
3. "Absent - 1 (MSE)" → SPECIAL RULE: subtract 1 from MSE Worker count → MSE Worker = 4 - 1 = 3
4. workerBreakdown: MSE Worker(3) + Vector control(1) = 4 ✓
</reasoning>
<expected_output>
totalWorkers: 4
workerBreakdown: [{"role":"MSE Worker","count":3},{"role":"Vector control","count":1}]
activity: "" (no Work Activities section in message)
</expected_output>
</example>

<example id="6" title="Report with Work Activities section">
<input>
Date: 20/03/26

Teamtech Pte Ltd - Zone A
Manpower on site: 12
Supervisor - 2
General Worker - 8
Safety Officer - 2

Work Activities:
1. Rebar work
2. Formwork erection & dismantling
3. Housekeeping

Machinery:
Excavator - 1
</input>
<reasoning>
1. Date: "20/03/26" → DD/MM/YY → 20-Mar-2026
2. Company: Teamtech Pte Ltd, Location: Zone A
3. "Manpower on site: 12" → Priority 1 → totalWorkers = 12
4. Breakdown: Supervisor(2) + General Worker(8) + Safety Officer(2) = 12 ✓
5. Activity section found: "Work Activities:" → extract everything after header until next section
6. activity = "1. Rebar work\\n2. Formwork erection & dismantling\\n3. Housekeeping"
7. Machinery: Excavator(1) → totalMachines = 1
</reasoning>
<expected_output>
date: "20-Mar-2026"
companies: [{name: "Teamtech Pte Ltd", location: "Zone A", totalWorkers: 12, workerBreakdown: [{"role":"Supervisor","count":2},{"role":"General Worker","count":8},{"role":"Safety Officer","count":2}], activity: "1. Rebar work\\n2. Formwork erection & dismantling\\n3. Housekeeping", totalMachines: 1, machineBreakdown: [{"name":"Excavator","count":1}]}]
</expected_output>
</example>

<example id="6b" title="VALID — small subcontractor with a single role (one trade for the day)">
<input>
*Company* : WHPL(TTJ)
*Date* 17/05/2026
*Time* :  08:15AM
 *Subject* :TBM

*Total Manpower* :
Welder        :
2pax

*TBM conducted By*: Ezhil

*Attended By* (Production staff / Site Management / Safety): Ezhil/Karthik

*Activities:-*
1)Rebar welding

*Control measures:*
1) Provide Hose conduit on Electrical cable, Face Shield, hand gloves
2) All to use sufficient PPE at all times
</input>
<reasoning>
Has company (WHPL(TTJ)), date (17/05/2026), and ONE explicit role-count pair (Welder : 2 pax). A single role is sufficient — small subcontractors commonly deploy a single trade. The "Subject: TBM" tag and Control Measures section are briefing context attached to the deployment, not grounds for rejection. Activity = "1)Rebar welding".
</reasoning>
<expected_output>
date: "17-May-2026"
shift: "Day"
companies: [{name: "WHPL(TTJ)", location: "", totalWorkers: 2, workerBreakdown: [{"role":"Welder","count":2}], activity: "1)Rebar welding", totalMachines: 0, machineBreakdown: []}]
</expected_output>
<wrong_output>
isValidReport: false ← WRONG: single-role reports are valid
rejectionReason: "Only one role listed" ← WRONG: no such rule exists
</wrong_output>
</example>

<example id="7" title="Invalid message — operational instruction">
<input>
Mass housekeeping gather at rest area, Wohup-5 persons
</input>
<reasoning>
This is an operational instruction, not a manpower report. No individual role breakdown with counts.
</reasoning>
<expected_output>
isValidReport: false
rejectionReason: "Operational instruction, not a structured manpower report with individual role breakdowns"
date: ""
companies: []
</expected_output>
</example>

<example id="8" title="INVALID — no company name (role-count pairs present but company missing)">
<input>
30/03/2026
1) traffic controller -1
2) Vector controller - 1
3) safety workers -2
4) Rigger -1
Total 5
</input>
<reasoning>
Has a date and role-count pairs, but NO company or contractor name is present anywhere in the message. A company name is mandatory for a valid report. This is NOT a valid manpower report.
</reasoning>
<expected_output>
isValidReport: false
rejectionReason: "No company or contractor name found. A valid manpower report must identify who is reporting."
date: ""
companies: []
</expected_output>
<wrong_output>
isValidReport: true ← WRONG: accepted despite missing company name
companies: [{name: "Unknown", ...}] ← WRONG: fabricated a company name
</wrong_output>
</example>

<example id="9" title="INVALID — template/placeholder message (XXX values)">
<input>
Date: XX/XXX/XX
Time: 07.30 AM
Company: XXX
Manpower:
1. Manager   =1
2. WSHC       =1
3. WSHS       = 1
4. Supervisor =02
5. Engineer =1
6. Worker.  =15
Total Manpower=21
Work Location: Zone B- L1 CJ2
Work activities:
1. Rebar work
2. Formwork erection & dismantling
</input>
<reasoning>
The date field is "XX/XXX/XX" (a placeholder), and company is "XXX" (a placeholder). Although the message has the STRUCTURE of a manpower report and has numeric role-count pairs, it is an unfilled template — not real data. Placeholder values indicate no actual report was submitted.
</reasoning>
<expected_output>
isValidReport: false
rejectionReason: "Template/placeholder message — date and company fields contain placeholder values (XX/XXX/XX, XXX). Not real data."
date: ""
companies: []
</expected_output>
<wrong_output>
isValidReport: true ← WRONG: accepted a template with no real data
date: "30-Mar-2026" ← WRONG: fabricated or guessed a date that was not in the message
companies: [{name: "XXX", ...}] ← WRONG: extracted placeholder as real company name
</wrong_output>
</example>

<example id="10" title="INVALID — activity-only / shift narrative (no role-count pairs)">
<input>
Date:30/03/2026 (Monday)
LT Sambo Night Shift Activities

>>CW18,CW32,CW90,P126,P211  Excavation
>>P123 bound wall setup, Ready for Excavation.
>>B95 base grouting 1st stage
>>P113 Casting
>>CW85 Rebar cage & KP install.
>>P196 Excavation,Base cleaning & pipe desanding
>>Cw115 Desanding,Koden Check & Rebar cage install.

>>BP223 Boring
>>BP167 LSS backfilling
>>BP219 Boring & Desanding.
>>BP94 Prepare for pre boring.

>>Capping beam hacking hardcore Cleaning
>>hot work
>>Pipe Line making
>>Soil internal Shifting
>>House keeping

Thanks
</input>
<reasoning>
Has a date and a name ("LT Sambo") but contains ONLY descriptions of work activities — no numeric role-count pairs (e.g., "Foreman - 1", "Workers - 10"). "CW18", "P123", "B95", "BP223" are location/task identifiers, not worker roles with counts. This is a shift activity log, not a manpower headcount report.
</reasoning>
<expected_output>
isValidReport: false
rejectionReason: "Activity-only report — no role-count pairs found. Contains only work activity descriptions with location/task codes, not a structured workforce headcount."
date: ""
companies: []
</expected_output>
<wrong_output>
isValidReport: true ← WRONG: no role-count pairs exist
companies: [{name: "LT Sambo", totalWorkers: 3, workerBreakdown: [{"role":"CW18","count":1},...]}] ← WRONG: fabricated workers from location/task codes
</wrong_output>
</example>

<example id="11" title="VALID — full report with emoji-decorated machinery section">
<input>
Project Name :MBS-IR2
Company : LTSAMBO
Date : 30/03/2026
Time: 0645PM

*Manpower*
1) Manager - 01
2) Site Supervisor -06
3) Rigger -19
4) G/Workers-2
5) Welders -10
6) Fire watchman-03
7) excavator op-06
8) banksman-6
9) Foreman -6
 *Total manpower* -59

*Machineries and Equipment's*:
🔹Service Crane :-06
🔹Grab crane :-03
🔹Excavator:-12
🔹Mini Excavator :-01

*Work Location* :
ZONE-1.2.3.4

*Work Activity* :
1.Grab crane excavation
2.lifting activities
3.welding activities
</input>
<reasoning>
1. Valid report: company = "LTSAMBO", date = "30/03/2026", role-count pairs present.
2. Date: "30/03/2026" → 30-Mar-2026
3. Company: LTSAMBO, Location: ZONE-1.2.3.4 (from Work Location)
4. No "Manpower on site" → Priority 2: Total manpower = 59. No excluded categories → totalWorkers = 59.
5. workerBreakdown: Manager(1) + Site Supervisor(6) + Rigger(19) + G/Workers(2) + Welders(10) + Fire watchman(3) + excavator op(6) + banksman(6) + Foreman(6) = 59 ✓
6. Machinery section header: "*Machineries and Equipment's*:" → this is the machinery block.
   Strip emoji bullets: 🔹Service Crane :-06 → {name:"Service Crane", count:6}
   🔹Grab crane :-03 → {name:"Grab crane", count:3}
   🔹Excavator:-12 → {name:"Excavator", count:12}
   🔹Mini Excavator :-01 → {name:"Mini Excavator", count:1}
   totalMachines = 6+3+12+1 = 22
7. Activity: "1.Grab crane excavation\\n2.lifting activities\\n3.welding activities"
</reasoning>
<expected_output>
isValidReport: true
date: "30-Mar-2026"
companies: [{
  name: "LTSAMBO",
  location: "ZONE-1.2.3.4",
  totalWorkers: 59,
  workerBreakdown: [{"role":"Manager","count":1},{"role":"Site Supervisor","count":6},{"role":"Rigger","count":19},{"role":"G/Workers","count":2},{"role":"Welders","count":10},{"role":"Fire watchman","count":3},{"role":"excavator op","count":6},{"role":"banksman","count":6},{"role":"Foreman","count":6}],
  activity: "1.Grab crane excavation\\n2.lifting activities\\n3.welding activities",
  totalMachines: 22,
  machineBreakdown: [{"name":"Service Crane","count":6},{"name":"Grab crane","count":3},{"name":"Excavator","count":12},{"name":"Mini Excavator","count":1}]
}]
</expected_output>
<wrong_output>
machineBreakdown: [] ← WRONG: failed to recognise "Machineries and Equipment's" header or emoji bullets
machineBreakdown: [{"name":"🔹Service Crane","count":6}] ← WRONG: kept emoji in machine name
totalMachines: 0 ← WRONG: missed machinery section entirely
</wrong_output>
</example>
</examples>

<date_parsing>
REQUIRED FORMAT: DD-MMM-YYYY (e.g., "08-Oct-2025", "15-Jan-2026")
Month abbreviations: Jan, Feb, Mar, Apr, May, Jun, Jul, Aug, Sep, Oct, Nov, Dec

Current date context (Singapore timezone):
- Today: ${dateInfo.today}
- Tomorrow: ${dateInfo.tomorrow}
- Yesterday: ${dateInfo.yesterday}

Conversion rules:
- "today" / "Today" → "${dateInfo.today}"
- "tomorrow" / "Tomorrow" → "${dateInfo.tomorrow}"
- "yesterday" / "Yesterday" → "${dateInfo.yesterday}"
- "18/09/25" (DD/MM/YY) → "18-Sep-2025" (2-digit year → 20XX)
- "25/12/24" → "25-Dec-2024"
- "08-Oct" or "8-Oct" → "08-Oct-${dateInfo.today.split("-")[2]}" (assume current year)
- "08 Oct 2025" → "08-Oct-2025"
- "8 October 2025" → "08-Oct-2025"
- No date mentioned → use today: "${dateInfo.today}"
NEVER return relative words ("Today", "Tomorrow") — ALWAYS convert to actual DD-MMM-YYYY date.
</date_parsing>

<final_reminders>
Before returning, verify these 5 rules:
1. Return ONLY valid JSON — no explanatory text, no markdown.
2. NEVER fabricate data — if a role or machine is not in the message, do not invent it.
3. Every count value MUST match exactly what is written in the message — NEVER modify a number to fix arithmetic. Extract verbatim.
4. Use "Manpower on site" for totalWorkers, NOT "Total manpower" — follow the priority order.
5. SKIP zero-count roles and EXCLUDE non-on-site categories (Home Leave, Off Day, MC, HL).
6. activity MUST be copied verbatim from the message. If no activity section exists, use empty string "". NEVER make up activity data.
</final_reminders>`,
    },
    {
      role: "user",
      content: `Extract the manpower data from this message.
      The message may contain multiple companies and locations.\n\nMessage: "${messageContent}"`,
    },
  ];

  const maxRetries = 4;
  let validExtraction = null;
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Processing manpower data with OpenAI (attempt ${attempt}/${maxRetries})...`);

      const response = await getOpenAI().responses.create({
        model: "gpt-4.1",
        temperature: 0,
        top_p: 0,
        input,
        text: {
          format: {
            type: "json_schema",
            name: "manpower_extraction",
            strict: true,
            schema,
          },
        },
        store: true,
        metadata: {
          ...metadata,
          attempt: String(attempt),
        },
      });

      if (!response.output_text) {
        console.log("No output from OpenAI");
        lastError = "Empty response from OpenAI.";
        continue;
      }

      const args = JSON.parse(response.output_text);
      const functionCalls = [{ functionName: "extract_manpower_and_machinery_data", arguments: args }];

      // Check if message was classified as a valid manpower report
      if (args.isValidReport === false) {
        console.log(`📋 Message rejected as invalid manpower report: ${args.rejectionReason || "No reason given"}`);
        return { args, functionCalls };
      }

      if (args.companies && args.companies.length > 0) {
        // Convert workerBreakdown/machineBreakdown arrays to objects for downstream processing
        for (const company of args.companies) {
          company.workerBreakdown = Object.fromEntries(
            (company.workerBreakdown || []).map(({ role, count }) => [role, count]),
          );
          company.machineBreakdown = Object.fromEntries(
            (company.machineBreakdown || []).map(({ name, count }) => [name, count]),
          );
          // Compute totalMachines from breakdown sum — LLM arithmetic is unreliable
          // when there's no stated total in the message
          const machineSum = Object.values(company.machineBreakdown).reduce((a, b) => a + b, 0);
          if (machineSum > 0 && company.totalMachines !== machineSum) {
            company.totalMachines = machineSum;
          }
        }

        // Log the full extraction for debugging
        console.log("Manpower extraction result:", JSON.stringify(args, null, 2));

        // Validate date format
        const dateValidation = validateDateFormat(args.date);
        if (!dateValidation.isValid) {
          console.warn(`Date format validation failed (attempt ${attempt}):`, dateValidation.reason);
          lastError = dateValidation.reason;

          if (attempt < maxRetries) {
            const dateInfo = getSingaporeDateInfo();
            input.push({ role: "assistant", content: response.output_text });
            input.push({
              role: "user",
              content: `ERROR: DATE FORMAT WRONG — ${dateValidation.reason}

CORRECTION INSTRUCTIONS:
1. The date MUST be in DD-MMM-YYYY format (e.g., "08-Oct-2025", "21-Sep-2025")
2. Use 3-letter month abbreviations: Jan, Feb, Mar, Apr, May, Jun, Jul, Aug, Sep, Oct, Nov, Dec
3. ALWAYS include the 4-digit year
4. NEVER use relative words — if "tomorrow" → use ${dateInfo.tomorrow}, if "today" → use ${dateInfo.today}

Re-extract NOW with the correct date format.`,
            });
            const delay = 1000 * Math.pow(2, attempt - 1) + Math.random() * 500;
            console.log(
              `⏳ [MANPOWER RETRY ${attempt}/${maxRetries}] Waiting ${Math.round(delay)}ms before retry attempt ${attempt + 1}...`,
            );
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
          continue;
        }

        // ── EXTRACTION CROSS-CHECKS ──
        // Two independent signals catch LLM transcription errors:
        //   (a) Internal inconsistency: LLM's totalWorkers ≠ its own breakdown sum.
        //   (b) Body-vs-LLM mismatch:   LLM's totalWorkers ≠ body's "Total manpower" line.
        //
        // Empirical: stress-testing against a real-prod failure body
        // (scripts/test-manpower-extraction-consistency.js) shows the LLM
        // returns *internally consistent but wrong* values (total=6 with
        // breakdown summing to 6, while the body says 9) ~80% of runs. Check
        // (a) alone misses these. Check (b) catches them deterministically.
        //
        // After all retries, return whatever we got — the handler-side audit
        // is the final gate.
        const c0 = args.companies[0];
        const breakdownKeys = Object.keys(c0?.workerBreakdown || {});
        const breakdownSum =
          breakdownKeys.length > 0 ? Object.values(c0.workerBreakdown).reduce((a, b) => a + b, 0) : 0;
        const totalWorkers = Number(c0?.totalWorkers) || 0;
        // Parse body's stated total. Two tiers:
        //   (1) "Total Manpower : NN" / "Total manpower -09" — explicit keyword
        //   (2) "Total : NN person/men/worker/crew/pax" — line-anchored, suffix-disambiguated
        // Tier 2 catches reports like LT Sambo's "Total :  24  person" that don't
        // include the "manpower" word. The suffix list prevents false positives
        // on unrelated totals like "Total weight: 50 kg".
        const bodyTier1 = messageContent
          ? messageContent.match(/total\s*(?:manpower|man\s*power|mp)\s*[:\-=]?\s*0*(\d+)/i)
          : null;
        const bodyTier2 =
          !bodyTier1 && messageContent
            ? messageContent.match(/^\s*total\s*[:\-=]\s*0*(\d+)\s*(?:persons?|man|men|workers?|crew|staff|pax)\b/im)
            : null;
        const bodyStatedTotal = bodyTier1 ? Number(bodyTier1[1]) : bodyTier2 ? Number(bodyTier2[1]) : null;

        const internalMismatch = breakdownKeys.length > 0 && totalWorkers > 0 && breakdownSum !== totalWorkers;
        const bodyMismatch = bodyStatedTotal != null && totalWorkers > 0 && bodyStatedTotal !== totalWorkers;

        if (internalMismatch || bodyMismatch) {
          const mismatchKind = bodyMismatch
            ? `body says ${bodyStatedTotal}, LLM returned totalWorkers=${totalWorkers}`
            : `internal: totalWorkers=${totalWorkers} ≠ breakdownSum=${breakdownSum}`;
          console.warn(`Extraction mismatch (attempt ${attempt}): ${mismatchKind}`);
          lastError = `extraction mismatch — ${mismatchKind}`;

          if (attempt < maxRetries) {
            const correctiveContent = bodyMismatch
              ? `ERROR: Your extracted totalWorkers does not match the body's stated total.

Body says: "Total manpower" line shows the number ${bodyStatedTotal}.
You returned: totalWorkers=${totalWorkers}, breakdown sum=${breakdownSum}.

⚠️ ABSOLUTE RULES — DO NOT VIOLATE ⚠️
- DO NOT change/invent numbers to make the math work.
- DO NOT alter values to fit each other.
- DO NOT fabricate or "adjust" any value.
- DO NOT skip role lines.

YOUR ONLY JOB: RE-READ the message body line by line and extract EXACTLY what is written there.

The body's "Total manpower" line clearly says ${bodyStatedTotal}. Your totalWorkers MUST equal ${bodyStatedTotal} unless the body line genuinely shows a different number.

Re-read each role line carefully. Some have no space before the dash (e.g., "11) Workers- 04"):
- The leading "N)" is the list-item number, NOT a count.
- The number AFTER the dash/colon is the actual count.
- "11) Workers- 04" → role="Workers", count=4 (not 1, not 11).
- "Role - NN" / "Role -NN" / "Role- NN" / "Role-NN" / "Role :- NN" / "Role:NN" → count=NN.

Re-read the body now and report what is ACTUALLY written there for each role and the total. The breakdown sum should equal ${bodyStatedTotal} when you correctly extract all on-site role counts.`
              : `ERROR: Your previous extraction was internally inconsistent.

Your output: totalWorkers=${totalWorkers}, breakdown sum=${breakdownSum}.
These don't match — meaning at least ONE of them was misread from the message body.

⚠️ ABSOLUTE RULES — DO NOT VIOLATE ⚠️
- DO NOT change/invent numbers to make the math work.
- DO NOT alter the breakdown values to fit the stated total.
- DO NOT alter the stated total to fit the breakdown sum.
- DO NOT fabricate or "adjust" any value.

YOUR ONLY JOB: RE-READ the message body line by line and extract EXACTLY what is written there. If the sender's body itself is internally inconsistent (sender's own arithmetic error), report both the breakdown counts and the stated total VERBATIM as written — do NOT reconcile them.

Read each role line carefully. Some lines have no space before the dash (e.g., "11) Workers- 04"):
- The leading "N)" is the list-item number, NOT a count.
- The number AFTER the dash/colon is the actual count.
- "11) Workers- 04" → role="Workers", count=4 (not 1, not 11).
- "Role - NN" / "Role -NN" / "Role- NN" / "Role-NN" / "Role :- NN" / "Role:NN" → count=NN.

For the stated total, find the line with "Total manpower" (or similar) and extract the number exactly as written. If it says "Total manpower -09" → totalWorkers=9. If it says "Total Manpower : 07" → totalWorkers=7.

Re-read the body now and report what is ACTUALLY written there — even if breakdown sum and total disagree.`;

            input.push({ role: "assistant", content: response.output_text });
            input.push({ role: "user", content: correctiveContent });
            const delay = 1000 * Math.pow(2, attempt - 1) + Math.random() * 500;
            console.log(
              `⏳ [MANPOWER RETRY ${attempt}/${maxRetries}] Waiting ${Math.round(delay)}ms before retry (${mismatchKind})...`,
            );
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }
          // Out of retries — accept the (still-mismatched) extraction. The
          // handler-side audit will reject it and reply to the user.
          console.warn(
            `Breakdown-sum mismatch persists after ${maxRetries} attempts. Returning last extraction; handler audit will reject.`,
          );
        }

        // ── MACHINERY PER-ITEM BODY CROSS-CHECK ──
        // The body has no "Total machinery" line to anchor against, so we
        // verify each machinery item individually: for every key the LLM
        // returned in machineBreakdown, look up that machine name in the body
        // and compare counts. Catches the "Steel plate :173 pcs." → LLM=1 case.
        const machineBreakdown = c0?.machineBreakdown || {};
        const machineMismatches = [];
        for (const [machineName, llmCount] of Object.entries(machineBreakdown)) {
          const escaped = String(machineName).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const pat = new RegExp(`${escaped}\\s*[:\\-=]+\\s*0*(\\d+)`, "i");
          const m = messageContent ? messageContent.match(pat) : null;
          const bodyCount = m ? Number(m[1]) : null;
          if (bodyCount != null && Number(llmCount) !== bodyCount) {
            machineMismatches.push({ machineName, bodyCount, llmCount: Number(llmCount) });
          }
        }

        if (machineMismatches.length > 0) {
          const summary = machineMismatches
            .map((mm) => `"${mm.machineName}": body=${mm.bodyCount} vs LLM=${mm.llmCount}`)
            .join(", ");
          console.warn(`Machinery body mismatch (attempt ${attempt}): ${summary}`);
          lastError = `machinery body mismatch — ${summary}`;

          if (attempt < maxRetries) {
            const mismatchList = machineMismatches
              .map((mm) => `  - "${mm.machineName}": body says ${mm.bodyCount}, you returned ${mm.llmCount}`)
              .join("\n");
            input.push({ role: "assistant", content: response.output_text });
            input.push({
              role: "user",
              content: `ERROR: Your machinery extraction disagrees with the body for ${machineMismatches.length} item(s):

${mismatchList}

⚠️ ABSOLUTE RULES — DO NOT VIOLATE ⚠️
- DO NOT change/invent numbers to make the math work.
- DO NOT alter the manpower values to compensate.
- DO NOT fabricate or "adjust" any value.

YOUR ONLY JOB: RE-READ each machinery line in the body and extract EXACTLY what is written there.

Common machinery formats to watch for:
- "★Steel plate :173 pcs." → count=173 (the "pcs." / "pieces" / "nos." suffix is NOT part of the count).
- "★Tower light-5" → count=5.
- "★Power pack vibro- 01" → count=1.
- "★Service Crane :3" → count=3.
- The leading bullet "★" / "🔹" / "▪️" is decoration, not a count.
- The count is the number that immediately follows the colon or dash.

Re-read each machinery line and extract the actual number — even for 3-digit counts like 173.`,
            });
            const delay = 1000 * Math.pow(2, attempt - 1) + Math.random() * 500;
            console.log(
              `⏳ [MANPOWER RETRY ${attempt}/${maxRetries}] Waiting ${Math.round(delay)}ms before retry (machinery mismatch: ${summary})...`,
            );
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }
          console.warn(
            `Machinery body mismatch persists after ${maxRetries} attempts. Returning last extraction; handler-side check is the final gate.`,
          );
        }

        // All validations passed (or retries exhausted) — accept extraction
        validExtraction = { args, functionCalls };
      }

      // If we have a valid extraction, break out of retry loop
      if (validExtraction) {
        break;
      }

      // Add delay before next retry (except on last attempt)
      if (attempt < maxRetries) {
        // Exponential backoff with jitter (same as OpenAI retry)
        const delay = 1000 * Math.pow(2, attempt - 1) + Math.random() * 500;
        console.log(
          `⏳ [MANPOWER RETRY ${attempt}/${maxRetries}] Waiting ${Math.round(delay)}ms before retry attempt ${
            attempt + 1
          }...`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    } catch (error) {
      console.error(`Error in createManpowerData (attempt ${attempt}):`, error);
      lastError = error.message;

      // Add delay before next retry (except on last attempt)
      if (attempt < maxRetries) {
        // Exponential backoff with jitter (same as OpenAI retry)
        const delay = 1000 * Math.pow(2, attempt - 1) + Math.random() * 500;
        console.log(
          `⏳ [MANPOWER RETRY ${attempt}/${maxRetries}] Waiting ${Math.round(delay)}ms before retry attempt ${
            attempt + 1
          } (after error)...`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  // Return the validated extraction or null
  if (validExtraction) {
    return validExtraction;
  }

  console.warn(`Failed to extract valid manpower data after ${maxRetries} attempts. Last error: ${lastError}`);
  return null;
}

module.exports = {
  extractManpowerFromMessage,
  metadata,
};
