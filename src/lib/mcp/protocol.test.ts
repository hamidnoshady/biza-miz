import { describe, expect, it } from "vitest";
import {
  JSON_RPC_ERRORS,
  LATEST_PROTOCOL_VERSION,
  MAX_BATCH_MESSAGES,
  SUPPORTED_PROTOCOL_VERSIONS,
  initializeResult,
  negotiateProtocolVersion,
  parseBody,
  parseMessage,
  toolResult,
} from "./protocol";

describe("parseMessage", () => {
  it("tells a request from a notification by the presence of an id", () => {
    // Load-bearing: answering a notification is a protocol violation, and a
    // client that gets a response to notifications/initialized treats the
    // whole session as broken.
    expect(parseMessage({ jsonrpc: "2.0", method: "notifications/initialized" })).toEqual({
      kind: "notification",
      method: "notifications/initialized",
      params: {},
    });
    expect(parseMessage({ jsonrpc: "2.0", id: 1, method: "ping" })).toEqual({
      kind: "request",
      id: 1,
      method: "ping",
      params: {},
    });
  });

  it("treats an explicit null id as a notification, not as a request with id null", () => {
    expect(parseMessage({ jsonrpc: "2.0", id: null, method: "ping" }).kind).toBe("notification");
  });

  it("rejects anything that is not JSON-RPC 2.0", () => {
    expect(parseMessage({ jsonrpc: "1.0", id: 1, method: "ping" }).kind).toBe("invalid");
    expect(parseMessage({ id: 1, method: "ping" }).kind).toBe("invalid");
    expect(parseMessage("ping").kind).toBe("invalid");
    expect(parseMessage(null).kind).toBe("invalid");
  });

  it("requires a non-empty method name", () => {
    expect(parseMessage({ jsonrpc: "2.0", id: 1 }).kind).toBe("invalid");
    expect(parseMessage({ jsonrpc: "2.0", id: 1, method: "" }).kind).toBe("invalid");
  });

  it("keeps a malformed message's id so the error can be correlated", () => {
    const parsed = parseMessage({ jsonrpc: "1.0", id: "abc", method: "ping" });
    expect(parsed).toMatchObject({ kind: "invalid", id: "abc" });
  });

  it("defaults non-object params to an empty object rather than throwing later", () => {
    expect(parseMessage({ jsonrpc: "2.0", id: 1, method: "ping", params: "x" })).toMatchObject({
      params: {},
    });
  });
});

describe("parseBody", () => {
  it("accepts a single message and a batch", () => {
    expect(parseBody({ jsonrpc: "2.0", id: 1, method: "ping" })).toMatchObject({ batch: false });
    expect(
      parseBody([
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { jsonrpc: "2.0", method: "notifications/initialized" },
      ]),
    ).toMatchObject({ batch: true });
  });

  it("refuses an empty batch, which JSON-RPC calls an invalid request", () => {
    expect(parseBody([])).toBeNull();
  });

  it("refuses a batch past the cap — a load attempt, not a conversation", () => {
    // Issue #883 P1-9: every message in a batch costs reads (and may cost
    // writes), so the batch itself is bounded rather than each message.
    const pings = Array.from({ length: MAX_BATCH_MESSAGES }, (_, i) => ({
      jsonrpc: "2.0",
      id: i,
      method: "ping",
    }));
    expect(parseBody(pings)).toMatchObject({ batch: true });
    expect(parseBody([...pings, { jsonrpc: "2.0", id: MAX_BATCH_MESSAGES, method: "ping" }]))
      .toBeNull();
  });
});

describe("negotiateProtocolVersion", () => {
  it("echoes a version we implement", () => {
    for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
      expect(negotiateProtocolVersion(version)).toBe(version);
    }
  });

  it("never echoes an unknown version back", () => {
    // Echoing claims support this server does not have, and the failure then
    // surfaces much later as a call the client cannot parse.
    expect(negotiateProtocolVersion("2099-01-01")).toBe(LATEST_PROTOCOL_VERSION);
    expect(negotiateProtocolVersion(undefined)).toBe(LATEST_PROTOCOL_VERSION);
    expect(negotiateProtocolVersion(7)).toBe(LATEST_PROTOCOL_VERSION);
  });
});

describe("initializeResult", () => {
  it("advertises no listChanged, because nothing is ever pushed", () => {
    const result = initializeResult({
      protocolVersion: LATEST_PROTOCOL_VERSION,
      title: "کافه ونک",
      version: "abc123",
      instructions: "…",
    });
    expect(result.capabilities.tools.listChanged).toBe(false);
    expect(result.capabilities.resources.listChanged).toBe(false);
    expect(result.capabilities.resources.subscribe).toBe(false);
    expect(result.capabilities.prompts.listChanged).toBe(false);
    expect(result.serverInfo.title).toBe("کافه ونک");
  });
});

describe("toolResult", () => {
  it("fills both content and structuredContent", () => {
    // A client that renders only `content` must not see an empty answer, and a
    // model that gets prose where it expected fields answers worse.
    const result = toolResult({ revenue: 1_200_000 });
    expect(result.structuredContent).toEqual({ revenue: 1_200_000 });
    expect(result.content[0].text).toContain("1200000");
    expect(result.isError).toBe(false);
  });

  it("wraps a non-object payload so structuredContent is always an object", () => {
    expect(toolResult([1, 2]).structuredContent).toEqual({ value: [1, 2] });
  });

  it("carries the tool-level error flag", () => {
    expect(toolResult({ error: "no such item" }, true).isError).toBe(true);
  });
});

describe("error codes", () => {
  it("uses the standard JSON-RPC codes and invents none", () => {
    expect(JSON_RPC_ERRORS).toEqual({
      parseError: -32700,
      invalidRequest: -32600,
      methodNotFound: -32601,
      invalidParams: -32602,
      internalError: -32603,
    });
  });
});
