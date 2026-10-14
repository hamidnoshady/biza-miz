/**
 * Issue #808 §9 — idempotent setup endpoints repair their own progress marker.
 *
 * The opening step had two retry paths that returned success without touching
 * `setup.progress`: an existing opening inventory event (rolled back and
 * returned as "idempotent") and an existing opening journal entry (a 409). If
 * the first attempt committed the accounting rows but failed to write the
 * marker, every retry reported success while the wizard stayed one step
 * behind — and the wizard then routed the owner back into a step the data
 * already satisfied.
 *
 * These tests pin the repair: both retry paths call `markStepDone` in the
 * caller's transaction and return okay, and neither writes the accounting rows
 * a second time.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as db from "@/lib/db";
import * as settings from "@/lib/settings";
import * as setupState from "@/lib/setup-state";
import { POST } from "./route";

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

vi.mock("@/lib/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/settings")>();
  return { ...actual, markStepDone: vi.fn(), getSetting: vi.fn() };
});

vi.mock("@/lib/setup-state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/setup-state")>();
  return {
    ...actual,
    resolveActiveLocation: vi.fn(),
    costingLocked: vi.fn(),
  };
});

const SESSION = { businessId: "biz-1", sub: "user-1" };
const PROGRESS = { steps: { opening: "2026-01-01T00:00:00.000Z" }, completedAt: null };

function request(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

let client: { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };

beforeEach(() => {
  vi.clearAllMocks();
  client = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() };
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(setupState.resolveActiveLocation).mockResolvedValue({ id: "loc-1" } as never);
  vi.mocked(settings.getSetting).mockResolvedValue({
    method: "fifo",
    system: "perpetual",
    lockedAt: null,
  } as never);
  vi.mocked(settings.markStepDone).mockResolvedValue(PROGRESS as never);
  vi.mocked(db.getPool).mockReturnValue({ connect: vi.fn().mockResolvedValue(client) } as never);
});

describe("POST /api/setup/opening — inventory retry", () => {
  it("repairs the marker and commits when the opening event already exists", async () => {
    // The first SELECT FOR UPDATE finds last attempt's event.
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM inventory_events")) return { rows: [{ id: "event-1" }] };
      return { rows: [] };
    });

    const response = await POST(request({ inventory: { items: [{ name: "قهوه", quantity: 10, unitCost: 500000 }] } }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, eventId: "event-1", idempotent: true });
    expect(settings.markStepDone).toHaveBeenCalledWith("biz-1", "opening", client);
    const statements = client.query.mock.calls.map((call) => String(call[0]));
    expect(statements.some((sql) => sql.includes("INSERT INTO inventory_events"))).toBe(false);
    expect(statements).toContain("COMMIT");
    expect(statements).not.toContain("ROLLBACK");
  });
});

describe("POST /api/setup/opening — balances retry", () => {
  it("repairs the marker and returns okay when the opening entry already exists", async () => {
    vi.mocked(db.query).mockResolvedValue({ rows: [{ id: "entry-1" }] } as never);

    const response = await POST(request({ balances: { lines: [{ accountId: "acc-1", debit: 100, credit: 0 }] } }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, entryId: "entry-1", alreadyExists: true });
    expect(settings.markStepDone).toHaveBeenCalledWith("biz-1", "opening");
    // The retry must not create a second opening entry — that is what the
    // strict balance/ownership checks below it would have allowed otherwise.
    const sql = vi.mocked(db.query).mock.calls[0][0];
    expect(sql).toContain("source_type = 'opening'");
  });
});
