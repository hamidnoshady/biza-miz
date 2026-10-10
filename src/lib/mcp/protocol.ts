/**
 * JSON-RPC 2.0 framing for the MCP endpoint.
 *
 * MCP is JSON-RPC over (here) a single HTTP POST — the "Streamable HTTP"
 * transport. This file is the part of that with no opinions about this app: it
 * parses a request body into requests and notifications, builds results and
 * errors, and negotiates the protocol version. It exists separately from
 * `server.ts` so the framing can be unit tested without a database, which
 * matters more than usual here: a malformed frame is answered by *us*, and an
 * MCP client that gets a malformed frame back typically shows the user nothing
 * at all rather than an error.
 *
 * Deliberately no SSE. The spec allows a server to answer a POST with a single
 * `application/json` response, and every tool here is a request/response call
 * with no server-initiated messages — so a streaming channel would be a session
 * to keep alive, resume and expire for no behaviour anyone would see. `GET /mcp`
 * therefore refuses rather than opening a stream, which is the documented way to
 * say "this server does not offer one".
 */

/** The versions this server implements, newest first. */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export const MCP_SERVER_NAME = "cafe-restaurant-pos";

/** Standard JSON-RPC 2.0 error codes, plus nothing invented. */
export const JSON_RPC_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export function jsonRpcResult(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

export function jsonRpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcFailure {
  return { jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } };
}

/**
 * A well-formed JSON-RPC message, or the reason it is not one.
 *
 * A *notification* (no `id`) is a message the client does not want an answer
 * to — `notifications/initialized` is the one every client sends — and the
 * difference is load-bearing: answering a notification is a protocol violation,
 * so `id` being absent has to survive parsing rather than being defaulted to
 * null.
 */
export type ParsedMessage =
  | { kind: "request"; id: JsonRpcId; method: string; params: Record<string, unknown> }
  | { kind: "notification"; method: string; params: Record<string, unknown> }
  | { kind: "invalid"; id: JsonRpcId; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseMessage(value: unknown): ParsedMessage {
  if (!isRecord(value)) return { kind: "invalid", id: null, message: "پیام JSON-RPC نامعتبر است" };

  const rawId = value.id;
  const id: JsonRpcId =
    typeof rawId === "string" || typeof rawId === "number" ? rawId : rawId === null ? null : null;
  const hasId = "id" in value && (typeof rawId === "string" || typeof rawId === "number");

  if (value.jsonrpc !== "2.0") {
    return { kind: "invalid", id, message: "فقط JSON-RPC 2.0 پشتیبانی می‌شود" };
  }
  if (typeof value.method !== "string" || value.method.length === 0) {
    return { kind: "invalid", id, message: "method لازم است" };
  }

  const params = isRecord(value.params) ? value.params : {};
  return hasId
    ? { kind: "request", id, method: value.method, params }
    : { kind: "notification", method: value.method, params };
}

/**
 * The most messages one POST may batch. Real MCP clients send a handful;
 * anything past this is a load attempt, not a conversation, and dispatching it
 * would multiply per-message reads (and writes) by however many the sender
 * felt like (issue #883 P1-9).
 */
export const MAX_BATCH_MESSAGES = 20;

/**
 * A body is either one message or a batch of them. Returns null for a batch
 * that is empty, which JSON-RPC calls an Invalid Request rather than "nothing
 * to do" — and for one over the batch cap, for the same reason.
 */
export function parseBody(body: unknown): { batch: boolean; messages: ParsedMessage[] } | null {
  if (Array.isArray(body)) {
    if (body.length === 0 || body.length > MAX_BATCH_MESSAGES) return null;
    return { batch: true, messages: body.map(parseMessage) };
  }
  return { batch: false, messages: [parseMessage(body)] };
}

/**
 * Which protocol version to answer `initialize` with.
 *
 * The rule from the spec: reply with the client's version if it is supported,
 * otherwise with ours and let the client decide whether it can live with that.
 * Never echo an unknown string back — that claims support this server does not
 * have, and the failure surfaces much later as a tool call the client cannot
 * parse.
 */
export function negotiateProtocolVersion(requested: unknown): string {
  return typeof requested === "string" &&
    (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : LATEST_PROTOCOL_VERSION;
}

export interface InitializeResultOptions {
  protocolVersion: string;
  /** The business's own name, so a client's connector list says «کافه ونک» rather than a product name. */
  title: string;
  version: string;
  instructions: string;
}

/**
 * The `initialize` result.
 *
 * `capabilities` advertises only what is actually implemented. `listChanged` is
 * false everywhere because this server never pushes a notification (there is no
 * stream to push it down), and claiming otherwise would leave a client waiting
 * for an update that cannot arrive.
 */
export function initializeResult(options: InitializeResultOptions) {
  return {
    protocolVersion: options.protocolVersion,
    capabilities: {
      tools: { listChanged: false },
      resources: { listChanged: false, subscribe: false },
      prompts: { listChanged: false },
    },
    serverInfo: {
      name: MCP_SERVER_NAME,
      title: options.title,
      version: options.version,
    },
    instructions: options.instructions,
  };
}

/**
 * A tool result in MCP's own shape.
 *
 * `content` is what the model reads and `structuredContent` is the same data
 * as JSON for clients that can use it. Both are filled: a client that renders
 * only `content` (most of them, today) must not see an empty answer, and a
 * model that gets prose where it expected fields answers worse.
 *
 * `isError: true` is a *tool* failure the model is meant to read and react to
 * ("that item does not exist") — not a protocol failure, which is a JSON-RPC
 * error and never reaches the model at all.
 */
export function toolResult(data: unknown, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: isRecord(data) ? data : { value: data },
    isError,
  };
}
