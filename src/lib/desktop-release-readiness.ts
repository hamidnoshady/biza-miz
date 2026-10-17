/**
 * Redacted release-pipeline readiness for operators (issue #981). Answers
 * "is Central able to accept and serve a signed Desktop release?" without ever
 * returning a secret: tokens are reported as present/absent only, and the
 * public key as a fingerprint. Pure over its inputs so it is unit-tested; the
 * route supplies the environment and the database facts.
 */
import { createHash, createPublicKey } from "node:crypto";

export type ReadinessStatus = "ok" | "warn" | "fail";

export interface ReadinessCheck {
  id: string;
  status: ReadinessStatus;
  /** Operator-facing, never contains a value taken from the environment. */
  message: string;
  /** Which failure layer this belongs to, so Coolify, GitHub, registry and device faults stay apart. */
  layer: "central_config" | "central_database" | "github_release" | "registration" | "tenant_exposure";
}

export interface ReadinessFacts {
  policyTablesReady: boolean;
  publishedReleaseCount: number;
  lastRegistration: { at: string; version: string } | null;
}

/** Variables that must NEVER be present in the Central container (issue #981 §2). */
export const FORBIDDEN_CENTRAL_ENV = ["DESKTOP_RELEASE_PRIVATE_KEY_PEM", "COOLIFY_API_TOKEN"] as const;

/** Fingerprint of a PEM public key, or null when the value is not a public key. */
export function publicKeyFingerprint(pem: string | undefined): string | null {
  const normalized = pem?.replaceAll("\\n", "\n").trim();
  if (!normalized) return null;
  try {
    const der = createPublicKey(normalized).export({ type: "spki", format: "der" });
    return createHash("sha256").update(der).digest("hex");
  } catch {
    return null;
  }
}

export function evaluateReleaseReadiness(
  env: Record<string, string | undefined>,
  facts: ReadinessFacts,
): { checks: ReadinessCheck[]; ready: boolean; publicKeyFingerprint: string | null } {
  const checks: ReadinessCheck[] = [];
  const add = (check: ReadinessCheck) => checks.push(check);

  const token = env.DESKTOP_RELEASE_PUBLISH_TOKEN?.trim() ?? "";
  add(!token
    ? { id: "publish_token", layer: "central_config", status: "fail", message: "DESKTOP_RELEASE_PUBLISH_TOKEN is not set on Central: the release pipeline cannot register a release." }
    : token.length < 32
      ? { id: "publish_token", layer: "central_config", status: "warn", message: "DESKTOP_RELEASE_PUBLISH_TOKEN is set but shorter than 32 characters; use a long random value." }
      : { id: "publish_token", layer: "central_config", status: "ok", message: "A release publish token is configured." });

  const fingerprint = publicKeyFingerprint(env.DESKTOP_RELEASE_PUBLIC_KEY_PEM);
  add(!env.DESKTOP_RELEASE_PUBLIC_KEY_PEM?.trim()
    ? { id: "public_key", layer: "central_config", status: "fail", message: "DESKTOP_RELEASE_PUBLIC_KEY_PEM is not set: Central cannot verify manifest signatures and refuses registration in production." }
    : fingerprint
      ? { id: "public_key", layer: "central_config", status: "ok", message: "A manifest public key is configured. Compare its fingerprint with the signing pipeline's." }
      : { id: "public_key", layer: "central_config", status: "fail", message: "DESKTOP_RELEASE_PUBLIC_KEY_PEM is set but is not a parseable PEM public key (check multiline handling in Coolify)." });

  for (const name of FORBIDDEN_CENTRAL_ENV) {
    if (env[name]?.trim()) {
      add({ id: `forbidden_${name.toLowerCase()}`, layer: "tenant_exposure", status: "fail", message: `${name} must not exist on Central. Remove it from the Coolify environment and rotate it.` });
    }
  }
  const publicSecrets = Object.keys(env).filter((name) =>
    name.startsWith("NEXT_PUBLIC_") && /DESKTOP_RELEASE|TOKEN|SECRET|PRIVATE/i.test(name) && env[name]?.trim());
  if (publicSecrets.length > 0) {
    add({ id: "public_env_secret", layer: "tenant_exposure", status: "fail", message: `${publicSecrets.length} NEXT_PUBLIC_* variable(s) look like secrets and would ship to every browser: ${publicSecrets.join(", ")}.` });
  }

  add(facts.policyTablesReady
    ? { id: "policy_tables", layer: "central_database", status: "ok", message: "Update policy tables are present (migration 0227 applied)." }
    : { id: "policy_tables", layer: "central_database", status: "fail", message: "Update policy tables are missing: migrations have not completed on this Central instance." });

  add(facts.lastRegistration
    ? { id: "last_registration", layer: "registration", status: "ok", message: `Last pipeline registration: ${facts.lastRegistration.version} at ${facts.lastRegistration.at}.` }
    : { id: "last_registration", layer: "registration", status: "warn", message: "No release has ever been registered by the pipeline on this Central instance." });

  add(facts.publishedReleaseCount > 0
    ? { id: "published_release", layer: "github_release", status: "ok", message: `${facts.publishedReleaseCount} published release(s) in the catalogue.` }
    : { id: "published_release", layer: "github_release", status: "warn", message: "The catalogue has no published release; devices have nothing to be offered." });

  return { checks, ready: checks.every((check) => check.status !== "fail"), publicKeyFingerprint: fingerprint };
}
