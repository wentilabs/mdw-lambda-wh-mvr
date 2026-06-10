/**
 * Noise Reading API endpoint
 *
 * Triggers IR2 noise scraper, waits for data, then computes Leq1hr per location,
 * sends a WhatsApp alert if any location exceeds its limit, and writes both the
 * Noise Tracking and Noise Analysis sheets.
 *
 * POST /noise-reading
 * {
 *   "groupIds": ["120363xxx@g.us", "120363yyy@g.us"]  // Required - Array of WhatsApp group IDs
 * }
 */

const axios = require("axios");

const IR2_NOISE_TRIGGER_URL = "https://api4.wentilabs.com/api/run-ir2-noise";
const IR2_NOISE_WAIT_MS = 3 * 60 * 1000; // 3 minutes

/**
 * Process noise reading API request
 * @param {object} req - Request object with body
 * @param {object} res - Response object with status and json methods
 */
async function processNoiseReadingRequest(req, res) {
  try {
    let body = {};
    try {
      body = JSON.parse(req.body || "{}");
    } catch (parseError) {
      console.error("[Noise API] Error parsing request body:", parseError);
    }

    const { groupIds } = body;
    console.log("[Noise API] Request params:", { groupIds });

    // Validate required parameter
    if (!groupIds || !Array.isArray(groupIds) || groupIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: "groupIds is required",
        message: "Please provide a non-empty array of WhatsApp group IDs (groupIds) in the request body",
      });
    }

    // Trigger IR2 noise scraper
    console.log(`[Noise API] Triggering IR2 noise scraper at ${IR2_NOISE_TRIGGER_URL}...`);
    try {
      const triggerResponse = await axios.post(IR2_NOISE_TRIGGER_URL, {}, { timeout: 3 * 60000 });
      console.log(`[Noise API] IR2 trigger response: ${triggerResponse.status}`);
    } catch (triggerError) {
      console.error("[Noise API] IR2 trigger failed (continuing anyway):", triggerError.message);
    }

    // Check if current SGT hour is within tracking hours (7-22 inclusive for noise)
    const now = new Date();
    const sgtHour = parseInt(
      now.toLocaleString("en-US", { timeZone: "Asia/Singapore", hour: "2-digit", hour12: false }),
      10,
    );
    console.log(`[Noise API] Current SGT hour: ${sgtHour}`);

    if (sgtHour < 7 || sgtHour > 22) {
      console.log(`[Noise API] Outside tracking hours (7am-11pm SGT). Skipping noise processing.`);
      return res.status(200).json({
        success: true,
        message: `IR2 scraper triggered but noise processing skipped — outside tracking hours (SGT hour: ${sgtHour})`,
        data: { sgtHour, triggerOnly: true },
      });
    }

    // Within tracking hours — wait for IR2 data then run noise handler
    console.log(`[Noise API] Waiting ${IR2_NOISE_WAIT_MS / 1000}s for IR2 data to be available...`);
    await new Promise((resolve) => setTimeout(resolve, IR2_NOISE_WAIT_MS));

    // Build event for the noise usecase handler
    const { handler: NoiseNotificationHandler } = require("../usecases/noise_notification/index");

    const enhancedEvent = {
      noise: {
        groupIds,
      },
      body: JSON.stringify({ groupIds }),
    };

    console.log(`[Noise API] Calling noise handler`);
    const result = await NoiseNotificationHandler(enhancedEvent, {});

    const responseBody = JSON.parse(result.body || "{}");

    return res.status(result.statusCode || 200).json({
      ...responseBody,
      sgtHour,
    });
  } catch (error) {
    console.error("[Noise API] Error processing noise reading request:", error);
    return res.status(500).json({
      success: false,
      error: error.message,
      message: "Failed to process noise reading request",
    });
  }
}

module.exports = processNoiseReadingRequest;
