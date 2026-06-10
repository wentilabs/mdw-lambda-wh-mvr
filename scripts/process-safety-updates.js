#!/usr/bin/env node
/**
 * Script to process historical WhatsApp messages for safety issue updates
 *
 * Usage:
 *   node process-safety-updates.js [options]
 *
 * Options:
 *   --limit N       Process only the first N records (default: process all)
 *   --date DATE     Process records from a specific date (format: DD-MMM-YYYY, e.g., 14-Jul-2025)
 *   --month MONTH   Process records from a specific month (format: MMM or MMMM, e.g., Jul or July)
 *   --from DATE     Process records from this date onwards (format: DD-MMM-YYYY)
 *   --to DATE       Process records until this date (format: DD-MMM-YYYY)
 *   --replies-only  Process only messages that are replies (have quotedMessageId)
 *   --originals     Process only original safety issue reports (no quotedMessageId)
 *   --pairs         Process related message pairs (original + reply) when possible
 *   --help          Show help information
 *
 * Examples:
 *   node process-safety-updates.js --limit 5
 *   node process-safety-updates.js --date 14-Jul-2025 --replies-only
 *   node process-safety-updates.js --month July --limit 20
 *   node process-safety-updates.js --month July --originals
 *   node process-safety-updates.js --from 14-Jul-2025 --to 20-Jul-2025 --pairs
 */

process.env.USE_LOCAL_ENV = "true";
require("dotenv").config();
const { getSupabaseClient } = require("../utils/common");
const { handler: HealthSafetyHandler } = require("../usecases/health_safety/index");
const { parseArgs } = require("util");
const path = require("path");

// Parse command-line arguments
const { values } = parseArgs({
  options: {
    limit: {
      type: "string",
    },
    date: {
      type: "string",
    },
    month: {
      type: "string",
    },
    from: {
      type: "string",
    },
    to: {
      type: "string",
    },
    "replies-only": {
      type: "boolean",
    },
    originals: {
      type: "boolean",
    },
    pairs: {
      type: "boolean",
    },
    after: {
      type: "string",
    },
    "analyze-only": {
      type: "boolean",
    },
    help: {
      type: "boolean",
    },
  },
});

// Show help if requested
if (values.help) {
  console.log(`
Process Historical Safety Update Messages
========================================

This script fetches historical WhatsApp messages from Supabase and processes them
through the health safety handler to test the safety issue update flow.

Usage:
  node process-safety-updates.js [options]

Options:
  --limit N       Process only the first N records (default: process all)
  --date DATE     Process records from a specific date (format: DD-MMM-YYYY, e.g., 14-Jul-2025)
  --month MONTH   Process records from a specific month (format: MMM or MMMM, e.g., Jul or July)
  --from DATE     Process records from this date onwards (format: DD-MMM-YYYY, e.g., 14-Jul-2025)
  --to DATE       Process records until this date (format: DD-MMM-YYYY, e.g., 20-Jul-2025)
  --replies-only  Process only messages that are replies (have quotedMessageId)
  --originals     Process only original safety issue reports (no quotedMessageId)
  --pairs        Process related message pairs (original + reply) when possible
  --after ID      Process only messages created after the record with this messageId
  --analyze-only  Only analyze messages, don't process them through handlers
  --help          Show this help information

Examples:
  node process-safety-updates.js --limit 5
  node process-safety-updates.js --date 14-Jul-2025 --replies-only
  node process-safety-updates.js --month July --limit 20
  node process-safety-updates.js --month July --originals
  node process-safety-updates.js --from 14-Jul-2025 --to 20-Jul-2025 --pairs
  `);
  process.exit(0);
}

/**
 * Processes historical safety update WhatsApp messages from Supabase
 * @param {number} messageLimit - Maximum number of messages to process
 * @param {string} dateFilter - Date to filter messages (format: DD-MMM-YYYY)
 * @param {string} monthFilter - Month to filter messages (format: MMM or MMMM)
 * @param {string} fromDateFilter - From date filter (format: DD-MMM-YYYY)
 * @param {string} toDateFilter - To date filter (format: DD-MMM-YYYY)
 * @param {boolean} repliesOnly - Whether to filter for reply messages only
 * @param {boolean} originalsOnly - Whether to filter for original messages only
 * @param {boolean} processPairs - Whether to process message pairs
 */
async function processSafetyUpdates(
  messageLimit = 10,
  dateFilter = null,
  monthFilter = null,
  fromDateFilter = null,
  toDateFilter = null,
  repliesOnly = false,
  originalsOnly = false,
  processPairs = false,
  afterMessageId = null,
) {
  console.log("\n🚀 Processing Historical WhatsApp Safety Updates from Supabase");
  console.log(
    `📋 Configuration: ${messageLimit ? `Limit: ${messageLimit}` : "No limit"}, ${
      dateFilter
        ? `Date: ${dateFilter}`
        : monthFilter
          ? `Month: ${monthFilter}`
          : fromDateFilter || toDateFilter
            ? `Range: ${fromDateFilter || "earliest"} to ${toDateFilter || "latest"}`
            : "No date filter"
    }, ${
      repliesOnly
        ? "Replies only"
        : originalsOnly
          ? "Original reports only"
          : processPairs
            ? "Message pairs"
            : "All messages"
    }`,
  );

  try {
    // Set up filters
    let startDate, endDate;

    // Apply date range filters if provided (highest priority)
    if (fromDateFilter || toDateFilter) {
      // From date filter
      if (fromDateFilter) {
        const fromDateObj = parseDate(fromDateFilter);
        if (fromDateObj) {
          startDate = new Date(fromDateObj);
          startDate.setHours(0, 0, 0, 0);
        } else {
          console.warn(
            `⚠️ Invalid from-date format: ${fromDateFilter}. Expected format: DD-MMM-YYYY (e.g., 14-Jul-2025)`,
          );
          return;
        }
      }

      // To date filter
      if (toDateFilter) {
        const toDateObj = parseDate(toDateFilter);
        if (toDateObj) {
          endDate = new Date(toDateObj);
          endDate.setHours(23, 59, 59, 999);
        } else {
          console.warn(`⚠️ Invalid to-date format: ${toDateFilter}. Expected format: DD-MMM-YYYY (e.g., 20-Jul-2025)`);
          return;
        }
      }

      console.log(
        `🔍 Filtering messages from ${startDate ? startDate.toISOString() : "earliest"} to ${
          endDate ? endDate.toISOString() : "latest"
        }`,
      );
    }
    // Apply date filter if provided and no date range filters
    else if (dateFilter) {
      const dateObj = parseDate(dateFilter);
      if (dateObj) {
        startDate = new Date(dateObj);
        startDate.setHours(0, 0, 0, 0);

        endDate = new Date(dateObj);
        endDate.setHours(23, 59, 59, 999);

        console.log(`🔍 Filtering messages from ${startDate.toISOString()} to ${endDate.toISOString()}`);
      } else {
        console.warn(`⚠️ Invalid date format: ${dateFilter}. Expected format: DD-MMM-YYYY (e.g., 14-Jul-2025)`);
        return;
      }
    }

    // Apply month filter if provided and no date/range filters
    if (monthFilter && !dateFilter && !fromDateFilter && !toDateFilter) {
      // Skip if date filter is already applied
      const monthObj = parseMonth(monthFilter);
      if (monthObj) {
        startDate = monthObj.startDate;
        endDate = monthObj.endDate;

        console.log(`🔍 Filtering messages for month: ${monthFilter}`);
        console.log(`   From: ${startDate.toISOString()} to ${endDate.toISOString()}`);
      } else {
        console.warn(`⚠️ Invalid month format: ${monthFilter}. Expected format: MMM or MMMM (e.g., Jul or July)`);
        return;
      }
    }

    // CORS headers for testing
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Credentials": true,
      "Access-Control-Allow-Headers": "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token",
      "Access-Control-Allow-Methods": "OPTIONS,POST",
    };

    // Process records with pagination to prevent timeout
    const PAGE_SIZE = 50; // Process 50 records at a time
    let page = 0;
    let processedCount = 0;
    let successCount = 0;
    let errorCount = 0;
    let hasMoreRecords = true;
    let totalRecords = 0;

    // Target chat names for safety updates
    const targetChatGroupIDs = [
      "120363161566699891@g.us", //MVR - Site Matters
      "120363282692763180@g.us", // MVR Safety Internal
      "120363161115223873@g.us", //MVR Sub-con’s Safety group
    ];
    console.log(`🎯 Targeting chat groups: ${targetChatGroupIDs.join(", ")}`);

    // Handle --after filter: look up the record's created_at and use it as startDate
    if (afterMessageId) {
      const { data: afterRecord, error: afterError } = await getSupabaseClient()
        .from("whatsapp_listener")
        .select("created_at")
        .eq("messageId", afterMessageId)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      if (afterError || !afterRecord) {
        console.error(`❌ Could not find record with messageId: ${afterMessageId}`, afterError?.message);
        return;
      }

      startDate = new Date(afterRecord.created_at);
      console.log(
        `📍 --after: Processing records created after ${afterRecord.created_at} (messageId: ${afterMessageId})`,
      );
      // Use gt (greater than) instead of gte — we set startDate and will use .gt() below
    }

    // Prepare for pairs processing mode
    let messageIdToRecordMap = {};
    let pairMappings = [];

    console.log("\n📄 Processing data in pages of", PAGE_SIZE, "records");

    // First, let's count how many total records match our criteria
    let countQuery = getSupabaseClient()
      .from("whatsapp_listener")
      .select("id", { count: "exact" })
      .in("from", targetChatGroupIDs);

    if (repliesOnly) {
      countQuery = countQuery.not("quotedMessageId", "is", null);
    }

    // Apply date filters if provided
    if (startDate) {
      countQuery = afterMessageId
        ? countQuery.gt("created_at", startDate.toISOString())
        : countQuery.gte("created_at", startDate.toISOString());
    }

    if (endDate) {
      countQuery = countQuery.lte("created_at", endDate.toISOString());
    }

    const { count, error: countError } = await countQuery;

    if (countError) {
      console.error("❌ Error counting records:", countError);
    } else {
      totalRecords = count;
      console.log(`📊 Total matching records found: ${totalRecords}`);
    }

    // Normal processing for individual messages
    // Now process the records in pages
    while (hasMoreRecords && (messageLimit === 0 || processedCount < messageLimit)) {
      // Calculate how many records to fetch in this page
      const pageLimit = messageLimit ? Math.min(PAGE_SIZE, messageLimit - processedCount) : PAGE_SIZE;

      console.log(`\n🔄 Fetching page ${page + 1} (${pageLimit} records)...`);

      // Build the query for this page
      let query = getSupabaseClient()
        .from("whatsapp_listener")
        .select("*")
        .in("from", targetChatGroupIDs)
        // .eq("messageId", "ACD42F349AF1ECF85452B9F06C28F588")
        .order("created_at", { ascending: true }); // Sort by oldest first

      // Apply message type filters
      if (repliesOnly) {
        query = query.not("quotedMessageId", "is", null);
        console.log("🔍 Filtering for reply messages only (with quotedMessageId)");
      } else if (originalsOnly) {
        query = query.is("quotedMessageId", null);
        console.log("🔍 Filtering for original messages only (no quotedMessageId)");
      }

      // Apply pagination
      query = query.range(page * PAGE_SIZE, page * PAGE_SIZE + pageLimit - 1);

      // Apply date filters if provided
      if (startDate) {
        query = afterMessageId
          ? query.gt("created_at", startDate.toISOString())
          : query.gte("created_at", startDate.toISOString());
      }

      if (endDate) {
        query = query.lte("created_at", endDate.toISOString());
      }

      // Execute the query
      const { data, error } = await query;

      if (error) {
        console.error(`❌ Error fetching page ${page + 1}:`, error);
        break;
      }

      if (!data || data.length === 0) {
        console.log(`📄 Page ${page + 1}: No more records found.`);
        hasMoreRecords = false;
        break;
      }

      console.log(`📋 Page ${page + 1}: Found ${data.length} messages to process`);
      console.log(`\n===== Processing Messages (Page ${page + 1}) =====`);

      // Process each message in this page
      for (let i = 0; i < data.length; i++) {
        const record = data[i];
        const globalIndex = page * PAGE_SIZE + i + 1;

        // Skip records with no body
        // if (!record.body) {
        //   console.log(`⏭️ Skipping record ${globalIndex}: No message body`);
        //   continue;
        // }

        const IDENTIFIER = process.env.CLIENTIDENTIFIER || "6587842038";

        if (String(record.clientIdentifier) !== IDENTIFIER) {
          console.log("not the right client");
          continue;
        }

        console.log(
          `\n🔄 Processing record ${globalIndex}: "${record.body?.substring(0, 50)}${
            record.body?.length > 50 ? "..." : ""
          }"`,
        );
        console.log(
          `📱 Chat: ${record.from}, ${record.quotedMessageId ? "Has quotedMessageId ✓" : "No quotedMessageId ✗"}`,
        );

        try {
          // Create mock message from the Supabase record
          // Ensure we preserve the original timestamp from the database record
          const mockMessage = {
            chatId: record.chatId,
            from: record.from,
            body: record.body,
            type: record.type || (record.mediaUrl ? "image" : "text"),
            sender: record.sender,
            phoneNumber: record.phoneNumber,
            messageId: record.messageId,
            quotedMessageId: record.quotedMessageId, // Important for safety updates
            timestamp: record.timestamp || record.created_at, // Use created_at as primary timestamp source
            mediaUrl: record.mediaUrl || "",
            mediaFilename: record.mediaFilename,
            isGroup: record.isGroup,
            clientIdentifier: record.clientIdentifier,
            isEdited: record.isEdited,
            isDeleted: record.isDeleted,
            parentMsgKey: record.parentMsgKey,
            chatName: record.chatName,
          };

          // Process through handler
          const result = await HealthSafetyHandler(mockMessage, corsHeaders);
          console.log(`🔍 Handler result:`, JSON.stringify(result, null, 2));

          successCount++;
          console.log(`✅ Successfully processed record ${globalIndex}`);
        } catch (error) {
          console.error(`❌ Error processing record ${globalIndex}:`, error.message);
          errorCount++;
        }

        processedCount++;
      }

      // Check if we've reached the user-specified limit
      if (messageLimit > 0 && processedCount >= messageLimit) {
        console.log(`\n📋 Reached specified limit of ${messageLimit} records.`);
        break;
      }

      // Move to the next page
      page++;

      // If this page had fewer records than PAGE_SIZE, we've reached the end
      if (data.length < pageLimit) {
        hasMoreRecords = false;
        console.log("\n📄 No more records available.");
      }
    }

    console.log("\n📊 FINAL SUMMARY:");
    console.log(`  📋 Total matching records: ${totalRecords}`);
    console.log(`  📋 Records processed: ${processedCount}`);
    console.log(`  ✅ Successful: ${successCount}`);
    console.log(`  ❌ Failed: ${errorCount}`);
  } catch (error) {
    console.error("\n❌ Error in processing safety updates:", error);
    throw error;
  }
}

/**
 * Parses date from string format DD-MMM-YYYY
 * @param {string} dateStr - Date string in format DD-MMM-YYYY
 * @returns {Date|null} - Parsed Date object or null if invalid
 */
function parseDate(dateStr) {
  try {
    // Check for expected format DD-MMM-YYYY (e.g., 14-Jul-2025)
    const regex = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/;
    const match = dateStr.match(regex);

    if (!match) {
      return null;
    }

    const [_, day, month, year] = match;

    // Create date in local timezone
    return new Date(`${month} ${day}, ${year}`);
  } catch (error) {
    console.error("Error parsing date:", error);
    return null;
  }
}

/**
 * Parses month string and returns start and end dates for the month
 * @param {string} monthStr - Month string in format MMM or MMMM (e.g., Jul or July)
 * @returns {Object|null} - Object with startDate and endDate or null if invalid
 */
function parseMonth(monthStr) {
  try {
    const currentYear = new Date().getFullYear();

    // Standardize month name format
    let monthName = monthStr.trim();

    // Handle abbreviated month names (Jan, Feb, etc.)
    const monthMap = {
      jan: 0,
      january: 0,
      feb: 1,
      february: 1,
      mar: 2,
      march: 2,
      apr: 3,
      april: 3,
      may: 4,
      jun: 5,
      june: 5,
      jul: 6,
      july: 6,
      aug: 7,
      august: 7,
      sep: 8,
      september: 8,
      oct: 9,
      october: 9,
      nov: 10,
      november: 10,
      dec: 11,
      december: 11,
    };

    const monthKey = monthName.toLowerCase();
    const monthIndex = monthMap[monthKey];

    if (monthIndex === undefined) {
      return null;
    }

    // Create start date (1st of the month)
    const startDate = new Date(currentYear, monthIndex, 1);
    startDate.setHours(0, 0, 0, 0);

    // Create end date (last day of the month)
    const endDate = new Date(currentYear, monthIndex + 1, 0);
    endDate.setHours(23, 59, 59, 999);

    return { startDate, endDate };
  } catch (error) {
    console.error("Error parsing month:", error);
    return null;
  }
}

// Parse the limit parameter
let limit = parseInt(values.limit) || 0; // Default limit of 0 means no limit
if (limit < 0) {
  console.warn(`⚠️ Invalid limit value: ${values.limit}. Using no limit.`);
  limit = 0;
}

// Check for conflicting mode arguments
if (
  (values["replies-only"] && values["originals"]) ||
  (values["replies-only"] && values["pairs"]) ||
  (values["originals"] && values["pairs"])
) {
  console.error(
    "⚠️ Error: Cannot use multiple message filtering modes together. Please choose only one of: --replies-only, --originals, or --pairs",
  );
  process.exit(1);
}

// Run the function
processSafetyUpdates(
  limit,
  values.date,
  values.month,
  values.from,
  values.to,
  values["replies-only"] || false,
  values["originals"] || false,
  values["pairs"] || false,
  values.after || null,
)
  .then(() => console.log("\n🎉 Processing completed"))
  .catch((err) => console.error("\n💥 Processing failed:", err));
