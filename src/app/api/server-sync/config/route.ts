import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requireRole } from "@/lib/auth";
import {
  getServerSyncConfig,
  getServerSyncState,
  getSyncDomainDiagnostics,
  listServerSyncDeadLetters,
  listSyncRuns,
  setServerSyncConfig,
} from "@/lib/server-sync";
import {
  resolveConfigUpdate,
  syncTokenFormat,
  type ServerSyncConfigUpdateInput,
} from "@/lib/server-sync-config";
import { getAppUpdateStatus } from "@/lib/app-update";
import { deploymentRole, platformBaseUrl } from "@/lib/deployment-role";
import { getPairedSite } from "@/lib/server-sync";
import { publicSyncEventRegistry } from "@/lib/sync-event-registry";
import { replicationCatalogue } from "@/lib/replication-catalogue";

/**
 * Owner-only: configure the bidirectional server-to-server sync target
 * (the peer server's URL + shared bearer token) and read current sync status.
 *
 * On a Windows site this points at the paired cloud origin. Pairing installs a
 * unique, location-scoped site credential; `REMOTE_SYNC_TOKEN` is only a
 * disabled-by-default migration fallback and is not used for new sites.
 *
 * Since Phase 23 Wave 2 the response also carries the install's deployment
 * role, because the two roles need different screens: a central server has
 * nothing to connect *to*, and a site should not be asked to type an address
 * that pairing already knows. `resolvedRemoteUrl` is that derived address.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner");
  if (error) return error;

  const role = deploymentRole();
  const [config, syncState, deadLetters, domainDiagnostics, appUpdateStatus, pairedSite, syncRuns] = await Promise.all([
    getServerSyncConfig(session.businessId),
    getServerSyncState(session.businessId),
    listServerSyncDeadLetters(session.businessId),
    getSyncDomainDiagnostics(session.businessId),
    getAppUpdateStatus(session.businessId),
    role === "central" ? getPairedSite(session.businessId) : Promise.resolve(null),
    listSyncRuns(session.businessId),
  ]);

  // Sources in order. Pairing writes the URL the laptop was paired with
  // straight into the config (pairing-apply.ts's insertSettings), so the
  // "paired platform URL" and "current config value" are one lookup here —
  // and config-first is what preserves a deliberate override.
  const resolvedRemoteUrl = config?.remoteUrl?.trim() || platformBaseUrl() || "";
  // Never leak the token back to the client in full — mask it. `tokenFormat`
  // carries the one fact the UI needs about the real value: whether it is a
  // pre-format hex secret the owner should rotate when convenient.
  const masked = config
    ? {
        ...config,
        token: config.token ? `${config.token.slice(0, 4)}…${config.token.slice(-4)}` : "",
        tokenFormat: syncTokenFormat(config.token),
      }
    : null;
  return NextResponse.json({
    config: masked,
    role,
    resolvedRemoteUrl,
    pairedSite,
    syncState,
    deadLetters,
    domainDiagnostics,
    eventRegistry: publicSyncEventRegistry(),
    replicationCatalogue: replicationCatalogue(),
    syncRuns,
    appUpdateStatus,
  });
});

export const PUT = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner");
  if (error) return error;

  // A central server is what sites sync *to*; it has no peer of its own, and
  // writing a remote URL here would point it at one of its own tenants. The
  // UI doesn't offer the form, but the route is the boundary, so it refuses
  // regardless of what the client sends.
  if (deploymentRole() === "central") {
    return NextResponse.json({ error: "central_server" }, { status: 409 });
  }

  let body: ServerSyncConfigUpdateInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // GET only ever returns a masked token preview, so the client omits `token`
  // entirely unless the owner typed a new one — resolveConfigUpdate keeps the
  // existing one in that case, so toggling `enabled` or changing `batchSize`
  // doesn't force re-entering the secret every time.
  const existing = await getServerSyncConfig(session.businessId);
  const result = resolveConfigUpdate(existing, body);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  await setServerSyncConfig(session.businessId, result.config);
  return NextResponse.json({ ok: true });
});
