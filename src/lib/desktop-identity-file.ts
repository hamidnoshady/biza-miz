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
 * The business this backend serves, read from its own database.
 *
 * `local_cloud_activations` is the install's Cloud enrollment (Full Offline),
 * which is where the non-secret Cloud origin already lives; a paired/Hybrid
 * install leaves it null and the file still names the tenant and subdomain.
 * `ORDER BY … LIMIT 2` is deliberate: one row is a single-business site, two
 * means this database belongs to a server and **no** business may be named.
 */
const STARTUP_IDENTITY_QUERY = `SELECT b.id::text AS business_id,
         b.subdomain::text AS subdomain,
         (SELECT a.cloud_origin FROM local_cloud_activations a WHERE a.business_id = b.id) AS cloud_origin
    FROM businesses b
   WHERE b.ownership_kind <> 'demo'
   ORDER BY b.id
   LIMIT 2`;

type StartupIdentityRow = {
  business_id: string;
  subdomain: string | null;
  cloud_origin: string | null;
};

export type StartupIdentityReason =
  | "published"
  | "not_desktop"
  | "not_site"
  | "no_business"
  | "several_businesses"
  | "read_failed"
  | "invalid_identity"
  | "write_failed";

export interface StartupIdentityResult {
  published: boolean;
  reason: StartupIdentityReason;
}

/**
 * Every business row on a site install, bounded to two so "more than one" is
 * cheap to detect. Loaded through the documented **platform** bypass for the
 * same reason `applyPairingSnapshot` uses it: the tenant is exactly what this
 * install cannot name yet, so there is nothing to scope to. The query returns
 * only the three identity columns above — no tenant data, no secrets.
 */
async function readStartupBusinessRows(): Promise<StartupIdentityRow[]> {
  const { query, withoutTenantScope } = await import("./db");
  const result = await withoutTenantScope("platform", () =>
    query<StartupIdentityRow>(STARTUP_IDENTITY_QUERY),
  );
  return result.rows;
}

/**
 * Publish the identity of the saved business this backend already holds, from
 * its own database, at startup (#1572 follow-up).
 *
 * A profile enrolled before the identity file existed — or a legacy install
 * imported into one — never runs pair/reconnect/bootstrap/signup again, so
 * without this it would stay unnamed until it was re-enrolled. Here the local
 * server names it once per launch, before it answers its first health probe,
 * and the shell picks the file up. Nothing comes from the renderer, and a
 * database that holds more than one business (a Cloud/central server, a shared
 * install) is refused outright rather than guessed at.
 *
 * Best-effort by contract: a failed read or write is reported, never thrown —
 * the backend still has to start.
 */
export async function publishStartupBusinessIdentity(
  options: {
    env?: IdentityEnvironment;
    role?: "central" | "site";
    readRows?: () => Promise<StartupIdentityRow[]>;
    now?: Date;
  } = {},
): Promise<StartupIdentityResult> {
  const env = options.env ?? process.env;
  // No identity path means this is not a desktop backend: don't touch the DB.
  if (!desktopIdentityFilePath(env)) return { published: false, reason: "not_desktop" };
  const role = options.role ?? (await import("./deployment-role")).deploymentRole();
  if (role !== "site") return { published: false, reason: "not_site" };

  let rows: StartupIdentityRow[];
  try {
    rows = await (options.readRows ?? readStartupBusinessRows)();
  } catch {
    return { published: false, reason: "read_failed" };
  }
  if (rows.length === 0) return { published: false, reason: "no_business" };
  if (rows.length > 1) return { published: false, reason: "several_businesses" };

  const [row] = rows;
  const result = publishDesktopBusinessIdentity(
    {
      businessId: row.business_id,
      businessSubdomain: row.subdomain,
      cloudOrigin: row.cloud_origin,
    },
    { env, now: options.now },
  );
  if (result.ok) return { published: true, reason: "published" };
  return { published: false, reason: result.error === "not_desktop" ? "not_desktop" : (result.error ?? "write_failed") };
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
