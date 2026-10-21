import { getAccessibleConnection } from "@/lib/integrations/connection-access";
import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isHoloo } from "@/lib/integrations/provider-registry";
import { listImportRuns } from "@/lib/integrations/holoo/migration-run-service";
import { previewBaseImport } from "@/lib/integrations/holoo/import-service";
import { previewTransactions } from "@/lib/integrations/holoo/transaction-import-service";
import { planJournalImport } from "@/lib/integrations/holoo/journal-plan";
import { buildMigrationDiscrepancyReport } from "@/lib/integrations/holoo/migration-discrepancy-service";
import type { BaseImportInput } from "@/lib/integrations/holoo/import-service";
import type { HolooTransaction } from "@/lib/integrations/holoo/transaction-plan";
import type { HolooVoucher } from "@/lib/integrations/holoo/journal-plan";
import type { OpeningBalanceLine } from "@/lib/integrations/holoo/journal-import-service";

export const GET = withTenantScope(async (_request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.integrationsView);
  if (error) return error;
  const { id } = await context.params;
  const connection = await getAccessibleConnection(session, id);
  if (!connection || !isHoloo(connection)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const runs = await listImportRuns(session.businessId, id);
  return NextResponse.json({ runs });
});

interface MigrationManifest {
  base?: BaseImportInput;
  transactions?: HolooTransaction[];
  journals?: HolooVoucher[];
  openingBalance?: OpeningBalanceLine[];
}

export const POST = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.integrationsManage);
  if (error) return error;
  const { id } = await context.params;

  const connection = await getAccessibleConnection(session, id);
  if (!connection || !isHoloo(connection)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let body: { action?: string; runId?: string; manifest?: MigrationManifest };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (body.action === "preview") {
    if (!body.manifest) return NextResponse.json({ error: "missing_manifest" }, { status: 400 });
    const summary: Record<string, unknown> = {};
    if (body.manifest.base) summary.base = await previewBaseImport(session.businessId, id, body.manifest.base);
    if (body.manifest.transactions) summary.transactions = await previewTransactions(session.businessId, id, body.manifest.transactions);
    if (body.manifest.journals) {
      const plan = planJournalImport(body.manifest.journals);
      summary.journals = { importable: plan.balanced.length, unbalanced: plan.unbalanced.map((v) => ({ remoteId: v.remoteId, difference: v.difference.toString() })) };
    }
    if (body.manifest.openingBalance) summary.openingBalance = { lines: body.manifest.openingBalance.length };
    const discrepancies = await buildMigrationDiscrepancyReport(session.businessId, id, body.manifest);
    return NextResponse.json({ ok: true, summary, discrepancies });
  }

  // #845 owns execution: its transfer endpoint binds preview to the input,
  // verifies financial scope/branch permissions and owns rollback safeguards.
  // Do not retain a weaker parallel import path in this connectivity hub.
  if (body.action === "apply" || body.action === "rollback") {
    return NextResponse.json({ error: "use_data_transfer", path: "/settings/transfer" }, { status: 409 });
  }

  return NextResponse.json({ error: "unknown_action" }, { status: 400 });
});
