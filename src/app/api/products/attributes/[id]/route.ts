import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireProductWorkspaceForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { isUuid } from "@/lib/uuid";
import { parseAttributeDefinitionInput, readBoundedJson } from "@/lib/product-attributes";
import {
  deleteAttributeDefinition,
  updateAttributeDefinition,
} from "@/lib/product-attributes-service";

function mutationError(error: string, details: Record<string, unknown> = {}) {
  if (error === "not_found") return NextResponse.json({ error }, { status: 404 });
  if (error === "duplicate_name" || error === "version_conflict" || error === "in_use") {
    const code = error === "version_conflict" ? "edit_conflict" : error;
    return NextResponse.json({ error: code, ...details }, { status: 409 });
  }
  return NextResponse.json({ error }, { status: error === "invalid_id" ? 400 : 400 });
}

/** Edits only a definition in the caller's authorized active branch. */
export const PATCH = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
  if (error) return error;
  const industryError = await requireProductWorkspaceForApi(session);
  if (industryError) return industryError;

  const { id } = await context.params;
  if (!isUuid(id)) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  const body = await readBoundedJson(request);
  if (!body.ok) {
    return NextResponse.json({ error: body.error }, { status: body.error === "payload_too_large" ? 413 : 400 });
  }
  const parsed = parseAttributeDefinitionInput(body.value, "patch");
  if (!parsed.ok) {
    return NextResponse.json({ error: "validation_failed", issues: parsed.issues }, { status: 400 });
  }

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const { definition, current, error: updateError } = await updateAttributeDefinition(
    id,
    location.id,
    { ...parsed.data, version: parsed.data.version! },
    session.businessId,
  );
  if (updateError) return mutationError(updateError, { current });
  return NextResponse.json({ ok: true, definition });
});

/**
 * Hard deletion is permitted only while no variant snapshot references the
 * master row. Referenced definitions should be deactivated instead; historical
 * name/value snapshots are never rewritten.
 */
export const DELETE = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
  if (error) return error;
  const industryError = await requireProductWorkspaceForApi(session);
  if (industryError) return industryError;

  const { id } = await context.params;
  if (!isUuid(id)) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const result = await deleteAttributeDefinition(id, location.id, session.businessId);
  if (result.error) return mutationError(result.error, { usageCount: result.usageCount });
  return NextResponse.json({ ok: true });
});
