import { describe, expect, it } from "vitest";
import {
  reconcileRetiredResearchRuns,
  reconcileResearchRetirement,
  readOpenResearchRuns,
  type ResearchReconcileClient,
} from "./ai-research-reconcile";

/**
 * Issue #1367 — the documented policy for work that was open at cutover.
 *
 * A fake client is enough here because the thing under test is the SQL policy,
 * not Postgres: which statuses are touched, which are left alone, and that
 * nothing is deleted or executed.
 */
type Call = { sql: string; params?: unknown[] };

function fakeClient(initial: {
  pending?: number;
  runningLive?: number;
  runningExpired?: number;
}) {
  const state = {
    pending: initial.pending ?? 0,
    runningLive: initial.runningLive ?? 0,
    runningExpired: initial.runningExpired ?? 0,
  };
  const calls: Call[] = [];
  const client: ResearchReconcileClient = {
    async query<T>(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      if (/^\s*SELECT/i.test(sql)) {
        return {
          rows: [
            {
              pending: String(state.pending),
              running_live: String(state.runningLive),
              running_expired: String(state.runningExpired),
            },
          ] as unknown as T[],
        };
      }
      if (/status = 'awaiting_approval'/.test(sql)) {
        const count = state.pending;
        state.pending = 0;
        return { rowCount: count };
      }
      if (/status = 'running'/.test(sql)) {
        const count = state.runningExpired;
        state.runningExpired = 0;
        return { rowCount: count };
      }
      return { rowCount: 0 };
    },
  };
  return { client, calls, state };
}

describe("issue #1367 — opening-run reconciliation", () => {
  it("counts pending and running runs, splitting live running from expired", async () => {
    const { client, calls } = fakeClient({ pending: 3, runningLive: 1, runningExpired: 2 });
    await expect(readOpenResearchRuns(client, "biz-1")).resolves.toEqual({
      pending: 3,
      runningLive: 1,
      runningExpired: 2,
      running: 3,
    });
    expect(calls[0].params).toEqual(["biz-1"]);
    expect(calls[0].sql).toContain("status IN ('awaiting_approval', 'running')");
  });

  it("changes nothing in report-only mode", async () => {
    const { client, calls } = fakeClient({ pending: 2, runningLive: 1, runningExpired: 1 });
    const outcome = await reconcileResearchRetirement(client, {
      businessId: null,
      apply: false,
    });

    expect(outcome.applied).toBeNull();
    expect(calls.filter((call) => /UPDATE/i.test(call.sql))).toHaveLength(0);
    expect(calls.every((call) => !/DELETE/i.test(call.sql))).toBe(true);
    expect(outcome.before).toEqual(outcome.after);
  });

  it("cancels pending runs and fails only expired running runs", async () => {
    const { client, calls } = fakeClient({ pending: 2, runningLive: 1, runningExpired: 1 });
    const outcome = await reconcileResearchRetirement(client, {
      businessId: "biz-1",
      apply: true,
    });

    expect(outcome.applied).toEqual({ cancelled: 2, failed: 1 });
    expect(outcome.after).toEqual({
      pending: 0,
      runningLive: 1,
      runningExpired: 0,
      running: 1,
    });

    const updates = calls.filter((call) => /UPDATE/i.test(call.sql));
    expect(updates).toHaveLength(2);
    // The pending row is cancelled; no cost existed, so nothing is repriced.
    expect(updates[0].sql).toContain("SET status = 'cancelled'");
    expect(updates[0].sql).toContain("error = 'research_retired'");
    // Only an expired running row is failed — a live rolling-deploy run is not
    // touched, which is the whole reason the predicate is in the SQL.
    expect(updates[1].sql).toContain("SET status = 'failed'");
    expect(updates[1].sql).toContain("expires_at < now()");
    // Platform maintenance, but never a writer of money or an executor.
    for (const call of calls) {
      expect(call.sql).not.toMatch(/DELETE/i);
      expect(call.sql).not.toMatch(/actual_cost_usd\s*=/);
      expect(call.sql).not.toMatch(/spend_cap_usd\s*=/);
    }
  });

  it("keeps a live running run visible after an apply, so the operator re-runs later", async () => {
    const { client } = fakeClient({ pending: 0, runningLive: 2, runningExpired: 0 });
    const outcome = await reconcileResearchRetirement(client, {
      businessId: null,
      apply: true,
    });
    expect(outcome.applied).toEqual({ cancelled: 0, failed: 0 });
    expect(outcome.after.running).toBe(2);
  });
});
