/**
 * The MCP method dispatcher: one JSON-RPC message in, one result out.
 *
 * Kept apart from the route handler so the interesting decisions — which tools a
 * scope sees, what a write does in each mode, what a client is told when it asks
 * for something it may not have — are testable without an HTTP request, and so
 * that the route is left with transport concerns only (framing, CORS, status
 * codes, the 401 challenge).
 *
 * Every handler here runs *inside* the connection's tenant scope, established by
 * `withMcpScope` before this file is reached. Nothing below re-checks the
 * business id, because RLS is already the boundary — but every one of them
 * re-checks the *scope*, because that is the boundary RLS says nothing about.
 */
import { query } from "../db";
import { runReadTool } from "../ai-tools";
import { canUseAiTool } from "../ai-capabilities";
import { getBusinessIndustry } from "../industry-guard";
import { INDUSTRY_LABELS } from "../industries";
import { industryProfile, labelFor } from "../industry-profile";
import { currentAppVersion } from "../app-update";
import type { McpAuthentication } from "./auth";
import {
  JSON_RPC_ERRORS,
  initializeResult,
  jsonRpcError,
  jsonRpcResult,
  negotiateProtocolVersion,
  toolResult,
  type JsonRpcResponse,
  type ParsedMessage,
} from "./protocol";
import { mcpResourcesFor, readMcpResource } from "./resources";
import { MCP_SCOPES, hasMcpScope } from "./scopes";
import { mcpBrancheIds } from "./grants";
import { findMcpTool, isKnownMcpTool, mcpToolCatalogue } from "./tools";
import { findMcpWriteStatus, performMcpWrite } from "./write-service";

/**
 * The `instructions` field of `initialize` — the one piece of text every client
 * puts in front of the model before it does anything.
 *
 * It says three things and stops: what this installation is, what the model must
 * not assume about the numbers, and where the ground truth lives. Anything more
 * belongs in the `pos://app/conventions` resource, which the model can read when
 * it needs it, rather than in a preamble paid for on every conversation.
 */
async function buildInstructions(auth: McpAuthentication): Promise<{ title: string; instructions: string }> {
  const { rows } = await query<{ name: string }>(`SELECT name FROM businesses WHERE id = $1`, [
    auth.businessId,
  ]);
  const businessName = rows[0]?.name?.trim() || "کسب‌وکار";
  const industry = await getBusinessIndustry(auth.businessId);
  const trade = industry ? INDUSTRY_LABELS[industry] : "";
  const saleDoc = industry ? labelFor(industry, "saleDocument") : "سفارش";
  const catalogue = industry ? labelFor(industry, "catalogue") : "منو";
  const modules = industry ? industryProfile(industry).modules.join(", ") : "";

  const canWrite = hasMcpScope(auth.scopes, MCP_SCOPES.write);
  const writeLine = canWrite
    ? auth.writeMode === "apply"
      ? "This connection MAY write, and a write tool takes effect immediately. Confirm every figure with the person before you call one."
      : "This connection MAY write, but every write waits in an approval list inside the app and changes nothing until a human approves it. Never tell the user a change has been made — say it is waiting for their approval."
    : "This connection is READ-ONLY. There are no write tools. If the user asks for a change, explain what they should do in the app; do not claim you have done it.";

  const instructions = [
    `You are connected to the point-of-sale and accounting system of «${businessName}»${trade ? ` (${trade})` : ""}.`,
    `The owner and staff speak Persian; answer in Persian unless asked otherwise. This trade calls one sale a «${saleDoc}» and its item list «${catalogue}».`,
    modules ? `Modules available here: ${modules}.` : "",
    // Issue #883 §1 — the catalogue is already filtered by this connection's
    // consent document; saying so up front keeps the client from explaining
    // missing tools as malfunctions.
    `The owner consented exactly to the tools listed by tools/list — if a section of the app is not there, this connection was not granted it; the owner can widen it from Settings → Connections.`,
    "",
    "Before you interpret any number, read the resource `pos://app/conventions`. In short: money is an integer count of RIAL and people speak in TOMAN (Rial ÷ 10) — tools hand you a preformatted `text` field, use it; dates on the wire are Gregorian ISO while people read Jalali; a trading day is not a calendar day, so never recompute a date range yourself.",
    "Never ask the user for an id and never print one — `find_items` turns a Persian name into the ids the tools need.",
    "When you are unsure whether a part of the app exists for this business, call `describe_app` instead of guessing.",
    "",
    writeLine,
  ]
    .filter((line) => line !== "")
    .join("\n");

  return { title: businessName, instructions };
}

/**
 * A short line describing what a write was asked to do, for the audit trail and
 * for the approval screen. Built from the payload rather than from anything the
 * model wrote: the owner reading the approval list needs the figures that will
 * actually be applied, not a summary that could flatter them.
 */
function summarizeWrite(toolName: string, args: Record<string, unknown>): string {
  const fields = Object.entries(args)
    .map(([key, value]) => {
      const rendered =
        typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
      return `${key}=${rendered.slice(0, 120)}`;
    })
    .join("، ");
  return `${toolName}: ${fields}`.slice(0, 1_500);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * P1-9 — one write tool's arguments may not be a denial of service. Sized what
 * a CMS body *already* is: the largest legitimate payload (a website post's
 * Markdown body) comfortably fits in a tenth of this.
 */
const MAX_TOOL_ARGUMENT_BYTES = 64 * 1024;

/**
 * Issue #883 §7 — the reverse budget: one tool call (or one resource/read)
 * may not stream an unbounded document at the client. Sized so the largest
 * legitimate reads (a full quarter of a report's rows, a big menu inventory)
 * fit with headroom; anything over it gets a clear, structured "narrow the
 * query" failure rather than a silently truncated — and therefore silently
 * corrupt — JSON document.
 */
export const MAX_TOOL_RESULT_BYTES = 256 * 1024;

/**
 * `toolResult`, budgeted. Over-budget payloads fail closed with guidance:
 * which budget was exceeded and how to narrow the read (date range, filters,
 * paging). Never truncate mid-JSON: a model cannot tell a cut JSON document
 * apart from a complete one.
 */
function boundedToolResult(data: unknown, isError: boolean) {
  const result = toolResult(data, isError);
  const text = result.content[0]?.text ?? "";
  if (text.length <= MAX_TOOL_RESULT_BYTES) return result;
  return toolResult(
    {
      status: "result_too_large",
      bytes: text.length,
      budget: MAX_TOOL_RESULT_BYTES,
      message:
        "نتیجه بزرگ‌تر از حد مجاز یک پاسخ است. بازهٔ تاریخ، فیلترها یا تعداد ردیف‌ها را باریک‌تر کنید و دوباره بخوانید.\n" +
        "The result exceeds the per-response budget. Narrow the date range, filters or row count and retry.",
    },
    true,
  );
}

/**
 * The idempotency key a client attaches to a write retry, in the spec's own
 * out-of-band channel (`params._meta`) so it never collides with a tool's
 * declared input schema. Bounded and namespaced: the durable contract lives in
 * `write-service.ts`.
 */
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

function readIdempotencyKey(params: Record<string, unknown>): string | null {
  const meta = isRecord(params._meta) ? params._meta : null;
  const candidate = meta?.idempotencyKey;
  if (typeof candidate !== "string") return null;
  const trimmed = candidate.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_IDEMPOTENCY_KEY_LENGTH ? trimmed : null;
}

async function callTool(
  auth: McpAuthentication,
  params: Record<string, unknown>,
): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
  const name = typeof params.name === "string" ? params.name : "";
  const args = isRecord(params.arguments) ? params.arguments : {};

  if (JSON.stringify(args).length > MAX_TOOL_ARGUMENT_BYTES) {
    return {
      error: {
        code: JSON_RPC_ERRORS.invalidParams,
        message: "ورودی ابزار بیش از حد بزرگ است. متن یا فهرست اقلام را کوتاه‌تر کنید.",
      },
    };
  }

  const tool = findMcpTool(name, auth.scopes, auth.permissions, auth.grants);
  if (!tool) {
    // "You may not" and "no such thing" are different answers and a model
    // behaves differently for each: the first is worth telling the user about,
    // the second means it should stop trying. Scope, module, grants, branch
    // consent and the authorizer's current permission all land in the first
    // bucket — the client needs no finer distinction to behave correctly.
    const message = isKnownMcpTool(name)
      ? `ابزار «${name}» برای این اتصال مجاز نیست. ممکن است اتصال دسترسی نوشتن نداشته باشد، به این بخش اجازه نداده شده باشد، یا کاربر مجوزش نداشته باشد.`
      : `ابزار «${name}» وجود ندارد.`;
    return { error: { code: JSON_RPC_ERRORS.invalidParams, message } };
  }

  // Issue #883 §7 — the dispatcher-native status tool. It answers from this
  // connection's own audit rows and nothing else's; the catalogue gate above
  // already proved the connection holds `pos.write` and a writable app.
  if (tool.binding.kind === "status") {
    const auditId = typeof args.auditId === "string" ? args.auditId.trim() : "";
    if (!auditId) {
      return {
        error: {
          code: JSON_RPC_ERRORS.invalidParams,
          message: "auditId لازم است — همان شناسه‌ای که ابزار نوشتنی برگرداند.",
        },
      };
    }
    const stored = await findMcpWriteStatus(auth.businessId, auth.connectionId, auditId);
    if (!stored) {
      return {
        result: toolResult(
          {
            status: "unknown",
            message:
              "چنین درخواستی متعلق به این اتصال پیدا نشد. auditId باید متعلق به فراخوانی همین اتصال باشد — درخواست‌های اتصال دیگر قابل پرس‌وجو نیست.",
          },
          true,
        ),
      };
    }
    return {
      result: toolResult(
        {
          status: stored.status,
          actionType: stored.actionType,
          message: stored.message,
          result: stored.result,
          requiresReview: stored.requiresReview,
        },
        stored.status === "failed",
      ),
    };
  }

  if (tool.binding.kind === "read") {
    // The workspace tools need to know who is asking — `mine: true` means the
    // human who authorized this connection, and nothing else. Every other read
    // tool ignores the argument.
    // P0-1: the permission set is the authorizer's *current* set, resolved in
    // `authenticateMcp`, never the all-permissions SYSTEM read context — a
    // connector reaches exactly what its authorizer's own session would.
    const outcome = await runReadTool(
      tool.binding.readToolName,
      args,
      auth.businessId,
      undefined,
      auth.authorizedByUserId,
      auth.permissions,
      // Issue #883 §1: the connection's branch consent, enforced at the
      // executor — a pinned tool resolves a consented branch instead of the
      // primary, a business-wide aggregate refused at the catalogue is also
      // refused here (registry + executor agree through ai-tools's own check).
      { allowedBranchIds: mcpBrancheIds(auth.grants) },
    );
    return { result: boundedToolResult(outcome.data, !outcome.ok) };
  }

  const outcome = await performMcpWrite({
    auth,
    actionType: tool.binding.actionType,
    payload: args,
    summary: summarizeWrite(name, args),
    idempotencyKey: readIdempotencyKey(params),
  });
  return {
    result: toolResult(
      {
        status: outcome.status,
        message: outcome.message,
        auditId: outcome.auditId,
        actionType: outcome.actionType,
        error: outcome.error ?? null,
        result: outcome.result ?? null,
      },
      outcome.status === "failed",
    ),
  };
}

/**
 * Dispatch one parsed message.
 *
 * Returns null for a notification — JSON-RPC forbids answering one, and a client
 * that receives a response to `notifications/initialized` treats the whole
 * session as broken.
 */
export async function dispatchMcpMessage(
  auth: McpAuthentication,
  message: ParsedMessage,
): Promise<JsonRpcResponse | null> {
  if (message.kind === "invalid") {
    return jsonRpcError(message.id, JSON_RPC_ERRORS.invalidRequest, message.message);
  }
  if (message.kind === "notification") return null;

  const { id, method, params } = message;

  switch (method) {
    case "initialize": {
      const { title, instructions } = await buildInstructions(auth);
      return jsonRpcResult(
        id,
        initializeResult({
          protocolVersion: negotiateProtocolVersion(params.protocolVersion),
          title,
          version: currentAppVersion(),
          instructions,
        }),
      );
    }

    case "ping":
      return jsonRpcResult(id, {});

    case "tools/list":
      return jsonRpcResult(id, {
        tools: mcpToolCatalogue(auth.scopes, auth.permissions, auth.grants).map(
          (tool) => tool.descriptor,
        ),
      });

    case "tools/call": {
      const outcome = await callTool(auth, params);
      return outcome.error
        ? jsonRpcError(id, outcome.error.code, outcome.error.message)
        : jsonRpcResult(id, outcome.result);
    }

    case "resources/list":
      return jsonRpcResult(id, { resources: mcpResourcesFor(auth.permissions, auth.grants) });

    // Nothing here is parameterised by a URI template. Answering with an empty
    // list is required: a client that gets "method not found" for this stops
    // asking about resources altogether.
    case "resources/templates/list":
      return jsonRpcResult(id, { resourceTemplates: [] });

    case "resources/read": {
      const uri = typeof params.uri === "string" ? params.uri : "";
      // Resources are data like any read: the overview is `describe_app`'s
      // content and the report catalogue lists reports, so each inherits its
      // tool's permission (P0-1). Unknown and unauthorized get the same
      // answer — a resource the authorizer may not see is not one to confirm
      // the existence of.
      if (!mcpResourcesFor(auth.permissions, auth.grants).some((resource) => resource.uri === uri)) {
        return jsonRpcError(id, JSON_RPC_ERRORS.invalidParams, `منبع «${uri}» وجود ندارد.`);
      }
      const content = await readMcpResource(uri, auth.businessId, auth.permissions);
      if (!content) {
        return jsonRpcError(id, JSON_RPC_ERRORS.invalidParams, `منبع «${uri}» وجود ندارد.`);
      }
      // Issue #883 §7 — resources obey the same response budget as tools: a
      // never-ending overview is as much a budget break as an over-wide
      // report. Refusing clearly beats transmitting a cut document.
      if ((content.text?.length ?? 0) > MAX_TOOL_RESULT_BYTES) {
        return jsonRpcError(
          id,
          JSON_RPC_ERRORS.internalError,
          `منبع «${uri}» بزرگ‌تر از حد مجاز یک پاسخ است (${MAX_TOOL_RESULT_BYTES} بایت). به‌جای این منبع، ابزار متناظر را با فیلتر باریک‌تر فراخوانی کنید.`,
        );
      }
      return jsonRpcResult(id, { contents: [content] });
    }

    // No prompt templates yet — the `instructions` above carry what a prompt
    // would. Same reasoning as resources/templates/list for answering rather
    // than erroring.
    case "prompts/list":
      return jsonRpcResult(id, { prompts: [] });

    // Accepted and ignored: this server writes to the process log, not down a
    // stream the client can subscribe to.
    case "logging/setLevel":
      return jsonRpcResult(id, {});

    default:
      return jsonRpcError(id, JSON_RPC_ERRORS.methodNotFound, `متد «${method}» پشتیبانی نمی‌شود.`);
  }
}
