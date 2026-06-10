// Note: dotenv is loaded in index.js handler, secrets come from AWS Secrets Manager

const { processMessageAgent } = require("./openai");
const {
  createProcessingRun,
  markProcessingFailure,
  markProcessingSkipped,
  markProcessingSuccess,
} = require("../../utils/message-processing-log");
const { createLogCollector, formatLogEntries } = require("../../utils/log-collector");

// Group IDs are now managed in config/group-config.js

/**
 * Handle incoming messages for the health safety use case
 *
 * @param {string|object} message - The message to process
 * @param {object} corsHeaders - CORS headers for the response
 * @returns {object} - The processed result
 */
async function handler(message, corsHeaders) {
  const runContext = await createProcessingRun({
    messageId: message?.messageId,
    listenerRowId: message?.id,
    chatId: message?.chatId || message?.from,
    usecaseKey: "health_safety",
    handlerKey: "health_safety.handler",
    messagePayload: message,
  });

  const startedAtMs = runContext?.startedAtMs ?? Date.now();
  const logCollector = createLogCollector();
  logCollector.start();

  const attachLogsToOutput = (baseOutput) => {
    const formattedLogs = formatLogEntries(logCollector.getLogs());
    let payload;

    if (baseOutput && typeof baseOutput === "object" && !Array.isArray(baseOutput)) {
      payload = { ...baseOutput };
    } else if (baseOutput !== undefined) {
      payload = { data: baseOutput };
    } else {
      payload = {};
    }

    if (formattedLogs) {
      payload.processingLogs = formattedLogs;
    }

    return payload;
  };

  try {
    console.log("Processing message:", message);

    const result = await processMessageAgent(message);

    console.log("Processing result:", JSON.stringify(result, null, 2));

    // If result is null or undefined, return a default response
    if (!result) {
      await markProcessingSkipped({
        runId: runContext?.runId,
        startedAtMs,
        remarks: "No actionable result from processMessageAgent",
        handlerOutput: attachLogsToOutput(null),
      });

      return {
        statusCode: 200,
        headers: { ...corsHeaders },
        body: "", // or 'no action', or whatever you want as a default
      };
    }

    if (result.error) {
      console.error("Error processing message:", result.error);

      await markProcessingFailure({
        runId: runContext?.runId,
        startedAtMs,
        error: result.error,
        handlerOutput: attachLogsToOutput(result),
      });

      return {
        success: false,
        // error: result.error,
      };
    }

    await markProcessingSuccess({
      runId: runContext?.runId,
      startedAtMs,
      handlerOutput: attachLogsToOutput(result),
    });

    return {
      success: true,
      //   message: result.message,
    };
  } catch (error) {
    console.error("Error in handler:", error);

    await markProcessingFailure({
      runId: runContext?.runId,
      startedAtMs,
      error,
      handlerOutput: attachLogsToOutput(null),
    });

    return {
      success: false,
      //   error: error.message,
    };
  } finally {
    logCollector.stop();
  }
}

module.exports = {
  handler,
  // Group IDs are now exported from config/group-config.js
};
