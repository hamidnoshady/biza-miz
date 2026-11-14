import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { getBusinessIndustry } from "@/lib/industry-guard";
import { isRetailCatalogueIndustry } from "@/lib/industries";
import { getAccessibleConnection } from "@/lib/integrations/connection-access";
import { stageWooCatalogueToReconciliation } from "@/lib/integrations/sync-service";
import { getImportJob, reconciliationDomainForImportEntity, stageImportJobToReconciliation } from "@/lib/data-transfer/import-service";
import { listRuns, ReconciliationError } from "@/lib/import-reconciliation/service";
import type { ReconciliationDomain, ReconciliationRunStatus } from "@/lib/import-reconciliation/types";
import { dataOwner, entityAccess, PERMISSIONS } from "../guard";

function entityKeyForDomain(domain: ReconciliationDomain, isRetail: boolean): string {
  switch (domain) {
    case "product":
      return isRetail ? "inventory.items" : "pos.products";
    case "party":
      return "crm.customers";
    case "inventory":
      return "inventory.items";
    case "financial_document":
      return "accounting.expenses";
  }
}

const postSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("stage_woo"), connectionId: z.string().uuid() }),
  z.object({ action: z.literal("stage_import_job"), jobId: z.string().uuid() }),
]);

export const GET = withTenantScope(async (request: NextRequest) => {
  const { owner, error } = await dataOwner(PERMISSIONS.dataImport);
  if (error) return error;

  const industry = await getBusinessIndustry(owner.businessId);
  const isRetail = isRetailCatalogueIndustry(industry);
  const search = request.nextUrl.searchParams;
  const domainParam = search.get("domain") as ReconciliationDomain | null;
  const statusParam = search.get("status") as ReconciliationRunStatus | null;
  const connectionId = search.get("connectionId");
  const activeOnly = search.get("activeOnly") === "true";

  if (domainParam && !["product", "party", "financial_document", "inventory"].includes(domainParam)) {
    return NextResponse.json({ error: "invalid_domain" }, { status: 400 });
  }
  if (domainParam) {
    const check = await entityAccess(owner, entityKeyForDomain(domainParam, isRetail), "import");
    if (check.error) return check.error;
    if (domainParam === "financial_document") {
      const ledger = await requirePermission(PERMISSIONS.ledgerPost);
      if (ledger.error) return ledger.error;
    }
  }

  const allRuns = await listRuns(owner.businessId, {
    domain: domainParam ?? undefined,
    connectionId: connectionId ?? undefined,
    ...(activeOnly ? { activeOnly: true } : {}),
    ...(statusParam ? { status: statusParam } : {}),
  } as Parameters<typeof listRuns>[1]);

  // Check domain-level permissions per run so no user sees runs for domains they lack permission for.
  const permittedCache = new Map<ReconciliationDomain, boolean>();
  const checkDomainPermitted = async (domain: ReconciliationDomain) => {
    const cached = permittedCache.get(domain);
    if (cached !== undefined) return cached;
    const access = await entityAccess(owner, entityKeyForDomain(domain, isRetail), "import");
    let allowed = access.error === null;
    if (allowed && domain === "financial_document") {
      const ledger = await requirePermission(PERMISSIONS.ledgerPost);
      allowed = ledger.error === null;
    }
    permittedCache.set(domain, allowed);
    return allowed;
  };

  const runs = [];
  for (const run of allRuns) {
    if (await checkDomainPermitted(run.domain)) runs.push(run);
  }
  return NextResponse.json({ runs });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { owner, error } = await dataOwner(PERMISSIONS.dataImport);
  if (error) return error;

  const body = await request.json().catch(() => null);
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    const industry = await getBusinessIndustry(owner.businessId);
    const isRetail = isRetailCatalogueIndustry(industry);

    if (parsed.data.action === "stage_woo") {
      const access = await entityAccess(owner, entityKeyForDomain("product", isRetail), "import");
      if (access.error) return access.error;
      const connection = await getAccessibleConnection(owner.session, parsed.data.connectionId);
      if (!connection || connection.provider !== "woocommerce") {
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      }
      const result = await stageWooCatalogueToReconciliation(owner.businessId, connection.id, {
        userId: owner.actorUserId,
        name: owner.actorName,
      });
      return NextResponse.json({ ok: true, ...result });
    }

    const job = await getImportJob(owner.businessId, parsed.data.jobId);
    if (!job) return NextResponse.json({ error: "job_not_found" }, { status: 404 });
    const access = await entityAccess(owner, job.entityKey, "import");
    if (access.error) return access.error;
    const domain = reconciliationDomainForImportEntity(job.entityKey);
    if (!domain) return NextResponse.json({ error: "reconciliation_unsupported_entity" }, { status: 400 });
    const result = await stageImportJobToReconciliation(
      owner.businessId,
      job.id,
      { userId: owner.actorUserId, name: owner.actorName },
      owner.locationId,
    );
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof ReconciliationError) {
      return NextResponse.json(
        { error: err.code, details: err.details },
        { status: err.code.endsWith("_not_found") ? 404 : 409 },
      );
    }
    throw err;
  }
});
