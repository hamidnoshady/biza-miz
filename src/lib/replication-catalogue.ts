/**
 * The single ownership contract for Desktop/Hybrid replication.
 *
 * This deliberately describes product ownership rather than pretending every
 * table is a bidirectional replica.  Runtime event names are derived from the
 * authoritative sync registry below; no second handwritten list of event
 * strings is allowed in pairing copy or diagnostics.
 */
import { SYNC_EVENT_REGISTRY, type SyncEventDefinition } from "./sync-event-registry";

export type ReplicationAuthority =
  | "cloud_authoritative"
  | "site_authoritative"
  | "bidirectional"
  | "site_local"
  | "cloud_only";
export type BootstrapPolicy = "snapshot" | "identity_only" | "none";
export type LocationScope = "business" | "site" | "cross_location" | "machine";
export type RetryPolicy = "idempotent_replay" | "manual_reconciliation" | "not_applicable";
export type DependencyPolicy = "strict" | "defer" | "none";

export interface ReplicationDomainDefinition {
  key: string;
  label: string;
  authority: ReplicationAuthority;
  bootstrap: BootstrapPolicy;
  /** Registry effect classes whose event names belong to this domain. */
  eventEffectClasses: readonly SyncEventDefinition["effectClass"][];
  conflictPolicy: string;
  locationScope: LocationScope;
  retryPolicy: RetryPolicy;
  dependencyPolicy: DependencyPolicy;
  mediaTransfer: "none" | "metadata" | "on_demand" | "full";
  deploymentProfiles: readonly ("cloud" | "hybrid" | "site")[];
  notes: string;
}

export interface ReplicationDomain extends Omit<ReplicationDomainDefinition, "eventEffectClasses"> {
  eventTypes: string[];
}

/**
 * Every mutable desktop-relevant domain is declared here.  A domain with no
 * events is intentionally explicit: it is either a bootstrap-only contract or
 * cloud/site-local data, never an accidental sync omission.
 */
export const REPLICATION_DOMAIN_DEFINITIONS: readonly ReplicationDomainDefinition[] = [
  { key: "business_settings", label: "Business profile and operational settings", authority: "cloud_authoritative", bootstrap: "snapshot", eventEffectClasses: [], conflictPolicy: "cloud replaces on repair", locationScope: "business", retryPolicy: "manual_reconciliation", dependencyPolicy: "none", mediaTransfer: "none", deploymentProfiles: ["cloud", "hybrid", "site"], notes: "Bootstrap settings are explicit; ongoing settings changes are not yet replicated." },
  { key: "users_permissions", label: "Users, staff and permissions", authority: "cloud_authoritative", bootstrap: "snapshot", eventEffectClasses: [], conflictPolicy: "cloud replaces on repair", locationScope: "business", retryPolicy: "manual_reconciliation", dependencyPolicy: "strict", mediaTransfer: "none", deploymentProfiles: ["cloud", "hybrid", "site"], notes: "Active credential hashes and branch assignments seed the site; ongoing team edits are cloud-managed." },
  { key: "locations", label: "Business location identities", authority: "cloud_authoritative", bootstrap: "identity_only", eventEffectClasses: [], conflictPolicy: "cloud replaces on repair", locationScope: "cross_location", retryPolicy: "manual_reconciliation", dependencyPolicy: "strict", mediaTransfer: "none", deploymentProfiles: ["cloud", "hybrid", "site"], notes: "All branch identities travel so cross-location references can be resolved; only the paired branch has operational data." },
  { key: "catalogue", label: "Menus, products, modifiers and prices", authority: "cloud_authoritative", bootstrap: "snapshot", eventEffectClasses: [], conflictPolicy: "cloud replaces on repair", locationScope: "site", retryPolicy: "manual_reconciliation", dependencyPolicy: "strict", mediaTransfer: "on_demand", deploymentProfiles: ["cloud", "hybrid", "site"], notes: "Menu, recipe and price master data are seeded. Ongoing catalogue mutation needs an explicit future event before it is advertised as live." },
  { key: "inventory_catalogue", label: "Inventory items", authority: "cloud_authoritative", bootstrap: "snapshot", eventEffectClasses: [], conflictPolicy: "cloud replaces on repair", locationScope: "site", retryPolicy: "manual_reconciliation", dependencyPolicy: "strict", mediaTransfer: "none", deploymentProfiles: ["cloud", "hybrid", "site"], notes: "Item metadata seeds a site; balances and lots do not." },
  { key: "stock_and_lots", label: "Stock balances and lots", authority: "site_authoritative", bootstrap: "none", eventEffectClasses: ["inventory", "transfer"], conflictPolicy: "idempotent domain effect", locationScope: "site", retryPolicy: "idempotent_replay", dependencyPolicy: "defer", mediaTransfer: "none", deploymentProfiles: ["hybrid", "site"], notes: "Operational mutations synchronize as explicit domain events, never as direct balance replication." },
  { key: "orders", label: "Orders", authority: "bidirectional", bootstrap: "none", eventEffectClasses: ["order"], conflictPolicy: "idempotency key and order-state conflict", locationScope: "site", retryPolicy: "idempotent_replay", dependencyPolicy: "defer", mediaTransfer: "none", deploymentProfiles: ["hybrid", "site"], notes: "New operational events sync; historical orders are not a bootstrap copy." },
  { key: "payments", label: "Payments and tenders", authority: "bidirectional", bootstrap: "none", eventEffectClasses: ["payment"], conflictPolicy: "idempotency key and settlement validation", locationScope: "site", retryPolicy: "idempotent_replay", dependencyPolicy: "defer", mediaTransfer: "none", deploymentProfiles: ["hybrid", "site"], notes: "Payment effects wait for their order dependency." },
  { key: "shifts", label: "Employee shifts and cash-ups", authority: "site_authoritative", bootstrap: "none", eventEffectClasses: ["shift"], conflictPolicy: "row upserted by shift id; a second open shift for one person dead-letters", locationScope: "site", retryPolicy: "idempotent_replay", dependencyPolicy: "defer", mediaTransfer: "none", deploymentProfiles: ["hybrid", "site"], notes: "Phase 45: shifts opened and cashed up at the till reach the cloud; the till session and device stay local." },
  { key: "refunds", label: "Returns and refunds", authority: "bidirectional", bootstrap: "none", eventEffectClasses: ["refund"], conflictPolicy: "idempotency key and completed-order validation", locationScope: "site", retryPolicy: "idempotent_replay", dependencyPolicy: "defer", mediaTransfer: "none", deploymentProfiles: ["hybrid", "site"], notes: "Historical refund data is not seeded." },
  { key: "commission_settlement", label: "Commission payouts and reversals", authority: "cloud_only", bootstrap: "none", eventEffectClasses: ["commission_settlement"], conflictPolicy: "immutable; each payout and reversal is one event keyed by its own id", locationScope: "business", retryPolicy: "idempotent_replay", dependencyPolicy: "none", mediaTransfer: "none", deploymentProfiles: ["cloud"], notes: "Commission runs are cloud-only: a run covers every branch and no site holds one. Each payout and each reversal of one is a business-scope sync event written in the transaction that moves the money. Business-wide consumers receive it; a desktop acknowledges a pulled copy and never applies it, because the money has already moved, and a replayed copy is refused (#869)." },
  { key: "journals", label: "Journal effects and fiscal controls", authority: "cloud_authoritative", bootstrap: "snapshot", eventEffectClasses: ["journal_reversal"], conflictPolicy: "ledger approval is authoritative", locationScope: "site", retryPolicy: "idempotent_replay", dependencyPolicy: "strict", mediaTransfer: "none", deploymentProfiles: ["cloud", "hybrid", "site"], notes: "The cloud is the single source of truth for the ledger (matches data-ownership.ts and the sync registry): the chart seeds locally, and accounting documents, fiscal periods, drafts, approvals and reports are all cloud-authoritative. A site's one ledger effect — reversing a manual entry — travels site-to-cloud as a request the cloud applies, tagged with the original entry's own branch, never the caller's." },
  { key: "customers_crm", label: "Customers and CRM", authority: "cloud_only", bootstrap: "none", eventEffectClasses: [], conflictPolicy: "not applicable", locationScope: "business", retryPolicy: "not_applicable", dependencyPolicy: "none", mediaTransfer: "none", deploymentProfiles: ["cloud"], notes: "Customer/CRM history is not presented as synchronized desktop data." },
  { key: "loyalty_credit", label: "Loyalty and store credit", authority: "cloud_only", bootstrap: "none", eventEffectClasses: [], conflictPolicy: "not applicable", locationScope: "business", retryPolicy: "not_applicable", dependencyPolicy: "none", mediaTransfer: "none", deploymentProfiles: ["cloud"], notes: "Cloud-only until an explicit value-safe protocol is introduced." },
  { key: "suppliers_purchases", label: "Suppliers and purchases", authority: "bidirectional", bootstrap: "none", eventEffectClasses: ["inventory"], conflictPolicy: "idempotent domain effect", locationScope: "site", retryPolicy: "idempotent_replay", dependencyPolicy: "defer", mediaTransfer: "none", deploymentProfiles: ["hybrid", "site"], notes: "Purchase-related events are supported; supplier master data must exist before replay." },
  { key: "stock_counts_waste_production", label: "Stock counts, waste and production", authority: "site_authoritative", bootstrap: "none", eventEffectClasses: ["inventory"], conflictPolicy: "idempotent domain effect", locationScope: "site", retryPolicy: "idempotent_replay", dependencyPolicy: "defer", mediaTransfer: "none", deploymentProfiles: ["hybrid", "site"], notes: "These operational effects are replayed through inventory domain handlers." },
  { key: "transfers", label: "Cross-branch transfers", authority: "cloud_authoritative", bootstrap: "identity_only", eventEffectClasses: ["transfer"], conflictPolicy: "cloud orchestrates cross-location lifecycle", locationScope: "cross_location", retryPolicy: "manual_reconciliation", dependencyPolicy: "strict", mediaTransfer: "none", deploymentProfiles: ["cloud", "hybrid", "site"], notes: "Branch location identities are seeded. Cross-location transfer orchestration is cloud-authoritative; sites must not treat a single branch snapshot as a complete transfer ledger." },
  { key: "payment_methods", label: "Payment methods", authority: "cloud_authoritative", bootstrap: "snapshot", eventEffectClasses: [], conflictPolicy: "cloud replaces on repair", locationScope: "business", retryPolicy: "manual_reconciliation", dependencyPolicy: "strict", mediaTransfer: "none", deploymentProfiles: ["cloud", "hybrid", "site"], notes: "Named methods seed locally; live configuration changes are cloud-managed." },
  { key: "tables_reservations", label: "Tables and reservations", authority: "site_local", bootstrap: "snapshot", eventEffectClasses: [], conflictPolicy: "site owns current floor state", locationScope: "site", retryPolicy: "not_applicable", dependencyPolicy: "none", mediaTransfer: "none", deploymentProfiles: ["hybrid", "site"], notes: "Table definitions seed; availability and reservations are intentionally local." },
  { key: "media", label: "Media metadata and files", authority: "cloud_authoritative", bootstrap: "snapshot", eventEffectClasses: [], conflictPolicy: "cloud object store is authoritative", locationScope: "business", retryPolicy: "manual_reconciliation", dependencyPolicy: "none", mediaTransfer: "on_demand", deploymentProfiles: ["cloud", "hybrid", "site"], notes: "Referenced metadata seeds; menu bytes are fetched on demand; media history is cloud-only." },
  { key: "features_plans", label: "Feature and plan configuration", authority: "cloud_authoritative", bootstrap: "snapshot", eventEffectClasses: [], conflictPolicy: "cloud replaces on repair", locationScope: "business", retryPolicy: "manual_reconciliation", dependencyPolicy: "none", mediaTransfer: "none", deploymentProfiles: ["cloud", "hybrid", "site"], notes: "Feature entitlement snapshot prevents a site from inventing cloud plan state." },
  { key: "integrations", label: "Website, Woo, WordPress, Holoo, API and MCP state", authority: "cloud_only", bootstrap: "none", eventEffectClasses: [], conflictPolicy: "not applicable", locationScope: "business", retryPolicy: "not_applicable", dependencyPolicy: "none", mediaTransfer: "none", deploymentProfiles: ["cloud"], notes: "Connection secrets and integration work queues do not travel to desktops." },
  { key: "machine_state", label: "Desktop machine state", authority: "site_local", bootstrap: "none", eventEffectClasses: [], conflictPolicy: "not applicable", locationScope: "machine", retryPolicy: "not_applicable", dependencyPolicy: "none", mediaTransfer: "none", deploymentProfiles: ["site"], notes: "Certificates, printers, LAN gateway, local backups and offline browser queues stay on the machine." },
  // Issue #799 §26. The AEC registers' classification lives in
  // `aec-sync-classification.ts` (with §26's two buckets and the guard that keeps
  // every table in one of them); these two domains are its projection into this
  // catalogue, so the pairing screen's coverage copy tells an AEC tenant the
  // truth: none of it replicates today, because a pair is a *till* and an AEC
  // business has no till modules — the desktop shows the cloud pane.
  { key: "aec_field_capture", label: "AEC field capture (site logs, inspections, snags, RFI drafts)", authority: "cloud_only", bootstrap: "none", eventEffectClasses: [], conflictPolicy: "not applicable until a field-capture protocol exists", locationScope: "business", retryPolicy: "not_applicable", dependencyPolicy: "none", mediaTransfer: "metadata", deploymentProfiles: ["cloud"], notes: "§26's offline candidates. Nothing travels yet: each entry in aec-sync-classification.ts states the event, the server-side numbering and the freeze boundary a field-capture protocol must add first." },
  { key: "aec_commercial_registers", label: "AEC commercial registers (BOQ, variations, certificates, procurement, transmittals)", authority: "cloud_only", bootstrap: "none", eventEffectClasses: [], conflictPolicy: "explicit event with a decision — never last-write-wins", locationScope: "business", retryPolicy: "not_applicable", dependencyPolicy: "none", mediaTransfer: "none", deploymentProfiles: ["cloud"], notes: "§26 forbids putting these into generic master-data merge: they are status machines whose terminal states move money and feed Accounting, and their guards refuse exactly the states a field-by-field merge could produce." },
] as const;

export function replicationCatalogue(): ReplicationDomain[] {
  return REPLICATION_DOMAIN_DEFINITIONS.map(({ eventEffectClasses, ...domain }) => ({
    ...domain,
    eventTypes: [...new Set(
      SYNC_EVENT_REGISTRY
        .filter((event) => eventEffectClasses.includes(event.effectClass))
        .map((event) => event.type),
    )],
  }));
}

/** Pairing's user-facing coverage copy is a projection of the same catalogue. */
export function pairingDataClassification(): {
  bootstrapMasterData: string[];
  ongoingDomainEvents: string[];
  siteLocalOperationalData: string[];
  centralOnlyData: string[];
  notYetReplicated: string[];
} {
  const catalogue = replicationCatalogue();
  const bootstrap = catalogue.filter((domain) => domain.bootstrap !== "none").map((domain) => domain.label);
  const siteLocal = catalogue.filter((domain) => domain.authority === "site_local").map((domain) => domain.label);
  const cloudOnly = catalogue.filter((domain) => domain.authority === "cloud_only").map((domain) => domain.label);
  const notLive = catalogue
    .filter((domain) => domain.bootstrap !== "none" && domain.eventTypes.length === 0 && domain.authority !== "site_local")
    .map((domain) => domain.label);
  return {
    bootstrapMasterData: bootstrap,
    ongoingDomainEvents: [...new Set(catalogue.flatMap((domain) => domain.eventTypes))].sort(),
    siteLocalOperationalData: siteLocal,
    centralOnlyData: cloudOnly,
    notYetReplicated: [
      ...notLive,
      "journal entries, fiscal periods, bank reconciliation, payroll, tax filings, and accounting documents",
    ],
  };
}

/** A CI-friendly invariant: every registered ongoing event has explicit ownership. */
export function replicationCatalogueProblems(): string[] {
  const catalogued = new Set(replicationCatalogue().flatMap((domain) => domain.eventTypes));
  return SYNC_EVENT_REGISTRY
    .filter((event) => !catalogued.has(event.type))
    .map((event) => `${event.type}@${event.schemaVersion}`);
}
