import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requirePermissions, withTenantScope } from "@/lib/auth";
import { dataOwner, entityAccess, PERMISSIONS } from "../guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { isAppAvailable } from "@/lib/app-availability-service";
import { isModuleEnabled } from "@/lib/industry-guard";
import { isFeatureEnabled } from "@/lib/features";
import { serviceActivationState } from "@/lib/service-activation/app-gate-service";
import { serviceGateBlocks } from "@/lib/service-activation/app-gate";
import { readBoundedJson } from "@/lib/product-attributes";
import { HISTORICAL_INVOICE_FIELDS, HistoricalMappingError } from "@/lib/data-transfer/historical-invoice-mapping";
import { HistoricalJobPreviewError } from "@/lib/data-transfer/historical-invoice-staged-rows";
import { previewHistoricalImportJob } from "@/lib/data-transfer/historical-invoice-job-preview";
import { HistoricalArchiveError, previewHistoricalCustomerReview, confirmHistoricalCustomerReview } from "@/lib/data-transfer/historical-invoice-archive-service";

// These endpoints operate only on already-staged jobs. They do not stage an
// upload, approve a job, enqueue one, or execute/archive an invoice.
const mapping = z.object({ columns: z.array(z.object({
  field: z.enum(HISTORICAL_INVOICE_FIELDS), column: z.number().int().min(0).max(511),
  transform: z.enum(["none", "trim"]).optional(),
}).strict()).max(HISTORICAL_INVOICE_FIELDS.length) }).strict();
const job = {
  jobId: z.string().uuid(), sourceKey: z.string().trim().min(1).max(200), provider: z.string().trim().max(200),
  currency: z.enum(["rial", "toman"]), calendar: z.enum(["jalali", "gregorian"]), mapping, lineMapping: mapping.optional(),
};
const customer = { externalCustomerCode: z.string().trim().min(1).max(300), partyId: z.string().uuid() };
const command = z.discriminatedUnion("action", [
  z.object({ action: z.literal("preview"), ...job, sampleLimit: z.number().int().min(0).max(200).optional(),
    documentOffset: z.number().int().min(0).max(50_000).optional(), orphanOffset: z.number().int().min(0).max(50_000).optional() }).strict(),
  z.object({ action: z.literal("review-customer"), ...job, ...customer }).strict(),
  z.object({ action: z.literal("confirm-customer"), ...job, ...customer,
    reviewToken: z.string().regex(/^[a-f0-9]{64}$/), confirmed: z.literal(true) }).strict(),
]);

export const POST = withTenantScope(async (request: NextRequest) => {
  // Both read and link operations expose sensitive invoice/customer evidence.
  // The identity decision also needs manage authority, not just a view grant.
  const { owner, error } = await dataOwner(PERMISSIONS.dataImport);
  if (error) return error;
  // Linking a customer is a CRM import operation; keep the registry's own
  // customer-import gate as well as the Accounting and party permissions.
  const access = await entityAccess(owner, "crm.customers", "import");
  if (access.error) return access.error;
  const permissions = await requirePermissions(PERMISSIONS.ordersView, PERMISSIONS.partiesView, PERMISSIONS.partiesManage);
  if (permissions.error) return permissions.error;
  const session = owner.session;
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "location_required" }, { status: 409 });
  try {
    for (const app of ["accounting", "crm"] as const) {
      if (!(await isAppAvailable(session.businessId, app))) {
        return NextResponse.json({ error: "app_unavailable", app }, { status: 503 });
      }
      if (serviceGateBlocks(await serviceActivationState(session.businessId, "app", app))) {
        return NextResponse.json({ error: "service_disabled" }, { status: 403 });
      }
    }
    for (const module of ["ledger", "crm"] as const) {
      if (!(await isModuleEnabled(session.businessId, module))) {
        return NextResponse.json({ error: "module_unavailable", module }, { status: 403 });
      }
    }
    if (!(await isFeatureEnabled(session.businessId, "ledger"))) {
      return NextResponse.json({ error: "feature_disabled", flag: "ledger" }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ error: "service_activation_check_unavailable" }, { status: 503 });
  }
  const body = await readBoundedJson(request, 32_768);
  if (!body.ok) return NextResponse.json({ error: body.error }, { status: body.error === "payload_too_large" ? 413 : 400 });
  const parsed = command.safeParse(body.value);
  if (!parsed.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const input = parsed.data;
  const scope = { businessId: session.businessId, locationId: location.id };
  try {
    if (input.action === "preview") {
      const { action: _action, ...values } = input;
      const preview = await previewHistoricalImportJob({ ...values, ...scope });
      return NextResponse.json({ preview, executionAvailable: false }, { headers: { "Cache-Control": "no-store" } });
    }
    if (input.action === "review-customer") {
      const { action: _action, ...values } = input;
      const review = await previewHistoricalCustomerReview({ ...values, ...scope });
      return NextResponse.json({ review }, { headers: { "Cache-Control": "no-store" } });
    }
    const { action: _action, ...values } = input;
    const result = await confirmHistoricalCustomerReview({ ...values, ...scope,
      actor: { userId: session.sub, name: session.fullName ?? "" } });
    return NextResponse.json({ result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof HistoricalJobPreviewError || error instanceof HistoricalArchiveError || error instanceof HistoricalMappingError) {
      const status = error.code.endsWith("_not_found") || error.code === "customer_code_not_in_job" ? 404 :
        ["customer_review_stale", "customer_identity_conflict", "customer_review_evidence_truncated", "job_not_editable", "job_source_changed"].includes(error.code) ? 409 : 400;
      return NextResponse.json({ error: error.code }, { status, headers: { "Cache-Control": "no-store" } });
    }
    throw error;
  }
});
