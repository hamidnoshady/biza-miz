/**
 * Wire contracts for the Platform Business surface.
 *
 * These types are shared by the server routes and the console's client
 * components, so the two cannot drift. They live in their own module because
 * the console runs in the browser: `platform-company.ts` pulls in `node:crypto`
 * and `bcryptjs`, and importing it from a `"use client"` component would drag
 * both into the client bundle.
 */

export const COMPANY_ACCESS_PRESET_KEYS = [
  "company_owner",
  "finance",
  "sales_success",
  "marketing",
  "website_editor",
  "project_manager",
] as const;
export type CompanyAccessPreset = (typeof COMPANY_ACCESS_PRESET_KEYS)[number];

export const COMPANY_APP_KEYS = ["workspace", "accounting", "crm", "growth", "websites"] as const;
export type CompanyAppKey = (typeof COMPANY_APP_KEYS)[number];

export const PRESET_LABELS: Record<CompanyAccessPreset, string> = {
  company_owner: "مالک شرکت",
  finance: "مالی",
  sales_success: "فروش و موفقیت مشتری",
  marketing: "بازاریابی",
  website_editor: "ویرایشگر وب‌سایت",
  project_manager: "مدیر پروژه",
};

export const COMPANY_APP_LABELS: Record<CompanyAppKey, string> = {
  workspace: "فضای کاری من",
  accounting: "حسابداری",
  crm: "ارتباط با مشتری",
  growth: "رشد و بازاریابی",
  websites: "مدیریت وب‌سایت",
};

/**
 * Why a Platform Business request is not usable right now.
 *
 * The console shows a different message and a different control for each one —
 * a staff member who is not a member must not be offered a setup button they
 * cannot use, and "the company is not provisioned" is not the same screen as
 * "your membership was revoked".
 */
export type PlatformCompanyState =
  /** No internal business exists yet on this deployment. */
  | "not_provisioned"
  /** The company exists; the caller has no membership row at all. */
  | "company_exists_not_member"
  /** The caller has a membership row but it is deactivated. */
  | "member_inactive"
  /** The mapped tenant user is deactivated, so no tenant session can be minted. */
  | "tenant_user_inactive"
  /** The internal business is archived/suspended. */
  | "company_unavailable"
  /** Membership is valid; permissions decide per-app access from here. */
  | "ready";

export interface PlatformCompanyMembershipSummary {
  preset: CompanyAccessPreset;
  active: boolean;
  revision: number;
}

export interface PlatformCompanyStatus {
  state: PlatformCompanyState;
  company: null | {
    businessId: string;
    name: string;
    subdomain: string;
    /** `businesses.status` — 'active' or a lifecycle state that blocks use. */
    status: string;
  };
  membership: PlatformCompanyMembershipSummary | null;
  /** Capability keys ('accounting' … plus 'workspace'). */
  entitlements: string[];
  /** Money display unit of the internal business, for the reconciliation table. */
  moneyUnit: "toman" | "rial";
  /** The caller may run the idempotent initializer. */
  canProvision: boolean;
  /** The caller may add, re-preset or revoke company staff. */
  canAdministerMembers: boolean;
  /** Central-cloud deployments only: local/hybrid nodes cannot provision. */
  provisioningSupported: boolean;
}

export interface PlatformCompanyMemberSummary {
  platformAdminId: string;
  fullName: string;
  email: string;
  preset: CompanyAccessPreset | null;
  active: boolean;
  revision: number;
}

/** One row of the Billing → Accounting reconciliation table. */
export type BillingEventStatus = "pending" | "processing" | "posted" | "failed" | "ignored";
export type BillingFailureKind = "transient" | "missing_account" | "missing_customer" | "permanent";

export interface BillingReconciliationRow {
  id: string;
  kind: string;
  source: string;
  version: string;
  amountRial: number;
  status: BillingEventStatus;
  attempts: number;
  error: string | null;
  failureKind: BillingFailureKind | null;
  /** Human explanation of why this row cannot be retried as-is, when it can't. */
  blockedReason: string | null;
  settlementMethod: string | null;
  occurredAt: string;
  postedAt: string | null;
  journalEntryId: string | null;
  customerTenantId: string | null;
  customerName: string | null;
}

export interface BillingReconciliationResponse {
  events: BillingReconciliationRow[];
  /** Total rows matching the filter, for pagination. */
  total: number;
  moneyUnit: "toman" | "rial";
  counts: Record<BillingEventStatus, number>;
}

/** One platform customer as the internal company's CRM may see it. */
export interface PlatformCompanyCustomerSummary {
  id: string;
  partyId: string;
  legalName: string;
  billingCustomerKey: string;
  churnRisk: string;
  accountOwner: string | null;
  tenants: {
    tenantId: string;
    tenantName: string | null;
    subscriptionStatus: string | null;
    walletBalanceRial: number | null;
    openInvoiceRial: number;
    supportTickets: number;
  }[];
  /** Posted Accounting balance — never a figure computed outside the ledger. */
  accountingBalanceRial: number;
  /** Posted A/R debits, including invoices and positive commercial adjustments. */
  invoicedRial: number;
  /** Posted A/R credits, including collections, credit notes and void reversals. */
  settledRial: number;
  deals: { id: string; title: string; valueRial: number; outcome: string | null; projectId: string | null }[];
  projectCount: number;
}

/** A CRM deal of the internal company that can be handed to My Workspace. */
export interface PlatformCompanyDealSummary {
  id: string;
  title: string;
  valueRial: number;
  outcome: string | null;
  stageName: string | null;
  customerName: string | null;
  closedAt: string | null;
  projectId: string | null;
  projectName: string | null;
  eligible: boolean;
  /** Machine reason the deal is not eligible, when it isn't. */
  ineligibleReason: string | null;
}

export interface SiteCredentialSummary {
  id: string;
  siteKey: string;
  siteId: string | null;
  provider: "eshobe" | "wordpress";
  isActive: boolean;
  revokedAt: string | null;
  requestsPerMinute: number;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface PlatformCompanySiteOption {
  id: string;
  provider: "eshobe" | "wordpress";
  name: string;
  siteId: string;
  domain: string | null;
}
