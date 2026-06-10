// Note: dotenv is loaded in index.js handler, secrets come from AWS Secrets Manager
const { createClient } = require("@supabase/supabase-js");

// Simple in-memory cache for Lambda (memory-efficient)
// Only cache a few items to stay within 128MB memory limit
const simpleCache = {
  data: new Map(),
  maxSize: 5, // Only cache 5 most recent queries

  set(key, value, ttlSeconds = 300) {
    const now = Date.now();
    const expiry = now + ttlSeconds * 1000;

    // Clear expired entries first
    this.cleanup();

    // If at max size, remove oldest entry
    if (this.data.size >= this.maxSize) {
      const oldestKey = this.data.keys().next().value;
      this.data.delete(oldestKey);
    }

    this.data.set(key, { value, expiry, created: now });
  },

  get(key) {
    const item = this.data.get(key);
    if (!item) return null;

    if (Date.now() > item.expiry) {
      this.data.delete(key);
      return null;
    }

    return item.value;
  },

  delete(key) {
    return this.data.delete(key);
  },

  cleanup() {
    const now = Date.now();
    for (const [key, item] of this.data.entries()) {
      if (now > item.expiry) {
        this.data.delete(key);
      }
    }
  },

  clear() {
    this.data.clear();
  },

  getStats() {
    return {
      size: this.data.size,
      maxSize: this.maxSize,
      keys: Array.from(this.data.keys()),
    };
  },
};

function createSupabaseClient() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SECRET_KEY;

  // Add client options to improve error handling and timeout behavior
  return createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false },
    global: {
      headers: { "x-client-info": "middleware-lambda-wa-wh-usecase" },
    },
  });
}

// Lazy initialization for Supabase client (for AWS Secrets Manager compatibility)
let supabaseClient = null;

function getSupabaseClient() {
  if (!supabaseClient) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
      throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY are required.");
    }
    supabaseClient = createSupabaseClient();
  }
  return supabaseClient;
}

/**
 * Read noise data from the wohhup schema
 *
 * @param {Object} options - Query options
 * @param {string} options.location - Optional location filter
 * @param {string} options.startTime - Optional start timestamp filter
 * @param {string} options.endTime - Optional end timestamp filter
 * @returns {Promise<Object>} - Supabase response with data and error properties
 */
async function readNoiseData(options = {}) {
  try {
    console.log("Reading noise data with options:", options);

    // Start building the query using dot notation for schema
    let query = getSupabaseClient().schema("wohhup").from("ir2_noise_data_daily").select("*");

    // Apply location filter if provided
    if (options.location) {
      query = query.eq("location", options.location);
    }

    // Apply timestamp filters if provided
    if (options.startTime) {
      query = query.gte("timestamp", options.startTime);
    }

    if (options.endTime) {
      query = query.lte("timestamp", options.endTime);
    }

    // Apply ordering if needed
    if (options.orderBy) {
      query = query.order(options.orderBy, { ascending: options.ascending !== false });
    } else {
      // Default ordering by timestamp
      query = query.order("timestamp", { ascending: true });
    }

    // Apply pagination/limits to prevent excessive data retrieval
    if (options.limit) {
      query = query.limit(options.limit);
    } else {
      // Default safety limit to prevent memory issues
      query = query.limit(10000);
    }

    if (options.offset) {
      query = query.range(options.offset, options.offset + (options.limit || 10000) - 1);
    }

    // Execute the query
    const response = await query;

    if (response.error) {
      console.error("Error reading noise data from Supabase:", response.error);
    } else {
      console.log(`Successfully read ${response.data ? response.data.length : 0} noise data records`);

      // Log a sample of the data if available
      if (response.data && response.data.length > 0) {
        console.log("Sample data length:", response.data.length);
      }
    }

    return response;
  } catch (error) {
    console.error("Unexpected error reading noise data:", error);
    return { data: null, error };
  }
}

/**
 * Get aggregated noise data for analytics (optimized for large datasets)
 * Uses database-level aggregation to avoid memory issues
 *
 * @param {Object} options - Query options
 * @param {string} options.location - Location filter
 * @param {string} options.startTime - Start timestamp filter
 * @param {string} options.endTime - End timestamp filter
 * @param {string} options.aggregationType - Type: 'hourly', 'daily', 'exceedances_count'
 * @returns {Promise<Object>} - Supabase response with aggregated data
 */
async function readNoiseDataAggregated(options = {}) {
  try {
    console.log("Reading aggregated noise data with options:", options);

    const { location, startTime, endTime, aggregationType = "daily" } = options;

    // Build base query
    let query = getSupabaseClient().schema("wohhup").from("ir2_noise_data_daily");

    // Apply filters
    if (location) {
      query = query.eq("location", location);
    }
    if (startTime) {
      query = query.gte("timestamp", startTime);
    }
    if (endTime) {
      query = query.lte("timestamp", endTime);
    }

    // Apply different aggregation strategies
    switch (aggregationType) {
      case "exceedances_count":
        // Count exceedances by location - use sampling for very large datasets
        query = query.select("location, timestamp, Leq5min").order("timestamp", { ascending: true }).limit(50000); // Reasonable limit for exceedance analysis
        break;

      case "daily_stats":
        // For daily statistics, sample data points throughout the day
        query = query.select("timestamp, Leq5min, location").order("timestamp", { ascending: true }).limit(20000); // Sample for statistics
        break;

      case "hourly_patterns":
        // For hourly patterns, we need representative data
        query = query.select("timestamp, Leq5min").order("timestamp", { ascending: true }).limit(15000); // Enough for pattern analysis
        break;

      default:
        // Default to limited raw data
        query = query.select("*").limit(10000);
    }

    const response = await query;

    if (response.error) {
      console.error("Error reading aggregated noise data:", response.error);
    } else {
      console.log(`Successfully read ${response.data?.length || 0} aggregated records (type: ${aggregationType})`);
    }

    return response;
  } catch (error) {
    console.error("Unexpected error reading aggregated noise data:", error);
    return { data: null, error };
  }
}

async function writeSupabase(table, userId, message, current_step_id) {
  const { data: upsertData, error } = await getSupabaseClient()
    .from(table)
    .upsert({ userId, message, current_step_id }, { onConflict: "userId" });
  if (error) {
    console.error("writeSupabase: Error inserting message into Supabase:", error);
  } else {
    console.log("Message successfully inserted into Supabase:", upsertData);
  }
}

async function readAndFilterSupabase(table, filters, columns = "*") {
  try {
    let query = getSupabaseClient().from(table).select(columns);

    // Apply filters dynamically
    filters.forEach(({ column, operator, value }) => {
      if (operator === "in") {
        query = query.in(column, value);
      } else {
        query = query[operator](column, value);
      }
    });

    const { data, error } = await query;

    if (error) {
      console.error("Error reading from Supabase:", error);
      return [];
    }

    return data;
  } catch (error) {
    console.error("Unexpected error:", error);
    return [];
  }
}

/**
 * Cleans up any active Supabase connections to help with process termination
 * Call this before using process.exit() to ensure clean shutdown
 */
async function cleanupSupabaseConnections() {
  try {
    console.log("Cleaning up Supabase connections...");
    // Force close any pending realtime connections
    const client = supabaseClient; // Use cached instance if exists
    if (client && client.realtime) {
      await client.realtime.disconnect();
    }

    // A small delay to allow any pending requests to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    console.log("Supabase connections cleanup complete.");
  } catch (error) {
    console.error("Error cleaning up Supabase connections:", error);
  }
}

/**
 * Get cached query results or execute the query if not cached
 * @param {string} cacheKey - Unique cache key
 * @param {Function} queryFn - Function that returns a Promise with the query results
 * @param {number} ttl - Optional custom TTL in seconds (default 300 = 5 minutes)
 * @returns {Promise<Object>} - Query results
 */
async function getCachedQueryResults(cacheKey, queryFn, ttl = 300) {
  // Clean up expired entries first
  simpleCache.cleanup();

  // Check if we have a cached result
  const cachedResult = simpleCache.get(cacheKey);
  if (cachedResult) {
    console.log(`Cache hit for key: ${cacheKey}`);
    console.log(`Cache stats:`, simpleCache.getStats());
    return cachedResult;
  }

  console.log(`Cache miss for key: ${cacheKey}, executing query`);
  // Execute the query function
  const result = await queryFn();

  // Only cache successful results and if they're not too large
  if (!result.error && result.data) {
    // Estimate result size to avoid memory issues
    const resultSize = JSON.stringify(result).length;
    const maxCacheItemSize = 500000; // 500KB max per cache item

    if (resultSize <= maxCacheItemSize) {
      simpleCache.set(cacheKey, result, ttl);
      console.log(`Cached result (${Math.round(resultSize / 1024)}KB) with TTL ${ttl}s`);
      console.log(`Cache stats:`, simpleCache.getStats());
    } else {
      console.warn(
        `Result too large to cache (${Math.round(resultSize / 1024)}KB > ${Math.round(maxCacheItemSize / 1024)}KB)`,
      );
    }
  }

  return result;
}

/**
 * Clear specific cache entries or all cache
 * @param {string} pattern - Optional key pattern to clear (if null, clears all cache)
 */
function clearQueryCache(pattern = null) {
  if (pattern) {
    const stats = simpleCache.getStats();
    const matchingKeys = stats.keys.filter((key) => key.includes(pattern));
    matchingKeys.forEach((key) => simpleCache.delete(key));
    console.log(`Cleared ${matchingKeys.length} cache entries matching pattern: ${pattern}`);
  } else {
    simpleCache.clear();
    console.log("Cleared entire query cache");
  }
}

/**
 * Get quoted message ID for reply functionality by finding the most recent summary message
 * @param {string} type - Type of summary: 'safety' or 'piling'
 * @param {string} chatId - Optional chat ID to filter by
 * @returns {Promise<string|null>} - Serialized message ID in true_* format or null if not found
 */
async function getQuotedMessageId(type, chatId = null) {
  try {
    console.log(`🔍 [getQuotedMessageId] Searching for most recent ${type} summary message...`);

    const searchPatterns = {
      safety: "%ZRA Project%Safety Issues Summary%",
      piling: "%ZRA Project%Completed Piling Progress Summary%",
    };

    const searchPattern = searchPatterns[type];
    if (!searchPattern) {
      console.error(`❌ [getQuotedMessageId] Invalid type: ${type}. Must be 'safety' or 'piling'`);
      return null;
    }

    let query = getSupabaseClient()
      .from("whatsapp_listener")
      .select("messageIdSerialized, created_at, body, chatId")
      .ilike("body", searchPattern)
      .eq("sender", "Joey")
      .order("created_at", { ascending: false })
      .limit(1);

    // Apply chat filter if provided
    if (chatId) {
      query = query.eq("chatId", chatId);
    }

    const { data, error } = await query.maybeSingle();

    if (error) {
      console.error("❌ [getQuotedMessageId] Database error:", error.message);
      return null;
    }

    if (!data) {
      console.log(`⚠️ [getQuotedMessageId] No ${type} summary message found`);
      return null;
    }

    console.log(`✅ [getQuotedMessageId] Found ${type} summary message:`, {
      messageIdSerialized: data.messageIdSerialized,
      created_at: data.created_at,
      chatId: data.chatId,
    });

    if (data.messageIdSerialized && data.messageIdSerialized.startsWith("false_")) {
      const convertedId = data.messageIdSerialized.replace(/^false_/, "true_");
      console.log(
        `🔄 [getQuotedMessageId] Converted messageIdSerialized: ${data.messageIdSerialized} -> ${convertedId}`,
      );
      return convertedId;
    }

    console.log(
      `ℹ️ [getQuotedMessageId] MessageIdSerialized doesn't match expected format, returning as-is: ${data.messageIdSerialized}`,
    );
    return data.messageIdSerialized;
  } catch (error) {
    console.error("❌ [getQuotedMessageId] Error:", error.message);
    return null;
  }
}

module.exports = {
  createSupabaseClient,
  readAndFilterSupabase,
  readNoiseData,
  readNoiseDataAggregated,
  getSupabaseClient, // Lazy-initialized client for AWS Secrets Manager compatibility
  cleanupSupabaseConnections,
  getCachedQueryResults,
  clearQueryCache,
  simpleCache, // Export for testing and monitoring
  getQuotedMessageId, // Add the new helper function
};
