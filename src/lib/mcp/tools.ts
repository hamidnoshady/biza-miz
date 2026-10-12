/**
 * The tool catalogue an MCP client sees.
 *
 * The read half is **not** written here. It is the assistant's own read tools
 * (`toolDefinitions("dashboard")` in `ai.ts`, executed by `runReadTool` in
 * `ai-tools.ts`), reshaped into MCP's tool descriptor. That is the whole point:
 * a question Claude asks over MCP and the same question asked in «دستیار» must
 * be answered by the same code reading the same views, or the two surfaces
 * start disagreeing about last week's revenue — and only one of them is in the
 * room to be corrected. Adding a read tool to `ai.ts` adds it here for free.
 *
 * Two things are added on top:
 *
 *   * **An English line.** The in-app assistant is prompted in Persian and
 *     talks to a Persian owner, so its descriptions are Persian only. An MCP
 *     client may be driving a model that is reasoning in English about a
 *     Persian business, and a tool it cannot read is a tool it will not call.
 *     Each tool therefore gets one English sentence *in front of* the Persian
 *     one — never instead of it, because the Persian text carries the domain
 *     rules ("بازهٔ پیش‌فرض ۳۰ روز", "شناسه را از کاربر نپرس").
 *   * **The write half**, built from `ACTION_CATALOG` — every action that has a
 *     server-side executor and is not `coworkerOnly`. See `MCP_WRITE_TOOLS`.
 *
 * Pure. Executing a tool is `server.ts`'s job; this file only says what exists.
 */
import {
  ACTION_CATALOG,
  toolDefinitions,
  type ActionType,
  type AutopilotExecutorKey,
  type OpenAiTool,
} from "../ai";
import { aiActionPermission, canUseAiTool } from "../ai-capabilities";
import type { Permission } from "../permissions";
import {
  LEGACY_GRANTS,
  isLegacyGrants,
  mcpCanReadApp,
  mcpCanWriteApp,
  type McpGrants,
} from "./grants";
import {
  mcpBusinessWideToolAllowed,
  mcpReadRegistryEntry,
  mcpWriteRegistryEntry,
} from "./registry";
import { MCP_SCOPES, type McpScope } from "./scopes";

/** MCP's own tool descriptor. `annotations` are hints a client may show or ignore. */
export interface McpToolDescriptor {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    title: string;
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}

/** Which half of the connection a tool belongs to, and what it runs. */
export type McpToolBinding =
  | { kind: "read"; readToolName: string }
  | { kind: "write"; actionType: ActionType; executor: AutopilotExecutorKey }
  /**
   * Issue #883 §7 — asynchronous status/result retrieval: `get_write_status`
   * is served by the dispatcher itself (it answers from ai_action_audit the
   * connection's own write outcomes), not by an assistant executor, and is a
   * read-shaped tool offered only when the connection has BOTH grants, so a
   * read-only connection cannot probe write traffic.
   */
  | { kind: "status" };

export interface McpTool {
  descriptor: McpToolDescriptor;
  scope: McpScope;
  binding: McpToolBinding;
}

// ---------------------------------------------------------------------------
// Read tools
// ---------------------------------------------------------------------------

/**
 * The tools an MCP client is *not* offered, and why each one is missing.
 *
 *   * `propose_action` — the in-app confirm gate. Over MCP a write is a tool
 *     the client calls directly (see below), so a "propose" wrapper would be a
 *     second, parallel way to ask for the same change.
 *   * `draft_expense_from_receipt` — reads an image the caller attached to the
 *     current chat turn. There is no such attachment over MCP; the tool would
 *     always answer "no image".
 *   * `request_input` — the in-app structured-input protocol (Phase E). It asks
 *     the human a typed question and waits for a card to be answered; over MCP
 *     there is no card and no user to answer it, so it has no meaning.
 */
const EXCLUDED_READ_TOOLS = new Set([
  "propose_action",
  "draft_expense_from_receipt",
  "request_input",
]);

/**
 * One English sentence per read tool.
 *
 * Kept as a map rather than being folded into `ai.ts` so that the in-app
 * assistant's prompt does not grow an English half it will never use — and so
 * that `tools.test.ts` can assert this map has an entry for every tool the
 * catalogue exposes. A tool added to `ai.ts` with no entry here still works; it
 * simply arrives Persian-only, which is a degraded description rather than a
 * missing tool.
 */
export const MCP_READ_TOOL_SUMMARIES: Record<string, string> = {
  get_setup_state: "Business setup state: name, branches, preferences, costing method, tax rate, and which setup steps are still incomplete.",
  list_reports: "List the standard reports available, by key and title. Call this before run_report.",
  run_report: "Run one standard report (by key from list_reports) over an optional ISO date range and return its rows.",
  get_menu_performance: "Best- and worst-selling menu items by quantity and revenue, plus items never ordered.",
  get_void_pattern: "Voided order items broken down by item, by the employee who opened the order, and by hour of day.",
  get_stock_valuation: "Current inventory valuation per item and in total.",
  get_supplier_performance: "Supplier purchase counts, total spend, and average lead time.",
  get_reservation_conflicts: "Future active reservations that overlap on the same table.",
  get_table_turnover_rate: "Average occupancy time and revenue per table, from closed table sessions.",
  get_courier_performance: "Delivery counts, revenue, courier cost, and average delivery time per courier.",
  get_customer_profile: "One customer's contact details, order count, lifetime spend, and first/last purchase.",
  get_at_risk_customers: "Repeat customers who have not bought for a while.",
  get_ar_aging: "Accounts receivable aged by customer into current / 30 / 60 / 90+ day buckets.",
  get_ap_upcoming: "Open supplier invoices, oldest first, for payment prioritisation.",
  get_unreconciled_bank_lines: "Ledger lines in cash and bank-in-transit not yet matched in any reconciliation.",
  get_payroll_summary: "Recent payroll runs and the monthly wage total for active staff.",
  // Accounting module (issue #883 package 2, batch A).
  list_accounts: "The full chart of accounts, optionally filtered by type, text and active flag.",
  list_journal_entries: "Posted journal entries with the ledger's own filters and keyset pagination.",
  list_manual_journal_drafts: "Manual journal drafts awaiting review.",
  list_expenses: "The expense register with date/status/search filters and a cursor for the next page.",
  get_expense: "One expense with the journal lines it posted.",
  list_receipts: "Customer receipt vouchers, newest first.",
  list_payments: "Supplier payment vouchers, newest first.",
  list_cheques: "Cheques by direction (receivable/payable), live ones first by due date.",
  list_fixed_assets: "Active fixed assets with acquisition date and cost.",
  list_installment_plans: "Installment plans by direction and state, with next due dates.",
  list_fiscal_years: "Fiscal years with open/closed state.",
  list_payroll_runs: "Recent payroll runs with status.",
  list_payroll_advances: "Outstanding payroll advances per staff member.",
  list_reconciliations: "Bank reconciliations by account, with line-clearing progress.",
  list_orders: "Orders of one branch, newest first, filtered by status.",
  get_order: "One order with its items, totals, payments and table.",
  list_shifts: "Staff shifts with per-shift cash summaries — the leader's register view.",
  get_menu_tree: "Categories and items of one branch's menu — the full tree, prices included.",
  list_formulas: "Production formulas (recipes) of one branch.",
  list_production_runs: "Production runs of one branch, newest first.",
  list_item_barcodes: "Barcodes assigned to a warehouse item.",
  list_items_without_barcode: "Warehouse items of one branch that have no scannable barcode yet.",
  list_customer_notes: "One customer's notes — pinned first, then newest.",
  list_crm_activities: "CRM activities (calls/meetings/tasks), filterable by customer or open state.",
  list_crm_automations: "CRM automation rules — trigger, action and on/off state.",
  list_branches: "The business's branches — id, name, colour, timezone.",
  list_team_members: "Staff members — name, role, active state, branch access.",
  list_promotions: "Active promotions — kind, value and active window.",
  get_gift_card_status: "One gift card's balance and issue/redeem history by code.",
  list_stock_counts: "One branch's stock counts, newest first — lines, shortage/surplus value.",
  get_stock_count: "One stock count's line-level detail.",
  list_suppliers: "The business's suppliers, paginated — same service the directory screen uses.",
  list_workspace_projects: "The business's workspace projects — status, priority, owner, tags.",
  get_workspace_dashboard: "Workspace home: today's/overdue/upcoming tasks and slipping projects (local day window).",
  get_workspace_insights: "Workspace insight cards: slipping projects, overloaded members, blocked contracts, bottlenecks.",
  get_workspace_project_report: "Per-project workspace report: progress, open/done tasks, delays (financials per access).",
  list_workspace_templates: "Workspace project templates (keys for project.create with templateKey).",
  list_workspace_calendar: "Workspace calendar events between two dates (task dates and contracts included in-range).",
  list_workspace_comments: "Comment thread of one workspace subject (access resolved from the subject, not the request).",
  list_workspace_documents: "Workspace documents with project/task/contract/party/status filters and pagination.",
  get_workspace_document: "One workspace document in full, optionally with the whole revision chain.",
  search_kb_articles: "Full-text search of the member knowledge centre (titles + summaries).",
  list_media_assets: "The business's media library, searchable, newest first.",
  get_media_asset: "One media asset's detail record by id.",
  list_saved_reports: "Standard and custom saved reports with their full configs.",
  list_crm_cases: "CRM support cases with status/priority/assignee/customer filters (openOnly, breachedOnly, unowned).",

  list_inventory_transfers: "Cross-branch inventory transfers with source/destination names and status.",
  list_warehouse_documents: "Warehouse receipt/issue documents, filterable by kind and location.",

  list_price_lists: "Price lists of a branch (names, currencies, order).",
  list_price_list_entries: "Every price-list cell of a branch with optimistic-lock versions.",
  list_crm_deals: "CRM deals filtered by stage/pipeline/owner/customer/value — the kanban cards.",
  list_crm_leads: "CRM leads with status/owner/rating/source filters and pagination.",
  list_crm_pipelines: "Sales pipelines with their stages, including stage ids for deal writes.",
  get_crm_overview: "The CRM dashboard: counts, pipeline, cases, 30-day trends vs prior period.",
  get_crm_data_quality: "CRM data-quality groups — missing contact fields, suspected duplicates with samples.",
  list_crm_members: "Assignable CRM members (owner/assignee ids for CRM writes).",
  get_crm_queue: "One CRM work-queue definition and its filters by key.",
  get_vat_liability: "Output VAT against input VAT and the net position for a period.",
  get_branch_comparison: "Per-branch order count, revenue, and estimated labour cost.",
  forecast_demand: "A simple demand estimate from the last 28 days' average. Always an estimate, never a promise.",
  get_near_expiry_items: "Cosmetics batches approaching their expiry date (cosmetics businesses only).",
  get_staff_commission: "Sales commission accrued per employee.",
  get_repurchase_candidates: "Customers due to buy again, based on their recorded repurchase interval.",
  run_accounting_review: "A deterministic audit of the books: unbalanced entries, unposted stock events, settled sales with no entry, missing account headings, stale drafts, till variances, overdue cheques and receivables, negative stock, unclosed periods. Rule-based, never a model's opinion.",
  find_items: "Resolve a partial Persian item name to its id, unit, branch, current stock, unit cost and active/disabled status. Use this instead of ever asking the user for an id.",
  get_waste_history: "Recorded waste by item and reason, with quantity, occurrences, date range and cost.",
  describe_app: "What this installation is: the trade, its branches, which modules and features it has, the words it uses for things, and what you are able to do here. Call this first when you are unsure whether a part of the app exists for this business.",
  list_coworker_jobs: "The standing «همکار هوشمند» jobs this business has defined, and how many runs are waiting for approval.",
  // Phase 36 — the CRM's read tools. `find_customers` is the id-resolution
  // entry point for people, exactly as `find_items` is for products.
  find_customers: "Resolve a partial name, phone number or email to a customer id, with their order count, lifetime spend, tags and whether the record is active, archived or merged into another. Use this instead of ever asking the user for a customer id.",
  get_customer_timeline: "One customer's full file: purchase summary, loyalty points, lifecycle stage, contact-consent state, and their recent events (orders, payments, tickets, notes) newest first.",
  list_customer_segments: "Saved customer segments with their member counts and a plain-Persian description of each segment's rules.",
  preview_customer_segment: "Count and sample a segment definition without saving it. With purpose 'sms' or 'email' only customers who have granted that permission are counted; the unfiltered total is returned alongside so the gap can be reported.",
  // Phase 38 — the website manager's reads.
  list_website_posts: "The business's website posts (drafts and published) with id, title, status and dates. Get a post id here before editing it.",
  list_website_products: "Products on the business's website with remote id, title, SKU, price in integer Rial and the site's stock figure.",
  get_website_status: "Whether a website is connected, its domain, the last connection test, the price/stock push switches and the sync queue counts (pending / failed / dead).",
  list_cms_pages: "The site's pages with publish status (publish stays human-confirmed, off-MCP).",
  list_cms_media: "The site's media library (urls + dimensions for featuredImageId).",
  list_sales_invoices: "Retail sales invoices of the branch with status, tenders and totals (search by invoice number; page with page/pageSize).",
  get_sales_invoice: "One retail invoice in full detail (lines, tenders, void state).",
  list_wp_queue: "The WooCommerce sync queue — pending/failed/dead outbox jobs (stock, prices, products, orders) plus failed inbound events.",
  get_wp_queue_summary: "Queue counters for one connected shop.",
  get_wp_overview: "The WooCommerce manager dashboard counts.",
  get_website_dns: "DNS status of the site's domain (records, nameservers, verification).",
  get_website_cdn: "CDN status of the site (cache mode, purge state).",
  list_kb_catalogue: "The product help catalogue — categories and articles with slugs for citation.",
  list_product_attributes: "The branch's product attribute definitions (e.g. colour → red, blue).",
  list_audit_log: "The business audit trail (who changed what, filtered by entity/action/actor; cursor with before).",
  get_account_statement: "One ledger account's statement (running balance over an optional ISO range).",
  get_fiscal_readiness: "Fiscal-year close readiness (open temporary balances, unlocked periods, remaining steps).",
  list_media_collections: "The media library's collections with file counts.",
  list_media_folders: "The media library's folders with file counts.",
  list_barcode_templates: "The branch's weight-barcode templates (prefix + weight unit).",
  // Phase C — the messaging reads that feed the campaign-create action.
  list_message_templates: "Saved message templates by id, channel (sms/email), name and body. Get a template id here before creating a campaign.",
  list_message_campaigns: "The business's message campaigns (draft, sending, done) with id, name, channel, status and recipient / sent / delivered / failed counts.",
  // Phase G — «میز کار من». These four answer over the workspace module, and
  // each one needs a caller identity: `callTool` passes the connection's
  // authorizing user, and where a connection has none the tool declines rather
  // than widening "mine" to "everybody" (see `runReadTool`'s actorUserId).
  get_workspace_project_status: "One project's status in full: phase progress, task counts by status, overdue tasks, team members and their roles, contracts, pending approvals, and budget against spend taken from the accounting ledger. Name the project in plain words — an ambiguous name comes back as a candidate list rather than a guess.",
  list_workspace_tasks: "Workspace tasks filtered by project, assignee, status, priority or due date. Pass mine:true for the calling user's own tasks; that resolves from the connection's identity, never from a name in the request.",
  list_expiring_contracts: "Project-execution contracts (contractor, supplier, consultant, subcontractor, vendor) expiring within a window of days, with counterparty, value in integer Rial, project and days remaining. Relationship contracts live on the CRM customer file and are not returned here.",
  list_workspace_approvals: "Pending and recently decided workspace approvals with subject (project, task, document or contract), requester, approver, due date and decision. Pass mine:true for approvals waiting on the calling user.",
  // Issue #799 §23 — the AEC reads. Architecture/engineering/construction
  // businesses only; the executor refuses another industry with a sentence.
  get_aec_project_financial_health: "One construction project's commercial position: budget, ledger-posted cost, contract value, open and overdue work, late phases, and planned versus reported physical progress. Architecture/engineering/construction businesses only.",
  list_delayed_project_activities: "What is late: open workspace tasks past their due date (whole business, or one named project) and overdue phases, with assignee, priority and days late. Architecture/engineering/construction businesses only.",
  get_boq_variance: "One construction project's approved BOQ estimate against the actual cost posted in Accounting, with the remaining amount and a per-chapter breakdown. Actual cost is read from the ledger, never recomputed. Architecture/engineering/construction businesses with estimating enabled only.",
  get_latest_drawing_revision: "The current revision of each drawing and document in one project or across the business, optionally filtered by discipline or a search term: document number, title, revision code, status (draft/issued/superseded), issue purpose and date. Read from the drawing register. Architecture/engineering/construction businesses with document control enabled only.",
  list_pending_rfis: "RFIs still unanswered — open RFIs past their due date first, then those due later, with number, subject, discipline, responsible party, assigned person, due date and how many days late. Optionally one project, or a window in days. Architecture/engineering/construction businesses only.",
  list_site_issues: "Open site and quality items: inspections, NCRs, corrective actions, snags and HSE observations that are not closed, most severe first, with number, kind, title, severity, status, assignee, responsible party, due date and how many days late. Optionally one project, a kind, a severity, or overdue only. Architecture/engineering/construction businesses with quality control enabled only.",
  list_change_orders: "One construction project's variations and change orders: number, description, source, status (draft/priced/submitted/under_review/approved/rejected/implemented/cancelled), estimated amount, cost impact, submitted and approved amounts, schedule impact and dates. Amounts are agreed, not paid — payments live in Accounting. Architecture/engineering/construction businesses with the variations capability enabled only.",
  list_payment_certificates: "One construction project's progress claims and payment certificates: number, kind (contractor application or employer/consultant certificate), measurement period, progress percent, gross, advance recovery, retention, other deductions, tax, net, certified amount and date, previous certified and the contract's remaining amount. Certified means certified, not collected. Architecture/engineering/construction businesses with progress claims enabled only.",
  list_project_commercial_risks: "One construction project's commercial position and risks in a single answer: original and revised contract value, approved variations, certified amounts, remaining commitment, retention receivable and payable, advance and its recovery, budget, approved estimate, actual cost from the accounting ledger, open change orders, uncertified claims, certified claims whose receipt should be checked in Accounting, and guarantees/insurance approaching expiry. Accounting figures are returned separately and no profit margin is invented. Architecture/engineering/construction businesses with project financials enabled only.",
  list_procurement_delays: "Purchase orders and subcontracts past their expected delivery date — optional one project and a minimum number of days late — with supplier, value, expected date and days late, plus material requests still waiting on approval. Also reports committed and delivered cost and the cost-to-complete forecast when the ledger and the approved estimate are both available; committed means promised, not posted to Accounting. Architecture/engineering/construction businesses with procurement enabled only.",
  list_upcoming_milestones: "Dated things coming up in an architecture/engineering/construction business — phase end dates, open task due dates and project end dates inside the next N days (default 30), soonest first, with the project, the days remaining and how much of a phase is done. The forward-looking counterpart of list_delayed_project_activities. AEC businesses only.",
  list_pending_submittals: "Submittals waiting on a reviewer: submitted or under review, overdue first, with number, title, submission type, revision number, reviewer, due date and days late. Optionally one project, or a window in days. Architecture/engineering/construction businesses with document control enabled only.",
};

function readDescriptor(tool: OpenAiTool): McpToolDescriptor {
  const english = MCP_READ_TOOL_SUMMARIES[tool.function.name];
  return {
    name: tool.function.name,
    title: tool.function.name,
    description: english ? `${english}\n\n${tool.function.description}` : tool.function.description,
    inputSchema: tool.function.parameters,
    annotations: {
      title: tool.function.name,
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  };
}

/**
 * Every read tool, in `ai.ts`'s own order.
 *
 * Dashboard mode with no attachment: the widest read surface the app has, which
 * is what a connector granted `pos.read` is for. Floor mode's narrower set is
 * about a waiter's tablet in a room, and has no meaning here.
 */
export function mcpReadTools(): McpTool[] {
  return toolDefinitions("dashboard")
    .filter((tool) => !EXCLUDED_READ_TOOLS.has(tool.function.name))
    .map((tool) => ({
      descriptor: readDescriptor(tool),
      scope: MCP_SCOPES.read,
      binding: { kind: "read", readToolName: tool.function.name } as const,
    }));
}

// ---------------------------------------------------------------------------
// Write tools
// ---------------------------------------------------------------------------

interface WriteToolSpec {
  name: string;
  actionType: ActionType;
  english: string;
  /** JSON Schema for the action's payload — the typed form of ACTION_CATALOG's `payloadHint`. */
  inputSchema: Record<string, unknown>;
  /** True where applying it cannot be undone in one click; surfaced as MCP's destructiveHint. */
  destructive: boolean;
}

const money = (description: string) => ({ type: "integer", description });
const id = (description: string) => ({ type: "string", description });

/**
 * The writes an MCP connection may perform.
 *
 * The list is not chosen freely — it is exactly the `ACTION_CATALOG` entries
 * with a server-side `executor`, minus the `coworkerOnly` ones, and
 * `assertWriteToolsMatchCatalogue` (called from the test) fails if it drifts
 * from that. Three consequences worth stating, because each one is a decision
 * some future change will want to undo:
 *
 *   * **No new mutation path.** Every tool here runs the same executor a
 *     coworker job runs, which calls the same service function the route
 *     handler calls. There is no MCP-specific write anywhere in this codebase.
 *   * **`inventory.waste.log` is absent**, and must stay absent. Phase 31 kept
 *     waste out of autopilot because "why did this stock leave" is a fact only
 *     a person in the room has; Phase 32 let a *coworker job* log it because
 *     the owner supplied that fact in advance. A model in a chat window has
 *     supplied nothing, so it is back to the Phase 31 position.
 *   * **Actions with no executor are absent** — the setup-wizard six, the live
 *     floor five (reservations, tables, courier), and Phase 38's
 *     `website.post.publish`. Their absence is not an omission to
 *     fix by writing an executor: each was left without one deliberately (see
 *     their entries in `ai.ts`). Publishing in particular is the moment a text
 *     becomes public under the business's name; an MCP client may draft it,
 *     and a person clicks publish.
 */
const WRITE_TOOL_SPECS: WriteToolSpec[] = [
  {
    name: "write_menu_item_price",
    actionType: "menu.item.priceUpdate",
    english: "Change one menu item's price. Amount is an integer in Rial (not Toman).",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        menuItemId: id("شناسهٔ آیتم منو — از find_items بگیر، هرگز از کاربر نپرس"),
        price: money("قیمت جدید، ریال صحیح (تومان × ۱۰)"),
      },
      required: ["menuItemId", "price"],
      additionalProperties: false,
    },
  },
  {
    name: "write_menu_item_availability",
    actionType: "menu.item.disable",
    english: "Turn one menu item off (or back on) — e.g. when it is out of stock.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        menuItemId: id("شناسهٔ آیتم منو — از find_items بگیر"),
        isActive: { type: "boolean", description: "false یعنی غیرفعال شود؛ true یعنی دوباره فعال شود" },
      },
      required: ["menuItemId", "isActive"],
      additionalProperties: false,
    },
  },
  {
    name: "write_order_discount",
    actionType: "order.discount.apply",
    english: "Apply a discount to an order that is still open. Refused once the bill is settled.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        orderId: id("شناسهٔ سفارش باز"),
        discount: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["percent", "amount"], description: "درصدی یا مبلغ ثابت" },
            value: { type: "number", description: "درصد ۰..۱۰۰، یا مبلغ ریال صحیح" },
          },
          required: ["type", "value"],
          additionalProperties: false,
        },
      },
      required: ["orderId", "discount"],
      additionalProperties: false,
    },
  },
  {
    name: "write_purchase_draft",
    actionType: "inventory.reorder.draftPO",
    english:
      "Create a DRAFT purchase order. A draft moves no stock and posts nothing to the ledger until a human receives it.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        supplierId: id("شناسهٔ تأمین‌کننده، اختیاری"),
        note: { type: "string", description: "یادداشت، اختیاری" },
        items: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              inventoryItemId: id("شناسهٔ کالای انبار — از find_items بگیر"),
              purchaseQty: { type: "string", description: "مقدار در واحد خرید، به‌صورت رشته (اعشار دقیق)" },
              totalCost: { type: "string", description: "مبلغ کل ریال، به‌صورت رشته" },
            },
            required: ["inventoryItemId", "purchaseQty", "totalCost"],
            additionalProperties: false,
          },
        },
      },
      required: ["items"],
      additionalProperties: false,
    },
  },
  {
    name: "write_stock_count",
    actionType: "inventory.adjustment.propose",
    english:
      "Record a physical stock count. Quantities are what was COUNTED, not a delta; the adjustment and its ledger posting are derived.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        note: { type: "string", description: "یادداشت شمارش، اختیاری" },
        lines: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              inventoryItemId: id("شناسهٔ کالای انبار — از find_items بگیر"),
              countedQty: { type: "string", description: "مقدار شمارش‌شدهٔ واقعی، به‌صورت رشته" },
            },
            required: ["inventoryItemId", "countedQty"],
            additionalProperties: false,
          },
        },
      },
      required: ["lines"],
      additionalProperties: false,
    },
  },
  {
    name: "write_customer_note",
    actionType: "customer.note.add",
    english:
      "Replace a customer's internal notes. This overwrites the field, so read get_customer_profile first and send the combined text. Internal only — nothing is sent to the customer.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        customerId: id("شناسهٔ مشتری"),
        notes: { type: "string", description: "کل متن یادداشت‌ها — جایگزین متن قبلی می‌شود" },
      },
      required: ["customerId", "notes"],
      additionalProperties: false,
    },
  },
  // Phase 36. Prefer `write_crm_customer_note` over `write_customer_note`
  // above: the older one replaces a single free-text field (which is why its
  // description has to warn about overwriting), whereas this one appends a
  // dated, attributed row that cannot destroy what someone else wrote.
  {
    name: "write_crm_customer_note",
    actionType: "crm.customer.note",
    english:
      "Append a dated, attributed note to a customer's CRM file. Only ever inserts — it cannot overwrite an existing note. Internal only; nothing is sent to the customer.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        customerId: id("شناسهٔ مشتری — از find_customers بگیر"),
        body: { type: "string", description: "متن یادداشت" },
        isPinned: { type: "boolean", description: "بالای پرونده سنجاق شود، اختیاری" },
      },
      required: ["customerId", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "write_crm_customer_tag",
    actionType: "crm.customer.tag",
    english:
      "Add or remove ONE tag on a customer. The other tags are untouched, so this can never clobber a label someone else applied.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        customerId: id("شناسهٔ مشتری — از find_customers بگیر"),
        tag: { type: "string", description: "یک برچسب" },
        action: { type: "string", enum: ["add", "remove"], description: "افزودن یا برداشتن" },
      },
      required: ["customerId", "tag", "action"],
      additionalProperties: false,
    },
  },
  {
    name: "write_journal_draft",
    actionType: "journal.manual.propose",
    english:
      "Draft a manual journal entry. Debits must equal credits. It is only ever a DRAFT — posting it to the ledger needs separate human approval, by design.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        entryDate: { type: "string", description: "تاریخ سند (ISO)، پیش‌فرض امروزِ کسب‌وکار" },
        memo: { type: "string", description: "شرح سند" },
        lines: {
          type: "array",
          minItems: 2,
          items: {
            type: "object",
            properties: {
              accountId: id("شناسهٔ حساب"),
              debit: money("بدهکار، ریال صحیح"),
              credit: money("بستانکار، ریال صحیح"),
            },
            required: ["accountId"],
            additionalProperties: false,
          },
        },
      },
      required: ["memo", "lines"],
      additionalProperties: false,
    },
  },
  {
    name: "write_expense",
    actionType: "expense.categorize",
    english:
      "Record and categorise an expense. This posts to the ledger immediately and has NO one-click undo — correct a mistake with a reversing entry.",
    destructive: true,
    inputSchema: {
      type: "object",
      properties: {
        accountId: id("حساب هزینه (کد ۵۲۰۰ تا ۵۹۰۰)"),
        paymentAccountId: id("حساب پرداخت: صندوق یا بانک"),
        amount: money("مبلغ، ریال صحیح"),
        expenseDate: { type: "string", description: "تاریخ (ISO)، پیش‌فرض امروزِ کسب‌وکار" },
        vendor: { type: "string", description: "نام فروشنده، اختیاری" },
        memo: { type: "string", description: "شرح هزینه" },
      },
      required: ["accountId", "paymentAccountId", "amount", "memo"],
      additionalProperties: false,
    },
  },
  {
    name: "write_production_run",
    actionType: "inventory.production.run",
    english:
      "Record an in-house production run against a formula: consumes the raw materials and receives the produced good at cost.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        formulaId: id("شناسهٔ فرمول تولید"),
        batches: { type: "string", description: "تعداد بچ، به‌صورت رشته" },
        outputQuantity: { type: "string", description: "مقدار واقعی تولیدشده، اختیاری" },
        note: { type: "string", description: "یادداشت، اختیاری" },
      },
      required: ["formulaId", "batches"],
      additionalProperties: false,
    },
  },
  // Phase 38 — the website's drafting writes. Note what is NOT here:
  // `website.post.publish`. See the header comment.
  {
    name: "write_website_post_draft",
    actionType: "website.post.draft",
    english:
      "Create a DRAFT post on the business's website. Body is Markdown. It is never published by this tool — a person publishes from the dashboard. Use only real data from the read tools; never invent prices or figures.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "عنوان مطلب" },
        body: { type: "string", description: "متن مطلب (Markdown)" },
        excerpt: { type: "string", description: "خلاصهٔ کوتاه، اختیاری" },
      },
      required: ["title", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "write_website_post_update",
    actionType: "website.post.update",
    english:
      "Edit a website post's title, body (Markdown) or excerpt. Cannot change whether it is published. Get the post id from list_website_posts.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        postId: id("شناسهٔ مطلب — از list_website_posts"),
        title: { type: "string", description: "عنوان تازه، اختیاری" },
        body: { type: "string", description: "متن تازه (Markdown)، اختیاری" },
        excerpt: { type: "string", description: "خلاصهٔ تازه، اختیاری" },
      },
      required: ["postId"],
      additionalProperties: false,
    },
  },
  {
    name: "write_website_product",
    actionType: "website.product.upsert",
    english:
      "Create or update a product on the business's website. Price is an integer in Rial; the adapter converts to the site's unit. Give remoteId (from list_website_products) to update, omit it to create.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        remoteId: id("شناسهٔ محصول در سایت — خالی یعنی محصول جدید"),
        title: { type: "string", description: "عنوان محصول" },
        sku: { type: "string", description: "کد کالا، اختیاری" },
        summary: { type: "string", description: "توضیح کوتاه، اختیاری" },
        priceRial: money("قیمت، ریال صحیح"),
        stock: { type: "integer", description: "موجودی سایت، اختیاری" },
      },
      required: ["title", "priceRial"],
      additionalProperties: false,
    },
  },
  // ── Accounting module writes (issue #883 package 2, batch A) ──────────────
  // Money-shaped ones are approval-queue-only (the registry says so); the
  // schema is the UI form's own field vocabulary so the same payload works
  // against the route and against this tool.
  {
    name: "write_account_create",
    actionType: "account.create",
    english: "Create a new ledger account (chart of accounts).",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "کد ۲ تا ۱۰ رقمی لاتین، منحصربه‌فرد در این نمودار" },
        name: { type: "string", description: "نام سرفصل" },
        type: { type: "string", enum: ["asset", "liability", "equity", "revenue", "expense"] },
        parentId: id("شناسهٔ سرفصل والد، اختیاری"),
        isContra: { type: "boolean", description: "حساب کاهنده باشد؟" },
      },
      required: ["code", "name", "type"],
      additionalProperties: false,
    },
  },
  {
    name: "write_account_update",
    actionType: "account.update",
    english: "Rename or reparent a ledger account.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        accountId: id("شناسهٔ سرفصل — از list_accounts"),
        name: { type: "string", description: "نام جدید، اختیاری" },
        parentId: { anyOf: [{ type: "string" }, { type: "null" }], description: "والد جدید یا null برای قطع اتصال، اختیاری" },
      },
      required: ["accountId"],
      additionalProperties: false,
    },
  },
  {
    name: "write_account_disable",
    actionType: "account.disable",
    english: "Deactivate (or reactivate) a ledger account.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        accountId: id("شناسهٔ سرفصل — از list_accounts"),
        isActive: { type: "boolean", description: "پیش‌فرض false یعنی غیرفعال" },
      },
      required: ["accountId"],
      additionalProperties: false,
    },
  },
  {
    name: "write_journal_draft_approve",
    actionType: "journal.draft.approve",
    english: "Approve a manual journal draft — posts it to the ledger.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: { draftId: id("شناسهٔ پیش‌نویس — از list_manual_journal_drafts") },
      required: ["draftId"],
      additionalProperties: false,
    },
  },
  {
    name: "write_journal_draft_reject",
    actionType: "journal.draft.reject",
    english: "Reject a manual journal draft with a reason.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        draftId: id("شناسهٔ پیش‌نویس"),
        reason: { type: "string", description: "دلیل رد (الزامی)" },
      },
      required: ["draftId", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "write_expense_reverse",
    actionType: "expense.reverse",
    english: "Reverse a posted expense (mirrored reversal entry).",
    destructive: true,
    inputSchema: {
      type: "object",
      properties: {
        expenseId: id("شناسهٔ هزینه — از list_expenses"),
        reversalDate: { type: "string", description: "تاریخ برگشت (ISO)، اختیاری" },
        memo: { type: "string", description: "شرح برگشت، اختیاری" },
      },
      required: ["expenseId"],
      additionalProperties: false,
    },
  },
  {
    name: "write_ar_receipt_record",
    actionType: "ar.receipt.record",
    english: "Record a receipt from a customer (posts cash/bank vs receivable).",
    destructive: true,
    inputSchema: {
      type: "object",
      properties: {
        customerId: id("شناسهٔ مشتری — از find_customers"),
        amount: money("مبلغ، ریال صحیح مثبت"),
        method: { type: "string", enum: ["cash", "bank"], description: "پیش‌فرض cash" },
        receiptDate: { type: "string", description: "ISO — پیش‌فرض امروزِ کسب‌وکار" },
        cashAccountId: id("حساب مقصد، اختیاری"),
        bankReference: { type: "string", description: "شمارهٔ پیگیری بانکی، اختیاری" },
        locationId: id("شعبه، اختیاری"),
        memo: { type: "string" },
      },
      required: ["customerId", "amount"],
      additionalProperties: false,
    },
  },
  {
    name: "write_ap_payment_record",
    actionType: "ap.payment.record",
    english: "Record a payment to a supplier (posts cash/bank vs payable).",
    destructive: true,
    inputSchema: {
      type: "object",
      properties: {
        supplierId: id("شناسهٔ تأمین‌کننده"),
        amount: money("مبلغ، ریال صحیح مثبت"),
        method: { type: "string", enum: ["cash", "bank"] },
        paymentDate: { type: "string" },
        cashAccountId: id("حساب مبدأ، اختیاری"),
        bankReference: { type: "string" },
        locationId: id("شعبه، اختیاری"),
        memo: { type: "string" },
        clientRequestId: { type: "string", description: "کلید وضعیت ژنی — تکرار با همان کلید پرداخت دوم نمی‌سازد" },
      },
      required: ["supplierId", "amount"],
      additionalProperties: false,
    },
  },
  {
    name: "write_ap_payment_reverse",
    actionType: "ap.payment.reverse",
    english: "Reverse a supplier payment.",
    destructive: true,
    inputSchema: {
      type: "object",
      properties: {
        paymentId: id("شناسهٔ پرداخت"),
        reversalDate: { type: "string" },
        memo: { type: "string" },
      },
      required: ["paymentId"],
      additionalProperties: false,
    },
  },
  {
    name: "write_cheque_create",
    actionType: "cheque.create",
    english: "Register a new cheque (receivable or payable).",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["receivable", "payable"] },
        serialNumber: { type: "string" },
        bankName: { type: "string" },
        amount: money("مبلغ، ریال صحیح مثبت"),
        dueDate: { type: "string", description: "تاریخ سررسید (ISO) — الزامی" },
        counterpartyName: { type: "string", description: "نام طرف حساب — الزامی" },
        sayadId: { type: "string" },
        accountNumber: { type: "string" },
        issueDate: { type: "string" },
        customerId: id("فقط receivable"),
        supplierId: id("فقط payable"),
        locationId: id("شعبه"),
        memo: { type: "string" },
      },
      required: ["direction", "serialNumber", "bankName", "amount", "dueDate", "counterpartyName"],
      additionalProperties: false,
    },
  },
  {
    name: "write_cheque_transition",
    actionType: "cheque.transition",
    english: "Move a cheque along its state machine (deposit/endorse/clear/bounce/present/cancel).",
    destructive: true,
    inputSchema: {
      type: "object",
      properties: {
        chequeId: id("شناسهٔ چک — از list_cheques"),
        action: { type: "string", enum: ["deposit", "endorse", "clear", "bounce", "present", "cancel"] },
        endorsedToSupplierId: id("فقط برای endorse — تأمین‌کنندهٔ گیرنده"),
        occurredOn: { type: "string", description: "تاریخ رویداد (ISO)، پیش‌فرض امروز" },
        memo: { type: "string" },
      },
      required: ["chequeId", "action"],
      additionalProperties: false,
    },
  },
  {
    name: "write_installment_plan_create",
    actionType: "installment.plan.create",
    english: "Create an installment plan for a customer (receivable) or supplier (payable).",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["receivable", "payable"] },
        partyId: id("شناسهٔ طرف حساب (مشتری یا تأمین‌کننده)"),
        principal: money("اصل مبلغ، ریال صحیح"),
        installmentCount: { type: "integer", description: "تعداد اقساط" },
        firstDueDate: { type: "string", description: "سررسید اول ،YYYY-MM-DD" },
        intervalMonths: { type: "integer", description: "فاصلهٔ اقساط به ماه، پیش‌فرض ۱" },
        downPayment: money("پیش‌پرداخت، اختیاری"),
        interestPercent: { type: "number" },
        lateFeePercent: { type: "number" },
        note: { type: "string" },
        locationId: id("شعبه"),
      },
      required: ["direction", "partyId", "principal", "installmentCount", "firstDueDate"],
      additionalProperties: false,
    },
  },
  {
    name: "write_installment_item_pay",
    actionType: "installment.item.pay",
    english: "Settle one installment line (posts the receipt/payment).",
    destructive: true,
    inputSchema: {
      type: "object",
      properties: {
        planId: id("شناسهٔ طرح"),
        itemId: id("شناسهٔ قسط"),
        method: { type: "string", enum: ["cash", "bank"] },
        memo: { type: "string" },
      },
      required: ["planId", "itemId"],
      additionalProperties: false,
    },
  },
  {
    name: "write_reconciliation_create",
    actionType: "reconciliation.create",
    english: "Start a bank reconciliation against a statement's closing balance.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        accountCode: { type: "string", enum: ["cash", "bank", "bankClearing"] },
        statementDate: { type: "string", description: "YYYY-MM-DD" },
        statementBalance: money("ماندهٔ بسته‌شدن صورتحساب، ریال صحیح"),
      },
      required: ["accountCode", "statementDate", "statementBalance"],
      additionalProperties: false,
    },
  },
  {
    name: "write_reconciliation_complete",
    actionType: "reconciliation.complete",
    english: "Complete a bank reconciliation (locks the confirmed rows).",
    destructive: true,
    inputSchema: {
      type: "object",
      properties: { reconciliationId: id("شناسهٔ مغایرت‌گیری — از list_reconciliations") },
      required: ["reconciliationId"],
      additionalProperties: false,
    },
  },
  {
    name: "write_payroll_run_accrue",
    actionType: "payroll.run.accrue",
    english: "Accrue one Jalali month's payroll (builds the run from wages/commission).",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        periodKey: { type: "string", description: "دورهٔ حقوق به شمسی، مثل «1403-05»" },
        accrualDate: { type: "string" },
        overtime: { type: "object", additionalProperties: { type: "number" }, description: "اضافه‌کاری هر کارمند به ریال" },
        idempotencyKey: { type: "string" },
      },
      required: ["periodKey"],
      additionalProperties: false,
    },
  },
  {
    name: "write_payroll_run_pay",
    actionType: "payroll.run.pay",
    english: "Pay a payroll run — posts the wage outflow.",
    destructive: true,
    inputSchema: {
      type: "object",
      properties: {
        runId: id("شناسهٔ اجرا — از list_payroll_runs"),
        method: { type: "string", enum: ["cash", "bank"] },
        paymentAccountId: id("حساب پرداخت، اختیاری"),
        paidDate: { type: "string" },
      },
      required: ["runId"],
      additionalProperties: false,
    },
  },
  {
    name: "write_payroll_run_void",
    actionType: "payroll.run.void",
    english: "Void a payroll run (releases its claims and advance deductions).",
    destructive: true,
    inputSchema: {
      type: "object",
      properties: { runId: id("شناسهٔ اجرا") },
      required: ["runId"],
      additionalProperties: false,
    },
  },
  {
    name: "write_payroll_advance_record",
    actionType: "payroll.advance.record",
    english: "Record a payroll advance for a staff member.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        userId: id("شناسهٔ کارمند"),
        amount: money("مبلغ، ریال صحیح مثبت"),
        method: { type: "string", enum: ["cash", "bank"] },
        paymentAccountId: id("حساب پرداخت"),
        advanceDate: { type: "string" },
        note: { type: "string" },
      },
      required: ["userId", "amount"],
      additionalProperties: false,
    },
  },
  {
    name: "write_payroll_advance_void",
    actionType: "payroll.advance.void",
    english: "Void a recorded payroll advance.",
    destructive: true,
    inputSchema: {
      type: "object",
      properties: { advanceId: id("شناسهٔ مساعده — از list_payroll_advances") },
      required: ["advanceId"],
      additionalProperties: false,
    },
  },
  {
    name: "write_fixed_asset_create",
    actionType: "fixed-asset.create",
    english: "Register a fixed asset (creates the depreciation schedule).",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        acquisitionDate: { type: "string", description: "YYYY-MM-DD" },
        cost: money("بهای تمام‌شده، ریال صحیح"),
        usefulLifeMonths: { type: "integer" },
        salvageValue: money("ارزش اسقاط، پیش‌فرض ۰"),
        inServiceDate: { type: "string" },
        locationId: id("شعبه"),
      },
      required: ["name", "acquisitionDate", "cost", "usefulLifeMonths"],
      additionalProperties: false,
    },
  },
  {
    name: "write_fixed_asset_depreciate",
    actionType: "fixed-asset.depreciate",
    english: "Post one period's depreciation for a fixed asset.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        fixedAssetId: id("شناسهٔ دارایی — از list_fixed_assets"),
        periodKey: { type: "string" },
        periodLabel: { type: "string" },
        entryDate: { type: "string" },
      },
      required: ["fixedAssetId"],
      additionalProperties: false,
    },
  },
  {
    name: "write_order_create",
    actionType: "order.create",
    english: "Open a new order at one branch (idempotency-keyed; opens stock/ledger effects but never settles the bill).",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        locationId: id("شناسهٔ شعبه، خالی یعنی شعبهٔ پیش‌فرض"),
        orderType: { type: "string", enum: ["dine_in", "takeaway", "delivery"], description: "نوع سفارش، پیش‌فرض takeaway" },
        items: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              menuItemId: id("شناسهٔ آیتم منو — از find_items بگیر"),
              quantity: { type: "integer", description: "تعداد — صفر یا منفی ممنوع" },
              note: { type: "string", description: "یادداشت آیتم، اختیاری" },
            },
            required: ["menuItemId", "quantity"],
            additionalProperties: false,
          },
        },
        note: { type: "string", description: "یادداشت سفارش، اختیاری" },
        customerId: id("شناسهٔ مشتری — از find_customers، اختیاری"),
        tableId: id("شناسهٔ میز، اختیاری"),
        clientOrderId: id("کلید ایمن تکرار — حداکثر یک بار ارسال شود؛ ارسال مجدد همان کلید همات سفارش را برمی‌گرداند"),
      },
      required: ["orderType", "items"],
      additionalProperties: false,
    },
  },
  {
    name: "write_shift_start",
    actionType: "shift.start",
    english: "Clock in — open a shift for the member who authorized this connection.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        openingFloat: money("صندوق آغاز شیفت به ریال، اختیاری"),
        locationId: id("شناسهٔ شعبه، اختیاری"),
      },
      additionalProperties: false,
    },
  },
  {
    name: "write_shift_end",
    actionType: "shift.end",
    english: "Clock out — end the connection's own open shift.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: { closingFloat: money("شمارش پایان شیفت به ریال، اختیاری") },
      additionalProperties: false,
    },
  },
  {
    name: "write_shift_close",
    actionType: "shift.close",
    english: "Force-close a shift an employee left open (manager action).",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        shiftId: id("شناسهٔ شیفت — از list_shifts"),
        closingFloat: money("شمارش نقدی به ریال، اختیاری"),
      },
      required: ["shiftId"],
      additionalProperties: false,
    },
  },
  {
    name: "write_menu_category_create",
    actionType: "menu.category.create",
    english: "Create a menu category at one branch.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        locationId: id("شناسهٔ شعبه؛ خالی فقط اگر اتصال به همان شعبه پین شده"),
        name: { type: "string", description: "نام دستهٔ منو — یکتا در همان شعبه" },
        taxRate: { type: "number", description: "نرخ مالیات درصدی — خالی یعنی نرخ پیش‌فرض کسب‌وکار" },
        sortOrder: { type: "number", description: "ترتیب نمایش در کارت منو" },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "write_menu_category_update",
    actionType: "menu.category.update",
    english: "Rename/reprice-tax/activate-toggle a menu category.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        categoryId: id("شناسهٔ دستهٔ منو — از get_menu_tree"),
        name: { type: "string", description: "نام جدید" },
        taxRate: { type: "number" },
        sortOrder: { type: "number" },
        isActive: { type: "boolean", description: "false یعنی دسته از منو پنهان می‌شود" },
      },
      required: ["categoryId"],
      additionalProperties: false,
    },
  },
  {
    name: "write_menu_item_create",
    actionType: "menu.item.create",
    english: "Add an item to a menu category — its price flows into every later invoice.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        categoryId: id("شناسهٔ دستهٔ منو — از get_menu_tree"),
        name: { type: "string" },
        price: money("قیمت به ریال"),
        sku: { type: "string", description: "کد کالای اختیاری" },
        description: { type: "string" },
        sortOrder: { type: "number" },
      },
      required: ["categoryId", "name", "price"],
      additionalProperties: false,
    },
  },
  {
    name: "write_menu_item_update",
    actionType: "menu.item.update",
    english: "Reprice or rename a menu item, or hide it from the floor.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        menuItemId: id("شناسهٔ آیتم — از find_items یا get_menu_tree"),
        name: { type: "string" },
        price: money("قیمت جدید به ریال"),
        sku: { type: "string" },
        description: { type: "string" },
        isActive: { type: "boolean" },
      },
      required: ["menuItemId"],
      additionalProperties: false,
    },
  },
  {
    name: "write_barcode_assign",
    actionType: "barcode.assign",
    english: "Assign (or auto-mint) a scannable barcode to a warehouse item.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        inventoryItemId: id("شناسهٔ کالای انبار — از find_items در مد inventory"),
        code: { type: "string", description: "صریح؛ خالی یعنی سیستم یک کد قابل‌اسکن می‌سازد" },
        symbology: {
          type: "string",
          enum: ["EAN13", "UPC", "internal"],
          description: "نویسهٔ بارکد؛ «internal» یعنی کد داخلیِ مینت‌شده — خالی یعنی تشخیص خودکار",
        },
        note: { type: "string" },
      },
      required: ["inventoryItemId"],
      additionalProperties: false,
    },
  },
  {
    name: "write_party_customer_create",
    actionType: "party.customer.create",
    english: "Create a customer record (identity + contact only, no accounting fields).",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "نام نمایشی مشتری" },
        phone: { type: "string" },
        email: { type: "string" },
        address: { type: "string" },
        notes: { type: "string" },
        birthday: { type: "string", description: "YYYY-MM-DD" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "write_party_supplier_create",
    actionType: "party.supplier.create",
    english: "Create a supplier record (identity + contact only, no accounting fields).",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "نام نمایشی تأمین‌کننده" },
        phone: { type: "string" },
        email: { type: "string" },
        address: { type: "string" },
        notes: { type: "string" },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "write_project_create",
    actionType: "project.create",
    english: "Create a workspace project (optionally from a template).",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        status: { type: "string", enum: ["planning", "active", "paused", "completed", "cancelled"] },
        priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
        startDate: { type: "string", description: "ISO date" },
        endDate: { type: "string", description: "ISO date — قبل از شروع نباشد" },
        tags: { type: "array", items: { type: "string" } },
        ownerUserId: id("شناسهٔ مدیر پروژه — از list_team_members"),
        partyId: id("شناسهٔ شخص مرتبط، اختیاری"),
        budgetRial: money("بودجه به ریال"),
        templateKey: { type: "string", description: "کلید قالب فضای کاری — فازها از آن ساخته می‌شوند" },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "write_project_update",
    actionType: "project.update",
    english: "Edit one project's name/status/priority/schedule/tags.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        projectId: id("شناسهٔ پروژه — از list_workspace_projects"),
        name: { type: "string" },
        description: { type: "string" },
        status: { type: "string", enum: ["planning", "active", "paused", "completed", "cancelled"] },
        priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
        startDate: { type: "string" },
        endDate: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["projectId"],
      additionalProperties: false,
    },
  },
  {
    name: "write_task_create",
    actionType: "task.create",
    english: "Add a task to a project.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        projectId: id("شناسهٔ پروژه — از list_workspace_projects"),
        title: { type: "string" },
        description: { type: "string" },
        assigneeUserId: id("شناسهٔ مسئول — از list_team_members"),
        priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
        dueDate: { type: "string", description: "ISO date" },
        phaseId: id("شناسهٔ مرحله از پروژه"),
      },
      required: ["projectId", "title"],
      additionalProperties: false,
    },
  },
  {
    name: "write_task_update",
    actionType: "task.update",
    english: "Edit a task's title/description/assignee/due-date/phase/priority.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        taskId: id("شناسهٔ تَسک — از list_workspace_tasks"),
        title: { type: "string" },
        description: { type: "string" },
        assigneeUserId: { type: ["string", "null"], description: "شناسهٔ مسئول؛ null یعنی بی‌مسئول کردن" },
        dueDate: { type: ["string", "null"], description: "ISO date؛ null یعنی برداشتن سررسید" },
        phaseId: { type: ["string", "null"] },
        priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
      },
      required: ["taskId"],
      additionalProperties: false,
    },
  },
  {
    name: "write_task_status",
    actionType: "task.status",
    english: "Move a task between open / in_progress / blocked / done.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        taskId: id("شناسهٔ تَسک — از list_workspace_tasks"),
        status: { type: "string", enum: ["open", "in_progress", "blocked", "done"] },
      },
      required: ["taskId", "status"],
      additionalProperties: false,
    },
  },
  {
    name: "write_production_formula_create",
    actionType: "production.formula.create",
    english: "Create a production formula shell (raw-material lines added one by one after).",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        outputInventoryItemId: id("کالای خروجی — از list_inventory_items؛ با ساخت فرمول is_produced می‌شود"),
        outputQuantity: { type: "string", description: "بازدهٔ یک بَچ — عددی اعشاری به‌صورت متن مثل «12.5»" },
        conversionCostRial: { type: "string", description: "هزینهٔ تبدیل به ریال — عدد صحیح به‌صورت متن؛ پیش‌فرض 0" },
        notes: { type: "string" },
      },
      required: ["name", "outputInventoryItemId", "outputQuantity"],
      additionalProperties: false,
    },
  },
  {
    name: "write_production_formula_update",
    actionType: "production.formula.update",
    english: "Edit a production formula (name, yield, conversion cost, notes, active flag).",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        formulaId: id("از list_production_formulas"),
        name: { type: "string" },
        outputQuantity: { type: "string" },
        conversionCostRial: { type: "string" },
        notes: { type: ["string", "null"] },
        isActive: { type: "boolean" },
      },
      required: ["formulaId"],
      additionalProperties: false,
    },
  },
  {
    name: "write_production_formula_deactivate",
    actionType: "production.formula.deactivate",
    english: "Deactivate a formula (past runs are kept — the screen's delete button).",
    destructive: true,
    inputSchema: {
      type: "object",
      properties: { formulaId: id("از list_production_formulas") },
      required: ["formulaId"],
      additionalProperties: false,
    },
  },
  {
    name: "write_production_formulainput_set",
    actionType: "production.formulaInput.set",
    english: "Add or change one raw-material line of a formula (cycle-checked like the screen).",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        formulaId: id("از list_production_formulas"),
        inventoryItemId: id("مادهٔ اولیه — از list_inventory_items"),
        quantity: { type: "string", description: "مقدار به‌صورت متن اعشاری" },
      },
      required: ["formulaId", "inventoryItemId", "quantity"],
      additionalProperties: false,
    },
  },
  {
    name: "write_production_formulainput_delete",
    actionType: "production.formulaInput.delete",
    english: "Remove one raw-material line from a formula.",
    destructive: true,
    inputSchema: {
      type: "object",
      properties: {
        formulaId: id("از list_production_formulas"),
        inventoryItemId: id("مادهٔ اولیه"),
      },
      required: ["formulaId", "inventoryItemId"],
      additionalProperties: false,
    },
  },
  {
    name: "write_workspace_document_create",
    actionType: "workspace.document.create",
    english: "Create a workspace document (supersedesId makes it the next revision of that document).",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        status: { type: "string", enum: ["draft", "in_review", "approved", "rejected", "archived"] },
        projectId: { type: ["string", "null"] },
        taskId: { type: ["string", "null"] },
        contractId: { type: ["string", "null"] },
        partyId: { type: ["string", "null"] },
        journalEntryId: { type: ["string", "null"] },
        mediaAssetId: { type: ["string", "null"] },
        tags: { type: "array", items: { type: "string" } },
        supersedesId: { type: ["string", "null"], description: "نسخهٔ قبلی — از list_workspace_documents" },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "write_workspace_document_update",
    actionType: "workspace.document.update",
    english: "Edit a workspace document.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        documentId: id("از list_workspace_documents"),
        title: { type: "string" },
        description: { type: "string" },
        status: { type: "string", enum: ["draft", "in_review", "approved", "rejected", "archived"] },
        projectId: { type: ["string", "null"] },
        taskId: { type: ["string", "null"] },
        contractId: { type: ["string", "null"] },
        partyId: { type: ["string", "null"] },
        journalEntryId: { type: ["string", "null"] },
        mediaAssetId: { type: ["string", "null"] },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["documentId"],
      additionalProperties: false,
    },
  },
  {
    name: "write_workspace_document_delete",
    actionType: "workspace.document.delete",
    english: "Delete a workspace document.",
    destructive: true,
    inputSchema: {
      type: "object",
      properties: { documentId: id("از list_workspace_documents") },
      required: ["documentId"],
      additionalProperties: false,
    },
  },
  {
    name: "write_workspace_template_save",
    actionType: "workspace.template.save",
    english: "Create or overwrite a workspace project template (passing an existing key rewrites it).",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        key: { type: "string", description: "برای بازنویسی قالب موجود؛ وگرنه از نام ساخته می‌شود" },
        description: { type: "string" },
        projectType: { type: ["string", "null"] },
        phases: { type: "array", items: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false } },
        defaultTasks: { type: "array", items: { type: "object", additionalProperties: true } },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "write_workspace_template_archive",
    actionType: "workspace.template.archive",
    english: "Archive a workspace project template.",
    destructive: true,
    inputSchema: {
      type: "object",
      properties: { templateKey: { type: "string", description: "از list_workspace_templates" } },
      required: ["templateKey"],
      additionalProperties: false,
    },
  },
  {
    name: "write_workspace_event_create",
    actionType: "workspace.event.create",
    english: "Add an event to the workspace calendar.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        kind: { type: "string", enum: ["meeting", "milestone", "reminder", "site_visit", "other"] },
        eventDate: { type: "string", description: "ISO date — لازم" },
        startTime: { type: ["string", "null"] },
        endTime: { type: ["string", "null"] },
        location: { type: "string" },
        description: { type: "string" },
        projectId: { type: ["string", "null"], description: "از list_workspace_projects" },
        taskId: { type: ["string", "null"], description: "از list_workspace_tasks" },
      },
      required: ["title", "eventDate"],
      additionalProperties: false,
    },
  },
  {
    name: "write_workspace_event_update",
    actionType: "workspace.event.update",
    english: "Edit a workspace calendar event.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        eventId: id("از list_workspace_calendar"),
        title: { type: "string" },
        kind: { type: "string", enum: ["meeting", "milestone", "reminder", "site_visit", "other"] },
        eventDate: { type: "string" },
        startTime: { type: ["string", "null"] },
        endTime: { type: ["string", "null"] },
        location: { type: "string" },
        description: { type: "string" },
        projectId: { type: ["string", "null"] },
      },
      required: ["eventId"],
      additionalProperties: false,
    },
  },
  {
    name: "write_workspace_event_delete",
    actionType: "workspace.event.delete",
    english: "Delete a workspace calendar event.",
    destructive: true,
    inputSchema: {
      type: "object",
      properties: { eventId: id("از list_workspace_calendar") },
      required: ["eventId"],
      additionalProperties: false,
    },
  },
  {
    name: "write_workspace_comment_add",
    actionType: "workspace.comment.add",
    english: "Append a comment to a workspace subject (project/task/document/contract/estimate_version/submittal_revision).",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        subjectType: {
          type: "string",
          enum: ["project", "task", "document", "contract", "estimate_version", "submittal_revision"],
        },
        subjectId: id("از فهرست همان سوژه"),
        body: { type: "string" },
      },
      required: ["subjectType", "subjectId", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "write_pricelist_create",
    actionType: "priceList.create",
    english: "Create a price list for the branch.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        currency: { type: "string", description: "پیش‌فرض IRR" },
        locationId: id("اگر شعبهٔ پین/فعال غلط است"),
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "write_pricelist_rename",
    actionType: "priceList.rename",
    english: "Rename one price list.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        priceListId: id("از list_price_lists"),
        name: { type: "string" },
      },
      required: ["priceListId", "name"],
      additionalProperties: false,
    },
  },
  {
    name: "write_pricelist_delete",
    actionType: "priceList.delete",
    english: "Delete one price list with all its prices.",
    destructive: true,
    inputSchema: {
      type: "object",
      properties: { priceListId: id("از list_price_lists") },
      required: ["priceListId"],
      additionalProperties: false,
    },
  },
  {
    name: "write_pricelist_entries_save",
    actionType: "priceList.entries.save",
    english: "Save price cells with expected versions (the price screen's save — conflict reports come back like the screen shows).",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        updates: {
          type: "array",
          items: {
            type: "object",
            properties: {
              priceListId: id("از list_price_lists"),
              itemId: id("از list_menu_items"),
              price: { type: ["number", "null"], description: "ریال — null یعنی حذف قیمت این سلول" },
              expectedVersion: { type: "string", description: "version از list_price_list_entries" },
            },
            required: ["priceListId", "itemId", "price"],
            additionalProperties: false,
          },
        },
      },
      required: ["updates"],
      additionalProperties: false,
    },
  },
  {
    name: "write_pricelist_quick_update",
    actionType: "priceList.quick_update",
    english: "Bulk raise/lower prices by percent or amount, optionally rounded — the screen's quick-update column.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "object",
          additionalProperties: true,
          description: '{ kind: "sale" } | { kind: "purchase" } | { kind: "list", priceListId: "…" }',
        },
        mode: { type: "string", enum: ["percent", "amount"] },
        value: { type: "number", description: "percent: مثبت یا منفی — amount: ریالِ اضافه‌شده به هر واحد" },
        round: { type: "boolean", description: "گرد به هزار تومان" },
        itemIds: { type: "array", items: { type: "string" }, description: "خالی = همهٔ اقلام شعبه" },
      },
      required: ["target", "mode", "value", "round"],
      additionalProperties: false,
    },
  },
  {
    name: "write_messaging_template_save",
    actionType: "messaging.template.save",
    english: "Save a message template (sms|email) — unknown variables are refused; nothing is sent.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", enum: ["sms", "email"] },
        name: { type: "string", description: "نام قالب" },
        body: { type: "string", description: "متن با متغیرهای شناخته‌شده — مثل {{customer_name}}" },
        subject: { type: "string", description: "فقط برای email" },
      },
      required: ["channel", "name", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "write_messaging_campaign_pause",
    actionType: "messaging.campaign.pause",
    english: "Pause a sending campaign (protective — sends stop).",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: { campaignId: id("شناسهٔ کمپین — از list_message_campaigns") },
      required: ["campaignId"],
      additionalProperties: false,
    },
  },
  {
    name: "write_messaging_campaign_resume",
    actionType: "messaging.campaign.resume",
    english: "Resume a paused campaign — back onto mass delivery; always asks a human first.",
    destructive: true,
    inputSchema: {
      type: "object",
      properties: { campaignId: id("شناسهٔ کمپین — از list_message_campaigns") },
      required: ["campaignId"],
      additionalProperties: false,
    },
  },
  {
    name: "write_messaging_campaign_launch",
    actionType: "messaging.campaign.launch",
    english:
      "Launch a campaign to every recipient in its segment — mass outbound, with optional wallet credit/discount code attached; always asks a human first.",
    destructive: true,
    inputSchema: {
      type: "object",
      properties: {
        campaignId: id("شناسهٔ کمپین — از list_message_campaigns"),
        creditRial: { type: "number", description: "اعتبار کیف پول برای هر گیرنده — ریال صحیح" },
        discountCode: { type: "string" },
      },
      required: ["campaignId"],
      additionalProperties: false,
    },
  },
  {
    name: "write_inventory_count_edit",
    actionType: "inventory.count.edit",
    english:
      "Correct a posted stock count — reverses its posted lines then re-records the edited ones in the same transaction.",
    destructive: true,
    inputSchema: {
      type: "object",
      properties: {
        countId: id("شناسهٔ شمارش — از list_stock_counts"),
        note: { type: "string" },
        lines: {
          type: "array",
          items: {
            type: "object",
            properties: {
              inventoryItemId: id("کد قلم — از list_inventory_items"),
              countedQty: { type: "string", description: "مقدار شمارش‌شدهٔ واقعی" },
            },
            required: ["inventoryItemId", "countedQty"],
            additionalProperties: false,
          },
        },
      },
      required: ["countId"],
      additionalProperties: false,
    },
  },
  {
    name: "write_inventory_count_reverse",
    actionType: "inventory.count.reverse",
    english:
      "Reverse a posted stock count in full — stock returns and its ledger entries are mirrored. Explicit approval each time.",
    destructive: true,
    inputSchema: {
      type: "object",
      properties: { countId: id("شناسهٔ شمارش — از list_stock_counts") },
      required: ["countId"],
      additionalProperties: false,
    },
  },
  {
    name: "write_journal_entry_reverse",
    actionType: "journal.entry.reverse",
    english:
      "Reverse a posted manual entry — a new mirrored entry dated today (original untouched). Explicit approval each time.",
    destructive: true,
    inputSchema: {
      type: "object",
      properties: {
        entryId: id("شناسهٔ سند دستی — از list_journal_entries"),
        memo: { type: "string", description: "یادداشت سند برگشتی — کوتاه" },
        entryDate: { type: "string", description: "YYYY-MM-DD — پیش‌فرض امروز شعبه" },
        locationId: id("شعبهٔ اختصاری — فقط وقتی سند اصلی شعبه ندارد"),
      },
      required: ["entryId"],
      additionalProperties: false,
    },
  },
  {
    name: "write_fiscal_year_create",
    actionType: "fiscal.year.create",
    english: "Create a fiscal year with its twelve monthly periods — calendar, no postings. Explicit approval each time.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: { jy: { type: "number", description: "سال جلالی — مثل ۱۴۰۴" } },
      required: ["jy"],
      additionalProperties: false,
    },
  },
  {
    name: "write_fiscal_period_set_status",
    actionType: "fiscal.period.set_status",
    english:
      "Set a fiscal period's status — open / soft_closed / locked. Reopening lets postings back into a closed period; explicit approval each time.",
    destructive: true,
    inputSchema: {
      type: "object",
      properties: {
        periodId: id("شناسهٔ دوره — از list_fiscal_years/دوره‌های سال"),
        status: { type: "string", enum: ["open", "soft_closed", "locked"] },
      },
      required: ["periodId", "status"],
      additionalProperties: false,
    },
  },
  {
    name: "write_fiscal_year_close",
    actionType: "fiscal.year.close",
    english:
      "Lock a fiscal year for good — closing entries are built under the year lock; unwind only from the admin console. Explicit approval each time.",
    destructive: true,
    inputSchema: {
      type: "object",
      properties: { fiscalYearId: id("شناسهٔ سال مالی — از list_fiscal_years") },
      required: ["fiscalYearId"],
      additionalProperties: false,
    },
  },
  {
    name: "write_reconciliation_line_clear",
    actionType: "reconciliation.line.clear",
    english:
      "Clear or un-clear journal lines against an in-progress reconciliation (single or batch; a malformed batch is refused whole).",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        reconciliationId: id("شناسهٔ مغایرت‌گیری در جریان — از list_reconciliations"),
        cleared: { type: "boolean", description: "true=علامت بزن، false=علامت را بردار" },
        journalLineId: id("تک‌سطری — یکی از get_unreconciled_bank_lines"),
        journalLineIds: { type: "array", items: { type: "string" }, description: "حالت دسته‌ای — در تقدم بر journalLineId" },
      },
      required: ["reconciliationId", "cleared"],
      additionalProperties: false,
    },
  },
  {
    name: "write_payroll_settings_update",
    actionType: "payroll.settings.update",
    english: "Update payroll settings — the calculator's basis for every future run. Always asks a human first.",
    destructive: true,
    inputSchema: {
      type: "object",
      properties: {
        settings: { type: "object", description: "همان JSON تنظیمات حقوق که فرم صفحه می‌فرستد" },
      },
      required: ["settings"],
      additionalProperties: false,
    },
  },
  {
    name: "write_payroll_staff_terms",
    actionType: "payroll.staff.terms",
    english:
      "Change one staff member's pay terms (monthly wage / allowances / fixed deduction, integer Rial). Always asks a human first.",
    destructive: true,
    inputSchema: {
      type: "object",
      properties: {
        userId: id("شناسهٔ پرسنل"),
        terms: {
          type: "object",
          description: "حداقل یکی: monthlyWage، taxableAllowance، nonTaxableAllowance، fixedDeduction — ریال صحیح؛ monthlyWage=null پاک می‌کند",
          properties: {
            monthlyWage: { type: "number" },
            taxableAllowance: { type: "number" },
            nonTaxableAllowance: { type: "number" },
            fixedDeduction: { type: "number" },
          },
          additionalProperties: false,
        },
      },
      required: ["userId", "terms"],
      additionalProperties: false,
    },
  },
  {
    name: "write_fixed_asset_set_acquisition",
    actionType: "fixed-asset.set_acquisition",
    english: "Set a fixed asset's acquisition source and (optionally) its source purchase entry.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        fixedAssetId: id("شناسهٔ دارایی — از list_fixed_assets"),
        acquisitionSource: { type: "string", description: "منشأ تملیک — از مقادیر پذیرفته‌شدهٔ ثبت دارایی" },
        acquisitionEntryId: id("شناسهٔ سند خرید — اختیاری"),
      },
      required: ["fixedAssetId", "acquisitionSource"],
      additionalProperties: false,
    },
  },
  {
    name: "write_account_delete",
    actionType: "account.delete",
    english:
      "Delete a chart account — refused when posted/drafted/children/well-known; safe to re-add otherwise.",
    destructive: true,
    inputSchema: {
      type: "object",
      properties: { accountId: id("شناسهٔ حساب — از list_accounts") },
      required: ["accountId"],
      additionalProperties: false,
    },
  },
  {
    name: "write_media_collection_create",
    actionType: "media.collection.create",
    english: "Create a media collection (a grouping only; no file moves).",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "نام مجموعه" },
        description: { type: "string" },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "write_media_collection_rename",
    actionType: "media.collection.rename",
    english: "Rename a media collection (optionally its description).",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        collectionId: id("شناسهٔ مجموعه — از list_media_collections"),
        name: { type: "string" },
        description: { type: "string", description: "اگر حذف شود، توضیح فعلی حفظ می‌شود" },
      },
      required: ["collectionId", "name"],
      additionalProperties: false,
    },
  },
  {
    name: "write_media_collection_delete",
    actionType: "media.collection.delete",
    english: "Delete a media collection — the files themselves are untouched.",
    destructive: true,
    inputSchema: {
      type: "object",
      properties: { collectionId: id("شناسهٔ مجموعه") },
      required: ["collectionId"],
      additionalProperties: false,
    },
  },
  {
    name: "write_media_asset_set_collection",
    actionType: "media.asset.set_collection",
    english: "Add a file to a collection or remove it from one.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        assetId: id("شناسهٔ فایل — از list_media_assets"),
        collectionId: id("شناسهٔ مجموعه"),
        action: { type: "string", enum: ["add", "remove"] },
      },
      required: ["assetId", "collectionId", "action"],
      additionalProperties: false,
    },
  },
  {
    name: "write_media_asset_trash",
    actionType: "media.asset.trash",
    english: "Move a media file to the library trash (recoverable; it disappears from menus/site while trashed).",
    destructive: true,
    inputSchema: {
      type: "object",
      properties: { assetId: id("شناسهٔ فایل") },
      required: ["assetId"],
      additionalProperties: false,
    },
  },
  {
    name: "write_media_asset_restore",
    actionType: "media.asset.restore",
    english: "Restore a file from the media trash.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: { assetId: id("شناسهٔ فایل") },
      required: ["assetId"],
      additionalProperties: false,
    },
  },
  {
    name: "write_product_attribute_create",
    actionType: "product.attribute.create",
    english: "Create one product attribute with its options (no item is touched).",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "نام ویژگی — مثل «برند»" },
        options: { type: "array", items: { type: "string" }, description: "مقادیر قابل‌انتخاب" },
        isActive: { type: "boolean", description: "پیش‌فرض فعال" },
        locationId: id("شعبه — اگر پین شعبه دیگری است؛ پیش‌فرض پین"),
      },
      required: ["name", "options"],
      additionalProperties: false,
    },
  },
  {
    name: "write_barcode_template_create",
    actionType: "barcode.template.create",
    english: "Create one weight-barcode template (two-digit prefix + weight unit).",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        prefix: { type: "string", description: "پیشوند دو رقمی — مثل ۲۱" },
        weightUnit: { type: "string", enum: ["kilograms", "grams"] },
        locationId: id("شعبه — اگر پین شعبه دیگری است؛ پیش‌فرض پین"),
      },
      required: ["prefix", "weightUnit"],
      additionalProperties: false,
    },
  },
  {
    name: "write_website_domain_set",
    actionType: "website.domain.set",
    english: "Change the live site's domain — the public identity of the shop; old links break.",
    destructive: true,
    inputSchema: {
      type: "object",
      properties: {
        domain: {
          type: "string",
          description: "دامنهٔ کامل بدون پروتکل — مثل shop.example.com",
        },
      },
      required: ["domain"],
      additionalProperties: false,
    },
  },
  {
    name: "write_wp_queue_retry",
    actionType: "wp.queue.retry",
    english: "Retry one sync-queue row (outbox or inbox) — resends data already approved once.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        queueRowId: id("شناسهٔ ردیف صف — از list_wp_queue"),
        connectionId: id("اگر بیش از یک فروشگاه وصل است"),
        direction: { type: "string", enum: ["out", "in"], description: "پیش‌فرض خروجی ثم ورودی" },
      },
      required: ["queueRowId"],
      additionalProperties: false,
    },
  },
  {
    name: "write_wp_queue_retry_all_failed",
    actionType: "wp.queue.retry_all_failed",
    english: "Retry every failed/dead queue row for one shop (no new data moves to the site).",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: { connectionId: id("اگر بیش از یک فروشگاه وصل است") },
      additionalProperties: false,
    },
  },
  {
    name: "write_wp_queue_flush",
    actionType: "wp.queue.flush",
    english: "Push the pending outbox to the shop now (RPC for plugin links, drain for REST).",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: { connectionId: id("اگر بیش از یک فروشگاه وصل است") },
      additionalProperties: false,
    },
  },
  {
    name: "write_website_order_status",
    actionType: "website.order.status",
    english:
      "Change a website order's status (pending/paid/cancelled/refunded) — visible money state on the connected site; always asks a human first.",
    destructive: true,
    inputSchema: {
      type: "object",
      properties: {
        orderId: id("شناسهٔ سفارش سایت — از فهرست سفارش‌های خود سایت"),
        status: {
          type: "string",
          enum: ["pending", "paid", "cancelled", "refunded"],
          description: "وضعیت مقصد — همان چهار مقدار پذیرفتهٔ CMS",
        },
      },
      required: ["orderId", "status"],
      additionalProperties: false,
    },
  },
  {
    name: "write_sales_invoice_void",
    actionType: "sales.invoice.void",
    english:
      "Void a settled retail invoice — reverses its postings, stock and loyalty. Always asks a human first; the reason is mandatory.",
    destructive: true,
    inputSchema: {
      type: "object",
      properties: {
        invoiceId: id("شناسهٔ فاکتور — از list_sales_invoices"),
        reason: {
          type: "string",
          description: "دلیل ابطال — الزامی، حداقل ۳ و حداکثر ۵۰۰ نویسه",
          minLength: 3,
          maxLength: 500,
        },
        locationId: id("شعبهٔ فاکتور — اگر پین شعبه دیگری است؛ پیش‌فرض پین"),
      },
      required: ["invoiceId", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "write_transfer_create",
    actionType: "transfer.create",
    english: "Create a draft cross-branch inventory transfer (ship/receive/cancel follow).",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        destinationLocationId: id("شعبهٔ مقصد — از list_branches"),
        locationId: id("شعبهٔ مبدأ — اگر شعبهٔ فعال/پین غلط است؛ پیش‌فرض پین"),
        note: { type: "string" },
        idempotencyKey: { type: "string", description: "کلید تکرارناپذیری لازم — مثل فرم صفحه" },
        lines: {
          type: "array",
          items: {
            type: "object",
            properties: {
              sourceInventoryItemId: id("کد خزانهٔ مبدأ — از list_inventory_items"),
              destinationInventoryItemId: id("کد خزانهٔ مقصد — از list_inventory_items"),
              quantity: { type: "string", description: "مقدار به‌صورت متن اعشاری" },
            },
            required: ["sourceInventoryItemId", "destinationInventoryItemId", "quantity"],
            additionalProperties: false,
          },
        },
      },
      required: ["destinationLocationId", "lines", "idempotencyKey"],
      additionalProperties: false,
    },
  },
  {
    name: "write_transfer_ship",
    actionType: "transfer.ship",
    english: "Ship a draft transfer (exact-cost withdrawal at the source branch).",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: { transferId: id("از list_inventory_transfers — باید draft باشد") },
      required: ["transferId"],
      additionalProperties: false,
    },
  },
  {
    name: "write_transfer_receive",
    actionType: "transfer.receive",
    english: "Receive a shipped transfer at the destination (carried cost).",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: { transferId: id("وضعیت باید shipped باشد") },
      required: ["transferId"],
      additionalProperties: false,
    },
  },
  {
    name: "write_transfer_cancel",
    actionType: "transfer.cancel",
    english: "Cancel a draft or shipped transfer (received ones need a reverse transfer, exactly like the screen).",
    destructive: true,
    inputSchema: {
      type: "object",
      properties: { transferId: id("draft یا shipped") },
      required: ["transferId"],
      additionalProperties: false,
    },
  },
  {
    name: "write_warehouse_document_create",
    actionType: "warehouseDocument.create",
    english: "Post a warehouse receipt/issue document (stock moves immediately, exactly like the screen).",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["receipt", "issue"] },
        locationId: id("شعبه — اگر پین غلط است"),
        supplierId: id("از list_suppliers — برای رسید"),
        recipient: { type: "string", description: "گیرندهٔ صدور" },
        documentNumber: { type: "string" },
        note: { type: "string" },
        lines: {
          type: "array",
          items: {
            type: "object",
            properties: {
              inventoryItemId: id("از list_inventory_items"),
              quantity: { type: "string", description: "مقدار به‌صورت متن اعشاری" },
              unitCost: { type: "string", description: "فقط رسید — ریال به‌صورت متن؛ باید مثبت باشد" },
            },
            required: ["inventoryItemId", "quantity"],
            additionalProperties: false,
          },
        },
      },
      required: ["kind", "lines"],
      additionalProperties: false,
    },
  },
  {
    name: "write_crm_case_save",
    actionType: "crm.case.save",
    english: "Create or update a CRM support case (the cases screen form).",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        id: id("شناسهٔ پرونده برای ویرایش — از list_crm_cases"),
        subject: { type: "string" },
        body: { type: "string" },
        customerId: { type: ["string", "null"], description: "از find_customers" },
        status: { type: "string", enum: ["open", "in_progress", "waiting", "resolved", "closed"] },
        priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
        category: { type: "string" },
        orderId: { type: ["string", "null"] },
        assigneeUserId: { type: ["string", "null"], description: "از list_crm_members — رشتهٔ خالی برداریِ مسئول است" },
        assignedTo: { type: "string", description: "نام مسئول — فقط وقتی شناسه نداری" },
        resolution: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "write_crm_case_set_status",
    actionType: "crm.case.set_status",
    english: "Move a case to another status (SLA clock and first-response recorded like the screen).",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        caseId: id("از list_crm_cases"),
        status: { type: "string", enum: ["open", "in_progress", "waiting", "resolved", "closed"] },
        comment: { type: "string" },
        isInternal: { type: "boolean", description: "یادداشت داخلی — به‌عنوان پاسخ به مشتری ثبت نمی‌شود" },
      },
      required: ["caseId", "status"],
      additionalProperties: false,
    },
  },
  {
    name: "write_crm_activity_create",
    actionType: "crm.activity.create",
    english: "Log a CRM activity (call/meeting/message/note/task/visit).",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["call", "meeting", "message", "note", "task", "visit"] },
        subject: { type: "string" },
        body: { type: "string" },
        dueAt: { type: ["string", "null"] },
        customerId: { type: ["string", "null"] },
        dealId: { type: ["string", "null"], description: "از list_crm_deals" },
        caseId: { type: ["string", "null"], description: "از list_crm_cases" },
        assigneeUserId: { type: ["string", "null"] },
        assignedTo: { type: "string" },
        completed: { type: "boolean" },
      },
      required: ["kind", "subject"],
      additionalProperties: false,
    },
  },
  {
    name: "write_crm_activity_update",
    actionType: "crm.activity.update",
    english: "Edit an activity or tick it off (only sent fields are written).",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        activityId: id("از list_crm_activities"),
        kind: { type: "string", enum: ["call", "meeting", "message", "note", "task", "visit"] },
        subject: { type: "string" },
        body: { type: "string" },
        dueAt: { type: ["string", "null"] },
        assigneeUserId: { type: ["string", "null"] },
        assignedTo: { type: "string" },
        customerId: { type: ["string", "null"] },
        completed: { type: "boolean" },
      },
      required: ["activityId"],
      additionalProperties: false,
    },
  },
  {
    name: "write_crm_lead_save",
    actionType: "crm.lead.save",
    english: "Create or update a CRM lead (the leads screen form).",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        id: id("شناسهٔ سرنخ برای ویرایش — از list_crm_leads"),
        name: { type: "string" },
        phone: { type: "string" },
        email: { type: "string" },
        organization: { type: "string" },
        source: { type: "string" },
        sourceDetail: { type: "string" },
        status: { type: "string", enum: ["new", "contacted", "working", "qualified", "unqualified", "converted"] },
        rating: { type: "string", enum: ["hot", "warm", "cold"] },
        ownerUserId: id("مالک به‌صورت شناسهٔ عضو — ترجیحاً این، نه نام"),
        ownerName: { type: "string" },
        notes: { type: "string" },
        nextAction: { type: "string" },
        nextActionAt: { type: "string" },
        qualificationReason: { type: "string" },
        disqualificationReason: { type: "string" },
        utm: { type: "object", additionalProperties: true },
      },
      additionalProperties: false,
    },
  },
  {
    name: "write_crm_lead_convert",
    actionType: "crm.lead.convert",
    english: "Convert a lead into a customer (optionally opening a deal) — transactional, duplicate-guarded.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        leadId: id("شناسهٔ سرنخ — از list_crm_leads"),
        partyId: id("اتصال به مشتری موجود به‌جای ساخت مشتری جدید"),
        createDeal: { type: "boolean" },
        dealTitle: { type: "string" },
        dealValueRial: { type: "number" },
        dealExpectedCloseDate: { type: ["string", "null"] },
        acknowledgeDuplicates: {
          type: "boolean",
          description: "فقط بعد از اینکه موارد تکراری (خروجی خطای duplicates_found) به کاربر نشان داده شد مقدار true بده",
        },
      },
      required: ["leadId"],
      additionalProperties: false,
    },
  },
  {
    name: "write_crm_deal_save",
    actionType: "crm.deal.save",
    english: "Create or update a CRM deal (the kanban card form).",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        id: id("شناسهٔ معامده برای ویرایش — از list_crm_deals"),
        title: { type: "string" },
        customerId: id("مشتری مرتبط"),
        stageId: id("مرحلهٔ قیف — از list_crm_pipelines"),
        valueRial: { type: "number" },
        probability: { type: ["number", "null"] },
        expectedCloseDate: { type: ["string", "null"] },
        ownerUserId: id("مالک به‌صورت شناسهٔ عضو"),
        ownerUser: { type: "string", description: "نام مالک — فقط وقتی شناسه نداری" },
        source: { type: "string" },
        lostReason: { type: ["string", "null"] },
        orderId: id("سفارش مرتبط"),
        description: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "write_crm_deal_move_stage",
    actionType: "crm.deal.move_stage",
    english: "Move a deal to another pipeline stage (the kanban drag, with stage history).",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        dealId: id("شناسهٔ معامده — از list_crm_deals"),
        stageId: id("مرحلهٔ مقصد — از list_crm_pipelines"),
        note: { type: "string" },
        lostReason: { type: "string", description: "برای مرحلهٔ باخته" },
        wonReason: { type: "string", description: "برای مرحلهٔ برده" },
      },
      required: ["dealId", "stageId"],
      additionalProperties: false,
    },
  },
  {
    name: "write_crm_pipeline_create",
    actionType: "crm.pipeline.create",
    english: "Create a sales pipeline (the CRM settings panel).",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        isDefault: { type: "boolean" },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "write_crm_pipeline_update",
    actionType: "crm.pipeline.update",
    english: "Rename, re-default, or archive/restore a sales pipeline.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        pipelineId: id("شناسهٔ قیف — از list_crm_pipelines"),
        name: { type: "string" },
        description: { type: "string" },
        isDefault: { type: "boolean" },
        archived: { type: "boolean", description: "true = بایگانی، false = بازگردانی" },
      },
      required: ["pipelineId"],
      additionalProperties: false,
    },
  },
  {
    name: "write_report_saved_create",
    actionType: "report.saved.create",
    english: "Save a custom report definition (validated like the builder screen).",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        config: {
          type: "object",
          additionalProperties: true,
          description: "{ view, metric, aggregation, dimension, filters?, sort?, limit? } — از مجموعهٔ معتبر گزارش‌ساز؛ معنای مقادیر در list_reports آمده",
        },
      },
      required: ["name", "config"],
      additionalProperties: false,
    },
  },
  {
    name: "write_report_saved_update",
    actionType: "report.saved.update",
    english: "Rename or re-configure a saved report (validated like the builder screen).",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        savedReportId: id("شناسهٔ گزارش ذخیره‌شده — از list_saved_reports"),
        name: { type: "string" },
        config: {
          type: "object",
          additionalProperties: true,
          description: "پیکربندی جدید کامل گزارش — با همان وایت‌لیست‌های گزارش‌ساز اعتبارسنجی می‌شود",
        },
      },
      required: ["savedReportId"],
      additionalProperties: false,
    },
  },
  {
    name: "write_report_saved_delete",
    actionType: "report.saved.delete",
    english: "Delete one saved report.",
    destructive: true,
    inputSchema: {
      type: "object",
      properties: {
        savedReportId: id("شناسهٔ گزارش ذخیره‌شده — از list_saved_reports"),
      },
      required: ["savedReportId"],
      additionalProperties: false,
    },
  },
  {
    name: "write_supplier_return_create",
    actionType: "supplier.return.create",
    english: "Return goods to a supplier — stock goes out and the settlement posts (cash/bank/AP or supplier receivable) in one transaction.",
    destructive: true,
    inputSchema: {
      type: "object",
      properties: {
        locationId: id("شعبهٔ برگشت؛ خالی یعنی شعبهٔ پیش‌فرض connection"),
        purchaseId: id("شناسهٔ خرید — از list_purchases"),
        settlementMethod: { type: "string", enum: ["accounts_payable", "cash", "bank", "supplier_receivable"] },
        reason: { type: "string" },
        idempotencyKey: { type: "string", description: "کلید ایمن تکرار — ارسال دوبارهٔ همان کلید همان برگشت قبلی را برمی‌گرداند" },
        lines: {
          type: "array",
          items: {
            type: "object",
            properties: {
              purchaseItemId: id("شناسهٔ ولم خرید"),
              inventoryLotId: id("لات مشخص؛ خالی یعنی سرویس انتخاب کند"),
              quantity: { type: "string", description: "مقدار مثبت، رشته — مثل «4» یا «2.5»" },
            },
            required: ["purchaseItemId", "quantity"],
            additionalProperties: false,
          },
        },
      },
      required: ["purchaseId", "settlementMethod", "reason", "idempotencyKey", "lines"],
      additionalProperties: false,
    },
  },
  {
    name: "write_promotion_upsert",
    actionType: "promotion.upsert",
    english: "Create or edit a promotion (percent/amount/bundle/buy-x-get-y) — changes till pricing immediately.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        promotionId: id("شناسهٔ ترفیج موجود برای ویرایش — خالی یعنی ساخت تازه"),
        name: { type: "string" },
        kind: { type: "string", enum: ["percent", "amount", "bundle_price", "buy_x_get_y"] },
        value: { type: "number", description: "درصد یا مبلغ یا قیمت باندل بسته به نوع" },
        minQuantity: { type: "number", description: "فقط برای buy_x_get_y" },
        itemIds: { type: "array", items: { type: "string" }, description: "آیتم‌های هدف — خالی یعنی همه" },
        activeFrom: { type: "string", description: "ISO date" },
        activeTo: { type: "string", description: "ISO date" },
        daysOfWeek: { type: "array", items: { type: "number" }, description: "شنبه=0 … جمعه=6 — خالی یعنی همهٔ روزها" },
        timeFrom: { type: "string", description: "HH:mm" },
        timeTo: { type: "string", description: "HH:mm" },
        isActive: { type: "boolean" },
      },
      required: ["name", "kind", "value"],
      additionalProperties: false,
    },
  },
  {
    name: "write_promotion_toggle",
    actionType: "promotion.toggle",
    english: "Activate or deactivate one promotion.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        promotionId: id("شناسهٔ ترفیج — از list_promotions"),
        isActive: { type: "boolean" },
      },
      required: ["promotionId", "isActive"],
      additionalProperties: false,
    },
  },
  {
    name: "write_gift_card_issue",
    actionType: "gift_card.issue",
    english: "Issue a gift card with an initial value — the value posts as a liability (2420) in the issue branch's ledger.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        locationId: id("شعبهٔ صدور؛ خالی یعنی شعبهٔ پیش‌فرض connection"),
        code: { type: "string", description: "کد منحصربه‌فرد کارت" },
        initialValue: money("ارزش اولیه به ریال، مثبت"),
      },
      required: ["code", "initialValue"],
      additionalProperties: false,
    },
  },
  {
    name: "write_branch_create",
    actionType: "branch.create",
    english: "Create a new branch for the business.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        address: { type: "string" },
        phone: { type: "string" },
        timezone: { type: "string", description: "IANA zone name; خالی یعنی پیش‌فرض کسب‌وکار" },
        color: { type: "string", description: "کلید پالت رنگ شناسایی شعبه" },
        copyMenuFromLocationId: id("شناسهٔ شعبهٔ منبع برای کپی منو (اختیاری)"),
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "write_branch_update",
    actionType: "branch.update",
    english: "Rename / re-address / retimezone a branch.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        branchId: id("شناسهٔ شعبه — از list_branches"),
        name: { type: "string" },
        address: { type: "string" },
        phone: { type: "string" },
        timezone: { type: "string" },
        color: { type: "string" },
      },
      required: ["branchId"],
      additionalProperties: false,
    },
  },
  {
    name: "write_branch_lifecycle",
    actionType: "branch.lifecycle",
    english: "Deactivate a branch (stops its daily reports) or bring one back.",
    destructive: true,
    inputSchema: {
      type: "object",
      properties: {
        branchId: id("شناسهٔ شعبه — از list_branches"),
        action: { type: "string", enum: ["deactivate", "reactivate"] },
      },
      required: ["branchId", "action"],
      additionalProperties: false,
    },
  },
  {
    name: "write_crm_note_delete",
    actionType: "crm.note.delete",
    english: "Delete one customer note.",
    destructive: true,
    inputSchema: {
      type: "object",
      properties: {
        noteId: id("شناسهٔ یادداشت — از list_customer_notes"),
        customerId: id("گارد: مشتری‌دارای یادداشت — اگر داده شود باید با مشتریِ یادداشت یکی باشد"),
      },
      required: ["noteId"],
      additionalProperties: false,
    },
  },
  {
    name: "write_crm_note_pin",
    actionType: "crm.note.pin",
    english: "Pin or unpin one customer note so it leads the file.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        noteId: id("شناسهٔ یادداشت — از list_customer_notes"),
        pinned: { type: "boolean" },
        customerId: id("گارد مشتری، اختیاری"),
      },
      required: ["noteId", "pinned"],
      additionalProperties: false,
    },
  },
  {
    name: "write_crm_consent_set",
    actionType: "crm.consent.set",
    english: "Record a marketing/SMS consent grant or withdrawal for one customer — creates a logged consent event.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        customerId: id("شناسهٔ مشتری — از find_customers"),
        channel: { type: "string", enum: ["sms", "email"] },
        granted: { type: "boolean" },
        note: { type: "string", description: "توضیح رویداد رضایت" },
      },
      required: ["customerId", "channel", "granted"],
      additionalProperties: false,
    },
  },
  {
    name: "write_crm_segment_create",
    actionType: "crm.segment.create",
    english: "Create a customer segment from a rule definition.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        definition: { type: "object", additionalProperties: true, description: "{ all?: SegmentRule[], any?: SegmentRule[] } — اعتبارش توسط validateSegmentDefinition سنجیده می‌شود" },
      },
      required: ["name", "definition"],
      additionalProperties: false,
    },
  },
  {
    name: "write_crm_segment_update",
    actionType: "crm.segment.update",
    english: "Rename/re-describe/re-rule a customer segment.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        segmentId: id("شناسهٔ بخش‌بندی — از list_customer_segments"),
        name: { type: "string" },
        description: { type: "string" },
        definition: { type: "object", additionalProperties: true },
      },
      required: ["segmentId"],
      additionalProperties: false,
    },
  },
  {
    name: "write_crm_segment_archive",
    actionType: "crm.segment.archive",
    english: "Archive a customer segment (reversible by unarchiving on the screen).",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        segmentId: id("شناسهٔ بخش‌بندی — از list_customer_segments"),
      },
      required: ["segmentId"],
      additionalProperties: false,
    },
  },
  {
    name: "write_crm_automation_toggle",
    actionType: "crm.automation.toggle",
    english: "Switch one CRM automation rule on or off — affects every matching customer.",
    destructive: false,
    inputSchema: {
      type: "object",
      properties: {
        automationId: id("شناسهٔ اتوماسیون — از list_crm_automations"),
        isActive: { type: "boolean" },
      },
      required: ["automationId", "isActive"],
      additionalProperties: false,
    },
  },
  {
    name: "write_fixed_asset_dispose",
    actionType: "fixed-asset.dispose",
    english: "Dispose a fixed asset — sale (with proceeds), write-off or retirement.",
    destructive: true,
    inputSchema: {
      type: "object",
      properties: {
        fixedAssetId: id("شناسهٔ دارایی"),
        kind: { type: "string", enum: ["sale", "write_off", "retirement"] },
        proceeds: money("فقط برای sale"),
        proceedsAccountId: id("فقط برای sale"),
        disposalDate: { type: "string" },
        reason: { type: "string" },
      },
      required: ["fixedAssetId", "kind"],
      additionalProperties: false,
    },
  },
];

function writeDescriptor(spec: WriteToolSpec): McpToolDescriptor {
  const meta = ACTION_CATALOG[spec.actionType];
  return {
    name: spec.name,
    title: meta.label,
    description: `${spec.english}\n\n${meta.label} — ${meta.payloadHint}`,
    inputSchema: spec.inputSchema,
    annotations: {
      title: meta.label,
      readOnlyHint: false,
      // "Destructive" in MCP's sense is "cannot simply be undone", which is
      // exactly what ACTION_CATALOG's `revertible: false` records.
      destructiveHint: spec.destructive,
      // None of these are idempotent: calling write_expense twice books the
      // expense twice, and a client that retries on a timeout must be told so.
      idempotentHint: false,
      openWorldHint: false,
    },
  };
}

export function mcpWriteTools(): McpTool[] {
  return WRITE_TOOL_SPECS.map((spec) => {
    const meta = ACTION_CATALOG[spec.actionType];
    return {
      descriptor: writeDescriptor(spec),
      scope: MCP_SCOPES.write,
      // Non-null by construction; assertWriteToolsMatchCatalogue proves it.
      binding: { kind: "write", actionType: spec.actionType, executor: meta.executor! } as const,
    };
  });
}

/**
 * The invariant the write list must keep: exactly the executable, non-coworker
 * -only actions. Exported rather than inlined in the test so the rule reads as
 * part of the module it constrains.
 */
export function assertWriteToolsMatchCatalogue(): { missing: ActionType[]; extra: ActionType[] } {
  const expected = (Object.keys(ACTION_CATALOG) as ActionType[]).filter((type) => {
    const meta = ACTION_CATALOG[type];
    return Boolean(meta.executor) && !meta.coworkerOnly;
  });
  const present = WRITE_TOOL_SPECS.map((spec) => spec.actionType);
  return {
    missing: expected.filter((type) => !present.includes(type)),
    extra: present.filter((type) => !expected.includes(type)),
  };
}

// ---------------------------------------------------------------------------
// MCP-native status tools (issue #883 §7)
// ---------------------------------------------------------------------------

/**
 * `get_write_status` completes the async write contract: in `approve` mode a
 * write returns "pending", in `apply` mode the caller may be watching the
 * approval queue, and an interrupted execution (issue #883 A4) ends failed —
 * the client needs one tool that asks "what happened to MY write?" without
 * polling the app. It answers ONLY for rows this connection itself created:
 * a connection may not probe another connection's traffic, which is exactly
 * how the approval queue inside the app behaves (it lists the whole business
 * because its reader is the owner; here the reader is the connection).
 */
const MCP_NATIVE_TOOLS: McpTool[] = [
  {
    descriptor: {
      name: "get_write_status",
      title: "وضعیت یک عملیات نوشتنی",
      description:
        "Ask what happened to one write this connection submitted: the audit id it returned, its status (pending_approval / applied / failed / dismissed / in_flight), and its message.\n" +
        "وضعیت یک درخواست نوشتنی که همین اتصال ثبت کرده است را برمی‌گرداند: انتظار تأیید، انجام‌شده، ناموفق یا ردشده، همراه با پیام آن.",
      inputSchema: {
        type: "object",
        properties: {
          auditId: { type: "string", description: "شناسهٔ حسابرسی (auditId) که ابزار نوشتنی برگرداند" },
        },
        required: ["auditId"],
        additionalProperties: false,
      },
      annotations: {
        title: "وضعیت عملیات نوشتنی",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    // Scoped to the write grant: polling a write outcome needs `pos.write`
    // plus at least one writable app, never read-only traffic.
    scope: MCP_SCOPES.write,
    binding: { kind: "status" },
  },
];

/** The native status tool(s) this connection holds. */
function mcpNativeTools(scopes: readonly McpScope[], grants: McpGrants): McpTool[] {
  return MCP_NATIVE_TOOLS.filter(() => MCP_NATIVE_TOOLS_SHOWABLE(scopes, grants));
}

/**
 * Whether the own-connection status tool shows at all. Write scope alone is
 * too narrow a test — a connection whose grants forbid every writable app
 * must not see it either. The legacy `{}` document (`grants.apps` empty) IS a
 * writable grant, exactly as it is in grants.ts.
 */
function MCP_NATIVE_TOOLS_SHOWABLE(scopes: readonly McpScope[], grants: McpGrants): boolean {
  if (!scopes.includes(MCP_SCOPES.write)) return false;
  // Legacy means THE legacy document (`{}` ⇔ `{apps:{}, branches:"all"}`),
  // not merely an empty apps map: a stored closed document
  // (`{apps:{}, branches:[]}`) says "nothing at all", and surfacing the
  // status tool there would confirm the connection exists — one bit too
  // much for a credential whose stored consent is closed (issue #883 A1).
  if (isLegacyGrants(grants)) return true;
  return Object.values(grants.apps).some((grant) => grant.write === true);
}

/**
 * Lookup a native tool by name. Returns the descriptor for the dispatcher,
 * skipping the catalogue filter (server.ts gates `kind: "status"` itself).
 */
export function findMcpStatusTool(name: string): McpTool | null {
  return MCP_NATIVE_TOOLS.find((tool) => tool.descriptor.name === name) ?? null;
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

/**
 * The tools this connection may call.
 *
 * Filtered twice, and both filters fail closed:
 *
 *   * **by scope** — a read-only connection must not be able to *see* that a
 *     write tool exists, or a model will keep proposing one and telling the
 *     owner the app refused;
 *   * **by the authorizer's current permissions**, when the caller passes
 *     them (the dispatcher always does) — a connector authorized by a member
 *     without `payroll.view` neither sees nor calls `get_payroll_summary`,
 *     and a write whose action maps to no recognisable domain permission is
 *     withheld entirely (issue #883 P0-1).
 *
 * The catalogue is a courtesy to the client; `server.ts` re-checks the same
 * two axes on every call. Omitting `permissions` yields the scope-only list
 * (`isKnownMcpTool`'s "exists at all" answer) — it must never be passed to a
 * client as what they may use.
 */
/**
 * The tools this connection may call.
 *
 * Filtered on four axes now, and every one fails closed:
 *
 *   * **by scope** — a read-only connection must not be able to *see* that a
 *     write tool exists;
 *   * **by grants** (issue #883 §1) — the connection's app grants and its
 *     branch consent. A "CRM read" connection sees the CRM rows only; a
 *     connection consented to ONE branch sees no tool whose answer aggregates
 *     across branches, because answering it would leak the branches it was
 *     NOT consented to;
 *   * **by the registry** — a tool with no registry entry is not offered. The
 *     registry names the app, branch behaviour and risk; a missing row is a
 *     CI failure (registry.test.ts), and defensively treated as denied here;
 *   * **by the authorizer's current permissions**, when the caller passes
 *     them (the dispatcher always does).
 *
 * The catalogue is a courtesy to the client; `server.ts` re-checks the same
 * axes on every call. Omitting `permissions` yields the scope-only list
 * (`isKnownMcpTool`'s "exists at all" answer) — it must never be passed to a
 * client as what they may use.
 */
export function mcpToolCatalogue(
  scopes: readonly McpScope[],
  permissions?: ReadonlySet<Permission>,
  grants: McpGrants = LEGACY_GRANTS,
): McpTool[] {
  const all = [...mcpReadTools(), ...mcpWriteTools(), ...mcpNativeTools(scopes, grants)];
  return all.filter((tool) => {
    if (!scopes.includes(tool.scope)) return false;
    if (tool.binding.kind === "status") return true; // gated by mcpNativeTools itself
    if (tool.binding.kind === "read") {
      const entry = mcpReadRegistryEntry(tool.binding.readToolName);
      if (!entry || !mcpCanReadApp(grants, entry.app)) return false;
      if (
        entry.branchPolicy === "business_wide" &&
        !mcpBusinessWideToolAllowed(grants.branches === "all")
      ) {
        return false;
      }
    } else {
      const entry = mcpWriteRegistryEntry(tool.binding.actionType);
      if (!entry || !mcpCanWriteApp(grants, entry.app)) return false;
    }
    if (!permissions) return true;
    return tool.binding.kind === "read"
      ? canUseAiTool(tool.binding.readToolName, permissions)
      : aiActionPermission(tool.binding.actionType) !== null &&
          permissions.has(aiActionPermission(tool.binding.actionType)!);
  });
}

export function findMcpTool(
  name: string,
  scopes: readonly McpScope[],
  permissions?: ReadonlySet<Permission>,
  grants?: McpGrants,
): McpTool | null {
  return mcpToolCatalogue(scopes, permissions, grants).find((tool) => tool.descriptor.name === name) ?? null;
}

/** True for a name this server knows at all — so "no access" and "no such tool" can be told apart. */
export function isKnownMcpTool(name: string): boolean {
  return mcpToolCatalogue(["pos.read", "pos.write"]).some((tool) => tool.descriptor.name === name);
}
