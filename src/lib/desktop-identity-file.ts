/**
 * The running desktop server's half of naming a saved business profile
 * (#1572 / ESH-223).
 *
 * The first version of this backfill let the renderer report the identity over
 * the Electron bridge. That made any script in the app page able to name a
 * profile: the shell could only check the *shape* of the claim, and because the
 * fields are fill-only a wrong tenant id would have become permanent. The
 * seller that ships with Electron is not the only code that can run in a page
 * on this origin, so the trust boundary was in the wrong place.
 *
 * Now the source of truth is the backend that actually committed the business.
 * When the local server finishes pairing/enrolling/creating a business, it
 * writes this small, non-secret document beside its own configuration:
 *
 *   <profile>/Configuration/business-identity.json
 *
 * The shell reads that file on the next launch, checks it belongs to *this*
 * profile's backend, and only then fills the profile's empty identity columns.
 * The renderer never sees or supplies a tenant id, and a document copied from
 * another profile is refused by the instance fingerprint.
 *
 * What is in it, and what is not: the tenant id, the canonical subdomain and
 * the Cloud origin — the same facts the signed session already carries — plus a
 * SHA-256 fingerprint of the profile's own `instanceId`. The fingerprint is
 * one-way on purpose: it proves the file came from this profile's backend
 * without copying the instance secret (which is the HMAC key behind the
 * `/api/health` identity proof) into a plaintext file.
 *
 * Writing is deliberately best-effort: enrollment has already committed in the
 * database, and a metadata gap must never surface as a failed pairing. The next
 * launch re-reads the file, and every later enrollment rewrites it.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export const BUSINESS_IDENTITY_FILENAME = "business-identity.json";
export const BUSINESS_IDENTITY_FORMAT = "bizamiz-desktop-business-identity";
export const BUSINESS_IDENTITY_VERSION = 1;

/** Lowercase UUID v1–v8, the only shape a tenant id may take. */
const BUSINESS_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Keep in step with electron/profile-registry.js's subdomain rule. */
const SUBDOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_SUBDOMAIN_LENGTH = 63;

/** Just the variables this module reads; `process.env` satisfies it. */
type IdentityEnvironment = Record<string, string | undefined>;

export interface DesktopBusinessIdentity {
  businessId: string;
  businessSubdomain: string | null;
  cloudOrigin: string | null;
}

export interface DesktopBusinessIdentityDocument extends DesktopBusinessIdentity {
  format: string;
  version: number;
  instanceFingerprint: string;
  publishedAt: string;
}

/**
 * One-way proof that a document was written by the backend of a particular
 * profile. `DESKTOP_INSTANCE_ID` is generated per profile by
 * `backend-manager.js` and never leaves the encrypted configuration otherwise.
 */
export function instanceFingerprint(instanceId: string | null | undefined): string | null {
  if (typeof instanceId !== "string" || !instanceId.trim()) return null;
  return createHash("sha256").update(instanceId.trim()).digest("hex");
}

/**
 * Where this backend publishes its identity. Set by `backend-manager.js` to the
 * active profile's `Configuration/` directory; absent (a browser, the Cloud
 * app, an unpackaged dev run) means this whole module is a no-op.
 */
export function desktopIdentityFilePath(env: IdentityEnvironment = process.env): string | null {
  const file = env.DESKTOP_IDENTITY_PATH?.trim();
  if (!file || !path.isAbsolute(file)) return null;
  return file;
}

function normalizeSubdomain(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return undefined;
  const candidate = value.trim().toLowerCase();
  if (!SUBDOMAIN_RE.test(candidate) || candidate.length > MAX_SUBDOMAIN_LENGTH) return undefined;
  return candidate;
}

/** A bare https origin, exactly the shape the registry stores. */
function normalizeCloudOrigin(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return undefined;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) return undefined;
  return url.origin;
}

/** The closed identity shape. Anything unprovable is refused as a whole. */
export function normalizeBusinessIdentity(input: unknown): DesktopBusinessIdentity | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const candidate = input as Record<string, unknown>;
  const businessId = typeof candidate.businessId === "string" ? candidate.businessId.trim() : "";
  if (!BUSINESS_ID_RE.test(businessId)) return null;
  const businessSubdomain = normalizeSubdomain(candidate.businessSubdomain);
  if (businessSubdomain === undefined) return null;
  const cloudOrigin = normalizeCloudOrigin(candidate.cloudOrigin);
  if (cloudOrigin === undefined) return null;
  return { businessId, businessSubdomain, cloudOrigin };
}

/**
 * The full document, or `null` when this runtime cannot prove one: no identity
 * path (not a desktop backend), no instance id, or an identity that does not
 * pass the closed shape. `publishedAt` is the only timestamp, so the shell can
 * tell a stale copy from the one this backend just wrote.
 */
export function buildDesktopIdentityDocument(
  input: DesktopBusinessIdentity,
  env: IdentityEnvironment = process.env,
  now: Date = new Date(),
): DesktopBusinessIdentityDocument | null {
  const fingerprint = instanceFingerprint(env.DESKTOP_INSTANCE_ID);
  if (!fingerprint) return null;
  const identity = normalizeBusinessIdentity(input);
  if (!identity) return null;
  return {
    format: BUSINESS_IDENTITY_FORMAT,
    version: BUSINESS_IDENTITY_VERSION,
    instanceFingerprint: fingerprint,
    ...identity,
    publishedAt: now.toISOString(),
  };
}

export interface PublishIdentityResult {
  ok: boolean;
  path: string | null;
  error?: "not_desktop" | "invalid_identity" | "write_failed";
}

/**
 * Publish the identity the backend just committed, atomically (temp file then
 * rename in the same directory, owner-readable only). Never throws and never
 * fails the caller: enrollment has already succeeded at this point.
 */
export function publishDesktopBusinessIdentity(
  input: DesktopBusinessIdentity,
  options: { env?: IdentityEnvironment; now?: Date } = {},
): PublishIdentityResult {
  const env = options.env ?? process.env;
  const file = desktopIdentityFilePath(env);
  if (!file) return { ok: false, path: null, error: "not_desktop" };
  const document = buildDesktopIdentityDocument(input, env, options.now);
  if (!document) return { ok: false, path: file, error: "invalid_identity" };

  const temporary = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, file);
    return { ok: true, path: file };
  } catch {
    return { ok: false, path: file, error: "write_failed" };
  } finally {
    try {
      rmSync(temporary, { force: true });
    } catch {}
  }
}
