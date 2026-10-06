import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { getItem, getSerial } from "@/lib/items-service";
import {
  latestPreOwnedIntake,
  PRE_OWNED_SOURCES,
  recordPreOwnedIntake,
  type PreOwnedSource,
} from "@/lib/watch-crm-service";
import { CONDITION_GRADES, type ConditionGrade } from "@/lib/watch";

/**
 * Issue #795 item 18 — the pre-owned intake as a full provenance document:
 * source, party, document, value, date, condition, box & papers,
 * authenticity, service history, year, accessories, notes, media, creator.
 */
async function ownedSerial(sessionBusinessLocationId: string | null, id: string) {
  const serial = await getSerial(id);
  if (!sessionBusinessLocationId || !serial) return null;
  const item = await getItem(serial.itemId);
  if (!item || item.locationId !== sessionBusinessLocationId) return null;
  return serial;
}

export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.inventoryView);
    if (error) return error;
    const industryError = await requireIndustryForApi(session, "watch");
    if (industryError) return industryError;
    const { id } = await context.params;

    const location = await resolveActiveLocation(session);
    const serial = await ownedSerial(location?.id ?? null, id);
    if (!serial) return NextResponse.json({ error: "serial_not_found" }, { status: 404 });

    const intake = await latestPreOwnedIntake(id);
    return NextResponse.json({ intake });
  },
);

export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
    if (error) return error;
    const industryError = await requireIndustryForApi(session, "watch");
    if (industryError) return industryError;
    const { id } = await context.params;

    const location = await resolveActiveLocation(session);
    const serial = await ownedSerial(location?.id ?? null, id);
    if (!serial) return NextResponse.json({ error: "serial_not_found" }, { status: 404 });

    let body: {
      conditionGrade?: string;
      boxAndPapers?: boolean;
      source?: string;
      partyId?: string | null;
      documentNo?: string | null;
      purchaseValueRial?: number;
      intakeDate?: string | null;
      authenticityVerified?: boolean;
      authenticityNotes?: string | null;
      serviceHistory?: string | null;
      productionYear?: number | null;
      accessories?: string | null;
      notes?: string | null;
      media?: string[];
    };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    if (!body.conditionGrade || !(CONDITION_GRADES as string[]).includes(body.conditionGrade)) {
      return NextResponse.json({ error: "invalid_condition_grade" }, { status: 400 });
    }
    if (body.source != null && !(PRE_OWNED_SOURCES as readonly string[]).includes(body.source)) {
      return NextResponse.json({ error: "invalid_source" }, { status: 400 });
    }
    if (body.media != null && (!Array.isArray(body.media) || body.media.some((m) => typeof m !== "string"))) {
      return NextResponse.json({ error: "invalid_media" }, { status: 400 });
    }

    try {
      const intake = await recordPreOwnedIntake({
        businessId: session.businessId,
        serialId: id,
        conditionGrade: body.conditionGrade as ConditionGrade,
        boxAndPapers: Boolean(body.boxAndPapers),
        source: body.source as PreOwnedSource | undefined,
        partyId: body.partyId ?? null,
        documentNo: body.documentNo ?? null,
        purchaseValueRial: body.purchaseValueRial != null ? Number(body.purchaseValueRial) : undefined,
        intakeDate: body.intakeDate ?? null,
        authenticityVerified: Boolean(body.authenticityVerified),
        authenticityNotes: body.authenticityNotes ?? null,
        serviceHistory: body.serviceHistory ?? null,
        productionYear: body.productionYear != null ? Number(body.productionYear) : null,
        accessories: body.accessories ?? null,
        notes: body.notes ?? null,
        media: body.media,
        createdBy: session.sub,
      });
      return NextResponse.json({ ok: true, intake });
    } catch (err) {
      return NextResponse.json({ error: "validation_failed", message: (err as Error).message }, { status: 400 });
    }
  },
);
