import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { getExportContent, getExportJob } from "@/lib/data-transfer/export-service";
import { getConnection } from "@/lib/integrations/connections-service";
import { isHoloo } from "@/lib/integrations/provider-registry";
import { HOLOO_EXPORT_SCOPES } from "@/lib/data-transfer/providers/holoo/export";
import { checkHolooExportScopePermissions, holooTransferOwner } from "../../providers/holoo/guard";
import {
  dataOwner,
  entityAccess,
  fileResponse,
  handleDataError,
  PERMISSIONS,
} from "../../guard";

/**
 * Download a previously produced export again.
 *
 * The bytes are kept on the job row for a retention window (see
 * `EXPORT_RETENTION_DAYS`); once pruned, the history row survives — who
 * exported what, when, how many rows — and this answers 410 rather than
 * pretending the file is still there.
 */
export const GET = withTenantScope(
  async (_request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await dataOwner(PERMISSIONS.dataExport);
    if (error) return error;
    try {
      const { id } = await params;
      const job = await getExportJob(owner.businessId, id);
      if (!job) return NextResponse.json({ error: "job_not_found" }, { status: 404 });
      // Re-check the domain permissions on every download, not only when the
      // file was produced. Provider jobs use the same universal history table,
      // with their provider adapter's permission contract.
      if (job.providerMetadata?.provider === "holoo") {
        const { owner: holooOwner, error: holooError } = await holooTransferOwner(PERMISSIONS.dataExport);
        if (holooError) return holooError;
        const scopes = job.providerMetadata.selectedScopes;
        if (!scopes.length || scopes.some((scope) => !HOLOO_EXPORT_SCOPES.includes(scope as (typeof HOLOO_EXPORT_SCOPES)[number]))) {
          return NextResponse.json({ error: "job_not_found" }, { status: 404 });
        }
        const scopeAccess = await checkHolooExportScopePermissions(holooOwner, scopes);
        if (!scopeAccess.ok) return NextResponse.json({ error: "forbidden", requires: scopeAccess.missing }, { status: 403 });
        if (job.providerMetadata.locationId && holooOwner.locationId && job.providerMetadata.locationId !== holooOwner.locationId) {
          return NextResponse.json({ error: "job_not_found" }, { status: 404 });
        }
        const connection = await getConnection(holooOwner.businessId, job.providerMetadata.connectionId);
        if (!connection || !isHoloo(connection)) return NextResponse.json({ error: "job_not_found" }, { status: 404 });
      } else {
        const { error: entityError } = await entityAccess(owner, job.entityKey, "export");
        if (entityError) return entityError;
      }

      const content = await getExportContent(owner.businessId, id);
      if (!content) return NextResponse.json({ error: "content_expired" }, { status: 410 });
      return fileResponse(content.body, content.contentType, content.fileName);
    } catch (err) {
      return handleDataError(err);
    }
  },
);
