import { describe, expect, it } from "vitest";
import {
  NATIVE_BRIDGE_VERSION,
  NATIVE_CAPABILITY_MIN_BRIDGE,
  buildRequestEnvelope,
  parseAppInfo,
  parseCommandResult,
  parseEventPayload,
  parseNativeEnvelope,
  parseNotificationStatus,
} from "./bridge-contract";

const APP_INFO = {
  appVersionName: "1.0.0",
  appVersionCode: 1,
  environment: "production",
  bridgeVersion: 1,
  capabilities: ["notifications"],
};

describe("parseAppInfo", () => {
  it("accepts a well-formed app.info result", () => {
    expect(parseAppInfo(APP_INFO)).toEqual(APP_INFO);
  });

  it("drops capability keys this page does not know, so a newer app cannot break an older page", () => {
    const parsed = parseAppInfo({ ...APP_INFO, capabilities: ["notifications", "hologram.projector", 42] });
    expect(parsed?.capabilities).toEqual(["notifications"]);
  });

  it("removes duplicate capability keys", () => {
    const parsed = parseAppInfo({ ...APP_INFO, capabilities: ["notifications", "notifications"] });
    expect(parsed?.capabilities).toEqual(["notifications"]);
  });

  it.each([
    ["an empty version name", { appVersionName: "" }],
    ["a version name over 32 characters", { appVersionName: "x".repeat(33) }],
    ["a non-integer version code", { appVersionCode: 1.5 }],
    ["a zero version code", { appVersionCode: 0 }],
    ["an unknown environment", { environment: "qa" }],
    ["a missing bridge version", { bridgeVersion: undefined }],
    ["capabilities that are not an array", { capabilities: "notifications" }],
  ])("rejects %s", (_label, override) => {
    expect(parseAppInfo({ ...APP_INFO, ...override })).toBeNull();
  });

  it("rejects non-objects", () => {
    expect(parseAppInfo(null)).toBeNull();
    expect(parseAppInfo("app")).toBeNull();
    expect(parseAppInfo([APP_INFO])).toBeNull();
  });
});

describe("parseNotificationStatus", () => {
  it.each(["granted", "denied", "not_determined"])("accepts the %s permission state", (permission) => {
    expect(parseNotificationStatus({ permission })).toEqual({ permission });
  });

  it("rejects a permission state the contract does not define", () => {
    expect(parseNotificationStatus({ permission: "maybe" })).toBeNull();
  });
});

describe("parseCommandResult and parseEventPayload", () => {
  it("checks a result against the shape of the command that produced it", () => {
    expect(parseCommandResult("app.info", APP_INFO)).toEqual(APP_INFO);
    expect(parseCommandResult("notifications.status", APP_INFO)).toBeNull();
  });

  it("checks an event payload against its declared shape", () => {
    expect(parseEventPayload("bridge.ready", APP_INFO)).toEqual(APP_INFO);
    expect(parseEventPayload("bridge.ready", { permission: "granted" })).toBeNull();
  });
});

describe("parseNativeEnvelope", () => {
  it("accepts a response with a result", () => {
    expect(
      parseNativeEnvelope({ v: NATIVE_BRIDGE_VERSION, kind: "response", id: "abc-123", ok: true, result: APP_INFO }),
    ).toEqual({ v: 1, kind: "response", id: "abc-123", ok: true, result: APP_INFO });
  });

  it("maps an unrecognised error code to native_failure rather than trusting the app's wording", () => {
    const parsed = parseNativeEnvelope({
      v: 1,
      kind: "response",
      id: "abc",
      ok: false,
      error: { code: "something_new" },
    });
    expect(parsed).toMatchObject({ ok: false, error: { code: "native_failure" } });
  });

  it("keeps a known error code and truncates an overlong message", () => {
    const parsed = parseNativeEnvelope({
      v: 1,
      kind: "response",
      id: "abc",
      ok: false,
      error: { code: "permission_denied", message: "m".repeat(500) },
    });
    expect(parsed).toMatchObject({ ok: false, error: { code: "permission_denied" } });
    if (parsed?.kind !== "response" || parsed.ok) throw new Error("expected an error response");
    expect(parsed.error?.message).toHaveLength(200);
  });

  it("refuses a frame from a different protocol version", () => {
    expect(
      parseNativeEnvelope({ v: NATIVE_BRIDGE_VERSION + 1, kind: "response", id: "abc", ok: true, result: APP_INFO }),
    ).toBeNull();
  });

  it("refuses a success response without a result", () => {
    expect(parseNativeEnvelope({ v: 1, kind: "response", id: "abc", ok: true })).toBeNull();
  });

  it.each([
    ["an id with spaces", "not valid"],
    ["an empty id", ""],
    ["an id over 64 characters", "a".repeat(65)],
    ["a non-string id", 7],
  ])("refuses a response with %s", (_label, id) => {
    expect(parseNativeEnvelope({ v: 1, kind: "response", id, ok: true, result: APP_INFO })).toBeNull();
  });

  it("refuses a request for a command outside the allowlist", () => {
    expect(
      parseNativeEnvelope({ v: 1, kind: "request", id: "abc", command: "shell.exec", payload: {} }),
    ).toBeNull();
  });

  it("refuses a request whose payload is not an object", () => {
    expect(
      parseNativeEnvelope({ v: 1, kind: "request", id: "abc", command: "app.info", payload: "x" }),
    ).toBeNull();
  });

  it("refuses an event name outside the allowlist", () => {
    expect(parseNativeEnvelope({ v: 1, kind: "event", name: "device.wiped", payload: {} })).toBeNull();
  });

  it("refuses an unknown kind and non-object frames", () => {
    expect(parseNativeEnvelope({ v: 1, kind: "push", id: "abc" })).toBeNull();
    expect(parseNativeEnvelope("hello")).toBeNull();
    expect(parseNativeEnvelope(undefined)).toBeNull();
  });
});

describe("buildRequestEnvelope", () => {
  it("builds the request shape the app expects", () => {
    expect(buildRequestEnvelope("req-1", "app.info")).toEqual({
      v: 1,
      kind: "request",
      id: "req-1",
      command: "app.info",
      payload: {},
    });
  });
});

describe("NATIVE_CAPABILITY_MIN_BRIDGE", () => {
  it("is frozen so a caller cannot widen a capability at runtime", () => {
    expect(Object.isFrozen(NATIVE_CAPABILITY_MIN_BRIDGE)).toBe(true);
  });
});
