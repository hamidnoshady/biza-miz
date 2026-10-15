import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { NativeBridgeError } from "./bridge";
import {
  authenticateWithNativeBiometric,
  buildPostCallActivityPayload,
  buildQuickCrmActivityPayload,
  buildQuickCustomerPartyPayload,
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
import { parsePartyRequestBody } from "@/lib/parties";
import type { NativeRequest } from "@/components/native/native-provider";

const createCrmActivityMock = vi.fn(async (businessId: string, input: Record<string, unknown>) => ({
  id: "act-created-1",
  businessId,
  ...input,
}));

vi.mock("@/lib/auth", () => ({
  withTenantScope: (fn: (req: Request) => Promise<Response>) => fn,
  requirePermission: vi.fn(async () => ({
    session: { id: "user-1", businessId: "biz-1", role: "Owner", fullName: "مدیر" },
    error: null,
  })),
}));

vi.mock("@/lib/crm-service", () => ({
  createActivity: (businessId: string, input: Record<string, unknown>) =>
    createCrmActivityMock(businessId, input),
  listActivities: vi.fn(async () => []),
}));

import { POST as postCrmActivity } from "@/app/api/crm/activities/route";

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

  it("fails closed when targetBusinessId is present but activeBusinessId is null or empty", () => {
    expect(
      validateTenantDeepLink({
        path: "/crm/customers/123",
        activeBusinessId: null,
        targetBusinessId: "biz-1",
      }),
    ).toEqual({
      allowed: false,
      path: null,
      reason: "missing_active_tenant",
    });
    expect(
      validateTenantDeepLink({
        path: "/crm/customers/123",
        activeBusinessId: "   ",
        targetBusinessId: "biz-1",
      }),
    ).toEqual({
      allowed: false,
      path: null,
      reason: "missing_active_tenant",
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
    const validUuid = "11111111-2222-4333-8444-555555555555";
    const assigneeUuid = "99999999-8888-4777-8666-555555555555";
    const payload = buildPostCallActivityPayload({
      customerId: validUuid,
      customerName: "علی رضایی",
      phoneNormalized: "+989121112233",
      direction: "incoming",
      durationSeconds: 125,
      outcome: "follow_up_needed",
      note: "ارسال پیش‌فاکتور تا فردا",
      followUpAt: "2026-10-16T09:00:00Z",
      assignedTo: assigneeUuid,
    });

    expect(payload.kind).toBe("call");
    expect(payload.subject).toBe("تماس ورودی — علی رضایی (نیازمند پیگیری)");
    expect(payload.customerId).toBe(validUuid);
    expect(payload.assigneeUserId).toBe(assigneeUuid);
    expect(payload.assignedTo).toBeUndefined();
    expect(payload.completed).toBe(false);
    expect(payload.dueAt).toBe("2026-10-16T09:00:00.000Z");
    expect(payload.body).toContain("ارسال پیش‌فاکتور تا فردا");
    expect(payload.body).toContain("2 دقیقه و 5 ثانیه");
    expect("title" in payload).toBe(false);
    expect("description" in payload).toBe(false);

    // Non-UUID customerId is omitted rather than triggering a 400 on /api/crm/activities.
    const nonUuidPayload = buildPostCallActivityPayload({
      customerId: "non-uuid-local-id",
      customerName: "مشتری ناشناس",
      phoneNormalized: "+989120000000",
      direction: "incoming",
      durationSeconds: 0,
      outcome: "no_answer",
      note: "",
      assignedTo: "تیم پشتیبانی",
    });
    expect(nonUuidPayload.customerId).toBeUndefined();
    expect(nonUuidPayload.assigneeUserId).toBeUndefined();
    expect(nonUuidPayload.assignedTo).toBe("تیم پشتیبانی");
  });

  it("builds quick-create CRM activity and customer party payloads matching server contracts", () => {
    const activityPayload = buildQuickCrmActivityPayload({
      kind: "task",
      subject: "ارسال قرارداد",
      body: "ارسال نسخه امضاشده",
      dueAt: "2026-10-20T10:00:00Z",
    });
    expect(activityPayload).toEqual({
      kind: "task",
      subject: "ارسال قرارداد",
      body: "ارسال نسخه امضاشده",
      completed: false,
      dueAt: "2026-10-20T10:00:00.000Z",
    });

    const partyPayload = buildQuickCustomerPartyPayload({
      displayName: "شرکت سپهر",
      phone: "۰۹۱۲۱۱۱۲۲۳۳",
    });
    expect(partyPayload).toEqual({
      displayName: "شرکت سپهر",
      role: "Customer",
      roles: ["Customer"],
      phone: "09121112233",
    });
    const parsedByServer = parsePartyRequestBody(partyPayload as unknown as Record<string, unknown>);
    expect(parsedByServer.errors).toEqual({});
    expect(parsedByServer.input.displayName).toBe("شرکت سپهر");
    expect(parsedByServer.input.roles).toEqual(["Customer"]);
  });

  it("submits post-call and quick-create payloads directly to the POST /api/crm/activities route handler with 201 Created", async () => {
    createCrmActivityMock.mockClear();
    const customerUuid = "11111111-2222-4333-8444-555555555555";
    const postCallPayload = buildPostCallActivityPayload({
      customerId: customerUuid,
      customerName: "سارا احمدی",
      phoneNormalized: "+989123334455",
      direction: "incoming",
      durationSeconds: 70,
      outcome: "answered",
      note: "ارسال لیست قیمت جدید",
      assignedTo: "واحد فروش",
    });

    const postCallRes = await postCrmActivity(
      new NextRequest("https://biza-miz.test/api/crm/activities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(postCallPayload),
      }),
    );
    expect(postCallRes.status).toBe(201);
    expect(createCrmActivityMock).toHaveBeenCalledWith(
      "biz-1",
      expect.objectContaining({
        kind: "call",
        subject: "تماس ورودی — سارا احمدی (پاسخ داده شد)",
        customerId: customerUuid,
        completed: true,
        assignedTo: "واحد فروش",
      }),
    );

    const quickTaskPayload = buildQuickCrmActivityPayload({
      kind: "task",
      subject: "تماس مجدد با مشتری",
      body: "بررسی تایید پیش‌فاکتور",
      dueAt: "2026-10-18T08:30:00Z",
    });
    const quickTaskRes = await postCrmActivity(
      new NextRequest("https://biza-miz.test/api/crm/activities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(quickTaskPayload),
      }),
    );
    expect(quickTaskRes.status).toBe(201);
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
