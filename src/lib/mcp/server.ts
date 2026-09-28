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
import { runSystemReadTool } from "../ai-system-read";
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
import { MCP_RESOURCES, readMcpResource } from "./resources";
import { MCP_SCOPES, hasMcpScope } from "./scopes";
import { findMcpTool, isKnownMcpTool, mcpToolCatalogue } from "./tools";
import { performMcpWrite } from "./write-service";

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

async function callTool(
  auth: McpAuthentication,
  params: Record<string, unknown>,
): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
  const name = typeof params.name === "string" ? params.name : "";
  const args = isRecord(params.arguments) ? params.arguments : {};

  const tool = findMcpTool(name, auth.scopes);
  if (!tool) {
    // "You may not" and "no such thing" are different answers and a model
    // behaves differently for each: the first is worth telling the user about,
    // the second means it should stop trying.
    const message = isKnownMcpTool(name)
      ? `ابزار «${name}» برای این اتصال مجاز نیست. این اتصال دسترسی نوشتن ندارد.`
      : `ابزار «${name}» وجود ندارد.`;
    return { error: { code: JSON_RPC_ERRORS.invalidParams, message } };
  }

  if (tool.binding.kind === "read") {
    // The workspace tools need to know who is asking — `mine: true` means the
    // human who authorized this connection, and nothing else. Every other read
    // tool ignores the argument. A connection with no authorizing user (a
    // machine token) gets a decline from the tool itself, which is the right
    // answer: there is no "my tasks" without a "my".
    const outcome = await runSystemReadTool(
      tool.binding.readToolName,
      args,
      auth.businessId,
      undefined,
      auth.authorizedByUserId ?? undefined,
    );
    return { result: toolResult(outcome.data, !outcome.ok) };
  }

  const outcome = await performMcpWrite({
    auth,
    actionType: tool.binding.actionType,
    payload: args,
    summary: summarizeWrite(name, args),
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
        tools: mcpToolCatalogue(auth.scopes).map((tool) => tool.descriptor),
      });

    case "tools/call": {
      const outcome = await callTool(auth, params);
      return outcome.error
        ? jsonRpcError(id, outcome.error.code, outcome.error.message)
        : jsonRpcResult(id, outcome.result);
    }

    case "resources/list":
      return jsonRpcResult(id, { resources: MCP_RESOURCES });

    // Nothing here is parameterised by a URI template. Answering with an empty
    // list is required: a client that gets "method not found" for this stops
    // asking about resources altogether.
    case "resources/templates/list":
      return jsonRpcResult(id, { resourceTemplates: [] });

    case "resources/read": {
      const uri = typeof params.uri === "string" ? params.uri : "";
      const content = await readMcpResource(uri, auth.businessId);
      return content
        ? jsonRpcResult(id, { contents: [content] })
        : jsonRpcError(id, JSON_RPC_ERRORS.invalidParams, `منبع «${uri}» وجود ندارد.`);
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
