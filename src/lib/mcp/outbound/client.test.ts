import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { OutboundMcpClient, OutboundMcpError, decodeSse } from "./client";

/**
 * The client against a real socket, not a mocked `fetch`.
 *
 * A transport test that stubs `fetch` proves the shape of a request and nothing
 * about the things that actually break in production: an SSE answer instead of
 * JSON, a session id that must be echoed, a redirect, a body bigger than the cap.
 * A throwaway HTTP server on loopback is a few lines and exercises all of them.
 *
 * `resolveTarget` is overridden to a no-op here on purpose: `guard.ts` has its own
 * tests, and the guard refuses loopback in production by design. Everything the
 * client does *after* the target check is what this file covers.
 */

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

let server: Server;
let baseUrl = "";
let handler: Handler;
const seen: Array<{ body: string; headers: IncomingMessage["headers"]; url: string }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => {
      seen.push({ body, headers: req.headers, url: req.url ?? "" });
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  seen.length = 0;
  handler = () => undefined;
});

const client = (overrides: Partial<ConstructorParameters<typeof OutboundMcpClient>[0]> = {}) =>
  new OutboundMcpClient({
    resolveTarget: async () => undefined,
    url: baseUrl,
    ...overrides,
  });

const json = (res: ServerResponse, payload: unknown, status = 200) => {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
};

const acceptInitialize = (res: ServerResponse, id: unknown, sessionId = "session-1") => {
  res.setHeader("mcp-session-id", sessionId);
  json(res, {
    id,
    jsonrpc: "2.0",
    result: {
      capabilities: { tools: {} },
      protocolVersion: "2025-06-18",
      serverInfo: { name: "mock-cms", version: "2.1.0" },
    },
  });
};

describe("initialize", () => {
  it("negotiates, records the server, and echoes the session id afterwards", async () => {
    handler = (req, res, body) => {
      const payload = JSON.parse(body) as { id?: unknown; method: string };
      if (payload.method === "initialize") {
        acceptInitialize(res, payload.id);
        return;
      }
      // The initialized notification: 202 with no body.
      res.writeHead(202);
      res.end();
    };

    const mcp = client({ bearerToken: "secret-token" });
    const info = await mcp.initialize();

    expect(info).toMatchObject({
      name: "mock-cms",
      protocolVersion: "2025-06-18",
      version: "2.1.0",
    });

    // Two requests: initialize, then notifications/initialized — and the second one
    // carries the session the first answered with.
    expect(seen).toHaveLength(2);
    expect(seen[0]!.headers.authorization).toBe("Bearer secret-token");
    expect(seen[1]!.headers["mcp-session-id"]).toBe("session-1");
    expect(JSON.parse(seen[1]!.body)).toMatchObject({ method: "notifications/initialized" });
  });

  it("sends no Authorization header when the server has no credential", async () => {
    handler = (req, res, body) => {
      const payload = JSON.parse(body) as { id?: unknown; method: string };
      if (payload.method === "initialize") return acceptInitialize(res, payload.id);
      res.writeHead(202);
      res.end();
    };

    await client().initialize();

    expect(seen[0]!.headers.authorization).toBeUndefined();
  });

  it("decodes an SSE answer to initialize", async () => {
    handler = (req, res, body) => {
      const payload = JSON.parse(body) as { id?: unknown; method: string };
      if (payload.method !== "initialize") {
        res.writeHead(202);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: message\n");
      res.write('data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n');
      res.write("event: message\n");
      res.write(
        `data: ${JSON.stringify({
          id: payload.id,
          jsonrpc: "2.0",
          result: {
            capabilities: {},
            protocolVersion: "2025-06-18",
            serverInfo: { name: "sse-cms", version: "1.0.0" },
          },
        })}\n\n`,
      );
      res.end();
    };

    const info = await client().initialize();
    expect(info.name).toBe("sse-cms");
  });
});

describe("tools/list", () => {
  beforeAll(() => undefined);

  it("refuses before initialize", async () => {
    await expect(client().listTools()).rejects.toMatchObject({ code: "not_initialized" });
  });

  it("follows nextCursor pages and caps the tool name shape", async () => {
    handler = (req, res, body) => {
      const payload = JSON.parse(body) as { id?: unknown; method: string; params?: { cursor?: string } };
      if (payload.method === "initialize") return acceptInitialize(res, payload.id);

      if (payload.method === "tools/list" && !payload.params?.cursor) {
        return json(res, {
          id: payload.id,
          jsonrpc: "2.0",
          result: {
            nextCursor: "page-2",
            tools: [
              {
                description: "Read pages",
                inputSchema: { properties: { limit: { type: "number" } }, type: "object" },
                name: "findPages",
                title: "Find pages",
              },
              // A nameless entry is not a tool; it must not become one.
              { description: "broken" },
            ],
          },
        });
      }
      if (payload.method === "tools/list") {
        return json(res, {
          id: payload.id,
          jsonrpc: "2.0",
          result: { tools: [{ inputSchema: { type: "object" }, name: "cms_site_context" }] },
        });
      }
      res.writeHead(202);
      res.end();
    };

    const mcp = client();
    await mcp.initialize();
    const tools = await mcp.listTools();

    expect(tools.map((tool) => tool.name)).toEqual(["findPages", "cms_site_context"]);
    expect(tools[0]).toMatchObject({ description: "Read pages", title: "Find pages" });
    // The schema is the server's, passed through untouched.
    expect(tools[0]!.inputSchema).toEqual({
      properties: { limit: { type: "number" } },
      type: "object",
    });
    expect(tools[1]!.title).toBeUndefined();
  });
});

describe("tools/call", () => {
  it("returns the MCP result untouched, including isError", async () => {
    handler = (req, res, body) => {
      const payload = JSON.parse(body) as { id?: unknown; method: string };
      if (payload.method === "initialize") return acceptInitialize(res, payload.id);
      if (payload.method === "tools/call") {
        return json(res, {
          id: payload.id,
          jsonrpc: "2.0",
          result: {
            content: [{ text: '{"ok":true}', type: "text" }],
            isError: true,
          },
        });
      }
      res.writeHead(202);
      res.end();
    };

    const mcp = client();
    await mcp.initialize();
    const result = await mcp.callTool("findPages", { limit: 5 });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ text: '{"ok":true}', type: "text" }]);

    const call = seen.find((request) => JSON.parse(request.body).method === "tools/call");
    expect(JSON.parse(call!.body)).toMatchObject({
      params: { arguments: { limit: 5 }, name: "findPages" },
    });
  });

  it("surfaces a JSON-RPC error with its code and no echoed token", async () => {
    handler = (req, res, body) => {
      const payload = JSON.parse(body) as { id?: unknown; method: string };
      if (payload.method === "initialize") return acceptInitialize(res, payload.id);
      if (payload.method === "tools/call") {
        return json(res, {
          error: { code: -32602, message: "Unknown tool: deletePages" },
          id: payload.id,
          jsonrpc: "2.0",
        });
      }
      res.writeHead(202);
      res.end();
    };

    const mcp = client({ bearerToken: "secret-token" });
    await mcp.initialize();

    const failure = await mcp.callTool("deletePages", {}).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(OutboundMcpError);
    expect(failure).toMatchObject({ code: "rpc_error", rpcCode: -32602 });
    expect(String((failure as Error).message)).toContain("Unknown tool");
    expect(String((failure as Error).message)).not.toContain("secret-token");
  });
});

describe("transport limits", () => {
  it("times out instead of hanging a turn", async () => {
    handler = () => {
      // Never answer.
    };

    const mcp = client({ timeoutMs: 40 });
    const failure = await mcp.initialize().catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "timeout" });
  });

  it("refuses an oversized body", async () => {
    handler = (_req, res, body) => {
      const payload = JSON.parse(body) as { id?: unknown; method: string };
      if (payload.method !== "initialize") {
        res.writeHead(202);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: payload.id, jsonrpc: "2.0", result: { pad: "x".repeat(4096) } }));
    };

    const mcp = client({ maxResponseBytes: 512 });
    const failure = await mcp.initialize().catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "response_too_large" });
  });

  it("maps an HTTP failure to a status-only error", async () => {
    handler = (_req, res) => {
      res.writeHead(500, { "content-type": "text/html" });
      res.end("<html>stack trace with secret-token inside</html>");
    };

    const failure = await client({ bearerToken: "secret-token" })
      .initialize()
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "http_error", status: 500 });
    expect(String((failure as Error).message)).not.toContain("secret-token");
    expect(String((failure as Error).message)).not.toContain("stack trace");
  });

  it("does not follow a redirect", async () => {
    handler = (_req, res) => {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
      res.end();
    };

    const failure = await client().initialize().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(OutboundMcpError);
    expect((failure as OutboundMcpError).code).toBe("network_error");
  });

  it("refuses a target the policy does not allow, before any request", async () => {
    handler = (_req, res) => json(res, { jsonrpc: "2.0", result: {} });

    const mcp = new OutboundMcpClient({
      // No policy override and an empty allowlist: the guard refuses.
      url: "https://cms.example.com/api/mcp",
    });

    const failure = await mcp.initialize().catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "target_refused" });
    expect(seen).toHaveLength(0);
  });
});

describe("decodeSse", () => {
  it("joins multi-line data and picks the message with the matching id", () => {
    const text = [
      'data: {"jsonrpc":"2.0","method":"notifications/message"}',
      "",
      "data: {",
      'data:   "jsonrpc":"2.0","id":7,"result":{"ok":true}',
      "data: }",
      "",
    ].join("\n");

    expect(decodeSse(text, 7)).toMatchObject({ id: 7, result: { ok: true } });
  });

  it("ignores a sentinel and unparseable events", () => {
    const text = ["data: [DONE]", "", "data: not-json", "", 'data: {"id":1,"result":{}}'].join("\n");
    expect(decodeSse(text, 1)).toMatchObject({ id: 1 });
  });

  it("returns nothing when the matching id never arrives", () => {
    expect(decodeSse('data: {"id":2,"result":{}}', 3)).toBeUndefined();
  });
});
