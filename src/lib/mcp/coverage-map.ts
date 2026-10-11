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
    note: "list, create/edit/disable, statement, history",
    ops: { listDetail: ["list_accounts"], create: ["account.create"], update: ["account.update", "account.disable"] },
    test: "integration/ledger.integration.test.ts",
  },
  {
    id: "accounting.entries",
    module: "Accounting",
    entity: "Journal entries",
    routes: ["ledger/entries"],
    note: "list, detail, reverse (manual drafts covered by journal.manual.propose)",
    ops: { listDetail: ["list_journal_entries", "list_manual_journal_drafts"], lifecycle: ["journal.manual.propose", "journal.draft.approve", "journal.draft.reject"] },
    test: "integration/ledger.integration.test.ts",
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
    ops: { listDetail: ["list_fixed_assets"], create: ["fixed-asset.create"], lifecycle: ["fixed-asset.depreciate", "fixed-asset.dispose"] },
    test: "integration/fixed-assets.integration.test.ts",
  },
  {
    id: "accounting.payroll",
    module: "Accounting",
    entity: "Payroll (settings, staff, runs, advances)",
    routes: ["ledger/payroll"],
    ops: { listDetail: ["get_payroll_summary", "list_payroll_runs", "list_payroll_advances"], create: ["payroll.run.accrue", "payroll.advance.record"], lifecycle: ["payroll.run.pay", "payroll.run.void", "payroll.advance.void"] },
    test: "integration/payroll.integration.test.ts",
  },
  {
    id: "accounting.reconciliation",
    module: "Accounting",
    entity: "Bank reconciliation",
    routes: ["ledger/reconciliations"],
    ops: { listDetail: ["get_unreconciled_bank_lines", "list_reconciliations"], create: ["reconciliation.create"], lifecycle: ["reconciliation.complete"] },
    test: "integration/bank-reconciliation.integration.test.ts",
  },
  {
    id: "accounting.fiscal",
    module: "Accounting",
    entity: "Fiscal years & periods (open/close), readiness",
    routes: ["ledger/fiscal-years", "ledger/fiscal-periods", "ledger/fiscal-readiness"],
    ops: { listDetail: ["list_fiscal_years"] },
    test: "integration/fiscal-readiness.integration.test.ts",
  },
  {
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
    test: "integration/stock.integration.test.ts",
  },
  {
    id: "inventory.counts",
    module: "Inventory",
    entity: "Stock counts / periodic closings / visual count scans",
    routes: ["inventory/stock-counts", "inventory/periodic-closings", "inventory/visual-count-scans", "inventory/visual-profiles"],
    test: "integration/stock.integration.test.ts",
  },
  {
    id: "inventory.purchases-suppliers",
    module: "Inventory",
    entity: "Purchases, supplier returns, suppliers",
    routes: ["inventory/purchases", "inventory/supplier-returns", "inventory/suppliers"],
    ops: { listDetail: ["get_supplier_performance"], create: ["inventory.reorder.draftPO"] },
    test: "integration/purchases.integration.test.ts",
  },
  {
    id: "inventory.production",
    module: "Inventory",
    entity: "Production formulas & runs, modifier recipes",
    routes: ["inventory/production", "inventory/recipes", "inventory/modifier-recipes"],
    ops: { listDetail: ["list_formulas", "list_production_runs"], lifecycle: ["inventory.production.run"] },
    test: "integration/production.integration.test.ts",
  },
  {
    id: "inventory.barcodes",
    module: "Inventory",
    entity: "Barcodes (lookup, bulk)",
    routes: ["inventory/barcodes", "barcodes"],
    ops: { listDetail: ["list_item_barcodes", "list_items_without_barcode"], create: ["barcode.assign"] },
    test: "integration/stock.integration.test.ts",
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
    test: "integration/crm.integration.test.ts",
  },
  {
    id: "crm.cases-activities",
    module: "CRM",
    entity: "Cases & activities",
    routes: ["crm/cases", "crm/activities"],
    test: "integration/crm.integration.test.ts",
  },
  {
    id: "crm.pipelines",
    module: "CRM",
    entity: "Pipelines & stages",
    routes: ["crm/pipelines"],
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
    ops: { listDetail: ["list_crm_automations"], update: ["crm.automation.toggle"] },
    test: "integration/crm.integration.test.ts",
  },
  {
    id: "crm.overview",
    module: "CRM",
    entity: "CRM overview, members, consent state, data quality",
    routes: ["crm/overview", "crm/members", "crm/consent", "crm/quality"],
    test: "integration/crm.integration.test.ts",
  },
  {
    id: "crm.loyalty",
    module: "CRM",
    entity: "Loyalty programs, store credit, redemptions",
    routes: ["loyalty"],
    ops: { listDetail: ["get_repurchase_candidates"] },
    test: "integration/loyalty.integration.test.ts",
  },

  // ============================ Growth / marketing / messaging ============================
  {
    id: "growth.settings-campaigns",
    module: "Growth",
    entity: "Growth overview, settings, campaign audience, accounting",
    routes: ["growth"],
    ops: { listDetail: ["list_message_templates", "list_message_campaigns"] },
    test: "integration/crm.integration.test.ts",
  },
  {
    id: "growth.messaging",
    module: "Growth",
    entity: "Messaging rules & templates",
    routes: ["messaging", "notifications/rules"],
    ops: { listDetail: ["list_message_templates"], lifecycle: ["crm.customer.note"] },
    test: "integration/crm.integration.test.ts",
  },
  {
    id: "growth.promotions",
    module: "Growth",
    entity: "Promotions & gift cards (issue, expire, redeem)",
    routes: ["promotions"],
    test: "integration/giftcards.integration.test.ts",
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
    test: "integration/website.integration.test.ts",
  },
  {
    id: "cms.setup-design-domain",
    module: "Website / CMS",
    entity: "Connection, setup/build, design, domain/DNS, CDN",
    routes: ["cms/website/setup", "cms/website/connect", "cms/website/connection", "cms/website/design", "cms/website/domain", "cms/website/dns", "cms/website/cdn"],
    test: "integration/website.integration.test.ts",
  },
  {
    id: "cms.orders",
    module: "Website / CMS",
    entity: "Website orders",
    routes: ["cms/website/orders"],
    test: "integration/website.integration.test.ts",
  },
  {
    id: "cms.woocommerce",
    module: "Website / CMS",
    entity: "WooCommerce manager (posts, queue, syncs)",
    routes: ["integrations/wp-manager"],
    status: undefined,
    note: "wp-manager content/queue are covered by list_website_*; sync verbs are WP-dashboard operations, not business records",
  },

  // ============================ Projects (My Workspace) ============================
  {
    id: "workspace.projects",
    module: "Workspace",
    entity: "Projects, members, phases",
    routes: ["workspace/projects"],
    ops: { listDetail: ["get_workspace_project_status"] },
    test: "integration/workspace.integration.test.ts",
  },
  {
    id: "workspace.tasks",
    module: "Workspace",
    entity: "Tasks, checklist, dependencies",
    routes: ["workspace/tasks"],
    ops: { listDetail: ["list_workspace_tasks"] },
    test: "integration/workspace.integration.test.ts",
  },
  {
    id: "workspace.calendar-comments",
    module: "Workspace",
    entity: "Calendar, comments, documents, templates",
    routes: ["workspace/calendar", "workspace/comments", "workspace/documents", "workspace/templates"],
    test: "integration/workspace.integration.test.ts",
  },
  {
    id: "workspace.contracts",
    module: "Workspace",
    entity: "Contracts & lifecycle",
    routes: ["workspace/contracts"],
    ops: { listDetail: ["list_expiring_contracts"] },
    test: "integration/workspace.integration.test.ts",
  },
  {
    id: "workspace.approvals",
    module: "Workspace",
    entity: "Approvals",
    routes: ["workspace/approvals"],
    ops: { listDetail: ["list_workspace_approvals"] },
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
    test: "integration/data-transfer.integration.test.ts",
  },
  {
    id: "config.backup",
    module: "Business config",
    entity: "Backup & restore (tenant scope)",
    routes: ["backup"],
    test: "integration/backup.integration.test.ts",
  },
  {
    id: "config.billing",
    module: "Business config",
    entity: "Tenant billing (plans/packages, wallet, payments)",
    routes: ["billing"],
    test: "integration/billing.integration.test.ts",
  },
  {
    id: "config.devices",
    module: "Business config",
    entity: "Devices & printing config, pairing",
    routes: ["devices", "printing", "payment-methods"],
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
    test: "integration/media.integration.test.ts",
  },
  {
    id: "knowledge.articles",
    module: "Knowledge base",
    entity: "Knowledge articles & search",
    routes: ["knowledge"],
    test: "integration/knowledge.integration.test.ts",
  },
  {
    id: "reports.reports",
    module: "Reports",
    entity: "Reports (standard, saved, export, query, drill-down, views)",
    routes: ["reports"],
    ops: { listDetail: ["list_reports", "run_report"] },
    test: "integration/reports.integration.test.ts",
  },
  {
    id: "misc.audit-orders",
    module: "Cross-cutting",
    entity: "Audit log, dashboard, commission, deliveries, couriers, business-day, business-info, bug report, industry, security, watch/sessions/rollup",
    routes: ["audit-log", "dashboard", "commission", "deliveries", "couriers", "business-day", "business-info", "bug-report", "industry", "security", "watch", "sessions", "rollup"],
    ops: { listDetail: ["get_setup_state", "describe_app"] },
    note: "small surfaces; audit-log read is the audit trail",
    test: "integration/security.integration.test.ts",
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
    test: "integration/products.integration.test.ts",
  },
  {
    id: "misc.price-lists",
    module: "Products (retail)",
    entity: "Price lists & entries (bulk quick-update)",
    routes: ["products/price-lists"],
    test: "integration/products.integration.test.ts",
  },
  {
    id: "misc.invoices",
    module: "Sales",
    entity: "Sales invoices & voids",
    routes: ["sales"],
    test: "integration/sales.integration.test.ts",
  },
  {
    id: "wire.workspace-overview",
    module: "Workspace",
    entity: "Workspace dashboard, insights, lookups, reports, search",
    routes: ["workspace/dashboard", "workspace/insights", "workspace/lookups", "workspace/reports", "workspace/search"],
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
    test: "integration/jewelry.integration.test.ts",
  },
  {
    id: "vertical_cosmetics",
    module: "Verticals",
    entity: "Cosmetics (rot management, suppliers, reports)",
    routes: ["cosmetics"],
    ops: { listDetail: ["get_near_expiry_items"] },
    test: "integration/cosmetics.integration.test.ts",
  },
  {
    id: "vertical_haberdashery",
    module: "Verticals",
    entity: "Haberdashery (models, measurements, work orders)",
    routes: ["haberdashery"],
    test: "integration/haberdashery.integration.test.ts",
  },
  {
    id: "vertical_tools",
    module: "Verticals",
    entity: "Tools & fittings (rentals, deposits, reports)",
    routes: ["tools-fittings"],
    test: "integration/tools-fittings.integration.test.ts",
  },
  {
    id: "vertical_accessories",
    module: "Verticals",
    entity: "Accessories (mobile/PC sale & repair)",
    routes: ["accessories"],
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
