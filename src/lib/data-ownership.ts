/**
 * The authoritative, machine-readable replication-domain contract.
 *
 * It deliberately describes the *shipped* data path rather than an aspiration.
 * UI copy, pairing capability disclosure, documentation and tests consume this
 * module so a newly added event/domain cannot accidentally be advertised as
 * replicated before it has a stable identity, conflict and recovery policy.
 */
import { SYNC_EVENT_REGISTRY } from "./sync-event-registry";
import { MASTER_SYNC_TABLES } from "./master-sync-registry";

/** v3 (Phase 45): shifts travel as events; v2 (migration 0190): customers and the menu sync continuously. */
export const REPLICATION_CONTRACT_VERSION = 3 as const;

export type DataOwnership =
  | "site_authoritative"
  | "cloud_authoritative"
  | "shared_synchronized"
  | "device_local";
export type SyncDirection =
  "site_to_cloud" | "cloud_to_site" | "bidirectional" | "none";
export type ConflictPolicy =
  | "immutable_idempotent"
  | "append_only"
  | "append_or_reverse"
  | "field_merge_with_version"
  | "authoritative_scope"
  | "never_sync";
export type TombstonePolicy =
  "tombstone" | "archive" | "authoritative_delete" | "not_applicable";
export type ContinuousSyncState =
  "active" | "bootstrap_only" | "not_replicated";
export type EventDisposition =
  "outbox_and_inbox" | "compatibility_receive_only";
/**
 * How a domain travels. `events`: versioned domain events through the
 * sync_events outbox/inbox. `master_feed`: row state with per-field clocks
 * through the master-data feed (master-sync-service.ts, migration 0190).
 */
export type SyncTransport = "events" | "master_feed" | "none";

/** A versioned event entry in the replication contract, never a wildcard. */
export interface ReplicationEventDefinition {
  type: string;
  schemaVersion: number;
  /** Whether current site code can create this event as well as apply it. */
  disposition: EventDisposition;
}

/**
 * Exact profiles in which a domain is allowed to move between deployments.
 * `local` intentionally never appears in `continuousSyncProfiles`: Local-only
 * operations remain local and must not initiate a cloud connection.
 */
export interface DeploymentAvailability {
  localOperationProfiles: readonly ("local" | "hybrid")[];
  continuousSyncProfiles: readonly ("hybrid" | "cloud")[];
  bootstrapProfiles: readonly "hybrid"[];
}

export interface DomainOwnershipDefinition {
  domain: string;
  authority: DataOwnership;
  /** Compatibility alias retained for existing consumers. */
  ownership: DataOwnership;
  direction: SyncDirection;
  conflictPolicy: ConflictPolicy;
  /** Explicit lifecycle/tombstone contract; never infer a delete from absence. */
  tombstonePolicy: TombstonePolicy;
  /** Compatibility alias retained for existing consumers. */
  deletion: TombstonePolicy;
  bootstrap: "required" | "optional" | "none";
  continuousSync: ContinuousSyncState;
  deploymentAvailability: DeploymentAvailability;
  /** Stable cross-peer identity used by idempotency and conflict handling. */
  identity: string;
  /** The durable retry/replay rule an operator can rely on. */
  retry: string;
  transport: SyncTransport;
  events: readonly ReplicationEventDefinition[];
  /** For `master_feed`: exactly the tables MASTER_SYNC_TABLES captures for this domain. */
  masterTables?: readonly string[];
}

const SITE_OPERATIONAL_PROFILES = ["local", "hybrid"] as const;
const HYBRID_SYNC_PROFILES = ["hybrid", "cloud"] as const;
const HYBRID_BOOTSTRAP_PROFILES = ["hybrid"] as const;
const NO_SYNC_PROFILES: readonly ("hybrid" | "cloud")[] = [];
const NO_BOOTSTRAP_PROFILES: readonly "hybrid"[] = [];

function event(
  type: string,
  schemaVersion: number,
  disposition: EventDisposition = "outbox_and_inbox",
): ReplicationEventDefinition {
  return { type, schemaVersion, disposition };
}

function replicated(
  definition: Omit<
    DomainOwnershipDefinition,
    | "authority"
    | "ownership"
    | "tombstonePolicy"
    | "deletion"
    | "deploymentAvailability"
  > & {
    authority: DataOwnership;
    tombstonePolicy: TombstonePolicy;
  },
): DomainOwnershipDefinition {
  return {
    ...definition,
    ownership: definition.authority,
    deletion: definition.tombstonePolicy,
    deploymentAvailability: {
      localOperationProfiles: SITE_OPERATIONAL_PROFILES,
      continuousSyncProfiles: HYBRID_SYNC_PROFILES,
      bootstrapProfiles: HYBRID_BOOTSTRAP_PROFILES,
    },
  };
}

function cloudOrBootstrapOnly(
  definition: Omit<
    DomainOwnershipDefinition,
    | "authority"
    | "ownership"
    | "tombstonePolicy"
    | "deletion"
    | "deploymentAvailability"
  > & {
    authority: DataOwnership;
    tombstonePolicy: TombstonePolicy;
  },
): DomainOwnershipDefinition {
  return {
    ...definition,
    ownership: definition.authority,
    deletion: definition.tombstonePolicy,
    deploymentAvailability: {
      localOperationProfiles:
        definition.authority === "device_local"
          ? SITE_OPERATIONAL_PROFILES
          : [],
      continuousSyncProfiles: NO_SYNC_PROFILES,
      bootstrapProfiles:
        definition.bootstrap === "none"
          ? NO_BOOTSTRAP_PROFILES
          : HYBRID_BOOTSTRAP_PROFILES,
    },
  };
}

/**
 * Every replicated domain must be declared here before code can claim it in
 * pairing, diagnostics, docs or tests. Financial facts use immutable/append
 * semantics; mutable master data is honestly marked bootstrap-only until its
 * version/tombstone event producer exists.
 */
export const DATA_OWNERSHIP_REGISTRY = {
  // Operational domains: the desktop is the authority for its branch, and
  // (contract v2) a write the owner makes in the cloud for that branch is
  // delivered to it as the same event, so both directions converge.
  orders: replicated({
    domain: "orders",
    authority: "site_authoritative",
    direction: "bidirectional",
    conflictPolicy: "immutable_idempotent",
    tombstonePolicy: "archive",
    bootstrap: "optional",
    continuousSync: "active",
    identity: "location-scoped order and line UUIDs plus client_event_id",
    retry:
      "transactional sync_events outbox; an open order converges by whole-state transfer ordered by hybrid logical clock; at-least-once delivery and idempotent application",
    transport: "events",
    events: [
      event("order.create", 1),
      event("order.add_items", 1),
      event("order_item.status", 1),
      event("order.state.synced", 1),
      event("order.amendment.posted", 1),
    ],
  }),
  payments: replicated({
    domain: "payments",
    authority: "site_authoritative",
    direction: "bidirectional",
    conflictPolicy: "append_only",
    tombstonePolicy: "not_applicable",
    bootstrap: "optional",
    continuousSync: "active",
    identity: "location-scoped payment or return UUID plus client_event_id",
    retry:
      "transactional sync_events outbox; payments append and returns compensate rather than overwrite; replays keep the paying side's instant and journal date",
    transport: "events",
    events: [
      event("order.payment.completed", 1, "compatibility_receive_only"),
      event("order.payment.completed", 2),
      event("order.customer_return.created", 1),
    ],
  }),
  shifts: replicated({
    domain: "shifts",
    authority: "site_authoritative",
    direction: "bidirectional",
    conflictPolicy: "immutable_idempotent",
    tombstonePolicy: "not_applicable",
    bootstrap: "none",
    continuousSync: "active",
    identity: "shift UUID; client_event_id shift.opened:<id> / shift.closed:<id>",
    retry:
      "transactional sync_events outbox; the row is upserted by id; a missing employee defers; a second open shift for the same person dead-letters",
    transport: "events",
    events: [event("shift.opened", 1), event("shift.closed", 1)],
  }),
  /*
   * The ledger is **cloud-authoritative**, and this entry says so because two
   * contracts used to say two different things.
   *
   * `replication-catalogue.ts` and `sync-event-registry.ts` both describe the
   * cloud as the system of record for ledger effects (Phase 45: a desktop pulls
   * a `journal_reversal` and *acknowledges* it rather than applying it), while
   * this module called the domain `site_authoritative` + `bidirectional` +
   * `continuousSync: active`. One source of truth, stated twice, in opposite
   * ways: a reader could not tell whether a site's ledger or the cloud's wins.
   *
   * The answer is the cloud's. Fiscal periods, the chart of accounts, the
   * draft → review → approve workflow and the journal entries themselves are
   * all owned by the cloud; a site's *only* ledger effect is reversing a manual
   * entry, and that travels as a request the cloud applies
   * (`site_to_cloud`), never as a second authoritative copy. Drafts,
   * approvals and rejections have no events at all on purpose — they are
   * cloud-only workflow, not replicated state.
   */
  accounting_journals: replicated({
    domain: "accounting_journals",
    authority: "cloud_authoritative",
    direction: "site_to_cloud",
    conflictPolicy: "append_or_reverse",
    tombstonePolicy: "not_applicable",
    bootstrap: "optional",
    continuousSync: "active",
    identity: "journal entry UUID plus deterministic reversal client_event_id",
    retry:
      "transactional sync_events outbox; reversals never overwrite posted facts; approvals and draft workflow are cloud-only and never replicated",
    transport: "events",
    events: [event("accounting.manual_journal.reversed", 1)],
  }),
  inventory_movements: replicated({
    domain: "inventory_movements",
    authority: "site_authoritative",
    direction: "bidirectional",
    conflictPolicy: "append_only",
    tombstonePolicy: "not_applicable",
    bootstrap: "optional",
    continuousSync: "active",
    identity: "location-scoped operation UUID plus client_event_id",
    retry:
      "transactional sync_events outbox; dependent events defer, terminal failures dead-letter",
    transport: "events",
    events: [
      event("inventory.purchase.created", 1),
      event("inventory.purchase.received", 1),
      event("inventory.supplier_return.created", 1),
      event("inventory.transfer.created", 1),
      event("inventory.transfer.shipped", 1),
      event("inventory.transfer.received", 1),
      event("inventory.transfer.cancelled", 1),
      event("inventory.waste.recorded", 1),
      event("inventory.stock_count.recorded", 1),
      event("inventory.stock_count.reversed", 1),
      event("retail.stock_count.recorded", 1),
      event("retail.stock_count.reversed", 1),
      event("inventory.production.recorded", 1),
      event("inventory.production.reversed", 1),
    ],
  }),
  // Master data (contract v2): row state merged field by field — the later
  // edit of each field wins, edits to different fields both survive.
  customers: replicated({
    domain: "customers",
    authority: "shared_synchronized",
    direction: "bidirectional",
    conflictPolicy: "field_merge_with_version",
    tombstonePolicy: "tombstone",
    bootstrap: "required",
    continuousSync: "active",
    identity: "stable party UUID",
    retry:
      "per-field hybrid-logical-clock capture by trigger; commit-safe feed in both directions; a missing parent defers, an unmergeable change is recorded as a master conflict",
    transport: "master_feed",
    events: [],
    masterTables: ["party_categories", "parties"],
  }),
  products_menu: replicated({
    domain: "products_menu",
    authority: "shared_synchronized",
    direction: "bidirectional",
    conflictPolicy: "field_merge_with_version",
    tombstonePolicy: "tombstone",
    bootstrap: "required",
    continuousSync: "active",
    identity: "stable catalogue UUIDs and location scope",
    retry:
      "per-field hybrid-logical-clock capture by trigger; commit-safe feed in both directions; derived costs and table occupancy never merge",
    transport: "master_feed",
    events: [],
    masterTables: [
      "payment_methods",
      "menu_categories",
      "modifier_groups",
      "modifiers",
      "inventory_items",
      "menu_items",
      "dining_tables",
      "menu_item_modifier_groups",
      "menu_item_ingredients",
      "modifier_ingredients",
    ],
  }),
  // Issue #795 Phase 7: the serialized-retail catalogue (watch models,
  // brands, structured attributes — migration 0206). Only the catalogue:
  // item_serials and everything downstream (sales, warranties, repairs,
  // reservations) stay under inventory_movements' cloud authority, so a
  // single side decides a sale and a serial can never sell twice across
  // devices.
  retail_catalogue: replicated({
    domain: "retail_catalogue",
    authority: "shared_synchronized",
    direction: "bidirectional",
    conflictPolicy: "field_merge_with_version",
    tombstonePolicy: "tombstone",
    bootstrap: "required",
    continuousSync: "active",
    identity: "stable catalogue UUIDs and location scope",
    retry:
      "per-field hybrid-logical-clock capture by trigger; commit-safe feed in both directions; serialized units never merge — stock stays cloud-owned",
    transport: "master_feed",
    events: [],
    masterTables: ["item_brands", "items", "watch_item_attributes"],
  }),
  staff_access: cloudOrBootstrapOnly({
    domain: "staff_access",
    authority: "cloud_authoritative",
    direction: "cloud_to_site",
    conflictPolicy: "authoritative_scope",
    tombstonePolicy: "tombstone",
    bootstrap: "required",
    continuousSync: "bootstrap_only",
    identity: "stable user/platform identity UUID",
    retry:
      "separate IAM control-plane stream (iam_events), applied before any operational event",
    transport: "none",
    events: [],
  }),
  plans_billing: cloudOrBootstrapOnly({
    domain: "plans_billing",
    authority: "cloud_authoritative",
    direction: "cloud_to_site",
    conflictPolicy: "authoritative_scope",
    tombstonePolicy: "authoritative_delete",
    bootstrap: "optional",
    continuousSync: "bootstrap_only",
    identity: "central plan and entitlement identity",
    retry: "cloud capability checks are separate from operational sync",
    transport: "none",
    events: [],
  }),
  printer_settings: cloudOrBootstrapOnly({
    domain: "printer_settings",
    authority: "device_local",
    direction: "none",
    conflictPolicy: "never_sync",
    tombstonePolicy: "not_applicable",
    bootstrap: "none",
    continuousSync: "not_replicated",
    identity: "device-local printer identifier",
    retry: "never transported",
    transport: "none",
    events: [],
  }),
  backup_paths: cloudOrBootstrapOnly({
    domain: "backup_paths",
    authority: "device_local",
    direction: "none",
    conflictPolicy: "never_sync",
    tombstonePolicy: "not_applicable",
    bootstrap: "none",
    continuousSync: "not_replicated",
    identity: "device-local filesystem path",
    retry: "never transported",
    transport: "none",
    events: [],
  }),
  lan_gateway: cloudOrBootstrapOnly({
    domain: "lan_gateway",
    authority: "device_local",
    direction: "none",
    conflictPolicy: "never_sync",
    tombstonePolicy: "not_applicable",
    bootstrap: "none",
    continuousSync: "not_replicated",
    identity: "device-local network adapter and certificate",
    retry: "never transported",
    transport: "none",
    events: [],
  }),
  certificate_paths: cloudOrBootstrapOnly({
    domain: "certificate_paths",
    authority: "device_local",
    direction: "none",
    conflictPolicy: "never_sync",
    tombstonePolicy: "not_applicable",
    bootstrap: "none",
    continuousSync: "not_replicated",
    identity: "device-local certificate path",
    retry: "never transported",
    transport: "none",
    events: [],
  }),
  database_paths: cloudOrBootstrapOnly({
    domain: "database_paths",
    authority: "device_local",
    direction: "none",
    conflictPolicy: "never_sync",
    tombstonePolicy: "not_applicable",
    bootstrap: "none",
    continuousSync: "not_replicated",
    identity: "device-local PostgreSQL data path",
    retry: "never transported",
    transport: "none",
    events: [],
  }),
  cloud_exception_transport: cloudOrBootstrapOnly({
    domain: "cloud_exception_transport",
    authority: "device_local",
    direction: "none",
    conflictPolicy: "never_sync",
    tombstonePolicy: "not_applicable",
    bootstrap: "none",
    continuousSync: "not_replicated",
    identity: "installation identity plus opaque relay event ID",
    retry: "separate bounded cloud-exception outbox, never operational sync",
    transport: "none",
    events: [],
  }),
  // Issue #799 §26 — the AEC registers, classified rather than assumed. The
  // per-table audit (bucket, reason, the protocol each would need first, and the
  // guard that keeps every table in one bucket) lives in
  // `aec-sync-classification.ts`; these two domains are what this contract, the
  // pairing disclosure and the docs read. Nothing here replicates today: a pair
  // is a till, and an AEC business has no till modules, so a paired AEC desktop
  // opens on the cloud pane instead of a half-copy of a register. `not_replicated`
  // is therefore a statement of fact, and `replicationContractProblems()` refuses
  // any of these that starts advertising continuous sync without a protocol.
  aec_field_capture: cloudOrBootstrapOnly({
    domain: "aec_field_capture",
    authority: "cloud_authoritative",
    direction: "none",
    conflictPolicy: "never_sync",
    tombstonePolicy: "archive",
    bootstrap: "none",
    continuousSync: "not_replicated",
    identity: "server-issued register number per project, plus the record's own UUID",
    retry:
      "never transported today. §26's candidates (site logs, inspections, snags, daily progress, RFI and submittal drafts, photo and drawing metadata) each require an explicit event with a repeatable key, server-side numbering and the register's own freeze boundary before any of them may travel",
    transport: "none",
    events: [],
  }),
  aec_commercial_registers: cloudOrBootstrapOnly({
    domain: "aec_commercial_registers",
    authority: "cloud_authoritative",
    direction: "none",
    conflictPolicy: "never_sync",
    tombstonePolicy: "archive",
    bootstrap: "none",
    continuousSync: "not_replicated",
    identity: "server-issued register number (VO-, PC-, MR-, RFQ-, PO-, SC-) per project",
    retry:
      "never transported, by §26's explicit rule: these are status machines whose terminal states move money and feed Accounting, and a field-by-field merge could produce the very states their trigger guards refuse. Any future transport must be an explicit event carrying a decision",
    transport: "none",
    events: [],
  }),
} as const satisfies Record<string, DomainOwnershipDefinition>;

export type DataDomain = keyof typeof DATA_OWNERSHIP_REGISTRY;

/** A serializable top-level document for diagnostics, docs and capability UI. */
export const REPLICATION_DOMAIN_CONTRACT = {
  version: REPLICATION_CONTRACT_VERSION,
  domains: Object.values(DATA_OWNERSHIP_REGISTRY),
} as const;

export function ownershipFor(domain: DataDomain): DomainOwnershipDefinition {
  return DATA_OWNERSHIP_REGISTRY[domain];
}

/**
 * Fail closed when an event is added to the advertised contract without an
 * exact handler/version in the executable registry. Kept pure for startup and
 * deploy-time checks; tests exercise the result with useful assertions.
 */
export function replicationContractProblems(): string[] {
  const available = new Set(
    SYNC_EVENT_REGISTRY.map((entry) => `${entry.type}@${entry.schemaVersion}`),
  );
  const problems: string[] = [];
  const capturedTables = new Set(MASTER_SYNC_TABLES.map((config) => config.table));
  const claimedTables = new Set<string>();
  for (const domain of REPLICATION_DOMAIN_CONTRACT.domains) {
    for (const listed of domain.events) {
      if (!available.has(`${listed.type}@${listed.schemaVersion}`)) {
        problems.push(
          `${domain.domain}: unknown event ${listed.type}@${listed.schemaVersion}`,
        );
      }
    }
    if (domain.continuousSync === "active" && domain.transport === "events" && domain.events.length === 0) {
      problems.push(`${domain.domain}: active continuous sync has no events`);
    }
    if (domain.continuousSync === "active" && domain.transport === "none") {
      problems.push(`${domain.domain}: active continuous sync has no transport`);
    }
    if (domain.transport === "master_feed") {
      const tables = domain.masterTables ?? [];
      if (tables.length === 0) problems.push(`${domain.domain}: master feed lists no tables`);
      for (const table of tables) {
        if (!capturedTables.has(table)) problems.push(`${domain.domain}: ${table} is not captured by the master feed`);
        if (claimedTables.has(table)) problems.push(`${domain.domain}: ${table} is claimed by two domains`);
        claimedTables.add(table);
      }
    }
    if (
      domain.continuousSync !== "active" &&
      domain.deploymentAvailability.continuousSyncProfiles.length > 0
    ) {
      problems.push(
        `${domain.domain}: non-active domain advertises continuous sync`,
      );
    }
  }
  return problems;
}

/** Every captured master table belongs to exactly one declared domain. */
export function unclaimedMasterTables(): string[] {
  const claimed = new Set(
    REPLICATION_DOMAIN_CONTRACT.domains.flatMap((domain) => ("masterTables" in domain ? domain.masterTables ?? [] : [])),
  );
  return MASTER_SYNC_TABLES.map((config) => config.table).filter((table) => !claimed.has(table));
}
