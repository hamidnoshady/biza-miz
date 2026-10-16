/**
 * Server half of `webauthn-policy.ts` (#854 follow-up F02 / F12): resolve the
 * policy for the *current database role* and this deployment's authority, and
 * turn a "no" into the shared refusal body.
 *
 * Kept out of `webauthn-policy.ts` because reading the deployment profile
 * touches the database, and that module must stay importable from the
 * `"use client"` Profile card.
 */
import { NextResponse } from "next/server";
import type { Role } from "./auth-edge";
import { AUTH_ERROR_CODES, authErrorMessage } from "./auth-contracts";
import { describeCredentialSurface, type CredentialSurface } from "./credential-authority";
import { readDeploymentProfile } from "./deployment-mode";
import { webauthnManagementPolicy, type WebauthnManagementPolicy } from "./webauthn-policy";

export async function resolveWebauthnPolicy(
  businessId: string,
  role: Role,
): Promise<{ policy: WebauthnManagementPolicy; surface: CredentialSurface }> {
  const deployment = await readDeploymentProfile(businessId);
  const surface = describeCredentialSurface(deployment.profile, "webauthn_credential");
  return { policy: webauthnManagementPolicy({ role, surface }), surface };
}

/** The refusal for an action the policy does not allow, or `null` when it does. */
export function webauthnPolicyDenial(
  resolved: { policy: WebauthnManagementPolicy; surface: CredentialSurface },
  action: "register" | "remove",
): NextResponse | null {
  const { policy, surface } = resolved;
  const allowed = action === "register" ? policy.canRegister : policy.canRemove;
  if (allowed) return null;
  if (action === "register" && policy.registerBlockedBy === "role") {
    return NextResponse.json(
      {
        error: AUTH_ERROR_CODES.forbidden,
        message: "ورود بیومتریک فقط برای نقش‌هایی است که با رمز عددی وارد می‌شوند.",
      },
      { status: 403 },
    );
  }
  return NextResponse.json(
    {
      error: AUTH_ERROR_CODES.loginManagedByCloud,
      message: surface.notice ?? authErrorMessage(AUTH_ERROR_CODES.loginManagedByCloud),
    },
    { status: 409 },
  );
}
