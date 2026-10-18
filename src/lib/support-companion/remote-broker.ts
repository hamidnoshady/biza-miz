/**
 * Issue #984 — remote-assistance engine broker (self-hosted MeshCentral).
 *
 * Attended sessions need a real media/input transport. The broker mints a
 * short-lived MeshCentral *device share link* per approved session and
 * revokes it when the session ends — the operator opens the returned guest
 * URL in their browser; the agent side needs no inbound ports (the Mesh
 * agent already holds an outbound connection to the MeshCentral server).
 *
 * Wire protocol (verified against MeshCentral's own reference client,
 * `meshctrl.js` — `DeviceSharing` command):
 *   - transport: `wss://{host}/control.ashx` with header
 *     `x-meshauth: base64(user),base64(pass)`;
 *   - create: `{action:'createDeviceShareLink', nodeid, guestname, p,
 *     consent, start, end, viewOnly, responseid}` →
 *     `{action:'createDeviceShareLink', result:'OK', publicid, url}`;
 *   - revoke: `{action:'removeDeviceShare', nodeid, publicid, responseid}`.
 * Share-type bits: terminal=1, desktop=2, files=4. Consent bits:
 * desktop-notify=0x1, terminal-notify=0x2, files-notify=0x4,
 * desktop-prompt=0x8, terminal-prompt=0x10, files-prompt=0x20,
 * desktop-toolbar=0x40.
 *
 * Least-privilege mapping: shares are desktop-only (`p=2`) — this product
 * has no terminal/files caps, so the broker never exposes them. Consent is
 * always desktop-notify + connection-toolbar (`0x41`): the customer already
 * approved locally with proof (recordLocalConsent), so MeshCentral does not
 * double-prompt, but the agent user always sees the banner and toolbar.
 * View-only sessions set `viewOnly`; control/elevation sessions do not
 * (elevation itself is enforced by our consent/lease layer, not the wire).
 *
 * Unconfigured (`MESHCENTRAL_URL` unset) or unreachable servers fail closed:
 * `operatorJoinSession` refuses and the session stays `approved` — there are
 * no fake "connected" sessions. Revocation is best-effort with a time-limit
 * backstop: shares always carry an `end`, so a failed revoke call still dies
 * at expiry, and the failure is journaled as `engine_revoke_failed`.
 */
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { SupportAssistanceCap } from "./types";

export interface RemoteBrokerConfig {
  provider: "meshcentral";
  /** Full control-channel URL, e.g. `wss://mesh.example.com/control.ashx`. */
  controlUrl: string;
  username: string;
  password: string;
  allowSelfSignedTls: boolean;
  /**
   * Device-group id for agent node discovery (`MESHCENTRAL_MESH_ID`).
   * Empty disables discovery: shares still bind/revoke against ids the
   * companion reports, but hostname matching never runs.
   */
  meshId: string;
}

export type ResolvedRemoteBroker = { provider: "none" } | RemoteBrokerConfig;

export function resolveRemoteBrokerConfig(
  env: Record<string, string | undefined> = process.env,
): ResolvedRemoteBroker {
  const rawUrl = env.MESHCENTRAL_URL?.trim();
  if (!rawUrl) return { provider: "none" };
  const username = env.MESHCENTRAL_USER?.trim() ?? "";
  const password = env.MESHCENTRAL_PASS ?? "";
  if (!username || !password) {
    throw new Error("MESHCENTRAL_USER and MESHCENTRAL_PASS are required when MESHCENTRAL_URL is set");
  }
  let controlUrl: string;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "wss:" && parsed.protocol !== "ws:" &&
        parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("bad protocol");
    }
    parsed.protocol = parsed.protocol === "http:" || parsed.protocol === "ws:" ? "ws:" : "wss:";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    if (!parsed.pathname.endsWith("/control.ashx")) {
      parsed.pathname = `${parsed.pathname === "/" ? "" : parsed.pathname}/control.ashx`;
    }
    parsed.search = "";
    parsed.hash = "";
    controlUrl = parsed.toString();
  } catch {
    throw new Error("MESHCENTRAL_URL must be a valid http(s)/ws(s) URL");
  }
  return {
    provider: "meshcentral",
    controlUrl,
    username,
    password,
    allowSelfSignedTls: env.MESHCENTRAL_ALLOW_SELF_SIGNED_TLS === "true",
    meshId: env.MESHCENTRAL_MESH_ID?.trim() ?? "",
  };
}

// ── Capability → share mapping ───────────────────────────────────────────────

export interface ShareParams {
  /** MeshCentral share-type bitmask — always desktop-only (2). */
  p: 2;
  viewOnly: boolean;
  /** Desktop-notify + connection-toolbar (0x1 | 0x40). */
  consent: 0x41;
}

export function shareParamsForCaps(approvedCaps: readonly SupportAssistanceCap[]): ShareParams {
  const viewOnly = !approvedCaps.includes("control") && !approvedCaps.includes("elevation");
  return { p: 2, viewOnly, consent: 0x41 };
}

// ── Share lifecycle ──────────────────────────────────────────────────────────

export interface EngineBindRequest {
  nodeId: string;
  /** Guest label shown in MeshCentral — ticket/session ids, never PII. */
  guestName: string;
  viewOnly: boolean;
  /** Share lifetime in minutes (clamped to 1..120). */
  minutes: number;
  nowSeconds?: number;
}

export interface EngineBindingRecord {
  provider: "meshcentral";
  nodeId: string;
  /** MeshCentral share identifier (`publicid`) — what revoke needs. */
  shareId: string;
  viewOnly: boolean;
  startsAt: string;
  endsAt: string;
}

/**
 * One control-channel round trip. Injected in tests; production uses
 * {@link meshcentralTransport}.
 */
export type BrokerTransport = (
  config: RemoteBrokerConfig,
  message: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export const BROKER_ROUNDTRIP_TIMEOUT_MS = 15_000;

export async function meshcentralTransport(
  config: RemoteBrokerConfig,
  message: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const responseid = `biza-${randomUUID()}`;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // Already gone; the result is what matters.
      }
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error("meshcentral_timeout")));
    }, BROKER_ROUNDTRIP_TIMEOUT_MS);
    const auth = `${Buffer.from(config.username, "utf8").toString("base64")},${Buffer.from(config.password, "utf8").toString("base64")}`;
    const ws = new WebSocket(config.controlUrl, {
      headers: { "x-meshauth": auth },
      rejectUnauthorized: !config.allowSelfSignedTls,
    });
    ws.on("open", () => {
      ws.send(JSON.stringify({ ...message, responseid }));
    });
    ws.on("message", (raw) => {
      let data: Record<string, unknown> | null = null;
      try {
        data = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      // The channel also pushes unsolicited events (serverinfo, events);
      // only the matching responseid completes this round trip.
      // removeDeviceShare first echoes the request back with our
      // responseid but no `result` field — the verdict arrives in a second
      // message, so for the share actions result-less matches are skipped,
      // not resolved. (Observed live against MeshCentral 1.2.5; see docs
      // §3.) Other actions (e.g. `nodes`) answer result-less by design, so
      // the gate is action-aware, not blanket.
      if (data.responseid !== responseid) return;
      const verdict =
        message.action === "createDeviceShareLink" || message.action === "removeDeviceShare";
      if (verdict && !("result" in data)) return;
      finish(() => resolve(data));
    });
    ws.on("error", (err) => {
      finish(() => reject(err instanceof Error ? err : new Error("meshcentral_unreachable")));
    });
    ws.on("close", () => {
      finish(() => reject(new Error("meshcentral_unreachable")));
    });
  });
}

export type CreateBrokerShareResult =
  | { ok: true; binding: EngineBindingRecord; operatorUrl: string }
  | { ok: false; error: "provider_not_configured" | "provider_unreachable" | "provider_error"; detail?: string };

export async function createBrokerShare(
  broker: ResolvedRemoteBroker,
  req: EngineBindRequest,
  transport: BrokerTransport = meshcentralTransport,
): Promise<CreateBrokerShareResult> {
  if (broker.provider === "none") return { ok: false, error: "provider_not_configured" };
  if (!req.nodeId.trim() || !req.guestName.trim()) {
    return { ok: false, error: "provider_error", detail: "node_and_guest_required" };
  }
  const minutes = Math.min(120, Math.max(1, Math.floor(req.minutes) || 15));
  const now = req.nowSeconds ?? Math.floor(Date.now() / 1000);
  const start = now;
  const end = now + minutes * 60;
  let data: Record<string, unknown>;
  try {
    data = await transport(broker, {
      action: "createDeviceShareLink",
      nodeid: req.nodeId,
      guestname: req.guestName.slice(0, 64),
      p: 2,
      consent: 0x41,
      start,
      end,
      viewOnly: req.viewOnly,
    });
  } catch (err) {
    return {
      ok: false,
      error: "provider_unreachable",
      detail: err instanceof Error ? err.message.slice(0, 200) : undefined,
    };
  }
  if (data.result !== "OK" || typeof data.publicid !== "string" || typeof data.url !== "string") {
    return {
      ok: false,
      error: "provider_error",
      detail: typeof data.result === "string" ? data.result.slice(0, 200) : "bad_response",
    };
  }
  return {
    ok: true,
    binding: {
      provider: "meshcentral",
      nodeId: req.nodeId,
      shareId: data.publicid,
      viewOnly: req.viewOnly,
      startsAt: new Date(start * 1000).toISOString(),
      endsAt: new Date(end * 1000).toISOString(),
    },
    operatorUrl: data.url,
  };
}

export type RevokeBrokerShareResult =
  | { ok: true }
  | { ok: false; error: "provider_not_configured" | "provider_unreachable" | "provider_error"; detail?: string };

export async function revokeBrokerShare(
  broker: ResolvedRemoteBroker,
  binding: Pick<EngineBindingRecord, "nodeId" | "shareId">,
  transport: BrokerTransport = meshcentralTransport,
): Promise<RevokeBrokerShareResult> {
  if (broker.provider === "none") return { ok: false, error: "provider_not_configured" };
  let data: Record<string, unknown>;
  try {
    data = await transport(broker, {
      action: "removeDeviceShare",
      nodeid: binding.nodeId,
      publicid: binding.shareId,
    });
  } catch (err) {
    return {
      ok: false,
      error: "provider_unreachable",
      detail: err instanceof Error ? err.message.slice(0, 200) : undefined,
    };
  }
  // Revoking an already-gone share reports "Invalid device share
  // identifier." — not OK. That is still the desired end state (no live
  // share), and the §3 checklist requires operator-revoke + customer-Stop
  // races to land without a spurious engine_revoke_failed, so it resolves
  // success. Anything else is an honest failure the caller journals (the
  // share's `end` remains the backstop).
  if (data.result !== "OK") {
    const result = typeof data.result === "string" ? data.result : "";
    if (result.startsWith("Invalid device share")) {
      return { ok: true };
    }
    return {
      ok: false,
      error: "provider_error",
      detail: result ? result.slice(0, 200) : "bad_response",
    };
  }
  return { ok: true };
}

// ── Agent node discovery ─────────────────────────────────────────────────────

export interface MeshNodeInfo {
  nodeId: string;
  name: string;
  host: string;
  connected: boolean;
}

export type ListMeshNodesResult =
  | { ok: true; nodes: MeshNodeInfo[] }
  | { ok: false; error: "provider_not_configured" | "provider_unreachable" | "provider_error"; detail?: string };

/**
 * Lists the agent nodes visible in one device group (`{action:'nodes'}`,
 * answered result-less by design). Powers hostname discovery on the
 * companion poll; never used for authorization, only for linking.
 */
export async function listMeshNodes(
  broker: ResolvedRemoteBroker,
  meshId: string,
  transport: BrokerTransport = meshcentralTransport,
): Promise<ListMeshNodesResult> {
  if (broker.provider === "none") return { ok: false, error: "provider_not_configured" };
  if (!meshId.trim()) return { ok: false, error: "provider_not_configured" };
  let data: Record<string, unknown>;
  try {
    data = await transport(broker, { action: "nodes", meshid: meshId });
  } catch (err) {
    return {
      ok: false,
      error: "provider_unreachable",
      detail: err instanceof Error ? err.message.slice(0, 200) : undefined,
    };
  }
  const byMesh = data.nodes;
  if (typeof byMesh !== "object" || byMesh === null) {
    // The error path DOES carry `result` (e.g. "Invalid group id");
    // surface it instead of a generic bad_response.
    const result = typeof data.result === "string" && data.result ? data.result : "bad_response";
    return { ok: false, error: "provider_error", detail: result.slice(0, 200) };
  }
  const nodes: MeshNodeInfo[] = [];
  for (const list of Object.values(byMesh as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      if (typeof record._id !== "string" || !record._id) continue;
      nodes.push({
        nodeId: record._id,
        name: typeof record.name === "string" ? record.name : "",
        host: typeof record.host === "string" ? record.host : "",
        connected: record.conn === 1,
      });
    }
  }
  return { ok: true, nodes };
}

const meshNodesCache = new Map<string, { at: number; nodes: MeshNodeInfo[] }>();

export const MESH_NODES_CACHE_TTL_MS = 60_000;

/** Test hook: drops the node-list cache between cases. */
export function resetMeshNodesCacheForTests(): void {
  meshNodesCache.clear();
}

/**
 * Cached `listMeshNodes`: the poll calls this per contact, and the agent
 * fleet does not churn second-to-second. Failures are never cached — the
 * next poll retries.
 */
export async function listMeshNodesCached(
  broker: ResolvedRemoteBroker,
  meshId: string,
  transport: BrokerTransport = meshcentralTransport,
  nowMs: number = Date.now(),
): Promise<ListMeshNodesResult> {
  const key = broker.provider === "none" ? "none" : `${broker.controlUrl}\n${meshId}`;
  const hit = meshNodesCache.get(key);
  if (hit && nowMs - hit.at < MESH_NODES_CACHE_TTL_MS) {
    return { ok: true, nodes: hit.nodes };
  }
  const listed = await listMeshNodes(broker, meshId, transport);
  if (listed.ok) {
    meshNodesCache.set(key, { at: nowMs, nodes: listed.nodes });
  }
  return listed;
}

/**
 * Matches a poll-reported hostname to exactly one agent node (case- and
 * whitespace-insensitive on the agent's `name`). Zero or ambiguous
 * matches return null — discovery refuses to guess, and the operator
 * links the node by hand from the console instead.
 */
export function matchNodeByHostname(nodes: readonly MeshNodeInfo[], hostname: string): string | null {
  const want = hostname.trim().toLowerCase();
  if (!want) return null;
  const hits = nodes.filter((node) => node.name.trim().toLowerCase() === want);
  if (hits.length !== 1) return null;
  return hits[0].nodeId;
}

// ── Agent provisioning ───────────────────────────────────────────────────────

export type AgentArch = "x64" | "x86" | "arm64";

/** MeshCentral agent binary ids for the Windows service builds. */
const AGENT_BINARY_IDS: Record<AgentArch, number> = { x64: 4, x86: 3, arm64: 43 };

/**
 * Maps a companion-reported OS architecture name to a Windows agent
 * build. Unknown values fall back to x64 (the fleet's common case);
 * the operator still sees a working installer, not an error.
 */
export function agentArchFromName(name: string | null | undefined): AgentArch {
  const normalized = (name ?? "").trim().toLowerCase();
  if (normalized === "x86" || normalized === "arm") return "x86";
  if (normalized === "arm64") return "arm64";
  return "x64";
}

/**
 * Builds the MeshCentral Windows installer URL for a mesh, in the exact
 * shape the server's own invite page uses (`meshagents?id=<bin>&
 * meshid=<bare token>`, installflags omitted = 0 = background &
 * interactive). The mesh id is stored full (`mesh/<domain>/<token>`,
 * the form the `nodes` action requires); the download route wants the
 * bare token, so the prefix is stripped (tokens escape `/` as `$`,
 * so cutting at the last slash is safe).
 *
 * Returns null when provisioning is not configured (no mesh id) or the
 * control URL is unparseable — the companion then shows guidance text
 * instead of a download button. Proven live: HTTP 200, ~3.5 MB
 * win64 exe with the mesh embedded (MeshCentral 1.2.5).
 */
export function agentInstallUrl(
  controlUrl: string,
  meshId: string,
  arch: AgentArch = "x64",
): string | null {
  const token = meshId.includes("/") ? (meshId.split("/").pop() ?? "") : meshId;
  if (!token.trim()) return null;
  let origin: string;
  try {
    const control = new URL(controlUrl);
    if (control.protocol !== "wss:" && control.protocol !== "ws:") return null;
    control.protocol = control.protocol === "wss:" ? "https:" : "http:";
    // Keep any subpath prefix (control.ashx at the root or below it).
    const prefix = control.pathname.replace(/\/control\.ashx\/?$/, "").replace(/\/$/, "");
    origin = `${control.origin}${prefix}`;
  } catch {
    return null;
  }
  return `${origin}/meshagents?id=${AGENT_BINARY_IDS[arch]}&meshid=${encodeURIComponent(token)}`;
}
