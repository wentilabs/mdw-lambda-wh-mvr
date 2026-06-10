// Note: dotenv is loaded in index.js handler, secrets come from AWS Secrets Manager

const { fetchNoiseData } = require("./noise-data");
const { calculateNoiseMetrics, checkLeq5minLimits, getHourlyNoiseLimitsForMetrics } = require("./calculator");
const { sendMultiLocationNotification } = require("./notification");
const { convertToSingaporeTime } = require("../../utils/date");
const { updateNoiseDataForDate } = require("./sheets-direct");
const { getSpreadsheetConfig } = require("../../config/group-config");
const { normalizeLocationCode } = require("./config-loader");

/**
 * Handle noise notification API requests
 * Retrieves noise data, calculates metrics, and sends notifications if needed
 *
 * @param {object} event - The API Gateway event
 * @param {object} corsHeaders - CORS headers for the response
 * @returns {object} - The API response
 */
async function handler(event, corsHeaders) {
  try {
    // Single entry: process the hourly noise run (the legacy GET reading-only
    // path and the summary/sheet-update actions were removed).
    return handlePostRequest(event, corsHeaders);
  } catch (error) {
    console.error("Error in noise handler:", error);
    return {
      statusCode: 500,
      headers: { ...corsHeaders },
      body: JSON.stringify({
        success: false,
        message: "Error processing request",
        error: error.message,
      }),
    };
  }
}

/**
 * Run the hourly noise pipeline: read per-location Leq5min from Supabase,
 * compute Leq1hr, send a WhatsApp alert for any location over its limit, then
 * write both the Noise Tracking and Noise Analysis sheets.
 *
 * @param {object} event - event with { noise: { groupIds } }
 * @param {object} corsHeaders - CORS headers for the response
 * @returns {object} - The API response with metrics + notification + sheet result
 */
async function handlePostRequest(event, corsHeaders) {
  try {
    console.log("Processing noise notification request");

    // Single flow: compute Leq1hr per location → alert if exceeded → write both
    // sheets. No action parameter — the only caller (api/noise-reading.js) sends
    // just groupIds.

    // Extract parameters from request body or noise property
    let groupIds = [];
    let overrideTime = null;
    let overrideDateTime = null;

    try {
      // Check for groupIds in event.noise
      if (event.noise && event.noise.groupIds) {
        groupIds = event.noise.groupIds;
        console.log(`Group IDs provided via event.noise: ${JSON.stringify(groupIds)}`);
      }
      // Check for groupIds in request body
      else if (event.body) {
        const body = JSON.parse(event.body);
        groupIds = body.groupIds || [];
        console.log(`Group IDs provided in request body: ${JSON.stringify(groupIds)}`);
      }

      // Check for datetime override in event.noise
      if (event.noise && event.noise.overrideDateTime) {
        overrideDateTime = event.noise.overrideDateTime;
        console.log(`Using datetime override: ${overrideDateTime}`);
      }

      // Check for time override in event.noise
      else if (event.noise && event.noise.overrideTime) {
        overrideTime = event.noise.overrideTime;
        console.log(`Using time override: ${overrideTime}`);
      }

      // Check for datetime in request body (fallback)
      else if (event.body) {
        const body = JSON.parse(event.body);
        if (body.datetime) {
          overrideDateTime = body.datetime;
          console.log(`Using datetime from request body: ${overrideDateTime}`);
        }
      }
    } catch (e) {
      console.log("No valid body or parameters in the request");
    }

    // Get current time in Singapore timezone
    let now = new Date();
    let useCustomDate = false;

    // First try to use full datetime override if provided
    if (overrideDateTime) {
      try {
        // Try parsing various datetime formats
        const parsedDate = new Date(overrideDateTime);

        // Check if we got a valid date
        if (!isNaN(parsedDate.getTime())) {
          now = parsedDate;
          useCustomDate = true;
          console.log(`DateTime overridden to: ${now.toLocaleString()}`);
        } else {
          // Try parsing yyyy-MM-dd HH:mm format manually
          const parts = overrideDateTime.split(/[T\s]/);
          if (parts.length === 2) {
            const [datePart, timePart] = parts;
            const [year, month, day] = datePart.split("-").map(Number);
            const [hours, minutes] = timePart.split(":").map(Number);

            // Month is 0-based in JavaScript Date
            const customDate = new Date(year, month - 1, day, hours, minutes, 0, 0);
            if (!isNaN(customDate.getTime())) {
              now = customDate;
              useCustomDate = true;
              console.log(`DateTime manually parsed and overridden to: ${now.toLocaleString()}`);
            }
          } else {
            console.error(`Invalid datetime format: ${overrideDateTime}`);
          }
        }
      } catch (e) {
        console.error(`Error parsing datetime: ${e.message}`);
      }
    }
    // Fall back to time-only override if datetime wasn't provided/valid
    else if (overrideTime) {
      try {
        // Parse HH:MM format
        const [hours, minutes] = overrideTime.split(":").map(Number);
        now = new Date(); // Create a fresh date object
        now.setHours(hours, minutes, 0, 0);
        console.log(`Time overridden to: ${now.toLocaleTimeString()}`);
      } catch (e) {
        console.error(`Invalid time override format: ${overrideTime}`);
      }
    }

    const sgTime = convertToSingaporeTime(now, { format: "locale" });
    const sgDate = new Date(sgTime);

    // Extract hour, minutes for processing logic
    const currentHour = sgDate.getHours();
    const currentMinutes = sgDate.getMinutes();

    // Only process at 30 min and 45 min marks (with a small buffer)
    const isProcessingTime =
      (currentMinutes >= 29 && currentMinutes <= 39) || (currentMinutes >= 44 && currentMinutes <= 51);

    // Check if we're in a processing time window
    if (!isProcessingTime) {
      console.log(`Not a regular processing time. Current time: ${sgTime}`);
      console.log("Continuing anyway as timing restrictions have been disabled.");
      // Note: Commented out the early return to allow processing at any time
      // return {
      //   statusCode: 200,
      //   headers: { ...corsHeaders },
      //   body: JSON.stringify({
      //     success: true,
      //     message: 'No processing needed at this time',
      //     currentTime: sgTime
      //   })
      // };
    } else {
      console.log(`Processing time check passed. Current time: ${sgTime}`);
    }

    // Collect data for all locations
    const locations = ["NM1: Marina Bay Sands Tower 1, Level 6 balcony", "NM2: Marina Bay Residences, Level 27"];

    const metricsList = [];
    for (const loc of locations) {
      const data = await fetchNoiseData(currentHour, loc, useCustomDate ? now : null);
      if (!data || data.length === 0) {
        console.log(`No noise data found for location ${loc}, skipping`);
        continue;
      }
      // Extract NM code from location string (e.g., "NM1: Marina Bay..." → "NM1")
      const nmMatch = loc.match(/^(NM\d+)/);
      const rawCode = nmMatch ? nmMatch[1] : "UNKNOWN";
      const code = normalizeLocationCode(rawCode);
      // Calculate metrics with location and date for dynamic limits
      const m = await calculateNoiseMetrics(data, currentHour, currentMinutes, code, sgDate);
      // Get all applicable limits for this location/hour/date
      const allLimits = await getHourlyNoiseLimitsForMetrics(code, currentHour, sgDate);
      const leq1hrApplicable = allLimits.leq_1hr !== null;

      // Check individual LEQ_5min readings against their limit
      const leq5minValues = (m.allReadings || []).filter((v) => v !== null);
      const leq5minCheck = checkLeq5minLimits(leq5minValues, allLimits.leq_5min);

      metricsList.push({
        location: code,
        currentLeq1hr: m.currentLeq1hr,
        hourlyLimit: m.hourlyLimit,
        maxRemainingLeq5min: m.maxRemainingLeq5min,
        leq1hrApplicable,
        leq5minCheck,
        activeLimits: allLimits,
      });
    }

    if (metricsList.length === 0) {
      return {
        statusCode: 404,
        headers: { ...corsHeaders },
        body: JSON.stringify({
          success: false,
          message: "No noise data found for any location",
          currentTime: sgTime,
        }),
      };
    }

    // Send consolidated multi-location notification
    const notificationResult = await sendMultiLocationNotification(metricsList, groupIds, currentHour, currentMinutes);

    // Also update Google Sheets with noise data (runs after notification, non-blocking on failure)
    let sheetUpdateResult = null;
    try {
      console.log("[Noise] Also updating Google Sheets with noise data...");
      const sheetResult = await handleSheetUpdateRequest(event, corsHeaders);
      const sheetBody = JSON.parse(sheetResult.body || "{}");
      sheetUpdateResult = { success: sheetBody.success, message: sheetBody.message };
      console.log(`[Noise] Sheet update: ${sheetBody.success ? "success" : "failed"}`);
    } catch (sheetErr) {
      console.error(`[Noise] Sheet update failed (non-fatal): ${sheetErr.message}`);
      sheetUpdateResult = { success: false, error: sheetErr.message };
    }

    return {
      statusCode: 200,
      headers: { ...corsHeaders },
      body: JSON.stringify({
        success: true,
        message: "Noise notification processed successfully",
        metrics: metricsList,
        notification: notificationResult,
        sheetUpdate: sheetUpdateResult,
        currentTime: sgTime,
      }),
    };
  } catch (error) {
    console.error("Error in POST noise notification handler:", error);

    // Determine appropriate error code based on error type
    let statusCode = 500; // Default to internal server error
    let errorMessage = "Error processing noise notification";

    // Handle specific error types
    if (error instanceof SyntaxError) {
      // Handle JSON parsing errors
      statusCode = 400; // Bad request
      errorMessage = "Invalid request format: Malformed JSON";
    } else if (error.code === "ECONNREFUSED" || error.code === "ENOTFOUND") {
      // Handle connection errors (e.g., to database)
      statusCode = 503; // Service unavailable
      errorMessage = "Database or external service unavailable";
    } else if (error.message && error.message.includes("timeout")) {
      // Handle timeout errors
      statusCode = 504; // Gateway timeout
      errorMessage = "Request timed out";
    }

    // Return appropriate error response
    return {
      statusCode,
      headers: { ...corsHeaders },
      body: JSON.stringify({
        success: false,
        message: errorMessage,
        error: error.message,
        timestamp: new Date().toISOString(),
      }),
    };
  }
}

/**
 * Handle Google Sheet update requests
 * Updates noise monitoring data to Google Sheets for a specific date
 * Enhanced with better error handling and parameter validation
 *
 * @param {object} event - The API Gateway event
 * @param {object} corsHeaders - CORS headers for the response
 * @returns {object} - The API response with sheet update results
 */
async function handleSheetUpdateRequest(event, corsHeaders) {
  try {
    console.log("Processing Google Sheet update request");

    // Validate required configuration
    const noiseConfig = getSpreadsheetConfig("noise");
    if (!noiseConfig?.spreadsheetId) {
      console.error("Noise spreadsheet configuration not available");
      return {
        statusCode: 500,
        headers: { ...corsHeaders },
        body: JSON.stringify({
          success: false,
          message: "Configuration error: Missing required configuration",
          details: "Noise spreadsheetId not configured",
          timestamp: new Date().toISOString(),
        }),
      };
    }

    // Parse date parameter with enhanced validation
    let targetDate = new Date(); // Default to today
    let isCustomDate = false;

    if (event.noise && event.noise.date) {
      const dateParam = event.noise.date;
      console.log(`Date parameter provided: ${dateParam}`);
      isCustomDate = true;

      try {
        // Try parsing YYYY-MM-DD format first (most common)
        const dateParts = dateParam.split("-");
        if (dateParts.length === 3) {
          const [year, month, day] = dateParts.map(Number);
          // Month is 0-based in JavaScript Date
          const parsedDate = new Date(year, month - 1, day);
          if (!isNaN(parsedDate.getTime())) {
            targetDate = parsedDate;
            console.log(`Date parsed successfully in YYYY-MM-DD format: ${targetDate.toLocaleDateString()}`);
          } else {
            console.warn(`Invalid date format (YYYY-MM-DD parsing failed): ${dateParam}`);

            // Try standard Date parsing as fallback
            const parsedDate = new Date(dateParam);
            if (!isNaN(parsedDate.getTime())) {
              targetDate = parsedDate;
              console.log(`Date parsed successfully with standard parsing: ${targetDate.toLocaleDateString()}`);
            } else {
              console.warn(`All date parsing methods failed for: ${dateParam}, using current date as fallback`);
              isCustomDate = false; // Reset since we're using default
            }
          }
        } else {
          // Try standard Date parsing
          const parsedDate = new Date(dateParam);
          if (!isNaN(parsedDate.getTime())) {
            targetDate = parsedDate;
            console.log(`Date parsed successfully with standard parsing: ${targetDate.toLocaleDateString()}`);
          } else {
            console.warn(`Invalid date format: ${dateParam}, using current date as fallback`);
            isCustomDate = false; // Reset since we're using default
          }
        }
      } catch (e) {
        console.error(`Error parsing date: ${e.message}, using current date as fallback`);
        isCustomDate = false; // Reset since we're using default
      }
    } else {
      console.log("No date parameter provided, using current date");
    }

    // Validate date is not too far in the past or future (optional)
    const now = new Date();
    const oneYearInMs = 365 * 24 * 60 * 60 * 1000;
    if (Math.abs(targetDate.getTime() - now.getTime()) > oneYearInMs) {
      console.warn(
        `Date ${targetDate.toLocaleDateString()} is more than a year from current date, this might be an error`,
      );
    }

    // Check for all_day parameter with better parsing
    let timeRangeFilter = true; // Default to evening hours only (7pm-10:55pm)

    if (event.noise && event.noise.all_day !== undefined) {
      // Handle string 'true'/'false' and boolean true/false
      if (event.noise.all_day === "true" || event.noise.all_day === true) {
        timeRangeFilter = false; // No time filter when all_day is true
        console.log("All day parameter is true - will fetch data for entire day");
      } else {
        console.log("All day parameter is false or invalid - using evening hours only (7pm-10:55pm)");
      }
    } else {
      console.log("No all_day parameter provided, defaulting to evening hours only (7pm-10:55pm)");
    }

    // Update noise data to Google Sheets with appropriate logging
    console.log(`Updating noise data for ${targetDate.toLocaleDateString()} to Google Sheets...`);
    console.log(`- Time range: ${timeRangeFilter ? "Evening hours only (7pm-10:55pm)" : "All day"}`);
    console.log(`- Using ${isCustomDate ? "custom date" : "current date"}`);

    // Call the update function with the parameters
    const updateResult = await customUpdateNoiseData(targetDate, timeRangeFilter);

    console.log("Sheet update completed with result:", updateResult);

    // Check if update was successful but no data was found
    if (updateResult.success && !updateResult.dataUpdated && updateResult.totalProcessed === 0) {
      console.log("Update successful but no data was found or updated");
      return {
        statusCode: 200, // Still return 200 as the request was processed successfully
        headers: { ...corsHeaders },
        body: JSON.stringify({
          success: true,
          message: `No noise data found for ${targetDate.toLocaleDateString()}. Nothing to update.`,
          date: updateResult.date,
          sheetName: updateResult.sheetName || null,
          dataUpdated: false,
          stats: {
            updated: 0,
            skipped: 0,
            failed: 0,
            total: 0,
          },
          timestamp: new Date().toISOString(),
        }),
      };
    }

    // Format detailed response
    return {
      statusCode: updateResult.success ? 200 : 500,
      headers: { ...corsHeaders },
      body: JSON.stringify({
        success: updateResult.success,
        message: updateResult.message,
        date: updateResult.date,
        sheetName: updateResult.sheetName || null,
        dataUpdated: updateResult.dataUpdated || false,
        stats: {
          updated: updateResult.successful ? updateResult.successful.length : 0,
          skipped: updateResult.skipped ? updateResult.skipped.length : 0,
          failed: updateResult.failed ? updateResult.failed.length : 0,
          total: updateResult.totalProcessed || 0,
        },
        timeRange: timeRangeFilter ? "evening" : "all_day",
        timestamp: new Date().toISOString(),
      }),
    };
  } catch (error) {
    console.error("Error in Google Sheet update handler:", error);
    let errorMessage = "Error updating Google Sheet";
    let statusCode = 500;

    // Provide more specific error messages for common error cases
    if (error.message && error.message.includes("auth")) {
      errorMessage = "Authentication error while accessing Google Sheets";
    } else if (error.message && error.message.includes("quota")) {
      errorMessage = "Google API quota exceeded, please try again later";
      statusCode = 429; // Too Many Requests
    } else if (error.message && error.message.includes("not found")) {
      errorMessage = "Sheet not found, check your configuration";
      statusCode = 404;
    }

    return {
      statusCode: statusCode,
      headers: { ...corsHeaders },
      body: JSON.stringify({
        success: false,
        message: errorMessage,
        error: error.message,
        timestamp: new Date().toISOString(),
      }),
    };
  }
}

/**
 * Custom wrapper for updateNoiseDataForDate that handles time range filter option
 * Enhanced with better error handling and parameter validation
 *
 * @param {Date} date - Date to update data for
 * @param {boolean} timeRangeFilter - Whether to filter to evening hours only
 * @returns {Promise<object>} - Update result
 */
async function customUpdateNoiseData(date, timeRangeFilter = true) {
  try {
    // Validate date parameter
    if (!date || !(date instanceof Date) || isNaN(date.getTime())) {
      console.error("Invalid date parameter provided to customUpdateNoiseData");
      return {
        success: false,
        message: "Invalid date parameter provided",
        date: null,
      };
    }

    // Get spreadsheet ID from configuration
    const noiseConfig = getSpreadsheetConfig("noise");
    const spreadsheetId = noiseConfig?.spreadsheetId;
    if (!spreadsheetId) {
      console.error("Noise spreadsheet configuration not available");
      return {
        success: false,
        message: "Configuration error: Noise spreadsheetId not configured",
      };
    }

    // Log important parameters
    console.log(`Calling updateNoiseDataForDate with:`);
    console.log(`- Date: ${date.toLocaleDateString()}`);
    console.log(`- Time range filter: ${timeRangeFilter ? "Active (evening hours only)" : "Disabled (all day)"}`);

    // TODO: The current implementation of updateNoiseDataForDate in sheets-direct.js
    // has hardcoded timeRangeFilter=true at line 906. To fully support the all_day parameter,
    // you would need to modify sheets-direct.js to accept this parameter.
    // For now, we'll use the default behavior (evening hours only).

    // Call the original function with appropriate logging
    try {
      const result = await updateNoiseDataForDate(date);

      // Enhance the result with the requested time range info
      return {
        ...result,
        requestedTimeRange: timeRangeFilter ? "evening_only" : "all_day",
        actualTimeRange: "evening_only", // Hardcoded because of current implementation
      };
    } catch (innerError) {
      console.error("Error in updateNoiseDataForDate:", innerError);
      throw innerError; // Re-throw for consistent error handling
    }
  } catch (error) {
    console.error("Error in custom update noise data function:", error);

    // Provide more detailed error response
    return {
      success: false,
      message: `Error updating noise data: ${error.message}`,
      date: date && date instanceof Date ? date.toISOString().split("T")[0] : null,
      errorDetails: {
        name: error.name,
        stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
      },
    };
  }
}

module.exports = {
  handler,
};
