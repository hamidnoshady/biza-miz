/**
 * Every reference to a party's identity, and what a merge must do with it.
 *
 * ## Why this file exists
 *
 * A merge used to be a hand-written list of `UPDATE` statements inside
 * `mergeCustomers()`. Every time the platform grew a new customer-linked table
 * — a WooCommerce customer mapping, a gold account, a layaway plan, a message
 * recipient — that list silently fell one table behind, and nothing failed.
 * The symptom was ugly and quiet: a Woo store kept its mapping pointed at the
 * *archived* record, so the next webhook resolved an online order onto a
 * customer who no longer exists, and the sale disappeared from the surviving
 * file.
 *
 * A hardcoded list cannot be audited. A **declared** one can: this registry is
 * compared against PostgreSQL's own foreign-key metadata by
 * `integration/party-merge-coverage.integration.test.ts`, so a new table with a
 * column pointing at `parties` fails the suite until somebody states what a
 * merge should do with it. Adding the table is how you find out you owe the
 * decision.
 *
 * ## The three dispositions
 *
 * - **`move`** — operational data that belongs to the person. After a merge it
 *   must resolve to the winner, because a live system reading it would
 *   otherwise reach an archived record. Orders, receipts, loyalty, deals,
 *   cases, external store mappings.
 * - **`historical`** — a row whose *whole meaning* is "this is what the losing
 *   record was". Moving it would destroy the audit trail the merge exists to
 *   leave behind. `crm_merges.loser_id` is the canonical example: repointing it
 *   at the winner would turn "A was merged into B" into "B was merged into B".
 * - **`blocked`** — a reference nobody has classified. Merge refuses rather
 *   than guessing. This is the fail-closed default and the reason the registry
 *   is worth having: an unknown reference stops a destructive, irreversible
 *   operation instead of being quietly left behind.
 *
 * ## Tenancy
 *
 * Some tables carry `business_id`; some are branch-scoped and reach the tenant
 * through `locations`; some reach it through a parent row (a workspace task
 * through its project). All three shapes are declared here (`scope`) so the
 * generated UPDATE can never move a row across tenants even if an id leaked
 * into a request. A table that fits none of them is `blocked` by construction,
 * which is the correct answer.
 *
 * Framework-free and side-effect-free: no `pg` import, no SQL execution. It is
 * a policy document the service reads, which is what makes it unit-testable.
 */

/** What a merge does with one reference to the losing party. */
export type MergeDisposition = "move" | "historical" | "blocked";

/** How a table reaches its tenant, which decides the shape of the UPDATE. */
export type MergeScope =
  /** The table has its own `business_id`. */
  | "business"
  /** The table is branch-scoped: join `locations` on `location_id`. */
  | "location"
  /**
   * The table has neither column and reaches the tenant through a parent row
   * that does — declare the hop in `parent`.
   *
   * `ai_project_tasks` is why this exists. A task is tenanted by the project
   * that contains it and deliberately carries no `business_id` of its own (one
   * owner of the tenancy fact, checked by the same RLS policy that guards the
   * project). Before this shape existed, the merge generated an UPDATE naming
   * a `business_id` column the table has not got: PostgreSQL answered 42703,
   * which aborted the surrounding transaction and took the whole merge with
   * it. Modelling the hop is the fix; widening the table would have been a
   * duplicate tenancy column.
   */
  | "parent";

/** The hop a `parent`-scoped table takes to reach `business_id`. */
export interface MergeParentScope {
  /** The parent table, which must itself carry `business_id`. */
  table: string;
  /** The child column holding the parent's id. */
  childColumn: string;
  /** The parent's key column. Practically always `id`. */
  parentColumn: string;
}

export interface PartyReference {
  /** The referencing table. */
  table: string;
  /** The column holding the party id. */
  column: string;
  scope: MergeScope;
  /** Required when `scope` is `"parent"`, meaningless otherwise. */
  parent?: MergeParentScope;
  disposition: MergeDisposition;
  /**
   * Why this disposition, in one line. Required — a classification without a
   * reason is the thing that rots.
   */
  reason: string;
  /**
   * Count this reference in the merge preview («چه چیزی به کجا می‌رود»)?
   * Operational data the owner should see before confirming; noisy internals
   * and audit rows are moved (or kept) without being itemised.
   */
  preview?: boolean;
  /** A short Persian label for the preview, when `preview` is set. */
  previewLabel?: string;
  /**
   * True when the column holds a party id but carries **no database foreign
   * key** to `parties`.
   *
   * `integration_mappings.local_id` is the reason this flag exists, and it is
   * the reason the original bug was invisible: the column is a bare `uuid`
   * that happens to hold a party id for `entity_type = 'customer'` rows, so
   * neither PostgreSQL's FK metadata nor any coverage test built on it could
   * see the reference at all. Declaring it here puts it back under the same
   * discipline as every real FK — it is moved by the same pass, and the
   * coverage test asserts the declaration still matches reality.
   */
  noForeignKey?: boolean;
  /**
   * An extra predicate ANDed into the UPDATE/COUNT/DELETE. Only ever a
   * constant written in this file — never anything derived from a request.
   *
   * Write `{t}` where the table alias belongs; the service substitutes the
   * alias it is using in that statement. Spelling a bare column name instead
   * would break the moment a statement needs two aliases of the same table.
   */
  filterSql?: string;
  /**
   * Columns that, together with the party column, make a row unique.
   *
   * When present, the merge deletes the loser's rows that would collide with a
   * row the winner already has *before* re-pointing the rest. Without this a
   * merge of two parties who are both "billing contact of Acme" would abort on
   * a unique violation — and a merge that fails halfway is the worst outcome
   * available, because the operation is irreversible.
   *
   * Dropping the loser's duplicate is the right resolution here: the winner
   * already asserts the same fact, so nothing is lost but a second copy of it.
   */
  uniqueWithSql?: readonly string[];
  /**
   * True when a row may reference the party at *both* ends (a relationship).
   * Merging the two endpoints would produce a self-edge, which the table's own
   * CHECK forbids — so those rows are deleted instead of moved.
   */
  selfEdgeColumn?: string;
}

/**
 * The classification, one entry per (table, column) that references a party.
 *
 * Ordered roughly by how much an owner cares: sales and money first, then the
 * CRM's own objects, then integrations, then the audit rows.
 */
export const PARTY_REFERENCES: readonly PartyReference[] = [
  // -- Accounting-owned operational data ------------------------------------
  {
    table: "orders",
    column: "customer_id",
    scope: "location",
    disposition: "move",
    reason:
      "Attribution of a sale to a person. The journal lines are untouched — only who the CRM says bought it moves — so the trial balance is identical before and after.",
    preview: true,
    previewLabel: "سفارش",
  },
  {
    table: "ar_receipts",
    column: "customer_id",
    scope: "business",
    disposition: "move",
    reason: "A receipt against the surviving party's receivable must reach the surviving party.",
    preview: true,
    previewLabel: "رسید دریافت",
  },
  {
    // Multicurrency (issue #863). The party attribution ON A LINE — the
    // foreign open item itself. Amounts (debit/credit/foreign) are untouched:
    // only who the ledger says the balance belongs to moves, exactly like the
    // orders entry above. Parent-scoped: journal_lines is tenanted by its
    // entry, and the generated UPDATE must hop through journal_entries.
    table: "journal_lines",
    column: "party_id",
    scope: "parent",
    parent: { table: "journal_entries", childColumn: "entry_id", parentColumn: "id" },
    disposition: "move",
    reason:
      "A foreign receivable/payable leg IS the person's open balance — the settlement FIFO and the foreign party report resolve it live. Leaving it on the archived record hides real money from the survivor's file; moving it touches only the attribution, never the posted amounts.",
  },
  {
    // Multicurrency (issue #863). The lot trail's denormalized copy of the
    // same attribution; it must keep agreeing with the settlement document
    // and the lot line it points at, so it follows the same merge.
    table: "fx_settlement_applications",
    column: "party_id",
    scope: "business",
    disposition: "move",
    reason:
      "The application repeats its settlement's party for the audit trail; after a merge it must still name the surviving party or the trail contradicts the settlement document and the lot line it belongs to.",
  },
  {
    table: "fixed_assets",
    column: "custodian_party_id",
    scope: "business",
    disposition: "move",
    reason:
      "An asset's custodian is operational: the register reads it live (history, responsibility), so it must resolve to the surviving party instead of an archived one. No journal line references the custodian — the trial balance is untouched.",
  },
  {
    table: "fixed_assets",
    column: "vendor_party_id",
    scope: "business",
    disposition: "move",
    reason:
      "The vendor an asset was bought from is a live register attribute (list, filters, export), not an audit row about the party itself; re-pointing keeps the provenance readable after two supplier files become one. The purchase journal entry is not touched.",
  },
  {
    table: "cheques",
    column: "customer_id",
    scope: "business",
    disposition: "move",
    reason:
      "An outstanding cheque is live operational money; leaving it on the archived record hides it from the surviving customer's file.",
    preview: true,
    previewLabel: "چک",
  },
  {
    table: "installments",
    column: "party_id",
    scope: "business",
    disposition: "move",
    reason: "An instalment plan is a live obligation of the person, not of the record that lost a merge.",
    preview: true,
    previewLabel: "قرارداد اقساط",
  },
  {
    table: "expenses",
    column: "party_id",
    scope: "business",
    // An expense survives its party being deleted outright — `ON DELETE SET
    // NULL` plus the free-text `vendor` snapshot keep the posted fact intact
    // (issue #832 §12). A merge is a different act: it does not destroy the
    // record, it declares that two rows were always the same person. Leaving
    // the link on the loser would strand it on an archived row, and the ledger
    // question the column exists to answer — «به این شخص/شرکت چقدر پرداختیم» —
    // would silently lose every expense the loser had.
    disposition: "move",
    reason:
      "The supplier link on a paid expense is a live ledger reference, not an audit annotation; the audit trail is the journal entry and the `vendor` snapshot, which a merge does not touch.",
    preview: true,
    previewLabel: "هزینه",
  },

  // -- Growth-owned programs ------------------------------------------------
  {
    table: "customer_points",
    column: "customer_id",
    scope: "business",
    disposition: "move",
    reason:
      "The loyalty ledger is the person's balance. Split across two records it is spendable twice and reportable as neither.",
    preview: true,
    previewLabel: "تراکنش امتیاز",
  },
  {
    table: "message_recipients",
    column: "customer_id",
    scope: "business",
    disposition: "move",
    reason:
      "Campaign send history belongs on the surviving file so the CRM timeline can show what was actually sent to this person. Growth still owns the rows; only the person they point at moves.",
    preview: true,
    previewLabel: "پیام ارسالی",
  },

  // -- Industry operational objects -----------------------------------------
  {
    table: "reservations",
    column: "customer_id",
    scope: "location",
    disposition: "move",
    reason: "A future booking must be reachable from the surviving file, or nobody finds it.",
    preview: true,
    previewLabel: "رزرو",
  },
  {
    table: "repair_tickets",
    column: "customer_id",
    scope: "location",
    disposition: "move",
    reason: "An open repair is live work owed to the person.",
    preview: true,
    previewLabel: "تعمیر",
  },
  {
    table: "custom_order_tickets",
    column: "customer_id",
    scope: "location",
    disposition: "move",
    reason: "A custom-order ticket is live work owed to the person (jewellery).",
    preview: true,
    previewLabel: "سفارش ساخت",
  },
  {
    table: "serial_returns",
    column: "customer_id",
    scope: "location",
    disposition: "move",
    reason:
      "A serialized return claim (issue #795) is live work owed to the person — a pending refund or exchange must be reachable from the surviving file.",
    preview: true,
    previewLabel: "مرجوعی سریالی",
  },
  {
    table: "serial_preowned_intakes",
    column: "party_id",
    scope: "business",
    disposition: "move",
    reason:
      "A pre-owned intake (issue #795 item 18) is the provenance document of where a unit came from — it must keep pointing at the surviving file.",
    preview: true,
    previewLabel: "دریافت دست‌دوم",
  },
  {
    table: "serial_reservations",
    column: "customer_id",
    scope: "business",
    disposition: "move",
    reason:
      "A reservation (issue #795 item 20) is a unit promised to the person — the hold must survive the merge so their invoice can still convert it.",
    preview: true,
    previewLabel: "رزرو ساعت",
  },
  {
    table: "layaway_plans",
    column: "customer_id",
    scope: "business",
    disposition: "move",
    reason: "A layaway plan is a live obligation with money already paid against it.",
    preview: true,
    previewLabel: "طرح رزرو کالا",
  },
  {
    table: "gold_account_movements",
    column: "customer_id",
    scope: "business",
    disposition: "move",
    reason: "A gold account is a real balance the person holds; two halves of it is a wrong balance twice.",
    preview: true,
    previewLabel: "گردش حساب طلا",
  },
  {
    table: "table_session_customers",
    column: "customer_id",
    scope: "business",
    disposition: "move",
    reason: "A seated guest attached to a table session must resolve to a live record while the session is open.",
  },

  // -- Platform-company CRM projections -------------------------------------
  {
    table: "platform_company_customers",
    column: "party_id",
    scope: "business",
    disposition: "blocked",
    reason: "Two separately mapped legal/billing customer accounts must be reconciled explicitly before their CRM parties can be merged.",
  },
  {
    table: "platform_company_web_leads",
    column: "party_id",
    scope: "business",
    disposition: "move",
    reason: "The attributed website inquiry belongs on the surviving CRM party; its original source and consent snapshot remain unchanged.",
    preview: true,
    previewLabel: "درخواست وب‌سایت",
  },

  // -- CRM's own objects ----------------------------------------------------
  {
    table: "customer_notes",
    column: "customer_id",
    scope: "business",
    disposition: "move",
    reason: "Notes about the person follow the person.",
    preview: true,
    previewLabel: "یادداشت",
  },
  {
    table: "crm_activities",
    column: "customer_id",
    scope: "business",
    disposition: "move",
    reason: "An open follow-up must appear on the surviving file or it is never done.",
    preview: true,
    previewLabel: "فعالیت",
  },
  {
    table: "crm_deals",
    column: "customer_id",
    scope: "business",
    disposition: "move",
    reason: "A live deal against an archived customer is invisible to the pipeline.",
    preview: true,
    previewLabel: "معامله",
  },
  {
    table: "crm_cases",
    column: "customer_id",
    scope: "business",
    disposition: "move",
    reason: "An open service case must stay reachable from the surviving file.",
    preview: true,
    previewLabel: "تیکت خدمات",
  },
  {
    table: "crm_cases",
    column: "contact_party_id",
    scope: "business",
    disposition: "move",
    reason:
      "The person to talk to about the case. Left on the archived record the case has a contact nobody can open.",
  },
  {
    table: "crm_consent_events",
    column: "customer_id",
    scope: "business",
    disposition: "move",
    reason:
      "The consent history of the person. Merge intersects the *current* answer conservatively; the event trail is carried across so the surviving file can still prove who said what and when.",
    preview: true,
    previewLabel: "رویداد رضایت",
  },
  {
    table: "crm_leads",
    column: "converted_party_id",
    scope: "business",
    disposition: "move",
    reason: "A converted lead points at the customer it became; that customer is now the winner.",
  },
  {
    table: "crm_party_relationships",
    column: "from_party_id",
    scope: "business",
    disposition: "move",
    reason: "A relationship edge from the losing record now starts at the winner.",
    // «A is billing contact of Acme» held by both records collapses to one.
    uniqueWithSql: ["to_party_id", "kind"],
    // A→B merged with B would become B→B, which the table's CHECK forbids.
    selfEdgeColumn: "to_party_id",
  },
  {
    table: "crm_party_relationships",
    column: "to_party_id",
    scope: "business",
    disposition: "move",
    reason: "A relationship edge to the losing record now ends at the winner.",
    uniqueWithSql: ["from_party_id", "kind"],
    selfEdgeColumn: "from_party_id",
  },
  {
    table: "crm_custom_field_values",
    column: "party_id",
    scope: "business",
    disposition: "move",
    reason: "Custom field values recorded about the person follow the person.",
    // One value per (field, party). The winner's own answer wins: it is the
    // record the business chose to keep.
    uniqueWithSql: ["field_id"],
  },

  // -- Website / external identity -----------------------------------------
  {
    table: "crm_external_profiles",
    column: "party_id",
    scope: "business",
    disposition: "move",
    reason:
      "THE bug this registry was written for. An external store profile left pointing at the archived loser means the next Woo webhook resolves its order onto a customer who no longer exists.",
    preview: true,
    previewLabel: "پروندهٔ فروشگاه آنلاین",
  },
  {
    table: "integration_mappings",
    column: "local_id",
    scope: "business",
    disposition: "move",
    reason:
      "The WooCommerce and Holoo customer mappings. A bare uuid with no FK, so no schema-driven check could see it — and that is exactly how a merge left a live store mapping resolving to an archived customer. Restricted to customer-kind rows: a product or order mapping's local_id is not a party.",
    noForeignKey: true,
    filterSql: "{t}.entity_type IN ('customer', 'holoo_customer')",
    preview: true,
    previewLabel: "نگاشت مشتری در اتصال‌ها",
  },

  // -- Shared directory -----------------------------------------------------
  {
    table: "suppliers",
    column: "party_id",
    scope: "location",
    disposition: "move",
    reason:
      "A branch supplier alias reads its name and phone from the party. Left on the loser it shows an archived record's details on a live purchase order.",
  },

  // -- Assistant drafts -----------------------------------------------------
  {
    table: "ai_proactive_drafts",
    column: "customer_id",
    scope: "business",
    disposition: "move",
    reason: "An unsent draft addressed to the person should address the surviving record.",
  },

  // -- My Workspace (Phase G) -----------------------------------------------
  // All four are `move`, for one reason: every one of these columns names the
  // real-world counterparty of a live commitment. A project is being delivered
  // FOR that customer, a contract is signed WITH that company, and neither
  // fact stops being true because two duplicate records were merged. Left on
  // the loser, the project header and the contract file would show an archived
  // customer's name and phone while the work is still running — the same bug
  // `suppliers.party_id` above exists to prevent.
  {
    table: "ai_projects",
    column: "party_id",
    scope: "business",
    disposition: "move",
    reason:
      "The project's client. The project is still being delivered for this person; pointing it at an archived record hides the live work from the surviving customer file.",
    preview: true,
    previewLabel: "پروژه‌ها",
  },
  {
    table: "workspace_contracts",
    column: "party_id",
    scope: "business",
    disposition: "move",
    reason:
      "The contract's counterparty. A signed agreement outlives a duplicate-record cleanup, and its expiry reminders must reach the surviving file.",
    preview: true,
    previewLabel: "قراردادهای اجرایی",
  },
  {
    table: "ai_project_tasks",
    column: "party_id",
    scope: "parent",
    parent: { table: "ai_projects", childColumn: "project_id", parentColumn: "id" },
    disposition: "move",
    reason:
      "The customer a task is being done for. Same rule as the project that contains it — an open task belongs to the surviving record.",
  },
  {
    table: "workspace_documents",
    column: "party_id",
    scope: "business",
    disposition: "move",
    reason:
      "A document filed against the customer. Leaving it on the loser removes it from the surviving file's document list, which is how a signed contract scan goes missing.",
  },

  // -- AEC (issue #799 Wave 2) ----------------------------------------------
  // Migration 0194's three party columns. All four are `move`: they name a live
  // counterparty on a project that is still running, and the migration's own
  // trigger refuses an archived or merged-away party — so leaving one pointing
  // at the loser would not merely hide it, it would make the row unwritable on
  // the next edit.
  {
    table: "aec_project_profiles",
    column: "employer_party_id",
    scope: "business",
    disposition: "move",
    reason:
      "The project's employer — the party the work is being delivered for. A duplicate-record merge must not leave the profile naming an archived company.",
    preview: true,
    previewLabel: "کارفرمای پروژه",
  },
  {
    table: "aec_project_profiles",
    column: "lead_consultant_party_id",
    scope: "business",
    disposition: "move",
    reason:
      "The lead consultant on the project. Same rule as the employer: the merged-away record must not remain the consultant of record.",
  },
  {
    table: "aec_project_profiles",
    column: "main_contractor_party_id",
    scope: "business",
    disposition: "move",
    reason:
      "The main contractor on the project, and a party the profile's trigger requires to be live and unmerged.",
  },
  {
    table: "aec_project_participants",
    column: "party_id",
    scope: "business",
    disposition: "move",
    reason:
      "An external participant's role on a project. It belongs to the surviving counterparty, and its trigger refuses a merged-away party just as the profile's does.",
    preview: true,
    previewLabel: "طرف‌های پروژه",
  },

  // -- AEC (issue #799 Wave 4) ----------------------------------------------
  {
    table: "aec_boq_items",
    column: "party_id",
    scope: "business",
    disposition: "move",
    // Only a *draft* revision may be written at all: migration 0196's line
    // guard refuses an UPDATE to any line of a submitted, approved or
    // superseded revision, so moving a frozen row would abort the whole merge.
    // Skipping them is also the right answer rather than a workaround — an
    // approved estimate is a historical document, and the supplier it named is
    // part of what was approved. Draft lines do move, because a draft stays
    // editable and its trigger refuses a merged-away party: leaving one behind
    // would make the next edit of that line fail.
    filterSql:
      "EXISTS (SELECT 1 FROM aec_estimate_versions v WHERE v.id = {t}.version_id AND v.status = 'draft')",
    reason:
      "The supplier or contractor a draft measured line is priced against. A draft line moves with the surviving record; a frozen revision keeps the name it was approved with.",
    preview: true,
    previewLabel: "ردیف‌های متره (پیش‌نویس)",
  },
  {
    table: "aec_transmittals",
    column: "sender_party_id",
    scope: "business",
    disposition: "move",
    // Same reasoning as the BOQ line: migration 0197's transmittal guard refuses
    // any content change to an issued transmittal, so a frozen one keeps the
    // sender it was issued under. Drafts move, because a draft stays editable
    // and its trigger refuses a merged-away party.
    filterSql:
      "EXISTS (SELECT 1 FROM aec_transmittals tm WHERE tm.id = {t}.id AND tm.status = 'draft')",
    reason:
      "The party a draft transmittal says it came from. A draft moves with the surviving record; an issued transmittal keeps the sender named in the record it issued.",
    preview: true,
    previewLabel: "برگه‌های ارسال (پیش‌نویس)",
  },
  {
    table: "aec_transmittal_recipients",
    column: "party_id",
    scope: "business",
    disposition: "move",
    // Only a *draft* transmittal's recipients may be rewritten: 0197 freezes the
    // recipient rows of an issued one, so moving a frozen row would abort the
    // merge — and keeping it is right, because that row is also the receipt.
    filterSql:
      "EXISTS (SELECT 1 FROM aec_transmittals tm WHERE tm.id = {t}.transmittal_id AND tm.status = 'draft')",
    reason:
      "Who a draft transmittal is addressed to. Drafts follow the surviving party; an issued transmittal keeps the recipient it was sent to, because that row is the receipt.",
    preview: true,
    previewLabel: "گیرندگان برگهٔ ارسال (پیش‌نویس)",
  },

  // -- AEC (issue #799 Wave 6) ----------------------------------------------
  {
    table: "aec_rfis",
    column: "responsible_party_id",
    scope: "business",
    disposition: "move",
    // Migration 0198's RFI guard freezes number, subject, question and the
    // original ask once the RFI leaves draft, and freezes the response once one
    // exists. The party that owes the answer is *not* among the frozen fields,
    // so the column always moves with the surviving record — a draft in
    // progress and an answered RFI alike. Leaving a closed RFI pointing at a
    // merged-away party would fail the trigger the next time the row is touched
    // (and the RFI's history would name a party that no longer exists).
    reason:
      "The party that owes (or owed) the answer to a project question. Always moves with the surviving record; who was asked is not part of a frozen RFI.",
    preview: true,
    previewLabel: "استعلام‌ها (RFI)",
  },
  // -- AEC (issue #799 Wave 7) ----------------------------------------------
  {
    table: "aec_site_log_lines",
    column: "party_id",
    scope: "business",
    disposition: "move",
    // 0199's line guard refuses any change to the lines of a *submitted* day, so
    // the filter moves a draft day's lines and leaves a signed day's exactly as
    // they were signed — the same shape as a draft transmittal's recipients.
    filterSql:
      "EXISTS (SELECT 1 FROM aec_site_logs sl WHERE sl.id = {t}.log_id AND sl.status = 'draft')",
    reason:
      "The contractor, plant owner or supplier a draft day's line names. A draft moves with the surviving party; a submitted day keeps the crew and supplier it was signed with.",
    preview: true,
    previewLabel: "عوامل و تجهیزات گزارش روزانه (پیش‌نویس)",
  },
  {
    table: "aec_site_issues",
    column: "responsible_party_id",
    scope: "business",
    disposition: "move",
    // Same reasoning as the RFI and submittal registers one wave earlier: a
    // closed or cancelled issue is frozen by 0199's guard and refuses the UPDATE,
    // and leaving the reference behind would abort the next write against it.
    filterSql:
      "EXISTS (SELECT 1 FROM aec_site_issues si WHERE si.id = {t}.id AND si.status NOT IN ('closed', 'cancelled'))",
    reason:
      "The contractor or supplier who owes a fix. A live issue follows the surviving party; a closed one keeps the party it was closed against.",
    preview: true,
    previewLabel: "موارد باز کارگاه",
  },
  {
    table: "aec_submittals",
    column: "responsible_party_id",
    scope: "business",
    disposition: "move",
    // Same shape: 0198's submittal guard freezes the identity of a register
    // entry once a revision has been submitted, but the responsible party is not
    // part of that identity — the submitter keeps moving so a live log never
    // names a party the merge removed.
    reason:
      "The party answerable for a submittal. Always moves with the surviving record; it is not part of what a submitted revision froze.",
    preview: true,
    previewLabel: "سابمیتال‌ها",
  },
  // -- AEC (issue #799 Wave 8) ----------------------------------------------
  {
    table: "aec_variations",
    column: "responsible_party_id",
    scope: "business",
    disposition: "move",
    // Migration 0200's variation guard freezes every field of a change order
    // once it has been submitted (only a rejected one may be reopened, and only
    // to be re-priced), so a merge can re-point the party on a draft or priced
    // change and must leave the rest exactly where they were named — the party a
    // submitted order was raised against must not change underneath the client
    // who received it.
    filterSql: "{t}.status IN ('draft', 'priced')",
    reason:
      "The party answerable for a change order. A draft or priced order follows the surviving record; a submitted one keeps the party it was raised against, because the client has seen that document.",
    preview: true,
    previewLabel: "تغییرات در حال تنظیم",
  },

  // -- AEC (issue #799 Wave 9) ----------------------------------------------
  // §18's three supplier columns. Suppliers stay `parties` — that is the whole
  // reason these are references to classify rather than a second supplier model.
  // Migration 0201's `aec_assert_party_live()` refuses an archived or
  // merged-away party, so a row left pointing at the loser becomes unwritable on
  // its next edit; each entry moves what may be moved and leaves the frozen rest.
  {
    table: "aec_rfq_suppliers",
    column: "party_id",
    scope: "business",
    disposition: "move",
    // An issued RFQ is frozen (0201's rfq guard), and its invitation rows are
    // part of what was sent — so only a draft tender's list moves. The unique
    // key is (rfq_id, party_id): when both records were invited to the same
    // tender, the loser's duplicate row is dropped rather than aborting the
    // merge.
    filterSql:
      "EXISTS (SELECT 1 FROM aec_rfqs q WHERE q.id = {t}.rfq_id AND q.status = 'draft')",
    uniqueWithSql: ["rfq_id"],
    reason:
      "A supplier invited to a draft RFQ. Drafts follow the surviving record; an issued tender keeps the invitation list it was sent with.",
    preview: true,
    previewLabel: "تأمین‌کنندگان دعوت‌شده به استعلام (پیش‌نویس)",
  },
  {
    table: "aec_supplier_quotations",
    column: "party_id",
    scope: "business",
    disposition: "move",
    // `selected` and `declined` quotations are history and 0201 refuses to
    // update them at all; received and shortlisted ones are still live rows and
    // move. Same unique key as the invitation list, so the same collision rule.
    filterSql: "{t}.status NOT IN ('selected', 'declined')",
    uniqueWithSql: ["rfq_id"],
    reason:
      "The supplier an offer came from. A live offer follows the surviving record; a decided one is the history the award was made against.",
    preview: true,
    previewLabel: "پیشنهادهای تأمین‌کنندگان",
  },
  {
    table: "aec_commitments",
    column: "supplier_party_id",
    scope: "business",
    disposition: "move",
    // A submitted award is frozen (0201's commitment guard), so a draft moves
    // and the rest keep the supplier they oblige. No unique conflict: a project
    // may have many awards to one supplier.
    filterSql: "{t}.status = 'draft'",
    reason:
      "The supplier a purchase order or subcontract obliges. A draft moves with the surviving record; a submitted award keeps the supplier the client and the books were told about.",
    preview: true,
    previewLabel: "سفارش‌های خرید و پیمان‌های جزئی (پیش‌نویس)",
  },

  // -- Historical / audit: deliberately NOT moved ---------------------------
  {
    table: "crm_merges",
    column: "loser_id",
    scope: "business",
    disposition: "historical",
    reason:
      "The record of the merge itself. Repointing it at the winner turns «A was merged into B» into «B was merged into B» and destroys the only explanation of the file's history.",
  },
  {
    table: "crm_merges",
    column: "winner_id",
    scope: "business",
    disposition: "move",
    reason:
      "A chained merge (A→B, then B→C) must re-point B's earlier wins at C, or the audit trail dead-ends at an archived record.",
  },
  {
    table: "parties",
    column: "merged_into_id",
    scope: "business",
    disposition: "historical",
    reason:
      "The merge pointer itself, written by the merge. It is set to the winner as part of the operation, not migrated by the generic pass.",
  },
];

const BY_TABLE_COLUMN = new Map(
  PARTY_REFERENCES.map((reference) => [`${reference.table}.${reference.column}`, reference]),
);

/** Look up the classification for one (table, column) pair, if it has one. */
export function partyReferenceFor(table: string, column: string): PartyReference | undefined {
  return BY_TABLE_COLUMN.get(`${table}.${column}`);
}

/** The references a merge actively re-points at the winner. */
export function movedPartyReferences(): PartyReference[] {
  return PARTY_REFERENCES.filter((reference) => reference.disposition === "move");
}

/** The references deliberately left pointing at the archived record. */
export function historicalPartyReferences(): PartyReference[] {
  return PARTY_REFERENCES.filter((reference) => reference.disposition === "historical");
}

/** The references itemised in the merge preview, in registry order. */
export function previewPartyReferences(): PartyReference[] {
  return PARTY_REFERENCES.filter((reference) => reference.preview);
}

/**
 * Classify a live foreign key discovered in the database.
 *
 * Anything the registry does not name is `blocked` — the fail-closed default
 * that makes "somebody added a customer table and forgot about merge" a test
 * failure rather than a support ticket six months later.
 */
export function classifyPartyReference(table: string, column: string): MergeDisposition {
  return partyReferenceFor(table, column)?.disposition ?? "blocked";
}

/**
 * The key used to report an unclassified reference. Kept as a function so the
 * merge service, the coverage test and any future tooling all spell it the
 * same way.
 */
export function partyReferenceKey(table: string, column: string): string {
  return `${table}.${column}`;
}

/**
 * Persian labels for the merge preview, keyed by table.
 *
 * Exported from the registry rather than restated in the dialog, because the
 * duplicates screen used to keep its own `MOVE_LABELS` map — and that map knew
 * about nine tables while the merge touched more than twenty. An owner
 * confirming an irreversible operation was shown a *subset* of what was about
 * to happen, with no indication anything was missing. One source, so the
 * preview cannot drift from the behaviour again.
 */
export function partyReferenceLabels(): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const reference of previewPartyReferences()) {
    // First label wins when a table is previewed through two columns; both
    // columns describe the same kind of row to the reader.
    labels[reference.table] ??= reference.previewLabel ?? reference.table;
  }
  return labels;
}
