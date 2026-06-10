/**
 * Utility functions for configuration parsing
 */

/**
 * Parse comma-separated group IDs from environment variable
 * @param {string} envVar - The environment variable value
 * @returns {string[]} Array of group IDs
 */
function parseGroupIds(envVar) {
  if (!envVar) return [];
  return envVar
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

module.exports = {
  parseGroupIds,
};
