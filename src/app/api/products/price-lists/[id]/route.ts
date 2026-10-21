import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireProductWorkspaceForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { deletePriceList, renamePriceList } from "@/lib/price-lists-service";

export const PATCH = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
    if (error) return error;
    const industryError = await requireProductWorkspaceForApi(session);
    if (industryError) return industryError;

    const { id } = await context.params;
    let body: { name?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    const location = await resolveActiveLocation(session);
    if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

    const { list, error: renameError } = await renamePriceList(id, body.name ?? "", location.id);
    if (renameError) {
      const status = renameError === "not_found" ? 404 : renameError === "duplicate_name" ? 409 : 400;
      return NextResponse.json({ error: renameError }, { status });
    }
    return NextResponse.json({ ok: true, list });
  },
);

/** Deleting a list cascades to its entries (price_list_entries ON DELETE CASCADE). */
export const DELETE = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
    if (error) return error;
    const industryError = await requireProductWorkspaceForApi(session);
    if (industryError) return industryError;

    const { id } = await context.params;
    const location = await resolveActiveLocation(session);
    if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

    const deleted = await deletePriceList(id, location.id, {
      businessId: session.businessId,
      actorId: session.sub,
    });
    if (!deleted) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  },
);
