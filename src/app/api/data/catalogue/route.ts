import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { getBusinessIndustry } from "@/lib/industry-guard";
import { isProductWorkspaceIndustry } from "@/lib/product-workspace";
import { resolveActiveLocation } from "@/lib/setup-state";
import { isLocalOnly } from "@/lib/deployment-mode";
import { serviceActivationState } from "@/lib/service-activation/app-gate-service";
import { serviceGateBlocks } from "@/lib/service-activation/app-gate";
import { getAccessibleConnection, listAccessibleConnections } from "@/lib/integrations/connection-access";
import { publicationStores } from "@/lib/integrations/product-publication-service";
import { readBoundedJson } from "@/lib/product-attributes";
import { readCatalogueWorksheet } from "@/lib/data-transfer/codecs";
import { toCsv } from "@/lib/data-transfer/csv";
import { REVIEWED_PRODUCT_CATALOGUE } from "@/lib/data-transfer/registry";
import {
  CATALOGUE_MAX_FILE_BYTES, CATALOGUE_MAX_ROWS, parseCatalogueRows, suggestCatalogueMapping, validateCatalogueMapping,
} from "@/lib/data-transfer/catalogue-profile";
import {
  applyCatalogue, catalogueItems, catalogueRuns, catalogueSummary, reviewCatalogueItem, stageCatalogue, type CatalogueOwner,
} from "@/lib/data-transfer/catalogue-service";
import { catalogueWooStatus, previewCatalogueWoo, queueCatalogueWoo } from "@/lib/data-transfer/catalogue-woo";
import { cancelRun, ReconciliationError } from "@/lib/import-reconciliation/service";
import type { CatalogueRecord } from "@/lib/data-transfer/catalogue-plan";
import { dataOwner, entityAccess, fileResponse, PERMISSIONS } from "../guard";

async function access() {
  const { owner, error } = await dataOwner(PERMISSIONS.dataImport);
  if (error) return { error };
  const inventory = await entityAccess(owner, REVIEWED_PRODUCT_CATALOGUE, "import");
  if (inventory.error) return { error: inventory.error };
  const industry = await getBusinessIndustry(owner.businessId);
  if (industry !== "watch" && !isProductWorkspaceIndustry(industry)) {
    return { error: NextResponse.json({ error: "industry_mismatch" }, { status: 403 }) };
  }
  const location = await resolveActiveLocation(owner.session);
  if (!location) return { error: NextResponse.json({ error: "location_required" }, { status: 409 }) };
  const state = await serviceActivationState(owner.businessId, "app", "accounting");
  if (serviceGateBlocks(state)) return { error: NextResponse.json({ error: "service_disabled" }, { status: 403 }) };
  const catalogue: CatalogueOwner = { businessId: owner.businessId, locationId: location.id,
    actor: { userId: owner.actorUserId, name: owner.actorName }, target: industry === "watch" ? "watch" : "retail" };
  return { catalogue, session: owner.session };
}

function failure(error: unknown) {
  if (error instanceof ReconciliationError) {
    return NextResponse.json({ error: error.code, details: error.details }, { status: error.code.endsWith("_not_found") ? 404 : 409 });
  }
  if (error instanceof Error && /^(catalogue_|publication_|attribute_|woo_attribute)/.test(error.message)) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  throw error;
}

const uuid = z.string().uuid();
const runKey = { runId: uuid };
const itemKey = { ...runKey, itemId: z.number().int().positive().safe() };
const storeKey = { ...itemKey, connectionId: uuid };
const command = z.discriminatedUnion("action", [
  z.object({ action: z.literal("review"), ...itemKey, decision: z.enum(["link", "create_separate", "skip", "keep_for_review"]), canonicalId: uuid.optional() }),
  z.object({ action: z.literal("apply"), ...runKey, confirmMetadataOnly: z.literal(true), approveSafe: z.boolean() }),
  z.object({ action: z.literal("cancel"), ...runKey }),
  z.object({ action: z.literal("woo-preview"), ...storeKey }),
  z.object({ action: z.literal("woo-queue"), ...storeKey, token: z.string().regex(/^[a-f0-9]{64}$/),
    categoryId: z.number().int().positive().safe().optional(), brandId: z.number().int().positive().safe().optional(),
    createMissing: z.boolean(), acceptMirror: z.boolean() }),
]);
const fileOptions = z.object({
  action: z.enum(["analyse", "preview", "stage"]),
  mapping: z.unknown().optional(),
  omax: z.boolean().default(false),
  duplicateRows: z.array(z.number().int().min(2).max(CATALOGUE_MAX_ROWS + 1)).max(CATALOGUE_MAX_ROWS).default([]),
  sourceName: z.string().trim().min(1).max(100).default("catalogue"),
  axis: z.string().trim().max(100).default(""),
});

async function boundedWorkbook(request: Request) {
  if (!request.body || Number(request.headers.get("content-length")) > CATALOGUE_MAX_FILE_BYTES + 65_536) {
    throw new Error("catalogue_file_limit");
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > CATALOGUE_MAX_FILE_BYTES + 65_536) {
        await reader.cancel().catch(() => {});
        throw new Error("catalogue_file_limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const contentType = request.headers.get("content-type")!;
  const form = await new Response(Buffer.concat(chunks, size), { headers: { "Content-Type": contentType } }).formData()
    .catch(() => { throw new Error("catalogue_file_invalid"); });
  const file = form.get("file");
  if (!(file instanceof File) || file.size > CATALOGUE_MAX_FILE_BYTES || !/\.xlsx$/i.test(file.name)) {
    throw new Error("catalogue_file_invalid");
  }
  let rawOptions: unknown;
  try { rawOptions = JSON.parse(String(form.get("options") ?? "{}")); }
  catch { throw new Error("catalogue_mapping_invalid"); }
  const options = fileOptions.safeParse(rawOptions);
  if (!options.success) throw new Error("catalogue_mapping_invalid");
  const bytes = await file.arrayBuffer();
  const sheet = await readCatalogueWorksheet(bytes, CATALOGUE_MAX_ROWS).catch(error => {
    if (error instanceof Error && error.message.startsWith("catalogue_")) throw error;
    throw new Error("catalogue_file_invalid");
  });
  return { options: options.data, sheet, bytes, file };
}

export const GET = withTenantScope(async (request: Request) => {
  const scope = await access();
  if (scope.error) return scope.error;
  const owner = scope.catalogue;
  const params = new URL(request.url).searchParams;
  const runId = params.get("runId");
  try {
    if (!runId) {
      const woo = await requirePermission(PERMISSIONS.woocommerceManage);
      const localOnly = await isLocalOnly(owner.businessId);
      const allowed = woo.error || localOnly ? new Set() : new Set((await listAccessibleConnections(scope.session)).map(c => c.id));
      const stores = allowed.size ? (await publicationStores(owner.businessId, owner.locationId)).filter(c => allowed.has(c.id)) : [];
      return NextResponse.json({ runs: await catalogueRuns(owner), stores, target: owner.target, localOnly });
    }
    if (!uuid.safeParse(runId).success) return NextResponse.json({ error: "bad_request" }, { status: 400 });
    const connectionId = params.get("connectionId");
    if (connectionId) {
      const woo = await requirePermission(PERMISSIONS.woocommerceManage);
      if (woo.error) return woo.error;
      if (!uuid.safeParse(connectionId).success || !(await getAccessibleConnection(scope.session, connectionId))) {
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      }
      return NextResponse.json({ deliveries: await catalogueWooStatus(owner, runId, connectionId) });
    }
    const items = await catalogueItems(owner, runId);
    if (params.get("report") === "csv") {
      const byRow = new Map(items.map(item => [item.rowNumber, item]));
      return fileResponse(toCsv(["row", "sku", "title", "outcome", "status", "issues", "other_rows", "family_parent_row", "error"], items.map(item => {
        const record = item.snapshot as CatalogueRecord;
        const row = record.catalogue;
        const effective = record.familyParentRow ? byRow.get(record.familyParentRow) ?? item : item;
        return [row.number, row.sku, row.title, effective.outcome, effective.status,
          row.issues.map(issue => `${issue.field} ${issue.code}`).join(" | "), row.duplicateRows.join(", "), record.familyParentRow, effective.error];
      })), "text/csv; charset=utf-8", "catalogue-review.csv");
    }
    return NextResponse.json({ ...await catalogueSummary(owner, runId), items });
  } catch (error) {
    return failure(error);
  }
});

export const POST = withTenantScope(async (request: Request) => {
  const scope = await access();
  if (scope.error) return scope.error;
  const owner = scope.catalogue;
  try {
    if (request.headers.get("content-type")?.startsWith("multipart/form-data")) {
      const { options, sheet, bytes, file } = await boundedWorkbook(request);
      if (options.action === "analyse") return NextResponse.json({ columns: sheet.columns, sheet: sheet.name, mapping: suggestCatalogueMapping(sheet.columns) });
      const mapping = validateCatalogueMapping(options.mapping, sheet.columns.length);
      if (options.action === "preview") return NextResponse.json(parseCatalogueRows(sheet, mapping, options.omax));
      return NextResponse.json({ runId: await stageCatalogue(owner, {
        ...options, mapping, sheet, fileName: file.name.slice(0, 255), fingerprint: createHash("sha256").update(new Uint8Array(bytes)).digest("hex"),
      }) });
    }
    const json = await readBoundedJson(request, 16_384);
    const parsed = command.safeParse(json.ok ? json.value : null);
    if (!parsed.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });
    const input = parsed.data;
    switch (input.action) {
      case "review":
        return NextResponse.json({ item: await reviewCatalogueItem(owner, input.runId, input.itemId, input.decision, input.canonicalId) });
      case "apply":
        return NextResponse.json(await applyCatalogue(owner, input.runId, input.approveSafe));
      case "cancel":
        await catalogueSummary(owner, input.runId);
        return NextResponse.json({ run: await cancelRun(owner.businessId, input.runId, owner.actor) });
      default: {
        const woo = await requirePermission(PERMISSIONS.woocommerceManage);
        if (woo.error) return woo.error;
        if (await isLocalOnly(owner.businessId)) return NextResponse.json({ error: "catalogue_woo_offline" }, { status: 409 });
        const connection = await getAccessibleConnection(scope.session, input.connectionId);
        if (!connection) return NextResponse.json({ error: "not_found" }, { status: 404 });
        if (input.action === "woo-preview") {
          return NextResponse.json({ preview: await previewCatalogueWoo(owner, input.runId, input.itemId, connection) });
        }
        return NextResponse.json({ operation: await queueCatalogueWoo(owner, input.runId, input.itemId, connection, input) }, { status: 202 });
      }
    }
  } catch (error) {
    return failure(error);
  }
});
