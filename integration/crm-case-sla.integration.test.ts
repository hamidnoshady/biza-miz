/**
 * Case status transitions and the waiting accumulator.
 *
 * The pure SLA arithmetic is covered in `crm-case-clock.test.ts`. What needs a
 * database is the **accumulator**: `waiting_seconds` is a running total that
 * must be closed out every time a case leaves `waiting`, and the failure mode
 * is invisible from a single status column — a case that bounces between
 * waiting and active silently loses each earlier stretch and its SLA improves
 * every time it bounces.
 *
 * The second thing a database is needed for is the **agreement** between the
 * service desk's filter and the clock. `listCases({ breachedOnly: true })` is
 * SQL — it has to be, because a filter applied after the read is a filter the
 * `LIMIT` already broke — while the row's badge and the summary panel call
 * `caseClock` in TypeScript, so the rule exists twice. The block at the end of
 * this file runs both over the same rows and demands the same answer, because
 * the day they disagree is the day the screen shows «از مهلت گذشته» above a
 * panel that says nothing is late.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { caseIsBreached } from "../src/lib/crm-case-clock";
import { isCasePriority, isCaseStatus } from "../src/lib/crm-shared";
import {
  caseViewAssigneeUserId,
  caseViewQuery,
  caseViewUnownedOnly,
  parseCaseViewFilters,
} from "../src/lib/crm-case-views";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let cases: typeof import("../src/lib/crm-case-service");
let desk: typeof import("../src/lib/crm-service");
let views: typeof import("../src/lib/crm-saved-views-service");

const biz = { id: "" };
const actor = { name: "مسئول پشتیبانی" };

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

function maintenanceUrl(): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = "/postgres";
  return url.toString();
}

beforeAll(async () => {
  databaseName = `pos_casesla_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  cases = await import("../src/lib/crm-case-service");
  desk = await import("../src/lib/crm-service");
  views = await import("../src/lib/crm-saved-views-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  const business = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, slug, industry)
     VALUES ('پشتیبانی تست', $1, 'food_service') RETURNING id`,
    [`case-${randomUUID().slice(0, 8)}`],
  );
  biz.id = business.rows[0].id;
}, 180_000);

afterAll(async () => {
  await db?.end();
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

beforeEach(async () => {
  await db.query(`DELETE FROM crm_case_events WHERE business_id = $1`, [biz.id]);
  await db.query(`DELETE FROM crm_cases WHERE business_id = $1`, [biz.id]);
});

async function makeCase(priority = "normal", openedHoursAgo = 0): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO crm_cases (business_id, subject, status, priority, opened_at)
     VALUES ($1, 'مشکل سفارش', 'open', $2, now() - ($3 || ' hours')::interval)
     RETURNING id`,
    [biz.id, priority, String(openedHoursAgo)],
  );
  return rows[0].id;
}

async function readCase(id: string) {
  const { rows } = await db.query<{
    status: string;
    waiting_seconds: string;
    waiting_since: Date | null;
    first_response_at: Date | null;
    resolved_at: Date | null;
    closed_at: Date | null;
    reopened_count: number;
  }>(`SELECT * FROM crm_cases WHERE id = $1`, [id]);
  return rows[0];
}

describe("the waiting accumulator", () => {
  it("starts the clock when a case enters waiting", async () => {
    const id = await makeCase();
    await cases.setCaseStatus(biz.id, id, "waiting", actor);

    const row = await readCase(id);
    expect(row.status).toBe("waiting");
    expect(row.waiting_since).not.toBeNull();
    // Nothing accumulated yet — the stretch is still in flight.
    expect(Number(row.waiting_seconds)).toBe(0);
  });

  it("closes out the stretch on the way back to active", async () => {
    const id = await makeCase();
    await cases.setCaseStatus(biz.id, id, "waiting", actor);

    // Backdate the wait so there is something measurable to accumulate.
    await db.query(
      `UPDATE crm_cases SET waiting_since = now() - interval '3 hours' WHERE id = $1`,
      [id],
    );

    await cases.setCaseStatus(biz.id, id, "in_progress", actor);
    const row = await readCase(id);
    expect(Number(row.waiting_seconds)).toBeGreaterThanOrEqual(3 * 3600 - 5);
    expect(Number(row.waiting_seconds)).toBeLessThan(3 * 3600 + 60);
    // Cleared, so the next wait starts fresh rather than double-counting.
    expect(row.waiting_since).toBeNull();
  });

  it("accumulates across a case that bounces", async () => {
    // The bug this defends against: each new wait overwriting the last, so a
    // case that goes waiting → active → waiting → active keeps only the final
    // stretch, and its SLA gets better every time it bounces.
    const id = await makeCase();

    await cases.setCaseStatus(biz.id, id, "waiting", actor);
    await db.query(
      `UPDATE crm_cases SET waiting_since = now() - interval '2 hours' WHERE id = $1`,
      [id],
    );
    await cases.setCaseStatus(biz.id, id, "in_progress", actor);

    await cases.setCaseStatus(biz.id, id, "waiting", actor);
    await db.query(
      `UPDATE crm_cases SET waiting_since = now() - interval '4 hours' WHERE id = $1`,
      [id],
    );
    await cases.setCaseStatus(biz.id, id, "in_progress", actor);

    const row = await readCase(id);
    // Both stretches, not just the last one.
    expect(Number(row.waiting_seconds)).toBeGreaterThanOrEqual(6 * 3600 - 10);
    expect(Number(row.waiting_seconds)).toBeLessThan(6 * 3600 + 120);
  });

  it("does not count waiting time against the SLA", async () => {
    // An urgent case (4h target) open for 10 hours, 8 of them waiting on the
    // customer, is not breached.
    const id = await makeCase("urgent", 10);
    await cases.setCaseStatus(biz.id, id, "waiting", actor);
    await db.query(
      `UPDATE crm_cases SET waiting_since = now() - interval '8 hours' WHERE id = $1`,
      [id],
    );

    const summary = await cases.caseSlaSummary(biz.id);
    expect(summary.waitingOnCustomer).toBe(1);
    // Explicitly NOT counted as breached: the clock is paused, and reporting
    // it as late would blame the team for the customer's silence.
    expect(summary.breached).toBe(0);
  });

  it("does count the same overrun when nobody is waiting on the customer", async () => {
    const id = await makeCase("urgent", 10);
    await cases.setCaseStatus(biz.id, id, "in_progress", actor);
    // Undo the auto first-response stamp: this case is genuinely untouched.
    await db.query(`UPDATE crm_cases SET first_response_at = NULL WHERE id = $1`, [id]);

    const summary = await cases.caseSlaSummary(biz.id);
    expect(summary.breached).toBe(1);
    expect(summary.waitingOnCustomer).toBe(0);
  });
});

describe("first response is recorded once", () => {
  it("stamps on the first move off open and never moves it", async () => {
    const id = await makeCase("normal", 2);
    await cases.setCaseStatus(biz.id, id, "in_progress", actor);
    const first = await readCase(id);
    expect(first.first_response_at).not.toBeNull();

    await cases.setCaseStatus(biz.id, id, "waiting", actor);
    await cases.setCaseStatus(biz.id, id, "in_progress", actor);
    const later = await readCase(id);
    // Unmoved: "somebody acknowledged me" happened when it happened, and a
    // later reply does not rewrite that.
    expect(later.first_response_at?.getTime()).toBe(first.first_response_at?.getTime());
  });

  it("does not treat closing an untouched case as a response", async () => {
    // A case closed without anybody replying (a duplicate, say) did not get a
    // response, and recording one would flatter the median.
    const id = await makeCase();
    await cases.setCaseStatus(biz.id, id, "closed", actor);
    const row = await readCase(id);
    expect(row.first_response_at).toBeNull();
    expect(row.closed_at).not.toBeNull();
  });
});

describe("resolution and reopening", () => {
  it("stamps resolved_at and clears it on reopen", async () => {
    const id = await makeCase();
    await cases.setCaseStatus(biz.id, id, "resolved", actor);
    expect((await readCase(id)).resolved_at).not.toBeNull();

    await cases.setCaseStatus(biz.id, id, "open", actor);
    const reopened = await readCase(id);
    expect(reopened.resolved_at).toBeNull();
    // A reopened case is a distinct failure from a slow one, and counting them
    // is the only way that failure is visible at all.
    expect(reopened.reopened_count).toBe(1);
  });

  it("refuses a move to the status it is already in", async () => {
    const id = await makeCase();
    const result = await cases.setCaseStatus(biz.id, id, "open", actor);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("same_status");

    // And wrote no event: a no-op must not pad the history.
    const { rows } = await db.query(`SELECT 1 FROM crm_case_events WHERE case_id = $1`, [id]);
    expect(rows).toHaveLength(0);
  });

  it("rejects a status that is not in the vocabulary", async () => {
    const id = await makeCase();
    const result = await cases.setCaseStatus(biz.id, id, "escalated_to_ceo", actor);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid_status");
  });
});

describe("every transition is recorded", () => {
  it("writes an event with both ends of the move", async () => {
    // Without the event the SLA history is unreconstructable, and there is no
    // repairing it afterwards — the information was simply never written down.
    const id = await makeCase();
    await cases.setCaseStatus(biz.id, id, "in_progress", actor, { comment: "تماس گرفتم" });

    const { rows } = await db.query<{
      kind: string;
      from_status: string;
      to_status: string;
      body: string;
      actor_name: string;
    }>(`SELECT * FROM crm_case_events WHERE case_id = $1`, [id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("status_changed");
    expect(rows[0].from_status).toBe("open");
    expect(rows[0].to_status).toBe("in_progress");
    expect(rows[0].body).toBe("تماس گرفتم");
    expect(rows[0].actor_name).toBe(actor.name);
  });
});

describe("case numbers", () => {
  it("counts per business rather than globally", async () => {
    // A global sequence would leak one tenant's case volume to another — a
    // competitor reading «تیکت #۴۸۲۱» learns something they should not.
    const other = await db.query<{ id: string }>(
      `INSERT INTO businesses (name, slug, industry)
       VALUES ('کسب‌وکار دوم', $1, 'food_service') RETURNING id`,
      [`case2-${randomUUID().slice(0, 8)}`],
    );
    const otherId = other.rows[0].id;

    expect(await cases.nextCaseNumber(biz.id)).toBe(1);
    expect(await cases.nextCaseNumber(biz.id)).toBe(2);
    // The second business starts at 1, learning nothing about the first.
    expect(await cases.nextCaseNumber(otherId)).toBe(1);
    expect(await cases.nextCaseNumber(biz.id)).toBe(3);

    await db.query(`DELETE FROM crm_case_counters WHERE business_id = $1`, [otherId]);
    await db.query(`DELETE FROM businesses WHERE id = $1`, [otherId]);
  });
});

/**
 * The desk's filter, against the clock it has to agree with.
 *
 * Every ticket below is built so that a *plausible wrong* predicate gives a
 * different answer: judging on raw age flags the case that was answered in an
 * hour, ignoring the per-priority targets flags the `high` ticket at the age
 * the `urgent` one is genuinely late, and forgetting the customer-wait flags the
 * case that spent its month waiting for a reply that finally came.
 */
describe("the service desk's filter", () => {
  async function makeMember(name: string): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO users (business_id, role, full_name, email, password_hash)
       VALUES ($1, 'manager', $2, $3, 'x') RETURNING id`,
      [biz.id, name, `desk-${randomUUID().slice(0, 8)}@example.test`],
    );
    return rows[0].id;
  }

  async function makeCustomer(name: string): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO parties (business_id, name, roles)
       VALUES ($1, $2, ARRAY['customer']::text[]) RETURNING id`,
      [biz.id, name],
    );
    return rows[0].id;
  }

  /** A ticket with every clock the SLA reads under the test's control. */
  async function makeTicket(input: {
    subject: string;
    body?: string;
    status?: string;
    priority?: string;
    openedHoursAgo?: number;
    /** Hours after opening that somebody replied; `null` = nobody has. */
    firstResponseAfterHours?: number | null;
    waitingSeconds?: number;
    /** Hours ago the current wait began; `null` = not waiting. */
    waitingSinceHoursAgo?: number | null;
    /** Hours after opening that it was resolved. */
    resolvedAfterHours?: number | null;
    customerId?: string | null;
    assigneeUserId?: string | null;
  }): Promise<string> {
    const opened = input.openedHoursAgo ?? 0;
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO crm_cases (
         business_id, customer_id, subject, body, status, priority, assignee_user_id,
         opened_at, first_response_at, waiting_seconds, waiting_since, resolved_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         now() - ($8 || ' hours')::interval,
         CASE WHEN $9::text IS NULL THEN NULL
              ELSE now() - (($8::numeric - $9::numeric) || ' hours')::interval END,
         $10,
         CASE WHEN $11::text IS NULL THEN NULL
              ELSE now() - ($11 || ' hours')::interval END,
         CASE WHEN $12::text IS NULL THEN NULL
              ELSE now() - (($8::numeric - $12::numeric) || ' hours')::interval END
       ) RETURNING id`,
      [
        biz.id,
        input.customerId ?? null,
        input.subject,
        input.body ?? "",
        input.status ?? "open",
        input.priority ?? "normal",
        input.assigneeUserId ?? null,
        String(opened),
        input.firstResponseAfterHours === null || input.firstResponseAfterHours === undefined
          ? null
          : String(input.firstResponseAfterHours),
        input.waitingSeconds ?? 0,
        input.waitingSinceHoursAgo === null || input.waitingSinceHoursAgo === undefined
          ? null
          : String(input.waitingSinceHoursAgo),
        input.resolvedAfterHours === null || input.resolvedAfterHours === undefined
          ? null
          : String(input.resolvedAfterHours),
      ],
    );
    return rows[0].id;
  }

  /** The rows themselves, as the clock reads them — the honest expectation. */
  async function breachedByTheClock(): Promise<string[]> {
    const { rows } = await db.query<{
      id: string;
      status: string;
      priority: string;
      opened_at: Date;
      first_response_at: Date | null;
      resolved_at: Date | null;
      waiting_seconds: string;
      waiting_since: Date | null;
    }>(
      `SELECT id, status, priority, opened_at, first_response_at, resolved_at,
              waiting_seconds, waiting_since
         FROM crm_cases WHERE business_id = $1`,
      [biz.id],
    );
    return rows
      .filter((row) =>
        caseIsBreached(
          {
            status: row.status as Parameters<typeof caseIsBreached>[0]["status"],
            priority: row.priority as Parameters<typeof caseIsBreached>[0]["priority"],
            openedAt: row.opened_at.toISOString(),
            resolvedAt: row.resolved_at?.toISOString() ?? null,
            firstResponseAt: row.first_response_at?.toISOString() ?? null,
            waitingSeconds: Number(row.waiting_seconds),
            waitingSince: row.waiting_since?.toISOString() ?? null,
          },
          new Date(),
        ),
      )
      .map((row) => row.id);
  }

  const ids = (found: { id: string }[]) => found.map((row) => row.id).sort();

  it("gives the SQL filter and the TypeScript clock the same answer", async () => {
    // Late: nobody has touched it.
    const urgentLate = await makeTicket({ subject: "فوری رهاشده", priority: "urgent", openedHoursAgo: 10 });
    // The same age, a longer target: not late. A hardcoded four hours in SQL
    // would call this one breached.
    await makeTicket({ subject: "زیاد در مهلت", priority: "high", openedHoursAgo: 10 });
    // Answered within the hour and still open ten hours later: the promise the
    // target measures — «someone acknowledged me» — was kept.
    await makeTicket({
      subject: "پاسخ‌داده‌شده",
      priority: "urgent",
      openedHoursAgo: 10,
      firstResponseAfterHours: 1,
    });
    // Waiting on the customer for eight of its ten hours: the clock is theirs.
    await makeTicket({
      subject: "منتظر مشتری",
      priority: "urgent",
      status: "waiting",
      openedHoursAgo: 10,
      waitingSinceHoursAgo: 8,
    });
    // Waited 27 hours for an answer, then replied an hour later: measured from
    // the end of the wait, not from the opening.
    const waitedThenAnswered = await makeTicket({
      subject: "پس از انتظار",
      priority: "urgent",
      status: "in_progress",
      openedHoursAgo: 30,
      firstResponseAfterHours: 28,
      waitingSeconds: 27 * 3600,
    });
    // Resolved five hours in, left to rot as a row: nobody was late.
    const resolvedLate = await makeTicket({
      subject: "حل‌شدهٔ قدیمی",
      priority: "urgent",
      status: "resolved",
      openedHoursAgo: 48,
      resolvedAfterHours: 5,
    });
    // Inside its target in every sense.
    await makeTicket({ subject: "تازه", priority: "normal", openedHoursAgo: 1 });

    const byTheClock = await breachedByTheClock();
    // The expectation is not empty and not everything — otherwise the two
    // answers could agree by both being wrong.
    expect(byTheClock).toEqual([urgentLate]);

    const bySql = await desk.listCases(biz.id, { breachedOnly: true });
    expect(ids(bySql)).toEqual([...byTheClock].sort());

    // And the other three cases really are fine by the clock, so their absence
    // from the filter is the rule and not an accident of the fixture.
    const all = await desk.listCases(biz.id, {});
    expect(all).toHaveLength(7);
    expect(ids(all)).toContain(waitedThenAnswered);
    expect(ids(all)).toContain(resolvedLate);
  });

  it("narrows on every key of the vocabulary, in the database", async () => {
    // A business of its own: the file's shared one now holds the clock fixtures
    // above, and "the filter excluded the others" would prove nothing there.
    const own = await db.query<{ id: string }>(
      `INSERT INTO businesses (name, slug, industry)
       VALUES ('میز خدمت تست', $1, 'food_service') RETURNING id`,
      [`desk-${randomUUID().slice(0, 8)}`],
    );
    const businessId = own.rows[0].id;
    const member = await db.query<{ id: string }>(
      `INSERT INTO users (business_id, role, full_name, email, password_hash)
       VALUES ($1, 'manager', 'زهرا کریمی', $2, 'x') RETURNING id`,
      [businessId, `viewer-${randomUUID().slice(0, 8)}@example.test`],
    );
    const viewerId = member.rows[0].id;
    const customer = await db.query<{ id: string }>(
      `INSERT INTO parties (business_id, name, roles)
       VALUES ($1, 'مشتری فیلترها', ARRAY['customer']::text[]) RETURNING id`,
      [businessId],
    );
    const customerId = customer.rows[0].id;

    const insert = async (input: Record<string, unknown>) => {
      const opened = (input.openedHoursAgo as number) ?? 0;
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO crm_cases (
           business_id, customer_id, subject, body, status, priority, assignee_user_id, opened_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, now() - ($8 || ' hours')::interval)
         RETURNING id`,
        [
          businessId,
          (input.customerId as string | null) ?? null,
          input.subject,
          (input.body as string | undefined) ?? "",
          (input.status as string | undefined) ?? "open",
          (input.priority as string | undefined) ?? "normal",
          (input.assigneeUserId as string | null) ?? null,
          String(opened),
        ],
      );
      return rows[0].id;
    };

    const mine = await insert({
      subject: "یخچال خراب",
      body: "نشتی آب دارد",
      priority: "urgent",
      customerId,
      assigneeUserId: viewerId,
      openedHoursAgo: 10,
    });
    const unowned = await insert({ subject: "لباسشویی", priority: "high", openedHoursAgo: 2 });
    const resolved = await insert({
      subject: "سفارش دیررسیده",
      status: "resolved",
      priority: "urgent",
      customerId,
      openedHoursAgo: 30,
    });
    const otherCustomer = await insert({ subject: "پرده", body: "اندازه اشتباه" });

    // The request is parsed by the screen's own module and handed to the read,
    // exactly as the route does it — one vocabulary, no second reading.
    const run = async (query: Record<string, string>) => {
      const parsed = parseCaseViewFilters({ get: (key) => query[key] ?? null });
      expect(parsed.error).toBeNull();
      const rows = await desk.listCases(businessId, {
        // The parser refuses anything outside the vocabulary, so this is a
        // narrowing for the type system rather than a second check.
        status: isCaseStatus(parsed.filters.status) ? parsed.filters.status : undefined,
        priority: isCasePriority(parsed.filters.priority) ? parsed.filters.priority : undefined,
        q: parsed.filters.q || undefined,
        openOnly: parsed.filters.openOnly,
        assigneeUserId:
          caseViewAssigneeUserId(parsed.filters, viewerId) ?? undefined,
        unowned: caseViewUnownedOnly(parsed.filters),
        breachedOnly: parsed.filters.breachedOnly,
      });
      return rows.map((row) => row.id).sort();
    };

    const sorted = (...found: string[]) => [...found].sort();
    expect(await run({ assignee: "mine" })).toEqual(sorted(mine));
    // Nobody owns three of them — including the resolved one, which is exactly
    // why «بدون مسئول» is a filter somebody would save.
    expect(await run({ assignee: "none" })).toEqual(sorted(unowned, otherCustomer, resolved));
    expect(await run({ assignee: viewerId })).toEqual(sorted(mine));
    expect(await run({ status: "resolved" })).toEqual(sorted(resolved));
    expect(await run({ priority: "high" })).toEqual(sorted(unowned));
    expect(await run({ q: "یخچال" })).toEqual(sorted(mine));
    // The body is searched too — people describe the problem before they name
    // the thing — and so is the customer's name.
    expect(await run({ q: "نشتی" })).toEqual(sorted(mine));
    expect(await run({ q: "پرده" })).toEqual(sorted(otherCustomer));
    expect(await run({ q: "مشتری فیلترها" })).toEqual(sorted(mine, resolved));
    // Open is a status question, so the resolved ticket drops out.
    expect(await run({ open: "1" })).toEqual(sorted(mine, unowned, otherCustomer));
    // And the keys compose.
    expect(await run({ open: "1", priority: "urgent", assignee: "mine" })).toEqual(sorted(mine));
    expect(await run({ open: "1", breached: "1" })).toEqual(sorted(mine));
    // A resolved ticket is late for nothing: 30 hours old, four-hour target,
    // and not in this list, because the clock stopped when it was resolved and
    // nobody was blamed for the tab that stayed open.
    expect(await run({ breached: "1" })).toEqual(sorted(mine));

    // A key the vocabulary does not carry is ignored rather than guessed at.
    expect(await run({ search: "یخچال" })).toEqual(
      sorted(mine, unowned, resolved, otherCustomer),
    );

    // The rows the filter returned are the rows the clock agrees about: the
    // descriptor each row renders is the same rule the `breached` key applied.
    const flagged = await desk.listCases(businessId, { breachedOnly: true });
    for (const row of flagged) expect(caseIsBreached(row, new Date())).toBe(true);
  });

  it("round-trips a view saved through the service into the request the desk sends", async () => {
    const saved = await views.saveView(
      biz.id,
      {
        entity: "cases",
        name: "فوری‌های بی‌مسئول",
        filters: { priority: "urgent", assignee: "none", open: "1", breached: "1" },
        shared: true,
      },
      { name: actor.name, userId: null },
    );
    expect(saved.ok).toBe(true);
    const view = saved.ok ? saved.view : null;
    expect(view?.filters).toEqual({
      priority: "urgent",
      assignee: "none",
      open: "1",
      breached: "1",
    });

    // The screen serialises the stored document into a query and the server
    // parses that query with the same module: three readings, one answer.
    const query = caseViewQuery({
      q: "",
      status: "",
      priority: view!.filters.priority,
      assignee: view!.filters.assignee,
      openOnly: view!.filters.open === "1",
      breachedOnly: view!.filters.breached === "1",
    });
    expect(query).toEqual({
      priority: "urgent",
      assignee: "none",
      open: "1",
      breached: "1",
    });
    const parsed = parseCaseViewFilters({ get: (key) => query[key] ?? null });
    expect(parsed.error).toBeNull();
    expect(parsed.filters).toEqual({
      q: "",
      status: "",
      priority: "urgent",
      assignee: "none",
      openOnly: true,
      breachedOnly: true,
    });

    // A key the vocabulary does not carry is dropped rather than stored — the
    // desk's old `mine` is the case that matters: it is exactly a filter the
    // screen would never apply.
    const legacy = await views.saveView(
      biz.id,
      {
        entity: "cases",
        name: "با کلید قدیمی",
        filters: { assignee: "mine", mine: "1", breached: "1" },
        shared: true,
      },
      { name: actor.name, userId: null },
    );
    expect(legacy.ok && legacy.view.filters).toEqual({ assignee: "mine", breached: "1" });

    // An impossible value inside the vocabulary is refused *and named*, so the
    // screen can point at the control instead of showing a mystery.
    const bad = await views.saveView(
      biz.id,
      {
        entity: "cases",
        name: "با وضعیت نامعتبر",
        filters: { status: "pending" },
        shared: true,
      },
      { name: actor.name, userId: null },
    );
    expect(bad.ok).toBe(false);
    expect(bad.ok === false && bad.error).toBe("invalid_filters");
    expect(bad.ok === false && bad.field).toBe("status");

    // A saved view whose assignee is a name is refused too: `assigned_to` is a
    // display snapshot and two colleagues can share one.
    const byName = await views.saveView(
      biz.id,
      {
        entity: "cases",
        name: "با نام مسئول",
        filters: { assignee: "زهرا" },
        shared: true,
      },
      { name: actor.name, userId: null },
    );
    expect(byName.ok === false && byName.field).toBe("assignee");
  });
});
