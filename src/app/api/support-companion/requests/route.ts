import { NextRequest, NextResponse } from "next/server";
import { withTenant } from "@/lib/db";
import { requireCompanionDevice } from "@/lib/support-companion/companion-auth";
import {
  listPendingInstallationRequests,
  transitionDiagnosticRequest,
} from "@/lib/support-companion/diagnostics";
import {
  listSessionsAwaitingConsent,
  markSessionDelivered,
} from "@/lib/support-companion/assistance";
import { recordInstallationContact } from "@/lib/support-companion/installations";
import { offlinePublicKeysBundle } from "@/lib/support-companion/access-tokens";

/** The companion's poll: this installation's pending diagnostic requests and
 * assistance sessions awaiting local consent. Device credential only;
 * metadata for the locked welcome screen — never execution authority. */
export async function GET(request: NextRequest) {
  const auth = await requireCompanionDevice(request);
  if ("response" in auth) return auth.response;
  const { identity, installation } = auth.device;
  // The companion reports its MeshCentral agent node id on every poll, which
  // (re-)links the installation for remote assistance. Empty = not installed.
  const meshNodeId = request.nextUrl.searchParams.get("meshNodeId")?.trim() || null;
  // Presence without an id (the agent phones home with its own id, which
  // the broker links server-side): "true"/"false", absent when unprobed.
  const meshAgentParam = request.nextUrl.searchParams.get("meshAgentPresent")?.trim().toLowerCase();
  const meshAgentPresent = meshAgentParam === "true" ? true : meshAgentParam === "false" ? false : null;

  const [requests, sessions] = await withTenant(identity.businessId, async () => {
    const pending = await listPendingInstallationRequests(identity.businessId, installation.id);
    const awaiting = await listSessionsAwaitingConsent(identity.businessId, installation.id);
    // Fetching is delivery: the operator's console moves from "waiting for
    // customer to open companion" to "awaiting local consent" truthfully.
    for (const item of pending) {
      if (item.state === "pending") {
        await transitionDiagnosticRequest(identity.businessId, item.id, "delivered");
        item.state = "delivered";
      }
    }
    for (const item of awaiting) {
      await markSessionDelivered(identity.businessId, item.id);
    }
    await recordInstallationContact(identity.businessId, installation.id, {
      meshNodeId,
      capabilities: meshAgentPresent === null ? undefined : { meshAgentPresent },
    }).catch(() => {});
    return [pending, awaiting] as const;
  });

  return NextResponse.json({
    installation: {
      id: installation.id,
      generation: installation.generation,
      displayName: installation.displayName,
    },
    live: installation.enrollmentState === "active",
    requests: requests.map((item) => ({
      id: item.id,
      ticketId: item.ticketId,
      installationGeneration: item.installationGeneration,
      initiatedBy: item.initiatedBy,
      modules: item.modules,
      allowedOperations: item.allowedOperations,
      expiresAt: item.expiresAt,
      state: item.state,
      // The locked screen shows scope + destination, never secrets.
      scope: {
        businessId: item.businessId,
        locationId: item.locationId,
        displayName: (item.contextSnapshot.displayName as string | undefined) ?? null,
        mainVersion: (item.contextSnapshot.mainVersion as string | undefined) ?? null,
        companionVersion: (item.contextSnapshot.companionVersion as string | undefined) ?? null,
      },
      createdAt: item.createdAt,
    })),
    assistance: sessions.map((item) => ({
      id: item.id,
      ticketId: item.ticketId,
      requestedCaps: item.requestedCaps,
      state: item.state,
      createdAt: item.createdAt,
    })),
    // The approved offline ES256 bundle for local token verification —
    // null when offline issuance is not configured. Public keys only.
    offlineKeys: offlinePublicKeysBundle(),
  });
}
