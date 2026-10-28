import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { readDeploymentProfile } from "@/lib/deployment-mode";
import { tenantBackupInventory } from "@/lib/tenant-backup-artifacts-service";
import {
  ARTIFACT_COMPLETENESS_LABELS,
  ARTIFACT_FORMAT_LABELS,
  ARTIFACT_ORIGIN_LABELS,
  ARTIFACT_STATE_LABELS,
  type ArtifactOrigin,
  type ArtifactViewState,
} from "@/lib/tenant-backup-inventory";

/**
 * Issue #903 §2 — the tenant's own artifact inventory.
 *
 * Read-only and provider-neutral: the response carries opaque references, byte
 * counts and human labels. Object keys, endpoints, buckets, prefixes and
 * internal error text stay on the server (`tenant-backup-artifacts-service.ts`
 * never serializes `storage_ref`).
 *
 * Permission: `backup.manage` (view/list plus run, as the existing permission
 * contract defines it). Download stays behind `backup.export` and every
 * upload/restore action behind `backup.restore` — both owner-only — so a Manager
 * can see the business is protected without being able to take a copy of, or
 * replace, all of its records.
 *
 * Connectivity for a Local/Hybrid installation is reported honestly as
 * `unknown` until the pairing channel exposes a fresh heartbeat: the inventory
 * treats `unknown` as "not known to be offline", and a queued upload is still
 * labelled `uploading` from its own row state.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.backupManage);
  if (error) return error;

  const params = request.nextUrl.searchParams;
  const state = params.get("state");
  const origin = params.get("origin");
  const profile = (await readDeploymentProfile(session.businessId)).profile;

  const inventory = await tenantBackupInventory(session.businessId, {
    profile,
    connectivity: profile === "cloud" ? "online" : "unknown",
    query: {
      search: params.get("search") ?? undefined,
      state: state ? (state as ArtifactViewState) : undefined,
      origin: origin ? (origin as ArtifactOrigin) : undefined,
      sort: params.get("sort") === "oldest" ? "oldest" : "newest",
      page: Number(params.get("page") ?? 1),
      pageSize: Number(params.get("pageSize") ?? 20),
    },
  });

  return NextResponse.json(
    {
      ...inventory,
      labels: {
        state: ARTIFACT_STATE_LABELS,
        format: ARTIFACT_FORMAT_LABELS,
        origin: ARTIFACT_ORIGIN_LABELS,
        completeness: ARTIFACT_COMPLETENESS_LABELS,
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
});
