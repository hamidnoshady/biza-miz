import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { getBusinessIndustry } from "@/lib/industry-guard";
import { isRetailCatalogueIndustry } from "@/lib/industries";
import { resolveActiveLocation } from "@/lib/setup-state";
import { applyReconciliationRunWithDomainHandlers } from "@/lib/import-reconciliation/apply-runner";
import { buildReconciliationReportCsv, buildReconciliationRunReport } from "@/lib/import-reconciliation/report";
import {
  approveSafeBatch,
  cancelRun,
  decideItem,
  getRunSummary,
  listItems,
  ReconciliationError,
  setRunCutoverPolicy,
} from "@/lib/import-reconciliation/service";
import type { ReconciliationDomain, ReconciliationItemStatus, ReconciliationOutcome } from "@/lib/import-reconciliation/types";
import { dataOwner, entityAccess, fileResponse, PERMISSIONS } from "../../guard";

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

const commandSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("decide"),
    itemId: z.number().int().positive().safe(),
    decision: z.enum(["link", "create_separate", "choose_authority", "skip", "keep_for_review"]),
    canonicalId: z.string().uuid().optional(),
    authorityOverrides: z.record(z.string(), z.enum(["canonical", "source"])).optional(),
    reason: z.string().trim().max(500).optional(),
  }),
  z.object({ action: z.literal("approve_safe") }),
  z.object({
    action: z.literal("cutover"),
    cutoverAuthority: z.enum(["books", "source", "two_way", "archive_only"]),
    cutoverAt: z.string().datetime().optional(),
  }),
  z.object({ action: z.literal("apply") }),
  z.object({ action: z.literal("cancel") }),
]);

async function authorizeRun(id: string) {
  const { owner, error } = await dataOwner(PERMISSIONS.dataImport);
  if (error) return { error };
  if (!z.string().uuid().safeParse(id).success) {
    return { error: NextResponse.json({ error: "invalid_run_id" }, { status: 400 }) };
  }
  let summary;
  try {
    summary = await getRunSummary(owner.businessId, id);
  } catch (err) {
    if (err instanceof ReconciliationError && err.code === "run_not_found") {
      return { error: NextResponse.json({ error: "run_not_found" }, { status: 404 }) };
    }
    throw err;
  }
  const industry = await getBusinessIndustry(owner.businessId);
  const scopeEntity = typeof summary.run.scope?.entityKey === "string" ? summary.run.scope.entityKey : null;
  const access = await entityAccess(
    owner,
    scopeEntity ?? entityKeyForDomain(summary.run.domain, isRetailCatalogueIndustry(industry)),
    "import",
  );
  if (access.error) return { error: access.error };
  if (summary.run.domain === "financial_document") {
    const ledger = await requirePermission(PERMISSIONS.ledgerPost);
    if (ledger.error) return { error: ledger.error };
  }
  return { owner, summary };
}

async function listAllItems(
  businessId: string,
  runId: string,
  filters: { outcome?: ReconciliationOutcome; status?: ReconciliationItemStatus; search?: string },
) {
  const BATCH = 500;
  const all: Awaited<ReturnType<typeof listItems>> = [];
  let afterId: number | undefined;
  for (;;) {
    const batch = await listItems(businessId, runId, {
      ...filters,
      ...(afterId !== undefined ? { afterId } : {}),
      limit: BATCH,
    });
    all.push(...batch);
    if (batch.length < BATCH) break;
    const lastId = batch[batch.length - 1]?.id;
    if (lastId == null || lastId === afterId) break;
    afterId = lastId;
  }
  return all;
}

export const GET = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params;
    const auth = await authorizeRun(id);
    if (auth.error) return auth.error;
    const { owner, summary } = auth;

    const search = request.nextUrl.searchParams;
    const outcome = search.get("outcome") as ReconciliationOutcome | null;
    const status = search.get("status") as ReconciliationItemStatus | null;
    const searchQuery = search.get("search")?.trim() || undefined;
    const report = search.get("report");

    if (report === "csv" || report === "json") {
      const allItems = await listAllItems(owner.businessId, id, {
        ...(outcome ? { outcome } : {}),
        ...(status ? { status } : {}),
        ...(searchQuery ? { search: searchQuery } : {}),
      });
      if (report === "csv") {
        return fileResponse(
          buildReconciliationReportCsv(summary, allItems),
          "text/csv; charset=utf-8",
          `reconciliation-${id.slice(0, 8)}.csv`,
        );
      }
      return fileResponse(
        JSON.stringify(buildReconciliationRunReport(summary, allItems), null, 2),
        "application/json; charset=utf-8",
        `reconciliation-${id.slice(0, 8)}.json`,
      );
    }

    const rawLimit = Number(search.get("limit"));
    const pageLimit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.trunc(rawLimit), 499) : 100;
    const rawAfterId = Number(search.get("afterId"));
    const afterId = Number.isSafeInteger(rawAfterId) && rawAfterId > 0 ? rawAfterId : undefined;

    const rows = await listItems(owner.businessId, id, {
      ...(outcome ? { outcome } : {}),
      ...(status ? { status } : {}),
      ...(searchQuery ? { search: searchQuery } : {}),
      ...(afterId !== undefined ? { afterId } : {}),
      limit: pageLimit + 1,
    });
    const hasMore = rows.length > pageLimit;
    const items = hasMore ? rows.slice(0, pageLimit) : rows;
    const nextCursor = hasMore ? (items[items.length - 1]?.id ?? null) : null;

    return NextResponse.json({ ...summary, items, nextCursor, hasMore });
  },
);

export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params;
    const auth = await authorizeRun(id);
    if (auth.error) return auth.error;
    const { owner, summary } = auth;

    const raw = await request.json().catch(() => null);
    const parsed = commandSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    const actor = { userId: owner.actorUserId, name: owner.actorName };
    try {
      const cmd = parsed.data;
      switch (cmd.action) {
        case "decide": {
          const item = await decideItem({
            businessId: owner.businessId,
            runId: id,
            itemId: cmd.itemId,
            decision: cmd.decision,
            canonicalId: cmd.canonicalId,
            authorityOverrides: cmd.authorityOverrides,
            reason: cmd.reason,
            actor,
          });
          return NextResponse.json({ ok: true, item, ...(await getRunSummary(owner.businessId, id)) });
        }
        case "approve_safe": {
          const { approved } = await approveSafeBatch(owner.businessId, id, actor);
          return NextResponse.json({ ok: true, approvedCount: approved, ...(await getRunSummary(owner.businessId, id)) });
        }
        case "cutover": {
          await setRunCutoverPolicy(
            owner.businessId,
            id,
            { cutoverAuthority: cmd.cutoverAuthority, cutoverAt: cmd.cutoverAt },
            actor,
          );
          return NextResponse.json({ ok: true, ...(await getRunSummary(owner.businessId, id)) });
        }
        case "apply": {
          const location = summary.run.locationId ?? (await resolveActiveLocation(owner.session))?.id ?? null;
          const result = await applyReconciliationRunWithDomainHandlers({
            businessId: owner.businessId,
            runId: id,
            locationId: location,
            actor,
          });
          return NextResponse.json({ ok: true, ...result });
        }
        case "cancel": {
          const run = await cancelRun(owner.businessId, id, actor);
          return NextResponse.json({ ok: true, run });
        }
      }
    } catch (err) {
      if (err instanceof ReconciliationError) {
        return NextResponse.json(
          { error: err.code, details: err.details },
          { status: err.code.endsWith("_not_found") ? 404 : 409 },
        );
      }
      throw err;
    }
  },
);
