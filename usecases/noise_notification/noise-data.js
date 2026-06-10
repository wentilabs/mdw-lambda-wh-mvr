// Note: dotenv is loaded in index.js handler, secrets come from AWS Secrets Manager
const { readNoiseData } = require("../../utils/common");
const { convertToSingaporeTime } = require("../../utils/date");
// const { generateMockNoiseData } = require('../../tests/mock-noise-data');

// Flag to use mock data for testing
// const USE_MOCK_DATA = process.env.USE_MOCK_DATA === 'true';

/**
 * Fetch noise data from Supabase for the specified hour, location and optionally a specific date
 *
 * @param {number} hour - The hour to fetch data for (0-23)
 * @param {string} location - The location to filter for
 * @param {Date|null} specificDate - Optional specific date to use (defaults to current date if null)
 * @returns {Array} - Array of noise data readings
 */
async function fetchNoiseData(hour, location, specificDate = null) {
  try {
    if (specificDate) {
      console.log(`Fetching noise data for ${specificDate}, hour ${hour} at location "${location}"`);
    } else {
      console.log(`Fetching noise data for hour ${hour} at location "${location}" (current date)`);
    }

    // Use mock data if enabled
    // if (USE_MOCK_DATA) {
    //   console.log('Using mock noise data for testing');
    //   return generateMockNoiseData(hour, 12, location, specificDate);
    // }

    // Get the date we're working with (either specific date or current date)
    const baseDate = specificDate || new Date();
    console.log(`Base date for query: ${baseDate.toLocaleString()}`);

    let hourStartStr, hourEndStr;

    // Handle the date formatting differently based on whether specificDate is provided
    if (specificDate) {
      // With specificDate, we want to use the exact hour without timezone conversions
      // Format the date as YYYY-MM-DD
      const year = baseDate.getFullYear();
      const month = String(baseDate.getMonth() + 1).padStart(2, "0");
      const day = String(baseDate.getDate()).padStart(2, "0");
      const dateStr = `${year}-${month}-${day}`;

      // Create ISO datetime strings for the specific hour without timezone conversion
      // Format: YYYY-MM-DDThh:mm:ss
      const hourPadded = String(hour).padStart(2, "0");

      // Extract the minutes from the specificDate for the end time
      const minute = baseDate.getMinutes();
      const minutePadded = String(minute).padStart(2, "0");

      hourStartStr = `${dateStr}T${hourPadded}:00:00`;
      hourEndStr = `${dateStr}T${hourPadded}:${minutePadded}:59.999`;

      console.log(`Using exact datetime string without timezone conversion`);
    } else {
      // Current date: always use the SGT datetime string directly (no UTC
      // conversion) — the Supabase table stores SGT wall-clock timestamps.
      const year = baseDate.getFullYear();
      const month = String(baseDate.getMonth() + 1).padStart(2, "0");
      const day = String(baseDate.getDate()).padStart(2, "0");
      const dateStr = `${year}-${month}-${day}`;
      const hourPadded = String(hour).padStart(2, "0");
      const minute = baseDate.getMinutes();
      const minutePadded = String(minute).padStart(2, "0");

      hourStartStr = `${dateStr}T${hourPadded}:00:00`;
      hourEndStr = `${dateStr}T${hourPadded}:59:59.999`;

      console.log(`Using SGT datetime string for query`);
    }

    if (specificDate) {
      // For specific date, just show the exact time strings
      console.log(`Query time range (exact): ${hourStartStr} - ${hourEndStr}`);
    } else {
      // For current date, show both SGT and UTC for clarity
      const hourStart = new Date(baseDate);
      hourStart.setHours(hour, 0, 0, 0);

      const hourEnd = new Date(baseDate);
      hourEnd.setHours(hour, 59, 59, 999);

      console.log(`Query time range (SGT): ${hourStart.toLocaleString()} - ${hourEnd.toLocaleString()}`);
      console.log(`Query time range (SGT): ${hourStartStr} - ${hourEndStr}`);
    }

    // Use the improved readNoiseData function from common.js
    try {
      console.log("Querying Supabase with wohhup schema");

      // Prepare query options
      const queryOptions = {
        location: location,
        startTime: hourStartStr,
        endTime: hourEndStr,
        orderBy: "timestamp",
        ascending: true,
      };

      // Execute the query
      const { data, error } = await readNoiseData(queryOptions);

      if (error) {
        console.error("Error fetching from wohhup schema:", error);
        return [];
      }

      return data || [];
    } catch (error) {
      console.error("Error querying Supabase:", error);
      return [];
    }
  } catch (error) {
    console.error("Unexpected error fetching noise data:", error);
    return [];
  }
}

module.exports = {
  fetchNoiseData,
};
