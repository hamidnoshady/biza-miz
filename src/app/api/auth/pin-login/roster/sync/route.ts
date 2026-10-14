import { NextRequest, NextResponse } from "next/server";
import { withTenant } from "@/lib/db";
import { requestHost } from "@/lib/host";
import { readDeploymentProfile } from "@/lib/deployment-mode";
import { resolveLoginBusinessId } from "@/lib/employee-service";
import { runIamSync } from "@/lib/iam/sync";
import { readHybridIdentityStatus, syncHybridLoginCredentials } from "@/lib/iam/login-credential-sync";

/**
 * «همگام‌سازی دوباره» on the staff login screen, for the partial-Hybrid state
 * this issue is about: the cloud holds PIN staff, the desktop's roster omits
 * them, and the person at the till cannot open Settings because they cannot
 * sign in yet.
 *
 * Session-less by necessity (there is nobody to authenticate) and therefore
 * deliberately narrow:
 *  - it only resolves the business from this origin's host, like the roster;
 *  - it is a no-op unless the deployment is Hybrid and the identity planes are
 *    actually not healthy, so it cannot be used to hammer the cloud;
 *  - it writes nothing but the sync state of its own business, and returns
 *    counts and names — never a credential.
 * It is registered in the middleware's per-IP credential bucket
 * (AUTH_RATE_LIMITED_PATHS), so it shares the same ceiling as the login door
 * beside it.
 */
export async function POST(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const { businessId, error } = await resolveLoginBusinessId({
    businessId: params.get("businessId") ?? undefined,
    businessSlug: params.get("businessSlug") ?? undefined,
    locationId: params.get("locationId") ?? undefined,
    host: requestHost(request.headers),
  });
  if (!businessId) {
    return NextResponse.json({ error: error ?? "unknown_business" }, { status: 400 });
  }
  return withTenant(businessId, async () => {
    const deployment = await readDeploymentProfile(businessId);
    if (deployment.profile !== "hybrid") {
      return NextResponse.json({ error: "not_hybrid" }, { status: 409 });
    }
    const before = await readHybridIdentityStatus(businessId);
    if (!before.configured) {
      return NextResponse.json({ error: "site_not_configured" }, { status: 409 });
    }
    if (before.overall === "healthy" && before.pinGap.missing === 0) {
      // Already converged; nothing to do, and no round trip to spend.
      return NextResponse.json(summary(before));
    }
    // Memberships first (a member may exist on the cloud but not locally at
    // all), then the credential plane explicitly: runIamSync performs it too,
    // but a membership-plane failure must not skip the credential retry —
    // that partial state is exactly what the button exists for.
    await runIamSync(businessId).catch(() => false);
    await syncHybridLoginCredentials(businessId).catch(() => null);
    const after = await readHybridIdentityStatus(businessId);
    return NextResponse.json(summary(after), { status: after.overall === "healthy" ? 200 : 503 });
  });
}

function summary(status: Awaited<ReturnType<typeof readHybridIdentityStatus>>) {
  return {
    overall: status.overall,
    state: status.credentials?.status ?? "pending",
    expected: status.pinGap.expected,
    usable: status.pinGap.usable,
    missing: status.pinGap.missing,
    missingMembers: status.pinGap.missingMembers,
    lastSuccessAt: status.credentials?.lastSuccessAt ?? null,
    lastError: status.credentials?.lastError ?? null,
  };
}
