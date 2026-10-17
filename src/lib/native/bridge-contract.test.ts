import { describe, expect, it } from "vitest";
import {
  NATIVE_BRIDGE_VERSION,
  NATIVE_CAPABILITY_MIN_BRIDGE,
  buildRequestEnvelope,
  parseAppInfo,
  parseCommandResult,
  parseDeviceIdentity,
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

describe("parseDeviceIdentity", () => {
  it("accepts a well-formed installation id", () => {
    expect(parseDeviceIdentity({ installationId: "a1b2c3d4-e5f6-4a3b-9c8d-1234567890ab" })).toEqual({
      installationId: "a1b2c3d4-e5f6-4a3b-9c8d-1234567890ab",
    });
  });

  it.each([
    ["too short", "short"],
    ["too long", "x".repeat(129)],
    ["containing characters outside the allowlist", "not/valid"],
  ])("rejects an installation id that is %s", (_label, installationId) => {
    expect(parseDeviceIdentity({ installationId })).toBeNull();
  });

  it("rejects non-objects and a missing field", () => {
    expect(parseDeviceIdentity(null)).toBeNull();
    expect(parseDeviceIdentity({})).toBeNull();
  });
});

describe("parseCommandResult and parseEventPayload", () => {
  it("checks a result against the shape of the command that produced it", () => {
    expect(parseCommandResult("app.info", APP_INFO)).toEqual(APP_INFO);
    expect(parseCommandResult("notifications.status", APP_INFO)).toBeNull();
    expect(parseCommandResult("device.identity", { installationId: "a1b2c3d4e5f64789" })).toEqual({
      installationId: "a1b2c3d4e5f64789",
    });
    expect(
      parseCommandResult("notifications.register", {
        permission: "granted",
        fcmToken: "fcm_token_1234567890abcdef",
        channels: ["orders", "crm", "unknown_channel"],
        pushProvider: "fcm",
      }),
    ).toEqual({
      permission: "granted",
      fcmToken: "fcm_token_1234567890abcdef",
      channels: ["orders", "crm"],
      pushProvider: "fcm",
    });
    expect(
      parseCommandResult("biometric.status", {
        available: true,
        enrolled: true,
        strength: "strong",
        credentialManagerAvailable: true,
      }),
    ).toEqual({
      available: true,
      enrolled: true,
      strength: "strong",
      credentialManagerAvailable: true,
    });
    expect(
      parseCommandResult("biometric.authenticate", {
        authenticated: true,
        method: "biometric",
        verifiedAt: "2026-10-15T10:00:00Z",
        challengeId: "chal-1",
      }),
    ).toEqual({
      authenticated: true,
      method: "biometric",
      verifiedAt: "2026-10-15T10:00:00Z",
      challengeId: "chal-1",
    });
    expect(
      parseCommandResult("scanner.scan", {
        value: "6260000000001",
        format: "ean_13",
        source: "code_scanner",
      }),
    ).toEqual({
      value: "6260000000001",
      format: "ean_13",
      source: "code_scanner",
    });
    expect(
      parseCommandResult("printer.discover", {
        printers: [
          {
            id: "system_print",
            name: "Android System Print",
            transport: "system_print",
            address: null,
            paperWidthMm: 80,
            online: true,
          },
        ],
        bluetoothPermission: "not_determined",
      }),
    ).toEqual({
      printers: [
        {
          id: "system_print",
          name: "Android System Print",
          transport: "system_print",
          address: null,
          paperWidthMm: 80,
          online: true,
        },
      ],
      bluetoothPermission: "not_determined",
    });
    expect(
      parseCommandResult("crm.callerId.status", {
        roleHeld: true,
        supported: true,
        cachedCustomerCount: 14,
        businessId: "biz-1",
        lastSyncedAt: "2026-10-15T10:00:00Z",
      }),
    ).toEqual({
      roleHeld: true,
      supported: true,
      cachedCustomerCount: 14,
      businessId: "biz-1",
      lastSyncedAt: "2026-10-15T10:00:00Z",
    });
    expect(
      parseCommandResult("sync.status", {
        scheduled: true,
        networkAvailable: true,
        businessId: "biz-1",
        pendingCount: 2,
        lastSyncedAt: "2026-10-15T10:00:00Z",
        revoked: false,
      }),
    ).toEqual({
      scheduled: true,
      networkAvailable: true,
      businessId: "biz-1",
      pendingCount: 2,
      lastSyncedAt: "2026-10-15T10:00:00Z",
      revoked: false,
    });
    expect(
      parseCommandResult("sync.status", {
        scheduled: true,
        state: "waiting_for_app",
        waitingForApp: true,
        networkAvailable: true,
        businessId: "biz-1",
        pendingCount: 3,
        lastSyncedAt: null,
        pendingSyncRequestId: "syncreq_biz1_123",
        installationId: "inst-1234567890",
        sessionGeneration: 2,
        revoked: false,
      }),
    ).toEqual({
      scheduled: true,
      state: "waiting_for_app",
      waitingForApp: true,
      networkAvailable: true,
      businessId: "biz-1",
      pendingCount: 3,
      lastSyncedAt: null,
      pendingSyncRequestId: "syncreq_biz1_123",
      installationId: "inst-1234567890",
      sessionGeneration: 2,
      revoked: false,
    });
    expect(
      parseCommandResult("sync.acknowledge", {
        accepted: true,
        reason: "acknowledged",
        businessId: "biz-1",
        syncRequestId: "syncreq_biz1_123",
        flushedCount: 3,
        remainingCount: 0,
        lastSyncedAt: "2026-10-16T08:00:00.000Z",
        state: "idle",
      }),
    ).toEqual({
      accepted: true,
      reason: "acknowledged",
      businessId: "biz-1",
      syncRequestId: "syncreq_biz1_123",
      flushedCount: 3,
      remainingCount: 0,
      lastSyncedAt: "2026-10-16T08:00:00.000Z",
      state: "idle",
    });
    expect(
      parseCommandResult("sync.acknowledge", {
        accepted: true,
        reason: "unknown_reason",
        businessId: "biz-1",
        syncRequestId: "syncreq_biz1_123",
        flushedCount: 1,
        remainingCount: 0,
        lastSyncedAt: null,
        state: "idle",
      }),
    ).toBeNull();
  });

  it("checks an event payload against its declared shape", () => {
    expect(parseEventPayload("bridge.ready", APP_INFO)).toEqual(APP_INFO);
    expect(parseEventPayload("bridge.ready", { permission: "granted" })).toBeNull();
    expect(
      parseEventPayload("navigation.deepLink", {
        path: "/accounting/orders",
        notificationCategory: "orders",
        businessId: "biz-1",
      }),
    ).toEqual({
      path: "/accounting/orders",
      notificationCategory: "orders",
      businessId: "biz-1",
    });
    expect(parseEventPayload("navigation.deepLink", { path: "//evil.example" })).toBeNull();
    expect(
      parseEventPayload("crm.callEnded", {
        phoneNormalized: "+989121234567",
        direction: "incoming",
        durationSeconds: 95,
        customerId: "cust-1",
        customerName: "رضا محمدی",
        endedAt: "2026-10-15T10:05:00Z",
      }),
    ).toEqual({
      phoneNormalized: "+989121234567",
      direction: "incoming",
      durationSeconds: 95,
      customerId: "cust-1",
      customerName: "رضا محمدی",
      endedAt: "2026-10-15T10:05:00Z",
    });
    expect(
      parseEventPayload("sync.reconcileRequested", {
        businessId: "biz-1",
        syncRequestId: "syncreq_biz1_123",
        pendingCount: 3,
        requestedAt: "2026-10-16T08:01:00.000Z",
        installationId: "inst-1234567890",
        sessionGeneration: 2,
      }),
    ).toEqual({
      businessId: "biz-1",
      syncRequestId: "syncreq_biz1_123",
      pendingCount: 3,
      requestedAt: "2026-10-16T08:01:00.000Z",
      installationId: "inst-1234567890",
      sessionGeneration: 2,
    });
    expect(
      parseEventPayload("sync.reconcileRequested", {
        businessId: "",
        syncRequestId: "bad id with spaces",
        pendingCount: 1,
        requestedAt: "2026-10-16T08:01:00.000Z",
      }),
    ).toBeNull();
  });
});

describe("parseNativeEnvelope", () => {
  it("accepts a response with a result", () => {
    expect(
      parseNativeEnvelope({ v: NATIVE_BRIDGE_VERSION, kind: "response", id: "abc-123", ok: true, result: APP_INFO }),
    ).toEqual({ v: NATIVE_BRIDGE_VERSION, kind: "response", id: "abc-123", ok: true, result: APP_INFO });
  });

  it("accepts backward-compatible v1 and v2 frames from older Android builds while rejecting v0", () => {
    expect(parseNativeEnvelope({ v: 1, kind: "response", id: "abc-1", ok: true, result: APP_INFO })).toMatchObject({
      v: 1,
      ok: true,
    });
    expect(parseNativeEnvelope({ v: 2, kind: "response", id: "abc-2", ok: true, result: APP_INFO })).toMatchObject({
      v: 2,
      ok: true,
    });
    expect(parseNativeEnvelope({ v: 0, kind: "response", id: "abc-0", ok: true, result: APP_INFO })).toBeNull();
  });

  it("maps an unrecognised error code to native_failure rather than trusting the app's wording", () => {
    const parsed = parseNativeEnvelope({
      v: NATIVE_BRIDGE_VERSION,
      kind: "response",
      id: "abc",
      ok: false,
      error: { code: "something_new" },
    });
    expect(parsed).toMatchObject({ ok: false, error: { code: "native_failure" } });
  });

  it("keeps a known error code and truncates an overlong message", () => {
    const parsed = parseNativeEnvelope({
      v: NATIVE_BRIDGE_VERSION,
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
    expect(parseNativeEnvelope({ v: NATIVE_BRIDGE_VERSION, kind: "response", id: "abc", ok: true })).toBeNull();
  });

  it.each([
    ["an id with spaces", "not valid"],
    ["an empty id", ""],
    ["an id over 64 characters", "a".repeat(65)],
    ["a non-string id", 7],
  ])("refuses a response with %s", (_label, id) => {
    expect(parseNativeEnvelope({ v: NATIVE_BRIDGE_VERSION, kind: "response", id, ok: true, result: APP_INFO })).toBeNull();
  });

  it("refuses a request for a command outside the allowlist", () => {
    expect(
      parseNativeEnvelope({ v: NATIVE_BRIDGE_VERSION, kind: "request", id: "abc", command: "shell.exec", payload: {} }),
    ).toBeNull();
  });

  it("refuses a request whose payload is not an object", () => {
    expect(
      parseNativeEnvelope({ v: NATIVE_BRIDGE_VERSION, kind: "request", id: "abc", command: "app.info", payload: "x" }),
    ).toBeNull();
  });

  it("refuses an event name outside the allowlist", () => {
    expect(parseNativeEnvelope({ v: NATIVE_BRIDGE_VERSION, kind: "event", name: "device.wiped", payload: {} })).toBeNull();
  });

  it("refuses an unknown kind and non-object frames", () => {
    expect(parseNativeEnvelope({ v: NATIVE_BRIDGE_VERSION, kind: "push", id: "abc" })).toBeNull();
    expect(parseNativeEnvelope("hello")).toBeNull();
    expect(parseNativeEnvelope(undefined)).toBeNull();
  });
});

describe("buildRequestEnvelope", () => {
  it("builds the request shape the app expects", () => {
    expect(buildRequestEnvelope("req-1", "app.info")).toEqual({
      v: NATIVE_BRIDGE_VERSION,
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
