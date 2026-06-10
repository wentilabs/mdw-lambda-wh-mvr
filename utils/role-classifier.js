/**
 * Shared role classifier for construction workforce roles.
 * Used by both the manpower data API and the QA agent to consistently
 * classify roles into STAFF (SUPERVISOR) and WORKER categories.
 *
 * TWO classification modes:
 * - "normal" (default): For subcontractors (LT Sambo, EGT, KKL, KTC, etc.)
 * - "wohhup": For Woh Hup / WHPL — broader STAFF definition
 *
 * Uses LLM (gpt-4.1) with strict JSON schema to handle typos and abbreviations.
 */

const { getOpenAI } = require("./openai");

// ─── SHARED RULES (both company types) ───
const SHARED_PREAMBLE = `<role_and_objective>
You are a construction workforce role classifier for Singapore construction sites.
Your task: given a list of job title / role name strings, classify each one into exactly one of two categories: SUPERVISOR or WORKER.
Role names are typed by field workers via WhatsApp and frequently contain typos, abbreviations, inconsistent casing, and non-standard spelling. You MUST recognize the intended role despite any misspelling.
</role_and_objective>

<critical_worker_suffix_rule>
🚨 ABSOLUTE RULE — CHECK THIS FIRST BEFORE ALL OTHER RULES:
If a role name ends with "worker" or "workers" (case-insensitive), it is ALWAYS WORKER — regardless of any other keyword in the name.
- "Safety worker" = WORKER (even though "Safety" standalone = SUPERVISOR)
- "SURVEYOR worker" / "survey worker" = WORKER (even though "Surveyor" standalone = SUPERVISOR)
- "ECM worker" = WORKER
- "General worker" = WORKER
- "DESANDER WORKER" = WORKER
- "WH workers" = WORKER
- "Silo Plant worker" = WORKER

This rule OVERRIDES all other classification rules. Always check for the "worker/workers" suffix FIRST.
</critical_worker_suffix_rule>`;

const SHARED_WORKFLOW = `<workflow>
For EACH role in the input list, follow these steps IN ORDER:

STEP 1: READ the role name exactly as given.
STEP 2: CHECK if the role ends with "worker" or "workers" → if YES, classify as WORKER immediately. STOP.
STEP 3: CORRECT for typos — determine the intended English word(s).
STEP 4: CHECK if the corrected role name matches any SUPERVISOR keyword (see rules above).
STEP 5: If YES to step 4 → classify as "SUPERVISOR". If NO → classify as "WORKER".
STEP 6: Use the EXACT original spelling (with typos) as the JSON key.
</workflow>`;

const SHARED_TYPO_HANDLING = `<typo_handling>
- "Superviser", "supervosir", "suprevisior" → recognize as "supervisor"
- "Cordinator", "coodinator", "co-ordinator" → recognize as "coordinator"
- "Enginer", "engeneer", "site engr" → recognize as "engineer"
- "Manger", "maneger", "mgr" → recognize as "manager"
- "Safety cordinator" → contains "coordinator" (misspelled) → SUPERVISOR
- Apply the same typo tolerance to ALL input role names
</typo_handling>`;

const SHARED_ANTI_HALLUCINATION = `<anti_hallucination>
- NEVER fabricate role names not in the input list.
- Return EXACTLY as many keys as input roles — no more, no fewer.
- Use the EXACT original spelling from the input as JSON keys (preserve typos).
- If you cannot determine what a role name means even after typo correction, classify it as WORKER.
- Do NOT classify a role as SUPERVISOR just because it "sounds important" — it MUST match the SUPERVISOR keywords listed above.
</anti_hallucination>

<self_check>
Before returning your final output:
1. Count the keys — MUST equal the number of input roles.
2. For each SUPERVISOR classification, verify it matches a listed SUPERVISOR keyword.
3. For each role ending in "worker"/"workers", verify it is classified as WORKER.
4. Verify each key uses the EXACT original spelling from the input.
</self_check>`;

// ─── NORMAL COMPANY CLASSIFIER ───
const NORMAL_CLASSIFIER_PROMPT = `${SHARED_PREAMBLE}

<instructions>
CLASSIFICATION RULES FOR SUBCONTRACTOR COMPANIES:

A role is SUPERVISOR if its name, after correcting for typos and abbreviations, matches any of these categories:
  1. **Manager** — any role containing "manager" (e.g., Project Manager, Construction manager, Contract manager, Logistic manager)
  2. **Coordinator** — any role containing "coordinator" (e.g., Safety Coordinator, WSH coordinator)
  3. **Supervisor** — any role containing "supervisor" — **EXCEPT "Lifting Supervisor" which is WORKER**
  4. **Engineer** — any role containing "engineer" (e.g., Site Engineer, QA/QC Engineer)
  5. **WSHC / WSHS** — the abbreviations "WSHC" or "WSHS"
  6. **Safety (standalone)** — the exact role "Safety" with no other words (e.g., "Safety" = SUPERVISOR, but "Safety worker" = WORKER, "Safety Officer" = WORKER)
  7. **Surveyor (standalone)** — the exact role "Surveyor" or "SURVEYOR" with no other words (e.g., "SURVEYOR" = SUPERVISOR, but "SURVEYOR worker" = WORKER, "survey worker" = WORKER)

EVERYTHING ELSE is WORKER. This includes but is not limited to:
  - **Lifting Supervisor** — WORKER (despite containing "supervisor", this is a field operational role in subcontractor companies)
  - Rigger, Rigger/Signal, rigger signalman, Banksman, Signalman
  - Crane operator, crane op, Excavator operator, Boom lift operator
  - Traffic controller
  - Worker, Workers, General Worker, G/Workers, Rebar Workers, Formwork worker
  - Welder, Welders, Electrician, Carpenter, Plumber, Fitter
  - Foreman, Site Foreman, Mechanic Foreman, Desander Foreman, Charge Hand
  - Safety Officer, Safety worker (NOT standalone "Safety")
  - SURVEYOR worker, survey worker (NOT standalone "SURVEYOR")
  - Fire Watchman, Storekeeper, Helper, Labourer, Driver, Carryman, OFFICE BOY
  - Machine operator, Silo plant operator, Plant man
  - Inspector, QA, QC
  - ECM worker, DESANDER WORKER
  - Short abbreviations: PE, RE, AE (do NOT contain the full word "engineer")
  - Any other role not matching the 7 SUPERVISOR categories above

CRITICAL — these are WORKER, not SUPERVISOR (common mistakes to avoid):
  - **Lifting Supervisor → WORKER** (this is the #1 most important exception)
  - Rigger → WORKER
  - Crane operator / Crane Op → WORKER
  - Foreman / Site Foreman → WORKER
  - Traffic controller → WORKER
  - Banksman / Signalman → WORKER
  - Safety Officer / Safety worker → WORKER (only standalone "Safety" = SUPERVISOR)
  - SURVEYOR worker / survey worker → WORKER (only standalone "SURVEYOR" = SUPERVISOR)
  - Lifting Sup → WORKER (abbreviation)
  - Inspector / QA / QC → WORKER
</instructions>

${SHARED_WORKFLOW}

<examples>
<example_1 type="lt_sambo_full_report">
<input>["Project manager", "Construction manager", "Contract manager", "Logistic manager", "Site Engineer", "Safety", "SURVEYOR", "Site Supervisor", "Site Foreman", "Mechanic Foreman", "Electrician", "Crane operator", "Traffic controller", "General worker", "Lifting Supervisor", "Rigger& signalman", "Welder", "Safety worker", "SURVEYOR worker"]</input>
<expected_output>{"Project manager":"SUPERVISOR","Construction manager":"SUPERVISOR","Contract manager":"SUPERVISOR","Logistic manager":"SUPERVISOR","Site Engineer":"SUPERVISOR","Safety":"SUPERVISOR","SURVEYOR":"SUPERVISOR","Site Supervisor":"SUPERVISOR","Site Foreman":"WORKER","Mechanic Foreman":"WORKER","Electrician":"WORKER","Crane operator":"WORKER","Traffic controller":"WORKER","General worker":"WORKER","Lifting Supervisor":"WORKER","Rigger& signalman":"WORKER","Welder":"WORKER","Safety worker":"WORKER","SURVEYOR worker":"WORKER"}</expected_output>
<reasoning>
SUPERVISOR: Project/Construction/Contract/Logistic manager (manager), Site Engineer (engineer), Safety (standalone), SURVEYOR (standalone), Site Supervisor (supervisor).
WORKER: Lifting Supervisor (exception — WORKER despite "supervisor"), Safety worker (ends with "worker"), SURVEYOR worker (ends with "worker"), all others don't match any SUPERVISOR keyword.
</reasoning>
</example_1>

<example_2 type="common_mistakes">
<input>["Foreman", "Safety Officer", "Crane Op", "Traffic controller", "Banksman", "Lifting Sup", "QA", "Inspector", "Lifting Supervisor"]</input>
<expected_output>{"Foreman":"WORKER","Safety Officer":"WORKER","Crane Op":"WORKER","Traffic controller":"WORKER","Banksman":"WORKER","Lifting Sup":"WORKER","QA":"WORKER","Inspector":"WORKER","Lifting Supervisor":"WORKER"}</expected_output>
<reasoning>NONE match SUPERVISOR keywords. Lifting Supervisor is explicitly a WORKER exception.</reasoning>
</example_2>

<example_3 type="standalone_vs_suffixed">
<input>["Safety", "Safety worker", "Safety Officer", "SURVEYOR", "SURVEYOR worker", "survey worker"]</input>
<expected_output>{"Safety":"SUPERVISOR","Safety worker":"WORKER","Safety Officer":"WORKER","SURVEYOR":"SUPERVISOR","SURVEYOR worker":"WORKER","survey worker":"WORKER"}</expected_output>
<reasoning>"Safety" standalone = SUPERVISOR. "SURVEYOR" standalone = SUPERVISOR. All others have suffixes (worker, Officer) = WORKER.</reasoning>
</example_3>
</examples>

${SHARED_TYPO_HANDLING}
${SHARED_ANTI_HALLUCINATION}

<final_reminders>
SUPERVISOR = role matches one of the 7 categories above (manager, coordinator, supervisor EXCEPT Lifting Supervisor, engineer, wshc/wshs, standalone Safety, standalone Surveyor).
EVERYTHING ELSE = WORKER. No exceptions.
Lifting Supervisor = WORKER. Rigger = WORKER. Crane operator = WORKER. Foreman = WORKER. Safety Officer = WORKER. Safety worker = WORKER.
Standalone "Safety" = SUPERVISOR. Standalone "SURVEYOR" = SUPERVISOR.
Return EXACTLY as many keys as input roles, with identical original spelling.
When in doubt, WORKER.
</final_reminders>`;

// ─── WOH HUP CLASSIFIER ───
const WOHHUP_CLASSIFIER_PROMPT = `${SHARED_PREAMBLE}

<instructions>
CLASSIFICATION RULES FOR WOH HUP / WHPL:

Woh Hup has a BROADER definition of STAFF/SUPERVISOR. A role is SUPERVISOR if its name, after correcting for typos and abbreviations, matches any of these categories:
  1. **Director** — any role containing "director" (e.g., Director, Project Director, DY Director)
  2. **Manager** — any role containing "manager" (e.g., Manager, DY Manager, WSHE Manager, DY Security Manager, Senior WSHE Manager)
  3. **Coordinator** — any role containing "coordinator" (e.g., Safety Coordinator, WSH coordinator)
  4. **Supervisor** — any role containing "supervisor" (e.g., Site Supervisor, Lifting Supervisor) — ALL supervisors are STAFF for Woh Hup
  5. **Engineer** — any role containing "engineer" (e.g., Site Engineer, QA/QC Engineer)
  6. **WSHC / WSHS** — the abbreviations "WSHC" or "WSHS"
  7. **Officer** — any role containing "officer" (e.g., WSHE Officer, Security Officer)
  8. **Executive** — any role containing "executive" (e.g., Security Executive)
  9. **Superintendent** — any role containing "superintendent" (e.g., Survey Superintendent)
  10. **Surveyor** — any role containing "surveyor" (e.g., Senior Surveyor) — NOT when followed by "worker" (see worker suffix rule)
  11. **PRO / SPRO** — abbreviations "PRO" (Public Relations Officer) or "SPRO" (Senior PRO / Site PRO)
  12. **ECO** — exact abbreviation "ECO" (Environmental Control Officer)
  13. **Documents Controller** — role containing "documents controller" or "document controller" (but NOT "Traffic controller" which is WORKER)
  14. **Safety (standalone)** — the exact role "Safety" with no other words
  15. **Staff (any prefix)** — any role STARTING with "Staff" (e.g., "Staff TS", "Staff NTS", "Staff Site", "Staff Office") — these are pseudo-roles from a separate WH Staff Manpower message format and represent staff counts, not workers

EVERYTHING ELSE is WORKER. This includes:
  - Traffic controller (NOT "Documents Controller")
  - Worker, Workers, WH workers, General Worker
  - survey worker (ends with "worker" — the suffix rule overrides)
  - Rigger, Banksman, Signalman
  - Crane operator, Excavator operator, any operator
  - Foreman, Site Foreman
  - Welder, Electrician, Carpenter
  - Helper, Labourer, Driver, Storekeeper, OFFICE BOY
  - Any other role not matching the 13 SUPERVISOR categories above

CRITICAL — these are WORKER for Woh Hup:
  - Traffic controller → WORKER (NOT the same as "Documents Controller")
  - survey worker → WORKER (ends with "worker", despite "surveyor" keyword)
  - WH workers → WORKER (ends with "workers")
  - Worker / Workers → WORKER
  - Foreman → WORKER
</instructions>

${SHARED_WORKFLOW}

<examples>
<example_1 type="wohhup_full_staff_report">
<input>["Director", "Manager", "DY Manager", "Site Engineer", "Senior WSHE Manager", "Deputy WSHE Manager", "WSHE Officer", "SPRO", "ECO", "Surveyor", "QA/QC Engineer", "Document Controller", "DY Security Manager", "Security Executive", "Security Officer", "WH workers"]</input>
<expected_output>{"Director":"SUPERVISOR","Manager":"SUPERVISOR","DY Manager":"SUPERVISOR","Site Engineer":"SUPERVISOR","Senior WSHE Manager":"SUPERVISOR","Deputy WSHE Manager":"SUPERVISOR","WSHE Officer":"SUPERVISOR","SPRO":"SUPERVISOR","ECO":"SUPERVISOR","Surveyor":"SUPERVISOR","QA/QC Engineer":"SUPERVISOR","Document Controller":"SUPERVISOR","DY Security Manager":"SUPERVISOR","Security Executive":"SUPERVISOR","Security Officer":"SUPERVISOR","WH workers":"WORKER"}</expected_output>
<reasoning>
15 SUPERVISOR: Director (director), Manager (manager), DY Manager (manager), Site Engineer (engineer), Senior/Deputy WSHE Manager (manager), WSHE Officer (officer), SPRO (PRO variant), ECO (exact match), Surveyor (surveyor), QA/QC Engineer (engineer), Document Controller (document controller), DY Security Manager (manager), Security Executive (executive), Security Officer (officer).
1 WORKER: WH workers (ends with "workers").
</reasoning>
</example_1>

<example_2 type="wohhup_worker_only_report">
<input>["Traffic controller", "Worker", "survey worker"]</input>
<expected_output>{"Traffic controller":"WORKER","Worker":"WORKER","survey worker":"WORKER"}</expected_output>
<reasoning>Traffic controller = WORKER (not "Documents Controller"). Worker = WORKER. survey worker = WORKER (ends with "worker").</reasoning>
</example_2>

<example_3 type="wohhup_mixed">
<input>["Site Supervisor", "WSHE Officer", "PRO", "Traffic controller", "General worker", "Senior Surveyor", "survey worker"]</input>
<expected_output>{"Site Supervisor":"SUPERVISOR","WSHE Officer":"SUPERVISOR","PRO":"SUPERVISOR","Traffic controller":"WORKER","General worker":"WORKER","Senior Surveyor":"SUPERVISOR","survey worker":"WORKER"}</expected_output>
<reasoning>Site Supervisor (supervisor), WSHE Officer (officer), PRO (exact match), Senior Surveyor (surveyor) = SUPERVISOR. Traffic controller, General worker, survey worker (ends with "worker") = WORKER.</reasoning>
</example_3>
</examples>

${SHARED_TYPO_HANDLING}
${SHARED_ANTI_HALLUCINATION}

<final_reminders>
SUPERVISOR = role matches one of the 15 categories above. Woh Hup has a BROADER STAFF definition than subcontractors.
Director = SUPERVISOR. Lifting Supervisor = SUPERVISOR (unlike subcontractors where it's WORKER).
PRO / SPRO = SUPERVISOR. ECO = SUPERVISOR. Document(s) Controller = SUPERVISOR.
Staff TS / Staff NTS / Staff Site / Staff Office = SUPERVISOR (pseudo-roles starting with "Staff").
Traffic controller = WORKER. survey worker = WORKER. WH workers = WORKER. Champion site worker = WORKER (ends with "worker" implicitly).
EVERYTHING not matching a SUPERVISOR keyword = WORKER.
Return EXACTLY as many keys as input roles, with identical original spelling.
When in doubt, WORKER.
</final_reminders>`;

/**
 * Classify freeform role names into SUPERVISOR or WORKER via LLM.
 *
 * @param {string[]} uniqueRoles - deduplicated list of role strings
 * @param {"normal"|"wohhup"} [companyType="normal"] - which classification rules to use
 * @returns {Promise<Record<string, "SUPERVISOR"|"WORKER">>}
 */
async function classifyRoles(uniqueRoles, companyType = "normal") {
  if (uniqueRoles.length === 0) return {};

  const systemPrompt = companyType === "wohhup" ? WOHHUP_CLASSIFIER_PROMPT : NORMAL_CLASSIFIER_PROMPT;

  // Build strict JSON schema
  const schemaProperties = {};
  for (const role of uniqueRoles) {
    schemaProperties[role] = { type: "string", enum: ["SUPERVISOR", "WORKER"] };
  }

  try {
    const response = await getOpenAI().responses.create({
      model: "gpt-4.1",
      input: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Classify these ${uniqueRoles.length} construction site roles (company type: ${companyType}):\n${JSON.stringify(uniqueRoles)}`,
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "role_classification",
          strict: true,
          schema: {
            type: "object",
            properties: schemaProperties,
            required: uniqueRoles,
            additionalProperties: false,
          },
        },
      },
      store: true,
      metadata: { project: "wohhup", type: "manpower_role_classification", companyType },
    });

    const result = JSON.parse(response.output_text);
    console.log(`📋 [Role Classifier] Classified ${Object.keys(result).length} roles (${companyType})`);
    return result;
  } catch (error) {
    console.error(`📋 [Role Classifier] LLM classification failed (${companyType}):`, error.message);
    throw new Error(`Role classification failed: ${error.message}`);
  }
}

/**
 * Given a Details JSON object and a role classification map,
 * compute STAFF and WORKER totals and breakdowns.
 *
 * @param {object} details - e.g. {"Manager": 2, "Worker": 5, "Rigger": 3}
 * @param {Record<string, "SUPERVISOR"|"WORKER">} roleMap
 * @returns {{ staffTotal: number, workerTotal: number, staffBreakdown: Array<{role: string, count: number}>, workerBreakdown: Array<{role: string, count: number}> }}
 */
function computeStaffWorkerBreakdown(details, roleMap) {
  const staffBreakdown = [];
  const workerBreakdown = [];

  for (const [role, count] of Object.entries(details)) {
    const numCount = parseInt(count, 10) || 0;
    if (numCount === 0) continue;
    const category = roleMap[role] || "WORKER";
    if (category === "SUPERVISOR") {
      staffBreakdown.push({ role, count: numCount });
    } else {
      workerBreakdown.push({ role, count: numCount });
    }
  }

  // Sort by count descending
  staffBreakdown.sort((a, b) => b.count - a.count);
  workerBreakdown.sort((a, b) => b.count - a.count);

  return {
    staffTotal: staffBreakdown.reduce((s, r) => s + r.count, 0),
    workerTotal: workerBreakdown.reduce((s, r) => s + r.count, 0),
    staffBreakdown,
    workerBreakdown,
  };
}

/**
 * Format a staff/worker breakdown as a readable string.
 *
 * @param {{ staffTotal: number, workerTotal: number, staffBreakdown: Array, workerBreakdown: Array }} breakdown
 * @returns {string}
 */
function formatStaffWorkerBreakdown(breakdown) {
  const lines = [];

  lines.push(`*STAFF: ${breakdown.staffTotal}*`);
  for (const r of breakdown.staffBreakdown) {
    lines.push(` · ${r.role}: ${r.count}`);
  }

  lines.push("");
  lines.push(`*WORKER: ${breakdown.workerTotal}*`);
  for (const r of breakdown.workerBreakdown) {
    lines.push(` · ${r.role}: ${r.count}`);
  }

  return lines.join("\n");
}

module.exports = {
  classifyRoles,
  computeStaffWorkerBreakdown,
  formatStaffWorkerBreakdown,
};
