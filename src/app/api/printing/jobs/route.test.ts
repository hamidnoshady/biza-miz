/**
 * /api/printing/jobs — print history and the two guarantees that make it
 * trustworthy (issue #815: "Failed jobs end in `failed`, never permanently
 * `sending`", "Print history stores template ID/key/version, printer and error
 * code", "failed-job status transition").
 *
 *  - PATCH accepts only the two terminal states, always scoped to the caller's
 *    active location, so a job cannot be closed across branches;
 *  - GET sweeps a job left `sending` past its window to `failed`/`job_timeout`
 *    before it reads — including for the case the browser never came back;
 *  - every row answers "which printer and which template revision printed
 *    this?".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as db from "@/lib/db";
import * as setupState from "@/lib/setup-state";
import { SENDING_STALE_AFTER_SECONDS } from "@/lib/printing/routing";
import { GET, PATCH } from "./route";

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
  return { ...actual, query: vi.fn() };
});

vi.mock("@/lib/setup-state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/setup-state")>();
  return { ...actual, resolveActiveLocation: vi.fn() };
});

const SESSION = { businessId: "biz-1", sub: "user-1", role: "cashier" };

function request(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(setupState.resolveActiveLocation).mockResolvedValue({ id: "loc-1" } as never);
  vi.mocked(db.query).mockResolvedValue({ rows: [], rowCount: 0 } as never);
});

describe("PATCH — a job ends in a terminal state, once", () => {
  it("closes a job as handed_off", async () => {
    const response = await PATCH(request({ printRequestId: "req-1", status: "handed_off" }));
    expect(response.status).toBe(200);
    const [sql, params] = vi.mocked(db.query).mock.calls[0] as [string, unknown[]];
    expect(String(sql)).toContain("UPDATE print_jobs");
    expect(String(sql)).toContain("handed_off_at = CASE WHEN $3 = 'handed_off'");
    expect(params).toEqual(["loc-1", "req-1", "handed_off", null]);
  });

  it("closes a job as failed with the canonical error code", async () => {
    await PATCH(request({ printRequestId: "req-2", status: "failed", errorCode: "network_unreachable" }));
    const params = vi.mocked(db.query).mock.calls[0][1] as unknown[];
    expect(params).toEqual(["loc-1", "req-2", "failed", "network_unreachable"]);
  });

  it("scopes the update to the caller's own branch — a foreign request id is a no-op", async () => {
    await PATCH(request({ printRequestId: "req-3", status: "handed_off" }));
    const [sql, params] = vi.mocked(db.query).mock.calls[0] as [string, unknown[]];
    expect(String(sql)).toContain("WHERE location_id = $1 AND print_request_id = $2");
    expect(params[0]).toBe("loc-1");
  });

  it("refuses every state that is not terminal — `sending` is the server's own opening state", async () => {
    for (const status of ["sending", "preparing", "created", "routing", "done", "", undefined]) {
      const response = await PATCH(request({ printRequestId: "req-4", status }));
      expect(response.status, String(status)).toBe(400);
    }
    expect((await PATCH(request({ status: "failed" }))).status).toBe(400);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("caps a runaway request id instead of storing it whole", async () => {
    await PATCH(request({ printRequestId: "x".repeat(200), status: "failed" }));
    const params = vi.mocked(db.query).mock.calls[0][1] as unknown[];
    expect(String(params[1])).toHaveLength(80);
  });

  it("requires printing.execute and the branch's active location", async () => {
    const denied = NextResponse.json({ error: "forbidden" }, { status: 403 });
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: null, error: denied } as never);
    expect((await PATCH(request({ printRequestId: "req-5", status: "failed" }))).status).toBe(403);
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
    vi.mocked(setupState.resolveActiveLocation).mockResolvedValue(null as never);
    expect((await PATCH(request({ printRequestId: "req-5", status: "failed" }))).status).toBe(404);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("reports a database failure without leaking it", async () => {
    vi.mocked(db.query).mockRejectedValue(new Error("deadlock detected") as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await PATCH(request({ printRequestId: "req-6", status: "failed" }));
    errorSpy.mockRestore();
    expect(response.status).toBe(500);
  });
});

describe("GET — history, and the sweep that ends abandoned jobs", () => {
  it("sweeps jobs still `sending` past the window to failed/job_timeout before reading", async () => {
    await GET();
    const [sweepSql, sweepParams] = vi.mocked(db.query).mock.calls[0] as [string, unknown[]];
    expect(String(sweepSql)).toContain("UPDATE print_jobs");
    expect(String(sweepSql)).toContain("status = 'failed'");
    expect(String(sweepSql)).toContain("COALESCE(error_code, $3)");
    expect(String(sweepSql)).toContain("status = 'sending'");
    expect(String(sweepSql)).toContain("make_interval(secs => $2)");
    expect(sweepParams).toEqual(["loc-1", SENDING_STALE_AFTER_SECONDS, "job_timeout"]);

    const selectSql = String(vi.mocked(db.query).mock.calls[1][0]);
    expect(selectSql).toContain("template_key");
    expect(selectSql).toContain("template_version");
    expect(selectSql).toContain("LEFT JOIN printers");
  });

  it("never touches a row that already ended", async () => {
    await GET();
    const sweepSql = String(vi.mocked(db.query).mock.calls[0][0]);
    expect(sweepSql).toContain("AND status = 'sending'");
    expect(sweepSql).not.toContain("status <> ");
  });

  it("answers with the printer and the exact template revision behind each row", async () => {
    vi.mocked(db.query).mockImplementation((async (sql: string) =>
      String(sql).includes("SELECT j.id")
        ? {
            rows: [
              {
                id: "job-1",
                document_type: "receipt",
                entity_id: "order-9",
                status: "failed",
                error_code: "printer_offline",
                created_at: new Date("2026-01-15T10:00:00Z"),
                printer_name: "صندوق",
                template_key: "tpl-1",
                template_version: 4,
              },
            ],
            rowCount: 1,
          }
        : { rows: [], rowCount: 0 }) as never);
    const response = await GET();
    const body = (await response.json()) as { jobs: Record<string, unknown>[] };
    expect(body.jobs[0]).toMatchObject({
      documentType: "receipt",
      entityId: "order-9",
      status: "failed",
      errorCode: "printer_offline",
      printerName: "صندوق",
      templateKey: "tpl-1",
      templateVersion: 4,
    });
    // A Jalali timestamp, never a raw ISO string.
    expect(String(body.jobs[0].when)).not.toContain("2026");
  });

  it("keeps history best-effort: a failed read answers 500 with an empty list, not a crash", async () => {
    vi.mocked(db.query).mockImplementation((async (sql: string) => {
      if (String(sql).includes("SELECT j.id")) throw new Error("database down");
      return { rows: [], rowCount: 0 };
    }) as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await GET();
    errorSpy.mockRestore();
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: "print_jobs_failed", jobs: [] });
  });

  it("answers an empty list when the caller has no active location", async () => {
    vi.mocked(setupState.resolveActiveLocation).mockResolvedValue(null as never);
    const response = await GET();
    expect(await response.json()).toEqual({ jobs: [] });
    expect(db.query).not.toHaveBeenCalled();
  });
});
