import { NextRequest, NextResponse } from "next/server";
import { requireMember, withTenantScope } from "@/lib/auth";
import { requireRecentAuth } from "@/lib/recent-auth";
import {
  issueTelegramLinkChallenge,
  readTelegramConnectionStatus,
  revokeTelegramIdentityLink,
  telegramBusinessAvailability,
} from "@/lib/telegram-service";

function unavailableStatus(error: string): number {
  if (error === "telegram_not_configured") return 503;
  if (error === "telegram_disabled") return 404;
  if (error === "feature_disabled") return 403;
  if (error === "cloud_only" || error === "deployment_unsupported") return 403;
  return 400;
}

export const GET = withTenantScope(async (request: NextRequest) => {
  const guard = await requireMember();
  if (guard.error) return guard.error;
  const { session } = guard;
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const availability = await telegramBusinessAvailability(session.businessId);
  if (!availability.available) {
    return NextResponse.json(
      { available: false, error: availability.error },
      { status: unavailableStatus(availability.error), headers: { "Cache-Control": "no-store" } },
    );
  }
  if (!session.platformUserId) {
    return NextResponse.json({
      available: true,
      identityAvailable: false,
      linked: false,
      linkedAt: null,
      challenge: null,
    }, { headers: { "Cache-Control": "no-store" } });
  }

  const challengeId = request.nextUrl.searchParams.get("challengeId");
  const status = await readTelegramConnectionStatus({
    businessId: session.businessId,
    membershipId: session.sub,
    platformUserId: session.platformUserId,
    challengeId,
  });
  return NextResponse.json(
    { available: true, identityAvailable: true, ...status },
    { headers: { "Cache-Control": "no-store" } },
  );
});

export const POST = withTenantScope(async () => {
  const guard = await requireMember();
  if (guard.error) return guard.error;
  const { session } = guard;
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const recentAuthError = requireRecentAuth(session);
  if (recentAuthError) return recentAuthError;
  const availability = await telegramBusinessAvailability(session.businessId);
  if (!availability.available) {
    return NextResponse.json({ error: availability.error }, { status: unavailableStatus(availability.error) });
  }
  const result = await issueTelegramLinkChallenge(session);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: unavailableStatus(result.error) });
  }
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
});

export const DELETE = withTenantScope(async () => {
  const guard = await requireMember();
  if (guard.error) return guard.error;
  const { session } = guard;
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const recentAuthError = requireRecentAuth(session);
  if (recentAuthError) return recentAuthError;
  const result = await revokeTelegramIdentityLink(session);
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
});
