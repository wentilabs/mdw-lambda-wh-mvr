// Note: dotenv is loaded in index.js handler, secrets come from AWS Secrets Manager
const OpenAI = require("openai");

let openai = null;

function getOpenAI() {
  if (!openai) {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openai;
}

async function withOpenAIRetry(apiCall, operationName, options = {}) {
  const { maxRetries = 2, logPrefix = "OpenAI" } = options;
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await apiCall();
    } catch (error) {
      lastError = error;
      const status = error?.status || error?.response?.status;
      const isRetryable =
        status === 429 || (status >= 500 && status < 600) || error.code === "ECONNRESET" || error.code === "ETIMEDOUT";
      if (!isRetryable || attempt === maxRetries) throw error;
      const delay = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 8000);
      console.warn(
        `[${logPrefix}] ${operationName} failed (attempt ${attempt + 1}), retrying in ${Math.round(delay)}ms...`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

module.exports = { getOpenAI, withOpenAIRetry };
