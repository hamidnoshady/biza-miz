import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import {
  cancelImportJob,
  getImportJob,
  listImportRows,
  previewImportJob,
  queueImportJob,
  reconciliationDomainForImportEntity,
  retryFailedRows,
  stageImportJobToReconciliation,
} from "@/lib/data-transfer/import-service";
import { hasCanonicalOverlapForDomain } from "@/lib/import-reconciliation/entry-guards";
import type { ImportMapping, ImportOptions } from "@/lib/data-transfer/types";
import { dataOwner, entityAccess, handleDataError, PERMISSIONS, readBody } from "../../guard";

/**
 * One import job: read it (GET), remap and re-preview it (PATCH), act on it
 * (POST `{action}`), or cancel it (DELETE).
 *
 * PATCH is the mapping screen's endpoint and is deliberately side-effect-free
 * on tenant data: it re-validates the stored rows against the new mapping and
 * answers with the counts and the first page of verdicts. Nothing is written
 * to the business's own tables until POST `{"action":"run"}`.
 */

export const GET = withTenantScope(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await dataOwner(PERMISSIONS.dataImport);
    if (error) return error;
    try {
      const { id } = await params;
      const job = await getImportJob(owner.businessId, id);
      if (!job) return NextResponse.json({ error: "job_not_found" }, { status: 404 });
      const { error: entityError } = await entityAccess(owner, job.entityKey, "import");
      if (entityError) return entityError;

      const search = request.nextUrl.searchParams;
      const rows = await listImportRows(owner.businessId, id, {
        status: search.get("status"),
        limit: Number(search.get("limit")) || undefined,
        offset: Number(search.get("offset")) || undefined,
      });
      return NextResponse.json({ job, rows: rows.rows, total: rows.total });
    } catch (err) {
      return handleDataError(err);
    }
  },
);

export const PATCH = withTenantScope(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await dataOwner(PERMISSIONS.dataImport);
    if (error) return error;
    try {
      const { id } = await params;
      const job = await getImportJob(owner.businessId, id);
      if (!job) return NextResponse.json({ error: "job_not_found" }, { status: 404 });
      const { error: entityError } = await entityAccess(owner, job.entityKey, "import");
      if (entityError) return entityError;

      const body = await readBody(request);
      const result = await previewImportJob(owner.businessId, id, {
        mapping: (body.mapping as ImportMapping | undefined) ?? undefined,
        options: (body.options as ImportOptions | undefined) ?? undefined,
      });
      return NextResponse.json(result);
    } catch (err) {
      return handleDataError(err);
    }
  },
);

export const POST = withTenantScope(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await dataOwner(PERMISSIONS.dataImport);
    if (error) return error;
    try {
      const { id } = await params;
      const job = await getImportJob(owner.businessId, id);
      if (!job) return NextResponse.json({ error: "job_not_found" }, { status: 404 });
      const { error: entityError } = await entityAccess(owner, job.entityKey, "import");
      if (entityError) return entityError;

      const body = await readBody(request);
      const action = String(body.action ?? "run");

      if (action === "retry") {
        return NextResponse.json({ job: await retryFailedRows(owner.businessId, id) });
      }
      if (action === "reconcile") {
        const staged = await stageImportJobToReconciliation(
          owner.businessId,
          id,
          { userId: owner.actorUserId, name: owner.actorName },
          owner.locationId,
        );
        return NextResponse.json({ ok: true, reconciliation: staged });
      }
      if (action === "run") {
        const domain = reconciliationDomainForImportEntity(job.entityKey);
        if (
          domain &&
          !job.reconciliationRunId &&
          body.skipReconciliation !== true &&
          (await hasCanonicalOverlapForDomain(owner.businessId, domain, owner.locationId))
        ) {
          const staged = await stageImportJobToReconciliation(
            owner.businessId,
            id,
            { userId: owner.actorUserId, name: owner.actorName },
            owner.locationId,
          );
          return NextResponse.json(
            { error: "reconciliation_required", runId: staged.runId, reconciliation: staged },
            { status: 409 },
          );
        }
        // Queued, never run inline: a 50,000-row import must not hold an HTTP
        // request open, and the worker is what makes progress visible while
        // the operator carries on working.
        return NextResponse.json({ job: await queueImportJob(owner.businessId, id) });
      }
      return NextResponse.json({ error: "unknown_action" }, { status: 400 });
    } catch (err) {
      return handleDataError(err);
    }
  },
);

export const DELETE = withTenantScope(
  async (_request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await dataOwner(PERMISSIONS.dataImport);
    if (error) return error;
    try {
      const { id } = await params;
      const job = await getImportJob(owner.businessId, id);
      if (!job) return NextResponse.json({ error: "job_not_found" }, { status: 404 });
      const { error: entityError } = await entityAccess(owner, job.entityKey, "import");
      if (entityError) return entityError;
      return NextResponse.json({ job: await cancelImportJob(owner.businessId, id) });
    } catch (err) {
      return handleDataError(err);
    }
  },
);
