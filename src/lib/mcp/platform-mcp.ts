/**
 * Issue #883 wave 3 — the MCP surface for the SUPERADMIN console.
 *
 * The tenant MCP at /api/mcp is built on three pillars this realm must keep
 * strictly separate:
 *
 *   1. Its own credential family. Tenant tokens start with `posmcp_`; console
 *      tokens start with `pospmcp_`. Nothing on either side parses the other
 *      family's segment shape, so presentation can never cross realms.
 *   2. Its own authorization vocabulary. Tenant tools are gated by pos scopes
 *      and tenant permissions; console tools are gated per tool by a
 *      PlatformCapability — re-verified LIVE against the admin's role on every
 *      call, because a role demotion can never leave a token powerful.
 *   3. Its own audit surface into platform_audit_log; every tool call —
 *      including read calls involving tenant-bridged data — writes one row.
 *
 * Bridge scope: writes never happen here directly; everything runs through
 * the console's existing platform services (setBusinessStatus,
 * setBusinessFeature, …), so idempotency, validation and side effects are
 * whatever the console UI itself has — MCP adds no new authority.
 */
import { randomBytes, createHash } from "node:crypto";
import { query, withoutTenantScope } from "../db";
import { platformCan, type PlatformAdminRole, type PlatformCapability } from "../platform-admin";
import {
  queryBusinesses,
  setBusinessStatus,
  setBusinessFeature,
  listFeatureFlags,
  businessFeatures,
  getBusinessIdentity,
  queryAudit,
  querySupportTickets,
  getSupportTicket,
  addSupportMessage,
  updateSupportTicket,
  queryBugReports,
  getBugReport,
  SupportTicketNotFoundError,
} from "../platform-service";
import { validateTicketInput } from "../support-service";
import { platformAudit } from "../platform-auth";

const TOKEN_PREFIX = "pospmcp_";
export const PLATFORM_MCP_TOKEN_PREFIX = TOKEN_PREFIX;

/* ------------------------------------------------------------------------- */
/* Credential model                                                          */
/* ------------------------------------------------------------------------- */

export interface PlatformMcpConnection {
  id: string;
  adminId: string;
  adminName: string;
  adminRole: PlatformAdminRole;
  name: string;
  capabilities: PlatformCapability[];
  /** Plain list of business ids the credential may bridge into. null = whole
   * platform. Never exposed to callers; it queries before every call. */
  businessIds: string[] | null;
  status: "active" | "revoked";
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

/**
 * Authenticate a Bearer token against the console MCP table. Returns null for
 * every unresolvable shape — including tenant `posmcp_*` tokens, deliberately:
 * the parse failure is the firewall, not an error surface the client can
 * compare.
 */
export async function authenticatePlatformMcp(rawToken: string): Promise<PlatformMcpConnection | null> {
  if (!rawToken.startsWith(TOKEN_PREFIX)) return null;
  const hash = createHash("sha256").update(rawToken).digest("hex");
  return withoutTenantScope("platform-mcp auth", async () => {
    const { rows } = await query<{
      id: string;
      admin_id: string;
      admin_name: string;
      admin_role: PlatformAdminRole;
      name: string;
      capabilities: unknown;
      business_ids: unknown;
      last_used_at: string | null;
      expires_at: string | null;
      created_at: string;
      admin_active: boolean;
    }>(
      `SELECT c.id, c.admin_id, a.full_name AS admin_name, a.role AS admin_role,
              c.name, c.capabilities, c.business_ids, c.last_used_at, c.expires_at,
              c.created_at, a.is_active AS admin_active
         FROM platform_mcp_connections c
         JOIN platform_admins a ON a.id = c.admin_id
        WHERE c.token_hash = $1 AND c.status = 'active' AND (c.expires_at IS NULL OR c.expires_at > now())`,
      [hash],
    );
    const row = rows[0];
    if (!row || !row.admin_active) return null;
    const businessIds = Array.isArray(row.business_ids)
      ? (row.business_ids as unknown[]).filter((x): x is string => typeof x === "string")
      : null;
    query(
      `UPDATE platform_mcp_connections SET last_used_at = now() WHERE id = $1`,
      [row.id],
    ).catch(() => undefined);
    return {
      id: row.id,
      adminId: row.admin_id,
      adminName: row.admin_name,
      adminRole: row.admin_role,
      name: row.name,
      capabilities: Array.isArray(row.capabilities)
        ? (row.capabilities as PlatformCapability[])
        : [],
      businessIds,
      status: "active",
      lastUsedAt: row.last_used_at,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    };
  });
}

/** The caller-visible security gate: capability must be granted ON this
 * credential AND survivable on the admin's CURRENT role. A missing role-side
 * capability is the downgrade case issue #883 explicitly names. */
function platformMcpAllows(connection: PlatformMcpConnection, capability: PlatformCapability): boolean {
  return (
    connection.capabilities.includes(capability) && platformCan(connection.adminRole, capability)
  );
}

function scopeAllowsBusiness(connection: PlatformMcpConnection, businessId: string): boolean {
  return connection.businessIds === null || connection.businessIds.includes(businessId);
}

/* ------------------------------------------------------------------------- */
/* Tools                                                                     */
/* ------------------------------------------------------------------------- */

interface PlatformToolInput {
  businessId?: string;
  businessIds?: string[];
  flagKey?: string;
  enabled?: boolean;
  /** Business status is validated inside the calling tool (active|suspended
   * today) — widening the input type keeps support-ticket triage honest on
   * the same property name, like the console forms. */
  status?: string;
  search?: string;
  limit?: number;
  offset?: number;
  // Batch BK — the security/support surface (ticket + report + audit ids and
  // filters); support triage fields mirror the console's PATCH lanes.
  ticketId?: string;
  reportId?: string;
  body?: string;
  attachment?: string;
  priority?: string;
  category?: string;
  assignedAdminId?: string | null;
  adminId?: string;
  actionFamily?: string;
  entity?: string;
  createdFrom?: string;
  createdTo?: string;
  q?: string;
  page?: number;
  pageSize?: number;
}

export interface PlatformMcpTool {
  name: string;
  description: string;
  capability: PlatformCapability;
  /** Whether callers need to name business(es); bridges plan into one
   * business at a time so per-target results can attribute failure. */
  bridged: boolean;
  /**
   * High-risk step-up marker (billing/credits, restore, access/identity,
   * secrets, mass mutation, tenant deletion, financial posting/reversal,
   * large exports): the caller must pass `confirm: true` echoing an explicit
   * preview acceptance, or the call returns a preview instead of acting.
   */
  stepUp?: boolean;
  inputSchema: {
    type: "object";
    properties: Record<string, { type: string; enum?: string[]; description?: string }>;
    required?: string[];
  };
}

export const PLATFORM_MCP_TOOLS: PlatformMcpTool[] = [
  {
    name: "list_businesses",
    description: "Search the business directory by name, status or plan.",
    capability: "businesses.read",
    bridged: false,
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Name or phone fragment." },
        status: { type: "string", enum: ["active", "suspended", "archived"] },
        limit: { type: "number" },
        offset: { type: "number" },
      },
    },
  },
  {
    name: "get_business_identity",
    description: "Load one business's identity block (name, phone, industry, status, plan).",
    capability: "businesses.read",
    bridged: true,
    inputSchema: {
      type: "object",
      properties: { businessId: { type: "string" } },
      required: ["businessId"],
    },
  },
  {
    name: "list_feature_flags",
    description: "The deployment-wide feature-flag catalogue (global defaults).",
    capability: "features.write",
    bridged: false,
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_business_features",
    description: "Override state for one business's feature flags.",
    capability: "business.reports.read",
    bridged: true,
    inputSchema: {
      type: "object",
      properties: { businessId: { type: "string" } },
      required: ["businessId"],
    },
  },
  {
    name: "set_business_feature",
    description:
      "Enable or disable a feature flag for one business. Partners console's own setter: audited, validated, immediate.",
    capability: "features.write",
    bridged: true,
    inputSchema: {
      type: "object",
      properties: {
        businessId: { type: "string" },
        flagKey: { type: "string" },
        enabled: { type: "boolean" },
      },
      required: ["businessId", "flagKey", "enabled"],
    },
  },
  {
    name: "list_audit_log",
    description:
      "Query the platform audit log — filter by business, admin, action family (e.g. 'business' matches 'business.provision'), entity, free text or date range.",
    capability: "audit.read",
    bridged: false,
    inputSchema: {
      type: "object",
      properties: {
        businessId: { type: "string", description: "Filter to one tenant's rows." },
        adminId: { type: "string", description: "Filter to one platform admin." },
        actionFamily: { type: "string", description: "Prefix match, e.g. 'platform_mcp'." },
        entity: { type: "string" },
        search: { type: "string" },
        createdFrom: { type: "string" },
        createdTo: { type: "string" },
        page: { type: "number" },
        pageSize: { type: "number" },
      },
    },
  },
  {
    name: "list_bug_reports",
    description: "Search tenant bug reports by status or free text.",
    capability: "audit.read",
    bridged: false,
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string" },
        q: { type: "string" },
        businessId: { type: "string" },
        page: { type: "number" },
        pageSize: { type: "number" },
      },
    },
  },
  {
    name: "get_bug_report",
    description: "Load one bug report in full.",
    capability: "audit.read",
    bridged: false,
    inputSchema: {
      type: "object",
      properties: { reportId: { type: "string" } },
      required: ["reportId"],
    },
  },
  {
    name: "list_support_tickets",
    description: "Search the platform support desk by status, priority, category, assignee, business or text.",
    capability: "support.manage",
    bridged: false,
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string" },
        priority: { type: "string" },
        category: { type: "string" },
        assignedAdminId: { type: "string" },
        businessId: { type: "string" },
        q: { type: "string" },
        page: { type: "number" },
        pageSize: { type: "number" },
      },
    },
  },
  {
    name: "get_support_ticket",
    description: "Load one support ticket with its message thread.",
    capability: "support.manage",
    bridged: false,
    inputSchema: {
      type: "object",
      properties: { ticketId: { type: "string" } },
      required: ["ticketId"],
    },
  },
  {
    name: "reply_support_ticket",
    description: "Answer a support ticket as the credential's own admin. The console's reply rules apply: the reply moves the ticket to the admin-replied state.",
    capability: "support.manage",
    bridged: false,
    inputSchema: {
      type: "object",
      properties: {
        ticketId: { type: "string" },
        body: { type: "string", description: "Reply text, 1–4000 chars." },
      },
      required: ["ticketId", "body"],
    },
  },
  {
    name: "triage_support_ticket",
    description: "Change a ticket's status / priority / category / assignee — same write the console PATCH lane runs.",
    capability: "support.manage",
    bridged: false,
    inputSchema: {
      type: "object",
      properties: {
        ticketId: { type: "string" },
        status: { type: "string" },
        priority: { type: "string" },
        category: { type: "string" },
        assignedAdminId: { type: "string", description: "null unassigns." },
      },
      required: ["ticketId"],
    },
  },
  {
    name: "set_business_status",
    description: "Suspend or reactivate a business. Uses the console lifecycle service; audited.",
    capability: "business.suspend",
    bridged: true,
    inputSchema: {
      type: "object",
      properties: {
        businessId: { type: "string" },
        status: { type: "string", enum: ["suspended", "active"] },
      },
      required: ["businessId", "status"],
    },
  },
];

/** Catalogue bargaining: clients see exactly the tools their credential can run. */
export function platformMcpToolCatalogue(connection: PlatformMcpConnection): PlatformMcpTool[] {
  return PLATFORM_MCP_TOOLS.filter((tool) => platformMcpAllows(connection, tool.capability));
}

export async function callPlatformMcpTool(
  connection: PlatformMcpConnection,
  name: string,
  arg: PlatformToolInput,
): Promise<{ text: string; data: unknown }> {
  const tool = PLATFORM_MCP_TOOLS.find((t) => t.name === name);
  if (!tool) return { text: `Unknown platform tool '${name}'.`, data: null };
  if (!platformMcpAllows(connection, tool.capability)) {
    // Audited even on denial: an automated probe of boundaries must leave the
    // trace a probe deserves.
    await platformAuditSafe(connection, null, tool.name, "denied_capability", null);
    return { text: "denied: this credential lacks the capability for that tool.", data: null };
  }

  const targets: string[] = [];
  if (tool.bridged) {
    // Bridging always names targets explicitly — a FAIL-CLOSED rule. Passing
    // no businessId never widens to "all"; it errors.
    const requested = [
      ...(arg.businessId ? [arg.businessId] : []),
      ...(Array.isArray(arg.businessIds) ? arg.businessIds : []),
    ];
    if (requested.length === 0) {
      return { text: "This tool bridges into tenants: businessId (or businessIds) is required.", data: null };
    }
    for (const id of requested) {
      if (!scopeAllowsBusiness(connection, id)) {
        await platformAuditSafe(connection, id, tool.name, "denied_scope", { businessIds: requested });
        return { text: `denied: business ${id} is outside this credential's bridge list.`, data: null };
      }
      targets.push(id);
    }
  }

  const results: Record<string, unknown> = {};
  const started = Date.now();
  try {
    const data = await executePlatformTool(tool, arg, targets, results, connection);
    await platformAuditSafe(connection, targets[0] ?? null, tool.name, "ok", {
      targets: targets.length > 0 ? targets : undefined,
      elapsedMs: Date.now() - started,
    });
    return { text: JSON.stringify(data, null, 2), data };
  } catch (err) {
    await platformAuditSafe(connection, targets[0] ?? null, tool.name, "failed", {
      message: err instanceof Error ? err.message : String(err),
      targets,
    });
    throw err;
  }
}

/** Per-business batch invocation results: the "outcomes" map has exactly one
 * entry per requested business, ok or failed — never silently skipped. */
async function executePlatformTool(
  tool: PlatformMcpTool,
  arg: PlatformToolInput,
  targets: string[],
  results: Record<string, unknown>,
  connection: PlatformMcpConnection,
): Promise<unknown> {
  return withoutTenantScope(`platform-mcp tool ${tool.name}`, async () => {
    switch (tool.name) {
      case "list_businesses": {
        const result = await queryBusinesses({
          search: arg.search,
          status: arg.status as "active" | "suspended" | "archived" | undefined,
          page: Math.floor((arg.offset ?? 0) / Math.max(1, arg.limit ?? 50)) + 1,
          pageSize: Math.min(arg.limit ?? 50, 100),
        });
        return result;
      }
      case "get_business_identity": {
        for (const id of targets) results[id] = await getBusinessIdentity(id);
        return { perBusiness: results };
      }
      case "list_feature_flags":
        return { flags: await listFeatureFlags() };
      case "list_business_features": {
        for (const id of targets) results[id] = await businessFeatures(id);
        return { perBusiness: results };
      }
      case "set_business_feature": {
        for (const id of targets) {
          try {
            await setBusinessFeature(id, String(arg.flagKey), Boolean(arg.enabled));
            results[id] = { ok: true, flag: arg.flagKey, enabled: arg.enabled };
          } catch (err) {
            results[id] = { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        }
        return { perBusiness: results };
      }
      case "set_business_status": {
        if (arg.status !== "active" && arg.status !== "suspended") {
          throw new Error("status must be 'active' or 'suspended'");
        }
        for (const id of targets) {
          try {
            const result = await setBusinessStatus(id, arg.status);
            results[id] = result ? { ok: true, status: arg.status } : { ok: false, error: "not_found" };
          } catch (err) {
            results[id] = { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        }
        return { perBusiness: results };
      }
      // ── Batch BK — security desk: audit + bug reports (audit.read) ────────
      case "list_audit_log": {
        return await queryAudit({
          businessId: arg.businessId,
          adminId: arg.adminId,
          actionFamily: arg.actionFamily,
          entity: arg.entity,
          search: arg.search,
          createdFrom: arg.createdFrom,
          createdTo: arg.createdTo,
          page: arg.page ?? 1,
          pageSize: arg.pageSize ?? arg.limit ?? 40,
        });
      }
      case "list_bug_reports": {
        return await queryBugReports({
          status: arg.status ?? "",
          search: arg.q ?? arg.search ?? "",
          businessId: arg.businessId,
          page: arg.page ?? 1,
          pageSize: arg.pageSize ?? arg.limit ?? 40,
        });
      }
      case "get_bug_report": {
        if (!arg.reportId) throw new Error("reportId is required");
        return await getBugReport(arg.reportId);
      }
      // ── Batch BK — the support desk (support.manage) ──────────────────────
      case "list_support_tickets": {
        return await querySupportTickets({
          status: arg.status,
          priority: arg.priority,
          category: arg.category,
          search: arg.q ?? arg.search,
          businessId: arg.businessId,
          adminId: arg.adminId,
          page: arg.page ?? 1,
          pageSize: arg.pageSize ?? arg.limit ?? 40,
        });
      }
      case "get_support_ticket": {
        if (!arg.ticketId) throw new Error("ticketId is required");
        return await getSupportTicket(arg.ticketId);
      }
      case "reply_support_ticket": {
        if (!arg.ticketId) throw new Error("ticketId is required");
        const text = (arg.body ?? "").trim();
        const attachment = typeof arg.attachment === "string" ? arg.attachment : null;
        const validation = validateTicketInput({ body: text, attachment });
        if (validation.error) throw new Error(validation.error);
        try {
          // The route posts as the session admin; the bridge posts as the
          // credential's own admin — never a claimed id from the payload.
          return await addSupportMessage({
            ticketId: arg.ticketId,
            adminId: connection.adminId,
            body: text,
            attachment,
          });
        } catch (err) {
          if (err instanceof SupportTicketNotFoundError) throw new Error("not_found");
          throw err;
        }
      }
      case "triage_support_ticket": {
        if (!arg.ticketId) throw new Error("ticketId is required");
        try {
          const ticket = await updateSupportTicket({
            ticketId: arg.ticketId,
            adminId: connection.adminId,
            status: arg.status,
            priority: arg.priority,
            category: arg.category,
            assignedAdminId: arg.assignedAdminId,
          });
          if (!ticket) throw new Error("not_found");
          return ticket;
        } catch (err) {
          if (err instanceof SupportTicketNotFoundError) throw new Error("not_found");
          throw err;
        }
      }
      default:
        throw new Error(`No implementation for platform tool '${tool.name}'.`);
    }
  });
}

async function platformAuditSafe(
  connection: PlatformMcpConnection,
  businessId: string | null,
  tool: string,
  outcome: string,
  payload: Record<string, unknown> | null,
): Promise<void> {
  try {
    await platformAudit({
      adminId: connection.adminId,
      businessId,
      action: "platform_mcp.call",
      entity: "platform_mcp_connection",
      entityId: connection.id,
      payload: { tool, outcome, ...(payload ?? {}) },
    });
  } catch {
    // platformAudit is deliberately loud on failure — but an audit outage must
    // not crash the MCP client; the audit route's loudness lives elsewhere.
  }
}

/* ------------------------------------------------------------------------- */
/* Credential management service (owner-only from the console UI)            */
/* ------------------------------------------------------------------------- */

export function createPlatformMcpToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(24).toString("hex")}`;
}

export async function listPlatformMcpConnections(): Promise<PlatformMcpConnection[]> {
  return withoutTenantScope("platform-mcp list", async () => {
    const { rows } = await query<{
      id: string;
      admin_id: string;
      admin_name: string;
      admin_role: PlatformAdminRole;
      name: string;
      capabilities: unknown;
      business_ids: unknown;
      last_used_at: string | null;
      expires_at: string | null;
      created_at: string;
      status: "active" | "revoked";
    }>(
      `SELECT c.id, c.admin_id, a.full_name AS admin_name, a.role AS admin_role,
              c.name, c.capabilities, c.business_ids, c.last_used_at, c.expires_at,
              c.created_at, c.status
         FROM platform_mcp_connections c
         JOIN platform_admins a ON a.id = c.admin_id
        ORDER BY c.created_at DESC`,
    );
    return rows.map((row) => ({
      id: row.id,
      adminId: row.admin_id,
      adminName: row.admin_name,
      adminRole: row.admin_role,
      name: row.name,
      capabilities: (Array.isArray(row.capabilities) ? row.capabilities : []) as PlatformCapability[],
      businessIds: Array.isArray(row.business_ids) ? (row.business_ids as string[]) : null,
      status: row.status,
      lastUsedAt: row.last_used_at,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    }));
  });
}

export async function createPlatformMcpConnection(input: {
  adminId: string;
  name: string;
  capabilities: PlatformCapability[];
  /** Restrict bridging to specific businesses; null = whole platform. */
  businessIds?: string[] | null;
  expiresInDays?: number | null;
}): Promise<{ connection: PlatformMcpConnection; token: string }> {
  const token = createPlatformMcpToken();
  const hash = createHash("sha256").update(token).digest("hex");
  return withoutTenantScope("platform-mcp create", async () => {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO platform_mcp_connections
         (admin_id, name, token_hash, capabilities, business_ids, expires_at)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb,
               CASE WHEN $6::numeric IS NULL THEN NULL ELSE now() + ($6 || ' days')::interval END)
       RETURNING id`,
      [
        input.adminId,
        input.name.trim().slice(0, 120),
        hash,
        JSON.stringify(input.capabilities),
        input.businessIds == null ? null : JSON.stringify(input.businessIds),
        input.expiresInDays ?? null,
      ],
    );
    const all = await listPlatformMcpConnections();
    const connection = all.find((c) => c.id === rows[0].id);
    if (!connection) throw new Error("Platform MCP connection minted but not visible.");
    return { connection, token };
  });
}

export async function revokePlatformMcpConnection(id: string): Promise<boolean> {
  return withoutTenantScope("platform-mcp revoke", async () => {
    const { rowCount } = await query(
      `UPDATE platform_mcp_connections SET status = 'revoked', revoked_at = now()
        WHERE id = $1 AND status = 'active'`,
      [id],
    );
    return (rowCount ?? 0) > 0;
  });
}
