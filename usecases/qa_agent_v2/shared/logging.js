/**
 * Per-stage structured logging for the v2 pipeline.
 * Thin wrappers over console.* with a stage tag so logs grep cleanly.
 */

function stageLog(stage, msg, payload) {
  const head = `[v2 ${stage}]`;
  if (payload !== undefined) console.log(head, msg, typeof payload === "string" ? payload : JSON.stringify(payload));
  else console.log(head, msg);
}

function stageWarn(stage, msg, payload) {
  const head = `[v2 ${stage}]`;
  if (payload !== undefined) console.warn(head, msg, payload);
  else console.warn(head, msg);
}

function stageError(stage, msg, err) {
  const head = `[v2 ${stage}]`;
  if (err) console.error(head, msg, err?.message || err, err?.stack ? "\n" + err.stack : "");
  else console.error(head, msg);
}

module.exports = { stageLog, stageWarn, stageError };
