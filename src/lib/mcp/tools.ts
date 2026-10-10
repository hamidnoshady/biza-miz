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
 *     floor five (reservations, tables, courier), `menu.item.create`, and
 *     Phase 38's `website.post.publish`. Their absence is not an omission to
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
