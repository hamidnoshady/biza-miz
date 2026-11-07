import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import type { EntityDefinition } from "@/lib/data-transfer/types";
import { toCsv } from "@/lib/data-transfer/csv";
import {
  applyCatalogue, cataloguePage, catalogueReport, getCatalogueRun, listCatalogueRuns, stageCatalogue,
  CATALOGUE_PROFILE, type CatalogueScope,
} from "@/lib/data-transfer/catalogue-import-service";
import { CATALOGUE_FIELDS, readCatalogueWorkbook, type CatalogueMapping } from "@/lib/data-transfer/catalogue-workbook";
import { catalogueWooReview, catalogueWooStatus } from "@/lib/data-transfer/catalogue-woo-service";
import { listAccessibleConnections, getAccessibleConnection } from "@/lib/integrations/connection-access";
import { publicationStores } from "@/lib/integrations/product-publication-service";
import { approveSafeBatch, cancelRun, decideItem, ReconciliationError } from "@/lib/import-reconciliation/service";
import type { ReconciliationDecision } from "@/lib/import-reconciliation/types";
import { getBusinessIndustry } from "@/lib/industry-guard";
import { isProductWorkspaceIndustry } from "@/lib/product-workspace";
import { resolveActiveLocation } from "@/lib/setup-state";
import { serviceActivationState } from "@/lib/service-activation/app-gate-service";
import { serviceGateBlocks } from "@/lib/service-activation/app-gate";
import { readBoundedJson } from "@/lib/product-attributes";
import { isUuid } from "@/lib/uuid";
import { dataOwner, entityAccess, fileResponse, PERMISSIONS, type DataOwner } from "../guard";

// A reviewed profile uses the same entity gate as generic jobs without
// exposing itself through the generic apply endpoint.
const catalogueEntity: EntityDefinition = {
  key: CATALOGUE_PROFILE, module: "inventory", label: "کاتالوگ محصولات", description: "ورود کاتالوگ با بررسی تطبیق",
  fields: [], importPermission: PERMISSIONS.inventoryAdjust, exportPermission: PERMISSIONS.inventoryView, locationScoped: true,
};

const MAX_WORKBOOK_BYTES = 5 * 1024 * 1024;
const reply = (error: string, status = 400) => NextResponse.json({ error }, { status });

async function catalogueAccess(): Promise<{ scope: CatalogueScope; owner: DataOwner } | NextResponse> {
  const { owner, error } = await dataOwner(PERMISSIONS.dataImport);
  if (error) return error;
  const inventory = await entityAccess(owner, catalogueEntity, "import");
  if (inventory.error) return inventory.error;
  const industry = await getBusinessIndustry(owner.businessId);
  if (industry !== "watch" && !isProductWorkspaceIndustry(industry)) return reply("industry_mismatch", 403);
  if (serviceGateBlocks(await serviceActivationState(owner.businessId, "app", "accounting"))) return reply("service_disabled", 403);
  const location = await resolveActiveLocation(owner.session);
  if (!location) return reply("no_location", 409);
  return { owner, scope: { businessId: owner.businessId, locationId: location.id,
    target: industry === "watch" ? "watch" : "retail", actor: { userId: owner.actorUserId, name: owner.actorName } } };
}

function catalogueError(error: unknown) {
  if (error instanceof ReconciliationError) return NextResponse.json({ error: error.code, ...error.details }, { status: 409 });
  if (error instanceof Error && /^(catalogue_|publication_|attribute_|woo_attribute)/.test(error.message)) return reply(error.message, 409);
  throw error;
}

export const GET = withTenantScope(async (request: NextRequest) => {
  const access = await catalogueAccess();
  if (access instanceof NextResponse) return access;
  const { scope, owner } = access;
  const params = request.nextUrl.searchParams;
  const runId = params.get("run");
  try {
    if (!runId) {
      const permission = await requirePermission(PERMISSIONS.integrationsManage);
      const allowed = permission.error ? [] : await listAccessibleConnections(owner.session);
      const stores = allowed.length ? (await publicationStores(scope.businessId, scope.locationId))
        .filter((store) => allowed.some((connection) => connection.id === store.id)) : [];
      return NextResponse.json({ target: scope.target, fields: CATALOGUE_FIELDS, runs: await listCatalogueRuns(scope), stores });
    }
    if (!isUuid(runId)) return reply("catalogue_run_not_found", 404);
    if (params.has("report")) {
      const report = await catalogueReport(scope, runId);
      return fileResponse(toCsv(
        ["excel_row", "sku", "outcome", "status", "reasons", "warnings", "error"],
        report.map((row) => [row.row_number, row.sku, row.outcome, row.status, row.reasons.join(" | "), row.warnings?.join(" | "), row.error]),
      ), "text/csv; charset=utf-8", "catalogue-review.csv");
    }
    const afterId = Number(params.get("after") ?? 0);
    if (!Number.isSafeInteger(afterId) || afterId < 0) return reply("bad_request");
    return NextResponse.json(await cataloguePage(scope, runId, params.get("search")?.slice(0, 160), afterId));
  } catch (error) { return catalogueError(error); }
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const access = await catalogueAccess();
  if (access instanceof NextResponse) return access;
  const { scope, owner } = access;
  try {
    if (request.headers.get("content-type")?.startsWith("multipart/form-data")) {
      if (Number(request.headers.get("content-length")) > MAX_WORKBOOK_BYTES + 32_768) return reply("file_too_large", 413);
      const form = await request.formData().catch(() => null);
      const file = form?.get("file");
      if (!(file instanceof File) || !file.name.toLowerCase().endsWith(".xlsx")) return reply("unsupported_format", 415);
      if (file.size > MAX_WORKBOOK_BYTES) return reply("file_too_large", 413);
      const sheet = await readCatalogueWorkbook(await file.arrayBuffer()).catch((error: unknown) => {
        if (error instanceof Error && error.message.startsWith("catalogue_")) throw error;
        throw new ReconciliationError("catalogue_invalid_workbook");
      });
      if (form?.get("action") !== "stage") {
        return NextResponse.json({ columns: sheet.columns, suggested: sheet.suggested,
          rows: sheet.rows.length, sample: sheet.rows.slice(0, 3), worksheet: sheet.name });
      }
      const raw = String(form?.get("mapping") ?? "");
      if (raw.length > 2048) return reply("catalogue_invalid_mapping");
      let mapping: CatalogueMapping;
      try {
        mapping = JSON.parse(raw);
        if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) return reply("catalogue_invalid_mapping");
      } catch { return reply("catalogue_invalid_mapping"); }
      const brand = String(form?.get("brand") ?? "").trim();
      if (brand.length > 120) return reply("catalogue_invalid_brand");
      const result = await stageCatalogue(scope, sheet, mapping, file.name, String(form?.get("source") ?? ""), brand);
      return NextResponse.json({ runId: result.run.id });
    }

    const parsed = await readBoundedJson(request, 16_384);
    if (!parsed.ok) return reply(parsed.error);
    if (!parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) return reply("bad_request");
    const body = parsed.value as Record<string, unknown>;
    const runId = typeof body.runId === "string" ? body.runId : "";
    if (!isUuid(runId)) return reply("catalogue_run_not_found", 404);
    await getCatalogueRun(scope, runId);
    const { businessId, actor } = scope;
    if (body.action === "apply") {
      if (body.confirmMetadata !== true) return reply("catalogue_confirmation_required");
      return NextResponse.json(await applyCatalogue(scope, runId));
    }
    if (body.action === "approve_safe") return NextResponse.json(await approveSafeBatch(businessId, runId, actor));
    if (body.action === "cancel") return NextResponse.json(await cancelRun(businessId, runId, actor));
    if (body.action === "decide") {
      const itemId = Number(body.itemId);
      const decision = String(body.decision ?? "");
      if (!Number.isSafeInteger(itemId) || itemId < 1 || !["link", "create_separate", "skip", "keep_for_review"].includes(decision)) return reply("bad_request");
      const canonicalId = typeof body.canonicalId === "string" ? body.canonicalId : undefined;
      if (canonicalId && !isUuid(canonicalId)) return reply("bad_request");
      return NextResponse.json(await decideItem({ businessId, runId, actor, itemId,
        decision: decision as ReconciliationDecision, canonicalId,
        reason: typeof body.reason === "string" ? body.reason.slice(0, 500) : undefined }));
    }
    if (body.action === "woo" || body.action === "woo_status") {
      const permission = await requirePermission(PERMISSIONS.integrationsManage);
      if (permission.error) return permission.error;
      const connectionId = typeof body.connectionId === "string" ? body.connectionId : "";
      if (!isUuid(connectionId)) return reply("publication_connection_unavailable", 404);
      const connection = await getAccessibleConnection(owner.session, connectionId);
      if (!connection) return reply("publication_connection_unavailable", 404);
      if (body.action === "woo_status") return NextResponse.json({ operations: await catalogueWooStatus(scope, runId, connectionId) });
      const itemId = Number(body.itemId);
      const remoteAction = body.remoteAction;
      if (!Number.isSafeInteger(itemId) || itemId < 1 ||
          (remoteAction !== undefined && remoteAction !== "link" && remoteAction !== "link_parent" && remoteAction !== "create" && remoteAction !== "create_parent")) return reply("bad_request");
      return NextResponse.json(await catalogueWooReview(scope, runId, connection, { itemId, action: remoteAction,
        remoteId: typeof body.remoteId === "string" && /^[1-9]\d{0,15}$/.test(body.remoteId) ? body.remoteId : undefined,
        includeTaxonomy: body.includeTaxonomy === true, createTaxonomy: body.createTaxonomy === true,
        reviewToken: typeof body.reviewToken === "string" ? body.reviewToken : undefined }));
    }
    return reply("bad_request");
  } catch (error) { return catalogueError(error); }
});
