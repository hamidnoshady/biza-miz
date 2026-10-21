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
// Batch BL — the Billing Control Center. Every verb rides the console's own
// services with the capability the route demands, and the money/price-policy
// writes are stepUp like their consoles.
import {
  listBillingPlans,
  saveBillingPlan,
  activatePlan,
  retirePlan,
  deleteDraftPlan,
  listFeatureCatalogue,
  listPlanFeatures,
  savePlanFeature,
  deletePlanFeature,
  listEntitlements,
  grantEntitlement,
  revokeEntitlement,
} from "../billing-plans-service";
import {
  listSubscriptions,
  listInvoices,
  voidBillingInvoice,
  applyInvoicePayment,
  changeBusinessPlan,
  cancelBusinessSubscription,
  reactivateBusinessSubscription,
  setAutoRenew,
} from "../subscription-service";
import {
  listPayments,
  saveCreditPackage,
  grantCredits,
  deductCredits,
  getWallet,
} from "../wallet-service";
import { reviewManualPayment } from "../billing-service";
import {
  listSpendPolicies,
  getSpendPolicy,
  evaluateBusinessSpend,
  saveSpendPolicy,
  readCommercialSettings,
  saveCommercialSettings,
} from "../billing/runtime";
import { getPublicMessageConfig, saveMessageRates } from "../messaging-billing";
import { getMediaConfig, saveMediaTariff } from "../media-service";
import { validateMediaTariffInput } from "../media";
import { getAiCostingConfig, saveAiCostingConfig } from "../ai-gateway-service";
// Batch BM — tenant lifecycle: provisioning, identity edits, and the typed-
// phrase destructive lanes (reset / hard delete), all via the console's own
// services with the same guards the routes enforce.
import {
  provisionBusiness,
  validateProvisionBody,
  shouldCompleteSetupForPlatformProvision,
} from "../business-provisioning";
import {
  resetBusiness,
  hardDeleteBusiness,
  getBusiness,
  renameBusinessSubdomain,
  updateBusiness,
  systemStatus,
} from "../platform-service";
import { businessDestructivePhrase } from "../platform-admin";
import { listPairingCodes, listPairingLocations } from "../pairing-service";
import { listSiteDevices } from "../site-device-service";
// Batch BN2 — the last exception rows: exception-inbox reads, per-business
// app availability, and the access-control revocations (mirroring the
// revoke_entitlement doctrine: withdrawing access is honest ops; issuing it
// stays console-side).
import {
  businessAppAvailability,
  setBusinessAppAvailability,
} from "../app-availability-service";
import { appForKey } from "../apps";
import { updatePlatformAdmin } from "../platform-service";
// Batch BN — support content (the platform's own knowledge base), the CMS
// fleet's read lanes, the backup backup/restore console's safe verbs, and the
// system/observability dials. All service-backed; credential-shaped lanes
// (site API keys, backup restore tokens, release channels) stay console-side.
import {
  adminListKbArticles,
  adminCreateKbArticle,
  adminUpdateKbArticle,
  adminDeleteKbArticle,
  adminCreateKbCategory,
  adminUpdateKbCategory,
  adminDeleteKbCategory,
  adminCreateKbTag,
  adminUpdateKbTag,
  adminDeleteKbTag,
} from "../knowledge-service";
import {
  listMirroredCmsSites,
  resolvePlatformCmsConfig,
  listCmsSyncRuns,
} from "../cms/platform-control-service";
import {
  fetchCmsRoutingTable,
  fetchCmsThemePackages,
  fetchCmsDeployTargets,
} from "../cms/platform-client";
import { provisionSite, issueSiteApiKey } from "../cms/client";
import { runCmsMirror } from "../cms/platform-sync";
import { getMigrationStatus } from "../migration-status-service";
import { observabilityConfig, zoHealth } from "../observability";
import {
  listPlatformBackupRuns,
  getPlatformBackupHealth,
  runPlatformBackupNow,
} from "../platform-backup-service";
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
  // Batch BL — billing lanes.
  planKey?: string;
  name?: string;
  description?: string | null;
  monthlyPriceRial?: number | null;
  monthlyAiCreditRial?: number | null;
  sortOrder?: number;
  trialDays?: number;
  graceDays?: number;
  limits?: Record<string, unknown>;
  featureKey?: string;
  pricingModel?: "included" | "monthly" | "per_use" | "addon";
  priceRial?: number;
  freeUntil?: string | null;
  freeLimit?: number | null;
  expiresAt?: string | null;
  activeOnly?: boolean;
  isActive?: boolean;
  creditRial?: number;
  note?: string;
  amountRial?: number;
  invoiceId?: string;
  paymentId?: string;
  action?: string;
  atPeriodEnd?: boolean;
  autoRenew?: boolean;
  group?: "messaging" | "media" | "ai";
  values?: Record<string, unknown>;
  monthlyBudgetRial?: number | null;
  actionAtLimit?: string;
  thresholds?: number[];
  withLines?: boolean;
  id?: string;
  invoicePrefix?: string;
  defaultDueDays?: number;
  defaultGraceDays?: number;
  rounding?: "ceil" | "floor";
  minimumTopUpRial?: number;
  overagePolicy?: "charge" | "block";
  prorationPolicy?: "none" | "daily";
  defaultSpendAction?: string;
  invoiceFooter?: string;
  taxRateBps?: number;
  // Batch BM — tenant lifecycle inputs.
  businessName?: string;
  ownerName?: string;
  email?: string;
  subdomain?: string;
  ownerPhone?: string;
  industry?: string;
  plan?: string;
  confirmExistingOwner?: boolean;
  timezone?: string;
  confirmation?: string;
  // Batch BN — generic record-shaped writes (knowledge builder, CMS sites).
  record?: Record<string, unknown>;
  categoryId?: string;
  query?: string;
  // Batch BN2 inputs.
  kind?: string;
  app?: string;
  write?: Record<string, unknown> | null;
  sessionId?: string;
  active?: boolean;
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
  // ── Batch BL — Billing Control Center (billing.view / plans/manage lanes) ─
  {
    name: "list_billing_plans",
    description: "The platform's billing plans (optionally only active ones).",
    capability: "billing.view",
    bridged: false,
    inputSchema: {
      type: "object",
      properties: { activeOnly: { type: "boolean" } },
    },
  },
  {
    name: "list_plan_features",
    description: "Feature lines of one billing plan — or the whole per-use catalogue when planKey is omitted.",
    capability: "billing.view",
    bridged: false,
    inputSchema: {
      type: "object",
      properties: { planKey: { type: "string" } },
    },
  },
  {
    name: "list_entitlements",
    description: "The per-business feature grants (entitlements).",
    capability: "billing.view",
    bridged: true,
    inputSchema: {
      type: "object",
      properties: { businessId: { type: "string" } },
      required: ["businessId"],
    },
  },
  {
    name: "list_billing_invoices",
    description: "Platform invoices, filterable by status and business, paged like the console.",
    capability: "billing.view",
    bridged: false,
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string" },
        businessId: { type: "string" },
        limit: { type: "number" },
        offset: { type: "number" },
        withLines: { type: "boolean" },
      },
    },
  },
  {
    name: "list_billing_payments",
    description: "Platform payments, filterable by status and business.",
    capability: "billing.view",
    bridged: false,
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["pending", "verified", "failed", "cancelled"] },
        businessId: { type: "string" },
        limit: { type: "number" },
        offset: { type: "number" },
      },
    },
  },
  {
    name: "list_billing_subscriptions",
    description: "Business subscriptions, filterable by status and business.",
    capability: "billing.view",
    bridged: false,
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string" },
        businessId: { type: "string" },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "list_spend_policies",
    description: "All spend policies — or one business's policy plus live evaluated spend.",
    capability: "billing.view",
    bridged: false,
    inputSchema: {
      type: "object",
      properties: { businessId: { type: "string" } },
    },
  },
  {
    name: "get_commercial_settings",
    description: "The commercial configuration every invoice/quote is computed from (billing.manage, like the console read).",
    capability: "billing.manage",
    bridged: false,
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "save_billing_plan",
    description:
      "Create or edit a billing plan. A new plan must ship every limit as an explicit limited/unlimited choice, same as the console form. Step-up: price policy.",
    capability: "plans.manage",
    bridged: false,
    stepUp: true,
    inputSchema: {
      type: "object",
      properties: {
        planKey: { type: "string", description: "Present = edit that plan." },
        name: { type: "string" },
        description: { type: "string" },
        monthlyPriceRial: { type: "number" },
        monthlyAiCreditRial: { type: "number" },
        status: { type: "string", enum: ["draft", "active", "retired"] },
        sortOrder: { type: "number" },
        trialDays: { type: "number" },
        graceDays: { type: "number" },
        limits: { type: "object", description: "limitKey → { unlimited: true } | { value: number }" },
      },
      required: ["name"],
    },
  },
  {
    name: "set_plan_status",
    description: "Activate or retire a billing plan — flips what the store can sell.",
    capability: "plans.manage",
    bridged: false,
    inputSchema: {
      type: "object",
      properties: {
        planKey: { type: "string" },
        action: { type: "string", enum: ["activate", "retire"] },
      },
      required: ["planKey", "action"],
    },
  },
  {
    name: "delete_draft_plan",
    description: "Delete a DRAFT plan (active/retired plans cannot be deleted).",
    capability: "plans.manage",
    bridged: false,
    inputSchema: {
      type: "object",
      properties: { planKey: { type: "string" } },
      required: ["planKey"],
    },
  },
  {
    name: "save_plan_feature",
    description: "Set one feature line on a plan (included/monthly/per_use/addon with its price). Step-up: price policy.",
    capability: "plans.manage",
    bridged: false,
    stepUp: true,
    inputSchema: {
      type: "object",
      properties: {
        planKey: { type: "string" },
        featureKey: { type: "string" },
        pricingModel: { type: "string", enum: ["included", "monthly", "per_use", "addon"] },
        priceRial: { type: "number" },
        freeUntil: { type: "string" },
        freeLimit: { type: "number" },
        sortOrder: { type: "number" },
      },
      required: ["planKey", "featureKey", "pricingModel", "priceRial"],
    },
  },
  {
    name: "delete_plan_feature",
    description: "Remove a feature line from a plan.",
    capability: "plans.manage",
    bridged: false,
    inputSchema: {
      type: "object",
      properties: { planKey: { type: "string" }, featureKey: { type: "string" } },
      required: ["planKey", "featureKey"],
    },
  },
  {
    name: "save_credit_package",
    description: "Create or edit a wallet credit package. Step-up: price policy.",
    capability: "billing.manage",
    bridged: false,
    stepUp: true,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Present = edit that package." },
        name: { type: "string" },
        priceRial: { type: "number" },
        creditRial: { type: "number" },
        isActive: { type: "boolean" },
        sortOrder: { type: "number" },
      },
      required: ["name", "priceRial", "creditRial", "isActive", "sortOrder"],
    },
  },
  {
    name: "grant_entitlement",
    description: "Grant one business a feature entitlement. Step-up: grants a concession.",
    capability: "billing.manage",
    bridged: true,
    stepUp: true,
    inputSchema: {
      type: "object",
      properties: {
        businessId: { type: "string" },
        featureKey: { type: "string" },
        expiresAt: { type: "string" },
        freeUntil: { type: "string" },
        freeLimit: { type: "number" },
      },
      required: ["businessId", "featureKey"],
    },
  },
  {
    name: "revoke_entitlement",
    description: "Revoke one business's feature entitlement. Step-up.",
    capability: "billing.manage",
    bridged: true,
    stepUp: true,
    inputSchema: {
      type: "object",
      properties: {
        businessId: { type: "string" },
        featureKey: { type: "string" },
      },
      required: ["businessId", "featureKey"],
    },
  },
  {
    name: "run_subscription_action",
    description: "change_plan / cancel / reactivate / set_auto_renew for a business's subscription — the console lane, audited. Step-up.",
    capability: "billing.manage",
    bridged: true,
    stepUp: true,
    inputSchema: {
      type: "object",
      properties: {
        businessId: { type: "string" },
        action: { type: "string", enum: ["change_plan", "cancel", "reactivate", "set_auto_renew"] },
        planKey: { type: "string" },
        atPeriodEnd: { type: "boolean" },
        autoRenew: { type: "boolean" },
      },
      required: ["businessId", "action"],
    },
  },
  {
    name: "review_manual_payment",
    description: "Approve or reject a bank-transfer manual payment — posts the settlement or the rejection. Step-up.",
    capability: "payments.review",
    bridged: false,
    stepUp: true,
    inputSchema: {
      type: "object",
      properties: {
        paymentId: { type: "string" },
        action: { type: "string", enum: ["approve", "reject"] },
      },
      required: ["paymentId", "action"],
    },
  },
  {
    name: "adjust_business_wallet",
    description: "Grant (positive) or deduct (negative) wallet credit for one business — a money posting, audited with the wallet's before/after. Step-up.",
    capability: "adjustments.manage",
    bridged: true,
    stepUp: true,
    inputSchema: {
      type: "object",
      properties: {
        businessId: { type: "string" },
        amountRial: { type: "number", description: "Non-zero; grants when positive, deducts when negative." },
        note: { type: "string" },
      },
      required: ["businessId", "amountRial"],
    },
  },
  {
    name: "act_billing_invoice",
    description: "Void an invoice or apply a payment to it. Step-up.",
    capability: "billing.manage",
    bridged: false,
    stepUp: true,
    inputSchema: {
      type: "object",
      properties: {
        invoiceId: { type: "string" },
        action: { type: "string", enum: ["void", "apply_payment"] },
        amountRial: { type: "number", description: "Required for apply_payment." },
      },
      required: ["invoiceId", "action"],
    },
  },
  {
    name: "save_spend_policy",
    description: "Set a business's monthly spend budget and what happens at the limit. Step-up.",
    capability: "billing.manage",
    bridged: true,
    stepUp: true,
    inputSchema: {
      type: "object",
      properties: {
        businessId: { type: "string" },
        monthlyBudgetRial: { type: "number" },
        actionAtLimit: { type: "string", enum: ["continue", "warn_only", "block_noncritical", "throttle_noncritical"] },
        thresholds: { type: "array" },
      },
      required: ["businessId", "actionAtLimit"],
    },
  },
  {
    name: "save_commercial_settings",
    description:
      "Edit the commercial configuration (invoice prefix, due/grace days, overage + proration policy, top-up floor, tax bps…). Step-up: platform-wide price policy.",
    capability: "billing.manage",
    bridged: false,
    stepUp: true,
    inputSchema: {
      type: "object",
      properties: {
        invoicePrefix: { type: "string" },
        defaultDueDays: { type: "number" },
        defaultGraceDays: { type: "number" },
        rounding: { type: "string", enum: ["ceil", "floor"] },
        minimumTopUpRial: { type: "number" },
        overagePolicy: { type: "string", enum: ["charge", "block"] },
        prorationPolicy: { type: "string", enum: ["none", "daily"] },
        defaultSpendAction: { type: "string" },
        invoiceFooter: { type: "string" },
        taxRateBps: { type: "number" },
      },
    },
  },
  {
    name: "save_billing_rates",
    description:
      "Edit one rate group: messaging (SMS/email), media (storage/enhance tariff) or ai (costing rates). Step-up: platform-wide price policy.",
    capability: "billing.manage",
    bridged: false,
    stepUp: true,
    inputSchema: {
      type: "object",
      properties: {
        group: { type: "string", enum: ["messaging", "media", "ai"] },
        values: { type: "object", description: "The rate fields of that group (partial merge, like the console form)." },
      },
      required: ["group"],
    },
  },
  // ── Batch BM — tenant lifecycle ───────────────────────────────────────────
  {
    name: "provision_business",
    description:
      "Provision a new tenant (business + owner + chart of accounts + AI key attempt). Same input as the console form: subdomain is required in English, owner activation is on. Step-up: mints a business.",
    capability: "business.provision",
    bridged: false,
    stepUp: true,
    inputSchema: {
      type: "object",
      properties: {
        businessName: { type: "string" },
        ownerName: { type: "string" },
        email: { type: "string" },
        subdomain: { type: "string", description: "DNS label on the root domain, typed by hand like the console." },
        ownerPhone: { type: "string" },
        industry: { type: "string" },
        plan: { type: "string" },
        confirmExistingOwner: { type: "boolean", description: "Proceed when the owner email is already a user." },
      },
      required: ["businessName", "ownerName", "email", "subdomain"],
    },
  },
  {
    name: "update_business",
    description: "Edit a business's identity fields (name / timezone). No-key edits answer as unchanged, like the console.",
    capability: "business.edit",
    bridged: true,
    inputSchema: {
      type: "object",
      properties: {
        businessId: { type: "string" },
        name: { type: "string" },
        timezone: { type: "string" },
      },
      required: ["businessId"],
    },
  },
  {
    name: "rename_business_subdomain",
    description: "Rename a business's public subdomain — the alias changes and live sessions are invalidated, like the console's rename lane.",
    capability: "business.edit",
    bridged: true,
    inputSchema: {
      type: "object",
      properties: {
        businessId: { type: "string" },
        subdomain: { type: "string" },
      },
      required: ["businessId", "subdomain"],
    },
  },
  {
    name: "reset_business",
    description:
      "Wipe a business's operational data back to a clean shell. Requires confirmation = the same typed phrase the console shows for this business. Step-up.",
    capability: "business.reset",
    bridged: true,
    stepUp: true,
    inputSchema: {
      type: "object",
      properties: {
        businessId: { type: "string" },
        confirmation: { type: "string", description: "Typed phrase — reset-<slug>." },
      },
      required: ["businessId", "confirmation"],
    },
  },
  {
    name: "hard_delete_business",
    description:
      "PERMANENTLY delete a business and every row under it. Requires confirmation = the same typed phrase the console shows for this business. Owner-only; step-up.",
    capability: "business.delete",
    bridged: true,
    stepUp: true,
    inputSchema: {
      type: "object",
      properties: {
        businessId: { type: "string" },
        confirmation: { type: "string", description: "Typed phrase — delete-<slug>." },
      },
      required: ["businessId", "confirmation"],
    },
  },
  {
    name: "list_provision_devices",
    description: "Provision-link issue history for one business (the key-maker lane shares business.provision).",
    capability: "business.provision",
    bridged: true,
    inputSchema: {
      type: "object",
      properties: { businessId: { type: "string" } },
      required: ["businessId"],
    },
  },
  // ── Batch BN — knowledge, CMS fleet reads, backup, system dials ──────────
  {
    name: "list_kb_articles",
    description: "List/search the platform knowledge base (builder view: drafts included).",
    capability: "knowledge.manage",
    bridged: false,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        status: { type: "string", enum: ["draft", "published"] },
        categoryId: { type: "string" },
      },
    },
  },
  {
    name: "save_kb_category",
    description: "Create a knowledge category (record.input) or update fields on an existing one (record.id + record.input).",
    capability: "knowledge.manage",
    bridged: false,
    inputSchema: { type: "object", properties: { id: { type: "string" }, record: { type: "object" } }, required: ["record"] },
  },
  {
    name: "delete_kb_category",
    description: "Delete a knowledge category. Fails category_has_children / category_has_articles while it holds content, exactly like the console.",
    capability: "knowledge.manage",
    bridged: false,
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "save_kb_tag",
    description: "Create a knowledge tag (record.input) or rename one (record.id + record.input).",
    capability: "knowledge.manage",
    bridged: false,
    inputSchema: { type: "object", properties: { id: { type: "string" }, record: { type: "object" } }, required: ["record"] },
  },
  {
    name: "delete_kb_tag",
    description: "Delete a knowledge tag.",
    capability: "knowledge.manage",
    bridged: false,
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "save_kb_article",
    description:
      "Create a knowledge article (record.input: slug, title, bodyMd, status draft|published, …) or update an existing one (record.id + record.input). Publishing rules are the console's.",
    capability: "knowledge.manage",
    bridged: false,
    inputSchema: { type: "object", properties: { id: { type: "string" }, record: { type: "object" } }, required: ["record"] },
  },
  {
    name: "delete_kb_article",
    description: "Hard-delete a knowledge article (the console DELETE lane — same guard).",
    capability: "knowledge.manage",
    bridged: false,
    stepUp: true,
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "list_cms_sites",
    description: "List websites mirrored from the CMS fleet (the mirror is the console's single source).",
    capability: "system.read",
    bridged: false,
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_cms_sync_runs",
    description: "Recent CMS push/pull/event-shipping sync runs.",
    capability: "system.read",
    bridged: false,
    inputSchema: { type: "object", properties: { limit: { type: "number" } } },
  },
  {
    name: "get_cms_infrastructure",
    description: "CMS routing table — the infrastructure lanes behind the websites. Reports an error when no CMS client is configured, like the console.",
    capability: "system.read",
    bridged: false,
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_cms_theme_packages",
    description: "Theme packages hosted by the CMS service.",
    capability: "system.read",
    bridged: false,
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_cms_deploy_targets",
    description: "Deployment targets configured on the CMS service.",
    capability: "system.read",
    bridged: false,
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_cms_site",
    description:
      "Provision a website on the CMS service ({record: {domain, name, type?}}). The API key minted for the site is returned ONCE — treat it as a credential. Step-up.",
    capability: "cms.manage",
    bridged: false,
    stepUp: true,
    inputSchema: { type: "object", properties: { record: { type: "object" } }, required: ["record"] },
  },
  {
    name: "list_backup_runs",
    description: "Recent platform backup runs with their partial/limit flags, like the console table.",
    capability: "backup.read",
    bridged: false,
    inputSchema: { type: "object", properties: { limit: { type: "number" } } },
  },
  {
    name: "get_backup_health",
    description: "Backup health rollup: last success, stale markers, storage stats, queue depth.",
    capability: "backup.read",
    bridged: false,
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "run_backup_now",
    description: "Run a platform backup immediately and wait for the result. Runs only when the backup engine is idle, like the console. Step-up.",
    capability: "backup.run",
    bridged: false,
    stepUp: true,
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_system_status",
    description: "Platform status: migrations, worker activity, counters — the System view.",
    capability: "system.read",
    bridged: false,
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_observability_health",
    description: "Health probe of the OpenSearch collector (observability disabled reports as such, like the console).",
    capability: "system.read",
    bridged: false,
    inputSchema: { type: "object", properties: {} },
  },
  // ── Batch BN2 — the exception rows' remaining lanes ─────────────────────
  {
    name: "list_cloud_exceptions",
    description: "Standalone-installation support/bug-report inbox (payload is never logged by the route either). Optional kind filter.",
    capability: "support.manage",
    bridged: false,
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number" }, kind: { type: "string" } },
    },
  },
  {
    name: "list_business_app_availability",
    description: "Which apps are enabled/hidden for one business, with rollout metadata.",
    capability: "business.reports.read",
    bridged: true,
    inputSchema: {
      type: "object",
      properties: { businessId: { type: "string" } },
      required: ["businessId"],
    },
  },
  {
    name: "set_business_app_availability",
    description:
      "Enable/hide an app for one business ({app, write: {available, hidden?…}} — write: null clears the override). Same guard as the console: unknown app keys fail.",
    capability: "features.write",
    bridged: true,
    inputSchema: {
      type: "object",
      properties: {
        businessId: { type: "string" },
        app: { type: "string" },
        write: { type: "object", description: "Availability write; pass null to clear the override." },
      },
      required: ["businessId", "app", "write"],
    },
  },
  {
    name: "set_platform_admin_active",
    description:
      "Activate/deactivate a platform admin by id (admins.manage; same guards as the console PATCH — your own account cannot be deactivated by yourself, role fields untouched).",
    capability: "admins.manage",
    bridged: false,
    stepUp: true,
    inputSchema: {
      type: "object",
      properties: {
        adminId: { type: "string" },
        active: { type: "boolean" },
      },
      required: ["adminId", "active"],
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
      // ── Batch BL — billing reads ──────────────────────────────────────────
      case "list_billing_plans":
        return { plans: await listBillingPlans(arg.activeOnly === true) };
      case "list_plan_features":
        if (arg.planKey) return { features: await listPlanFeatures(arg.planKey) };
        return { catalogue: await listFeatureCatalogue() };
      case "list_entitlements": {
        for (const id of targets) results[id] = await listEntitlements(id);
        return { perBusiness: results };
      }
      case "list_billing_invoices":
        return {
          invoices: await listInvoices({
            businessId: arg.businessId,
            status: arg.status,
            limit: arg.limit ?? 100,
            offset: arg.offset ?? 0,
            withLines: arg.withLines === true,
          }),
        };
      case "list_billing_payments":
        return {
          payments: await listPayments({
            businessId: arg.businessId,
            status: arg.status as never,
            limit: arg.limit ?? 100,
            offset: arg.offset ?? 0,
          }),
        };
      case "list_billing_subscriptions":
        return {
          subscriptions: await listSubscriptions({
            status: (arg.status || undefined) as never,
            businessId: arg.businessId,
            limit: arg.limit ?? 200,
          }),
        };
      case "list_spend_policies":
        if (!arg.businessId) return { policies: await listSpendPolicies() };
        return {
          policy: await getSpendPolicy(arg.businessId),
          spend: await evaluateBusinessSpend(arg.businessId),
        };
      case "get_commercial_settings":
        return { settings: await readCommercialSettings() };
      // ── Batch BL — plan & package writes (plans.manage / billing.manage) ──
      case "save_billing_plan": {
        if (!arg.name) throw new Error("missing_fields");
        const plan = await saveBillingPlan({
          key: arg.planKey,
          name: arg.name,
          description: arg.description,
          monthlyPriceRial: arg.monthlyPriceRial,
          monthlyAiCreditRial: arg.monthlyAiCreditRial,
          status: arg.status as never,
          sortOrder: arg.sortOrder ?? 0,
          trialDays: arg.trialDays,
          graceDays: arg.graceDays,
          limits: arg.limits as never,
        });
        return { plan };
      }
      case "set_plan_status": {
        if (!arg.planKey) throw new Error("missing_fields");
        if (arg.action === "activate") return { plan: await activatePlan(arg.planKey) };
        if (arg.action === "retire") return { plan: await retirePlan(arg.planKey) };
        throw new Error("invalid_lifecycle_action");
      }
      case "delete_draft_plan": {
        if (!arg.planKey) throw new Error("missing_fields");
        await deleteDraftPlan(arg.planKey);
        return { ok: true };
      }
      case "save_plan_feature": {
        if (!arg.planKey || !arg.featureKey || !arg.pricingModel) throw new Error("missing_fields");
        const feature = await savePlanFeature({
          planKey: arg.planKey,
          featureKey: arg.featureKey,
          pricingModel: arg.pricingModel,
          priceRial: arg.priceRial ?? 0,
          freeUntil: arg.freeUntil,
          freeLimit: arg.freeLimit,
          sortOrder: arg.sortOrder ?? 0,
        });
        return { feature };
      }
      case "delete_plan_feature": {
        if (!arg.planKey || !arg.featureKey) throw new Error("missing_fields");
        await deletePlanFeature(arg.planKey, arg.featureKey);
        return { ok: true };
      }
      case "save_credit_package": {
        if (!arg.name) throw new Error("missing_fields");
        const pkg = await saveCreditPackage({
          id: arg.id,
          name: arg.name,
          priceRial: Number(arg.priceRial ?? 0),
          creditRial: Number(arg.creditRial ?? 0),
          isActive: arg.isActive !== false,
          sortOrder: arg.sortOrder ?? 0,
        });
        await platformAuditSafe(connection, null, tool.name, "ok", { action: "package.saved", id: pkg.id ?? arg.id });
        return { package: pkg };
      }
      case "grant_entitlement": {
        if (!arg.featureKey) throw new Error("missing_fields");
        for (const id of targets) {
          try {
            await grantEntitlement({
              businessId: id,
              featureKey: arg.featureKey,
              source: "admin_grant" as never,
              expiresAt: arg.expiresAt,
              freeUntil: arg.freeUntil,
              freeLimit: arg.freeLimit,
              grantedBy: connection.adminId,
            });
            results[id] = { ok: true, feature: arg.featureKey, granted: true };
          } catch (err) {
            results[id] = { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        }
        return { perBusiness: results };
      }
      case "revoke_entitlement": {
        if (!arg.featureKey) throw new Error("missing_fields");
        for (const id of targets) {
          try {
            await revokeEntitlement(id, arg.featureKey);
            results[id] = { ok: true, feature: arg.featureKey, revoked: true };
          } catch (err) {
            results[id] = { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        }
        return { perBusiness: results };
      }
      // ── Batch BL — runtime writes ─────────────────────────────────────────
      case "run_subscription_action": {
        const action = String(arg.action ?? "");
        for (const id of targets) {
          try {
            let outcome: unknown;
            if (action === "change_plan") {
              if (!arg.planKey) throw new Error("missing_fields");
              outcome = await changeBusinessPlan({ businessId: id, planKey: arg.planKey, source: "admin" });
            } else if (action === "cancel") {
              outcome = await cancelBusinessSubscription(id, { atPeriodEnd: arg.atPeriodEnd === true });
            } else if (action === "reactivate") {
              outcome = await reactivateBusinessSubscription(id);
            } else if (action === "set_auto_renew") {
              outcome = await setAutoRenew(id, arg.autoRenew !== false);
            } else {
              throw new Error("invalid_lifecycle_action");
            }
            await platformAuditSafe(connection, id, tool.name, "ok", { action: `subscription.${action}`, planKey: arg.planKey });
            results[id] = { ok: true, outcome };
          } catch (err) {
            results[id] = { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        }
        return { perBusiness: results };
      }
      case "review_manual_payment": {
        if (!arg.paymentId) throw new Error("missing_fields");
        if (arg.action !== "approve" && arg.action !== "reject") throw new Error("invalid_review_action");
        const status = await reviewManualPayment({
          paymentId: arg.paymentId,
          action: arg.action,
          platformAdminId: connection.adminId,
        });
        await platformAuditSafe(connection, null, tool.name, "ok", { action: `payment.${arg.action}`, paymentId: arg.paymentId, status });
        return { status };
      }
      case "adjust_business_wallet": {
        const amount = Math.trunc(Number(arg.amountRial ?? 0));
        if (!amount || !Number.isFinite(amount)) throw new Error("bad_amount");
        for (const id of targets) {
          try {
            const before = await getWallet(id);
            const entry =
              amount > 0
                ? await grantCredits({
                    businessId: id,
                    amountRial: amount,
                    note: arg.note?.trim() || undefined,
                    platformAdminId: connection.adminId,
                  })
                : await deductCredits({
                    businessId: id,
                    amountRial: Math.abs(amount),
                    note: arg.note?.trim() || undefined,
                    platformAdminId: connection.adminId,
                  });
            const afterWallet = await getWallet(id);
            await platformAuditSafe(connection, id, tool.name, "ok", {
              action: "wallet.adjusted",
              amountRial: amount,
              note: arg.note?.trim() || null,
              before: before.balanceRial,
              after: afterWallet.balanceRial,
            });
            results[id] = { ok: true, entry, before: before.balanceRial, after: afterWallet.balanceRial };
          } catch (err) {
            results[id] = { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        }
        return { perBusiness: results };
      }
      case "act_billing_invoice": {
        if (!arg.invoiceId) throw new Error("missing_fields");
        if (arg.action === "void") return { invoice: await voidBillingInvoice(arg.invoiceId) };
        if (arg.action === "apply_payment") {
          const amount = Math.trunc(Number(arg.amountRial ?? 0));
          if (!amount || amount <= 0) throw new Error("bad_amount");
          return { invoice: await applyInvoicePayment(arg.invoiceId, amount) };
        }
        throw new Error("invalid_lifecycle_action");
      }
      case "save_spend_policy": {
        const actionAtLimit = String(arg.actionAtLimit ?? "");
        if (!["continue", "warn_only", "block_noncritical", "throttle_noncritical"].includes(actionAtLimit)) {
          throw new Error("invalid_action");
        }
        for (const id of targets) {
          try {
            await saveSpendPolicy({
              businessId: id,
              monthlyBudgetRial: arg.monthlyBudgetRial ?? null,
              actionAtLimit: actionAtLimit as never,
              thresholds: arg.thresholds,
            });
            results[id] = { ok: true, actionAtLimit };
          } catch (err) {
            results[id] = { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        }
        return { perBusiness: results };
      }
      case "save_commercial_settings": {
        await saveCommercialSettings({
          invoicePrefix: arg.invoicePrefix,
          defaultDueDays: arg.defaultDueDays,
          defaultGraceDays: arg.defaultGraceDays,
          rounding: arg.rounding,
          minimumTopUpRial: arg.minimumTopUpRial,
          overagePolicy: arg.overagePolicy,
          prorationPolicy: arg.prorationPolicy,
          defaultSpendAction: arg.defaultSpendAction,
          invoiceFooter: arg.invoiceFooter,
          taxRateBps: arg.taxRateBps,
        });
        await platformAuditSafe(connection, null, tool.name, "ok", { action: "commercial_settings.saved" });
        return { settings: await readCommercialSettings() };
      }
      case "save_billing_rates": {
        const group = String(arg.group ?? "");
        const values = (arg.values ?? {}) as Record<string, unknown>;
        if (group === "messaging") {
          const before = (await getPublicMessageConfig()).rate;
          const rate = await saveMessageRates({
            smsRialPerSegment: values.smsRialPerSegment === undefined ? undefined : Number(values.smsRialPerSegment),
            emailRialPerSend: values.emailRialPerSend === undefined ? undefined : Number(values.emailRialPerSend),
          });
          await platformAuditSafe(connection, null, tool.name, "ok", { action: "messaging_rate.changed", before, after: rate });
          return { rate };
        }
        if (group === "media") {
          const before = await getMediaConfig();
          const parsed = validateMediaTariffInput(values, before);
          if (!parsed.ok) throw new Error(parsed.error);
          await saveMediaTariff(parsed.tariff, connection.adminId);
          await platformAuditSafe(connection, null, tool.name, "ok", {
            action: "media_tariff.changed",
            before: { dailyFlatRial: before.dailyFlatRial, dailyPerGbRial: before.dailyPerGbRial },
            after: parsed.tariff,
          });
          return { tariff: parsed.tariff };
        }
        if (group === "ai") {
          const before = await getAiCostingConfig();
          const after = await saveAiCostingConfig(values as never);
          await platformAuditSafe(connection, null, tool.name, "ok", { action: "ai_costing.changed", before, after });
          return { config: after };
        }
        throw new Error("invalid_rate_group");
      }
      // ── Batch BM — tenant lifecycle ───────────────────────────────────────
      case "provision_business": {
        const validated = validateProvisionBody(
          {
            businessName: arg.businessName,
            ownerName: arg.ownerName,
            email: arg.email,
            subdomain: arg.subdomain,
            ownerPhone: arg.ownerPhone,
            industry: arg.industry,
            plan: arg.plan,
          } as never,
          { requireSubdomain: true, ownerActivation: true },
        );
        if (validated.input === null) throw new Error(validated.error);
        const provisioned = await provisionBusiness({
          ...validated.input,
          seedChartOfAccounts: true,
          // Parity with the console route: F&B tenants must walk the wizard
          // (issue #840); other industries arrive ready-to-enter.
          completeSetup: shouldCompleteSetupForPlatformProvision(validated.input.industry),
          createdBy: connection.adminId,
          confirmExistingOwner: arg.confirmExistingOwner === true,
        });
        await platformAuditSafe(connection, provisioned.businessId, tool.name, "ok", {
          action: "business.provision",
        });
        return provisioned;
      }
      case "update_business": {
        if (arg.name === undefined && arg.timezone === undefined) throw new Error("nothing_to_change");
        if (typeof arg.name === "string" && arg.name.trim() === "") throw new Error("invalid_name");
        for (const id of targets) {
          try {
            const updated = await updateBusiness(id, {
              name: typeof arg.name === "string" ? arg.name.trim() : undefined,
              timezone: typeof arg.timezone === "string" ? arg.timezone : undefined,
            });
            if (!updated) throw new Error("not_found");
            await platformAuditSafe(connection, id, tool.name, "ok", {
              action: "business.update",
              fields: { name: typeof arg.name === "string", timezone: typeof arg.timezone === "string" },
            });
            results[id] = { ok: true };
          } catch (err) {
            results[id] = { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        }
        return { perBusiness: results };
      }
      case "rename_business_subdomain": {
        if (!arg.subdomain) throw new Error("missing_fields");
        for (const id of targets) {
          try {
            const result = await renameBusinessSubdomain(id, arg.subdomain);
            await platformAuditSafe(connection, id, tool.name, "ok", {
              action: "business.rename_subdomain",
              subdomain: arg.subdomain,
            });
            results[id] = { ok: true, result };
          } catch (err) {
            results[id] = { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        }
        return { perBusiness: results };
      }
      case "reset_business": {
        for (const id of targets) {
          try {
            const business = await getBusiness(id);
            if (!business) throw new Error("not_found");
            if (business.ownershipKind === "platform_internal") throw new Error("protected_internal_business");
            const expected = businessDestructivePhrase("reset", business.slug);
            if ((arg.confirmation ?? "").trim() !== expected) throw new Error("confirmation_mismatch");
            await resetBusiness(id);
            await platformAuditSafe(connection, id, tool.name, "ok", { action: "business.reset" });
            results[id] = { ok: true };
          } catch (err) {
            results[id] = { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        }
        return { perBusiness: results };
      }
      case "hard_delete_business": {
        for (const id of targets) {
          try {
            const business = await getBusiness(id);
            if (!business) throw new Error("not_found");
            if (business.ownershipKind === "platform_internal") throw new Error("protected_internal_business");
            const expected = businessDestructivePhrase("delete", business.slug);
            if ((arg.confirmation ?? "").trim() !== expected) throw new Error("confirmation_mismatch");
            const result = await hardDeleteBusiness(id);
            await platformAuditSafe(connection, id, tool.name, "ok", {
              action: "business.delete",
              snapshot: { name: business.name, slug: business.slug, industry: business.industry },
            });
            results[id] = { ok: true, result };
          } catch (err) {
            results[id] = { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        }
        return { perBusiness: results };
      }
      case "list_provision_devices": {
        for (const id of targets) {
          if (!(await getBusiness(id))) {
            results[id] = { ok: false, error: "not_found" };
            continue;
          }
          const [installations, codes, locations] = await Promise.all([
            listSiteDevices(id),
            listPairingCodes(id),
            listPairingLocations(id),
          ]);
          results[id] = { ok: true, installations, codes, locations };
        }
        return { perBusiness: results };
      }
      // ── Batch BN — knowledge, CMS fleet reads, backup, system dials ───────
      case "list_kb_articles": {
        const articles = await adminListKbArticles({
          q: arg.query || undefined,
          status: arg.status as "draft" | "published" | undefined,
          categoryId: arg.categoryId || undefined,
        });
        return { articles };
      }
      case "save_kb_category": {
        const input = (arg.record?.input ?? {}) as Record<string, unknown>;
        const existingId = (arg.record?.id as string | undefined) ?? arg.id;
        if (existingId) {
          await adminUpdateKbCategory(existingId, input as never, connection.adminId);
          await platformAuditSafe(connection, existingId, tool.name, "ok", { action: "knowledge_category.update" });
          return { ok: true, id: existingId };
        }
        const id = await adminCreateKbCategory(input as never, connection.adminId);
        await platformAuditSafe(connection, id, tool.name, "ok", { action: "knowledge_category.create" });
        return { ok: true, id };
      }
      case "delete_kb_category": {
        if (!arg.id) throw new Error("missing_fields");
        await adminDeleteKbCategory(arg.id);
        await platformAuditSafe(connection, arg.id, tool.name, "ok", { action: "knowledge_category.delete" });
        return { ok: true, id: arg.id };
      }
      case "save_kb_tag": {
        const input = (arg.record?.input ?? {}) as Record<string, unknown>;
        const existingId = (arg.record?.id as string | undefined) ?? arg.id;
        if (existingId) {
          await adminUpdateKbTag(existingId, input as never, connection.adminId);
          await platformAuditSafe(connection, existingId, tool.name, "ok", { action: "knowledge_tag.update" });
          return { ok: true, id: existingId };
        }
        const id = await adminCreateKbTag(input as never, connection.adminId);
        await platformAuditSafe(connection, id, tool.name, "ok", { action: "knowledge_tag.create" });
        return { ok: true, id };
      }
      case "delete_kb_tag": {
        if (!arg.id) throw new Error("missing_fields");
        await adminDeleteKbTag(arg.id);
        await platformAuditSafe(connection, arg.id, tool.name, "ok", { action: "knowledge_tag.delete" });
        return { ok: true, id: arg.id };
      }
      case "save_kb_article": {
        const input = (arg.record?.input ?? {}) as Record<string, unknown>;
        const existingId = (arg.record?.id as string | undefined) ?? arg.id;
        if (existingId) {
          await adminUpdateKbArticle(existingId, input as never, connection.adminId);
          await platformAuditSafe(connection, existingId, tool.name, "ok", { action: "knowledge_article.update" });
          return { ok: true, id: existingId };
        }
        const id = await adminCreateKbArticle(input as never, connection.adminId);
        await platformAuditSafe(connection, id, tool.name, "ok", { action: "knowledge_article.create" });
        return { ok: true, id };
      }
      case "delete_kb_article": {
        if (!arg.id) throw new Error("missing_fields");
        await adminDeleteKbArticle(arg.id);
        await platformAuditSafe(connection, arg.id, tool.name, "ok", { action: "knowledge_article.delete" });
        return { ok: true, id: arg.id };
      }
      case "list_cms_sites": {
        return { sites: await listMirroredCmsSites() };
      }
      case "list_cms_sync_runs": {
        return { runs: await listCmsSyncRuns(arg.limit) };
      }
      case "get_cms_infrastructure": {
        const config = await resolvePlatformCmsConfig();
        if (!config) throw new Error("cms_not_configured");
        const routing = await fetchCmsRoutingTable(config, { actor: connection.adminId });
        return { routing };
      }
      case "list_cms_theme_packages": {
        const config = await resolvePlatformCmsConfig();
        if (!config) throw new Error("cms_not_configured");
        const packages = await fetchCmsThemePackages(config, { actor: connection.adminId });
        return { packages };
      }
      case "list_cms_deploy_targets": {
        const config = await resolvePlatformCmsConfig();
        if (!config) throw new Error("cms_not_configured");
        const targets = await fetchCmsDeployTargets(config, { actor: connection.adminId });
        return { targets };
      }
      case "create_cms_site": {
        const config = await resolvePlatformCmsConfig();
        if (!config) throw new Error("cms_not_configured");
        const body = (arg.record ?? {}) as Record<string, unknown>;
        const domain = typeof body.domain === "string" ? body.domain.trim() : "";
        const name = typeof body.name === "string" ? body.name.trim() : "";
        const type = (body.type as string | undefined) ?? "business";
        if (!domain || !name) throw new Error("missing_fields");
        if (type !== "business") throw new Error("unsupported_site_type");
        const site = await provisionSite(config, { domain, name, type: "business" });
        const result = site.site as unknown as { id: string };
        const key = await issueSiteApiKey(config, {
          name: `کنسول اسکو (${domain})`,
          role: "site",
          siteId: result.id,
        });
        await platformAuditSafe(connection, result.id, tool.name, "ok", {
          action: "platform_cms.site.provision",
          domain,
        });
        // The console refreshes the site mirror after a provision so the new
        // site is immediately listable; same behaviour here.
        await runCmsMirror({ actor: connection.adminId, startedBy: connection.adminId, trigger: "manual" });
        return {
          ok: true,
          site: site.site,
          // One-time plaintext credential — the console shows it once too.
          apiKey: key.key,
          warning: "Store the API key securely; it cannot be retrieved later.",
        };
      }
      case "list_backup_runs": {
        return { runs: await listPlatformBackupRuns(arg.limit) };
      }
      case "get_backup_health": {
        return { health: await getPlatformBackupHealth() };
      }
      case "run_backup_now": {
        const result = await runPlatformBackupNow(connection.adminId);
        await platformAuditSafe(connection, "platform", tool.name, "ok", {
          action: "backup.run_now",
          local: result.local.status,
          cloud: result.cloud.status,
        });
        return { ok: true, result };
      }
      case "get_system_status": {
        const migrations = await getMigrationStatus();
        return { status: await systemStatus(migrations) };
      }
      case "get_observability_health": {
        const cfg = observabilityConfig();
        if (!cfg) throw new Error("observability_not_configured");
        return { health: await zoHealth(cfg) };
      }
      // ── Batch BN2 — exception rows' remaining lanes ──────────────────────
      case "list_cloud_exceptions": {
        const limit = Math.min(Math.max(Number(arg.limit) || 50, 1), 200);
        const kind = arg.kind?.trim() || null;
        const { rows } = await query<{ id: string; kind: string; occurredAt: string }>(
          `SELECT i.id::text,i.installation_id AS "installationId",COALESCE(c.label,i.installation_id) AS "installationLabel",
                  i.event_id::text AS "eventId",i.kind,i.aggregate_id::text AS "aggregateId",
                  (i.payload - ARRAY['attachment','screenshot','userAgent']::text[]) AS payload,
                  i.occurred_at::text AS "occurredAt",i.received_at::text AS "receivedAt"
             FROM cloud_exception_inbox i
             LEFT JOIN cloud_exception_installations c ON c.installation_id=i.installation_id
            WHERE ($2::text IS NULL OR i.kind=$2)
            ORDER BY i.received_at DESC LIMIT $1`,
          [limit, kind],
        );
        return { events: rows };
      }
      case "list_business_app_availability": {
        for (const id of targets) {
          if (!(await getBusiness(id))) {
            results[id] = { ok: false, error: "not_found" };
            continue;
          }
          results[id] = { ok: true, apps: await businessAppAvailability(id) };
        }
        return { perBusiness: results };
      }
      case "set_business_app_availability": {
        let appKey;
        try {
          appKey = appForKey(arg.app as never).key;
        } catch {
          throw new Error("unknown_app");
        }
        const write = arg.write === undefined ? undefined : arg.write;
        if (write === undefined) throw new Error("missing_fields");
        for (const id of targets) {
          try {
            if (!(await getBusiness(id))) throw new Error("not_found");
            await setBusinessAppAvailability(id, appKey, write as never, connection.adminId);
            await platformAuditSafe(connection, id, tool.name, "ok", {
              action: "business.app_availability.write",
              app: appKey,
              cleared: write === null,
            });
            results[id] = { ok: true };
          } catch (err) {
            results[id] = { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        }
        return { perBusiness: results };
      }
      case "set_platform_admin_active": {
        if (!arg.adminId || typeof arg.active !== "boolean") throw new Error("missing_fields");
        const updated = await updatePlatformAdmin({
          targetAdminId: arg.adminId,
          isActive: arg.active,
          actorAdminId: connection.adminId,
        });
        if (!updated.ok) throw new Error(updated.error);
        await platformAuditSafe(connection, arg.adminId, tool.name, "ok", {
          action: "platform_admin.update",
          isActive: arg.active,
        });
        return { ok: true, admin: updated.admin };
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
