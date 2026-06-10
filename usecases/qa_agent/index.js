/**
 * QA Agent — entry point.
 *
 * Thin wrapper over the v2 pipeline plus side-effect bypass handlers.
 * The v2 pipeline (parser → planner → data plugins → aggregator → formatter)
 * owns every analytical question; this file only routes side-effect domains
 * (report_generation) to their bypass handlers and wires the lambda webhook.
 *
 *   handleQuestion(text, groupConfig, chatId)
 *     → v2.handleQuestion (Layer 1-5)
 *     → bypass/report_generation when v2 returns { bypass: 'report_generation' }
 *     → fallback unsupported message otherwise
 *
 * Kept bypasses: report_generation, novade_sync, safety-image, safety_summary
 */

const { handleQuestion: v2Handle } = require("../qa_agent_v2");
const { handleReportGeneration } = require("./bypass/report_generation");
const { handleSafetyImage } = require("./bypass/safety-image");
const { handleNovadeSync } = require("./bypass/novade_sync");
const { maybeRenderSafetyListImage } = require("./safety_list_image");
const {
  sendWhatsAppReply,
  sendWhatsAppMessage,
  sendWhatsAppImage,
  sendTypingIndicator,
} = require("../../utils/sendMessage");
const { getGroupConfiguration } = require("../../config/group-config");
const { splitForWhatsApp } = require("../../utils/message-splitter");
const {
  createProcessingRun,
  markProcessingFailure,
  markProcessingSkipped,
  markProcessingSuccess,
} = require("../../utils/message-processing-log");
const { createLogCollector, formatLogEntries } = require("../../utils/log-collector");

/**
 * Handle a question through the QA agent pipeline (internal, no WhatsApp I/O).
 * @param {string} text - The cleaned question text
 * @param {object} groupConfig - Group configuration for spreadsheet routing
 * @param {string} [chatId] - WhatsApp chat ID (needed for report generation)
 * @returns {Promise<{ message: string } | null>}
 */
async function handleQuestion(text, groupConfig, chatId) {
  if (!text || !text.trim()) {
    console.log("⚠️ [QA Agent] Empty question, skipping");
    return null;
  }

  console.log(`🤖 [QA Agent] Processing question: "${text.substring(0, 100)}..."`);

  let v2Result;
  try {
    v2Result = await v2Handle(text, groupConfig);
  } catch (e) {
    console.error(`[QA Agent] v2 error:`, e?.stack || e);
    return { message: "Sorry, an error occurred while answering your question. Please try again." };
  }

  // Analytical answer — v2 produced a message.
  if (v2Result && v2Result.applies && v2Result.message) {
    console.log(`✅ [QA Agent] ${v2Result.answer?.kind} · ${v2Result.answer?.meta?.domain} · ${v2Result.ms}ms`);

    // For safety LIST answers that would wall into multiple WhatsApp messages
    // (e.g. "show me first 100 issues this month" → 7 "continued X/7" texts),
    // render the same rows as a safety-sheet screenshot instead. Falls back to
    // text automatically if the image flow throws or renders nothing.
    const safetyImage = await maybeRenderSafetyListImage(v2Result, groupConfig);
    if (safetyImage?.imageUrls?.length) {
      console.log(`✅ [QA Agent] safety list → image (${safetyImage.imageUrls.length} page(s))`);
      return {
        message: safetyImage.message,
        imageUrls: safetyImage.imageUrls,
        imageCaptions: safetyImage.imageCaptions,
      };
    }

    return { message: v2Result.message };
  }

  // Bypass: report generation.
  if (v2Result && v2Result.bypass === "report_generation") {
    try {
      // Pass intent so safety_summary can use the parser's time_window
      // (supports ranges — "this week", "last month", "from X to Y").
      return await handleReportGeneration(text, chatId, groupConfig, v2Result.intent);
    } catch (error) {
      console.error(`[QA Agent] Report generation failed:`, error);
      return { message: "Sorry, I encountered an error while generating the report. Please try again." };
    }
  }

  // Bypass: safety image — screenshot of Safety sheet filtered by date +
  // status / severity / category / location. Same multi-image return shape.
  if (v2Result && v2Result.bypass === "safety_image") {
    return handleSafetyImage(v2Result.intent, chatId, groupConfig);
  }

  // Bypass: novade sync — on-demand sync of safety issues to Novade
  // (action='sync'), or sheet-side sync status (action='status_sheet'),
  // or Novade-side action status drift check (action='status_novade').
  // Returns { message } or { message, imageUrls, imageCaptions } (sync only).
  if (v2Result && v2Result.bypass === "novade_sync") {
    return handleNovadeSync(v2Result.intent, chatId, groupConfig);
  }

  // Unsupported — v2 couldn't classify. Tell the user what domains we cover.
  const supportedSummary = [
    "manpower (worker counts, Wohhup TS/NTS, workers register)",
    "safety (issues, severity, status)",
    "WBGT (heat-stress readings)",
    "noise (Leq dBA at NM1/NM2)",
    "daily/weekly report generation",
  ]
    .map((d) => `- ${d}`)
    .join("\n");

  return {
    message: `I can currently answer questions about:\n${supportedSummary}\n\nYour question doesn't seem to match any of these. Please try rephrasing.`,
  };
}

/**
 * Lambda-compatible handler for mention-based QA messages.
 * Strips the mention ID, forwards the question to the QA agent, and sends
 * the answer back to WhatsApp.
 *
 * @param {object} message - Incoming WhatsApp message payload
 * @param {object} [corsHeaders={}] - Optional CORS headers for lambda
 * @returns {object} HTTP-style response containing the agent answer
 */
async function handler(message, corsHeaders = {}) {
  const runContext = await createProcessingRun({
    messageId: message?.messageId,
    listenerRowId: message?.id,
    chatId: message?.chatId || message?.from,
    usecaseKey: "qa_agent",
    handlerKey: "qa_agent.handler",
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
    if (formattedLogs) payload.processingLogs = formattedLogs;
    return payload;
  };

  try {
    const mentionId = process.env.MENTION_BOT_ID || "@154885513306361";
    const rawBody = String(message.body || "");
    const text = rawBody.replace(mentionId, "").trim();
    const chatId = message.chatId || message.from || "";

    if (!text) {
      await markProcessingSkipped({
        runId: runContext?.runId,
        startedAtMs,
        handlerInput: { text },
        remarks: "Empty question after removing mention",
        handlerOutput: attachLogsToOutput(null),
      });
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
        body: JSON.stringify({ skipped: true, reason: "empty-question" }),
      };
    }

    sendTypingIndicator(chatId);

    const groupConfig = getGroupConfiguration(chatId);
    const result = await handleQuestion(text, groupConfig, chatId);

    console.log(`Answer to be sent: `, result?.message);

    if (chatId && Array.isArray(result?.imageUrls) && result.imageUrls.length > 0) {
      // Multi-image response (safety_image bypass). Send each image
      // with its own caption — captions come from result.imageCaptions when
      // present (per-page numbered), else fall back to result.message.
      const captions =
        Array.isArray(result.imageCaptions) && result.imageCaptions.length === result.imageUrls.length
          ? result.imageCaptions
          : result.imageUrls.map(() => result.message || "");
      console.log(`[QA] Sending ${result.imageUrls.length} images`);
      let sentOne = false;
      for (let i = 0; i < result.imageUrls.length; i++) {
        try {
          await sendWhatsAppImage(chatId, result.imageUrls[i], captions[i] || "");
          sentOne = true;
          if (i < result.imageUrls.length - 1) await new Promise((r) => setTimeout(r, 800));
        } catch (e) {
          console.error(`[QA] sendWhatsAppImage page ${i + 1} failed:`, e?.message || e);
        }
      }
      // If nothing got through and we have a fallback text message, send it.
      if (!sentOne && result.message) {
        try {
          await sendWhatsAppMessage(chatId, result.message, undefined, 15000);
        } catch (e) {
          console.error(`[QA] fallback text send also failed:`, e?.message || e);
        }
      }
    } else if (chatId && result?.imageUrl) {
      // Single-image response. Send the PNG with the short text caption.
      console.log(`[QA] Sending image (caption ${result.message?.length || 0} chars)`);
      try {
        await sendWhatsAppImage(chatId, result.imageUrl, result.message || "");
      } catch (e) {
        console.error(`[QA] sendWhatsAppImage failed, falling back to text:`, e?.message || e);
        if (result.message) await sendWhatsAppMessage(chatId, result.message, undefined, 15000);
      }
    } else if (chatId && result?.message) {
      const quotedMessageId = message?.messageIdSerialized || null;
      if (quotedMessageId) console.log(`[QA] Sending reply as quoted message to: ${quotedMessageId}`);
      // Split long answers (>3800 chars) into sequential WhatsApp messages at
      // natural boundaries. The user never sees a truncated answer — the full
      // message arrives, split into multiple parts if needed.
      const parts = splitForWhatsApp(result.message);
      console.log(
        `[QA] Sending ${parts.length} message part${parts.length === 1 ? "" : "s"} (total ${result.message.length} chars)`,
      );
      for (let i = 0; i < parts.length; i++) {
        // First part: quote the user's question via /reply-message so the thread
        //   is anchored. Continuation parts: use /send-message (no quote needed
        //   — and /reply-message rejects missing quotedMessageId).
        if (i === 0 && quotedMessageId) {
          await sendWhatsAppReply(chatId, parts[i], undefined, 15000, quotedMessageId);
        } else {
          await sendWhatsAppMessage(chatId, parts[i], undefined, 15000);
        }
      }
    }

    if (!result || !result.message) {
      await markProcessingSkipped({
        runId: runContext?.runId,
        startedAtMs,
        handlerInput: { text },
        handlerOutput: attachLogsToOutput(result),
        remarks: "QA agent returned no message",
      });
    } else {
      await markProcessingSuccess({
        runId: runContext?.runId,
        startedAtMs,
        handlerInput: { text },
        handlerOutput: attachLogsToOutput(result),
      });
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    };
  } catch (error) {
    console.error("[QA] Handler failed", error);
    await markProcessingFailure({
      runId: runContext?.runId,
      startedAtMs,
      error,
      handlerOutput: attachLogsToOutput(null),
    });
    throw error;
  } finally {
    logCollector.stop();
  }
}

module.exports = {
  handler,
  handleQuestion,
};
