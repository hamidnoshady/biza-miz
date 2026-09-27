/**
 * The authoritative, machine-readable replication-domain contract.
 *
 * It deliberately describes the *shipped* data path rather than an aspiration.
 * UI copy, pairing capability disclosure, documentation and tests consume this
 * module so a newly added event/domain cannot accidentally be advertised as
 * replicated before it has a stable identity, conflict and recovery policy.
 */
import { SYNC_EVENT_REGISTRY } from "./sync-event-registry";

export const REPLICATION_CONTRACT_VERSION = 1 as const;

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
  events: readonly ReplicationEventDefinition[];
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
  orders: replicated({
    domain: "orders",
    authority: "site_authoritative",
    direction: "site_to_cloud",
    conflictPolicy: "immutable_idempotent",
    tombstonePolicy: "archive",
    bootstrap: "optional",
    continuousSync: "active",
    identity: "location-scoped order UUID plus client_event_id",
    retry:
      "transactional sync_events outbox; at-least-once delivery and idempotent application",
    events: [
      event("order.create", 1),
      event("order.add_items", 1),
      event("order_item.status", 1),
    ],
  }),
  payments: replicated({
    domain: "payments",
    authority: "site_authoritative",
    direction: "site_to_cloud",
    conflictPolicy: "append_only",
    tombstonePolicy: "not_applicable",
    bootstrap: "optional",
    continuousSync: "active",
    identity: "location-scoped payment or return UUID plus client_event_id",
    retry:
      "transactional sync_events outbox; payments append and returns compensate rather than overwrite",
    events: [
      event("order.payment.completed", 1, "compatibility_receive_only"),
      event("order.payment.completed", 2),
      event("order.customer_return.created", 1),
    ],
  }),
  accounting_journals: replicated({
    domain: "accounting_journals",
    authority: "site_authoritative",
    direction: "site_to_cloud",
    conflictPolicy: "append_or_reverse",
    tombstonePolicy: "not_applicable",
    bootstrap: "optional",
    continuousSync: "active",
    identity: "journal entry UUID plus deterministic reversal client_event_id",
    retry:
      "transactional sync_events outbox; reversals never overwrite posted facts",
    events: [event("accounting.manual_journal.reversed", 1)],
  }),
  inventory_movements: replicated({
    domain: "inventory_movements",
    authority: "site_authoritative",
    direction: "site_to_cloud",
    conflictPolicy: "append_only",
    tombstonePolicy: "not_applicable",
    bootstrap: "optional",
    continuousSync: "active",
    identity: "location-scoped operation UUID plus client_event_id",
    retry:
      "transactional sync_events outbox; dependent events defer, terminal failures dead-letter",
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
  customers: cloudOrBootstrapOnly({
    domain: "customers",
    authority: "shared_synchronized",
    direction: "bidirectional",
    conflictPolicy: "field_merge_with_version",
    tombstonePolicy: "tombstone",
    bootstrap: "required",
    continuousSync: "bootstrap_only",
    identity: "stable customer UUID",
    retry:
      "no continuous producer yet; snapshot application is atomic and a later pairing is required",
    events: [],
  }),
  products_menu: cloudOrBootstrapOnly({
    domain: "products_menu",
    authority: "shared_synchronized",
    direction: "bidirectional",
    conflictPolicy: "authoritative_scope",
    tombstonePolicy: "tombstone",
    bootstrap: "required",
    continuousSync: "bootstrap_only",
    identity: "stable catalogue UUIDs and location scope",
    retry:
      "no continuous producer yet; snapshot application is atomic and a later pairing is required",
    events: [],
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
      "no continuous producer yet; snapshot application is atomic and a later pairing is required",
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
  for (const domain of REPLICATION_DOMAIN_CONTRACT.domains) {
    for (const listed of domain.events) {
      if (!available.has(`${listed.type}@${listed.schemaVersion}`)) {
        problems.push(
          `${domain.domain}: unknown event ${listed.type}@${listed.schemaVersion}`,
        );
      }
    }
    if (domain.continuousSync === "active" && domain.events.length === 0) {
      problems.push(`${domain.domain}: active continuous sync has no events`);
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
