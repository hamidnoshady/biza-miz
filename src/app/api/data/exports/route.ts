import { NextRequest, NextResponse } from "next/server";
import { memberAccessFor } from "@/lib/member-access";
import { PERMISSIONS as MEMBER_PERMISSIONS } from "@/lib/permissions";
import { checkHolooConnectedSendPermissions, checkHolooExportScopePermissions } from "../providers/holoo/guard";
import { withTenantScope } from "@/lib/auth";
import { resolveActiveLocation } from "@/lib/setup-state";
import { createExportJob, listExportJobs } from "@/lib/data-transfer/export-service";
import { getExportTemplate } from "@/lib/data-transfer/templates-service";
import type { ExportFormat } from "@/lib/data-transfer/types";
import { partyReadAudienceForPermissions } from "@/lib/personnel-access";
import { decideExportDownload } from "@/lib/data-transfer/export-audience";
import {
  dataOwner,
  entityAccess,
  fileResponse,
  handleDataError,
  PERMISSIONS,
  readBody,
} from "../guard";

/**
 * Exports: the history (GET) and producing one (POST).
 *
 * POST answers with the file itself, and stores a copy on the job row so the
 * same file is downloadable again from the history later. Both halves matter:
 * the operator wanted a download now, and «دانلود دوبارهٔ خروجی قبلی» must not
 * mean "run it again and hope the data has not moved".
 */

const FORMATS: ExportFormat[] = ["csv", "xlsx", "pdf", "json"];

export const GET = withTenantScope(async (request: NextRequest) => {
  const { owner, error } = await dataOwner(PERMISSIONS.dataExport);
  if (error) return error;
  try {
    const entityKey = request.nextUrl.searchParams.get("entity");
    if (entityKey) {
      const { error: entityError } = await entityAccess(owner, entityKey, "export");
      if (entityError) return entityError;
    }
    const jobs = await listExportJobs(owner.businessId, { entityKey });
    const member = await memberAccessFor(owner.session);
    const access = {
      partyAudience: partyReadAudienceForPermissions(member?.permissions),
      permissions: member?.permissions ?? new Set<string>(),
    };
    const visibleJobs = [];
    for (const job of jobs) {
      if (job.providerMetadata?.provider === "holoo") {
        if (job.providerMetadata.locationId && owner.locationId && job.providerMetadata.locationId !== owner.locationId) continue;
        if (!member?.permissions.has(MEMBER_PERMISSIONS.integrationsView)) continue;
        const scopeAccess = job.providerMetadata.sourceFormat === "connected_outbox"
          ? await checkHolooConnectedSendPermissions(owner)
          : await checkHolooExportScopePermissions(owner, job.providerMetadata.selectedScopes);
        if (!scopeAccess.ok) continue;
      }
      /*
       * Issue #947 — the row says whether *this* member may still download it, decided
       * by the same function the download itself calls, so the screen never offers a
       * button whose answer is a 403. The history still lists the file: who exported
       * what, when and how many rows is the audit record, and hiding it would hide the
       * fact that somebody produced a wider file.
       */
      const decision = decideExportDownload(
        { partyAudience: job.partyAudience, domainKeys: job.domainKeys },
        access,
      );
      visibleJobs.push({
        ...job,
        download: decision.allowed
          ? { allowed: true as const }
          : { allowed: false as const, requires: decision.requires, reason: decision.reason },
      });
    }
    return NextResponse.json({ jobs: visibleJobs });
  } catch (err) {
    return handleDataError(err);
  }
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { owner, error } = await dataOwner(PERMISSIONS.dataExport);
  if (error) return error;

  try {
    const body = await readBody(request);
    const { entity, error: entityError } = await entityAccess(
      owner,
      typeof body.entity === "string" ? body.entity : null,
      "export",
    );
    if (entityError) return entityError;

    // A saved template supplies the fields, filters and format the operator
    // named once; an explicit body still wins over it.
    const templateId = typeof body.templateId === "string" ? body.templateId : "";
    const template = templateId ? await getExportTemplate(owner.businessId, templateId) : null;
    const usable = template && template.entityKey === entity.key ? template : null;

    const format = (
      FORMATS.includes(body.format as ExportFormat)
        ? body.format
        : (usable?.format ?? "xlsx")
    ) as ExportFormat;
    const fields = Array.isArray(body.fields)
      ? (body.fields as unknown[]).filter((field): field is string => typeof field === "string")
      : (usable?.fields ?? undefined);
    const filters =
      body.filters && typeof body.filters === "object" && !Array.isArray(body.filters)
        ? (body.filters as Record<string, unknown>)
        : (usable?.filters ?? {});
    const ids = Array.isArray(body.ids)
      ? (body.ids as unknown[]).filter((id): id is string => typeof id === "string")
      : undefined;

    const locationId = entity.locationScoped
      ? (await resolveActiveLocation(owner.session))?.id ?? null
      : owner.locationId;

    // Issue #947 (TEAM-F01) — an export is a read, and one that leaves the server.
    // Narrowed to what this member may actually see, so a manager exporting the customer
    // list cannot pick up the national ID of a colleague who is also a customer: the
    // Employee rows come back with the personnel columns empty, exactly as the
    // directory screen shows them.
    const member = await memberAccessFor(owner.session);

    const { job, body: content } = await createExportJob({
      businessId: owner.businessId,
      locationId,
      entityKey: entity.key,
      format,
      fields,
      filters,
      ids,
      limit: typeof body.limit === "number" ? body.limit : undefined,
      actorUserId: owner.actorUserId,
      actorName: owner.actorName,
      partyAudience: partyReadAudienceForPermissions(member?.permissions),
    });

    return fileResponse(content, job.contentType, job.fileName, {
      "X-Export-Job": job.id,
      "X-Row-Count": String(job.rowCount),
    });
  } catch (err) {
    return handleDataError(err);
  }
});
