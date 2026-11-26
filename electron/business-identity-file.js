"use strict";

/**
 * The saved-business identity file a running desktop backend publishes about
 * itself (#1572 follow-up).
 *
 * The shell used to accept a business id from the renderer over an IPC bridge.
 * Any script in the app page could therefore have named a profile, and because
 * the registry's identity columns are fill-only, a wrong tenant id would have
 * become permanent. This module replaces that trust boundary: the local server
 * writes `<profile>/Configuration/business-identity.json` when it commits the
 * business (pairing, reconnect, bootstrap, signup), and the shell reads it on
 * the next launch.
 *
 * Two checks make a foreign document harmless:
 *
 *   - the file must carry the SHA-256 fingerprint of the *running* profile's
 *     own `instanceId` (one-way, so the instance secret stays in the encrypted
 *     config), which refuses a document copied from another profile;
 *   - the identity itself must pass the registry's closed shape, and
 *     `recordProfileIdentity` still refuses a tenant that disagrees with what
 *     the profile already holds.
 *
 * Pure decision logic with an injectable `fs`, like the rest of this module's
 * neighbours: see src/lib/desktop-business-identity-file.test.ts.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { computePaths } = require("./app-paths");
const { normalizeReportedIdentity } = require("./profile-registry");

const BUSINESS_IDENTITY_FILENAME = "business-identity.json";
/** Keep in step with src/lib/desktop-identity-file.ts. */
const IDENTITY_FILE_FORMAT = "bizamiz-desktop-business-identity";
const IDENTITY_FILE_VERSION = 1;

const IDENTITY_FILE_FIELDS = Object.freeze([
  "format",
  "version",
  "instanceFingerprint",
  "businessId",
  "businessSubdomain",
  "cloudOrigin",
  "publishedAt",
]);

const FINGERPRINT_RE = /^[0-9a-f]{64}$/;

/** Where a profile's own backend publishes its identity, inside that profile. */
function businessIdentityPath(profileRoot) {
  return path.join(computePaths(profileRoot).configDir, BUSINESS_IDENTITY_FILENAME);
}

/** Same construction as src/lib/desktop-identity-file.ts's instanceFingerprint. */
function instanceFingerprint(instanceId) {
  if (typeof instanceId !== "string" || !instanceId.trim()) return null;
  return crypto.createHash("sha256").update(instanceId.trim()).digest("hex");
}

/**
 * Validate one parsed document against the fingerprint of the profile being
 * launched. Returns the closed identity shape, or `null` for anything that
 * cannot be proven — an unknown/extra field, a credential-shaped field, a wrong
 * format/version, a missing timestamp, or a document from another profile.
 */
function validateIdentityDocument(raw, expectedFingerprint) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (typeof expectedFingerprint !== "string" || !FINGERPRINT_RE.test(expectedFingerprint)) return null;
  const keys = Object.keys(raw);
  if (keys.length !== IDENTITY_FILE_FIELDS.length) return null;
  for (const key of keys) {
    if (!IDENTITY_FILE_FIELDS.includes(key)) return null;
  }
  if (raw.format !== IDENTITY_FILE_FORMAT || raw.version !== IDENTITY_FILE_VERSION) return null;
  if (typeof raw.instanceFingerprint !== "string" || !FINGERPRINT_RE.test(raw.instanceFingerprint)) return null;
  if (raw.instanceFingerprint !== expectedFingerprint) return null;
  if (typeof raw.publishedAt !== "string" || !raw.publishedAt) return null;
  // The identity columns go through the registry's own closed shape, so the
  // file cannot introduce a credential-shaped key or a non-UUID tenant.
  return normalizeReportedIdentity({
    businessId: raw.businessId,
    businessSubdomain: raw.businessSubdomain,
    cloudOrigin: raw.cloudOrigin,
  });
}

/**
 * Read and validate a profile's identity file. `state` is one of:
 *   - `missing`     — the backend has not published one yet (first run)
 *   - `ok`          — parsed, validated and written by this profile's backend
 *   - `unreadable`  — exists but could not be read
 *   - `invalid`     — parsed, but not a document this build understands
 *   - `foreign`     — a well-formed document from a *different* backend
 * `identity` is set only for `ok`.
 */
function readBusinessIdentityFile(file, expectedFingerprint, fsImpl = fs) {
  let text;
  try {
    if (!fsImpl.existsSync(file)) return { state: "missing", identity: null, file };
    text = fsImpl.readFileSync(file, "utf8");
  } catch {
    return { state: "unreadable", identity: null, file };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { state: "invalid", identity: null, file };
  }
  if (
    typeof expectedFingerprint === "string" && FINGERPRINT_RE.test(expectedFingerprint) &&
    parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
    typeof parsed.instanceFingerprint === "string" && FINGERPRINT_RE.test(parsed.instanceFingerprint) &&
    parsed.instanceFingerprint !== expectedFingerprint
  ) {
    return { state: "foreign", identity: null, file };
  }
  const identity = validateIdentityDocument(parsed, expectedFingerprint);
  if (!identity) return { state: "invalid", identity: null, file };
  return { state: "ok", identity, file };
}

module.exports = {
  BUSINESS_IDENTITY_FILENAME,
  IDENTITY_FILE_FORMAT,
  IDENTITY_FILE_VERSION,
  businessIdentityPath,
  instanceFingerprint,
  validateIdentityDocument,
  readBusinessIdentityFile,
};
