/**
 * Issue #902 §0 — the platform-wide inventory of provider-backed services.
 *
 * `contract.ts` says what a *tenant* may see about a managed service. This file
 * says which services exist, who supplies each one today, where the credential
 * actually lives, and how far its migration has got. The issue asks for exactly
 * this and gives the reason: the leak it was written about was not a Kavenegar
 * bug, it was that nobody could enumerate the places a supplier's name could
 * reach a customer, so the same bug was waiting in every other integration.
 *
 * ## What the fields are for
 *
 * - `supplier` is *internal*. It is here so that a reviewer can answer "who
 *   bills us for this" without reading an adapter, and so that a supplier swap
 *   is a one-line change with a test that notices. **Nothing in this file may
 *   be rendered to a tenant** — `tenantLabel` is, and it is checked against the
 *   same provider-name pattern the payload guard uses.
 * - `credentialStore` is the part that took the longest to get right in §1:
 *   "where does the key live" has four different answers in this codebase and
 *   two of them were the same service configured twice.
 * - `maturity` is deliberately honest. `vendor_visible` means the tenant can see
 *   the supplier's name today, and the entry carries the issue that changes
 *   that; a roadmap that says "all managed" while three screens name a vendor is
 *   the thing this inventory exists to prevent.
 * - `tenantSurfaces` and `consoleSurface` are *paths on disk*, and the test
 *   beside this file asserts they exist. A table of aspirational file names
 *   would be worse than no table.
 *
 * ## Adding a service
 *
 * Add the entry, add it to `MANAGED_SERVICES` in `contract.ts` when it has a
 * tenant-facing readiness shape, and — if the tenant can see the vendor today —
 * set `maturity: "vendor_visible"` with the follow-up issue. The guard test then
 * holds the line: a new tenant screen that names a supplier fails CI.
 */
import type { AppKey } from "../apps";

/** Where the supplier's credential actually lives. */
export type ManagedCredentialStore =
  /** One deployment-wide row, encrypted at rest, administered in the console. */
  | "platform_singleton"
  /** One child account per business, minted by provisioning (§2). */
  | "per_business_child"
  /** Per-business settings the business itself typed (its own account, not ours). */
  | "per_business_settings"
  /** No managed credential exists yet: the capability is not a managed service. */
  | "not_yet_managed";

/**
 * How far an integration has come.
 *
 * - `managed` — the tenant sees first-party words only, the credential is ours,
 *   wholesale is recorded separately from retail, and a guard test pins it.
 * - `partial` — the tenant sees first-party words, but one of the other three
 *   properties is still missing (usually the wholesale ledger).
 * - `vendor_visible` — a tenant-facing surface names the supplier today. Each of
 *   these must carry the issue that removes it; it is a to-do list, not a
 *   verdict.
 */
export type ManagedServiceMaturity = "managed" | "partial" | "vendor_visible";

export interface ManagedServiceInventoryEntry {
  /** Stable internal key, matching `MANAGED_SERVICES` where one exists. */
  key: string;
  /** First-party name a tenant may read. Never contains a supplier. */
  tenantLabel: string;
  owningApp: AppKey;
  /** Entitlement capability that gates the capability. */
  capability: string;
  /**
   * The supplier today — INTERNAL. Console, logs and adapters only; it must
   * never be serialised into a tenant response or rendered in a tenant screen.
   */
  supplier: string | null;
  credentialStore: ManagedCredentialStore;
  /** The platform console surface that administers it (provider detail is allowed there). */
  consoleSurface: string;
  /** Tenant-facing files that render this service's state. */
  tenantSurfaces: readonly string[];
  maturity: ManagedServiceMaturity;
  /** The issue that finishes the migration, when `maturity` is not `managed`. */
  followUpIssue: number | null;
  /** One sentence on what is left, for the reviewer rather than the customer. */
  note: string;
}

/**
 * Every provider-backed capability in the product, as of this slice.
 *
 * The list is the answer to §0's "audit existing connections/services" — and it
 * is deliberately a *list*, because the audit's finding was that the product
 * had no list.
 */
export const MANAGED_SERVICE_INVENTORY: readonly ManagedServiceInventoryEntry[] = [
  {
    key: "messaging.sms",
    tenantLabel: "پیامک",
    owningApp: "growth",
    capability: "cloud.messaging",
    supplier: "Kavenegar",
    credentialStore: "per_business_child",
    consoleSurface: "src/app/platform/messaging/managed-accounts-card.tsx",
    tenantSurfaces: [
      "src/app/(app)/growth/messaging-section.tsx",
      "src/app/(app)/settings/security-center-settings.tsx",
    ],
    maturity: "managed",
    followUpIssue: 902,
    note: "Child account per business (§2), platform-auth transport for login codes (§5e), retail settled once per message (§5d).",
  },
  {
    key: "messaging.email",
    tenantLabel: "ایمیل",
    owningApp: "growth",
    capability: "cloud.messaging",
    // Our own SMTP relay: the deployment-wide singleton in
    // `platform_message_config`, not a tenant's mail server.
    supplier: null,
    credentialStore: "platform_singleton",
    consoleSurface: "src/app/platform/messaging/page.tsx",
    tenantSurfaces: ["src/app/(app)/growth/messaging-section.tsx"],
    maturity: "partial",
    followUpIssue: 902,
    note: "The relay is ours, so there is no supplier name to leak; what is missing is a wholesale cost line from the relay's own billing, which §6a's ledger can now accept.",
  },
  {
    key: "ai.assistant",
    tenantLabel: "دستیار هوشمند",
    owningApp: "accounting",
    capability: "ai.use",
    supplier: "platform_ai_config",
    credentialStore: "platform_singleton",
    consoleSurface: "src/app/platform/ai/page.tsx",
    tenantSurfaces: ["src/app/(app)/settings/security-center-settings.tsx"],
    maturity: "partial",
    followUpIssue: null,
    note: "One deployment-wide credential, already first-party in tenant copy; the missing half is per-model wholesale cost in `billing_vendor_cost_events`, which needs a per-model price table the provider does not publish.",
  },
  {
    key: "payments.gateway",
    tenantLabel: "پرداخت آنلاین",
    owningApp: "accounting",
    capability: "billing.top_up",
    supplier: "Zarinpal",
    credentialStore: "platform_singleton",
    consoleSurface: "src/app/platform/billing/page.tsx",
    tenantSurfaces: ["src/app/(app)/settings/billing/billing-manager.tsx"],
    maturity: "partial",
    followUpIssue: null,
    note: "No tenant screen names the gateway; the wallet API reports only whether a top-up is online or a manual transfer. What is missing is the gateway fee in the wholesale ledger.",
  },
  {
    key: "media.storage",
    tenantLabel: "کتابخانهٔ رسانه",
    owningApp: "website",
    capability: "media.manage",
    supplier: "Parspack S3-compatible storage",
    credentialStore: "platform_singleton",
    consoleSurface: "src/app/platform/media/page.tsx",
    tenantSurfaces: ["src/app/(app)/websites/wp/media-section.tsx"],
    maturity: "managed",
    followUpIssue: null,
    note: "Tenant keys are per-business prefixes inside one bucket; the credential never leaves the console.",
  },
  {
    key: "website.wordpress",
    tenantLabel: "مدیریت وردپرس",
    owningApp: "website",
    capability: "website.manage",
    // Deliberately null: WordPress/WooCommerce is the *tenant's own* site, not a
    // supplier Bizamiz resells. Naming it is the product, and hiding it would be
    // the confusing kind of first-party copy.
    supplier: null,
    credentialStore: "per_business_settings",
    consoleSurface: "src/app/platform/media/page.tsx",
    tenantSurfaces: ["src/app/(app)/websites"],
    maturity: "managed",
    followUpIssue: null,
    note: "The tenant's own installation: the credentials are theirs, the vendor is the product, and there is no wholesale cost to hide.",
  },
  {
    key: "marketplaces.torob",
    tenantLabel: "ترب",
    owningApp: "website",
    capability: "marketplace.torob",
    supplier: "Torob",
    credentialStore: "not_yet_managed",
    consoleSurface: "src/app/platform/messaging/page.tsx",
    tenantSurfaces: [],
    maturity: "vendor_visible",
    followUpIssue: 894,
    note: "Not implemented yet: the issue is the migration. Listed so the audit is complete rather than flattering.",
  },
  {
    key: "marketplaces.divar",
    tenantLabel: "دیوار",
    owningApp: "website",
    capability: "marketplace.divar",
    supplier: "Divar",
    credentialStore: "not_yet_managed",
    consoleSurface: "src/app/platform/messaging/page.tsx",
    tenantSurfaces: [],
    maturity: "vendor_visible",
    followUpIssue: 896,
    note: "Not implemented yet: the issue is the migration. Listed for the same reason as Torob.",
  },
];

/**
 * Supplier names that must never appear on a tenant surface.
 *
 * Shared by the payload guard (`contract.ts`) and the source guard
 * (`inventory.test.ts`), because two patterns would drift. The Persian
 * spellings are here for the same reason: «کاوه‌نگار» on a settings page is the
 * same leak in a different alphabet.
 *
 * The separator allowance includes the zero-width non-joiner on purpose:
 * «کاوه‌نگار» is how the name is actually typed in Persian, and `\s` does not
 * match ZWNJ — the first version of this pattern only caught the spaced
 * spelling, which is the one nobody uses.
 *
 * The patterns are only for names that are unambiguously *ours to hide*: a
 * supplier Bizamiz resells. «دیوار» is also a retaining wall and «ترب» is also a
 * word, so those two appear only as their domain names — a guard that cries
 * wolf on ordinary Persian gets deleted, and then it guards nothing.
 */
export const SUPPLIER_NAME_PATTERN =
  /kavenegar|kaveh[\s\u200c\u200d-]*negar|parspack|zarinpal|torob\.ir|divar\.ir|کاوه[\s\u200c\u200d-]*نگار|پارس[\s\u200c\u200d-]*پک|زرین[\s\u200c\u200d-]*پال/i;

/** One entry by key, or undefined. */
export function managedInventoryEntry(key: string): ManagedServiceInventoryEntry | undefined {
  return MANAGED_SERVICE_INVENTORY.find((entry) => entry.key === key);
}
