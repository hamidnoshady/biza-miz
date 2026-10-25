/**
 * Issue #1115 §C — the replication coverage manifest.
 *
 * Question it answers: *may the product say "fully synced", and if not, which
 * class of data is the reason?* It is the layer between the two ownership
 * contracts that already exist and the progress UI the epic asks for:
 *
 *  - `data-ownership.ts` — per-domain authority, direction, conflict policy,
 *    tombstones, bootstrap and transport (the contract #766 defined);
 *  - `replication-catalogue.ts` — the pairing screen's copy, per catalogue key.
 *
 * It does NOT restate any of that. Each coverage class below only *points* at
 * domains in those two registries (typed, so a rename breaks the compile), adds
 * what neither carries — whether the class is required for a site to be called
 * ready, how a count/hash comparison could prove it, what it depends on and the
 * limits that must be disclosed — and derives the rest. The test pins that
 * every domain in both registries belongs to exactly one class, so a new domain
 * cannot ship outside the manifest.
 *
 * Honesty rules, encoded rather than documented:
 *
 *  - A required class with no verifier (`verifier: "none"`) makes
 *    `fullySyncedBlockers()` non-empty by itself. Today that is true for most
 *    classes: the only comparison that exists is the per-day settled figures
 *    (`sync-health.ts`) and the identity/credential health. The manifest says
 *    so instead of letting an empty queue read as "synced".
 *  - Cloud-only data is declared cloud-only (`localReplica: "cloud_only"`), with
 *    its disclosure, never counted as replicated and never silently dropped.
 *  - `catalogueDiscrepancies()` lists where the pairing catalogue's description
 *    of a domain disagrees with the ownership contract. They are pinned in
 *    `KNOWN_CATALOGUE_DISCREPANCIES`, so a new one fails the build and a fixed
 *    one must be removed.
 *
 * Pure and client-safe: it imports the two (database-free) registries only.
 */
import { DATA_OWNERSHIP_REGISTRY, type DataDomain, type DomainOwnershipDefinition } from "./data-ownership";
import { REPLICATION_DOMAIN_DEFINITIONS, replicationCatalogue } from "./replication-catalogue";

/** Bump when a class is added, removed, re-scoped or its requirement changes. */
export const REPLICATION_COVERAGE_VERSION = 1 as const;

export const COVERAGE_CLASS_IDS = [
  "tenant_branch",
  "identity_iam",
  "settings_entitlements",
  "media_assets",
  "customers_crm",
  "menu_catalogue",
  "stock_inventory",
  "pos_operations",
  "ledger_accounting",
  "installed_apps",
  "device_local",
] as const;
export type CoverageClassId = (typeof COVERAGE_CLASS_IDS)[number];

/**
 * How a class could be *proven* in step, not merely believed to be.
 *  - `identity_health`: memberships / identities / PIN credentials compared
 *    (`readHybridIdentityStatus`).
 *  - `day_digest`: per-business-day settled figures compared both ways
 *    (`sync-health.ts`, `/api/server-sync/digest`).
 *  - `event_acknowledgement`: outbox/inbox empty and every event acknowledged,
 *    with no deferred or dead-lettered effect. Proves delivery, not equality.
 *  - `none`: nothing compares the two sides for this class yet.
 */
export type CoverageVerifier = "identity_health" | "day_digest" | "event_acknowledgement" | "none";

/** What a site actually holds, derived from the ownership contract. */
export type LocalReplicaStatus =
  | "continuous"
  | "bootstrap_only"
  | "cloud_only"
  | "device_local"
  | "mixed";

export interface CoverageClassDefinition {
  id: CoverageClassId;
  /** The epic §C audit class, in its own words. */
  auditClass: string;
  /** Domains of `data-ownership.ts` that belong to this class. */
  domains: readonly DataDomain[];
  /** Keys of `replication-catalogue.ts` that belong to this class. */
  catalogue: readonly string[];
  /**
   * Ownership domain ↔ catalogue key pairs that describe the *same* data in the
   * two registries; the discrepancy check compares exactly these.
   */
  pairs: readonly (readonly [DataDomain, string])[];
  /** Must be verified before a site may be called fully synced. */
  requiredForReady: boolean;
  /** Why it is or is not required, in a sentence a reviewer can disagree with. */
  requirement: string;
  /** Classes that must be applied first (staged apply order). */
  dependsOn: readonly CoverageClassId[];
  /** How the class could be proven in step today. */
  verifier: CoverageVerifier;
  /** What the verifier does and does not prove. */
  verifierNote: string;
  /** Limits that must be disclosed to the owner, never hidden. */
  disclosure: readonly string[];
}

export const COVERAGE_CLASSES: readonly CoverageClassDefinition[] = [
  {
    id: "tenant_branch",
    auditClass: "Tenant / business / branch",
    domains: [],
    catalogue: ["locations"],
    pairs: [],
    requiredForReady: true,
    requirement: "Without the business and branch identity nothing else can be scoped or attributed.",
    dependsOn: [],
    verifier: "none",
    verifierNote: "Applied from the pairing snapshot and the site-profile feed; nothing compares it afterwards.",
    disclosure: [
      "No data-ownership.ts domain exists for business/branch identity; only the pairing catalogue declares it.",
      "All branch identities travel so cross-location references resolve; only the paired branch has operational data.",
    ],
  },
  {
    id: "identity_iam",
    auditClass: "Owner / Team / IAM / roles / permissions / PIN credentials / revocation",
    domains: ["staff_access"],
    catalogue: ["users_permissions"],
    pairs: [["staff_access", "users_permissions"]],
    requiredForReady: true,
    requirement: "Every authorised member must be able to sign in with the same Cloud identity, and revocation must have arrived.",
    dependsOn: ["tenant_branch"],
    verifier: "identity_health",
    verifierNote:
      "The IAM plane (iam/*) converges memberships, identities and PIN credentials and reports expected vs usable counts; it is its own plane and is not an entry in the ownership registry.",
    disclosure: ["Plaintext passwords and tokens are never copied; credential hashes and PIN material only."],
  },
  {
    id: "settings_entitlements",
    auditClass: "Settings / tax / payment methods / entitlements",
    domains: ["plans_billing"],
    catalogue: ["business_settings", "payment_methods", "features_plans"],
    pairs: [["plans_billing", "features_plans"]],
    requiredForReady: true,
    requirement: "Tax, payment ways and feature entitlements decide what the till may do.",
    dependsOn: ["tenant_branch"],
    verifier: "none",
    verifierNote: "Seeded at pairing; ongoing changes are cloud-managed and reach the site through the site-profile fetch, which is not compared.",
    disclosure: ["Ongoing settings edits are not an event stream; the site-profile fetch refreshes branch settings each tick."],
  },
  {
    id: "media_assets",
    auditClass: "Media / assets / templates / attachments",
    domains: ["media_assets"],
    catalogue: ["media"],
    pairs: [["media_assets", "media"]],
    requiredForReady: false,
    requirement: "Binary files transfer on demand; a missing image degrades display but not selling, so it does not gate readiness.",
    dependsOn: ["tenant_branch"],
    verifier: "none",
    verifierNote: "Metadata rides the master feed; file bytes are fetched on demand and are not counted or hashed.",
    disclosure: ["Files are fetched on demand, so an offline site may lack images it has never opened."],
  },
  {
    id: "customers_crm",
    auditClass: "Customers / CRM",
    domains: ["customers"],
    catalogue: ["customers_crm", "loyalty_credit"],
    pairs: [["customers", "customers_crm"]],
    requiredForReady: true,
    requirement: "Sales attach customers; a missing customer blocks or mis-attributes a bill.",
    dependsOn: ["tenant_branch", "identity_iam"],
    verifier: "none",
    verifierNote: "Merged field by field with per-field clocks; no row count or checksum is compared between the sides.",
    disclosure: ["Loyalty balances and store credit are cloud-only; CRM scores, tags and campaigns stay in the Cloud."],
  },
  {
    id: "menu_catalogue",
    auditClass: "Menu / products / categories / modifiers / prices",
    domains: ["products_menu", "retail_catalogue"],
    catalogue: ["catalogue"],
    pairs: [["products_menu", "catalogue"]],
    requiredForReady: true,
    requirement: "The till cannot sell what it does not hold, at a price it does not hold.",
    dependsOn: ["tenant_branch", "media_assets"],
    verifier: "none",
    verifierNote: "Master feed with per-field clocks; no row count or checksum is compared between the sides.",
    disclosure: ["The retail catalogue has no entry in the pairing catalogue at all; only data-ownership.ts declares it."],
  },
  {
    id: "stock_inventory",
    auditClass: "Stock / inventory / purchases / transfers",
    domains: ["inventory_movements"],
    catalogue: ["stock_and_lots", "inventory_catalogue", "suppliers_purchases", "stock_counts_waste_production", "transfers"],
    pairs: [["inventory_movements", "stock_and_lots"]],
    requiredForReady: true,
    requirement: "Stock moves with every sale; it must converge or the branch oversells.",
    dependsOn: ["menu_catalogue"],
    verifier: "event_acknowledgement",
    verifierNote: "Movements travel as events and are acknowledged; balances are derived on each side, so equal balances are not asserted.",
    disclosure: [
      "Balances and lots are never replicated directly.",
      "Cloud-owned inventory, transfer and cost events are acknowledged by a site, not applied (sync-event-registry).",
    ],
  },
  {
    id: "pos_operations",
    auditClass: "POS orders / payments / refunds / shifts / tables",
    domains: ["orders", "payments", "shifts", "floor_sessions_reservations"],
    catalogue: ["orders", "payments", "shifts", "refunds", "tables_reservations"],
    pairs: [
      ["orders", "orders"],
      ["payments", "payments"],
      ["shifts", "shifts"],
      ["floor_sessions_reservations", "tables_reservations"],
    ],
    requiredForReady: true,
    requirement: "These are the sales the branch makes while offline; none may remain unsent.",
    dependsOn: ["tenant_branch", "identity_iam", "customers_crm", "menu_catalogue", "stock_inventory"],
    verifier: "day_digest",
    verifierNote:
      "Settled sales and payments are counted and summed per business day on both sides and compared (drift). Open orders, shifts and floor state are proven by event acknowledgement only.",
    disclosure: ["Historical orders are not a bootstrap copy; only new operational events sync."],
  },
  {
    id: "ledger_accounting",
    auditClass: "Ledger / chart / accounts / fiscal periods / financial documents",
    domains: ["accounting_journals", "accounting_dimension_master", "commission_settlement", "shareholder_accounting"],
    catalogue: ["journals", "accounting_dimensions", "commission_settlement", "shareholder_accounting"],
    pairs: [
      ["accounting_journals", "journals"],
      ["accounting_dimension_master", "accounting_dimensions"],
      ["commission_settlement", "commission_settlement"],
      ["shareholder_accounting", "shareholder_accounting"],
    ],
    requiredForReady: true,
    requirement: "The Cloud is the system of record; the site must have the chart and have delivered its ledger effects.",
    dependsOn: ["tenant_branch", "settings_entitlements", "pos_operations"],
    verifier: "event_acknowledgement",
    verifierNote: "Ledger effects are cloud-posted; the site's one ledger event (a manual-entry reversal) is acknowledged. No journal totals are compared.",
    disclosure: [
      "Journal entries, fiscal periods, bank reconciliation, payroll, tax filings and accounting documents are cloud-authoritative and not mirrored locally.",
    ],
  },
  {
    id: "installed_apps",
    auditClass: "Other installed / industry-specific apps",
    domains: ["aec_field_capture", "aec_commercial_registers", "automotive_vehicle_board"],
    catalogue: ["aec_field_capture", "aec_commercial_registers", "automotive_vehicle_stock", "automotive_vehicle_board", "integrations"],
    pairs: [
      ["aec_field_capture", "aec_field_capture"],
      ["aec_commercial_registers", "aec_commercial_registers"],
      ["automotive_vehicle_board", "automotive_vehicle_board"],
    ],
    requiredForReady: false,
    requirement:
      "These are Cloud-only by contract (the desktop shows the Cloud pane for them), except the read-only automotive board; disclosed instead of gating the till.",
    dependsOn: ["tenant_branch", "menu_catalogue"],
    verifier: "event_acknowledgement",
    verifierNote: "Only the automotive board has a transport (a snapshot plus two request events); everything else is Cloud-only.",
    disclosure: [
      "AEC registers and automotive vehicle records are Cloud-only and online-dependent.",
      "Website, WooCommerce, WordPress, Holoo, API and MCP state is Cloud-only.",
    ],
  },
  {
    id: "device_local",
    auditClass: "Device-local configuration",
    domains: ["printer_settings", "backup_paths", "lan_gateway", "certificate_paths", "database_paths", "cloud_exception_transport"],
    catalogue: ["machine_state"],
    pairs: [],
    requiredForReady: false,
    requirement: "Machine configuration is never replicated, by design.",
    dependsOn: [],
    verifier: "none",
    verifierNote: "Not applicable: nothing here is replicated.",
    disclosure: ["Printers, backup destinations, certificates and the LAN gateway are configured per machine."],
  },
];

const CLASS_BY_ID = new Map(COVERAGE_CLASSES.map((entry) => [entry.id, entry]));

export function coverageClass(id: CoverageClassId): CoverageClassDefinition {
  const entry = CLASS_BY_ID.get(id);
  if (!entry) throw new Error(`unknown coverage class ${id}`);
  return entry;
}

/** Classes in an order that applies every class after the ones it depends on. */
export function coverageApplyOrder(): CoverageClassId[] {
  const done = new Set<CoverageClassId>();
  const order: CoverageClassId[] = [];
  const visiting = new Set<CoverageClassId>();
  const visit = (id: CoverageClassId) => {
    if (done.has(id)) return;
    if (visiting.has(id)) throw new Error(`coverage dependency cycle at ${id}`);
    visiting.add(id);
    for (const dependency of coverageClass(id).dependsOn) visit(dependency);
    visiting.delete(id);
    done.add(id);
    order.push(id);
  };
  for (const entry of COVERAGE_CLASSES) visit(entry.id);
  return order;
}

function domainDefinition(domain: DataDomain): DomainOwnershipDefinition {
  return DATA_OWNERSHIP_REGISTRY[domain];
}

/** What a site holds for a class, derived from its domains and never declared a second time. */
export function localReplicaStatus(entry: CoverageClassDefinition): LocalReplicaStatus {
  if (entry.domains.length === 0) return entry.catalogue.length > 0 ? "bootstrap_only" : "cloud_only";
  const states = new Set<Exclude<LocalReplicaStatus, "mixed">>();
  for (const domain of entry.domains) {
    const definition = domainDefinition(domain);
    if (definition.authority === "device_local") states.add("device_local");
    else if (definition.continuousSync === "active") states.add("continuous");
    else if (definition.continuousSync === "bootstrap_only") states.add("bootstrap_only");
    else states.add("cloud_only");
  }
  return states.size === 1 ? [...states][0] : "mixed";
}

/** Tombstone policies the class's domains declare, deduplicated. */
export function coverageTombstones(entry: CoverageClassDefinition): string[] {
  return [...new Set(entry.domains.map((domain) => domainDefinition(domain).tombstonePolicy))].sort();
}

/** Transports the class's domains use, deduplicated. */
export function coverageTransports(entry: CoverageClassDefinition): string[] {
  return [...new Set(entry.domains.map((domain) => domainDefinition(domain).transport))].sort();
}

/** How file bytes move for the class's catalogue keys. */
export function coverageBinaryTransport(entry: CoverageClassDefinition): string[] {
  const keys = new Set(entry.catalogue);
  return [
    ...new Set(
      REPLICATION_DOMAIN_DEFINITIONS.filter((domain) => keys.has(domain.key)).map((domain) => domain.mediaTransfer),
    ),
  ].sort();
}

// ---- Registry cross-checks --------------------------------------------------

/** A domain of either registry that no coverage class claims, or that two claim. */
export function unclassifiedDomains(): string[] {
  const problems: string[] = [];
  const ownership = new Map<string, number>();
  const catalogue = new Map<string, number>();
  for (const entry of COVERAGE_CLASSES) {
    for (const domain of entry.domains) ownership.set(domain, (ownership.get(domain) ?? 0) + 1);
    for (const key of entry.catalogue) catalogue.set(key, (catalogue.get(key) ?? 0) + 1);
  }
  for (const domain of Object.keys(DATA_OWNERSHIP_REGISTRY)) {
    const count = ownership.get(domain) ?? 0;
    if (count !== 1) problems.push(`data-ownership domain "${domain}" is in ${count} coverage classes`);
  }
  for (const definition of REPLICATION_DOMAIN_DEFINITIONS) {
    const count = catalogue.get(definition.key) ?? 0;
    if (count !== 1) problems.push(`replication-catalogue key "${definition.key}" is in ${count} coverage classes`);
  }
  for (const domain of ownership.keys()) {
    if (!(domain in DATA_OWNERSHIP_REGISTRY)) problems.push(`coverage names unknown data-ownership domain "${domain}"`);
  }
  const knownKeys = new Set(REPLICATION_DOMAIN_DEFINITIONS.map((definition) => definition.key));
  for (const key of catalogue.keys()) {
    if (!knownKeys.has(key)) problems.push(`coverage names unknown catalogue key "${key}"`);
  }
  for (const entry of COVERAGE_CLASSES) {
    for (const [domain, key] of entry.pairs) {
      if (!entry.domains.includes(domain) || !entry.catalogue.includes(key)) {
        problems.push(`${entry.id}: pair ${domain}↔${key} is not inside the class`);
      }
    }
  }
  return problems;
}

export interface CatalogueDiscrepancy {
  domain: DataDomain;
  catalogueKey: string;
  /** What `data-ownership.ts` declares. */
  ownershipSays: "continuous" | "not_continuous";
  /** What the pairing catalogue's authority and events imply. */
  catalogueImplies: "continuous" | "not_continuous";
}

/**
 * Where the pairing catalogue describes a domain as less (or more) replicated
 * than the ownership contract. `pairingDataClassification()` is a projection of
 * the catalogue, so a disagreement here is a statement the pairing screen makes
 * that the contract does not support.
 */
export function catalogueDiscrepancies(): CatalogueDiscrepancy[] {
  const catalogue = new Map(replicationCatalogue().map((domain) => [domain.key, domain]));
  const found: CatalogueDiscrepancy[] = [];
  for (const entry of COVERAGE_CLASSES) {
    for (const [domain, key] of entry.pairs) {
      const described = catalogue.get(key);
      if (!described) continue;
      const catalogueContinuous =
        described.eventTypes.length > 0 ||
        described.authority === "bidirectional" ||
        described.authority === "site_authoritative";
      const ownershipContinuous = domainDefinition(domain).continuousSync === "active";
      if (catalogueContinuous !== ownershipContinuous) {
        found.push({
          domain,
          catalogueKey: key,
          ownershipSays: ownershipContinuous ? "continuous" : "not_continuous",
          catalogueImplies: catalogueContinuous ? "continuous" : "not_continuous",
        });
      }
    }
  }
  return found;
}

/**
 * The disagreements that exist today: all four are master-feed domains
 * (migration 0190) whose catalogue entry still reads as bootstrap-only or
 * cloud-only. Pinned so that fixing one means deleting its line and adding a
 * new one fails the build.
 */
export const KNOWN_CATALOGUE_DISCREPANCIES: readonly string[] = [
  "accounting_dimension_master↔accounting_dimensions",
  "customers↔customers_crm",
  "media_assets↔media",
  "products_menu↔catalogue",
];

// ---- The "fully synced" gate ------------------------------------------------

/**
 * Facts a sync job has measured, not assumed. A class is `verified` only when
 * its verifier ran against the Cloud and agreed; absence is not agreement.
 */
export interface CoverageEvidence {
  verified: Partial<Record<CoverageClassId, boolean>>;
  identityBlocked: boolean;
  /** Members the Cloud lists who cannot yet sign in here. */
  credentialsMissing: number;
  pendingOutbox: number;
  deferredEvents: number;
  deadLetters: number;
  masterConflicts: number;
  /** A count/hash/cursor comparison disagreed. */
  checksumMismatch: boolean;
  /** The Cloud has not acknowledged the target revisions the site reports. */
  cloudAcknowledged: boolean;
}

/**
 * Why a site may NOT yet be shown as fully synced. Empty means eligible.
 * Codes are stable so UI copy and tests can key on them.
 */
export function fullySyncedBlockers(evidence: CoverageEvidence): string[] {
  const blockers: string[] = [];
  for (const entry of COVERAGE_CLASSES) {
    if (!entry.requiredForReady) continue;
    if (entry.verifier === "none") blockers.push(`class_unverifiable:${entry.id}`);
    else if (evidence.verified[entry.id] !== true) blockers.push(`class_unverified:${entry.id}`);
  }
  if (evidence.identityBlocked) blockers.push("identity_blocked");
  if (evidence.credentialsMissing > 0) blockers.push("credentials_missing");
  if (evidence.pendingOutbox > 0) blockers.push("pending_outbox");
  if (evidence.deferredEvents > 0) blockers.push("deferred_events");
  if (evidence.deadLetters > 0) blockers.push("dead_letters");
  if (evidence.masterConflicts > 0) blockers.push("master_conflicts");
  if (evidence.checksumMismatch) blockers.push("checksum_mismatch");
  if (!evidence.cloudAcknowledged) blockers.push("cloud_not_acknowledged");
  return blockers;
}

/** Required classes that cannot be proven at all today. */
export function unverifiableRequiredClasses(): CoverageClassId[] {
  return COVERAGE_CLASSES.filter((entry) => entry.requiredForReady && entry.verifier === "none").map((entry) => entry.id);
}

// ---- Rendered document ------------------------------------------------------

function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** `docs/architecture/replication-coverage.md` is this output verbatim. */
export function renderReplicationCoverageMarkdown(): string {
  const lines: string[] = [];
  lines.push("<!-- Generated by `npx tsx scripts/render-replication-coverage.ts` from src/lib/replication-coverage.ts. Do not edit by hand. -->");
  lines.push("");
  lines.push("# Replication coverage manifest");
  lines.push("");
  lines.push(
    `Issue #1115 §C, version ${REPLICATION_COVERAGE_VERSION}. A layer over \`data-ownership.ts\` (per-domain authority, direction, conflict, tombstones, transport) and \`replication-catalogue.ts\` (pairing copy): it adds which classes are required before a site may be called fully synced, how each could be proven, what depends on what, and what must be disclosed. It restates none of the ownership facts; the columns below marked *derived* are read from the registries.`,
  );
  lines.push("");
  lines.push("**Today a site cannot honestly be shown as fully synced.** The classes below that are required but have no verifier make `fullySyncedBlockers()` non-empty on their own:");
  lines.push("");
  for (const id of unverifiableRequiredClasses()) lines.push(`- \`${id}\` — ${coverageClass(id).verifierNote}`);
  lines.push("");
  lines.push("## Staged apply order");
  lines.push("");
  lines.push(coverageApplyOrder().map((id) => `\`${id}\``).join(" → "));
  lines.push("");
  lines.push("## Classes");
  lines.push("");
  lines.push("| Class | Audit class (epic §C) | Required | Local replica *(derived)* | Transport *(derived)* | Tombstones *(derived)* | Files *(derived)* | Verifier | Depends on |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const entry of COVERAGE_CLASSES) {
    lines.push(
      `| \`${entry.id}\` | ${cell(entry.auditClass)} | ${entry.requiredForReady ? "yes" : "no"} | ${localReplicaStatus(entry)} | ${coverageTransports(entry).join(", ") || "—"} | ${coverageTombstones(entry).join(", ") || "—"} | ${coverageBinaryTransport(entry).join(", ") || "—"} | ${entry.verifier} | ${entry.dependsOn.map((id) => `\`${id}\``).join(", ") || "—"} |`,
    );
  }
  lines.push("");
  lines.push("## Members, requirement and disclosure");
  lines.push("");
  for (const entry of COVERAGE_CLASSES) {
    lines.push(`### \`${entry.id}\``);
    lines.push("");
    lines.push(`- **Ownership domains:** ${entry.domains.map((domain) => `\`${domain}\``).join(", ") || "none"}`);
    lines.push(`- **Catalogue keys:** ${entry.catalogue.map((key) => `\`${key}\``).join(", ") || "none"}`);
    lines.push(`- **Requirement:** ${entry.requirement}`);
    lines.push(`- **Verifier:** \`${entry.verifier}\` — ${entry.verifierNote}`);
    for (const note of entry.disclosure) lines.push(`- **Disclose:** ${note}`);
    lines.push("");
  }
  lines.push("## Known disagreements with the pairing catalogue");
  lines.push("");
  lines.push(
    "`pairingDataClassification()` projects the catalogue, so these domains are described on the pairing screen as less replicated than `data-ownership.ts` declares them (all four are master-feed domains from migration 0190). Recorded, not changed here.",
  );
  lines.push("");
  for (const found of catalogueDiscrepancies()) {
    lines.push(`- \`${found.domain}\` ↔ \`${found.catalogueKey}\`: ownership says ${found.ownershipSays.replace("_", " ")}, the catalogue implies ${found.catalogueImplies.replace("_", " ")}.`);
  }
  lines.push("");
  lines.push("## Not in the manifest (runtime, per site)");
  lines.push("");
  lines.push(
    "Record counts, checksums, high-water marks and the last verified cursor are measured values, not declarations. They belong to the durable `initial_sync_job` (a separate workstream) and arrive here as `CoverageEvidence`.",
  );
  lines.push("");
  return lines.join("\n");
}
