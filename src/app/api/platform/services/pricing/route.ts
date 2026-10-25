import { NextRequest, NextResponse } from "next/server";
import {
  platformAudit,
  requirePlatformCapability,
  withPlatformScope,
} from "@/lib/platform-auth";
import {
  ServicePriceError,
  publishServicePrice,
} from "@/lib/service-activation/pricing-service";
import { isServiceKey, isServiceKind } from "@/lib/service-activation/catalog";

/**
 * Publish a new per-service price version (issue #1041 §E.1).
 *
 * Writing a price is a commercial decision, so it rides `billing.manage` — the
 * same capability that owns the plan catalogue and rates — and every write is
 * audited with the old and new figures. A published 0 Rial row is the explicit
 * "free" choice; omitting the row keeps the service ineligible (fail closed).
 */
export const POST = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("billing.manage");
  if (error) return error;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const kind = body.kind;
  const key = typeof body.key === "string" ? body.key.trim() : "";
  if (!isServiceKind(kind) || !isServiceKey(kind, key)) {
    return NextResponse.json({ error: "unknown_service" }, { status: 404 });
  }
  const setupMode = body.setupMode;
  if (setupMode !== "fixed" && setupMode !== "hour_equivalent") {
    return NextResponse.json({ error: "invalid_setup_mode" }, { status: 400 });
  }

  try {
    const published = await publishServicePrice({
      kind,
      key,
      setupMode,
      setupFixedRial: Number(body.setupFixedRial ?? 0),
      setupEquivalentHours: Number(body.setupEquivalentHours ?? 0),
      hourlyRateRial: Number(body.hourlyRateRial ?? 0),
      published: body.published !== false,
      effectiveFrom: typeof body.effectiveFrom === "string" ? body.effectiveFrom : undefined,
      note: typeof body.note === "string" ? body.note : null,
      adminId: session.padmin,
    });

    await platformAudit({
      adminId: session.padmin,
      action: "service.price.publish",
      entity: "service_price_schedule",
      entityId: published.id,
      payload: {
        kind,
        key,
        version: published.version,
        setupMode: published.setupMode,
        setupFixedRial: published.setupFixedRial,
        setupEquivalentHours: published.setupEquivalentHours,
        hourlyRateRial: published.hourlyRateRial,
        published: published.published,
        effectiveFrom: published.effectiveFrom,
      },
    });

    return NextResponse.json({ price: published });
  } catch (err) {
    if (err instanceof ServicePriceError) {
      return NextResponse.json({ error: err.code }, { status: 400 });
    }
    throw err;
  }
});
