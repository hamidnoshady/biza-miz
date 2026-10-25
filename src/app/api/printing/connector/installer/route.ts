import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { resolveDeploymentRole, type DeploymentEnv } from "@/lib/deployment-role";
import {
  businessHost,
  preferredProto,
  requestHost,
  rootDomain,
  subdomainRoutingEnabled,
  type HostEnv,
} from "@/lib/host";
import { listBusinessHostLabels } from "@/lib/host-resolution";
import { PERMISSIONS } from "@/lib/permissions";
import { connectorPayloadInfo } from "@/lib/printing/connector-payload";
import {
  buildConnectorDownloadUrl,
  CONNECTOR_RELEASE,
  connectorMinVersion,
  mergeAllowedOrigins,
  normalizeOrigin,
  resolveConnectorDownloadBase,
  type ConnectorReleaseEnv,
} from "@/lib/printing/connector-release";
import { buildWindowsPrintConnectorInstaller } from "@/lib/windows-print-connector";

export const runtime = "nodejs";

/**
 * Authenticated, tenant-origin-specific one-click installer for the Bizamiz
 * Windows Print Connector — the one hardware gateway for Windows printer
 * queues and network printers alike.
 *
 * The executable-looking download is a Windows command file containing only
 * built-in PowerShell setup code. It downloads the public connector source,
 * installs it per-user, starts it, and creates a Startup shortcut.
 *
 * The two addresses baked into it are *not* the same thing, and are resolved
 * independently:
 *
 *  - The connector's allowed origin(s): the browser-facing Bizamiz origin,
 *    taken from this request's host under the same host policy the tenant
 *    boundary uses (so it is already guaranteed to match the session's
 *    business), plus the business's other legitimate labels — the current
 *    subdomain and any rename aliases — so a renamed tenant's connector keeps
 *    working while bookmarks move over.
 *  - The connector's download URL: the stable platform base where the payload
 *    (a tenant-neutral file) actually lives — never an improvised tenant
 *    hostname. That separation is the fix for first-install failures where a
 *    tenant subdomain that the browser could resolve (DoH) could not be
 *    resolved by the Windows system resolver PowerShell uses.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const guard = await requirePermission(PERMISSIONS.settingsManage);
  if (guard.error) return guard.error;
  const session = guard.session;

  const host = requestHost(request.headers);
  if (!host) {
    return NextResponse.json({ ok: false, error: "installer_origin_unavailable" }, { status: 400 });
  }

  const env = process.env as ConnectorReleaseEnv;
  const protocol = preferredProto(request.headers.get("x-forwarded-proto"), request.nextUrl.protocol);
  const requestOrigin = normalizeOrigin(`${protocol}://${host}`);
  if (!requestOrigin) {
    return NextResponse.json({ ok: false, error: "installer_origin_invalid" }, { status: 400 });
  }

  // The connector's allowed-origin set. Two regimes:
  //
  //  - Host routing on (the SaaS): the allowed origins are the session
  //    business's own host labels — the current subdomain authoritative from
  //    the database, plus every alias left over from a rename — under
  //    ROOT_DOMAIN. The request's Host header only gates reachability: it
  //    must BE one of those labels, checked again here rather than trusted,
  //    because an allowed origin is exactly what the connector will serve
  //    print jobs from. `window.location.origin` reaches the connector only
  //    through this server-side validation, never verbatim.
  //  - Host routing off (single-café, desktop, LAN installs): the only
  //    meaningful origin is the one the browser used to reach this kiosk —
  //    the request origin itself (localhost, an IP:port, the café's custom
  //    domain), which is the whole deployment.
  //
  // Either way the result contains no fabricated `{label}.{domain}` and no
  // attacker-supplied value: every origin is either database-verified or is
  // the one address the operator demonstrably browses on.
  const root = rootDomain();
  const requestPort = host.match(/:(\d+)$/)?.[1];
  const labelOrigin = (label: string) =>
    `${protocol}://${businessHost(label, root ?? "")}${requestPort ? `:${requestPort}` : ""}`;

  let allowedOrigins: string[] | null = null;
  let origin = requestOrigin;
  if (root && subdomainRoutingEnabled(process.env as HostEnv)) {
    let labels: Awaited<ReturnType<typeof listBusinessHostLabels>> = null;
    try {
      labels = await listBusinessHostLabels(session.businessId);
    } catch {
      // The label lookup is redundant with middleware's session↔host pin; a
      // transient lookup failure degrades to the request origin alone.
    }
    if (labels?.subdomain) {
      // Canonical subdomain first — the original failure mode was installers
      // trusting whichever host answered, including stale alias names. Every
      // candidate is normalised through one origin parser, so scheme/host
      // casing, a redundant default port, or a trailing slash can never split
      // what DNS says is one origin into two.
      const knownOrigins = new Set<string>();
      for (const label of [labels.subdomain, ...labels.aliases]) {
        const normalized = normalizeOrigin(label ? labelOrigin(label) : null);
        if (normalized) knownOrigins.add(normalized);
      }
      if (!knownOrigins.has(requestOrigin)) {
        // The Host header names a tenant the session does not belong to
        // (middleware normally refuses first, so this fires only for callers
        // that reached the handler directly): refuse rather than mint an
        // installer for an origin this business cannot serve.
        return NextResponse.json({ ok: false, error: "installer_wrong_host" }, { status: 403 });
      }
      origin = normalizeOrigin(labelOrigin(labels.subdomain))!;
      try {
        const [, ...aliases] = [...knownOrigins.keys()];
        allowedOrigins = mergeAllowedOrigins(origin, aliases);
      } catch {
        return NextResponse.json({ ok: false, error: "installer_origin_invalid" }, { status: 400 });
      }
    }
  }
  if (!allowedOrigins) {
    allowedOrigins = [requestOrigin];
  }

  const downloadBase = resolveConnectorDownloadBase(env, origin);
  if (!downloadBase) {
    // An explicit CONNECTOR_DOWNLOAD_BASE_URL that is unusable is an operator
    // configuration error: report it clearly rather than silently generating
    // installers that download from a manufactured hostname.
    return NextResponse.json({ ok: false, error: "connector_download_unconfigured" }, { status: 500 });
  }

  let downloadUrl: string;
  try {
    downloadUrl = buildConnectorDownloadUrl(downloadBase.base);
  } catch {
    return NextResponse.json({ ok: false, error: "connector_download_unconfigured" }, { status: 500 });
  }

  // Integrity pinning: the SHA-256 of the payload this deployment ships is
  // safe to require whenever the download is answered by this very deployment
  // (its own origin, or any base on a central install — the platform serves
  // all tenant origins from the same build). A site install downloading from
  // its separately-versioned central server cannot assume byte-equality, so
  // there the installer relies on its structural validation alone.
  const payload = connectorPayloadInfo();
  const pinHash =
    payload && (downloadBase.source === "request-origin" || resolveDeploymentRole(process.env as DeploymentEnv).role === "central");

  const installer = buildWindowsPrintConnectorInstaller({
    allowedOrigins,
    downloadUrl,
    minVersion: connectorMinVersion(env),
    expectedSha256: pinHash ? payload.sha256 : null,
    expectedMinBytes: payload ? Math.trunc(payload.bytes * 0.75) : null,
    release: CONNECTOR_RELEASE,
  });

  return new NextResponse(installer, {
    status: 200,
    headers: {
      "Content-Type": "application/x-msdownload; charset=utf-8",
      "Content-Disposition": 'attachment; filename="Install-Bizamiz-Print-Connector.cmd"',
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      "X-Connector-Version": CONNECTOR_RELEASE,
    },
  });
});
