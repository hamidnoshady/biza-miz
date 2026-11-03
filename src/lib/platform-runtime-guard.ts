/**
 * Issue #1194 — the Central Superadmin realm exists only on the Central runtime.
 *
 * `src/middleware.ts` already answers 404 for `/platform/*` and
 * `/api/platform/*` whenever `DEPLOYMENT_ROLE` resolves to `site`, and the
 * desktop package no longer contains those route modules at all
 * (`scripts/desktop/central-route-exclusions.cjs`). This module is the third,
 * independent layer: the *authorization* path decides the realm is not served,
 * so a site process answers the platform API the same way even when a request
 * reaches a handler directly — a unit test, an internal call, a future router
 * change, or a customer who has patched their own local copy of middleware.
 *
 * Why a plain 404 and not 401/403: the realm does not exist on this deployment.
 * The response must not become an oracle that tells a local tinkerer whether a
 * platform admin row exists in their (customer-controlled) database, and it
 * must match what middleware returns so the two layers are indistinguishable
 * from outside.
 *
 * The rule is deliberately role-based, not cookie-based. A site install signs
 * its own JWT realm secrets, so it can always mint a token that *looks* like a
 * platform session locally; what it cannot change is which deployment role its
 * process is. And Central verifies platform sessions with Central's own
 * secret, so a token minted on a desktop never verifies there — see
 * `src/lib/platform-realm-isolation.test.ts` for both directions of that
 * assertion.
 */
import { NextResponse } from "next/server";
import { deploymentRole, type DeploymentRole } from "./deployment-role";

/** The stable error body middleware uses for this realm on a site runtime. */
export const PLATFORM_REALM_UNAVAILABLE = "deployment_unsupported";

const NO_STORE = { "Cache-Control": "no-store, private, max-age=0" };

/**
 * Pure decision, so the guard is testable without a running Next server or a
 * mutated `process.env`.
 */
export function platformRealmDenialForRole(role: DeploymentRole): NextResponse | null {
  if (role === "central") return null;
  return NextResponse.json(
    { error: PLATFORM_REALM_UNAVAILABLE },
    { status: 404, headers: NO_STORE },
  );
}

/**
 * The guard every Central realm entry point calls before it reads a cookie,
 * a bearer token or the database.
 */
export function platformRealmUnavailable(): NextResponse | null {
  return platformRealmDenialForRole(deploymentRole());
}
