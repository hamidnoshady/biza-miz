/**
 * Issue #883 (package 1) — the coverage map: one typed source from which
 * `docs/mcp/coverage-matrix.md` is generated.
 *
 * Each row is a domain entity (tenant realm) or a console surface (platform
 * realm). The generator walks every `src/app/api/** /route.ts`, matches
 * routes to rows by prefix, derives the operation columns from the verbs and
 * path shapes the route files actually export, and joins the rows with the
 * MCP capability registries:
 *
 *   - tenant reads  → `MCP_READ_REGISTRY` (./registry.ts)
 *   - tenant writes → `MCP_WRITE_REGISTRY`
 *   - platform      → `PLATFORM_MCP_TOOLS` (./platform-mcp.ts)
 *
 * `ops` lists the MCP verbs serving each operation column TODAY. An empty
 * list against a column the API supports is the gap the issue is closing —
 * add the verb to the registry and update the row in the same commit; the
 * drift test regenerates the matrix and rejects the divergence.
 *
 * Unmatched route files are not silently dropped: the generator prints them
 * into an "unclassified" section of the matrix, so extending the API without
 * touching this map makes the incompleteness visible in the same review.
 */

export interface CoverageOps {
  /** list/search/detail cell — read verbs, or empty when only the HTTP route exists. */
  listDetail?: string[];
  create?: string[];
  update?: string[];
  lifecycle?: string[];
  /** bulk / import / export cell */
  bulk?: string[];
}

export interface CoverageEntity {
  id: string;
  module: string;
  entity: string;
  /** Route prefixes, e.g. "ledger/accounts". Prefixed "platform/" for the console realm. */
  routes: string[];
  note?: string;
  ops?: CoverageOps;
  /** The integration/unit test that proves the row. */
  test?: string;
  /**
   * Explicit status when derivation cannot express it:
   *  - `"backend gap"` — the domain (service) supports the operation but the
   *    API does not (and neither does MCP): missing on both sides.
   *  - `"n/a (infra)"` — transport/sync/pairing/session machinery that is not
   *    a business operation (an AI client has no use for it).
   *  - `"duplicate surface"` — legacy alias routes already covered elsewhere.
   * Absent ⇒ status is derived from the ops columns.
   */
  status?: "backend gap" | "n/a (infra)" | "duplicate surface";
}

/**
 * Tenant realm (posmcp_) — grouped in the module order the matrix prints.
 * `module` is the report bucket, `routes` are prefix-matched route dirs.
 */
export const TENANT_COVERAGE: CoverageEntity[] = [
  // ============================ Accounting (ledger + banking) ============================
  {
    id: "accounting.accounts",
    module: "Accounting",
    entity: "Chart of accounts",
    routes: ["ledger/accounts"],
    note: "account history rides list_audit_log {entity: account} — same service, stricter gate is the audit screen's own teamManage",
    ops: { listDetail: ["list_accounts", "get_account_statement"], create: ["account.create"], update: ["account.update", "account.disable"], lifecycle: ["account.delete"] },
    test: "integration/chart-of-accounts.integration.test.ts",
  },
  {
    id: "accounting.entries",
    module: "Accounting",
    entity: "Journal entries",
    routes: ["ledger/entries"],
    note: "manual drafts are intentionally one lane — humans and the assistant both draft through the same parseManualDraftPayload pipeline (journal.manual.propose); reversal makes a new mirrored entry, never an edit",
    ops: { listDetail: ["list_journal_entries", "list_manual_journal_drafts"], create: ["journal.manual.propose"], lifecycle: ["journal.draft.approve", "journal.draft.reject", "journal.entry.reverse"] },
    test: "integration/ledger-reports.integration.test.ts",
  },
  {
    id: "accounting.ar",
    module: "Accounting",
    entity: "Receivables (receipts, aging, customers)",
    routes: ["ledger/ar"],
    ops: { listDetail: ["get_ar_aging", "list_receipts"], create: ["ar.receipt.record"] },
    test: "integration/expense.integration.test.ts",
  },
  {
    id: "accounting.ap",
    module: "Accounting",
    entity: "Payables (payments, aging, suppliers)",
    routes: ["ledger/ap"],
    ops: { listDetail: ["get_ap_upcoming", "list_payments"], create: ["ap.payment.record"], lifecycle: ["ap.payment.reverse"] },
    test: "integration/expense.integration.test.ts",
  },
  {
    id: "accounting.cheques",
    module: "Accounting",
    entity: "Cheques (receivable/payable)",
    routes: ["ledger/cheques"],
    ops: { listDetail: ["list_cheques"], create: ["cheque.create"], lifecycle: ["cheque.transition"] },
  },
  {
    id: "accounting.expenses",
    module: "Accounting",
    entity: "Expenses",
    routes: ["ledger/expenses"],
    ops: { listDetail: ["list_expenses", "get_expense"], create: ["expense.categorize"], lifecycle: ["expense.reverse"] },
    test: "integration/expense.integration.test.ts",
  },
  {
    id: "accounting.fixed-assets",
    module: "Accounting",
    entity: "Fixed assets (register, depreciate, dispose, transfer)",
    routes: ["ledger/fixed-assets"],
    ops: { listDetail: ["list_fixed_assets"], create: ["fixed-asset.create"], update: ["fixed-asset.set_acquisition"], lifecycle: ["fixed-asset.depreciate", "fixed-asset.dispose"] },
    test: "integration/fixed-assets.integration.test.ts",
  },
  {
    id: "accounting.payroll",
    module: "Accounting",
    entity: "Payroll (settings, staff, runs, advances)",
    routes: ["ledger/payroll"],
    ops: { listDetail: ["get_payroll_summary", "list_payroll_runs", "list_payroll_advances"], create: ["payroll.run.accrue", "payroll.advance.record"], update: ["payroll.settings.update", "payroll.staff.terms"], lifecycle: ["payroll.run.pay", "payroll.run.void", "payroll.advance.void"] },
    note: "settings and pay terms are always_approve by parity with the rest of the money-shaping payroll verbs (settings govern every future run; terms change somebody's pay)",
    test: "integration/payroll.integration.test.ts",
  },
  {
    id: "accounting.reconciliation",
    module: "Accounting",
    entity: "Bank reconciliation",
    routes: ["ledger/reconciliations"],
    ops: { listDetail: ["get_unreconciled_bank_lines", "list_reconciliations"], create: ["reconciliation.create"], update: ["reconciliation.line.clear"], lifecycle: ["reconciliation.complete"] },
    note: "line clearance rides the shared parseLineClearanceRequest parser — boolean required, batch wins, a malformed batch is refused whole, never partly applied",
    test: "integration/reconciliation.integration.test.ts",
  },
  {
    id: "accounting.fiscal",
    module: "Accounting",
    entity: "Fiscal years & periods (open/close), readiness",
    routes: ["ledger/fiscal-years", "ledger/fiscal-periods", "ledger/fiscal-readiness"],
    ops: { listDetail: ["list_fiscal_years", "get_fiscal_readiness"], create: ["fiscal.year.create"], update: ["fiscal.period.set_status"], lifecycle: ["fiscal.year.close"] },
    note: "all three calendar verbs are always_approve: a reopened period takes postings again, a locked one freezes them, a closed year builds its closing entries under the year lock (unwind is console-only, no MCP verb)",
    test: "integration/fiscal-readiness.integration.test.ts",
  },  {
    id: "accounting.vat",
    module: "Accounting",
    entity: "VAT & trial balance",
    routes: ["ledger/vat", "ledger/trial-balance"],
    ops: { listDetail: ["get_vat_liability", "run_report"] },
    test: "integration/ledger.integration.test.ts",
  },
  {
    id: "accounting.installments",
    module: "Accounting",
    entity: "Installment contracts",
    routes: ["ledger/installments"],
    ops: { listDetail: ["list_installment_plans"], create: ["installment.plan.create"], lifecycle: ["installment.item.pay"] },
    test: "integration/installments.integration.test.ts",
  },
  {
    id: "accounting.misc-ledger",
    module: "Accounting",
    entity: "Ledger overview / settings / shift sales",
    routes: ["ledger/overview", "ledger/settings", "ledger/shift-sales"],
    ops: { listDetail: ["run_accounting_review"] },
  },

  // ============================ POS (orders / payments / shifts) ============================
  {
    id: "pos.orders",
    module: "POS",
    entity: "Orders (open, amend, pay, refund/returns)",
    routes: ["orders"],
    note: "amend, pay/settle and returns/refunds stay MCP gaps by design for now: their posting orchestration is inline in the route handlers (COGS, outbox, loyalty, refunds post with about/reversal shape). A money path is only exposed after its orchestration is extracted into a shared service — see issue #883 package 2 follow-ups.",
    ops: { listDetail: ["get_void_pattern", "list_orders", "get_order"], create: ["order.discount.apply", "order.create"] },
    test: "integration/orders.integration.test.ts",
  },
  {
    id: "pos.shifts",
    module: "POS",
    entity: "Shifts (start/end/close, active)",
    routes: ["shifts"],
    ops: { listDetail: ["list_shifts"], create: ["shift.start"], lifecycle: ["shift.end", "shift.close"] },
    test: "integration/shifts.integration.test.ts",
  },
  {
    id: "pos.kitchen-floor",
    module: "POS",
    entity: "Kitchen display / floor / waiter queues",
    routes: ["kitchen", "floor", "waiter"],
    ops: { listDetail: ["get_table_turnover_rate"] },
    status: undefined,
    note: "read-only live queues; writes happen through order item actions",
  },
  {
    id: "pos.reservations",
    module: "POS",
    entity: "Reservations",
    routes: ["reservations"],
    ops: { listDetail: ["get_reservation_conflicts"] },
    test: "integration/reservations.integration.test.ts",
  },
  {
    id: "pos.tables",
    module: "POS",
    entity: "Dining tables & table sessions",
    routes: ["tables", "table-sessions"],
    ops: {
      create: ["table.session.open"],
      update: ["table.session.update"],
    },
    note: "batch AF: session open/update verbs broadcast table_session.updated exactly like the routes (the executor runs server-side, where the realtime hub lives), and setSessionGuests was extracted verbatim into the service so route and verb share the guest rules; floor-plan table CRUD (tables routes) still needs its own extraction — the designation lane is designer-side config",
  },

  // ============================ Menu & pricing ============================
  {
    id: "pos.menu",
    module: "Menu",
    entity: "Menu categories, items, modifier groups, modifiers, reorder",
    routes: ["menu"],
    ops: {
      // Batch C (#883) put the whole menu-designer surface on the catalogue:
      // categories + items create/update through the shared services, the
      // full menu tree as a read, modifier groups still as they were.
      listDetail: ["find_items", "get_menu_performance", "get_menu_tree"],
      create: ["menu.category.create", "menu.item.create"],
      lifecycle: ["menu.item.disable"],
      update: ["menu.category.update", "menu.item.update", "menu.item.priceUpdate"],
    },
    test: "integration/menu.integration.test.ts",
  },

  // ============================ Inventory / stock ============================
  {
    id: "inventory.items",
    module: "Inventory",
    entity: "Stock items & stock levels",
    routes: ["inventory/items", "inventory/stock-levels", "inventory", "inventory/low-stock", "inventory/location-items"],
    ops: { listDetail: ["get_stock_valuation", "forecast_demand"], create: ["inventory.adjustment.propose"] },
    test: "integration/stock.integration.test.ts",
  },
  {
    id: "inventory.warehouses-transfers",
    module: "Inventory",
    entity: "Warehouses, transfers, warehouse documents",
    routes: ["inventory/warehouses", "inventory/transfers", "inventory/warehouse-documents"],
    ops: {
      listDetail: ["list_inventory_transfers", "list_warehouse_documents"],
      create: ["transfer.create", "warehouseDocument.create"],
      lifecycle: ["transfer.ship", "transfer.receive", "transfer.cancel"],
    },
    note: "the warehouses screen itself is the branch/location directory — covered by list_branches and the branch.* writes; transfer ship/receive/cancel and the posting document are always_approve (priced layers move), transfer.create is a draft",
    test: "integration/warehouse-document.integration.test.ts + retail-warehouse-document",
  },
  {
    id: "inventory.counts",
    module: "Inventory",
    entity: "Stock counts / periodic closings / visual count scans",
    routes: ["inventory/stock-counts", "inventory/periodic-closings", "inventory/visual-count-scans", "inventory/visual-profiles"],
    ops: {
      // Batch G (#883): the list detail share one service (the route's GET was
      // extracted into listStockCounts verbatim); the count-create lane is the
      // adjustment's own verb (same /stock-counts POST); batch AA added the
      // correct/reverse pair as client-transaction services like batch L.
      listDetail: ["list_stock_counts", "get_stock_count"],
      create: ["inventory.adjustment.propose"],
      update: ["inventory.count.edit"],
      lifecycle: ["inventory.count.reverse"],
    },
    note: "periodic closings and visual count scans (image upload/AI scan) stay route-only: a closing is an accounting period operation with no service-level undo, and the scan is a bytes flow",
    test: "integration/item-stock-counts.integration.test.ts",
  },
  {
    id: "inventory.purchases-suppliers",
    module: "Inventory",
    entity: "Purchases, supplier returns, suppliers",
    routes: ["inventory/purchases", "inventory/supplier-returns", "inventory/suppliers"],
    ops: {
      // Batch G (#883): suppliers directory read + the supplier-return voucher
      // (stock-out + settlement posting, same tx as the route).
      // Batch AT (#883): draft edit, ordered/cancelled transitions, receive
      // (stock + ledger), draft delete, and the supplier edit/archive pair.
      listDetail: ["get_supplier_performance", "list_suppliers"],
      create: ["inventory.reorder.draftPO", "supplier.return.create"],
      update: ["purchase.update", "supplier.update"],
      lifecycle: ["purchase.lifecycle", "purchase.receive", "purchase.delete", "supplier.archive"],
    },
    note: "AT closes the [id] lanes: receive posts stock+ledger and delete erases a business record, so both are always_approve like the supplier-return voucher",
    test: "integration/purchase-invoice-asset.integration.test.ts",
  },
  {
    id: "inventory.production",
    module: "Inventory",
    entity: "Production formulas & runs, modifier recipes",
    routes: ["inventory/production", "inventory/recipes", "inventory/modifier-recipes"],
    ops: {
      listDetail: ["list_formulas", "list_production_runs"],
      create: ["production.formula.create", "production.formulaInput.set"],
      update: ["production.formula.update", "inventory.production.run"],
      lifecycle: ["production.formula.deactivate", "production.formulaInput.delete"],
    },
    note: "the run itself is inventory.production.run (reversible via its own undo); formula shell/lines/edit/deactivate close the CRUD ring around it; modifier recipe assignment stays route-only (menu-screen layout, covered by recipe.assign elsewhere)",
    test: "integration/production-runs.integration.test.ts",
  },
  {
    id: "inventory.barcodes",
    module: "Inventory",
    entity: "Barcodes (lookup, bulk)",
    routes: ["inventory/barcodes", "barcodes"],
    ops: {
      listDetail: ["list_item_barcodes", "list_items_without_barcode"],
      create: ["barcode.assign"],
      bulk: ["barcode.bulkMint"],
    },
    note: "AS closes the bulk column — the idempotent whole-branch mint",
    test: "integration/inventory-barcodes.integration.test.ts",
  },
  {
    id: "inventory.waste-writedowns",
    module: "Inventory",
    entity: "Waste & write-downs",
    routes: ["inventory/waste", "inventory/write-downs"],
    ops: { listDetail: ["get_waste_history"] },
    test: "integration/stock.integration.test.ts",
  },
  {
    id: "inventory.stock-module",
    module: "Inventory",
    entity: "stock/* routes",
    routes: ["stock"],
    status: "duplicate surface",
    note: "legacy alias of the inventory/* surface",
  },

  // ============================ CRM / parties ============================
  {
    id: "crm.customers",
    module: "CRM",
    entity: "Customers (profile, notes, tags, relationships, merge, duplicates, consent)",
    routes: ["crm/customers", "parties", "crm/external-profiles"],
    ops: {
      // Batch D (#883): notes reads + lifecycle (delete/pin), consent as a
      // logged legal event — both live behind the same services the CRM file
      // of the business uses (parties.view/manage on notes & activities and
      // crm.consent_manage on consent, exactly the routes' gates).
      listDetail: ["get_customer_profile", "find_customers", "get_customer_timeline", "get_at_risk_customers", "list_customer_notes", "list_crm_activities"],
      create: ["party.customer.create", "party.supplier.create", "customer.note.add", "crm.customer.note", "crm.consent.set"],
      update: ["crm.customer.tag", "crm.note.pin"],
      lifecycle: ["crm.note.delete"],
    },
    test: "integration/parties.integration.test.ts",
  },
  {
    id: "crm.deals-leads",
    module: "CRM",
    entity: "Deals & leads (handoff, convert)",
    routes: ["crm/deals", "crm/leads"],
    ops: {
      listDetail: ["list_crm_deals", "list_crm_leads"],
      create: ["crm.lead.save", "crm.deal.save"],
      update: ["crm.deal.move_stage"],
      lifecycle: ["crm.lead.convert", "crm.deal.delete"],
    },
    note: "the services are upserts (optional id), matching the routes' create-vs-update split; convert is transactional and duplicate-guarded, exactly the screen button",
    test: "integration/crm.integration.test.ts",
  },
  {
    id: "crm.cases-activities",
    module: "CRM",
    entity: "Cases & activities",
    routes: ["crm/cases", "crm/activities"],
    ops: {
      listDetail: ["list_crm_cases", "list_crm_activities"],
      create: ["crm.case.save", "crm.activity.create"],
      update: ["crm.activity.update", "crm.case.set_status"],
      lifecycle: ["crm.case.delete"],
    },
    note: "writes gate on partiesManage like their routes (the CRM screens share the parties lane); setCaseStatus drives the SLA clock identical to the screen button",
    test: "integration/crm.integration.test.ts",
  },
  {
    id: "crm.pipelines",
    module: "CRM",
    entity: "Pipelines & stages",
    routes: ["crm/pipelines"],
    ops: {
      listDetail: ["list_crm_pipelines"],
      create: ["crm.pipeline.create"],
      update: ["crm.pipeline.update"],
    },
    note: "stage set edits (savePipelineStages) stay route-only: structural rework belongs to the settings screen, not a chat turn",
    test: "integration/crm.integration.test.ts",
  },
  {
    id: "crm.segments-views",
    module: "CRM",
    entity: "Segments, saved views, queues, RFM",
    routes: ["crm/segments", "crm/saved-views", "crm/queues", "crm/rfm"],
    ops: {
      // Batch D (#883): segments beyond read-only — create/update/archive all
      // ride the crm-segments service the screens use.
      listDetail: ["list_customer_segments", "preview_customer_segment", "get_repurchase_candidates"],
      create: ["crm.segment.create"],
      update: ["crm.segment.update"],
      lifecycle: ["crm.segment.archive"],
    },
    test: "integration/crm.integration.test.ts",
  },
  {
    id: "crm.config",
    module: "CRM",
    entity: "CRM automations, custom fields, audit",
    routes: ["crm/automations", "crm/custom-fields", "crm/audit"],
    // Batch D reads the rules and toggles each rule's on/off; rule-shape
    // editing stays on the screen (the rule DSL is screen-owned).
    ops: {
      listDetail: ["list_crm_automations", "list_custom_fields"],
      create: ["crm.customField.save"],
      update: ["crm.automation.toggle", "crm.customField.save"],
      lifecycle: ["crm.customField.archive"],
    },
    note: "AR close-out: automation create/rule DSL stays screen-owned by design (batch D decision); custom fields fully covered — save is the route's single create-or-edit POST, archive its soft delete",
    test: "integration/crm.integration.test.ts",
  },
  {
    id: "crm.overview",
    module: "CRM",
    entity: "CRM overview, members, consent state, data quality",
    routes: ["crm/overview", "crm/members", "crm/consent", "crm/quality"],
    ops: {
      listDetail: ["get_crm_overview", "get_crm_data_quality", "list_crm_members", "get_crm_queue"],
      update: ["crm.customer.tag", "crm.consent.set"],
    },
    note: "consent state changes ride the customer row's crm.consent.set (logged legal event, always_approve); quality/merge POST stays route-only (mass mutation identity merge)",
    test: "integration/crm.integration.test.ts",
  },
  {
    id: "crm.loyalty",
    module: "CRM",
    entity: "Loyalty programs, store credit, redemptions",
    routes: ["loyalty"],
    ops: {
      listDetail: ["get_repurchase_candidates"],
      create: ["loyalty.program.upsert"],
      lifecycle: ["loyalty.points.redeem", "loyalty.store_credit.issue", "loyalty.store_credit.use"],
    },
    note: "every wallet lane (redeem / issue / payout) steps up forever — points and store credit are the customer's money; loyalty reports and the repurchase feed stay read lanes",
    test: "integration/loyalty.integration.test.ts",
  },

  // ============================ Growth / marketing / messaging ============================
  {
    id: "growth.settings-campaigns",
    module: "Growth",
    entity: "Growth overview, settings, campaign audience, accounting",
    routes: ["growth"],
    ops: { listDetail: ["list_message_templates", "list_message_campaigns"], lifecycle: ["messaging.campaign.pause", "messaging.campaign.resume", "messaging.campaign.launch"] },
    note: "growth settings screen (channels, tariffs, attribution windows) stays route-only — Twilio/SMS sender configuration is credential-shaped and never crosses the chat channel; campaign draft creation is proposal-only by design (see growth.messaging)",
    test: "integration/crm.integration.test.ts",
  },
  {
    id: "growth.messaging",
    module: "Growth",
    entity: "Messaging rules & templates",
    routes: ["messaging", "notifications/rules"],
    ops: { listDetail: ["list_message_templates"], create: ["messaging.template.save"], lifecycle: ["crm.customer.note", "messaging.campaign.pause", "messaging.campaign.resume", "messaging.campaign.launch"] },
    note: "campaign DRAFT creation stays proposal-only (the assistant writes the campaign card, the browser sends it) — same design class as website.post.publish; notification rules live on their own screen with their own route",
    test: "integration/crm.integration.test.ts",
  },
  {
    id: "growth.promotions",
    module: "Growth",
    entity: "Promotions & gift cards (issue, expire, redeem)",
    routes: ["promotions"],
    ops: {
      // Batch F (#883): promotion create/toggle, gift-card issue (liability
      // posting rides the route's transaction), card balance+history by code.
      // Batch AC: standalone redeem + the deliberate expiry tick — the
      // spend side outside a sale, always_approve both.
      listDetail: ["list_promotions", "get_gift_card_status"],
      create: ["promotion.upsert", "gift_card.issue"],
      update: ["promotion.toggle"],
      lifecycle: ["gift_card.redeem", "gift_card.expire_run"],
    },
    test: "integration/promotions.integration.test.ts",
  },

  // ============================ Website / CMS / WooCommerce ============================
  {
    id: "cms.posts-products",
    module: "Website / CMS",
    entity: "Posts & products (publish, update)",
    routes: ["cms/website/posts", "cms/website/products", "cms/website/catalog"],
    ops: {
      listDetail: ["list_website_posts", "list_website_products"],
      create: ["website.post.draft"],
      update: ["website.post.update", "website.product.upsert"],
    },
    test: "integration/website.integration.test.ts",
  },
  {
    id: "cms.status",
    module: "Website / CMS",
    entity: "Website overview & state",
    routes: ["cms/website/overview", "cms/website/state"],
    ops: { listDetail: ["get_website_status"] },
    test: "integration/website.integration.test.ts",
  },
  {
    id: "cms.order-web",
    module: "Website / CMS",
    entity: "Order events, revalidate, public website connector endpoints (leads, managers, billing)",
    routes: ["cms/order-events", "cms/revalidate", "website/leads", "website/managers", "website/billing"],
    status: "n/a (infra)",
  },
  {
    id: "cms.drafts-pages-media",
    module: "Website / CMS",
    entity: "Drafts, pages, website media",
    routes: ["cms/website/drafts", "cms/website/pages", "cms/website/media"],
    ops: {
      listDetail: ["list_website_posts", "list_cms_pages", "list_cms_media"],
      create: ["website.post.draft"],
      update: ["website.post.update"],
    },
    note: "page publish stays a human-confirmed action off-MCP — the same rule website.post.publish already documents in tools.ts; media upload is bytes-in-flight, not a JSON envelope",
    test: "integration/website-sync.integration.test.ts",
  },
  {
    id: "cms.setup-design-domain",
    module: "Website / CMS",
    entity: "Connection, setup/build, design, domain/DNS, CDN",
    routes: ["cms/website/setup", "cms/website/connect", "cms/website/connection", "cms/website/design", "cms/website/domain", "cms/website/dns", "cms/website/cdn"],
    ops: {
      listDetail: ["get_website_status", "get_website_dns", "get_website_cdn"],
      update: ["website.domain.set"],
    },
    note: "credential paths (connect/disconnect keys, sync-switch toggles) and the domain PURCHASE flow stay route-only: secrets never cross the chat channel and buying a domain is wallet spend — see issue #883 package 2 follow-ups",
    test: "integration/website-sync.integration.test.ts",
  },
  {
    id: "cms.orders",
    module: "Website / CMS",
    entity: "Website orders",
    routes: ["cms/website/orders"],
    ops: { lifecycle: ["website.order.status"] },
    note: "orders are read on the connected site itself — this lane owns only the status PATCH (pending/paid/cancelled/refunded), always_approve because it publishes customer-visible money state and the CMS hooks settle stock",
    test: "integration/website-sync.integration.test.ts",
  },
  {
    id: "cms.woocommerce",
    module: "Website / CMS",
    entity: "WooCommerce manager (posts, queue, syncs)",
    routes: ["integrations/wp-manager"],
    ops: {
      listDetail: ["list_wp_queue", "get_wp_queue_summary", "get_wp_overview"],
      bulk: ["wp.queue.retry", "wp.queue.retry_all_failed", "wp.queue.flush"],
    },
    status: undefined,
    note: "content/queue reads ride list_website_* plus these manager views; retry/flush only re-pend events the shop already approved or wake the drainer early — connection resolution follows the screens (single active shop implicit, several need connectionId)",
  },

  // ============================ Projects (My Workspace) ============================
  {
    id: "workspace.projects",
    module: "Workspace",
    entity: "Projects, members, phases",
    routes: ["workspace/projects"],
    ops: {
      // Batch H (#883): project CRUD through the workspace service with the
      // owner's access flags rebuilt for the authorizing user.
      listDetail: ["get_workspace_project_status", "list_workspace_projects"],
      create: ["project.create", "project.member.set", "project.phase.create"],
      update: ["project.update"],
      lifecycle: ["project.member.remove"],
    },
    note: "AQ close-out: member/phase lanes re-run requireProjectCapability exactly like their routes; last-owner removal is refused in service",
    test: "integration/workspace.integration.test.ts",
  },
  {
    id: "workspace.tasks",
    module: "Workspace",
    entity: "Tasks, checklist, dependencies",
    routes: ["workspace/tasks"],
    ops: {
      // Batch H (#883): task create/update/status — the kanban screen's verbs,
      // with open/done transitions staying service-signed.
      listDetail: ["list_workspace_tasks"],
      create: ["task.create"],
      update: ["task.update"],
      lifecycle: ["task.status"],
    },
    test: "integration/workspace.integration.test.ts",
  },
  {
    id: "workspace.calendar-comments",
    module: "Workspace",
    entity: "Calendar, comments, documents, templates",
    routes: ["workspace/calendar", "workspace/comments", "workspace/documents", "workspace/templates"],
    ops: {
      listDetail: ["list_workspace_calendar", "list_workspace_comments", "list_workspace_templates", "list_workspace_documents", "get_workspace_document"],
      create: ["workspace.event.create", "workspace.comment.add", "workspace.document.create"],
      update: ["workspace.event.update", "workspace.document.update", "workspace.template.save"],
      lifecycle: ["workspace.event.delete", "workspace.document.delete", "workspace.template.archive"],
    },
    note: "document links are validated against the calling owner (validateDocumentLinks); revisions inherit version numbers server-side via supersedesId; template apply is workspace.project.create's templateKey, not a standalone verb",
    test: "integration/workspace.integration.test.ts",
  },
  {
    id: "workspace.contracts",
    module: "Workspace",
    entity: "Contracts & lifecycle",
    routes: ["workspace/contracts"],
    ops: {
      listDetail: ["list_expiring_contracts", "get_workspace_contract"],
      create: ["contract.create"],
      update: ["contract.update", "contract.lifecycle"],
      lifecycle: ["contract.delete"],
    },
    note: "AQ close-out: every lane re-runs resolveWorkspaceSubject(contract, id, edit) on the authorizing user's rebuilt flags; delete is a business-record erasure so it steps up on every call",
    test: "integration/workspace.integration.test.ts",
  },
  {
    id: "workspace.approvals",
    module: "Workspace",
    entity: "Approvals",
    routes: ["workspace/approvals"],
    ops: {
      listDetail: ["list_workspace_approvals"],
      create: ["workspace.approval.request"],
      lifecycle: ["workspace.approval.decide"],
    },
    test: "integration/workspace.integration.test.ts",
  },
  {
    id: "workspace.aec",
    module: "Workspace",
    entity: "AEC registers (RFIs, change orders, payment certificates, submittals, site issues, procurement)",
    routes: ["aec"],
    ops: {
      listDetail: [
        "list_pending_rfis", "list_change_orders", "list_payment_certificates",
        "list_pending_submittals", "list_site_issues", "list_procurement_delays",
        "get_aec_project_financial_health", "get_boq_variance", "get_latest_drawing_revision",
        "list_project_commercial_risks", "list_delayed_project_activities", "list_upcoming_milestones",
      ],
    },
    status: undefined,
  },

  // ============================ Business configuration ============================
  {
    id: "config.settings",
    module: "Business config",
    entity: "Business profile & settings (accounts, pricing, tax, logo, MFA policy, print rules/templates/printers, payment methods, online platforms)",
    routes: ["settings"],
    ops: { listDetail: ["get_setup_state"] },
    test: "integration/business-settings.integration.test.ts",
  },
  {
    id: "config.team",
    module: "Business config",
    entity: "Staff, roles & permissions, invitations, credentials, site access",
    routes: ["team", "staff"],
    // Reads landed with batch E (#883); membership create/role/permission
    // writes stay screen-owned for now — access/identity writes carry a
    // step-up policy beyond the approval queue (see the batch's commit note).
    ops: { listDetail: ["list_team_members"] },
    test: "integration/team.integration.test.ts",
  },
  {
    id: "config.branches",
    module: "Business config",
    entity: "Branches & locations",
    routes: ["branches", "locations"],
    ops: {
      // Batch E (#883) — the full branch CRUD of the locations screen,
      // reusing createBranch/updateBranch/deactivateBranch/reactivateBranch.
      listDetail: ["list_branches", "get_branch_comparison"],
      create: ["branch.create"],
      update: ["branch.update"],
      lifecycle: ["branch.lifecycle"],
    },
    test: "integration/branch-management.integration.test.ts",
  },
  {
    id: "config.integrations",
    module: "Business config",
    entity: "Integration connections & syncs (Holoo etc.)",
    routes: ["integrations/connections", "integrations/overview"],
    ops: { listDetail: ["describe_app"] },
    test: "integration/connections.integration.test.ts",
  },
  {
    id: "config.integration-hooks",
    module: "Business config",
    entity: "WooCommerce webhooks / WordPress event bridges / connections management planes (API keys, desktop, MCP, website)",
    routes: [
      "integrations/woocommerce/webhook",
      "integrations/wordpress",
      "connections",
      "connection/status",
      "host/resolve",
      "host/redirect",
      "internal/rate-limit",
      "internal/billing",
    ],
    status: "n/a (infra)",
    note: "inbound webhooks and the token-management planes of the API connector families (the panel hosts the UI); the MCP management plane itself is expressly out of scope",
  },
  {
    id: "config.ai",
    module: "Business config",
    entity: "AI config, automations, coworker jobs/templates/review, widgets, memory, conversations, research",
    routes: ["ai"],
    ops: { listDetail: ["list_coworker_jobs", "get_setup_state"] },
    test: "integration/ai-autopilot.integration.test.ts",
  },
  {
    id: "config.data",
    module: "Business config",
    entity: "Data transfer: entities, exports, imports, schedules, templates, Holoo provider",
    routes: ["data"],
    ops: {
      listDetail: ["list_data_entities", "list_export_jobs", "get_export_job", "list_import_jobs", "get_import_job", "list_data_schedules", "list_data_templates"],
      create: ["data.schedule.create", "data.template.create"],
      update: ["data.schedule.update", "data.template.update", "data.schedule.run"],
      lifecycle: ["data.schedule.delete", "data.template.delete"],
      bulk: ["data.import.run"],
    },
    note: "AP — executors re-run the route's two-key rule (engine key already the MCP capability; entity key + mapping-kind engine re-checked from the caller's membership). Export/import CREATE stay browser-bound on purpose (export streams a file download, import needs an uploaded file); Holoo provider lanes follow in their own batch",
    test: "integration/data-transfer.integration.test.ts",
  },
  {
    id: "config.backup",
    module: "Business config",
    entity: "Backup & restore (tenant scope)",
    routes: ["backup"],
    ops: {
      listDetail: ["get_backup_status"],
      create: ["backup.run_now"],
      update: ["backup.config.set"],
      lifecycle: ["backup.restore.apply"],
    },
    note: "run-now charges the wallet when the plan prices the feature (the route's own billing gate, reclaimed by the verb); restore is Owner-only whole-DB replacement on single-tenant installs, verify-only first; the bytes upload restore lane stays route-only",
    test: "integration/backup.integration.test.ts",
  },
  {
    id: "config.billing",
    module: "Business config",
    entity: "Tenant billing (plans/packages, wallet, payments)",
    routes: ["billing"],
    note: "tenant billing lanes (initiate payment → gateway redirect → verify) are browser-bound: the gateway returns a redirect the user's browser must follow, and verifyPayment expects the PSP callback params — no chat-side verb can complete the dance; wallet top-up/purchase design note stands (route-owned), see billing-service fulfilPurchasedPayment",
    test: "integration/billing.integration.test.ts",
  },
  {
    id: "config.devices",
    module: "Business config",
    entity: "Devices & printing config, pairing",
    routes: ["devices", "printing", "payment-methods"],
    ops: {
      listDetail: ["list_devices"],
      update: ["device.rename"],
      lifecycle: ["device.revoke"],
    },
    note: "device PAIRING stays route-only by design: the POST returns a plaintext device token exactly once, meant for the calling browser's local storage — a chat-initiated pair would mint an orphaned credential; printing jobs/test lanes drive physical printers on a branch's own runtime (route-owned); payment-method edits are Owner-side POS settings rides",
    test: "integration/printing.integration.test.ts",
  },
  {
    id: "config.setup-flow",
    module: "Business config",
    entity: "Onboarding wizard routes",
    routes: ["setup"],
    status: "n/a (infra)",
    note: "first-run wizard flow — UI-only; nothing to operate once a business exists",
  },

  // ============================ Knowledge / media / reports ============================
  {
    id: "media.assets",
    module: "Media",
    entity: "Media assets, folders, collections, AI transforms",
    routes: ["media"],
    // Batch I (#883): library read + single-asset detail; batch X added the
    // organisation lanes (folders/collections reads + collection CRUD,
    // membership, and the recoverable soft trash). Upload stays screen-side:
    // the upload is a presign/PUT byte flow rather than a JSON verb, the HARD
    // delete removes the storage object for good, and AI transforms cost
    // metered credits (see the ai-media endpoints).
    ops: {
      listDetail: ["list_media_assets", "get_media_asset", "list_media_collections", "list_media_folders"],
      create: ["media.collection.create"],
      update: ["media.collection.rename", "media.asset.set_collection"],
      lifecycle: ["media.collection.delete", "media.asset.trash", "media.asset.restore"],
    },
    test: "integration/media-library.integration.test.ts",
  },
  {
    id: "knowledge.articles",
    module: "Knowledge base",
    entity: "Knowledge articles & search",
    routes: ["knowledge"],
    ops: { listDetail: ["search_kb_articles", "list_kb_catalogue"] },
    note: "authoring (articles/categories/tags) lives under the platform console by design — the tenant exposes the help it reads, not the help it writes",
    test: "src/lib/knowledge.test.ts",
  },
  {
    id: "reports.reports",
    module: "Reports",
    entity: "Reports (standard, saved, export, query, drill-down, views)",
    routes: ["reports"],
    ops: {
      listDetail: ["list_reports", "run_report", "list_saved_reports"],
      create: ["report.saved.create"],
      update: ["report.saved.update"],
      lifecycle: ["report.saved.delete"],
    },
    note: "XLSX/PDF byte export stays route-only (binary payloads aren't JSON envelopes); dashboard-widget layout save stays UI-only",
    test: "integration/ledger-reports.integration.test.ts + aec-reports/industry-reports/vat-report",
  },
  {
    id: "misc.audit-orders",
    module: "Cross-cutting",
    entity: "Audit log, dashboard, commission, deliveries, couriers, business-day, business-info, bug report, industry, security, watch/sessions/rollup",
    routes: ["audit-log", "dashboard", "commission", "deliveries", "couriers", "business-day", "business-info", "bug-report", "industry", "security", "watch", "sessions", "rollup"],
    ops: { listDetail: ["get_setup_state", "describe_app", "list_audit_log"] },
    note: "small surfaces; the audit-log read mirrors the screen's validation contract (invalid cursors and filters are refused, never silently paged)",
    test: "integration/auth-account-security.integration.test.ts",
  },
  {
    id: "misc.support",
    module: "Cross-cutting",
    entity: "Support tickets (tenant side)",
    routes: ["support", "support-access"],
    status: "n/a (infra)",
  },
  {
    id: "misc.products",
    module: "Products (retail)",
    entity: "Product items, attributes, barcode templates",
    routes: ["products/items", "products/attributes", "products/barcode-templates"],
    ops: {
      listDetail: ["list_product_attributes", "list_barcode_templates"],
      create: ["product.attribute.create", "barcode.template.create"],
      update: ["product.attribute.update"],
      lifecycle: ["product.attribute.delete", "barcode.template.delete"],
    },
    note: "products/items create waits for the checkout-input normaliser (tax, barcode-conflict shape) to move out of the route body — same extraction gate as pos.orders; item reads ride list_inventory_items",
    test: "integration/generic-items.integration.test.ts",
  },
  {
    id: "misc.price-lists",
    module: "Products (retail)",
    entity: "Price lists & entries (bulk quick-update)",
    routes: ["products/price-lists"],
    ops: {
      listDetail: ["list_price_lists", "list_price_list_entries"],
      create: ["priceList.create"],
      update: ["priceList.rename", "priceList.entries.save", "priceList.quick_update"],
      lifecycle: ["priceList.delete"],
    },
    note: "entries save carries expectedVersion optimistic-lock conflicts back to the caller exactly like the screen; quick_update is always_approve (mass price mutation), everything else mode",
    test: "integration/products.integration.test.ts",
  },
  {
    id: "misc.invoices",
    module: "Sales",
    entity: "Sales invoices & voids",
    routes: ["sales"],
    ops: {
      listDetail: ["list_sales_invoices", "get_sales_invoice"],
      lifecycle: ["sales.invoice.void"],
    },
    note: "creating an invoice stays register-only: the checkout path coordinates tender queue, loyalty, COGS and outbox in the route — same registered design note as the pos.orders lane; void (the reversal mirror) is service-backed and runs under explicit approval with the service's obstacle codes (batches, dismissed sessions, fiscal locks) verbatim",
    test: "integration/retail-invoice.integration.test.ts",
  },
  {
    id: "wire.workspace-overview",
    module: "Workspace",
    entity: "Workspace dashboard, insights, lookups, reports, search",
    routes: ["workspace/dashboard", "workspace/insights", "workspace/lookups", "workspace/reports", "workspace/search"],
    ops: {
      listDetail: ["get_workspace_dashboard", "get_workspace_insights", "get_workspace_project_report"],
    },
    note: "each service derives visibility from the real member row (exactly the screens' owner shape); lookup/search picker endpoints stay route-only (they exist to feed the screens' keyboards, not a conversation)",
    test: "integration/workspace.integration.test.ts",
  },
  {
    id: "misc.sync-infra",
    module: "Cross-cutting",
    entity: "server-sync, sync, peer, pairing, v1, desktop releases/update, mcp management APIs",
    routes: ["server-sync", "sync", "peer", "pairing", "v1", "desktop-releases", "desktop-update", "mcp", "notifications/devices", "notifications/inbox", "notifications/public-key", "notifications/test", "iam", "cloud-exceptions"],
    status: "n/a (infra)",
  },
  {
    id: "misc.auth-infra",
    module: "Cross-cutting",
    entity: "tenant auth/session endpoints (login, MFA, OTP, webauthn, step-up, switch business) + OAuth discovery metadata",
    routes: ["auth", "well-known"],
    status: "n/a (infra)",
    note: "credential exchange surface — never an AI-callable verb",
  },

  // ============================ Vertical modules ============================
  {
    id: "vertical_jewelry",
    module: "Verticals",
    entity: "Jewelry (items, stones, custom orders, buy-back, layaway, consignors, prices, reports)",
    routes: ["jewelry"],
    ops: {
      listDetail: ["list_jewelry_items"],
      create: ["jewelry.item.create", "jewelry.stone.add", "jewelry.buyback.create", "jewelry.layaway.create", "jewelry.price.record", "jewelry.consignor.create"],
      update: ["jewelry.item.update", "jewelry.item.consign", "jewelry.layaway.pay"],
      lifecycle: ["jewelry.stone.delete", "jewelry.item.sell", "jewelry.layaway.complete", "jewelry.consignor.payout"],
    },
    note: "AL1 catalog + AL2 money lanes + AM directory close-out: every money verb (sale / buy-back / installment / payout / settle / gold price record) steps up on every call — the whole vertical deals in gold and cash; consignor directory is create-only in the UI too (no PATCH/DELETE routes exist), so the MCP surface matches it exactly",
    test: "integration/jewelry.integration.test.ts",
  },
  {
    id: "vertical_cosmetics",
    module: "Verticals",
    entity: "Cosmetics (rot management, suppliers, reports)",
    routes: ["cosmetics"],
    ops: {
      listDetail: ["get_near_expiry_items", "list_cosmetic_items", "list_cosmetic_brands"],
      create: ["cosmetics.brand.create", "cosmetics.item.create", "cosmetics.matrix.create", "cosmetics.batch.receive"],
      update: ["cosmetics.stock.update", "cosmetics.profile.update", "cosmetics.tester.open"],
    },
    note: "AN closes the write surface except expired-batch write-offs: those destroy value deliberately and stay in-app like inventory.waste.log (no MCP verb anywhere for value-destructive writedowns)",
    test: "integration/cosmetics.integration.test.ts",
  },
  {
    id: "vertical_haberdashery",
    module: "Verticals",
    entity: "Haberdashery (models, measurements, work orders)",
    routes: ["haberdashery"],
    ops: {
      listDetail: ["list_trade_goods_items"],
      create: ["haberdashery.item.create", "haberdashery.stock.update"],
      lifecycle: ["haberdashery.item.sell"],
    },
    note: "AO — shared trade-goods implementation (one route builder bound per namespace); sale rides ordersCreate with the ledger_account_missing envelope; variant-sales report stays report-surface only",
    test: "integration/haberdashery.integration.test.ts",
  },
  {
    id: "vertical_tools",
    module: "Verticals",
    entity: "Tools & fittings (rentals, deposits, reports)",
    routes: ["tools-fittings"],
    ops: {
      listDetail: ["list_trade_goods_items"],
      create: ["tools_fittings.item.create", "tools_fittings.stock.update"],
      lifecycle: ["tools_fittings.item.sell"],
    },
    note: "AO — shared trade-goods implementation (one route builder bound per namespace); sale rides ordersCreate with the ledger_account_missing envelope; variant-sales report stays report-surface only",
    test: "integration/tools-fittings.integration.test.ts",
  },
  {
    id: "vertical_accessories",
    module: "Verticals",
    entity: "Accessories (mobile/PC sale & repair)",
    routes: ["accessories"],
    ops: {
      listDetail: ["list_accessory_items"],
      create: ["accessories.item.create", "accessories.stock.update"],
      lifecycle: ["accessories.item.sell"],
    },
    note: "AN close-out: sale rides ordersCreate like checkout and mirrors the MissingLedgerAccountError envelope; specialized variant-sales report route stays report-surface only (no MCP analytics reads)",
    test: "integration/accessories.integration.test.ts",
  },
  {
    id: "vertical_merch",
    module: "Verticals",
    entity: "Merchandising (displays, perishables)",
    routes: ["merchandising"],
    status: "n/a (infra)",
  },
  {
    id: "vertical_wholesale",
    module: "Verticals",
    entity: "Wholesale (files, payments, reports)",
    routes: ["wholesale"],
    ops: {
      listDetail: ["list_trade_goods_items"],
      create: ["wholesale.item.create", "wholesale.stock.update"],
      lifecycle: ["wholesale.item.sell"],
    },
    note: "AO — shared trade-goods implementation (one route builder bound per namespace); sale rides ordersCreate with the ledger_account_missing envelope; variant-sales report stays report-surface only",
    test: "integration/wholesale.integration.test.ts",
  },
];

/**
 * Platform realm (pospmcp_) — the Superadmin console. `ops` cell entries are
 * names in `PLATFORM_MCP_TOOLS` (./platform-mcp.ts).
 */
export const PLATFORM_COVERAGE: CoverageEntity[] = [
  {
    id: "platform.biz-directory",
    module: "Platform — Tenants",
    entity: "Business directory (search, identity, usage, reports)",
    routes: ["platform/businesses"],
    ops: { listDetail: ["list_businesses", "get_business_identity"] },
    test: "integration/platform-mcp.integration.test.ts",
  },
  {
    id: "platform.biz-lifecycle",
    module: "Platform — Tenants",
    entity: "Tenant lifecycle (provision, status, suspend, delete)",
    routes: ["platform/businesses"],
    ops: { lifecycle: ["set_business_status"] },
    test: "integration/platform-mcp.integration.test.ts",
  },
  {
    id: "platform.biz-owner",
    module: "Platform — Tenants",
    entity: "Owner & impersonation",
    routes: ["platform/businesses", "platform/impersonation"],
    test: "integration/platform-business-management.integration.test.ts",
  },
  {
    id: "platform.biz-features",
    module: "Platform — Tenants",
    entity: "Features & app availability",
    routes: ["platform/businesses", "platform/app-availability", "platform/feature-flags"],
    ops: { listDetail: ["list_feature_flags", "list_business_features"], lifecycle: ["set_business_feature"] },
    test: "integration/platform-mcp.integration.test.ts",
  },
  {
    id: "platform.biz-devices",
    module: "Platform — Tenants",
    entity: "Tenant devices",
    routes: ["platform/businesses"],
  },
  {
    id: "platform.billing-plans",
    module: "Platform — Billing",
    entity: "Plans & packages (features, rates, settings)",
    routes: ["platform/billing/plans", "platform/billing/packages", "platform/billing/rates", "platform/billing/settings", "platform/plans"],
    test: "integration/platform-billing.integration.test.ts",
  },
  {
    id: "platform.billing-runtime",
    module: "Platform — Billing",
    entity: "Subscriptions, invoices, payments, meters, manual review, spend, credits/overrides",
    routes: ["platform/billing/subscriptions", "platform/billing/invoices", "platform/billing/payments", "platform/billing/meters", "platform/billing/manual-review", "platform/billing/spend", "platform/billing/businesses", "platform/billing/overview"],
    test: "integration/platform-billing.integration.test.ts",
  },
  {
    id: "platform.billing-config",
    module: "Platform — Billing",
    entity: "Billing config, gateway credentials, audit",
    routes: ["platform/billing/config", "platform/billing/credentials", "platform/billing/audit"],
    test: "integration/platform-billing.integration.test.ts",
  },
  {
    id: "platform.ai",
    module: "Platform — AI",
    entity: "AI config: models, gateway (LiteLLM), modes, prompts, agents, research, widgets",
    routes: ["platform/ai"],
    test: "integration/platform-ai.integration.test.ts",
  },
  {
    id: "platform.integrations",
    module: "Platform — Integrations",
    entity: "Cloud exceptions, messaging, notification/SMS config",
    routes: ["platform/cloud-exceptions", "platform/messaging", "platform/sms", "platform/mfa"],
    test: "integration/platform-cloud-exceptions.integration.test.ts",
  },
  {
    id: "platform.cms-sites",
    module: "Platform — CMS",
    entity: "CMS sites, deployments, targets, keys",
    routes: ["platform/cms/sites", "platform/cms/deploy-targets", "platform/cms/keys"],
    test: "integration/platform-cms.integration.test.ts",
  },
  {
    id: "platform.cms-ops",
    module: "Platform — CMS",
    entity: "CMS config, runs, sync, infrastructure, theme packages, self tests, billing sync",
    routes: ["platform/cms/config", "platform/cms/runs", "platform/cms/sync", "platform/cms/infrastructure", "platform/cms/theme-packages", "platform/cms/self-tests", "platform/cms/billing-sync", "platform/cms/overview"],
    test: "integration/platform-cms.integration.test.ts",
  },
  {
    id: "platform.deploy-ops",
    module: "Platform — Ops",
    entity: "Updates/releases, system, observability, overview",
    routes: ["platform/updates", "platform/system", "platform/observability", "platform/overview"],
    test: "integration/platform-admin.integration.test.ts",
  },
  {
    id: "platform.backup",
    module: "Platform — Ops",
    entity: "Backup config, run, status, peers, tokens, restore",
    routes: ["platform/backup"],
    test: "integration/platform-backup.integration.test.ts",
  },
  {
    id: "platform.security",
    module: "Platform — Security",
    entity: "Audit log, support tickets, admins, platform sessions, pairing",
    routes: ["platform/audit", "platform/support", "platform/admins", "platform/auth", "platform/pairing", "platform/bug-reports"],
    test: "integration/platform-admin.integration.test.ts",
  },
  {
    id: "platform.knowledge",
    module: "Platform — Content",
    entity: "Knowledge base (platform), media config",
    routes: ["platform/knowledge", "platform/media"],
    test: "integration/platform-knowledge.integration.test.ts",
  },
  {
    id: "platform.mcp-self",
    module: "Platform — MCP",
    entity: "MCP connections management (console UI + management API)",
    routes: ["platform/mcp-connections", "platform/mcp"],
    status: "n/a (infra)",
    note: "the management plane of this very feature; mint/list/revoke exist as HTTP+UI, not MCP verbs",
  },
  {
    id: "platform.company",
    module: "Platform — Company",
    entity: "Platform's own company surfaces (CRM, growth, workspace, websites, reports, setup)",
    routes: ["platform/company"],
    status: "n/a (infra)",
    note: "the operator-of-record business; its rows use the *tenant* suite, not the platform realm",
  },
  {
    id: "platform.cross-business",
    module: "Platform — Search & reports",
    entity: "Cross-business search/reporting",
    routes: ["platform/businesses"],
    ops: { listDetail: ["list_businesses", "get_business_identity"] },
    status: undefined,
  },
];
