import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { requireProductWorkspaceForApi } from "@/lib/industry-guard";
import { readBoundedJson } from "@/lib/product-attributes";
import { previewProductPublication, publicationStores, queueProductPublication, type PublicationPreview } from "@/lib/integrations/product-publication-service";
import { getAccessibleConnection, listAccessibleConnections } from "@/lib/integrations/connection-access";
import { withTenantTransaction } from "@/lib/db";

export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryView);
  if (error) return error;
  const access = await requirePermission(PERMISSIONS.integrationsManage);
  if (access.error) return access.error;
  const industryError = await requireProductWorkspaceForApi(session);
  if (industryError) return industryError;
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ stores: [] });
  const allowed = new Set((await listAccessibleConnections(session)).map(c => c.id));
  return NextResponse.json({ stores: (await publicationStores(session.businessId, location.id)).filter(c => allowed.has(c.id)) });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
  if (error) return error;
  const access = await requirePermission(PERMISSIONS.integrationsManage);
  if (access.error) return access.error;
  const industryError = await requireProductWorkspaceForApi(session);
  if (industryError) return industryError;
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  const parsed = await readBoundedJson(request, 16_384);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const body = parsed.value as Record<string, unknown> | null;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!body || typeof body.localId !== "string" || !uuid.test(body.localId) || !Array.isArray(body.stores) || body.stores.length < 1 || body.stores.length > 20) return NextResponse.json({ error: "invalid_publication_selection" }, { status: 400 });
  try {
    const previews: PublicationPreview[] = [];
    for (const store of body.stores as Record<string, unknown>[]) {
      if (!store || typeof store.connectionId !== "string" || !uuid.test(store.connectionId) || (store.remoteId !== undefined && (typeof store.remoteId !== "string" || !/^[1-9]\d*$/.test(store.remoteId)))) return NextResponse.json({ error: "invalid_publication_selection" }, { status: 400 });
      if (!(await getAccessibleConnection(session, store.connectionId))) return NextResponse.json({ error: "not_found" }, { status: 404 });
      if (store.remoteId && body.stores.length !== 1) return NextResponse.json({ error: "publication_link_one_store" }, { status: 400 });
      const preview = await previewProductPublication(session.businessId, location.id, store.connectionId, body.localId, store.remoteId as string | undefined);
      if (body.confirm === true && preview.reviewToken !== store.reviewToken) return NextResponse.json({ error: "publication_preview_changed" }, { status: 409 });
      previews.push(preview);
    }
    if (body.confirm === true) {
      await withTenantTransaction(session.businessId, async () => {
        for (const preview of previews) await queueProductPublication(session.businessId, preview);
      });
      return NextResponse.json({ ok: true, queued: previews.length }, { status: 202 });
    }
    return NextResponse.json({ previews });
  } catch (error) {
    const message = error instanceof Error ? error.message : "publication_failed";
    if (!message.startsWith("publication_") && !message.startsWith("attribute_") && !message.startsWith("woo_attribute")) throw error;
    return NextResponse.json({ error: message }, { status: 409 });
  }
});
