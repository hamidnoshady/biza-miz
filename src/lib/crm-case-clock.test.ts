import { describe, expect, it } from "vitest";
import {
  CASE_ACTIVE_STATUSES,
  CASE_BREACH_SQL_CASES,
  CASE_CLOSED_STATUSES,
  CASE_WAITING_STATUS,
  caseBreachSql,
  caseClock,
  caseIsBreached,
} from "./crm-case-clock";
import { CASE_PRIORITY_TARGET_HOURS } from "./crm-shared";

const now = new Date("2026-03-10T12:00:00Z");

/** A case with every field spelled out, so each test changes one thing. */
function input(overrides: Partial<Parameters<typeof caseClock>[0]> = {}) {
  return {
    priority: "normal" as const,
    status: "open" as const,
    openedAt: "2026-03-10T00:00:00Z",
    firstResponseAt: null,
    resolvedAt: null,
    waitingSeconds: 0,
    waitingSince: null,
    now,
    ...overrides,
  };
}

describe("caseClock", () => {
  it("counts a case inside its target as fine", () => {
    const clock = caseClock(input({ priority: "urgent", openedAt: "2026-03-10T10:00:00Z" }));
    expect(clock.breached).toBe(false);
    expect(clock.targetHours).toBe(4);
    expect(clock.activeSeconds).toBe(7200);
    expect(clock.remainingSeconds).toBe(7200);
  });

  it("breaches an urgent case left open past its target", () => {
    expect(caseClock(input({ priority: "urgent" })).breached).toBe(true);
  });

  it("judges a responded case on first response, not on age", () => {
    // Opened 12 hours ago, answered in 30 minutes: the promise being measured
    // — «somebody acknowledged me» — was kept, so an open case is not late.
    const clock = caseClock(
      input({ priority: "urgent", firstResponseAt: "2026-03-10T00:30:00Z" }),
    );
    expect(clock.firstResponseSeconds).toBe(1800);
    expect(clock.breached).toBe(false);
  });

  it("blames a case whose first response missed the target", () => {
    const clock = caseClock(
      input({ priority: "urgent", firstResponseAt: "2026-03-10T06:00:00Z" }),
    );
    expect(clock.firstResponseSeconds).toBe(6 * 3600);
    expect(clock.breached).toBe(true);
  });

  it("never blames the shop while the clock belongs to the customer", () => {
    // «waiting» means we asked the customer something. Marking the shop late
    // for the customer's silence makes the indicator meaningless — and makes
    // "never ask the customer anything" the fastest way to protect it.
    const clock = caseClock(input({ status: "waiting", priority: "urgent" }));
    expect(clock.breached).toBe(false);
    expect(clock.waitingOnCustomer).toBe(true);
  });

  it("adds the wait that is still in progress to the stored total", () => {
    // `waiting_seconds` only carries waits that have finished; a case waiting
    // right now has not closed its stretch out yet.
    const clock = caseClock(
      input({
        priority: "urgent",
        status: "waiting",
        waitingSeconds: 3600,
        waitingSince: "2026-03-10T11:00:00Z",
      }),
    );
    // 12 hours elapsed, one of them stored and one of them still running.
    expect(clock.activeSeconds).toBe(12 * 3600 - 3600 - 3600);
  });

  it("subtracts a finished wait from a case that came back", () => {
    // Four days of silence from the customer, then answered the moment they
    // replied. The wait is not the team's failure even after it ends, so the
    // response is measured from the end of the wait — not from the opening.
    const clock = caseClock(
      input({
        status: "in_progress",
        priority: "urgent",
        openedAt: "2026-03-01T12:00:00Z",
        firstResponseAt: "2026-03-05T12:00:00Z",
        waitingSeconds: 4 * 24 * 3600,
      }),
    );
    expect(clock.firstResponseSeconds).toBe(0);
    expect(clock.breached).toBe(false);
    // …while the age it also reports is reduced by the same wait: 9 days
    // elapsed minus 4 waiting is 5 days of the team's own time.
    expect(clock.activeSeconds).toBe(5 * 24 * 3600);
  });

  it("stops the clock at resolution", () => {
    // Resolved in two hours, closed a week later: nobody gets blamed for the
    // tab that stayed open.
    const clock = caseClock(
      input({ priority: "urgent", status: "closed", resolvedAt: "2026-03-10T02:00:00Z" }),
    );
    expect(clock.breached).toBe(false);
    expect(clock.remainingSeconds).toBe(7200);
  });

  it("does not resurrect a breach for a resolved case", () => {
    const clock = caseClock(
      input({ priority: "urgent", status: "resolved", resolvedAt: "2026-03-11T00:00:00Z" }),
    );
    expect(clock.breached).toBe(false);
  });

  it("keeps the policy constants in one place", () => {
    expect(CASE_ACTIVE_STATUSES).toEqual(["open", "in_progress"]);
    expect(CASE_CLOSED_STATUSES).toEqual(["resolved", "closed"]);
    expect(CASE_WAITING_STATUS).toBe("waiting");
  });
});

describe("caseIsBreached", () => {
  it("answers for a row that predates first-response tracking", () => {
    // Migration 0157 added the columns; rows older than it must read as
    // unresponded rather than throwing on `undefined`.
    expect(
      caseIsBreached({ status: "open", priority: "urgent", openedAt: "2026-03-10T00:00:00Z", resolvedAt: null }, now),
    ).toBe(true);
  });

  it("refuses to guess about an unparseable date", () => {
    expect(
      caseIsBreached({ status: "open", priority: "urgent", openedAt: "not a date", resolvedAt: null }, now),
    ).toBe(false);
  });

  it("agrees with caseClock for the same row", () => {
    const row = {
      status: "in_progress" as const,
      priority: "high" as const,
      openedAt: "2026-03-09T12:00:00Z",
      resolvedAt: null,
      firstResponseAt: null,
      waitingSeconds: 3600,
      waitingSince: null,
    };
    expect(caseIsBreached(row, now)).toBe(caseClock({ ...row, now }).breached);
  });
});

describe("caseBreachSql", () => {
  const sql = caseBreachSql({ targets: "$5", closed: "$6" });

  it("inlines the stored policy as parameters, not as literals", () => {
    // The hours map and the closed statuses travel as arguments so the policy
    // stays in `crm-case-clock.ts` / `crm-shared.ts` and the SQL holds only the
    // arithmetic. A literal here would be a second copy of the policy.
    expect(sql).toContain("$5::jsonb ->> k.priority");
    expect(sql).toContain("$6::text[]");
    expect(sql).not.toMatch(/urgent/);
  });

  it("pauses the clock for a waiting case in SQL too", () => {
    expect(sql).toContain("k.status <> 'waiting'");
  });

  it("measures a responded case against first response, minus the wait", () => {
    expect(sql).toContain("k.first_response_at IS NOT NULL");
    expect(sql).toContain("least(");
  });

  it("stops the clock at resolution and clamps at zero", () => {
    expect(sql).toContain("coalesce(k.resolved_at, now())");
    expect(sql).toMatch(/greatest\(0,/);
  });

  it("pins the policy the SQL is handed", () => {
    // The SQL holds the arithmetic; the policy arrives as these values. Pinned
    // as literals so changing a target is a deliberate edit in a test that
    // knows both implementations read the same source.
    expect(CASE_BREACH_SQL_CASES.targets).toEqual({ urgent: 4, high: 24, normal: 72, low: 168 });
    expect(CASE_BREACH_SQL_CASES.closed).toEqual(["resolved", "closed"]);
    expect(CASE_BREACH_SQL_CASES.closed).toEqual([...CASE_CLOSED_STATUSES]);
    expect(CASE_BREACH_SQL_CASES.targets).toEqual(CASE_PRIORITY_TARGET_HOURS);
  });
});
