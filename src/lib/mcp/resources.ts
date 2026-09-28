/**
 * MCP resources — the "read the manual before you start guessing" half of the
 * connector.
 *
 * Tools answer questions. Resources answer the question *before* the questions:
 * what is this installation, what does it call things, what units is it
 * counting in. Without them a model connecting to a Persian jewellery shop's
 * POS will cheerfully talk about «سفارش» when the trade says «فاکتور», divide
 * Rial by ten in the wrong direction, and bucket a night shift's sales at
 * midnight. Every one of those is a confident, plausible, wrong answer about
 * money — the exact failure mode `ai-labels.ts` was written to prevent inside
 * the app, applied to a model running outside it.
 *
 * Three resources, and no more: an overview of this business, the report
 * catalogue, and a short guide to the conventions. A resource list is read in
 * full by most clients, so length here is a cost paid on every conversation.
 */
import { runSystemReadTool } from "../ai-system-read";
import { getBusinessIndustry } from "../industry-guard";
import { standardReportsFor } from "../reports";

export interface McpResourceDescriptor {
  uri: string;
  name: string;
  title: string;
  description: string;
  mimeType: string;
}

export const MCP_RESOURCES: McpResourceDescriptor[] = [
  {
    uri: "pos://app/overview",
    name: "business-overview",
    title: "این کسب‌وکار",
    description:
      "What this installation is: trade, branches, available modules, enabled features, the vocabulary this trade uses, and what can be done here. Read this first.",
    mimeType: "application/json",
  },
  {
    uri: "pos://app/conventions",
    name: "data-conventions",
    title: "قراردادهای داده",
    description:
      "How this system stores money, dates, quantities and the business day — and the mistakes a model makes when it assumes otherwise. Read before interpreting any number.",
    mimeType: "text/markdown",
  },
  {
    uri: "pos://reports/catalog",
    name: "report-catalog",
    title: "فهرست گزارش‌ها",
    description: "Every standard report available to run_report, by key and Persian title.",
    mimeType: "application/json",
  },
];

/**
 * The conventions document.
 *
 * Static text on purpose — it describes the codebase's own storage rules, which
 * are the same for every business, and a per-tenant version would be a second
 * place for them to drift from README.md. Written in English because it is
 * instructions *to a model*, unlike everything the model then says to the owner.
 */
const CONVENTIONS = `# Data conventions in this POS

Read this before interpreting any figure you get from a tool.

## Money

- Every monetary value is stored and returned as an **integer number of Rial**.
- Owners speak in **Toman**, which is Rial ÷ 10. Tools that return money give you
  \`{ rial, toman, text }\` — use \`text\`, which is already formatted with Persian
  digits. Never divide or multiply yourself, and never present a bare Rial
  integer to a person: "۱۲۰۰۰۰۰ ریال" reads to an owner as a hundred times what
  they meant.
- When a tool takes an amount, it takes **integer Rial**. A price of ۵۰٬۰۰۰ تومان
  is \`500000\`.

## Dates and times

- Dates on the wire are **ISO / Gregorian** (\`YYYY-MM-DD\`). The owner reads
  **Jalali**. If you show a date, say which calendar you mean.
- Persian digits are a display convention only; send ASCII digits.

## The business day

- "Today" is not the calendar day. A branch may start its trading day at any
  time, so a café working 18:00→03:00 keeps one night's service on one date.
  Tools already answer in the branch's own business day — do not recompute a
  date range from your own clock, and do not assume UTC.
- If you leave a date range open, tools default to the branch's business day,
  which is the correct behaviour. Prefer that over inventing bounds.

## Quantities

- Inventory quantities are exact decimals passed as **strings**, not floats. A
  store room counted in kilograms drifts if you round them.

## Identifiers

- Never ask a person for an id, and never print one. \`find_items\` turns a
  partial Persian name into the ids the write tools need.
- A disabled item is an answer: \`find_items\` returns \`isActive\` and a Persian
  status label. "پیدا نشد" for an item that merely exists but is switched off is
  wrong.

## Labels

- Enum values come back with their Persian label attached. Use the label the
  tool gave you; do not translate a code like \`spoilage\` yourself.

## Writing

- Write tools are only present if this connection was granted write access.
- Depending on how the owner configured this connection, a write may either
  apply immediately or wait in an approval list inside the app. The tool result
  tells you which happened — say so plainly rather than claiming a change was
  made when it is pending.
- Amounts and quantities you send are taken literally. Confirm the figure with
  the person before calling a write tool.
`;

export interface McpResourceContent {
  uri: string;
  mimeType: string;
  text: string;
}

/**
 * Read one resource. Returns null for an unknown URI, which the caller turns
 * into a JSON-RPC error rather than an empty document — a client that receives
 * an empty resource shows the model nothing and gives no reason.
 */
export async function readMcpResource(
  uri: string,
  businessId: string,
): Promise<McpResourceContent | null> {
  switch (uri) {
    case "pos://app/overview": {
      const result = await runSystemReadTool("describe_app", {}, businessId);
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(result.data, null, 2),
      };
    }
    case "pos://app/conventions":
      return { uri, mimeType: "text/markdown", text: CONVENTIONS };
    // This trade's catalogue, not the whole library: a connected model that
    // reads a report this business cannot run would ask for it, get a 404, and
    // have no way to tell "not for this trade" from "broken".
    case "pos://reports/catalog": {
      const industry = await getBusinessIndustry(businessId);
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(
          standardReportsFor(industry).map((report) => ({
            key: report.key,
            label: report.label,
            group: report.group,
            description: report.description ?? null,
          })),
          null,
          2,
        ),
      };
    }
    default:
      return null;
  }
}
