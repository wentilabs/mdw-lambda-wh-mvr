/**
 * QA Agent v2 — entry point.
 *
 *   handleQuestion(question, groupConfig)
 *     → parseIntent (Layer 1)
 *     → planFromIntent (Layer 2)
 *     → runPlan (Layer 3 + Layer 4 — fetch + reduce)
 *     → renderAnswer (Layer 5)
 *     → { message, intent, plan, answer }
 *
 * The same question always produces byte-identical output because:
 *   • Layer 1 uses temperature=0 + strict json_schema.
 *   • Layers 2-5 are pure code.
 */

const { parseIntent } = require("./parser/parse-intent");
const { planFromIntent } = require("./planner/plan-from-intent");
const { runPlan } = require("./agg/run-plan");
const { renderAnswer } = require("./format/render");
const { isBypass } = require("./data");
const { stageLog, stageError } = require("./shared/logging");

async function handleQuestion(question, groupConfig) {
  const t0 = Date.now();
  let intent = null;
  let plan = null;
  let answer = null;

  try {
    intent = await parseIntent(question);
    plan = planFromIntent(intent);

    // Bypass: report_generation / document_log — legacy owns these.
    if (plan.answer_shape === "bypass" && isBypass(intent.domain)) {
      return {
        applies: false,
        bypass: intent.domain,
        intent,
        plan,
        message: "",
        ms: Date.now() - t0,
      };
    }
    // Unsupported: hand back to legacy rather than confidently rejecting.
    // Legacy's router has the canonical "what I can answer" template.
    if (
      intent.question_type === "unsupported" ||
      intent.domain === "unsupported" ||
      plan.answer_shape === "unsupported"
    ) {
      return {
        applies: false,
        reason: intent.unsupported_reason || plan.unsupported_reason || "out_of_scope",
        intent,
        plan,
        message: "",
        ms: Date.now() - t0,
      };
    }

    answer = await runPlan(plan, { groupConfig });
    const message = await renderAnswer(answer);
    stageLog("entry", `done in ${Date.now() - t0}ms`, {
      kind: answer?.kind,
      domain: answer?.meta?.domain,
      rows: answer?.meta?.row_count,
    });
    return {
      applies: true,
      message,
      intent,
      plan,
      answer,
      ms: Date.now() - t0,
    };
  } catch (e) {
    stageError("entry", "uncaught", e);
    return {
      applies: false,
      error: e?.message || String(e),
      intent,
      plan,
      answer,
      message: `Sorry, an error occurred while answering your question: ${e?.message || "unknown"}.`,
      ms: Date.now() - t0,
    };
  }
}

module.exports = { handleQuestion };
