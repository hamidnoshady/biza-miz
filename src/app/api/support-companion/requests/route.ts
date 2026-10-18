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
import {
  agentArchFromName,
  agentInstallUrl,
  listMeshNodesCached,
  matchNodeByHostname,
  resolveRemoteBrokerConfig,
  type ResolvedRemoteBroker,
} from "@/lib/support-companion/remote-broker";

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
  // The machine hostname, for server-side agent discovery when the agent
  // is present but its node id is not yet linked.
  const hostname = request.nextUrl.searchParams.get("hostname")?.trim() || null;

  // OS architecture for the agent installer link ("x64"/"x86"/"arm64",
  // unknown falls back to x64 inside the builder).
  const arch = agentArchFromName(request.nextUrl.searchParams.get("arch"));

  // The broker is best-effort here: discovery and provisioning degrade
  // to unlinked / no-download-link, never to a failed poll.
  let broker: ResolvedRemoteBroker = { provider: "none" };
  try {
    broker = resolveRemoteBrokerConfig();
  } catch {
    broker = { provider: "none" };
  }

  // Best-effort hostname discovery: presence + hostname + an unlinked
  // installation + a configured discovery mesh. Any throw or miss
  // simply leaves the installation unlinked.
  let discoveredNodeId: string | null = null;
  if (!installation.meshNodeId && !meshNodeId && meshAgentPresent && hostname) {
    try {
      if (broker.provider !== "none" && broker.meshId) {
        const listed = await listMeshNodesCached(broker, broker.meshId);
        if (listed.ok) {
          discoveredNodeId = matchNodeByHostname(listed.nodes, hostname);
        }
      }
    } catch {
      discoveredNodeId = null;
    }
  }

  // Agent provisioning: no local agent + a configured mesh → the poll
  // carries the mesh-embedded installer URL for this machine's arch.
  const installUrl =
    meshAgentPresent === false && broker.provider !== "none" && broker.meshId
      ? agentInstallUrl(broker.controlUrl, broker.meshId, arch)
      : null;

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
      meshNodeId: meshNodeId ?? discoveredNodeId,
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
    // The linked agent node id (reported, previously linked, or just
    // discovered) — null until the installation is linked for assist.
    meshNodeId: meshNodeId ?? installation.meshNodeId ?? discoveredNodeId,
    // Mesh-embedded Windows installer URL when no local agent was
    // reported — null when the agent is present or provisioning is not
    // configured. The companion offers it as a download button.
    agentInstallUrl: installUrl,
  });
}
