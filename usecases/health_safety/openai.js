// Note: dotenv is loaded in index.js handler, secrets come from AWS Secrets Manager
const { getOpenAI } = require("../../utils/openai");
const { retrieveImageFromSupabase } = require("../../utils/action");
const {
  createSafetyIssue,
  updateSafetyIssues,
  // createWBGTReading, // Commented out - WBGT now triggered by API, not WhatsApp messages
  findExistingSafetyIssueRow,
  cloneSafetyIssue,
  handleDeletedSafetyMessage,
  handleEditedSafetyMessage,
  resolveAlbumParentMessageId,
  parsePicRef,
  handlePicFollowupReply,
} = require("../../handlers/safety-handlers");
const {
  createManpowerData,
  createWohhupManpowerData,
  handleDeletedManpowerMessage,
  handleEditedManpowerMessage,
} = require("../../handlers/manpower-handlers");
const { detectWohhupManpowerFormat } = require("../../handlers/wohhup-manpower-extract");
const { getGroupConfiguration } = require("../../config/group-config");
// Optional usecases — present in wh-mbs, NOT shipped in the 5-use-case base
// template. Lazy try/catch lets the import graph resolve cleanly when these
// folders are absent. Missing handlers fall back to a no-op async stub so
// wh-mbs's dispatch logic stays verbatim (each unconditional `await handler(...)`
// call simply returns null and falls through — the piling/im/pile_cap branches
// never produce a result without their folders + designated group ids).
const __absentUsecaseStub = async () => null;
let processProgressReport, handleEditedPilingMessage, handleDeletedPilingMessage;
try {
  ({
    processProgressReport,
    handleEditedPilingMessage,
    handleDeletedPilingMessage,
  } = require("../piling_progress/openai"));
} catch (e) {
  processProgressReport = handleEditedPilingMessage = handleDeletedPilingMessage = __absentUsecaseStub;
}
let processIMReport, handleEditedIMMessage, handleDeletedIMMessage;
try {
  ({ processIMReport, handleEditedIMMessage, handleDeletedIMMessage } = require("../im_progress/openai"));
} catch (e) {
  processIMReport = handleEditedIMMessage = handleDeletedIMMessage = __absentUsecaseStub;
}
const {
  handleWaterParade,
  handleEditedWaterParadeMessage,
  handleDeletedWaterParadeMessage,
} = require("./water_parade");
const { getSupabaseClient } = require("../../utils/common");

// Import optimized prompts
const {
  intentClassificationPrompt,
  intentAuditPrompt,
  auditorTools,
} = require("../../handlers/prompts/safety-prompts");

const metadata = {
  project: "wohhup",
};

/**
 * Edge-case race detector for the edit-then-delete sequence.
 *
 * Scenario: a message gets rejected by the validator (so no row is written),
 * then the user EDITS to fix it AND deletes it within seconds. The edit
 * handler retries for ~2 minutes waiting for "the original" to appear; during
 * that window, the deletion event runs and finds nothing to delete. When the
 * edit handler finally gives up and falls back to "process as new", it would
 * resurrect a message the user already removed.
 *
 * This helper checks `whatsapp_listener` for any deletion event whose
 * `parentMsgKey` references the given messageId. If found → caller must
 * skip the fallback write.
 *
 * @param {string} messageId  - the original message's WhatsApp messageId
 * @param {string} chatId     - the chat the message lives in (for index hit)
 * @returns {Promise<boolean>}
 */
async function wasMessageDeleted(messageId, chatId) {
  if (!messageId) return false;
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from("whatsapp_listener")
      .select("id")
      .eq("isDeleted", true)
      .like("parentMsgKey", `%_${messageId}_%`)
      .limit(1);
    if (error) {
      console.warn(`[wasMessageDeleted] supabase error for ${messageId}:`, error.message);
      return false; // fail-open: don't block the fallback if the check fails
    }
    return Array.isArray(data) && data.length > 0;
  } catch (e) {
    console.warn(`[wasMessageDeleted] unexpected error for ${messageId}:`, e?.message || e);
    return false;
  }
}

/**
 * Detects if a string appears to be base64-encoded image data
 * Common JPEG base64 signatures start with /9j/4AAQ... (FFD8FFE0 in hex)
 * @param {string} str - The string to check
 * @returns {boolean} - True if the string appears to be base64 image data
 */
function isBase64ImageData(str) {
  if (!str || typeof str !== "string") {
    return false;
  }

  // Common base64 image signatures:
  // JPEG: /9j/4 (FFD8FF in hex)
  // PNG: iVBORw (89504E47 in hex)
  // GIF: R0lGOD (47494638 in hex)
  // WebP: UklGR (52494646 in hex)
  const base64ImagePatterns = [
    /^\/9j\/[0-9A-Za-z+/]/, // JPEG
    /^iVBORw[0-9A-Za-z+/]/, // PNG
    /^R0lGOD[a-zA-Z]/, // GIF
    /^UklGR[0-9A-Za-z+/]/, // WebP
  ];

  const trimmed = str.trim();

  // Check if string matches any base64 image pattern and is long enough to be image data
  // (base64 image data is typically at least several hundred characters)
  if (trimmed.length < 100) {
    return false;
  }

  return base64ImagePatterns.some((pattern) => pattern.test(trimmed));
}

/**
 * Retry wrapper for OpenAI API calls with exponential backoff
 * @param {Function} apiCall - The OpenAI API call function to retry
 * @param {string} operationName - Name of the operation for logging
 * @param {number} maxRetries - Maximum number of retries (default: 2)
 * @returns {Promise} - Result of the API call
 */
async function withOpenAIRetry(apiCall, operationName, maxRetries = 2) {
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await apiCall();
      if (attempt > 0) {
        console.log(`✅ [OPENAI RETRY SUCCESS] ${operationName} succeeded on attempt ${attempt + 1}`);
      }
      return result;
    } catch (error) {
      lastError = error;

      // Don't retry on the last attempt
      if (attempt === maxRetries) {
        break;
      }

      // Check if error is retryable
      const isRetryable =
        (error.status === 400 && error.message && error.message.includes("Timeout while downloading")) || // Image download timeout
        error.status === 429 || // Rate limit
        error.status === 500 || // Internal server error
        error.status === 502 || // Bad gateway
        error.status === 503 || // Service unavailable
        error.status === 504 || // Gateway timeout
        (error.message &&
          (error.message.includes("timeout") ||
            error.message.includes("network") ||
            error.message.includes("connection") ||
            error.message.includes("downloading")));

      if (!isRetryable) {
        console.error(`❌ [OPENAI NON-RETRYABLE] ${operationName} failed:`, error.message);
        throw error;
      }

      // Calculate delay with exponential backoff + jitter
      const delay = 2000 * Math.pow(2, attempt) + Math.random() * 1000;

      console.warn(
        `⚠️ [OPENAI RETRY ${attempt + 1}/${maxRetries}] ${operationName} failed: ${
          error.message
        }. Retrying in ${Math.round(delay)}ms...`,
      );

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  console.error(
    `❌ [OPENAI RETRY EXHAUSTED] ${operationName} failed after ${maxRetries + 1} attempts:`,
    lastError.message,
  );
  throw lastError;
}

/**
 * Detects if an image contains a WBGT thermometer or temperature measurement device
 * @param {string} mediaUrl - URL of the image to analyze
 * @returns {Promise<boolean>} - True if thermometer detected, false otherwise
 */
async function detectThermometerInImage(mediaUrl) {
  try {
    const input = [
      {
        role: "system",
        content:
          "You are an assistant that detects WBGT thermometers and temperature measurement devices in images. Look for digital displays, analog thermometers, or any temperature reading devices.",
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: 'Does this image show a WBGT thermometer, temperature measurement device, or temperature display? Look for:\n- Digital temperature displays\n- Analog thermometers\n- WBGT measurement devices\n- Any device showing temperature readings\n\nReply with only "yes" if you see a temperature measurement device, or "no" if you do not.',
          },
          {
            type: "input_image",
            image_url: mediaUrl,
          },
        ],
      },
    ];

    const response = await withOpenAIRetry(async () => {
      return await getOpenAI().responses.create({
        model: "gpt-4.1",
        input,
        store: true,
        metadata,
      });
    }, "detectThermometerInImage");

    const responseText = response.output[0]?.content || "";
    const isThermometer = responseText.toLowerCase().includes("yes");

    console.log(`🌡️ Thermometer detection result: ${isThermometer ? "DETECTED" : "NOT DETECTED"}`);
    return isThermometer;
  } catch (error) {
    console.error("❌ Error detecting thermometer in image:", error);
    return false; // Default to not a thermometer on error
  }
}

/**
 * Processes a message using OpenAI function calling to extract structured updates into multiple rows
 * @param {string} messageContent - The message content to analyze
 * @returns {Promise<{functionName: string|null, arguments: object|null}>} - Function name and arguments if a function was called
 */
async function processMessageAgent(message) {
  let messageBody = message;
  let senderDetails = {};
  let messageType = "text";
  let caption = "";
  let mediaUrl = "";
  const whatsappGroupId = message.from;

  const groupConfig = getGroupConfiguration(whatsappGroupId);

  let preResolvedIntent = null;

  if (typeof message === "object") {
    messageBody = message.body;
    senderDetails = {
      name: message.sender || "",
      text: message.body || "",
      phoneNumber: message.phoneNumber || "",
      messageId: message.messageId || "",
      messageIdSerialized: message.messageIdSerialized || "",
      parentMsgKey: message.parentMsgKey || null,
      timestamp: message.timestamp || new Date().toISOString(),
      // chatName flows through to the sheet's ChatGroup column (col 14) and
      // also lands in the Sender JSON for forensic / future use.
      chatName: message.chatName || "",
    };

    // Drop trash messages: image type with base64 body and no mediaFilename
    if (message.type === "image" && !message.mediaFilename && isBase64ImageData(message.body)) {
      console.log("🗑️ Dropping trash message: image type with base64 body and no mediaFilename");
      return null;
    }

    // Handle deleted messages — before intent classification (no LLM call needed)
    if (message.isDeleted === true) {
      console.log("🗑️ Deleted message detected");
      const safetyResult = await handleDeletedSafetyMessage(message, groupConfig);
      if (safetyResult) return safetyResult;
      const manpowerResult = await handleDeletedManpowerMessage(message, groupConfig);
      if (manpowerResult) return manpowerResult;
      const pilingDeleteResult = await handleDeletedPilingMessage(message, groupConfig);
      if (pilingDeleteResult) return pilingDeleteResult;
      const imDeleteResult = await handleDeletedIMMessage(message, groupConfig);
      if (imDeleteResult) return imDeleteResult;
      let handleDeletedPileCapMessage = __absentUsecaseStub;
      try {
        ({ handleDeletedPileCapMessage } = require("../pile_cap/index"));
      } catch (e) {
        /* pile_cap not shipped in base */
      }
      const pileCapDeleteResult = await handleDeletedPileCapMessage(message, groupConfig);
      if (pileCapDeleteResult) return pileCapDeleteResult;
      const waterParadeDeleteResult = await handleDeletedWaterParadeMessage(message, groupConfig);
      if (waterParadeDeleteResult) return waterParadeDeleteResult;
      console.log("🗑️ Deleted message not found on any sheet");
      return null;
    }

    // Handle edited messages — before intent classification
    if (message.isEdited === true) {
      console.log("✏️ Edited message detected");
      const safetyResult = await handleEditedSafetyMessage(message, senderDetails, groupConfig);
      if (safetyResult) return safetyResult;
      const manpowerResult = await handleEditedManpowerMessage(message, senderDetails, groupConfig);
      if (manpowerResult) return manpowerResult;
      const pilingEditResult = await handleEditedPilingMessage(message, groupConfig);
      if (pilingEditResult) return pilingEditResult;
      const imEditResult = await handleEditedIMMessage(message, groupConfig);
      if (imEditResult) return imEditResult;
      let handleEditedPileCapMessage = __absentUsecaseStub;
      try {
        ({ handleEditedPileCapMessage } = require("../pile_cap/index"));
      } catch (e) {
        /* pile_cap not shipped in base */
      }
      const pileCapEditResult = await handleEditedPileCapMessage(message, groupConfig);
      if (pileCapEditResult) return pileCapEditResult;
      const waterParadeEditResult = await handleEditedWaterParadeMessage(message, senderDetails, groupConfig);
      if (waterParadeEditResult) return waterParadeEditResult;

      // Edge case: original was rejected (e.g. validator mismatch) → no row to update.
      // Before falling back to "process as new", check if the user has since DELETED
      // this message. If yes, skip the fallback write — otherwise we'd resurrect a
      // message the user explicitly removed (the deletion handler already ran during
      // our retry window and found nothing on the sheet).
      const hasPendingDeletion = await wasMessageDeleted(message.messageId, message.from);
      if (hasPendingDeletion) {
        console.log(
          `✏️ Edited message ${message.messageId} was DELETED by user — skipping fallback "process as new" write.`,
        );
        return null;
      }

      console.log("✏️ Edited message not found on any sheet, processing as new");
      // Fall through to normal processing
    }

    // PIC follow-up: a reply to our "please tag the PIC" ask carries a
    // "[ref: PIC-<originalMessageId>]" marker in quotedBody. Resolve the tagged person(s)
    // and fill the original issue's PIC — same @mention→name flow as the create path.
    // Deterministic short-circuit, BEFORE intent classification (like the sustainability
    // [ref:] follow-up). The "PIC-" namespace can't collide with the Novade-Preview marker.
    if (message.quotedBody && parsePicRef(message.quotedBody)) {
      const picResult = await handlePicFollowupReply(message, senderDetails, groupConfig);
      if (picResult) return picResult;
    }

    if (message.type === "image") {
      messageType = "image";
      caption = message.body || "";
      if (message.mediaFilename) {
        mediaUrl = await retrieveImageFromSupabase(whatsappGroupId, message.mediaFilename);
      } else {
        // No mediaFilename - check if body contains base64 image data
        if (isBase64ImageData(message.body)) {
          console.log("Rejecting message: image type with base64 data in body but no mediaFilename");
          return {
            rejected: true,
            reason: "Message contains base64 image data without proper media file. Please resend the image.",
          };
        }
        // No mediaFilename and no base64 data - this is likely an edited message (text-only edit)
        // Don't fall back to latest image, treat as text-only
        console.log("no mediaFilename - treating as text-only edit");
        mediaUrl = null;
      }

      // Heuristic: image-only reply to an existing open safety issue should close the issue
      if (!caption && message.quotedMessageId) {
        try {
          let lookupId = message.quotedMessageId;
          const sheetIdentifier = {
            messageId: lookupId,
            parentMessageId: lookupId,
          };

          let existingIssue = await findExistingSafetyIssueRow(sheetIdentifier, groupConfig);

          // If not found, the user may have replied to an album child image.
          // Resolve to the album parent's messageId and retry.
          if (!existingIssue) {
            const albumParentId = await resolveAlbumParentMessageId(lookupId, message.from);
            if (albumParentId) {
              existingIssue = await findExistingSafetyIssueRow(
                { messageId: albumParentId, parentMessageId: albumParentId },
                groupConfig,
              );
            }
          }

          if (
            existingIssue &&
            (!existingIssue.Status ||
              (typeof existingIssue.Status === "string" && existingIssue.Status.toLowerCase() === "open"))
          ) {
            console.log("Heuristic: image-only reply to quoted open safety issue detected. Forcing update intent.");
            preResolvedIntent = "update_safety_issue";
          }
        } catch (error) {
          console.warn("Failed heuristic lookup for image-only reply:", error?.message || error);
        }
      }

      // NEW LOGIC: Skip image-only messages without quotedMessageId
      // BUT allow WBGT thermometer images AND water-parade images to pass through
      if (!caption && !message.quotedMessageId) {
        // Classify intent first to check if it's a WBGT reading or a water parade
        const quickIntent = await classifyMessageIntent(message, mediaUrl);

        if (quickIntent !== "wbgt_reading_entry" && quickIntent !== "water_parade_entry") {
          console.log("📸 [IMAGE-ONLY SKIP] Image without text and not a reply. Ignoring for safety creation.");
          return null;
        } else if (quickIntent === "water_parade_entry") {
          console.log("💧 [WATER PARADE DETECTED] Image-only water parade detected. Processing...");
          preResolvedIntent = quickIntent; // Use the classified intent
        } else {
          console.log("🌡️ [WBGT DETECTED] Image-only WBGT thermometer detected. Processing...");
          preResolvedIntent = quickIntent; // Use the classified intent
        }
      }
    }
  }

  // PRE-CLASSIFICATION: Wohhup compact manpower format
  // Must run BEFORE the generic manpower pre-classifier because Wohhup messages
  // can have very few role-count lines (Workers: T= 06, WH Total = 06, etc.) and
  // would either miss the generic ≥5-role-count threshold OR match it incorrectly
  // and produce empty workerBreakdown (the standard extractor doesn't recognize
  // Wohhup-specific phrasing like "Workers on site: NN" or "WH Engineering: NN").
  if (!preResolvedIntent) {
    const preBody = (typeof message === "object" ? message.body : message) || "";
    const whFormat = detectWohhupManpowerFormat(preBody);
    if (whFormat === "staff") {
      console.log(
        "[PRE-CLASSIFY] Wohhup STAFF manpower detected — skipping (already tracked by wh-staff-tracker for daily image).",
      );
      return null;
    }
    if (whFormat === "workers") {
      // Same treatment as staff: do NOT store on the manpower sheet. The compact
      // register (Total / Workers on site / Home leave / Loan out / Absent) is
      // fetched directly from Supabase via wh-worker-breakdown-tracker for the
      // daily summary / manpower data sheet / QA agent. The detailed per-role
      // breakdown lands on the sheet via the standard manpower extractor (the
      // TBM-style "Subject:TBM" message with `1) Traffic controller -2 …`).
      console.log(
        "[PRE-CLASSIFY] Wohhup WORKERS compact register detected — skipping sheet write (tracked by wh-worker-breakdown-tracker).",
      );
      return null;
    }
    if (whFormat === "engineering") {
      console.log("[PRE-CLASSIFY] Wohhup ENGINEERING manpower detected — routing to dedicated extractor.");
      if (typeof message === "object") message.__wohhupSectionType = whFormat;
      preResolvedIntent = "wohhup_manpower_data_entry";
    }
  }

  // PRE-CLASSIFICATION: Detect manpower report structure deterministically
  // Manpower reports have an unmistakable structural signature that NO safety issue ever has.
  // Key indicators: "Manpower" keyword + "Total Manpower" line + many role-count pairs
  // Optional reinforcing indicators: "Machineries"/"Machinery"/"Equipment" section, "Work activities" section
  if (!preResolvedIntent) {
    const preBody = (typeof message === "object" ? message.body : message) || "";
    const preBodyLower = preBody.toLowerCase();

    // PRIMARY indicators
    const hasManpowerKeyword = preBodyLower.includes("manpower");
    const hasTotalLine = /total\s*(manpower|man\s*power|mp)?\s*[=:\-]+\s*\d+/i.test(preBody);
    // Count role-count pairs: "Role :- NN" or "Role - NN" or "Role = NN" or "Role :NN"
    const roleCountMatches = preBody.match(/[♦️🔹▪️•\-\d.)]*\s*[A-Za-z][A-Za-z\s&/()]+\s*[:\-=]+\s*\d{1,4}\b/g) || [];

    // SECONDARY indicators (reinforcing)
    const hasMachinerySection = /machiner(y|ies)|equipment/i.test(preBody);
    const hasActivitySection = /work\s*activit(y|ies)/i.test(preBody);

    // TEMPLATE indicators — explicit manpower-report headers (with or without
    // WhatsApp markdown asterisks). Both `*Company* : XXX` and `Company :- XXX`
    // styles are widely used.
    const hasCompanyMarker = /\*?\s*Company\s*\*?\s*[:\-]/i.test(preBody);
    const hasTotalManpowerMarker = /\*?\s*Total\s*Manpower\s*\*?\s*[:\-=]/i.test(preBody);

    const hasPlaceholder = preBodyLower.includes("xx/xxx") || /company\s*:\s*xxx\b/i.test(preBodyLower);

    // STRONG match: all primary indicators present
    if (hasManpowerKeyword && hasTotalLine && roleCountMatches.length >= 5 && !hasPlaceholder) {
      console.log(
        `[PRE-CLASSIFY] Manpower report detected: "manpower" keyword + total line + ${roleCountMatches.length} role-count pairs → forcing manpower_data_entry (LLM bypassed)`,
      );
      preResolvedIntent = "manpower_data_entry";
    }
    // REINFORCED match: manpower keyword + role-count pairs + secondary indicators (no total line)
    else if (
      hasManpowerKeyword &&
      roleCountMatches.length >= 5 &&
      (hasMachinerySection || hasActivitySection) &&
      !hasPlaceholder
    ) {
      console.log(
        `[PRE-CLASSIFY] Manpower report detected: "manpower" keyword + ${roleCountMatches.length} role-count pairs + machinery/activities section → forcing manpower_data_entry (LLM bypassed)`,
      );
      preResolvedIntent = "manpower_data_entry";
    }
    // SMALL-TEAM match: explicit template markers (Company + Total Manpower)
    // + ≥2 role-count pairs. Catches reports like 2-role TBMs that the ≥5
    // threshold misses but are unmistakably manpower reports because of the
    // template structure.
    else if (hasCompanyMarker && hasTotalManpowerMarker && roleCountMatches.length >= 2 && !hasPlaceholder) {
      console.log(
        `[PRE-CLASSIFY] Small-team manpower report detected: Company + Total Manpower markers + ${roleCountMatches.length} role-count pairs → forcing manpower_data_entry (LLM bypassed)`,
      );
      preResolvedIntent = "manpower_data_entry";
    }
  }

  // PRE-CLASSIFICATION: Detect piling progress report structure deterministically
  // Piling progress reports have an unmistakable structural signature:
  // - Multiple "(completed X/total Y)" patterns for different work categories
  // - Numbered sections (1. Barrette Pile, 2. D-wall, etc.)
  // - Type must be "chat" (plain text only)
  // - ONLY from the designated piling group
  const PILING_GROUP_ID = process.env.PILING_PROGRESS_GROUP_ID || "";
  const pilingChatId = typeof message === "object" ? message.chatId || message.from || "" : "";

  if (!preResolvedIntent && PILING_GROUP_ID && pilingChatId === PILING_GROUP_ID) {
    const pilingBody = (typeof message === "object" ? message.body : message) || "";
    const pilingType = typeof message === "object" ? message.type : "chat";

    if (pilingType === "chat" && pilingBody.trim().length >= 50) {
      // Count completion count patterns: "(completed X/total Y)" or "(Complete X/Y)"
      const completionMatches = pilingBody.match(/\b(?:complet(?:ed?|e))\s*\d+\s*[\/]\s*(?:total\s*)?\d+/gi) || [];

      // Must have 3+ completion counts to be a real daily report (not a casual mention)
      if (completionMatches.length >= 3) {
        // Additional check: must have numbered sections (1., 2., 3.)
        const numberedSections = pilingBody.match(/^\s*\d+\s*\.\s*/gm) || [];
        if (numberedSections.length >= 2) {
          console.log(
            `[PRE-CLASSIFY] Piling progress report detected: ${completionMatches.length} completion counts + ${numberedSections.length} numbered sections → forcing piling_progress_report (LLM bypassed)`,
          );
          preResolvedIntent = "piling_progress_report";
        }
      }
    }
  }

  // PRE-CLASSIFICATION: Detect instrumentation monitoring (IM) progress report structure deterministically
  // IM summary reports: date + multiple lines of "CODE - X/Y" instrument counts
  // IM activity reports: date + rig references + instrument IDs + activity keywords
  // ONLY from the designated IM group
  const IM_GROUP_ID = process.env.IM_PROGRESS_GROUP_ID || "";
  const imChatId = typeof message === "object" ? message.chatId || message.from || "" : "";

  if (!preResolvedIntent && IM_GROUP_ID && imChatId === IM_GROUP_ID) {
    const imBody = (typeof message === "object" ? message.body : message) || "";
    const imType = typeof message === "object" ? message.type : "chat";

    if (imType === "chat" && imBody.trim().length >= 20) {
      // Check for summary pattern: CODE - X/Y (e.g., "IW - 16/23")
      const instrumentCountMatches = imBody.match(/[A-Z]{1,4}\s*-\s*\d+\s*\/\s*\d+/g) || [];

      if (instrumentCountMatches.length >= 3) {
        console.log(
          `[PRE-CLASSIFY] IM summary report detected: ${instrumentCountMatches.length} instrument counts → forcing im_progress_report (LLM bypassed)`,
        );
        preResolvedIntent = "im_progress_report";
      } else {
        // Check for activity pattern: rig + instrument ID
        const hasRig = /\brig\s*\d+/i.test(imBody);
        const hasInstrumentId = /\b[A-Z]{1,4}\d{3,}/i.test(imBody);
        const hasDate = /\b\d{1,2}\s*[\/\-]\s*\d{1,2}\s*[\/\-]\s*\d{2,4}\b/.test(imBody);

        if (hasRig && hasInstrumentId && hasDate) {
          console.log(
            `[PRE-CLASSIFY] IM activity report detected: rig + instrument ID + date → forcing im_progress_report (LLM bypassed)`,
          );
          preResolvedIntent = "im_progress_report";
        }
      }
    }
  }

  // PRE-CLASSIFICATION: Detect pile cap (CJ) update messages deterministically
  // CJ updates are short messages (usually with images) containing "CJ" + number + activity keyword
  // e.g., "CJ8 rebar work is in progress", "CJ 11, hacking work finished"
  if (!preResolvedIntent) {
    // Pile cap (CJ) classification is now handled by the LLM intent classifier,
    // which has explicit rules to distinguish a pile_cap_update (e.g. "CJ12
    // rebar finished") from a safety report at a CJ location (e.g. "rebar
    // broken at CJ13" or a formal "Severity:/Category:/..." template). The
    // previous regex pre-classifier was too greedy — it forced any message
    // with `CJ\d+` + activity keyword into pile_cap_update, mis-routing real
    // safety reports into the CJ Tracking sheet.
  }

  let intentType = preResolvedIntent;

  if (!intentType) {
    intentType = await classifyMessageIntent(message, mediaUrl);
    console.log(`Classified intent: ${intentType}`);

    // ── LLM AUDITOR SELF-CORRECTION LOOP (max 1 retry) ──
    const hasQuotedIdForAudit = typeof message === "object" && !!message.quotedMessageId;
    const auditResult = await auditClassification(message, mediaUrl, intentType, messageBody);
    if (auditResult.shouldReclassify) {
      // HARD GUARD: Replies (quotedMessageId) can NEVER be reclassified to create_safety_issue
      if (hasQuotedIdForAudit && auditResult.suggestedIntent === "create_safety_issue") {
        console.log(
          `🚫 [AUDITOR BLOCKED] Auditor suggested create_safety_issue for a REPLY message — this is invalid. Replies can only be update_safety_issue or others. Keeping original: "${intentType}"`,
        );
      } else {
        console.log(
          `🔍 [AUDITOR] Reclassifying from "${intentType}" → suggested "${auditResult.suggestedIntent}". Reason: ${auditResult.correctionMessage}`,
        );
        intentType = await classifyMessageIntentWithContext(message, mediaUrl, auditResult.correctionMessage);
        console.log(`🔍 [AUDITOR] Final intent after reclassification: ${intentType}`);
      }
    }
  } else {
    console.log(`Intent pre-resolved via heuristic: ${intentType}`);
    // No audit for pre-resolved intents (heuristics, not NLP)
  }

  // SANITY CHECK: update_safety_issue requires quotedMessageId
  if (intentType === "update_safety_issue") {
    const hasQuotedId = typeof message === "object" && !!message.quotedMessageId;
    if (!hasQuotedId) {
      console.log(`[SANITY CHECK] update_safety_issue without quotedMessageId → re-classifying as create_safety_issue`);
      intentType = "create_safety_issue";
    }
  }

  // SANITY CHECK: create_safety_issue with quotedMessageId is invalid — replies don't create new issues
  if (intentType === "create_safety_issue") {
    const hasQuotedId = typeof message === "object" && !!message.quotedMessageId;
    if (hasQuotedId) {
      console.log(
        `🚫 [SANITY CHECK] create_safety_issue with quotedMessageId → replies cannot create new issues. Re-classifying as others.`,
      );
      intentType = "others";
    }
  }

  // SANITY CHECK: water_parade_entry must be an ORIGINAL message, never a reply.
  // A reply that merely mentions a water parade does not log a new WBGT water-parade record.
  if (intentType === "water_parade_entry") {
    const hasQuotedId = typeof message === "object" && !!message.quotedMessageId;
    if (hasQuotedId) {
      console.log(
        `🚫 [SANITY CHECK] water_parade_entry with quotedMessageId → replies cannot log a water parade. Re-classifying as others.`,
      );
      intentType = "others";
    }
  }

  // SANITY CHECK: manpower reports misclassified as create_safety_issue
  // A message with manpower-report structure cannot be a safety issue.
  if (intentType === "create_safety_issue") {
    const body = (typeof message === "object" ? message.body : message) || "";
    const bodyLower = body.toLowerCase();
    const hasManpowerKeyword = bodyLower.includes("manpower");
    const hasTotalLine = /total\s*(manpower|man\s*power|mp)?\s*[=:\-]+\s*\d+/i.test(body);
    const roleCountMatches = body.match(/[♦️🔹▪️•\-\d.)]*\s*[A-Za-z][A-Za-z\s&/()]+\s*[:\-=]+\s*\d{1,4}\b/g) || [];
    const hasCompanyMarker = /\*?\s*Company\s*\*?\s*[:\-]/i.test(body);
    const hasTotalManpowerMarker = /\*?\s*Total\s*Manpower\s*\*?\s*[:\-=]/i.test(body);
    const hasPlaceholder = bodyLower.includes("xx/xxx") || /company\s*:\s*xxx\b/i.test(bodyLower);
    const isStandard = hasManpowerKeyword && hasTotalLine && roleCountMatches.length >= 5 && !hasPlaceholder;
    const isSmallTeam = hasCompanyMarker && hasTotalManpowerMarker && roleCountMatches.length >= 2 && !hasPlaceholder;
    if (isStandard || isSmallTeam) {
      console.log(
        `[SANITY CHECK] create_safety_issue has manpower report structure (${roleCountMatches.length} role-count pairs${isSmallTeam ? ", template markers" : ", total line"}) → re-classifying as manpower_data_entry`,
      );
      intentType = "manpower_data_entry";
    }
  }

  // SANITY CHECK: manpower reports misclassified as "others" or "discussion"
  if (intentType === "others" || intentType === "discussion") {
    const body = (typeof message === "object" ? message.body : message) || "";
    const bodyLower = body.toLowerCase();
    const hasManpowerKeyword = bodyLower.includes("manpower");
    const hasTotalLine = /total\s*(manpower|man\s*power|mp)?\s*[=:\-]+\s*\d+/i.test(body);
    const roleCountMatches = body.match(/[♦️🔹▪️•\-\d.)]*\s*[A-Za-z][A-Za-z\s&/()]+\s*[:\-=]+\s*\d{1,4}\b/g) || [];
    const hasCompanyMarker = /\*?\s*Company\s*\*?\s*[:\-]/i.test(body);
    const hasTotalManpowerMarker = /\*?\s*Total\s*Manpower\s*\*?\s*[:\-=]/i.test(body);
    const hasPlaceholder = bodyLower.includes("xx/xxx") || /company\s*:\s*xxx\b/i.test(bodyLower);
    const isStandard = hasManpowerKeyword && hasTotalLine && roleCountMatches.length >= 5 && !hasPlaceholder;
    const isSmallTeam = hasCompanyMarker && hasTotalManpowerMarker && roleCountMatches.length >= 2 && !hasPlaceholder;
    if (isStandard || isSmallTeam) {
      console.log(
        `[SANITY CHECK] Message has manpower report structure but classified as "${intentType}" → re-classifying as manpower_data_entry`,
      );
      intentType = "manpower_data_entry";
    }
  }

  // SANITY CHECK: piling progress report misclassified as create_safety_issue, others, or discussion
  // A message with 3+ "(completed X/total Y)" patterns + numbered sections is NEVER a safety issue
  // ONLY re-classify if message is from the designated piling group
  if (intentType !== "piling_progress_report" && PILING_GROUP_ID && pilingChatId === PILING_GROUP_ID) {
    const pilingCheckBody = (typeof message === "object" ? message.body : message) || "";
    const pilingCheckType = typeof message === "object" ? message.type : "chat";
    if (pilingCheckType === "chat" && pilingCheckBody.trim().length >= 50) {
      const completionMatches = pilingCheckBody.match(/\b(?:complet(?:ed?|e))\s*\d+\s*[\/]\s*(?:total\s*)?\d+/gi) || [];
      const numberedSections = pilingCheckBody.match(/^\s*\d+\s*\.\s*/gm) || [];
      if (completionMatches.length >= 3 && numberedSections.length >= 2) {
        console.log(
          `[SANITY CHECK] Message has piling report structure (${completionMatches.length} completion counts) but classified as "${intentType}" → re-classifying as piling_progress_report`,
        );
        intentType = "piling_progress_report";
      }
    }
  }

  // SANITY CHECK: piling_progress_report must be chat type AND from the designated piling group
  if (intentType === "piling_progress_report") {
    const pilingMsgType = typeof message === "object" ? message.type : "chat";
    if (pilingMsgType !== "chat" || !PILING_GROUP_ID || pilingChatId !== PILING_GROUP_ID) {
      console.log(
        `[SANITY CHECK] piling_progress_report rejected — type="${pilingMsgType}", group="${pilingChatId}", expected="${PILING_GROUP_ID}" → re-classifying as others`,
      );
      intentType = "others";
    }
  }

  // SANITY CHECK: IM progress report misclassified — re-classify if IM patterns detected from IM group
  if (intentType !== "im_progress_report" && IM_GROUP_ID && imChatId === IM_GROUP_ID) {
    const imCheckBody = (typeof message === "object" ? message.body : message) || "";
    const imCheckType = typeof message === "object" ? message.type : "chat";
    if (imCheckType === "chat" && imCheckBody.trim().length >= 20) {
      const instrumentCountMatches = imCheckBody.match(/[A-Z]{1,4}\s*-\s*\d+\s*\/\s*\d+/g) || [];
      const hasRig = /\brig\s*\d+/i.test(imCheckBody);
      const hasInstrumentId = /\b[A-Z]{1,4}\d{3,}/i.test(imCheckBody);
      const hasDate = /\b\d{1,2}\s*[\/\-]\s*\d{1,2}\s*[\/\-]\s*\d{2,4}\b/.test(imCheckBody);

      if (instrumentCountMatches.length >= 3 || (hasRig && hasInstrumentId && hasDate)) {
        console.log(
          `[SANITY CHECK] Message has IM report structure but classified as "${intentType}" → re-classifying as im_progress_report`,
        );
        intentType = "im_progress_report";
      }
    }
  }

  // SANITY CHECK: im_progress_report must be chat type AND from the designated IM group
  if (intentType === "im_progress_report") {
    const imMsgType = typeof message === "object" ? message.type : "chat";
    if (imMsgType !== "chat" || !IM_GROUP_ID || imChatId !== IM_GROUP_ID) {
      console.log(
        `[SANITY CHECK] im_progress_report rejected — type="${imMsgType}", group="${imChatId}", expected="${IM_GROUP_ID}" → re-classifying as others`,
      );
      intentType = "others";
    }
  }

  // Safety-issue creation requires BOTH an image AND text (caption or body).
  // Image-only messages (no text) and text-only messages (no image) are both
  // rejected — partial submissions don't carry enough context to file a safety
  // issue and were a source of low-quality / accidental records.
  if (intentType === "create_safety_issue") {
    const hasImage = Boolean(mediaUrl);
    const hasText = Boolean((caption || messageBody || "").toString().trim());
    if (!hasImage || !hasText) {
      console.log(
        `⚠️ [CREATE SKIP] Safety issue requires BOTH image and text. hasImage=${hasImage}, hasText=${hasText}. Skipping.`,
      );
      return null;
    }
  }

  const intentHandlers = {
    create_safety_issue: async () => await createSafetyIssue(message, mediaUrl, caption, senderDetails, groupConfig),
    update_safety_issue: async () => await updateSafetyIssues(message, mediaUrl, caption, senderDetails, groupConfig),
    // wbgt_reading_entry: Commented out - WBGT now triggered by API (/wbgt-reading), not WhatsApp messages
    // wbgt_reading_entry: async () => await createWBGTReading(message, mediaUrl, caption, senderDetails, groupConfig),
    water_parade_entry: async () => {
      console.log(`💧 [WATER PARADE] Routing water parade message to WBGT sheet`);
      return await handleWaterParade(message, mediaUrl, caption, senderDetails, groupConfig);
    },
    manpower_data_entry: async () => await createManpowerData(message, senderDetails, groupConfig),
    wohhup_manpower_data_entry: async () => await createWohhupManpowerData(message, senderDetails, groupConfig),
    piling_progress_report: async () => {
      console.log(`🏗️ [PILING] Processing piling progress report`);
      const result = await processProgressReport(message);
      console.log(`🏗️ [PILING] Wrote ${result.rowCount} rows for ${result.reportDate}`);
      return result;
    },
    im_progress_report: async () => {
      console.log(`📐 [IM] Processing IM progress report`);
      const result = await processIMReport(message);
      console.log(`📐 [IM] Wrote ${result.rowCount} rows for ${result.reportDate} (${result.recordType})`);
      return result;
    },
    pile_cap_update: async () => {
      console.log(`🧱 [PILE CAP] Processing CJ pile cap update`);
      let processPileCapMessage;
      try {
        ({ processPileCapMessage } = require("../pile_cap/index"));
      } catch (e) {
        return { processed: false, reason: "pile_cap usecase not shipped in base template" };
      }
      const result = await processPileCapMessage(message, groupConfig);
      if (result.processed) {
        console.log(`🧱 [PILE CAP] Wrote ${result.rowCount} rows for ${result.reportDate}`);
      } else {
        console.log(`🧱 [PILE CAP] Skipped: ${result.reason}`);
      }
      return result;
    },
    clone_safety_issue: async () => {
      console.log(`🔄 [CLONE] Processing "Same" reply to clone safety issue`);

      // Get the quoted message ID
      const quotedMessageId = typeof message === "object" ? message.quotedMessageId : null;

      if (!quotedMessageId) {
        console.log(`⚠️ [CLONE] No quotedMessageId found. Ignoring.`);
        return null;
      }

      // Check if the quoted message exists as a safety issue in the sheet
      const existingIssue = await findExistingSafetyIssueRow({ messageId: quotedMessageId }, groupConfig);

      if (!existingIssue) {
        console.log(`ℹ️ [CLONE] Quoted message is not an existing safety issue. Ignoring.`);
        return null;
      }

      // Clone the safety issue
      console.log(`✅ [CLONE] Found existing issue #${existingIssue["S/N"]}. Cloning...`);
      return await cloneSafetyIssue(existingIssue, senderDetails, groupConfig);
    },
    discussion: async () => {
      console.log(`Message classified as "discussion" - no action taken:`, messageBody);
      return null;
    },
    others: async () => {
      console.log(`No intent detected:`, intentType);
      return null;
    },
  };

  const handler = intentHandlers[intentType];
  if (!handler) {
    console.log(
      `⚠️ [HANDLER MISS] intentType="${intentType}" (length=${intentType?.length}) not found in intentHandlers. Available keys:`,
      Object.keys(intentHandlers),
    );
  }
  return await (handler || intentHandlers.others)();
}

/**
 * Classifies the intent of a message
 * @param {object} message - The message object to classify
 * @returns {Promise<string>} - The intent type
 */
async function classifyMessageIntent(message, mediaUrl) {
  let messageBody = typeof message === "object" ? message.body : message;
  let originalMessageBody = null;

  // SPECIAL CASE: "Same" reply detection for cloning safety issues
  // Check if message is exactly "same" (case-insensitive) and has quotedMessageId
  if (typeof message === "object" && message.quotedMessageId) {
    const trimmedBody = String(messageBody || "")
      .trim()
      .toLowerCase();
    if (trimmedBody === "same") {
      console.log(`🔄 [CLONE DETECTION] "Same" reply detected for quotedMessageId: ${message.quotedMessageId}`);
      return "clone_safety_issue";
    }
  }

  // =============================================================================
  // COMMENTED OUT: Thermometer detection for WBGT
  // WBGT is now triggered by API (/wbgt-reading), not WhatsApp messages
  // =============================================================================
  /*
  // NEW LOGIC: Detect thermometer in image-only messages (no caption, no quotedMessageId)
  // This allows users to send just a thermometer image without any text
  if (typeof message === 'object' && message.type === 'image' && !messageBody && !message.quotedMessageId) {
    console.log('📸 [IMAGE-ONLY WBGT CHECK] Checking if image contains thermometer...');

    if (mediaUrl) {
      const isThermometer = await detectThermometerInImage(mediaUrl);

      if (isThermometer) {
        console.log('🌡️ [THERMOMETER DETECTED] Classifying as wbgt_reading_entry');
        return 'wbgt_reading_entry';
      } else {
        console.log('📸 [NOT THERMOMETER] Image does not contain thermometer, will classify as others');
        // Continue with normal classification flow
      }
    }
  }
  */
  // END OF COMMENTED OUT thermometer detection
  // =============================================================================

  // Check if this is a reply message (has quotedMessageId)
  if (typeof message === "object" && message.quotedMessageId) {
    console.log(`Message has quotedMessageId: ${message.quotedMessageId}. Looking up original message...`);

    try {
      // Query Supabase to find the original message
      const { data: originalMessages, error } = await getSupabaseClient()
        .from("whatsapp_listener")
        .select("*")
        .eq("from", message.from) // Match the same group
        .eq("messageId", message.quotedMessageId) // Match the quoted message ID
        .order("created_at", { ascending: false }) // Get the most recent if there are duplicates
        .limit(1);

      if (error) {
        console.error("Error fetching original message:", error);
      } else if (originalMessages && originalMessages.length > 0) {
        originalMessageBody = originalMessages[0].body;
        console.log(
          `Found original message: "${originalMessageBody.substring(0, 50)}${
            originalMessageBody.length > 50 ? "..." : ""
          }"`,
        );
      } else {
        console.log(`No original message found for quotedMessageId: ${message.quotedMessageId}`);
      }
    } catch (err) {
      console.error("Unexpected error looking up original message:", err);
    }
  }
  const tools = [
    {
      type: "function",
      name: "classify_intent",
      parameters: {
        type: "object",
        properties: {
          intentType: {
            type: "string",
            enum: [
              "create_safety_issue",
              "update_safety_issue",
              "manpower_data_entry",
              "piling_progress_report",
              "im_progress_report",
              "pile_cap_update",
              "wbgt_reading_entry",
              "water_parade_entry",
              "discussion",
              "others",
            ],
            description: "The type of the message intent",
          },
        },
        required: ["intentType"],
      },
    },
  ];

  const input = [
    {
      role: "system",
      content: intentClassificationPrompt,
    },
    {
      role: "user",
      content: originalMessageBody
        ? mediaUrl
          ? [
              {
                type: "input_text",
                text: `ORIGINAL MESSAGE: "${originalMessageBody}"\n\nREPLY MESSAGE: "${
                  messageBody || "(no text, image only)"
                }"\n\nREPLY IMAGE: See attached image\n\nPlease classify the intent of this message pair, focusing on the REPLY message and its relationship to the original message. Note that replies with images (even without text) can indicate issue resolution if the image shows the problem has been fixed.`,
              },
              {
                type: "input_image",
                image_url: mediaUrl,
              },
            ]
          : `ORIGINAL MESSAGE: "${originalMessageBody}"\n\nREPLY MESSAGE: "${messageBody}"\n\nPlease classify the intent of this message pair, focusing on the REPLY message and its relationship to the original message.`
        : mediaUrl
          ? [
              {
                type: "input_text",
                text: `MESSAGE: "${
                  messageBody || "(no text, image only)"
                }"\n\nIMAGE: See attached image\n\nPlease classify the intent of this message.`,
              },
              {
                type: "input_image",
                image_url: mediaUrl,
              },
            ]
          : messageBody,
    },
  ];

  try {
    const response = await withOpenAIRetry(
      async () => {
        return await getOpenAI().responses.create({
          model: "gpt-4.1",
          temperature: 0,
          input,
          tools,
          store: true,
          metadata,
        });
      },
      `classifyMessageIntent(${typeof message === "object" ? message.sender : "unknown"})`,
    );

    if (response.output && response.output.length > 0) {
      for (const toolCall of response.output) {
        if (toolCall.type === "function_call" && toolCall.name === "classify_intent") {
          const args = JSON.parse(toolCall.arguments);
          return args.intentType;
        }
      }
    }

    return "others";
  } catch (error) {
    console.error("Error in classifyMessageIntent:", error);
    return "others";
  }
}

/**
 * LLM Auditor: Reviews a classification result and determines if reclassification is needed.
 * Uses construction domain knowledge to catch false negatives (safety messages wrongly classified as "others"/"discussion").
 * @param {object} message - The original message object
 * @param {string} mediaUrl - URL of the image (if any)
 * @param {string} classifiedIntent - The intent returned by the classifier
 * @param {string} messageBody - The message text
 * @returns {Promise<{shouldReclassify: boolean, suggestedIntent?: string, correctionMessage?: string}>}
 */
async function auditClassification(message, mediaUrl, classifiedIntent, messageBody) {
  try {
    const messageType = mediaUrl ? "image + text" : "text only";
    const hasQuotedId = typeof message === "object" && !!message.quotedMessageId;

    const auditDescription = `MESSAGE TEXT: "${messageBody || "(no text)"}"\nMESSAGE TYPE: ${messageType}\nHAS QUOTED MESSAGE (reply): ${hasQuotedId}\nCURRENT CLASSIFICATION: "${classifiedIntent}"`;

    const userContent = mediaUrl
      ? [
          {
            type: "input_text",
            text: auditDescription,
          },
          {
            type: "input_image",
            image_url: mediaUrl,
          },
        ]
      : auditDescription;

    const input = [
      {
        role: "system",
        content: intentAuditPrompt,
      },
      {
        role: "user",
        content: userContent,
      },
    ];

    const response = await withOpenAIRetry(async () => {
      return await getOpenAI().responses.create({
        model: "gpt-4.1",
        temperature: 0,
        input,
        tools: auditorTools,
        store: true,
        metadata,
      });
    }, `auditClassification(${classifiedIntent})`);

    if (response.output && response.output.length > 0) {
      for (const toolCall of response.output) {
        if (toolCall.type === "function_call" && toolCall.name === "audit_classification") {
          const args = JSON.parse(toolCall.arguments);
          console.log(
            `🔍 [AUDITOR] Result: isCorrect=${args.isCorrect}, confidence=${args.confidence}, reasoning="${args.reasoning}"`,
          );

          // Double guard: both prompt AND code enforce confidence >= 85
          if (!args.isCorrect && args.confidence >= 85 && args.suggestedIntent && args.correctionMessage) {
            return {
              shouldReclassify: true,
              suggestedIntent: args.suggestedIntent,
              correctionMessage: args.correctionMessage,
            };
          }

          return { shouldReclassify: false };
        }
      }
    }

    return { shouldReclassify: false };
  } catch (error) {
    // Error resilience: never block the pipeline
    console.error("⚠️ [AUDITOR ERROR] Audit failed, continuing with original classification:", error.message);
    return { shouldReclassify: false };
  }
}

/**
 * Re-classifies a message with additional correction context from the auditor.
 * Nearly identical to classifyMessageIntent but prepends correction context to the user message.
 * Does NOT handle "same" reply heuristic or quotedMessageId lookup (those already ran in the first call).
 * @param {object} message - The original message object
 * @param {string} mediaUrl - URL of the image (if any)
 * @param {string} correctionContext - The auditor's correction context explaining why the original classification was wrong
 * @returns {Promise<string>} - The reclassified intent type
 */
async function classifyMessageIntentWithContext(message, mediaUrl, correctionContext) {
  const messageBody = typeof message === "object" ? message.body : message;

  const tools = [
    {
      type: "function",
      name: "classify_intent",
      parameters: {
        type: "object",
        properties: {
          intentType: {
            type: "string",
            enum: [
              "create_safety_issue",
              "update_safety_issue",
              "manpower_data_entry",
              "piling_progress_report",
              "im_progress_report",
              "pile_cap_update",
              "wbgt_reading_entry",
              "water_parade_entry",
              "discussion",
              "others",
            ],
            description: "The type of the message intent",
          },
        },
        required: ["intentType"],
      },
    },
  ];

  // Build user content with correction context prepended
  const correctionPrefix = `⚠️ CORRECTION CONTEXT FROM SAFETY AUDITOR:\n${correctionContext}\n\nPlease re-classify this message considering the auditor's feedback above.\n\n`;

  const userContent = mediaUrl
    ? [
        {
          type: "input_text",
          text: `${correctionPrefix}MESSAGE: "${messageBody || "(no text, image only)"}"\n\nIMAGE: See attached image\n\nPlease classify the intent of this message.`,
        },
        {
          type: "input_image",
          image_url: mediaUrl,
        },
      ]
    : `${correctionPrefix}MESSAGE: "${messageBody}"\n\nPlease classify the intent of this message.`;

  const input = [
    {
      role: "system",
      content: intentClassificationPrompt,
    },
    {
      role: "user",
      content: userContent,
    },
  ];

  try {
    const response = await withOpenAIRetry(
      async () => {
        return await getOpenAI().responses.create({
          model: "gpt-4.1",
          temperature: 0,
          input,
          tools,
          store: true,
          metadata,
        });
      },
      `classifyMessageIntentWithContext(${typeof message === "object" ? message.sender : "unknown"})`,
    );

    if (response.output && response.output.length > 0) {
      for (const toolCall of response.output) {
        if (toolCall.type === "function_call" && toolCall.name === "classify_intent") {
          const args = JSON.parse(toolCall.arguments);
          return args.intentType;
        }
      }
    }

    return "others";
  } catch (error) {
    console.error("Error in classifyMessageIntentWithContext:", error);
    return "others";
  }
}

module.exports = {
  processMessageAgent,
  classifyMessageIntent,
  detectThermometerInImage,
  auditClassification,
  classifyMessageIntentWithContext,
};
