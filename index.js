require("dotenv").config();

const { getSecrets } = require("./utils/secrets");
const { handler: HealthSafetyHandler } = require("./usecases/health_safety/index");
const { handler: QAAgentHandler } = require("./usecases/qa_agent/index");
const processDailySafetySummaryRequest = require("./api/daily-safety-summary");
const { processP1SafetyReminderRequest } = require("./api/p1-safety-reminder");
const processWbgtReadingRequest = require("./api/wbgt-reading");
const processNoiseReadingRequest = require("./api/noise-reading");
const processNoiseReading5minRequest = require("./api/noise-reading-5min");
const processDailyManpowerSummaryRequest = require("./api/daily-manpower-summary");
const processManpowerReminderRequest = require("./api/manpower-reminder");
const processDailyManpowerDataRequest = require("./api/daily-manpower-data");
const processWeeklyReportRequest = require("./api/weekly-report");
const processDailyReportRequest = require("./api/daily-report");
const processNovadeSafetySyncRequest = require("./api/novade-safety-sync");
const {
  handleNovadeSyncConfirmation,
  REF_MARKER_RE: NOVADE_REF_MARKER_RE,
} = require("./usecases/qa_agent/bypass/novade_sync");
const { getGroupConfiguration } = require("./config/group-config");
const { sendWhatsAppMessage: sendWaText } = require("./utils/sendMessage");
const { createProcessingRun, markProcessingSkipped } = require("./utils/message-processing-log");

// Import group IDs from centralized config
const { SAFETY_GROUP_IDS, QA_GROUP_IDS } = require("./config/group-config");

/**
 * Lambda function handler — base template for Wohhup safety/manpower/QA agent Lambdas.
 *
 * Routes:
 *   GET  /version
 *   POST /middleware                  — WhatsApp webhook (routes by chatId to safety / QA)
 *   POST /daily-safety-summary
 *   POST /p1-safety-reminder
 *   POST /wbgt-reading
 *   POST /daily-manpower-summary
 *   POST /daily-manpower-data
 *   POST /manpower-reminder
 *   POST /daily-report
 *   POST /weekly-report
 *
 * @param {Object} event - AWS Lambda event (API Gateway HTTP v2)
 * @returns {Object} - HTTP response
 */
exports.handler = async (event) => {
  // Load secrets from AWS Secrets Manager and inject into process.env
  const secrets = await getSecrets();
  Object.assign(process.env, secrets);

  // Start a global timer to monitor execution time
  const globalStartTime = Date.now();
  const requestMethod = event.requestContext.http.method;
  const requestPath = event.requestContext.http.path;
  const origin = event.headers.origin || event.headers.Origin || "*";

  const corsHeaders = {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": true,
    "Access-Control-Allow-Headers": "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token",
    "Access-Control-Allow-Methods": "OPTIONS,POST,GET",
  };

  if (requestMethod === "OPTIONS") {
    console.log("Main handler processing OPTIONS request with headers:", corsHeaders);
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: "OK",
    };
  }

  if (requestMethod === "GET" && requestPath === "/version") {
    const version = process.env.APP_VERSION || "1.0.0";
    return { statusCode: 200, body: version, headers: { ...corsHeaders } };
  }

  // Daily Safety Summary API
  if (requestMethod === "POST" && requestPath === "/daily-safety-summary") {
    console.log("Received a daily safety summary request");
    return processDailySafetySummaryRequest(event, {
      status: (code) => ({
        json: (body) => ({
          statusCode: code,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      }),
    });
  }

  // P1 Safety Reminder API
  if (requestMethod === "POST" && requestPath === "/p1-safety-reminder") {
    console.log("Received a P1 safety reminder request");
    return processP1SafetyReminderRequest(event, {
      status: (code) => ({
        json: (body) => ({
          statusCode: code,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      }),
    });
  }

  // WBGT Reading API - Fetches latest WBGT directly from Noiselynx and processes it
  if (requestMethod === "POST" && requestPath === "/wbgt-reading") {
    console.log("Received a WBGT reading request");
    return processWbgtReadingRequest(event, {
      status: (code) => ({
        json: (body) => ({
          statusCode: code,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      }),
    });
  }

  // Noise Reading API - Triggers IR2 scraper + processes noise data
  if (requestMethod === "POST" && requestPath === "/noise-reading") {
    console.log("Received a noise reading request");
    return processNoiseReadingRequest(event, {
      status: (code) => ({
        json: (body) => ({
          statusCode: code,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      }),
    });
  }

  // Noise 5-Minute Reading API - Checks latest Leq5min per location, alerts if exceeded
  if (requestMethod === "POST" && requestPath === "/noise-reading-5min") {
    console.log("Received a noise 5-minute reading request");
    return processNoiseReading5minRequest(event, {
      status: (code) => ({
        json: (body) => ({
          statusCode: code,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      }),
    });
  }

  // Novade Safety Sync API (nightly cron — auth via X-Cron-Auth header)
  if (requestMethod === "POST" && requestPath === "/novade-safety-sync") {
    console.log("Received a Novade safety sync request");
    return processNovadeSafetySyncRequest(event, {
      status: (code) => ({
        json: (body) => ({
          statusCode: code,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      }),
    });
  }

  // Daily Manpower Summary API
  if (requestMethod === "POST" && requestPath === "/daily-manpower-summary") {
    console.log("Received a daily manpower summary request");
    return processDailyManpowerSummaryRequest(event, {
      status: (code) => ({
        json: (body) => ({
          statusCode: code,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      }),
    });
  }

  // Daily Manpower Data Report API
  if (requestMethod === "POST" && requestPath === "/daily-manpower-data") {
    console.log("Received a daily manpower data request");
    return processDailyManpowerDataRequest(event, {
      status: (code) => ({
        json: (body) => ({
          statusCode: code,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      }),
    });
  }

  // Manpower Reminder API
  if (requestMethod === "POST" && requestPath === "/manpower-reminder") {
    console.log("Received a manpower reminder request");
    return processManpowerReminderRequest(event, {
      status: (code) => ({
        json: (body) => ({
          statusCode: code,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      }),
    });
  }

  // Daily Report PDF API
  if (requestMethod === "POST" && requestPath === "/daily-report") {
    console.log("Received a daily report request");
    return processDailyReportRequest(event, {
      status: (code) => ({
        json: (body) => ({
          statusCode: code,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      }),
    });
  }

  // Weekly Report API
  if (requestMethod === "POST" && requestPath === "/weekly-report") {
    console.log("Received a weekly report request");
    return processWeeklyReportRequest(event, {
      status: (code) => ({
        json: (body) => ({
          statusCode: code,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      }),
    });
  }

  if (requestMethod === "POST" && requestPath === "/middleware") {
    console.log("received an event: ", event);

    let eventBody = {};
    try {
      eventBody = JSON.parse(event.body);
    } catch (error) {}

    console.log(`Received on middleware: `, eventBody);

    const { chatId, body, phoneNumber, quotedBody, isGroup, clientIdentifier } = eventBody;
    const messageData = eventBody;

    console.log(`The quoted msg is ${quotedBody}`);
    console.log(`The msg is received by ${clientIdentifier}`);

    const IDENTIFIER = process.env.CLIENTIDENTIFIER || "6587842038";

    if (String(clientIdentifier) !== IDENTIFIER) {
      console.log("not the right client");
      return { statusCode: 200, body: "not the right client", headers: { ...corsHeaders } };
    }

    // Novade-sync approval reply detection. The user replies to a preview
    // screenshot we sent earlier (caption ended with `[ref: Novade-Preview-...]`).
    // The listener delivers `quotedBody` containing that marker verbatim;
    // we route to the QA-agent's confirmation handler directly so the user's
    // short reply ("approve" / "cancel") doesn't have to also @-mention the
    // bot to be heard. Must run BEFORE per-group routing so safety handlers
    // don't misclassify the reply as a normal message.
    if (typeof quotedBody === "string" && NOVADE_REF_MARKER_RE.test(quotedBody)) {
      console.log(`Routing to Novade Sync confirmation handler for chatId=${chatId}`);
      try {
        const groupConfig = getGroupConfiguration(chatId);
        const result = await handleNovadeSyncConfirmation(messageData, groupConfig);
        // Send the WA reply ourselves — this is the ONE and only send.
        if (result?.message) {
          try {
            await sendWaText(chatId, result.message);
          } catch (waErr) {
            console.error("Novade confirmation WA send failed:", waErr?.message || waErr);
          }
        }
        // ROOT CAUSE of the duplicate reply (fixed here): the wenti-listener
        // auto-sends the HTTP response body's `message` attribute back to the
        // chat. Returning `{ message }` here made it send a SECOND time — every
        // approve/reject doubled (and only this path, since QA/safety handlers
        // return no `message` in their body). We already sent via sendWaText
        // above, so the response body MUST NOT contain a `message` attribute.
        return {
          statusCode: 200,
          body: JSON.stringify({ ok: true, handled: "novade_confirmation" }),
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        };
      } catch (err) {
        console.error("Novade confirmation handler failed:", err?.stack || err);
        // Plain string body — deliberately no `message` attribute (see above).
        return { statusCode: 200, body: "novade confirmation error", headers: { ...corsHeaders } };
      }
    }

    // QA Agent: process messages containing the bot mention from configured QA groups
    const mentionIds = [process.env.MENTION_BOT_ID, "@154885513306361"].filter(Boolean);
    const hasMention = typeof body === "string" && mentionIds.some((mentionId) => body.includes(mentionId));

    if (hasMention && QA_GROUP_IDS.includes(chatId)) {
      console.log(`Routing to QA Agent for group: ${chatId}`);
      return QAAgentHandler(messageData, corsHeaders);
    }

    // Handle health & safety messages
    if (SAFETY_GROUP_IDS.includes(chatId)) {
      console.log(`Routing to health safety handler for group: ${chatId}`);
      return HealthSafetyHandler(messageData, corsHeaders);
    }

    console.log("no handler...");

    const unhandledRunContext = await createProcessingRun({
      messageId: messageData?.messageId,
      listenerRowId: messageData?.id,
      chatId,
      usecaseKey: "router",
      handlerKey: "router.no_handler",
      messagePayload: messageData,
    });

    await markProcessingSkipped({
      runId: unhandledRunContext?.runId,
      startedAtMs: unhandledRunContext?.startedAtMs ?? Date.now(),
      remarks: `No handler matched for chatId: ${chatId || "unknown"}`,
    });

    const totalExecutionTime = Date.now() - globalStartTime;
    console.log(`Total Lambda execution time: ${totalExecutionTime}ms`);

    return { statusCode: 200, body: "no handler", headers: { ...corsHeaders } };
  }

  console.log("no handler...");

  // Log total Lambda execution time
  const totalExecutionTime = Date.now() - globalStartTime;
  console.log(`Total Lambda execution time: ${totalExecutionTime}ms`);

  return { statusCode: 200, body: "no handler", headers: { ...corsHeaders } };
};
