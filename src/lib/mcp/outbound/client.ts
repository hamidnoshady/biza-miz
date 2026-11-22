/**
 * A Streamable HTTP MCP **client**.
 *
 * Direction, stated once because it is the whole point of the module: this is
 * Bizamiz calling somebody else's MCP server — a CMS, an index, a translation
 * service. It is the opposite of `src/lib/mcp/server.ts`, which serves Bizamiz's
 * own tools to ChatGPT; the two share nothing but the JSON-RPC vocabulary and
 * deliberately no code, because a server that can also dial out is one bug away
 * from a proxy.
 *
 * Only what a tool-provider integration needs:
 *
 *  - `initialize` → `notifications/initialized`, carrying the session id the server
 *    returns (some servers require it on every later call, some do not; sending it
 *    only when given is what makes both work);
 *  - `tools/list`, with cursor pagination and a hard cap;
 *  - `tools/call`, returning the MCP result shape untouched.
 *
 * Three properties that are easy to lose and expensive to lose:
 *
 *  1. **The URL is checked before every request, not once at registration.** A
 *     server row can be edited; a policy read per call cannot be outrun by a row
 *     that changed five minutes ago.
 *  2. **No redirect is followed.** `redirect: "error"` — one 302 from an allowed
 *     host to `169.254.169.254` would otherwise walk past the allowlist entirely.
 *  3. **The bearer token never appears in an error.** Messages come from a closed
 *     set plus a truncated server sentence; headers, URLs and bodies are not
 *     copied into anything a caller might log.
 *
 * The transport is a single POST per call. SSE is accepted as a *response*
 * encoding (the spec allows a server to answer either way) but no streaming
 * session is opened, because every call here is request/response.
 */
import { assertOutboundTarget, outboundPolicyFromEnv, type OutboundTargetPolicy } from "./guard";

export const OUTBOUND_PROTOCOL_VERSION = "2025-06-18";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_TOOL_PAGES = 10;
const MAX_TOOLS = 250;
const MAX_ERROR_MESSAGE = 300;

export type OutboundMcpErrorCode =
  | "target_refused"
  | "network_error"
  | "timeout"
  | "http_error"
  | "protocol_error"
  | "response_too_large"
  | "rpc_error"
  | "not_initialized";

export class OutboundMcpError extends Error {
  readonly code: OutboundMcpErrorCode;
  /** HTTP status when the failure was an HTTP one. Never the body. */
  readonly status?: number;
  /** JSON-RPC error code when the server answered with one. */
  readonly rpcCode?: number;
  /** The URL's origin, for an operator log. Never the full URL, never a header. */
  readonly origin?: string;

  constructor(
    code: OutboundMcpErrorCode,
    message: string,
    extra: { status?: number; rpcCode?: number; origin?: string } = {},
  ) {
    super(message.slice(0, MAX_ERROR_MESSAGE));
    this.name = "OutboundMcpError";
    this.code = code;
    this.status = extra.status;
    this.rpcCode = extra.rpcCode;
    this.origin = extra.origin;
  }
}

export interface OutboundMcpTool {
  name: string;
  title?: string;
  description?: string;
  /** JSON Schema as the remote server declares it. Passed through, never interpreted here. */
  inputSchema: unknown;
}

export interface OutboundMcpCallResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError: boolean;
  structuredContent?: unknown;
}

export interface OutboundMcpServerInfo {
  name: string;
  version: string;
  protocolVersion: string;
  instructions?: string;
}

export interface OutboundMcpClientOptions {
  url: string;
  bearerToken?: string | null;
  timeoutMs?: number;
  maxResponseBytes?: number;
  policy?: OutboundTargetPolicy;
  /**
   * Test seam. Production code passes nothing and gets the real resolver; a unit
   * test points the client at a loopback server without weakening `guard.ts`.
   */
  resolveTarget?: (url: string) => Promise<void>;
}

interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: number | string;
  result: Record<string, unknown>;
}

interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: number | string | null;
  error: { code?: number; message?: string };
}

export class OutboundMcpClient {
  private readonly options: Required<Pick<OutboundMcpClientOptions, "timeoutMs" | "maxResponseBytes">> &
    OutboundMcpClientOptions;
  private nextId = 1;
  private sessionId: string | null = null;
  private serverInfo: OutboundMcpServerInfo | null = null;

  constructor(options: OutboundMcpClientOptions) {
    this.options = {
      ...options,
      maxResponseBytes: options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
  }

  /** The negotiated protocol version and the server's self-description. */
  get info(): OutboundMcpServerInfo | null {
    return this.serverInfo;
  }

  async initialize(): Promise<OutboundMcpServerInfo> {
    const result = await this.request("initialize", {
      capabilities: {},
      clientInfo: { name: "bizamiz", version: "1.0.0" },
      protocolVersion: OUTBOUND_PROTOCOL_VERSION,
    });

    const info: OutboundMcpServerInfo = {
      instructions:
        typeof result.instructions === "string" ? result.instructions.slice(0, 2000) : undefined,
      name:
        typeof (result.serverInfo as { name?: unknown } | undefined)?.name === "string"
          ? String((result.serverInfo as { name: string }).name).slice(0, 100)
          : "remote",
      protocolVersion:
        typeof result.protocolVersion === "string"
          ? result.protocolVersion
          : OUTBOUND_PROTOCOL_VERSION,
      version:
        typeof (result.serverInfo as { version?: unknown } | undefined)?.version === "string"
          ? String((result.serverInfo as { version: string }).version).slice(0, 50)
          : "0",
    };

    this.serverInfo = info;

    // A notification: no id, and a rejection is permitted by the spec because the
    // server may not implement it. Failure here must not fail the connection.
    await this.notify("notifications/initialized", {}).catch(() => undefined);

    return info;
  }

  async listTools(): Promise<OutboundMcpTool[]> {
    if (!this.serverInfo) throw new OutboundMcpError("not_initialized", "Initialize the client first.");

    const tools: OutboundMcpTool[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
      const result = await this.request("tools/list", cursor ? { cursor } : {});
      const page_ = Array.isArray(result.tools) ? result.tools : [];

      for (const entry of page_) {
        if (tools.length >= MAX_TOOLS) break;
        const tool = normalizeTool(entry);
        if (tool) tools.push(tool);
      }

      const next = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
      if (!next || tools.length >= MAX_TOOLS) break;
      cursor = next;
    }

    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<OutboundMcpCallResult> {
    if (!this.serverInfo) throw new OutboundMcpError("not_initialized", "Initialize the client first.");
    if (!name) throw new OutboundMcpError("protocol_error", "A tool name is required.");

    const result = await this.request("tools/call", {
      arguments: args ?? {},
      name,
    });

    const content = Array.isArray(result.content)
      ? (result.content as OutboundMcpCallResult["content"])
      : [];
    return {
      content,
      isError: result.isError === true,
      structuredContent: result.structuredContent,
    };
  }

  async close(): Promise<void> {
    // No transport to close (each call is its own POST) and no `shutdown` method in
    // the protocol. Dropping the session id is the whole cleanup.
    this.sessionId = null;
  }

  // -------------------------------------------------------------------------

  private async notify(method: string, params: Record<string, unknown>): Promise<void> {
    await this.send({ jsonrpc: "2.0", method, params });
  }

  private async request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const body = await this.send({ id, jsonrpc: "2.0", method, params });

    if (!body) {
      throw new OutboundMcpError("protocol_error", `No response for ${method}.`, {
        origin: this.origin(),
      });
    }

    if ("error" in body && body.error) {
      const failure = body as JsonRpcFailure;
      throw new OutboundMcpError(
        "rpc_error",
        typeof failure.error.message === "string" && failure.error.message
          ? failure.error.message
          : `The server rejected ${method}.`,
        { origin: this.origin(), rpcCode: failure.error.code },
      );
    }

    const success = body as JsonRpcSuccess;
    if (!success.result || typeof success.result !== "object") {
      throw new OutboundMcpError("protocol_error", `${method} answered without a result.`, {
        origin: this.origin(),
      });
    }
    return success.result;
  }

  private origin(): string | undefined {
    try {
      return new URL(this.options.url).origin;
    } catch {
      return undefined;
    }
  }

  private async guard(): Promise<void> {
    if (this.options.resolveTarget) {
      await this.options.resolveTarget(this.options.url);
      return;
    }
    const policy = this.options.policy ?? outboundPolicyFromEnv();
    const checked = await assertOutboundTarget(this.options.url, policy);
    if (!checked.ok) {
      throw new OutboundMcpError(
        "target_refused",
        `This MCP server address is not allowed (${checked.reason}).`,
      );
    }
  }

  /**
   * One POST. Returns the JSON-RPC body, or null for a notification's empty answer.
   *
   * The response may be JSON or an SSE stream; both are decoded here so callers
   * never see the difference.
   */
  private async send(payload: Record<string, unknown>): Promise<JsonRpcSuccess | JsonRpcFailure | null> {
    await this.guard();

    const headers: Record<string, string> = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    };
    if (this.options.bearerToken) headers.authorization = `Bearer ${this.options.bearerToken}`;
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;

    let response: Response;
    try {
      response = await fetch(this.options.url, {
        body: JSON.stringify(payload),
        headers,
        method: "POST",
        // One redirect would defeat the allowlist. The spec does not need any.
        redirect: "error",
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new OutboundMcpError(
        timedOut ? "timeout" : "network_error",
        timedOut ? "The MCP server did not answer in time." : "The MCP server could not be reached.",
        { origin: this.origin() },
      );
    }

    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) this.sessionId = sessionId;

    if (!response.ok) {
      // Drain the body without keeping it: an error page is not ours to store.
      await response.body?.cancel().catch(() => undefined);
      throw new OutboundMcpError("http_error", `The MCP server answered HTTP ${response.status}.`, {
        origin: this.origin(),
        status: response.status,
      });
    }

    const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
    if (Number.isFinite(declared) && declared > this.options.maxResponseBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new OutboundMcpError("response_too_large", "The MCP server response was too large.", {
        origin: this.origin(),
      });
    }

    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > this.options.maxResponseBytes) {
      throw new OutboundMcpError("response_too_large", "The MCP server response was too large.", {
        origin: this.origin(),
      });
    }

    // 202/204 is the correct answer to a notification.
    if (!text.trim()) return null;

    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    const decoded = contentType.includes("text/event-stream")
      ? decodeSse(text, payload.id as number | string | undefined)
      : decodeJson(text);

    if (decoded === undefined) {
      throw new OutboundMcpError("protocol_error", "The MCP server sent an unreadable response.", {
        origin: this.origin(),
      });
    }
    return decoded;
  }
}

function decodeJson(text: string): JsonRpcSuccess | JsonRpcFailure | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object") {
      return parsed as JsonRpcSuccess | JsonRpcFailure;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Pulls the one JSON-RPC message that answers `id` out of an SSE body.
 *
 * A server may interleave notifications and the reply, and may split a `data:`
 * payload across several lines. Lines are joined per event, `[DONE]`-style
 * sentinels are ignored, and the first message matching the id wins; without an
 * id (a notification) the last message is used.
 */
export function decodeSse(
  text: string,
  id?: number | string,
): JsonRpcSuccess | JsonRpcFailure | undefined {
  const events: string[] = [];
  let dataLines: string[] = [];

  const flush = () => {
    if (dataLines.length > 0) events.push(dataLines.join("\n"));
    dataLines = [];
  };

  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine === "") {
      flush();
      continue;
    }
    if (rawLine.startsWith("data:")) {
      dataLines.push(rawLine.slice(5).replace(/^ /, ""));
    }
    // `event:`, `id:` and `retry:` carry nothing this client needs.
  }
  flush();

  let last: JsonRpcSuccess | JsonRpcFailure | undefined;
  for (const event of events) {
    if (event.trim() === "[DONE]") continue;
    let parsed: JsonRpcSuccess | JsonRpcFailure | undefined;
    try {
      parsed = JSON.parse(event) as JsonRpcSuccess | JsonRpcFailure;
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    last = parsed;
    if (id !== undefined && "id" in parsed && parsed.id === id) return parsed;
  }
  return id === undefined ? last : last && !("id" in last) ? last : undefined;
}

function normalizeTool(entry: unknown): OutboundMcpTool | null {
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!name || name.length > 128) return null;
  return {
    description: typeof record.description === "string" ? record.description.slice(0, 2000) : undefined,
    inputSchema: record.inputSchema ?? { properties: {}, type: "object" },
    name,
    title: typeof record.title === "string" ? record.title.slice(0, 200) : undefined,
  };
}
