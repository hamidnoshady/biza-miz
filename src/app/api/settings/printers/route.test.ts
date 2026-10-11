/**
 * Printer settings API regression coverage. A Windows printer carries no IP
 * address, and saving a default clears its predecessor of the same purpose
 * before the insert; both paths must remain valid and transactional.
 *
 * The route is plumbing over the canonical write boundary: the row's columns
 * are the source of truth and the jsonb is only the hardware target. The
 * parser itself is pinned in src/lib/printing/printer-input.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as db from "@/lib/db";
import { PERMISSIONS } from "@/lib/permissions";
import * as setupState from "@/lib/setup-state";
import { GET, POST } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler,
  };
});

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, getPool: vi.fn(), query: vi.fn() };
});

vi.mock("@/lib/setup-state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/setup-state")>();
  return { ...actual, resolveActiveLocation: vi.fn() };
});

const SESSION = { businessId: "biz-1", sub: "owner-1" };
const SAVED = {
  id: "printer-1",
  name: "EPSON TM-T20III",
  kind: "receipt",
  connection: { type: "windows", systemName: "EPSON TM-T20III", paperWidthMm: 80, paper: "thermal80" },
  is_active: true,
};

function request(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

function mockClient() {
  return {
    query: vi.fn(async (sql: string, _params?: unknown[]) => ({
      rows: sql.includes("INSERT INTO printers") ? [SAVED] : [],
    })),
    release: vi.fn(),
  };
}

let client: ReturnType<typeof mockClient>;

beforeEach(() => {
  vi.clearAllMocks();
  client = mockClient();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(setupState.resolveActiveLocation).mockResolvedValue({ id: "loc-1" } as never);
  vi.mocked(db.getPool).mockReturnValue({ connect: vi.fn().mockResolvedValue(client) } as never);
  vi.mocked(db.query).mockResolvedValue({ rows: [SAVED], rowCount: 1 } as never);
});

describe("GET /api/settings/printers", () => {
  it("reads the canonical relational columns and never a behavioural jsonb key", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ printers: [SAVED] });
    const sql = String(vi.mocked(db.query).mock.calls[0][0]);
    expect(sql).toContain("printer_class");
    expect(sql).toContain("paper");
    expect(sql).toContain("supports_drawer");
    // Behaviour is columns now; nothing may be cast out of the jsonb blob.
    expect(sql).not.toContain("connection->>");
    expect(sql).not.toContain("connection @>");
  });

  it("returns a stable error body when the database read fails", async () => {
    vi.mocked(db.query).mockRejectedValue(new Error("invalid input syntax for type boolean"));
    const response = await GET();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "printer_list_failed", printers: [] });
  });
});

describe("POST /api/settings/printers", () => {
  it("saves a Windows printer without requiring an IP, through the canonical model", async () => {
    const response = await POST(
      request({
        name: "EPSON TM-T20III",
        kind: "receipt",
        connection: { type: "windows", systemName: "EPSON TM-T20III" },
        paperWidthMm: 80,
        isActive: true,
      }),
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ printer: SAVED });
    expect(client.query).toHaveBeenCalledWith("BEGIN");
    expect(client.query).toHaveBeenCalledWith("COMMIT");
    expect(client.query).not.toHaveBeenCalledWith("ROLLBACK");
    const insert = client.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO printers"));
    expect(insert?.[1]?.[0]).toBe("loc-1");
    // The jsonb is the hardware target and nothing else…
    const stored = JSON.parse(String(insert?.[1]?.[3]));
    expect(stored).toEqual({ type: "windows", systemName: "EPSON TM-T20III" });
    expect(stored).not.toHaveProperty("transport");
    expect(stored).not.toHaveProperty("ip");
    expect(stored).not.toHaveProperty("paperWidthMm");
    expect(stored).not.toHaveProperty("openDrawer");
    expect(stored).not.toHaveProperty("templateKey");
    // …while behaviour travels in the columns the row is read from.
    const params = insert?.[1] as unknown[];
    expect(params[5]).toBe("thermal"); // printer_class
    expect(params[8]).toBe(false); // is_default
    expect(params[9]).toBe("thermal80"); // paper
    expect(params[10]).toBe(80); // paper_width_mm
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("refuses a legacy transport outright — no new usb/webusb/browser rows", async () => {
    for (const legacy of [
      { name: "x", kind: "receipt", transport: "usb", devicePath: "USB001" },
      { name: "x", kind: "receipt", transport: "webusb", usbVendorId: 0x04b8 },
      { name: "x", kind: "receipt", transport: "browser" },
    ]) {
      const response = await POST(request(legacy));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_printer" });
    }
    expect(db.getPool).not.toHaveBeenCalled();
  });

  it("clears the previous default of the same purpose in the same transaction", async () => {
    const response = await POST(
      request({
        name: "POS80",
        kind: "receipt",
        connection: { type: "windows", systemName: "POS80" },
        paperWidthMm: 80,
        isDefault: true,
      }),
    );
    expect(response.status).toBe(201);
    const update = client.query.mock.calls.find(([sql]) => String(sql).includes("UPDATE printers"));
    expect(update?.[0]).toContain("is_default = false");
    expect(update?.[0]).toContain("kind = $2");
    expect(update?.[1]).toEqual(["loc-1", "receipt"]);
  });

  it("does not disturb the default when the new printer is not one", async () => {
    await POST(request({ name: "POS80", kind: "receipt", connection: { type: "windows", systemName: "POS80" }, paperWidthMm: 80 }));
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("UPDATE printers"))).toBe(false);
  });

  it("rolls back and returns printer_save_failed when the insert fails", async () => {
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes("INSERT INTO printers")) throw new Error("database down");
      return { rows: [] };
    });
    const response = await POST(
      request({ name: "POS80", kind: "receipt", connection: { type: "windows", systemName: "POS80" }, paperWidthMm: 80 }),
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "printer_save_failed" });
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("returns the permission error without touching the database", async () => {
    const denied = NextResponse.json({ error: "forbidden" }, { status: 403 });
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: null, error: denied } as never);
    const response = await POST(request({}));
    expect(response).toBe(denied);
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.settingsManage);
    expect(db.getPool).not.toHaveBeenCalled();
  });
});
