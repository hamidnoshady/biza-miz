import { describe, expect, it, vi } from "vitest";
import { NativeBridgeError } from "./bridge";
import {
  authenticateWithNativeBiometric,
  buildPostCallActivityPayload,
  getNativeBiometricStatus,
  getNativeCallerIdStatus,
  getNativeSyncStatus,
  normalizeCallerPhone,
  pickedMediaFileToBrowserFile,
  registerNativePushNotifications,
  shareViaNativeOrWeb,
  syncNativeCallerIdCache,
  triggerNativeBackgroundSync,
  validatePickedMediaFile,
  validateTenantDeepLink,
} from "./capabilities-client";
import type { NativeRequest } from "@/components/native/native-provider";

describe("normalizeCallerPhone", () => {
  it("normalizes Iranian mobile numbers across local, +98, 0098, and Persian digits", () => {
    expect(normalizeCallerPhone("0912 345 6789")).toBe("+989123456789");
    expect(normalizeCallerPhone("۰۹۱۲۳۴۵۶۷۸۹")).toBe("+989123456789");
    expect(normalizeCallerPhone("+98 912-345-6789")).toBe("+989123456789");
    expect(normalizeCallerPhone("00989123456789")).toBe("+989123456789");
    expect(normalizeCallerPhone("9123456789")).toBe("+989123456789");
  });

  it("preserves international E.164 numbers and rejects empty/non-numeric strings", () => {
    expect(normalizeCallerPhone("+49 69 12345678")).toBe("+496912345678");
    expect(normalizeCallerPhone("   ")).toBe("");
    expect(normalizeCallerPhone("12")).toBe("");
  });
});

describe("validateTenantDeepLink", () => {
  it("allows relative internal paths when tenant matches or is unspecified", () => {
    expect(
      validateTenantDeepLink({
        path: "/accounting/orders?status=pending",
        activeBusinessId: "biz-1",
        targetBusinessId: "biz-1",
      }),
    ).toEqual({
      allowed: true,
      path: "/accounting/orders?status=pending",
    });
  });

  it("rejects protocol-relative URLs, external origins, and control characters", () => {
    expect(
      validateTenantDeepLink({
        path: "//evil.example/phish",
        activeBusinessId: "biz-1",
      }),
    ).toEqual({
      allowed: false,
      path: null,
      reason: "invalid_path",
    });
    expect(
      validateTenantDeepLink({
        path: "https://evil.example",
        activeBusinessId: "biz-1",
      }),
    ).toEqual({
      allowed: false,
      path: null,
      reason: "invalid_path",
    });
  });

  it("rejects deep links targeting a different tenant than the active business", () => {
    expect(
      validateTenantDeepLink({
        path: "/crm/customers/123",
        activeBusinessId: "biz-1",
        targetBusinessId: "biz-2",
      }),
    ).toEqual({
      allowed: false,
      path: null,
      reason: "tenant_mismatch",
    });
  });
});

describe("biometric & push notification helpers", () => {
  it("falls back cleanly when biometric.status is unavailable on the bridge", async () => {
    const request: NativeRequest = vi.fn(async () => {
      throw new NativeBridgeError("bridge_unavailable");
    });
    const status = await getNativeBiometricStatus(request);
    expect(status.available).toBe(false);
    expect(status.strength).toBe("none");
  });

  it("forwards biometric authentication options to biometric.authenticate", async () => {
    const request = vi.fn(async () => ({
      authenticated: true,
      method: "biometric" as const,
      verifiedAt: "2026-10-15T12:00:00Z",
      challengeId: "chal-99",
    })) as unknown as NativeRequest;

    const result = await authenticateWithNativeBiometric(request, {
      title: "ورود بیومتریک",
      challengeId: "chal-99",
    });
    expect(result.authenticated).toBe(true);
    expect(request).toHaveBeenCalledWith(
      "biometric.authenticate",
      expect.objectContaining({ title: "ورود بیومتریک", challengeId: "chal-99" }),
    );
  });

  it("falls back to notifications.status when an older v2 wrapper does not support notifications.register", async () => {
    const request = vi.fn(async (command: string) => {
      if (command === "notifications.register") {
        throw new NativeBridgeError("bridge_version_too_old");
      }
      return { permission: "granted" as const };
    }) as unknown as NativeRequest;

    const res = await registerNativePushNotifications(request, ["orders", "crm"]);
    expect(res).toEqual({
      permission: "granted",
      fcmToken: null,
      channels: [],
      pushProvider: "none",
    });
  });
});

describe("media picker validation & conversion", () => {
  it("validates MIME type, non-empty content, and 20 MB cap", () => {
    expect(
      validatePickedMediaFile({
        name: "invoice.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1024,
        base64Data: btoa("pdf-bytes"),
        source: "document_picker",
      }),
    ).toEqual({ valid: true });

    expect(
      validatePickedMediaFile({
        name: "script.exe",
        mimeType: "application/x-msdownload",
        sizeBytes: 120,
        base64Data: btoa("exe"),
        source: "document_picker",
      }),
    ).toEqual({ valid: false, reason: "invalid_mime" });

    expect(
      validatePickedMediaFile({
        name: "huge.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 25 * 1024 * 1024,
        base64Data: btoa("x"),
        source: "camera",
      }),
    ).toEqual({ valid: false, reason: "file_too_large" });
  });

  it("converts a picked native media file into a browser File", () => {
    const file = pickedMediaFileToBrowserFile({
      name: "receipt.png",
      mimeType: "image/png",
      sizeBytes: 4,
      base64Data: btoa("test"),
      source: "camera",
    });
    expect(file.name).toBe("receipt.png");
    expect(file.type).toBe("image/png");
    expect(file.size).toBe(4);
  });
});

describe("CRM caller ID sync and post-call activity payload", () => {
  it("normalizes customer phones before syncing caller ID cache", async () => {
    const request = vi.fn(async (_cmd: string, payload?: Record<string, unknown>) => ({
      roleHeld: true,
      syncedCount: (payload?.entries as unknown[]).length,
      businessId: String(payload?.businessId),
    })) as unknown as NativeRequest;

    const result = await syncNativeCallerIdCache(request, {
      businessId: "biz-1",
      customers: [
        { id: "c-1", name: "علی رضایی", phone: "0912 111 2233", organizationName: "شرکت بهار", tags: ["VIP"] },
        { id: "c-2", name: "بدون شماره", phone: "" },
      ],
    });

    expect(result.syncedCount).toBe(1);
    expect(request).toHaveBeenCalledWith("crm.callerId.sync", {
      businessId: "biz-1",
      requestRole: false,
      entries: [
        {
          customerId: "c-1",
          displayName: "علی رضایی",
          phoneNormalized: "+989121112233",
          organizationName: "شرکت بهار",
          tags: ["VIP"],
        },
      ],
    });
  });

  it("builds a CRM call activity payload compatible with POST /api/crm/activities", () => {
    const payload = buildPostCallActivityPayload({
      customerId: "c-1",
      customerName: "علی رضایی",
      phoneNormalized: "+989121112233",
      direction: "incoming",
      durationSeconds: 125,
      outcome: "follow_up_needed",
      note: "ارسال پیش‌فاکتور تا فردا",
      followUpAt: "2026-10-16T09:00:00Z",
    });

    expect(payload.kind).toBe("call");
    expect(payload.customerId).toBe("c-1");
    expect(payload.completed).toBe(false);
    expect(payload.dueAt).toBe("2026-10-16T09:00:00Z");
    expect(payload.description).toContain("۲ دقیقه".replace("۲", "2"));
    expect(payload.description).toContain("ارسال پیش‌فاکتور تا فردا");
  });

  it("degrades safely when caller ID status or background sync bridge commands are unavailable", async () => {
    const failingRequest: NativeRequest = vi.fn(async () => {
      throw new NativeBridgeError("bridge_unavailable");
    });
    const callerStatus = await getNativeCallerIdStatus(failingRequest, "biz-1");
    expect(callerStatus.supported).toBe(false);

    const syncStatus = await getNativeSyncStatus(failingRequest, "biz-1");
    expect(syncStatus.scheduled).toBe(false);

    const triggerRes = await triggerNativeBackgroundSync(failingRequest, {
      action: "clear_tenant",
      businessId: "biz-1",
    });
    expect(triggerRes.scheduled).toBe(false);

    const shareRes = await shareViaNativeOrWeb(failingRequest, { title: "فاکتور" });
    expect(shareRes.shared).toBe(false);
  });
});
