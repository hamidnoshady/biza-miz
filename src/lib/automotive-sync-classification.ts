/**
 * Issue #839 §22 — the automotive trade's deployment-mode classification.
 *
 * §22 asks for the same audit #799 §26 asked of the AEC registers: every new
 * entity classified for cloud/hybrid/desktop/local, and — *only* if it
 * replicates — the replication catalogue, the sync registry, the pairing
 * snapshot, the drift checks and the conflict rules updated with it. This
 * module is that audit, written where the platform's own replication contract
 * can see it instead of in a document nobody checks.
 *
 * ## The decision it records
 *
 * **No authoritative vehicle record replicates, and that is a decision, not an
 * omission.** The rule is already in the product for serialized stock, and a
 * car is the archetype of a serial: `master-sync-registry.test.ts` asserts
 * `item_serials` is not master-synced, and 0212's uniqueness is *per business*
 * (`uq_automotive_vehicle_vin` and friends). A second writer holding the same
 * VINs would have to reproduce those partial unique indexes on its own copy,
 * and a field-by-field merge of two such copies is exactly how one car ends up
 * in two places at two prices — or sold twice.
 *
 * So the split is:
 *
 *   * **The catalogue travels.** A dealership's `items` rows (make/model/trim)
 *     are generic retail catalogue rows and already ride `retail_catalogue`'s
 *     master feed, so a paired till knows a «پژو ۲۰۷» exists. That is a
 *     *catalogue* fact, not a car.
 *   * **The cars do not.** The vehicle record, its cost ledger, its price
 *     history, its transfers and the leads attached to it stay cloud-owned with
 *     one authority over every state transition, exactly as `item_serials`,
 *     `serial_reservations` and the retail sale path already are.
 *   * **Two derived tables do travel, and neither is a car.** §19's Wave 6
 *     added a *read-only mirror* (`automotive_vehicle_stock_mirror`) and a
 *     *durable request queue* (`automotive_vehicle_offline_requests`). The
 *     mirror is the cloud's own answer, replaced whole from a snapshot that
 *     carries no acquisition cost, no capitalized cost and no minimum price —
 *     a paired desktop reads the board and cannot leak a margin from it. The
 *     queue holds *intents*: hold this car, release a hold this branch placed.
 *     Each carries an idempotency key and the version the operator saw, and the
 *     cloud re-validates the car inside its own transaction before calling the
 *     canonical reservation service. Neither table is written by any other
 *     path, neither carries the master-data capture trigger, and a sale is
 *     still not offline-finalizable at all.
 *
 * ## Why the buckets are not the same protocol
 *
 * Two of these tables *look* like catalogue rows and are not:
 *
 *   * `automotive_vehicle_attributes` is keyed by `serial_id` — one row per
 *     physical unit — so it inherits the unit's single-writer rule.
 *   * `automotive_vehicle_price_history` is an append-only journal of what the
 *     asking price *was*. Merging it field by field would rewrite history, and
 *     the whole reason it exists is that history must not be rewritten.
 *   * `automotive_vehicle_sales` preserves each sale/reversal occurrence, and
 *     `automotive_vehicle_media` links a specific unit to a shared Media Library
 *     asset. Neither is a generic catalogue row.
 *
 * Each entry below therefore carries the write model that put it in its bucket
 * and what a future protocol would have to add first. Changing a classification
 * is a code change with a reason, never a table name appended to
 * `MASTER_SYNC_TABLES`.
 *
 * ## The guard
 *
 * `automotiveSyncClassificationProblems(tables)` is the CI half: given the
 * schema's real table list it reports any automotive table no entry claims
 * (`uncovered`) and any table an entry claims that the schema does not have
 * (`unknown`). `integration/automotive-sync-classification.integration.test.ts`
 * runs it against PostgreSQL and asserts none of these tables carries the
 * master-data capture trigger, so a later wave cannot quietly make a VIN
 * last-write-wins by adding one line to the sync registry.
 */

/** How each automotive record is classified for a paired desktop. */
export type AutomotiveSyncClass =
  | "cloud_only"
  | "cloud_catalogue"
  /** A read-only projection of cloud data: the cloud's row or nothing, never a merge. */
  | "cloud_mirror"
  /** An outbound queue of intents that only the cloud can decide. */
  | "site_request_queue";

export const AUTOMOTIVE_SYNC_CLASS_LABELS: Record<AutomotiveSyncClass, string> = {
  cloud_only: "ابری — موجودی و اسناد خودرو یک نویسنده دارد",
  cloud_catalogue: "کاتالوگ مشترک — برند و مدل، نه خودروی فیزیکی",
  cloud_mirror: "آینهٔ خواندنی — همان چیزی که سرور مرکزی می‌گوید، بدون هزینه و بدون تصمیم",
  site_request_queue: "صف درخواست محلی — تا تأیید سرور مرکزی رزرو نیست",
};

export interface AutomotiveSyncEntry {
  key: string;
  label: string;
  class: AutomotiveSyncClass;
  /** The screen or service a person would find this on. */
  surface: string;
  /** The write model that decides the bucket. */
  writeModel:
    | "unit_state_machine"
    | "append_only_journal"
    | "void_not_edit"
    | "lead_extension"
    | "vehicle_attachment"
    | "catalogue_row"
    /** Replaced whole by a cloud snapshot; never merged field by field. */
    | "replaced_snapshot"
    /** Append-an-intent; the cloud decides and the answer is final. */
    | "request_queue";
  tables: readonly string[];
  reason: string;
  conflictRule: string;
  /**
   * What any future protocol must add before this record may travel at all.
   * Non-empty even for a candidate: "cloud-only" is a decision with a stated
   * cost, not a licence to skip the work.
   */
  requirement: string;
}

export const AUTOMOTIVE_SYNC_CLASSIFICATION: readonly AutomotiveSyncEntry[] = [
  {
    key: "vehicle_units",
    label: "خودروها (یک ردیف به‌ازای هر دستگاه)",
    class: "cloud_only",
    surface: "مدیر خودرو / انبار خودرو",
    writeModel: "unit_state_machine",
    tables: ["automotive_vehicle_attributes"],
    reason:
      "The 1:1 extension of one `item_serials` row: VIN, chassis, engine number, plate, stock number, new/used, lifecycle state, frozen sale facts and the sold-once pointer. 0212's uniqueness is per business, and the lifecycle is a state machine whose terminal transition moves money — the two properties a second writer cannot hold.",
    conflictRule:
      "single authority: the cloud decides every transition; a duplicate VIN is refused by a partial unique index, never merged",
    requirement:
      "an explicit event protocol carrying the unit id and its expected state, with a VIN/chassis uniqueness check on the receiving side before apply, plus a documented answer for what a site does when it cannot reach the cloud",
  },
  {
    key: "vehicle_costs",
    label: "هزینه‌های خودرو (خرید و سرمایه‌ای‌شده)",
    class: "cloud_only",
    surface: "مدیر خودرو / هزینه‌های خودرو",
    writeModel: "void_not_edit",
    tables: ["automotive_vehicle_costs"],
    reason:
      "Every row posts to the ledger (inventory 1370, freight/customs 1375, reconditioning 5195) or is voided by a reversal entry, so it is an accounting document as much as an expense. A merged row would be a document with two different values, and the effective cost it feeds is frozen into a sale.",
    conflictRule:
      "append and void only (a voided row is complete, never edited); the ledger entry is the authority",
    requirement:
      "the same accounting-document protocol `inventory_movements` uses — an idempotent operation id, a posting entry id both sides agree on, and a reversal that references the original",
  },
  {
    key: "vehicle_price_history",
    label: "تاریخچهٔ قیمت خودرو",
    class: "cloud_only",
    surface: "مدیر خودرو / تغییر قیمت",
    writeModel: "append_only_journal",
    tables: ["automotive_vehicle_price_history"],
    reason:
      "An append-only record of what the asking price was and when it changed, kept precisely so history is never rewritten. Field-by-field merge has no meaning for it: two writers would interleave the same change twice or lose an interval.",
    conflictRule: "append-only; the later change never overwrites the earlier one",
    requirement:
      "an ordering guarantee (a sequence the cloud assigns) before any row of it may leave the cloud, since a log without one cannot be merged",
  },
  {
    key: "vehicle_transfers",
    label: "انتقال خودرو بین شعب",
    class: "cloud_only",
    surface: "مدیر خودرو / انتقال",
    writeModel: "unit_state_machine",
    tables: ["automotive_vehicle_transfers"],
    reason:
      "A transfer's completion is what moves the unit between branches, and 0212 allows exactly one open transfer per vehicle (`uq_automotive_vehicle_transfer_open`). Two writers would each hold a legal-looking open transfer for the same car.",
    conflictRule:
      "single authority with an idempotent completion; the open-transfer uniqueness index is the guard and it lives on the cloud",
    requirement:
      "the `inventory.transfer.*` event shape generalized to a serialized unit (requested/shipped/completed/cancelled), with the receiving branch naming the same unit id",
  },
  {
    key: "lead_vehicle_preferences",
    label: "خودروی مورد نظر سرنخ‌ها",
    class: "cloud_only",
    surface: "مدیر خودرو / مشتریان و سرنخ‌ها",
    writeModel: "lead_extension",
    tables: ["crm_lead_vehicle_preferences"],
    reason:
      "One row per lead (migration 0213), an extension of the CRM lead. The lead itself is cloud-only in the replication catalogue's `customers_crm` domain, so its extension cannot be the piece that travels.",
    conflictRule:
      "cloud authority; the lead's own row decides, and this row travels only with it",
    requirement:
      "nothing less than moving `customers_crm` first: a preference row merged without its lead would attach a budget to a person the receiving side does not hold",
  },
  {
    key: "lead_vehicle_links",
    label: "خودروهای معرفی‌شده به سرنخ",
    class: "cloud_only",
    surface: "مدیر خودرو / سرنخ → خودرو",
    writeModel: "lead_extension",
    tables: ["crm_lead_vehicle_links"],
    reason:
      "A link names a specific serialized unit, so it depends on a table that itself never travels: the pair (lead, vehicle) is only meaningful where both rows exist.",
    conflictRule:
      "cloud authority; one row per (lead, unit) pair, never merged onto a unit the receiving side does not hold",
    requirement:
      "the same protocol as `lead_vehicle_preferences`, plus the unit: a link may only be applied where the referenced `item_serials` row resolves, or it defers",
  },
  {
    key: "vehicle_sales",
    label: "سوابق فروش و برگشت خودرو",
    class: "cloud_only",
    surface: "فروش خودرو / مرجوعی و فروش مجدد",
    writeModel: "void_not_edit",
    tables: ["automotive_vehicle_sales"],
    reason:
      "One durable occurrence per sale, carrying the frozen price, effective cost, VAT and posting ids; a return marks that occurrence reversed and records its mirror entries without rewriting the original sale. The ordinary retail invoice and ledger remain the canonical financial documents.",
    conflictRule:
      "the cloud serializes the active sale per unit; reversals name the original occurrence and ledger entries, and a later resale creates a new occurrence",
    requirement:
      "an idempotent sale occurrence id plus the same order, exact unit, expected-state and posting/reversal dependencies on both sides before the history may travel",
  },
  {
    key: "vehicle_media_links",
    label: "پیوست‌های رسانه‌ای خودرو",
    class: "cloud_only",
    surface: "پروندهٔ خودرو / رسانه",
    writeModel: "vehicle_attachment",
    tables: ["automotive_vehicle_media"],
    reason:
      "This is only the tenant-safe link from one serialized vehicle to a canonical Media Library asset; the bytes and quotas remain owned by `media_assets`. A link to an absent vehicle or a different tenant's asset has no safe local meaning.",
    conflictRule:
      "cloud-owned link identity; one link per vehicle/asset pair, with bytes served only by the shared Media Library",
    requirement:
      "a vehicle-id and asset-id dependency protocol that transfers or resolves both rows before applying an attachment, with delete/unlink replay made idempotent",
  },
  {
    key: "vehicle_catalogue",
    label: "کاتالوگ برند و مدل خودرو",
    class: "cloud_catalogue",
    surface: "خودروها (ساخت خودرو / Acquire)",
    writeModel: "catalogue_row",
    tables: [],
    reason:
      "The make/model/trim half of a dealership is generic `items` rows, so a paired till learns the catalogue through `retail_catalogue`'s existing master feed. It is listed here because \"the catalogue syncs and the cars do not\" is the split a reader of this file needs, and because it is the reason `items` deliberately has no automotive-specific column (0212 put the vehicle fields on the serial-keyed table instead).",
    conflictRule:
      "the existing `retail_catalogue` rule: per-field hybrid-logical-clock merge, which is safe precisely because a catalogue row is not a physical car",
    requirement:
      "none — this is the shipped path; the table list is empty because the catalogue is not an automotive-owned table, and the guard proves it is not claimed twice",
  },
  {
    key: "vehicle_board_mirror",
    label: "آینهٔ خواندنی موجودی خودرو در شعبه",
    class: "cloud_mirror",
    surface: "خودروها / موجودی همگام‌شده (نسخهٔ دسکتاپ)",
    writeModel: "replaced_snapshot",
    tables: ["automotive_vehicle_stock_mirror"],
    reason:
      "The branch's board as a paired desktop may hold it: one row per car, replaced whole from the cloud's snapshot on every sync tick, and carrying no acquisition cost, no capitalized cost and no minimum price. The payload is validated before it is written (duplicate VIN/chassis/stock number is refused whole) and the table itself repeats those partial unique indexes, so a bad snapshot cannot create the ambiguous stock §19 forbids.",
    conflictRule:
      "the cloud's snapshot is the only writer and the whole row is replaced — there is no per-field merge and no clock comparison anywhere on this path",
    requirement:
      "already satisfied: the snapshot is a whole-branch projection over the site credential (`GET /api/server-sync/automotive-stock`), the applier is idempotent by content hash, and the table is never written by any other code path",
  },
  {
    key: "vehicle_offline_requests",
    label: "درخواست‌های آفلاین خودرو (رزرو و آزادسازی)",
    class: "site_request_queue",
    surface: "خودروها / رزرو در حالت آفلاین",
    writeModel: "request_queue",
    tables: ["automotive_vehicle_offline_requests"],
    reason:
      "The durable queue of the only two operations a disconnected branch may take: hold a car for a customer, and release a hold this branch placed. Each row is an intent with an idempotency key (the row id, which is also the sync event's client_event_id), the vehicle version the operator was looking at and the state they saw. Nothing about it is financial until the cloud confirms it: a pending row is never shown as a hold and a deposit on it is not a liability.",
    conflictRule:
      "the cloud re-validates the car's live state inside one transaction (row lock plus the one-active-hold-per-serial index) and answers `confirmed` or `conflict` with a named code; the site adopts that answer monotonically and never overwrites it",
    requirement:
      "already satisfied: `automotive.vehicle.reservation.requested` and `.released` carry the request site-to-cloud, `applyVehicleOfflineRequest` calls the canonical `reserveVehicle`/`releaseVehicleReservation` behind a savepoint, and `offlineSaleFinalization` is `false` by type — a sale, a purchase and their postings are never invented offline",
  },
];

export function automotiveClassifiedTables(): string[] {
  return AUTOMOTIVE_SYNC_CLASSIFICATION.flatMap((entry) => [...entry.tables]);
}

/** The tables that must never be captured by the master-data trigger. */
export function automotiveCloudOnlyTables(): string[] {
  return AUTOMOTIVE_SYNC_CLASSIFICATION.filter((entry) => entry.class === "cloud_only").flatMap((entry) => [
    ...entry.tables,
  ]);
}

/**
 * The two tables §19's Wave 6 added — the ones a paired desktop *does* hold.
 * Exported so the guard, the pairing test and the docs agree on the exception
 * instead of each keeping its own list.
 */
export function automotiveSiteLocalTables(): string[] {
  return AUTOMOTIVE_SYNC_CLASSIFICATION.filter(
    (entry) => entry.class === "cloud_mirror" || entry.class === "site_request_queue",
  ).flatMap((entry) => [...entry.tables]);
}

/**
 * The CI guard. `tables` is the schema's real automotive table list — from
 * `pg_class`, so every new automotive table fails here until somebody
 * classifies it and states what it would need to travel.
 */
export function automotiveSyncClassificationProblems(tables: readonly string[]): {
  uncovered: string[];
  unknown: string[];
} {
  const claimed = new Set(automotiveClassifiedTables());
  const actual = new Set(tables);
  return {
    uncovered: [...actual].filter((table) => !claimed.has(table)).sort(),
    unknown: [...claimed].filter((table) => !actual.has(table)).sort(),
  };
}

/** Table names this audit recognizes as automotive-specific, for the DB half. */
export const AUTOMOTIVE_TABLE_PREFIX = "automotive_vehicle_";

/**
 * Which of the schema's tables are automotive-specific: the trade's own
 * `automotive_vehicle_*` tables plus the two CRM lead extensions 0213 added.
 * Kept as one predicate so the integration guard and any future reader agree
 * on what "an automotive table" means.
 */
export function isAutomotiveTable(table: string): boolean {
  return (
    table.startsWith(AUTOMOTIVE_TABLE_PREFIX) ||
    table === "crm_lead_vehicle_preferences" ||
    table === "crm_lead_vehicle_links"
  );
}
