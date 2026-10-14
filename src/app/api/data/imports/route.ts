import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { resolveActiveLocation } from "@/lib/setup-state";
import { memberAccessFor } from "@/lib/member-access";
import { PERMISSIONS as MEMBER_PERMISSIONS } from "@/lib/permissions";
import { checkHolooScopePermissions } from "../providers/holoo/guard";
import {
  createImportJob,
  formatForFileName,
  listImportJobs,
  MAX_IMPORT_FILE_BYTES,
} from "@/lib/data-transfer/import-service";
import { getMappingTemplate } from "@/lib/data-transfer/templates-service";
import { dataOwner, entityAccess, handleDataError, PERMISSIONS } from "../guard";

/**
 * Import jobs: the history (GET) and the upload that starts one (POST).
 *
 * The upload **analyses and stores, and writes nothing** to the business's own
 * tables. It answers with the parsed columns and a suggested mapping; the
 * operator maps, previews, and only then confirms. That split is the whole
 * point of the flow — see `import-service.ts`.
 */

export const GET = withTenantScope(async (request: NextRequest) => {
  const { owner, error } = await dataOwner(PERMISSIONS.dataImport);
  if (error) return error;
  try {
    const entityKey = request.nextUrl.searchParams.get("entity");
    // A history filtered to one entity still has to pass that entity's own
    // gate; an unfiltered history is already scoped to the business.
    if (entityKey) {
      const { error: entityError } = await entityAccess(owner, entityKey, "import");
      if (entityError) return entityError;
    }
    const jobs = await listImportJobs(owner.businessId, { entityKey });
    const member = await memberAccessFor(owner.session);
    const visibleJobs = [];
    for (const job of jobs) {
      if (job.providerMetadata?.provider === "holoo") {
        if (job.providerMetadata.locationId && owner.locationId && job.providerMetadata.locationId !== owner.locationId) continue;
        if (!member?.permissions.has(MEMBER_PERMISSIONS.integrationsView)) continue;
        const scopeAccess = await checkHolooScopePermissions(owner, job.providerMetadata.selectedScopes);
        if (!scopeAccess.ok) continue;
      }
      visibleJobs.push(job);
    }
    return NextResponse.json({ jobs: visibleJobs });
  } catch (err) {
    return handleDataError(err);
  }
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { owner, error } = await dataOwner(PERMISSIONS.dataImport);
  if (error) return error;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const file = form.get("file");
  const entityKey = String(form.get("entity") ?? "");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "missing_file" }, { status: 400 });
  }
  if (file.size > MAX_IMPORT_FILE_BYTES) {
    return NextResponse.json({ error: "file_too_large" }, { status: 413 });
  }

  const { entity, error: entityError } = await entityAccess(owner, entityKey, "import");
  if (entityError) return entityError;

  const format = formatForFileName(file.name);
  if (!format) return NextResponse.json({ error: "unsupported_format" }, { status: 415 });

  try {
    const locationId = entity.locationScoped
      ? (await resolveActiveLocation(owner.session))?.id ?? null
      : owner.locationId;

    // A template is a saved mapping for this entity; one saved for another
    // entity would confidently map the wrong columns, so it is ignored.
    const templateId = String(form.get("templateId") ?? "");
    const template = templateId ? await getMappingTemplate(owner.businessId, templateId) : null;
    const usable = template && template.entityKey === entity.key ? template : null;

    const { job, sheet } = await createImportJob({
      businessId: owner.businessId,
      locationId,
      entityKey: entity.key,
      fileName: file.name,
      format,
      buffer: await file.arrayBuffer(),
      actorUserId: owner.actorUserId,
      actorName: owner.actorName,
      mapping: usable?.mapping ?? null,
      options: usable?.options,
    });

    return NextResponse.json({ job, columns: sheet.columns, sampleRows: sheet.rows.slice(0, 5) });
  } catch (err) {
    return handleDataError(err);
  }
});
