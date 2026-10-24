/**
 * `POST /api/platform/media/test` — the console's «آزمایش اتصال» (issue #1080).
 *
 * The route's contract is what the console renders: a verdict, a Persian
 * sentence for every failure path (including an incomplete configuration and a
 * provider error with no detail), the per-step breakdown, and a support
 * reference. It must never echo a secret or a signed URL, and it must say that
 * it tested the SAVED configuration.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MEDIA_CONFIG } from "@/lib/media";

vi.mock("@/lib/platform-auth", () => ({
  withPlatformScope: <T>(fn: T) => fn,
  requirePlatformCapability: vi.fn(),
}));

vi.mock("@/lib/media-service", () => ({
  getMediaConfig: vi.fn(),
}));

vi.mock("@/lib/media-storage-health", () => ({
  runMediaStorageHealthCheck: vi.fn(),
}));

import { POST } from "./route";
import * as platformAuth from "@/lib/platform-auth";
import * as mediaService from "@/lib/media-service";
import * as health from "@/lib/media-storage-health";

const CONFIG = {
  ...DEFAULT_MEDIA_CONFIG,
  enabled: true,
  endpoint: "https://s3.parspack.com",
  region: "ir-thr-at1",
  bucket: "media-bucket",
  keyPrefix: "media/",
  accessKeyId: "AKIA_SECRET_KEY_ID",
  secretAccessKey: "super-secret-value",
};

function request(headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost:3000/api/platform/media/test", { method: "POST", headers });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(platformAuth.requirePlatformCapability).mockResolvedValue({
    session: { padmin: 1, email: "root@bizamiz.test", role: "super_admin" } as never,
    error: null,
  });
  vi.mocked(mediaService.getMediaConfig).mockResolvedValue(CONFIG as never);
});

describe("POST /api/platform/media/test", () => {
  it("reports every verified capability on success and states that the saved config was tested", async () => {
    const steps = [
      { id: "config", label: "خواندن پیکربندی ذخیره‌شده", ok: true, durationMs: 1, providerStatus: null, providerCode: null, detail: null },
      { id: "buffered_write", label: "نوشتن آزمایشی حجم کوچک در باکت", ok: true, durationMs: 2, providerStatus: null, providerCode: null, detail: null },
    ];
    vi.mocked(health.runMediaStorageHealthCheck).mockResolvedValue({
      ok: true,
      testedSavedConfiguration: true,
      enabled: true,
      endpointHost: "s3.parspack.com",
      bucket: "media-bucket",
      keyPrefix: "media/",
      steps: steps as never,
      capabilities: { write: true, readBack: true, integrity: true, streamedUpload: true, delete: true },
      leftoverKeys: [],
      failure: null,
    });

    const res = await POST(request({ "x-request-id": "edge-request-123" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.testedSavedConfiguration).toBe(true);
    expect(body.reference).toBe("edge-request-123");
    expect(body.capabilities).toMatchObject({ streamedUpload: true, delete: true });
    expect(body.message).toContain("راستی‌آزمایی");
    // The check runs against the saved row — never a draft from the request body.
    expect(mediaService.getMediaConfig).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(body)).not.toContain("super-secret-value");
    expect(JSON.stringify(body)).not.toContain("AKIA_SECRET_KEY_ID");
  });

  it("returns a localized, actionable failure with the failing step and a reference", async () => {
    vi.mocked(health.runMediaStorageHealthCheck).mockResolvedValue({
      ok: false,
      testedSavedConfiguration: true,
      enabled: true,
      endpointHost: "s3.parspack.com",
      bucket: "media-bucket",
      keyPrefix: "media/",
      steps: [
        {
          id: "buffered_write",
          label: "نوشتن آزمایشی حجم کوچک در باکت",
          ok: false,
          durationMs: 3,
          providerStatus: 403,
          providerCode: "SignatureDoesNotMatch",
          detail: "upload …: HTTP 403 SignatureDoesNotMatch",
        },
      ] as never,
      capabilities: { write: false, readBack: false, integrity: false, streamedUpload: false, delete: false },
      leftoverKeys: [],
      failure: {
        code: "storage_credentials_rejected",
        stage: "s3_upload",
        message: "سرویس ذخیره‌سازی ابری کلید دسترسی را نپذیرفت. این مورد باید توسط مدیر پلتفرم اصلاح شود؛ فایل شما ثبت نشد.",
      },
    });

    const res = await POST(request());
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe("storage_credentials_rejected");
    expect(body.message).toContain("کلید دسترسی");
    expect(body.reference).toMatch(/^media-/);
    expect(body.steps[0]).toMatchObject({ id: "buffered_write", providerStatus: 403 });
    expect(res.headers.get("x-request-id")).toBeNull(); // the body carries it; no header contract
  });

  it("still answers with a real sentence when the failure carries no detail at all", async () => {
    vi.mocked(health.runMediaStorageHealthCheck).mockResolvedValue({
      ok: false,
      testedSavedConfiguration: true,
      enabled: true,
      endpointHost: null,
      bucket: "",
      keyPrefix: "",
      steps: [],
      capabilities: { write: false, readBack: false, integrity: false, streamedUpload: false, delete: false },
      leftoverKeys: [],
      failure: { code: "__unmapped__", stage: "unknown", message: "آزمایش اتصال ناموفق بود." },
    });

    const res = await POST(request());
    const body = await res.json();
    expect(res.status).toBe(502);
    expect(body.message).toBe("آزمایش اتصال ناموفق بود.");
    expect(body.message).not.toContain("undefined");
  });

  it("refuses an operator without the media.manage capability", async () => {
    vi.mocked(platformAuth.requirePlatformCapability).mockResolvedValue({
      session: null as never,
      error: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }) as never,
    });
    const res = await POST(request());
    expect(res.status).toBe(403);
    expect(health.runMediaStorageHealthCheck).not.toHaveBeenCalled();
  });
});
