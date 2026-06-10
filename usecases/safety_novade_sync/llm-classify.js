// Novade enrichment via LLM batch classification.
//
// Input: a list of safety-issue rows from the sheet (description, location,
// category, severity, status). Output: a map keyed by rowNumber, each value:
//   { level, residualLocation, issueType, subtype, roottype, rootcause }
//
// `level` is constrained to one of the project's 13 quality units (e.g.,
// "Basement 01", "L05"). `issueType` is constrained to one of Novade's 18
// safety issue types (from /safety/issuetypes). The rest are constrained by
// the SUBTYPE_OPTIONS / ROOTTYPE_OPTIONS small enums below.
//
// One responses.create call per backfill batch. Falls back to an empty Map
// on any LLM error so the caller can use defaults and the sync still ships.

const { getOpenAI } = require("../../utils/openai");

const SUBTYPE_OPTIONS = ["Unsafe Condition", "Unsafe Act", "Near Miss", "Good Practice"];
const ROOTTYPE_OPTIONS = ["Unsafe Conditions", "Unsafe Acts", "Management Failure", "Environmental"];

function buildSystemPrompt({ unitNames, issueTypeNames }) {
  return `You classify construction safety issues into Novade's taxonomy. For each input issue, return EVERY field below with no nulls.

# Output fields

- **level**: pick from this exact list of project levels: ${JSON.stringify(unitNames)}.
  Parsing rules:
    - "Basement 01 - Zone 2, vehicle access" → "Basement 01"
    - "B1 entrance" / "B01" → "Basement 01"
    - "B2M ramp" → "Basement 02M"
    - "Level 5 pump room" / "L5" / "L05" → "L05"
    - If location is silent on level, infer from description; if still ambiguous, prefer the deepest basement (Basement 01) for ground/access work and the level mentioned by zone numbers if any.

- **residualLocation**: the location string with the level prefix removed.
  Examples:
    - input location "Basement 01 - Zone 2, vehicle access area" → residualLocation "Zone 2, vehicle access area"
    - input location "L05 pump room" → residualLocation "pump room"
    - input location "near the entrance" with no level prefix → residualLocation "near the entrance"
  Trim leading separators (-, –, —, :, ,, whitespace).

- **issueType**: pick the closest matching Novade issue type from: ${JSON.stringify(issueTypeNames)}.
  Use "Others. Please explain in description." ONLY when no listed type fits.

  **STRICT MAPPING TABLE — apply by SHEET CATEGORY first, then refine by DESCRIPTION ONLY when a stronger signal exists:**

    1. Sheet category = "Equipment" → ALWAYS "Plant & Equipment". Exception: ONLY override to "Lifting & Rigging" if the description explicitly contains one of these lifting-gear terms: "chain sling", "wire rope", "lifting hook", "rigging", "crane operator/operation", "banksman", "lifting permit", "tower crane", "crawler crane", "mobile crane".
    2. Sheet category = "Lifting & Rigging" / "Cranes/ heavy equipment" → ALWAYS "Lifting & Rigging".
    3. Sheet category = "Vehicular hazard" → ALWAYS "Traffic Safety".
    4. Sheet category = "Excavation/Trenching/Confined Spaces" → ALWAYS "Excavation".
    5. Sheet category = "Working at Height/Falling hazard" / "Overhead/Falling object hazard" → ALWAYS "Work at Height" for height-of-worker hazards; "Work Area" for falling-object/protrusion hazards on the ground.
    6. Sheet category = "Personal protective equipment" / "PPE" → ALWAYS "Hand Tools" (no native PPE type exists in Novade — Hand Tools is the closest by Novade convention). Never pick "Plant & Equipment" for PPE-tagged rows.
    7. Sheet category = "Electrical hazard" → ALWAYS "Electrical".
    8. Sheet category = "Health hazard" → ALWAYS "Environmental".
    9. Sheet category = "Hot Work" / hot work permits → ALWAYS "Hot Work".
    10. Sheet category = "Fire/Explosion Hazard" → ALWAYS "Fire Safety".
    11. Sheet category = "Chemical Safety" / "chemical storage" → ALWAYS "Chemical Safety".
    12. Sheet category = "Trips/slips/Protruding hazards" → ALWAYS "Work Area". Even if the description mentions vehicles or access, the issue is the GROUND CONDITION (mud, uneven plates, protrusions). Pick "Traffic Safety" ONLY if the description is specifically about traffic flow / signaling / banksman / vehicle collision (not about the road surface).
    13. Sheet category = "Access" / "Access and Egress" → ALWAYS "Access and Egress".
    14. Sheet category = "Scaffolds/ supports" → ALWAYS "Scaffold & Formwork".
    15. Sheet category = "Security /facilities" → ALWAYS "Welfare/ Facilities". Even if the description mentions a generator, plant room, store, or door lock, the security/access concern maps to facilities, not Plant & Equipment.
    16. Sheet category = "Public safety" → context-dependent: silty/muddy water discharge / dust / environmental pollution → "Environmental"; pedestrian crossing / signage / banksman / vehicle public-road interaction → "Traffic Safety"; hoarding / public-side barricade → "Work Area".
    17. Sheet category = "Other hazards" → strict description-based rules (apply in order):
        a. Description mentions "lighting" / "lights" / "lit" / "lamp" / "illumination" / "tower light" / "halogen" → ALWAYS "Plant & Equipment", regardless of location words like "capping beam area" or "work area" appearing alongside.
        b. Description mentions "generator" / "compressor" / "machinery" / "equipment defect" → "Plant & Equipment".
        c. Description mentions "ventilation" / "dust" / "fumes" / "noise level" → "Environmental".
        d. Description mentions "canvas" / "loose tied" / "housekeeping" / "untidy" / "general site condition" / ground hazards → "Work Area".
        e. Otherwise default → "Work Area".
    18. Sheet category = "Good Observation" → no hazard; pick the issueType that best describes the GOOD PRACTICE being observed (e.g., barricade installed → "Work Area"; water parade → "Welfare/ Facilities"; PPE inspection → "Hand Tools"; signage installation → "Traffic Safety"). Never default to "Plant & Equipment" unless the observation is specifically about equipment.

  **DETERMINISTIC TIE-BREAKING:** When two types could plausibly fit, ALWAYS pick the one in the table above for that sheet category — do NOT use the description to override the table unless the description matches an explicit exception listed in the rule.

  **NEVER pick "Others. Please explain in description."** unless absolutely none of the 17 specific types fit.

  Match the safety DOMAIN, not the exact wording of the example phrase shown next to each type in the issueType list.

- **subtype**: one of ${JSON.stringify(SUBTYPE_OPTIONS)}.
  Rules:
    - status="n/a" or category mentions "FYI" / "Good Observation" → "Good Practice"
    - description explicitly mentions someone almost being hurt / nearly hit / could have caused injury → "Near Miss"
    - description focuses on a person's behavior (failure to wear PPE, smoking, ignoring rules) → "Unsafe Act"
    - otherwise (physical condition: missing barrier, exposed cable, mud, water, broken plate, missing sign) → "Unsafe Condition"

- **roottype**: one of ${JSON.stringify(ROOTTYPE_OPTIONS)}.
  Pair with subtype:
    - "Unsafe Condition" → "Unsafe Conditions"
    - "Unsafe Act" → "Unsafe Acts"
    - "Near Miss" / "Good Practice" → choose by description (most physical-hazard near-misses → "Unsafe Conditions"; behavior-driven → "Unsafe Acts"; weather/site-wide → "Environmental"; missing PTW or plan → "Management Failure")

- **rootcause**: a SHORT (≤6 words) noun-phrase root cause derived from the description.
  Pick from this preferred set when one fits, but you may write a different short phrase if none fits:
    "Absence of Safety Means", "Inadequate Training", "Failure to Follow Procedures",
    "Equipment Defect", "Poor Housekeeping", "Improper PPE Usage", "Lack of Supervision",
    "Inadequate Planning", "Environmental Conditions", "Communication Breakdown".

# Reasoning rules
- Never return free-form text outside the JSON.
- Never include the level name inside residualLocation.
- Never invent a level or issueType outside the provided lists.
- Be deterministic — identical inputs should produce identical outputs.`;
}

/**
 * Classify a batch of safety issues for Novade enrichment.
 *
 * @param {Array} issues   Each item: { rowNumber, description, location, category, severity, status }
 * @param {Array} units    [{ id, name }, ...] for the project
 * @param {Array} issueTypes [{ type, description }, ...] from /safety/issuetypes
 * @returns {Promise<Map<number, {level, residualLocation, issueType, subtype, roottype, rootcause}>>}
 */
async function classifyIssuesForNovade(issues, units, issueTypes) {
  const out = new Map();
  if (!issues?.length) return out;

  const unitNames = (units || []).map((u) => u?.name).filter(Boolean);
  const issueTypeNames = (issueTypes || []).map((t) => t?.type || t?.name).filter(Boolean);

  if (!unitNames.length || !issueTypeNames.length) {
    console.warn("[novade-classify] missing units or issueTypes; skipping LLM call.");
    return out;
  }

  const input = issues.map((i) => ({
    rowNumber: i.rowNumber,
    description: i.description || "",
    location: i.location || "",
    category: i.category || "",
    severity: i.severity || "",
    status: i.status || "open",
  }));

  const systemPrompt = buildSystemPrompt({ unitNames, issueTypeNames });

  let response;
  try {
    response = await getOpenAI().responses.create({
      model: "gpt-4.1",
      temperature: 0,
      input: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Classify these ${input.length} safety issue(s):\n${JSON.stringify(input, null, 2)}`,
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "novade_safety_classification",
          strict: true,
          schema: {
            type: "object",
            properties: {
              results: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    rowNumber: { type: "integer" },
                    level: { type: "string", enum: unitNames },
                    residualLocation: { type: "string" },
                    issueType: { type: "string", enum: issueTypeNames },
                    subtype: { type: "string", enum: SUBTYPE_OPTIONS },
                    roottype: { type: "string", enum: ROOTTYPE_OPTIONS },
                    rootcause: { type: "string" },
                  },
                  required: ["rowNumber", "level", "residualLocation", "issueType", "subtype", "roottype", "rootcause"],
                  additionalProperties: false,
                },
              },
            },
            required: ["results"],
            additionalProperties: false,
          },
        },
      },
      store: true,
      metadata: { project: "wohhup-mbs", type: "safety_novade_classification" },
    });
  } catch (err) {
    console.warn("[novade-classify] LLM call failed:", err?.message || err);
    return out;
  }

  let parsed;
  try {
    parsed = JSON.parse(response.output_text);
  } catch (err) {
    console.warn("[novade-classify] could not parse LLM JSON:", err?.message || err);
    return out;
  }

  for (const r of parsed?.results || []) {
    if (Number.isFinite(r?.rowNumber)) out.set(r.rowNumber, r);
  }
  return out;
}

module.exports = {
  classifyIssuesForNovade,
  SUBTYPE_OPTIONS,
  ROOTTYPE_OPTIONS,
};
