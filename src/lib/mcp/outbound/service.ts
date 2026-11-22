/**
 * External MCP servers: registration, discovery and invocation.
 *
 * Issue #1473, the second half of #1126 §B. The transport lives in `client.ts`
 * and the SSRF policy in `guard.ts`; this file is the part that knows a tenant,
 * a credential and an audit trail.
 *
 * Direction and boundaries, stated once:
 *
 *  - **Only enabled servers, only named tools.** A row has an `enabled` flag and
 *    an `allowed_tools` array (empty = everything discovery returned). Both are
 *    re-read on every call, so switching a server off takes effect on the next
 *    tool call rather than the next process.
 *  - **The URL is re-validated per call** through the client's guard. A row
 *    stored yesterday cannot outrun `MCP_OUTBOUND_ALLOWED_HOSTS` today.
 *  - **The credential is write-only.** It is encrypted with
 *    `src/lib/integrations/secrets.ts` on write, and no read path selects the
 *    ciphertext; `toSummary` has no field for it.
 *  - **Discovery is cached, calls are not.** `tools/list` is persisted so a model
 *    turn does not pay a network round-trip to build its catalogue; `tools/call`
 *    always goes to the server.
 *  - **Every call is recorded** in `mcp_external_calls` with an outcome, duration
 *    and error code — never the arguments or the result.
 *
 * There is deliberately no "trust this server" flag and no way to bypass the
 * allowlist from the database. A tenant can narrow what a server may do; the
 * deployment decides where a server may be.
 */
import type { OpenAiTool } from "@/lib/ai";
import type { ToolResult } from "@/lib/ai-tools";
import { query } from "@/lib/db";
import { decryptSecret, encryptSecret, resolveEncryptionKey } from "@/lib/integrations/secrets";

import { OutboundMcpClient, OutboundMcpError, type OutboundMcpTool } from "./client";
import { checkOutboundUrl, outboundPolicyFromEnv } from "./guard";
import {
  externalToolName,
  isExternalMcpToolName,
  MAX_SERVER_SLUG,
  parseExternalToolName,
  SERVER_SLUG_RE,
} from "./naming";

export {
  externalToolName,
  isExternalMcpToolName,
  MCP_EXTERNAL_NAME_SEPARATOR,
  MCP_EXTERNAL_TOOL_PREFIX,
  parseExternalToolName,
} from "./naming";

const MAX_DISCOVERED_TOOLS = 250;
const MAX_TOOL_DESCRIPTION = 900;
const MAX_ERROR_LENGTH = 300;

export type ExternalAuthKind = "bearer" | "none";

export interface ExternalMcpServerSummary {
  id: string;
  slug: string;
  label: string;
  url: string;
  authKind: ExternalAuthKind;
  enabled: boolean;
  allowedTools: string[];
  discoveredTools: OutboundMcpTool[];
  lastDiscoveredAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ExternalMcpFailure =
  | "invalid_slug"
  | "invalid_label"
  | "invalid_url"
  | "url_not_allowed"
  | "missing_credential"
  | "duplicate_slug"
  | "not_found"
  | "disabled"
  | "tool_not_allowed"
  | "not_discovered";

type Result<T> = { ok: true; data: T } | { ok: false; error: ExternalMcpFailure };


function encryptionKey(): Buffer {
  return resolveEncryptionKey(process.env);
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, MAX_ERROR_LENGTH);
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry)) : [];
}

function toTools(value: unknown): OutboundMcpTool[] {
  if (!Array.isArray(value)) return [];
  const tools: OutboundMcpTool[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : "";
    if (!name) continue;
    tools.push({
      description: typeof record.description === "string" ? record.description : undefined,
      inputSchema: record.inputSchema ?? { properties: {}, type: "object" },
      name,
      title: typeof record.title === "string" ? record.title : undefined,
    });
  }
  return tools;
}

/** The shape the API returns. There is deliberately no credential field. */
function toSummary(row: Record<string, unknown>): ExternalMcpServerSummary {
  return {
    allowedTools: toStringArray(row.allowed_tools),
    authKind: row.auth_kind === "bearer" ? "bearer" : "none",
    createdAt: new Date(String(row.created_at)).toISOString(),
    discoveredTools: toTools(row.discovered_tools),
    enabled: Boolean(row.enabled),
    id: String(row.id),
    label: String(row.label),
    lastDiscoveredAt: row.last_discovered_at ? new Date(String(row.last_discovered_at)).toISOString() : null,
    lastError: (row.last_error as string | null) ?? null,
    slug: String(row.slug),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
    url: String(row.url),
  };
}

const SUMMARY_COLUMNS =
  "id, slug, label, url, auth_kind, enabled, allowed_tools, discovered_tools, last_discovered_at, last_error, created_at, updated_at";

export async function listExternalMcpServers(businessId: string): Promise<ExternalMcpServerSummary[]> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT ${SUMMARY_COLUMNS} FROM mcp_external_servers WHERE business_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [businessId],
  );
  return rows.map(toSummary);
}

export async function getExternalMcpServer(
  businessId: string,
  id: string,
): Promise<ExternalMcpServerSummary | null> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT ${SUMMARY_COLUMNS} FROM mcp_external_servers WHERE business_id = $1 AND id = $2`,
    [businessId, id],
  );
  return rows[0] ? toSummary(rows[0]) : null;
}

export interface CreateExternalMcpServerInput {
  businessId: string;
  slug: string;
  label: string;
  url: string;
  authKind: ExternalAuthKind;
  /** Required when `authKind` is `bearer`; encrypted on write and never returned. */
  bearerToken?: string | null;
  enabled?: boolean;
  createdBy?: string | null;
}

export async function createExternalMcpServer(
  input: CreateExternalMcpServerInput,
): Promise<Result<ExternalMcpServerSummary>> {
  const slug = input.slug.trim().toLowerCase();
  if (!SERVER_SLUG_RE.test(slug) || slug.length > MAX_SERVER_SLUG) return { ok: false, error: "invalid_slug" };

  const label = input.label.trim();
  if (!label || label.length > 120) return { ok: false, error: "invalid_label" };

  // The synchronous half of the guard. The DNS half runs on every call, where a
  // resolution failure is a call failure rather than a save failure.
  const checked = checkOutboundUrl(input.url.trim(), outboundPolicyFromEnv());
  if (!checked.ok) {
    return { ok: false, error: checked.reason === "host_not_allowed" ? "url_not_allowed" : "invalid_url" };
  }

  const token = (input.bearerToken ?? "").trim();
  if (input.authKind === "bearer" && !token) return { ok: false, error: "missing_credential" };

  let ciphertext: string | null = null;
  if (input.authKind === "bearer") {
    try {
      ciphertext = encryptSecret(token, encryptionKey());
    } catch {
      // A deployment with no integration key must not store a plaintext secret:
      // refuse the write rather than fall back.
      return { ok: false, error: "missing_credential" };
    }
  }

  const { rows } = await query<{ id: string }>(
    `INSERT INTO mcp_external_servers
       (business_id, slug, label, url, auth_kind, bearer_token_ciphertext, enabled, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (business_id, slug) DO NOTHING
     RETURNING id`,
    [
      input.businessId,
      slug,
      label,
      checked.url.toString(),
      input.authKind,
      ciphertext,
      input.enabled === true,
      input.createdBy ?? null,
    ],
  );
  if (!rows[0]) return { ok: false, error: "duplicate_slug" };

  const created = await getExternalMcpServer(input.businessId, rows[0].id);
  return created ? { ok: true, data: created } : { ok: false, error: "not_found" };
}

export interface UpdateExternalMcpServerInput {
  businessId: string;
  id: string;
  label?: string;
  url?: string;
  authKind?: ExternalAuthKind;
  /**
   * `undefined` leaves the stored credential alone; `""` clears it. An empty
   * string from a form that renders the secret blank therefore means "unchanged"
   * only when the caller omits the field — the API layer decides which, and the
   * service treats `undefined` as unchanged.
   */
  bearerToken?: string | null;
  enabled?: boolean;
  allowedTools?: string[];
}

export async function updateExternalMcpServer(
  input: UpdateExternalMcpServerInput,
): Promise<Result<ExternalMcpServerSummary>> {
  const current = await getExternalMcpServer(input.businessId, input.id);
  if (!current) return { ok: false, error: "not_found" };

  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };

  if (input.label !== undefined) {
    const label = input.label.trim();
    if (!label || label.length > 120) return { ok: false, error: "invalid_label" };
    set("label", label);
  }

  if (input.url !== undefined) {
    const checked = checkOutboundUrl(input.url.trim(), outboundPolicyFromEnv());
    if (!checked.ok) {
      return { ok: false, error: checked.reason === "host_not_allowed" ? "url_not_allowed" : "invalid_url" };
    }
    set("url", checked.url.toString());
  }

  const nextAuth = input.authKind ?? current.authKind;

  if (input.bearerToken !== undefined) {
    const token = (input.bearerToken ?? "").trim();
    if (token) {
      try {
        set("bearer_token_ciphertext", encryptSecret(token, encryptionKey()));
      } catch {
        return { ok: false, error: "missing_credential" };
      }
    } else if (nextAuth === "bearer") {
      // Clearing the only credential of a bearer server would leave a row that can
      // never authenticate; refuse instead of storing a broken configuration.
      return { ok: false, error: "missing_credential" };
    } else {
      set("bearer_token_ciphertext", null);
    }
  }

  if (input.authKind !== undefined) {
    if (input.authKind === "bearer" && input.bearerToken === undefined && current.authKind !== "bearer") {
      return { ok: false, error: "missing_credential" };
    }
    set("auth_kind", input.authKind);
  }

  if (input.enabled !== undefined) set("enabled", input.enabled);

  if (input.allowedTools !== undefined) {
    const known = new Set(current.discoveredTools.map((tool) => tool.name));
    const requested = [...new Set(input.allowedTools.map((tool) => String(tool)))].filter((tool) => known.has(tool));
    set("allowed_tools", requested);
  }

  if (sets.length === 0) return { ok: true, data: current };

  params.push(input.businessId, input.id);
  const { rows } = await query<Record<string, unknown>>(
    `UPDATE mcp_external_servers
        SET ${sets.join(", ")}, updated_at = now()
      WHERE business_id = $${params.length - 1} AND id = $${params.length}
      RETURNING ${SUMMARY_COLUMNS}`,
    params,
  );
  return rows[0] ? { ok: true, data: toSummary(rows[0]) } : { ok: false, error: "not_found" };
}

/** Deleting removes the call history with it (FK cascade) — the row is the tenant's own. */
export async function deleteExternalMcpServer(businessId: string, id: string): Promise<boolean> {
  const { rowCount } = await query(
    `DELETE FROM mcp_external_servers WHERE business_id = $1 AND id = $2`,
    [businessId, id],
  );
  return (rowCount ?? 0) > 0;
}

async function credentialFor(row: Record<string, unknown>): Promise<string | null> {
  if (row.auth_kind !== "bearer") return null;
  const ciphertext = row.bearer_token_ciphertext;
  if (typeof ciphertext !== "string" || !ciphertext) return null;
  return decryptSecret(ciphertext, encryptionKey());
}

function clientFor(row: Record<string, unknown>, bearerToken: string | null): OutboundMcpClient {
  return new OutboundMcpClient({
    bearerToken,
    maxResponseBytes: 512 * 1024,
    policy: outboundPolicyFromEnv(),
    timeoutMs: 15_000,
    url: String(row.url),
  });
}

/**
 * Runs `initialize` + `tools/list` and persists the result.
 *
 * A failure is persisted as `last_error` (bounded, never the credential) and
 * returned, so an operator sees why a server is unusable instead of a UI that
 * silently lists nothing.
 */
export async function discoverExternalMcpServer(
  businessId: string,
  id: string,
): Promise<Result<{ server: ExternalMcpServerSummary; info: Awaited<ReturnType<OutboundMcpClient["initialize"]>> }>> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT * FROM mcp_external_servers WHERE business_id = $1 AND id = $2`,
    [businessId, id],
  );
  const row = rows[0];
  if (!row) return { ok: false, error: "not_found" };

  try {
    const bearerToken = await credentialFor(row);
    const client = clientFor(row, bearerToken);
    const info = await client.initialize();
    const tools = await client.listTools();

    // A discovery that returns nothing is a server that publishes nothing; it is
    // not an error, and storing the empty list is what makes the next turn honest.
    const bounded = tools.slice(0, MAX_DISCOVERED_TOOLS);

    const { rows: updated } = await query<Record<string, unknown>>(
      `UPDATE mcp_external_servers
          SET discovered_tools = $3::jsonb,
              last_discovered_at = now(),
              last_error = NULL,
              -- Dropping a tool from the server removes it from the local allowlist
              -- too, so a later re-add cannot silently resurrect authority.
              allowed_tools = array(
                SELECT unnest(allowed_tools) INTERSECT SELECT unnest($4::text[])
              ),
              updated_at = now()
        WHERE business_id = $1 AND id = $2
        RETURNING ${SUMMARY_COLUMNS}`,
      [businessId, id, JSON.stringify(bounded), bounded.map((tool) => tool.name)],
    );

    return updated[0]
      ? { ok: true, data: { info, server: toSummary(updated[0]) } }
      : { ok: false, error: "not_found" };
  } catch (error) {
    await query(
      `UPDATE mcp_external_servers SET last_error = $3, updated_at = now() WHERE business_id = $1 AND id = $2`,
      [businessId, id, boundedError(error)],
    ).catch(() => undefined);
    throw error;
  }
}

/**
 * The tools one business may show its assistant right now.
 *
 * Called per turn. Returns nothing unless the server is enabled and discovery has
 * run; the agent's own `allowed_tools` narrows it further, and the suite's
 * permission filter then applies `ai.use` to the resulting names.
 */
export async function externalToolsForTurn(
  businessId: string,
  options: { toolAllowlist?: readonly string[] | null } = {},
): Promise<OpenAiTool[]> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT slug, label, allowed_tools, discovered_tools
       FROM mcp_external_servers
      WHERE business_id = $1 AND enabled AND last_discovered_at IS NOT NULL
      ORDER BY created_at ASC
      LIMIT 20`,
    [businessId],
  );

  const allowlist = options.toolAllowlist && options.toolAllowlist.length > 0 ? new Set(options.toolAllowlist) : null;
  const tools: OpenAiTool[] = [];

  for (const row of rows) {
    const slug = String(row.slug);
    const label = String(row.label);
    const permitted = toStringArray(row.allowed_tools);
    for (const tool of toTools(row.discovered_tools)) {
      if (permitted.length > 0 && !permitted.includes(tool.name)) continue;
      const name = externalToolName(slug, tool.name);
      if (allowlist && !allowlist.has(name)) continue;
      tools.push({
        type: "function",
        function: {
          description: [`${label} (external MCP server)`, tool.title, tool.description]
            .filter(Boolean)
            .join(" — ")
            .slice(0, MAX_TOOL_DESCRIPTION),
          name,
          parameters:
            tool.inputSchema && typeof tool.inputSchema === "object"
              ? (tool.inputSchema as Record<string, unknown>)
              : { properties: {}, type: "object" },
        },
      });
    }
  }

  return tools;
}

export interface ExternalToolCallInput {
  businessId: string;
  /** The model-facing name, `mcp_<slug>__<tool>`. */
  name: string;
  args: Record<string, unknown>;
  actorUserId?: string | null;
}

/**
 * Executes one external tool call and records it.
 *
 * Everything is re-checked here rather than trusted from the catalogue: the
 * server row (enabled, still present), the per-tool allowlist and the remote
 * tool's existence at the server. A catalogue built a second ago is a
 * suggestion; this function is the decision.
 */
export async function callExternalMcpTool(input: ExternalToolCallInput): Promise<ToolResult> {
  const parsed = parseExternalToolName(input.name);
  if (!parsed) return { ok: false, data: { error: "ابزار خارجی نامعتبر است." } };

  const { rows } = await query<Record<string, unknown>>(
    `SELECT * FROM mcp_external_servers WHERE business_id = $1 AND slug = $2`,
    [input.businessId, parsed.slug],
  );
  const row = rows[0];
  if (!row) return { ok: false, data: { error: "سرور خارجی یافت نشد." } };
  if (!row.enabled) return { ok: false, data: { error: "این سرور خارجی غیرفعال است." } };

  const discovered = toTools(row.discovered_tools);
  // The remote name may contain characters the model-facing name had to sanitize,
  // so match on the sanitized form rather than the raw string.
  const remote = discovered.find((tool) => externalToolName(parsed.slug, tool.name) === input.name);
  if (!remote) return { ok: false, data: { error: "این ابزار در سرور خارجی وجود ندارد." } };

  const permitted = toStringArray(row.allowed_tools);
  if (permitted.length > 0 && !permitted.includes(remote.name)) {
    return { ok: false, data: { error: "این ابزار برای این کسب‌وکار مجاز نیست." } };
  }

  const started = Date.now();
  let status: "failed" | "ok" | "refused" = "failed";
  let errorCode: string | null = null;

  try {
    const bearerToken = await credentialFor(row);
    const client = clientFor(row, bearerToken);
    await client.initialize();
    const result = await client.callTool(remote.name, input.args ?? {});

    // `isError` is the server's own refusal: a tool answered, and said no. That is
    // recorded separately from a transport failure because only one of the two is
    // worth retrying.
    status = result.isError ? "refused" : "ok";
    if (result.isError) errorCode = "tool_reported_error";

    return { ok: !result.isError, data: { content: result.content, isError: result.isError } };
  } catch (error) {
    errorCode = error instanceof OutboundMcpError ? error.code : "unknown";
    return { ok: false, data: { error: "فراخوانی سرور خارجی ناموفق بود." } };
  } finally {
    await query(
      `INSERT INTO mcp_external_calls (business_id, server_id, tool_name, status, duration_ms, error_code, actor_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.businessId,
        row.id,
        remote.name,
        status,
        Math.max(0, Date.now() - started),
        errorCode,
        input.actorUserId ?? null,
      ],
    ).catch(() => undefined);
  }
}

/** Recent calls for the admin panel. No arguments or results are stored, so none are returned. */
export async function listExternalMcpCalls(
  businessId: string,
  options: { serverId?: string; limit?: number } = {},
): Promise<Array<{ id: string; serverId: string; toolName: string; status: string; durationMs: number | null; errorCode: string | null; createdAt: string }>> {
  const limit = Math.min(100, Math.max(1, options.limit ?? 25));
  const { rows } = await query<Record<string, unknown>>(
    `SELECT id, server_id, tool_name, status, duration_ms, error_code, created_at
       FROM mcp_external_calls
      WHERE business_id = $1 AND ($2::uuid IS NULL OR server_id = $2::uuid)
      ORDER BY created_at DESC
      LIMIT $3`,
    [businessId, options.serverId ?? null, limit],
  );
  return rows.map((row) => ({
    createdAt: new Date(String(row.created_at)).toISOString(),
    durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms),
    errorCode: (row.error_code as string | null) ?? null,
    id: String(row.id),
    serverId: String(row.server_id),
    status: String(row.status),
    toolName: String(row.tool_name),
  }));
}
