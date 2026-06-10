/**
 * Supabase Storage helpers for the Document Log feature.
 *
 * Wraps the existing supabase JS client (from utils/common.js) with two
 * convenience functions:
 *   - uploadToBucket(bucket, path, buffer, contentType)
 *   - createSignedUrl(bucket, path, ttlSeconds)
 *
 * Bucket name and path layout are documented in docs/document-log-feature.md §4.
 */

const { getSupabaseClient } = require("./common");

const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

/**
 * Upload a file to a Supabase Storage bucket. Replaces if it already exists.
 *
 * @param {string} bucket
 * @param {string} path        e.g. "drafts/<draft_id>/outgoing.pdf"
 * @param {Buffer} buffer
 * @param {string} contentType e.g. "application/pdf"
 * @returns {Promise<{path: string}>}
 */
async function uploadToBucket(bucket, path, buffer, contentType = "application/octet-stream") {
  if (!bucket) throw new Error("uploadToBucket: bucket is required");
  if (!path) throw new Error("uploadToBucket: path is required");
  if (!Buffer.isBuffer(buffer)) throw new Error("uploadToBucket: buffer must be a Buffer");

  const supabase = getSupabaseClient();
  const { data, error } = await supabase.storage.from(bucket).upload(path, buffer, {
    contentType,
    upsert: true, // replace if existing — needed for retries / re-runs
  });
  if (error) {
    throw new Error(`Supabase Storage upload failed (bucket=${bucket}, path=${path}): ${error.message}`);
  }
  return { path: data?.path || path };
}

/**
 * Create a signed URL for a file in Supabase Storage.
 *
 * @param {string} bucket
 * @param {string} path
 * @param {number} ttlSeconds  default 7 days
 * @returns {Promise<string>}  signed URL
 */
async function createSignedUrl(bucket, path, ttlSeconds = DEFAULT_TTL_SECONDS) {
  if (!bucket) throw new Error("createSignedUrl: bucket is required");
  if (!path) throw new Error("createSignedUrl: path is required");

  const supabase = getSupabaseClient();
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, ttlSeconds);
  if (error) {
    throw new Error(`Supabase Storage createSignedUrl failed (bucket=${bucket}, path=${path}): ${error.message}`);
  }
  return data?.signedUrl || data?.signedURL || null;
}

/**
 * Convenience: upload + return signed URL in one call.
 */
async function uploadAndSign(bucket, path, buffer, contentType, ttlSeconds = DEFAULT_TTL_SECONDS) {
  await uploadToBucket(bucket, path, buffer, contentType);
  const url = await createSignedUrl(bucket, path, ttlSeconds);
  return { path, signedUrl: url };
}

/**
 * Idempotently ensure a bucket exists. The bucket should be created via the
 * Supabase Dashboard for safety, but this helper exists for the simulation
 * script. Public-read disabled (signed-URL-only).
 */
async function ensureBucket(bucket) {
  if (!bucket) throw new Error("ensureBucket: bucket is required");
  const supabase = getSupabaseClient();
  const { data: existing } = await supabase.storage.getBucket(bucket);
  if (existing) return { existed: true };
  const { error } = await supabase.storage.createBucket(bucket, { public: false });
  if (error) throw new Error(`Supabase Storage createBucket failed (bucket=${bucket}): ${error.message}`);
  return { existed: false };
}

/**
 * Parse a Supabase Storage signed URL into { bucket, path }.
 * Supports URLs of the form:
 *   https://<host>/storage/v1/object/(sign|public|authenticated)/<bucket>/<path...>?token=...
 *
 * The first path segment after the prefix is the bucket; everything after the
 * next slash (including any sub-path slashes) is the file path. Returns null
 * if the URL doesn't match the Supabase Storage layout.
 *
 * @param {string} url
 * @returns {{bucket: string, path: string} | null}
 */
function parseSupabaseSignedUrl(url) {
  if (!url || typeof url !== "string") return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const m = parsed.pathname.match(/^\/storage\/v1\/object\/(?:sign|public|authenticated)\/([^/]+)\/(.+)$/);
  if (!m) return null;
  return {
    bucket: decodeURIComponent(m[1]),
    path: decodeURIComponent(m[2]),
  };
}

/**
 * Re-sign a (possibly-expired) Supabase Storage signed URL by parsing the
 * bucket+path out of the original URL and asking Supabase for a fresh token.
 *
 * Returns the new signed URL on success, or null if the input URL doesn't look
 * like a Supabase Storage URL we can parse. Throws on Supabase API errors so
 * callers can decide whether to fall back.
 *
 * @param {string} url
 * @param {number} ttlSeconds
 * @returns {Promise<string|null>}
 */
async function refreshSignedUrl(url, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const parsed = parseSupabaseSignedUrl(url);
  if (!parsed) return null;
  return createSignedUrl(parsed.bucket, parsed.path, ttlSeconds);
}

module.exports = {
  uploadToBucket,
  createSignedUrl,
  uploadAndSign,
  ensureBucket,
  parseSupabaseSignedUrl,
  refreshSignedUrl,
  DEFAULT_TTL_SECONDS,
};
