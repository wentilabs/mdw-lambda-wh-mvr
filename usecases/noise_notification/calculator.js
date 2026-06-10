/**
 * Calculate noise metrics based on Leq5min readings
 *
 * @param {Array} noiseData - Array of noise data readings with Leq5min values
 * @param {number} hour - The current hour (0-23)
 * @param {number} minutes - The current minutes (0-59)
 * @param {string} [location] - Location code (e.g., "NM02") for dynamic limit lookup
 * @param {Date} [date] - Date for day type determination (defaults to current date)
 * @returns {Promise<object>} - Calculated noise metrics
 */
async function calculateNoiseMetrics(noiseData, hour, minutes, location = null, date = null) {
  console.log("Calculating noise metrics with data:", noiseData.length, "records");

  // Store readings with their timestamps
  const readings = [];
  const timestamps = [];

  // Extract Leq5min values from the data, handling different possible field names
  noiseData.forEach((reading) => {
    // The field might be named differently depending on the database schema
    const value = reading.Leq5min || reading.leq5min || reading.leq_5min || reading.leq || reading.value;

    if (value === undefined || value === null) {
      console.log("Warning: Could not find Leq5min value in record:", reading);
      // Still store null for the timestamp mapping
      readings.push(null);
    } else {
      readings.push(parseFloat(value));
    }

    // Store the timestamp regardless of whether the reading is valid
    if (reading.timestamp) {
      timestamps.push(reading.timestamp);
    }
  });

  // Filter out null values for calculations
  const leq5minValues = readings.filter((val) => val !== null);

  // Determine hourly noise limit based on the hour, location, and date
  const hourlyLimit = await getHourlyNoiseLimit(hour, location, date);

  // Calculate current Leq1hr based on available readings
  const currentLeq1hr = calculateLeq1hr(leq5minValues);

  // Determine how many 5-min intervals we have based on actual readings
  // Use the actual count of readings instead of calculating from time
  const intervalsElapsed = leq5minValues.length;
  const intervalsRemaining = 12 - intervalsElapsed;
  console.log(`Using actual reading count for intervals: ${intervalsElapsed} readings available`);

  // Calculate remaining maximum permitted Leq5min to stay below hourly limit
  // Pass the time-based intervals for reference, but calculation will use actual values
  const maxRemainingLeq5min = calculateMaxRemainingLeq5min(
    leq5minValues,
    hourlyLimit,
    intervalsElapsed,
    intervalsRemaining,
  );

  // Determine if we're at a notification point (30 min or 45 min mark)
  const isHalfHourMark = minutes >= 29 && minutes <= 31;
  const isThreeQuarterHourMark = minutes >= 44 && minutes <= 46;
  const notificationTrigger = isHalfHourMark ? "30min" : isThreeQuarterHourMark ? "45min" : null;

  // Get indices of the most recent 5 readings (non-null values)
  const validIndices = [];
  for (let i = readings.length - 1; i >= 0 && validIndices.length < 5; i--) {
    if (readings[i] !== null) {
      validIndices.unshift(i);
    }
  }

  // Get the recent readings and their corresponding timestamps
  const recentReadings = validIndices.map((i) => readings[i]);
  const recentTimestamps = validIndices.map((i) => timestamps[i]);

  console.log("Recent readings indices:", validIndices);
  console.log("Recent readings values:", recentReadings);
  console.log("Recent readings timestamps:", recentTimestamps);

  return {
    hour,
    currentTime: `${hour}:${minutes.toString().padStart(2, "0")}`,
    readingsCount: leq5minValues.length,
    intervalsElapsed,
    intervalsRemaining,
    currentLeq1hr,
    hourlyLimit,
    maxRemainingLeq5min,
    notificationTrigger,
    recentReadings: recentReadings, // Include mapped readings
    timestamps: recentTimestamps, // Include corresponding timestamps
    allReadings: readings, // Include all readings (including nulls)
    allTimestamps: timestamps, // Include all timestamps
  };
}

/**
 * Calculate the Leq1hr value from an array of Leq5min values
 * Using logarithmic average formula for sound levels
 *
 * @param {Array} leq5minValues - Array of Leq5min values
 * @returns {number} - Calculated Leq1hr value
 */
function calculateLeq1hr(leq5minValues) {
  if (!leq5minValues.length) return 0;

  console.log("\n[DEBUG] Leq1hr Calculation:");
  console.log(`- Input values (${leq5minValues.length} readings): [${leq5minValues.join(", ")}]`);

  // Calculate using logarithmic average formula for sound levels:
  // Leq = 10 * log10(1/n * sum(10^(Li/10)))
  const energyValues = leq5minValues.map((val) => Math.pow(10, val / 10));
  console.log(`- Energy values: [${energyValues.map((v) => v.toExponential(2)).join(", ")}]`);

  const sum = energyValues.reduce((acc, val) => acc + val, 0);
  console.log(`- Sum of energy values: ${sum.toExponential(5)}`);

  const average = sum / leq5minValues.length;
  console.log(`- Average energy (sum / ${leq5minValues.length} readings): ${average.toExponential(5)}`);

  const leq1hr = 10 * Math.log10(average);
  console.log(`- Final Leq1hr: 10 * log10(${average.toExponential(5)}) = ${leq1hr.toFixed(1)} dBA`);

  return parseFloat(leq1hr.toFixed(1));
}

/**
 * Calculate the maximum permitted Leq5min for remaining intervals
 * to stay below the hourly limit
 *
 * @param {Array} existingValues - Existing Leq5min values
 * @param {number} hourlyLimit - The hourly noise limit in dBA
 * @param {number} intervalsElapsed - Number of 5-min intervals elapsed
 * @param {number} intervalsRemaining - Number of 5-min intervals remaining
 * @returns {number} - Maximum permitted Leq5min for remaining intervals
 */
function calculateMaxRemainingLeq5min(existingValues, hourlyLimit, intervalsElapsed, intervalsRemaining) {
  if (!existingValues.length || intervalsRemaining <= 0) return hourlyLimit;

  // Always use the actual count of readings for calculations
  const actualIntervalsElapsed = existingValues.length;
  const actualIntervalsRemaining = 12 - actualIntervalsElapsed;

  console.log("\n[DEBUG] Max Remaining Leq5min Calculation:");
  console.log(`- Input values (${existingValues.length} readings): [${existingValues.join(", ")}]`);
  console.log(`- Hourly limit: ${hourlyLimit} dBA`);
  console.log(`- Time-based intervals elapsed: ${intervalsElapsed}`);
  console.log(`- ACTUAL intervals elapsed: ${actualIntervalsElapsed} (based on data count)`);
  console.log(`- ACTUAL intervals remaining: ${actualIntervalsRemaining} (12 - ${actualIntervalsElapsed})`);
  console.log(`- Total intervals in an hour: 12`);

  // Calculate the sum of energy for existing readings
  const energyValues = existingValues.map((val) => Math.pow(10, val / 10));
  console.log(`- Energy values: [${energyValues.map((v) => v.toExponential(2)).join(", ")}]`);

  const existingEnergySum = energyValues.reduce((acc, val) => acc + val, 0);
  console.log(`- Sum of existing energy: ${existingEnergySum.toExponential(5)}`);

  // Calculate the total energy allowed for the hour
  const totalAllowedEnergy = Math.pow(10, hourlyLimit / 10) * 12; // 12 intervals in an hour
  console.log(`- Total allowed energy (hourly limit ${hourlyLimit} dBA): ${totalAllowedEnergy.toExponential(5)}`);

  // Calculate the current average energy per interval - using actual count
  const avgEnergyPerInterval = existingEnergySum / actualIntervalsElapsed;
  console.log(`- Average energy per interval: ${avgEnergyPerInterval.toExponential(5)}`);

  // Calculate current equivalent noise level
  const currentAvgLeq = 10 * Math.log10(avgEnergyPerInterval);
  console.log(`- Current average Leq: ${currentAvgLeq.toFixed(1)} dBA`);

  // Calculate remaining allowed energy
  const remainingAllowedEnergy = totalAllowedEnergy - existingEnergySum;
  console.log(`- Remaining allowed energy: ${remainingAllowedEnergy.toExponential(5)}`);

  // Calculate maximum energy per remaining interval - using actual count
  const maxEnergyPerInterval = remainingAllowedEnergy / actualIntervalsRemaining;
  console.log(`- Max energy per remaining interval: ${maxEnergyPerInterval.toExponential(5)}`);

  // If we have remaining energy (we're below the limit)
  if (maxEnergyPerInterval > 0) {
    const maxRemainingLeq5min = 10 * Math.log10(maxEnergyPerInterval);
    return parseFloat(maxRemainingLeq5min.toFixed(1));
  } else {
    // For negative values, return a small negative value indicating reduction needed
    // Calculate how much the existing average exceeds the limit
    const exceedsByDb = currentAvgLeq - hourlyLimit;

    console.log(`Warning: Hourly limit of ${hourlyLimit} dBA already exceeded by ${exceedsByDb.toFixed(1)} dBA`);

    // Return negative value indicating reduction needed
    return parseFloat((-exceedsByDb).toFixed(1));
  }
}

/**
 * Get hourly noise limit based on the hour, location, and date.
 * Returns the primary applicable limit (LEQ_1hr preferred, LEQ_5min fallback).
 *
 * @param {number} hour - The hour (0-23)
 * @param {string} [location] - Location code (e.g., "NM02")
 * @param {Date} [date] - Date for day type determination
 * @returns {Promise<number>} - The noise limit in dBA
 */
async function getHourlyNoiseLimit(hour, location = null, date = null) {
  const { getNoiseLimit, getDefaultNoiseLimit } = require("./config-loader");

  // If location is provided, try to get dynamic limit
  if (location) {
    try {
      const limit = await getNoiseLimit(location, hour, date);
      console.log(`Using dynamic limit for ${location} at hour ${hour}: ${limit} dBA`);
      return limit;
    } catch (error) {
      console.warn(`Error getting dynamic limit, using defaults: ${error.message}`);
      return getDefaultNoiseLimit(hour);
    }
  }

  // If no location provided, use default limits
  console.log(`No location provided, using default limit for hour ${hour}`);
  return getDefaultNoiseLimit(hour);
}

/**
 * Check individual LEQ_5min readings against a threshold.
 * Used when LEQ_5min limits are applicable (e.g., NM02 all periods, NM01 daytime).
 *
 * @param {number[]} leq5minValues - Array of Leq5min readings
 * @param {number|null} limit - The LEQ_5min limit in dBA, or null if N.A.
 * @returns {{ applicable: boolean, limit: number|null, maxValue: number, exceedanceCount: number, anyExceeded: boolean }}
 */
function checkLeq5minLimits(leq5minValues, limit) {
  if (limit === null || limit === undefined) {
    return { applicable: false, limit: null, maxValue: 0, exceedanceCount: 0, anyExceeded: false };
  }

  if (!leq5minValues || leq5minValues.length === 0) {
    return { applicable: true, limit, maxValue: 0, exceedanceCount: 0, anyExceeded: false };
  }

  const maxValue = Math.max(...leq5minValues);
  const exceedanceCount = leq5minValues.filter((val) => val > limit).length;

  return {
    applicable: true,
    limit,
    maxValue: parseFloat(maxValue.toFixed(1)),
    exceedanceCount,
    anyExceeded: exceedanceCount > 0,
  };
}

/**
 * Get all applicable noise limits for a location/hour/date.
 * Wrapper around config-loader's getNoiseLimitsForMetrics.
 *
 * @param {string} location - Location code
 * @param {number} hour - Hour (0-23)
 * @param {Date} [date] - Date
 * @returns {Promise<{leq_5min: number|null, leq_1hr: number|null, leq_12hr: number|null}>}
 */
async function getHourlyNoiseLimitsForMetrics(location, hour, date = null) {
  const { getNoiseLimitsForMetrics, getDefaultNoiseLimit } = require("./config-loader");

  if (location) {
    try {
      return await getNoiseLimitsForMetrics(location, hour, date);
    } catch (error) {
      console.warn(`Error getting noise limits for metrics, using defaults: ${error.message}`);
      return { leq_5min: null, leq_1hr: getDefaultNoiseLimit(hour), leq_12hr: null };
    }
  }

  return { leq_5min: null, leq_1hr: getDefaultNoiseLimit(hour), leq_12hr: null };
}

module.exports = {
  calculateNoiseMetrics,
  calculateLeq1hr,
  calculateMaxRemainingLeq5min,
  getHourlyNoiseLimit,
  checkLeq5minLimits,
  getHourlyNoiseLimitsForMetrics,
};
