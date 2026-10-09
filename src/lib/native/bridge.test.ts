import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NativeBridgeError,
  createNativeBridgeClient,
  createRequestId,
  type BridgeTransport,
  type NativeBridgeClient,
} from "./bridge";
import { parseNativeEnvelope } from "./bridge-contract";

describe("createRequestId", () => {
  it("produces 32 hex characters that the app's id rule accepts", () => {
    const id = createRequestId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(parseNativeEnvelope({ v: 1, kind: "request", id, command: "app.info", payload: {} })).not.toBeNull();
  });

  it("produces a different id on each call", () => {
    const ids = new Set(Array.from({ length: 50 }, () => createRequestId()));
    expect(ids.size).toBe(50);
  });
});

const APP_INFO = {
  appVersionName: "1.0.0",
  appVersionCode: 7,
  environment: "staging",
  bridgeVersion: 1,
  capabilities: ["notifications"],
};

function fakeTransport() {
  const sent: Array<Record<string, unknown>> = [];
  let handler: ((value: unknown) => void) | null = null;
  const close = vi.fn();
  const transport: BridgeTransport = {
    send: (envelope) => {
      sent.push(envelope as Record<string, unknown>);
    },
    onMessage: (next) => {
      handler = next;
    },
    close,
  };
  return {
    transport,
    sent,
    close,
    deliver(value: unknown) {
      handler?.(value);
    },
  };
}

function setup(overrides: Partial<Parameters<typeof createNativeBridgeClient>[0]> = {}) {
  const channel = fakeTransport();
  let counter = 0;
  const client: NativeBridgeClient = createNativeBridgeClient({
    transport: channel.transport,
    timeoutMs: 1000,
    createId: () => `req-${++counter}`,
    ...overrides,
  });
  return { ...channel, client };
}

describe("createNativeBridgeClient", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends an allowlisted request and resolves with the parsed result when the id matches", async () => {
    const { client, sent, deliver } = setup();
    const pending = client.request("app.info");
    expect(sent).toEqual([{ v: 1, kind: "request", id: "req-1", command: "app.info", payload: {} }]);

    deliver({ v: 1, kind: "response", id: "req-1", ok: true, result: APP_INFO });
    await expect(pending).resolves.toEqual(APP_INFO);
  });

  it("rejects with the native error code when the app answers with an error", async () => {
    const { client, deliver } = setup();
    const pending = client.request("notifications.status");
    deliver({ v: 1, kind: "response", id: "req-1", ok: false, error: { code: "permission_denied", message: "no" } });
    await expect(pending).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("rejects with invalid_payload when the app sends a result that does not match the command", async () => {
    const { client, deliver } = setup();
    const pending = client.request("notifications.status");
    deliver({ v: 1, kind: "response", id: "req-1", ok: true, result: APP_INFO });
    await expect(pending).rejects.toMatchObject({ code: "invalid_payload" });
  });

  it("times out a request the app never answers", async () => {
    const { client } = setup();
    const pending = client.request("app.info");
    const assertion = expect(pending).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it("ignores a response whose id matches no pending request", async () => {
    const { client, deliver } = setup();
    const pending = client.request("app.info");
    deliver({ v: 1, kind: "response", id: "req-999", ok: true, result: APP_INFO });
    deliver({ v: 1, kind: "response", id: "req-1", ok: true, result: APP_INFO });
    await expect(pending).resolves.toEqual(APP_INFO);
  });

  it("ignores a second response for the same request", async () => {
    const { client, deliver } = setup();
    const pending = client.request("app.info");
    deliver({ v: 1, kind: "response", id: "req-1", ok: true, result: APP_INFO });
    deliver({ v: 1, kind: "response", id: "req-1", ok: false, error: { code: "native_failure" } });
    await expect(pending).resolves.toEqual(APP_INFO);
  });

  it("drops frames from a different protocol version and leaves the request pending", async () => {
    const { client, deliver } = setup();
    const pending = client.request("app.info");
    deliver({ v: 2, kind: "response", id: "req-1", ok: true, result: APP_INFO });
    const assertion = expect(pending).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it("refuses a command outside the allowlist without sending anything", async () => {
    const { client, sent } = setup();
    await expect(client.request("shell.exec" as never)).rejects.toMatchObject({ code: "unknown_command" });
    expect(sent).toEqual([]);
  });

  it("reports send_failure as channel_closed when the transport throws", async () => {
    const channel = fakeTransport();
    channel.transport.send = () => {
      throw new Error("port is closed");
    };
    const client = createNativeBridgeClient({ transport: channel.transport, createId: () => "req-1" });
    await expect(client.request("app.info")).rejects.toMatchObject({ code: "channel_closed" });
  });

  it("delivers a bridge.ready event to its subscribers, with the payload parsed", () => {
    const { client, deliver } = setup();
    const seen: unknown[] = [];
    client.onEvent("bridge.ready", (info) => seen.push(info));
    deliver({ v: 1, kind: "event", name: "bridge.ready", payload: APP_INFO });
    expect(seen).toEqual([APP_INFO]);
  });

  it("drops an event whose payload does not match the contract", () => {
    const { client, deliver } = setup();
    const seen: unknown[] = [];
    client.onEvent("bridge.ready", (info) => seen.push(info));
    deliver({ v: 1, kind: "event", name: "bridge.ready", payload: { permission: "granted" } });
    expect(seen).toEqual([]);
  });

  it("stops delivering an event after the listener unsubscribes", () => {
    const { client, deliver } = setup();
    const seen: unknown[] = [];
    const unsubscribe = client.onEvent("bridge.ready", (info) => seen.push(info));
    unsubscribe();
    deliver({ v: 1, kind: "event", name: "bridge.ready", payload: APP_INFO });
    expect(seen).toEqual([]);
  });

  it("rejects everything still pending with channel_closed, closes the transport once, and refuses new requests", async () => {
    const { client, close } = setup();
    const first = client.request("app.info");
    const second = client.request("notifications.status");

    client.close();
    client.close();

    await expect(first).rejects.toBeInstanceOf(NativeBridgeError);
    await expect(first).rejects.toMatchObject({ code: "channel_closed" });
    await expect(second).rejects.toMatchObject({ code: "channel_closed" });
    await expect(client.request("app.info")).rejects.toMatchObject({ code: "channel_closed" });
    expect(close).toHaveBeenCalledTimes(1);
    expect(client.closed).toBe(true);
  });

  it("ignores frames that arrive after close", () => {
    const { client, deliver } = setup();
    const seen: unknown[] = [];
    client.onEvent("bridge.ready", (info) => seen.push(info));
    client.close();
    deliver({ v: 1, kind: "event", name: "bridge.ready", payload: APP_INFO });
    expect(seen).toEqual([]);
  });

  it("does not let a timer fire after the request has already settled", async () => {
    const { client, deliver } = setup();
    const pending = client.request("app.info");
    deliver({ v: 1, kind: "response", id: "req-1", ok: true, result: APP_INFO });
    await expect(pending).resolves.toEqual(APP_INFO);
    await vi.advanceTimersByTimeAsync(5000);
    expect(vi.getTimerCount()).toBe(0);
  });
});
