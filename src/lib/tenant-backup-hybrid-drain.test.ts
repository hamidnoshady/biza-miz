/**
 * Issue #903 §3 — `max_parallel_uploads` bounds real work.
 *
 * The fleet row has carried the number since migration 0265 and the console has
 * shown it, but `drainUploadQueue` was strictly one-artifact-per-tick, so the
 * setting changed nothing. These cases drive the real function through a mocked
 * `query` (rather than mocking the module's own exports, which the internal
 * calls do not go through) and pin three things: the default keeps the historic
 * behaviour, a configured bound is honoured in queue order, and the hard ceiling
 * and the generation fence still apply.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("./db", () => ({ query: db.query, withoutTenantScope: vi.fn() }));

import { drainUploadQueue, MAX_UPLOAD_CONCURRENCY } from "./tenant-backup-hybrid";

const now = new Date("2026-10-28T12:00:00.000Z");

function queueRow(name: string, patch: Record<string, unknown> = {}) {
  return {
    artifact_name: name,
    generation: "4",
    state: "queued",
    attempts: 0,
    next_attempt_at: new Date(now.getTime() - 1000),
    ...patch,
  };
}

function routeQuery(rows: ReturnType<typeof queueRow>[], accepted = 0) {
  db.query.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM tenant_backup_upload_queue")) return { rows, rowCount: rows.length };
    if (sql.includes("FROM tenant_backup_site_heartbeat")) {
      return {
        rows: [{
          site_generation: "4",
          accepted_generation: String(accepted),
          last_seen_at: now,
          queue_depth: rows.length,
          last_error_code: null,
        }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 1 };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("drainUploadQueue concurrency", () => {
  it("attempts exactly one artifact by default", async () => {
    routeQuery([queueRow("a.dump.enc"), queueRow("b.dump.enc"), queueRow("c.dump.enc")]);
    const upload = vi.fn().mockResolvedValue({ ok: true });

    const result = await drainUploadQueue("business-a", upload, now);

    expect(upload).toHaveBeenCalledTimes(1);
    expect(result.uploaded).toBe(1);
  });

  it("runs the configured number at once, in queue order", async () => {
    routeQuery([queueRow("a.dump.enc"), queueRow("b.dump.enc"), queueRow("c.dump.enc")]);
    const seen: string[] = [];
    const upload = vi.fn(async (name: string): Promise<{ ok: true }> => {
      seen.push(name);
      return { ok: true };
    });

    const result = await drainUploadQueue("business-a", upload, now, { concurrency: 3 });

    expect(upload).toHaveBeenCalledTimes(3);
    expect(seen).toEqual(["a.dump.enc", "b.dump.enc", "c.dump.enc"]);
    expect(result.uploaded).toBe(3);
  });

  it("reports a failed upload without stopping its neighbours' bookkeeping", async () => {
    routeQuery([queueRow("a.dump.enc"), queueRow("b.dump.enc")]);
    const upload = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: "upload_failed" })
      .mockResolvedValueOnce({ ok: true });

    const result = await drainUploadQueue("business-a", upload, now, { concurrency: 2 });

    expect(result.uploaded).toBe(1);
    // Two results recorded: one success, one failure with its backoff.
    const marks = db.query.mock.calls.filter(([sql]) => String(sql).includes("UPDATE tenant_backup_upload_queue"));
    expect(marks.length).toBe(2);
  });

  it("never exceeds the hard ceiling, however large the fleet asks for", async () => {
    routeQuery(
      Array.from({ length: MAX_UPLOAD_CONCURRENCY + 5 }, (_, index) => queueRow(`x${index}.enc`)),
    );
    const upload = vi.fn().mockResolvedValue({ ok: true });

    await drainUploadQueue("business-a", upload, now, { concurrency: 500 });

    expect(upload).toHaveBeenCalledTimes(MAX_UPLOAD_CONCURRENCY);
  });

  it("refuses a stale generation before running any upload for it", async () => {
    // The platform has already accepted generation 9; these artifacts carry 4.
    routeQuery([queueRow("a.dump.enc"), queueRow("b.dump.enc")], 9);
    const upload = vi.fn().mockResolvedValue({ ok: true });

    const result = await drainUploadQueue("business-a", upload, now, { concurrency: 2 });

    expect(upload).not.toHaveBeenCalled();
    expect(result.superseded).toBe(2);
  });

  it("treats a nonsense concurrency as one, not as unlimited", async () => {
    routeQuery([queueRow("a.dump.enc"), queueRow("b.dump.enc")]);
    const upload = vi.fn().mockResolvedValue({ ok: true });

    await drainUploadQueue("business-a", upload, now, { concurrency: Number.NaN });

    expect(upload).toHaveBeenCalledTimes(1);
  });
});
