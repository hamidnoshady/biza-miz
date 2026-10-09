/**
 * POST /api/printing/test-draft — the add-printer wizard's «چاپ آزمایشی» for a
 * printer that is not saved yet. Settings-managing roles only; the purpose and
 * paper are validated with the SAME matrix the write boundary uses, so the
 * wizard can never test a combination it would then refuse to save. No
 * hardware address is accepted — rendering never needs one.
 *
 * The render service is mocked; the sample documents themselves are pinned in
 * src/lib/printing/render-service.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as renderService from "@/lib/printing/render-service";
import { POST } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler,
  };
});

vi.mock("@/lib/printing/render-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/printing/render-service")>();
  return { ...actual, buildDraftTestPrint: vi.fn() };
});

function request(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

const RENDERED = Buffer.from([0x1b, 0x40, 0x1d, 0x56]);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: { businessId: "biz-1" }, error: null } as never);
  vi.mocked(renderService.buildDraftTestPrint).mockResolvedValue({ delivery: "raw", bytes: RENDERED } as never);
});

describe("POST /api/printing/test-draft", () => {
  it("requires the settings-manage permission", async () => {
    await POST(request({ purpose: "receipt", paper: "thermal80" }));
    expect(auth.requirePermission).toHaveBeenCalledWith("settings.manage");
  });

  it("returns the permission gate's error untouched", async () => {
    const denied = NextResponse.json({ error: "forbidden" }, { status: 403 });
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: null, error: denied } as never);
    expect((await POST(request({ purpose: "receipt", paper: "thermal80" }))).status).toBe(403);
    expect(renderService.buildDraftTestPrint).not.toHaveBeenCalled();
  });

  it("renders the sample for any of the four purposes on its own paper", async () => {
    for (const [purpose, paper] of [
      ["receipt", "thermal58"],
      ["kitchen", "thermal80"],
      ["document", "a4"],
      ["label", "label57x40"],
    ] as const) {
      const response = await POST(request({ purpose, paper }));
      expect(response.status).toBe(200);
      expect(renderService.buildDraftTestPrint).toHaveBeenCalledWith(purpose, paper);
      const body = (await response.json()) as { ok: boolean; delivery: string; dataBase64: string };
      expect(body.ok).toBe(true);
      expect(body.delivery).toBe("raw");
      expect(body.dataBase64).toBe(RENDERED.toString("base64"));
    }
  });

  it("reports a page delivery for a cut-sheet draft", async () => {
    vi.mocked(renderService.buildDraftTestPrint).mockResolvedValue({ delivery: "page", bytes: RENDERED } as never);
    const response = await POST(request({ purpose: "document", paper: "a4" }));
    expect(await response.json()).toMatchObject({ delivery: "page" });
  });

  it("still accepts the wizard's pre-unification `paperWidthMm` spelling and its `kind`", async () => {
    await POST(request({ kind: "kitchen", paperWidthMm: 58 }));
    expect(renderService.buildDraftTestPrint).toHaveBeenCalledWith("kitchen", "thermal58");
  });

  it("refuses a purpose/paper pair the write boundary would refuse, without rendering", async () => {
    for (const body of [
      {},
      { purpose: "fax", paper: "thermal80" },
      { purpose: "receipt", paper: "a4" },
      { purpose: "document", paper: "label57x40" },
      { purpose: "label", paper: "a4" },
      { purpose: "receipt", paperWidthMm: 62 },
      { purpose: "receipt", paperWidthMm: 0 },
    ]) {
      const response = await POST(request(body));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "incompatible_printer" });
    }
    expect(renderService.buildDraftTestPrint).not.toHaveBeenCalled();
  });

  it("rejects a body that is not JSON", async () => {
    const bad = { json: async () => Promise.reject(new Error("boom")) } as unknown as NextRequest;
    expect((await POST(bad)).status).toBe(400);
  });

  it("ignores any hardware address in the body — rendering takes none", async () => {
    const response = await POST(
      request({ purpose: "receipt", paper: "thermal80", ip: "203.0.113.7", target: { type: "network", ip: "198.51.100.9" } }),
    );
    expect(response.status).toBe(200);
    expect(renderService.buildDraftTestPrint).toHaveBeenCalledWith("receipt", "thermal80");
  });

  it("maps a render failure to 502 render_failed", async () => {
    vi.mocked(renderService.buildDraftTestPrint).mockRejectedValue(new Error("chromium gone") as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await POST(request({ purpose: "receipt", paper: "thermal80" }));
    errorSpy.mockRestore();
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: "render_failed" });
  });
});
