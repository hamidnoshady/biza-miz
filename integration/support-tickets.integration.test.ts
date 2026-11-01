/**
 * Migration 0130 — the support ticketing platform against a real database.
 *
 * The pure vocabulary is unit-tested in src/lib/support-tickets.test.ts; this
 * proves the database round trip both surfaces (the member's «پشتیبانی»
 * section and the platform console) depend on:
 *
 * 1. **The member lifecycle** — open a ticket with its first message, list it
 *    (newest activity first, with message counts), read the conversation in
 *    order, reply (which moves the status forward and *reopens* a resolved or
 *    closed ticket), and close/reopen with the `closed_at` stamp.
 * 2. **Visibility rules** — owners/managers see the whole business queue,
 *    cashiers only their own tickets, and a ticket is unreachable across
 *    businesses — through every service entry point, not just the list.
 * 3. **The platform desk** — the cross-tenant queue with every console filter
 *    (status / priority / category / search / business / «فقطِ من»), the reply
 *    (which hands the ticket back as `waiting_customer` and writes an audit
 *    row), and the lifecycle controls (status / priority / category /
 *    assignee, with invalid values refused and `closed_at` kept in step).
 * 4. **RLS holds on the new tables** — both tables are RLS-enabled and forced
 *    with a scoping policy, and an unprivileged role can neither read nor
 *    write another business's tickets, nor insert into one.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { createAppRole, dropAppRole } from "../scripts/create-app-role";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const APP_ROLE = "pos_support_rls_role";
const APP_PASSWORD = "rls-test-password";

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let service: typeof import("../src/lib/support-service");
let platformService: typeof import("../src/lib/platform-service");
let cloudRelay: typeof import("../src/lib/cloud-exception-relay");

const alpha = { id: "", locationId: "", ownerId: "", cashierId: "" };
const beta = { id: "", locationId: "", cashierId: "" };
const admin = { id: "" };

function urlFor(database: string, user?: { name: string; password: string }): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  if (user) {
    url.username = user.name;
    url.password = user.password;
  }
  return url.toString();
}

function maintenanceUrl(): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = "/postgres";
  return url.toString();
}

beforeAll(async () => {
  databaseName = `pos_support_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  await createAppRole({
    databaseUrl: urlFor(databaseName),
    roleName: APP_ROLE,
    password: APP_PASSWORD,
    quiet: true,
  });

  // The lazy pool reads DATABASE_URL on first use, so point it at the fresh
  // database before importing anything that touches it (same shape as the
  // other integration files).
  process.env.DATABASE_URL = urlFor(databaseName);
  dbLib = await import("../src/lib/db");
  service = await import("../src/lib/support-service");
  platformService = await import("../src/lib/platform-service");
  cloudRelay = await import("../src/lib/cloud-exception-relay");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  async function seedBusiness(name: string, slug: string) {
    const biz = await db.query<{ id: string }>(
      "INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id",
      [name, slug],
    );
    const loc = await db.query<{ id: string }>(
      "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
      [biz.rows[0].id],
    );
    return { businessId: biz.rows[0].id, locationId: loc.rows[0].id };
  }

  const alphaBiz = await seedBusiness("Alpha Café", `alpha-${randomUUID().slice(0, 8)}`);
  const betaBiz = await seedBusiness("Beta Café", `beta-${randomUUID().slice(0, 8)}`);
  alpha.id = alphaBiz.businessId;
  alpha.locationId = alphaBiz.locationId;
  beta.id = betaBiz.businessId;
  beta.locationId = betaBiz.locationId;

  async function seedUser(businessId: string, locationId: string | null, role: string, name: string) {
    const row = await db.query<{ id: string }>(
      "INSERT INTO users (business_id, location_id, role, full_name, pin_hash) VALUES ($1, $2, $3, $4, 'x') RETURNING id",
      [businessId, locationId, role, name],
    );
    return row.rows[0].id;
  }

  alpha.ownerId = await seedUser(alpha.id, alpha.locationId, "owner", "Alpha Owner");
  alpha.cashierId = await seedUser(alpha.id, alpha.locationId, "cashier", "Alpha Cashier");
  beta.cashierId = await seedUser(beta.id, beta.locationId, "cashier", "Beta Cashier");

  const adminRow = await db.query<{ id: string }>(
    "INSERT INTO platform_admins (email, password_hash, full_name) VALUES ($1, 'x', 'Support Desk Admin') RETURNING id",
    [`support-desk-${randomUUID().slice(0, 8)}@example.com`],
  );
  admin.id = adminRow.rows[0].id;
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await dropAppRole(maintenance, APP_ROLE);
  } finally {
    await maintenance.end();
  }
});

/** Each test starts from an empty ticket board (fixtures are per-test). */
beforeEach(async () => {
  await db.query("DELETE FROM cloud_exception_response_receipts");
  await db.query("DELETE FROM cloud_exception_responses");
  await db.query("DELETE FROM cloud_exception_inbox");
  await db.query("DELETE FROM cloud_exception_installations");
  await db.query("DELETE FROM cloud_exception_outbox");
  await db.query("DELETE FROM support_ticket_messages");
  await db.query("DELETE FROM support_tickets");
  await db.query("DELETE FROM platform_audit_log");
});

function asAlpha<T>(fn: () => Promise<T>): Promise<T> {
  return dbLib.withTenant(alpha.id, fn, { locationId: alpha.locationId, userId: alpha.ownerId });
}

/** Opens a ticket through the member service, scoped to the given business. */
async function seedTicket(
  businessId: string,
  locationId: string,
  userId: string,
  overrides: Record<string, string> = {},
) {
  return dbLib.withTenant(businessId, () =>
    service.createMemberTicket({
      businessId,
      locationId,
      userId,
      subject: overrides.subject ?? "تیکت آزمایشی",
      category: overrides.category ?? "technical",
      priority: overrides.priority ?? "normal",
      body: overrides.body ?? "شرح اولیه.",
      attachment: null,
    }),
  );
}

describe("the member lifecycle", () => {
  it("commits the Local cloud relay envelope atomically with the ticket", async () => {
    const ticket = await seedTicket(alpha.id, alpha.locationId, alpha.ownerId);
    const { rows } = await db.query<{ kind: string; aggregate_id: string; payload: { ticketId: string } }>(
      "SELECT kind,aggregate_id::text,payload FROM cloud_exception_outbox WHERE business_id=$1",
      [alpha.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "support.ticket.created", aggregate_id: ticket.id });
    expect(rows[0].payload.ticketId).toBe(ticket.id);
  });

  it("opens a ticket with its first message and the right shape", async () => {
    const ticket = await asAlpha(() =>
      service.createMemberTicket({
        businessId: alpha.id,
        locationId: alpha.locationId,
        userId: alpha.ownerId,
        subject: "چاپگر کار نمی‌کند",
        category: "technical",
        priority: "high",
        body: "بعد از به‌روزرسانی چاپگر وصل نمی‌شود.",
        attachment: null,
      }),
    );

    expect(ticket.subject).toBe("چاپگر کار نمی‌کند");
    expect(ticket.category).toBe("technical");
    expect(ticket.priority).toBe("high");
    expect(ticket.status).toBe("open");
    expect(ticket.businessId).toBe(alpha.id);
    expect(ticket.locationId).toBe(alpha.locationId);
    expect(ticket.userId).toBe(alpha.ownerId);
    expect(ticket.messageCount).toBe(1);
    expect(ticket.messages).toHaveLength(1);
    expect(ticket.messages[0].authorType).toBe("member");
    expect(ticket.messages[0].userId).toBe(alpha.ownerId);
    expect(ticket.messages[0].body).toBe("بعد از به‌روزرسانی چاپگر وصل نمی‌شود.");
    expect(ticket.closedAt).toBeNull();
  });

  it("sanitises an unknown category and priority to the safe defaults", async () => {
    const ticket = await asAlpha(() =>
      service.createMemberTicket({
        businessId: alpha.id,
        locationId: alpha.locationId,
        userId: alpha.ownerId,
        subject: "چیز عجیب",
        category: "banana",
        priority: "banana",
        body: "متن آزمایشی.",
        attachment: null,
      }),
    );
    expect(ticket.category).toBe("other");
    expect(ticket.priority).toBe("normal");
  });

  it("lists the business's tickets newest-activity-first with a message preview", async () => {
    const first = await asAlpha(() =>
      service.createMemberTicket({
        businessId: alpha.id,
        locationId: alpha.locationId,
        userId: alpha.ownerId,
        subject: "اول",
        category: "other",
        priority: "normal",
        body: "پیام اول.",
        attachment: null,
      }),
    );
    await asAlpha(() =>
      service.createMemberTicket({
        businessId: alpha.id,
        locationId: alpha.locationId,
        userId: alpha.cashierId,
        subject: "دوم",
        category: "feature",
        priority: "low",
        body: "یک تیکت دیگر.",
        attachment: null,
      }),
    );
    // The reply to the first ticket makes it the one with the newer activity.
    await asAlpha(() =>
      service.addMemberMessage({
        businessId: alpha.id,
        userId: alpha.ownerId,
        role: "owner",
        ticketId: first.id,
        body: "پیام دوم.",
        attachment: null,
      }),
    );

    const list = await asAlpha(() =>
      service.listMemberTickets({ businessId: alpha.id, userId: alpha.ownerId, role: "owner" }),
    );
    // Two tickets: the one with the newer activity (a reply) comes first.
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe(first.id);
    expect(list[0].messageCount).toBe(2);
    expect(list[0].lastMessagePreview).toBe("پیام دوم.");
    expect(list[1].messageCount).toBe(1);
  });

  it("returns the conversation in chronological order", async () => {
    const ticket = await asAlpha(() =>
      service.createMemberTicket({
        businessId: alpha.id,
        locationId: alpha.locationId,
        userId: alpha.ownerId,
        subject: "ترتیب پیام‌ها",
        category: "other",
        priority: "normal",
        body: "اول",
        attachment: null,
      }),
    );
    await asAlpha(() =>
      service.addMemberMessage({
        businessId: alpha.id,
        userId: alpha.ownerId,
        role: "owner",
        ticketId: ticket.id,
        body: "دوم",
        attachment: null,
      }),
    );
    await asAlpha(() =>
      service.addMemberMessage({
        businessId: alpha.id,
        userId: alpha.ownerId,
        role: "owner",
        ticketId: ticket.id,
        body: "سوم",
        attachment: null,
      }),
    );

    const detail = await asAlpha(() =>
      service.getMemberTicket({ businessId: alpha.id, userId: alpha.ownerId, role: "owner", ticketId: ticket.id }),
    );
    expect(detail!.messages.map((m) => m.body)).toEqual(["اول", "دوم", "سوم"]);
  });

  it("a member reply moves the ticket forward, and reopens a resolved one", async () => {
    const ticket = await asAlpha(() =>
      service.createMemberTicket({
        businessId: alpha.id,
        locationId: alpha.locationId,
        userId: alpha.ownerId,
        subject: "پیگیری",
        category: "other",
        priority: "normal",
        body: "شروع.",
        attachment: null,
      }),
    );

    // open → in_progress
    await asAlpha(() =>
      service.addMemberMessage({
        businessId: alpha.id,
        userId: alpha.ownerId,
        role: "owner",
        ticketId: ticket.id,
        body: "جزئیات بیشتر.",
        attachment: null,
      }),
    );
    let current = await asAlpha(() =>
      service.getMemberTicket({ businessId: alpha.id, userId: alpha.ownerId, role: "owner", ticketId: ticket.id }),
    );
    expect(current!.status).toBe("in_progress");

    // Platform resolves it; the member's follow-up reopens it as `open`.
    await platformService.updateSupportTicket({
      ticketId: ticket.id,
      adminId: admin.id,
      status: "resolved",
    });
    await asAlpha(() =>
      service.addMemberMessage({
        businessId: alpha.id,
        userId: alpha.ownerId,
        role: "owner",
        ticketId: ticket.id,
        body: "هنوز حل نشده است.",
        attachment: null,
      }),
    );
    current = await asAlpha(() =>
      service.getMemberTicket({ businessId: alpha.id, userId: alpha.ownerId, role: "owner", ticketId: ticket.id }),
    );
    expect(current!.status).toBe("open");
    expect(current!.closedAt).toBeNull();
  });

  it("closing stamps closed_at and reopening clears it", async () => {
    const ticket = await asAlpha(() =>
      service.createMemberTicket({
        businessId: alpha.id,
        locationId: alpha.locationId,
        userId: alpha.ownerId,
        subject: "بستن",
        category: "other",
        priority: "normal",
        body: "شروع.",
        attachment: null,
      }),
    );

    await asAlpha(() =>
      service.setMemberTicketStatus({
        businessId: alpha.id,
        userId: alpha.ownerId,
        role: "owner",
        ticketId: ticket.id,
        status: "closed",
      }),
    );
    let current = await asAlpha(() =>
      service.getMemberTicket({ businessId: alpha.id, userId: alpha.ownerId, role: "owner", ticketId: ticket.id }),
    );
    expect(current!.status).toBe("closed");
    expect(current!.closedAt).not.toBeNull();

    await asAlpha(() =>
      service.setMemberTicketStatus({
        businessId: alpha.id,
        userId: alpha.ownerId,
        role: "owner",
        ticketId: ticket.id,
        status: "open",
      }),
    );
    current = await asAlpha(() =>
      service.getMemberTicket({ businessId: alpha.id, userId: alpha.ownerId, role: "owner", ticketId: ticket.id }),
    );
    expect(current!.status).toBe("open");
    expect(current!.closedAt).toBeNull();
  });

  it("rejects statuses the member may not set", async () => {
    const ticket = await asAlpha(() =>
      service.createMemberTicket({
        businessId: alpha.id,
        locationId: alpha.locationId,
        userId: alpha.ownerId,
        subject: "محدودیت",
        category: "other",
        priority: "normal",
        body: "شروع.",
        attachment: null,
      }),
    );
    await expect(
      asAlpha(() =>
        service.setMemberTicketStatus({
          businessId: alpha.id,
          userId: alpha.ownerId,
          role: "owner",
          ticketId: ticket.id,
          status: "resolved",
        }),
      ),
    ).rejects.toThrow("invalid_status");
  });

  it("validates subject, body and attachment", () => {
    const ok = service.validateTicketInput({
      subject: "عنوان",
      body: "شرح",
      attachment: null,
    });
    expect(ok.error).toBeNull();

    expect(service.validateTicketInput({ subject: "  ", body: "شرح", attachment: null }).error).toBe("subject_required");
    expect(
      service.validateTicketInput({ subject: "x".repeat(151), body: "شرح", attachment: null }).error,
    ).toBe("subject_too_long");
    expect(service.validateTicketInput({ subject: "عنوان", body: " ", attachment: null }).error).toBe("body_required");
    expect(
      service.validateTicketInput({ subject: "عنوان", body: "x".repeat(5001), attachment: null }).error,
    ).toBe("body_too_long");
    expect(
      service.validateTicketInput({
        subject: "عنوان",
        body: "شرح",
        attachment: `data:image/jpeg;base64,${"x".repeat(4 * 1024 * 1024 + 1)}`,
      }).error,
    ).toBe("attachment_too_large");
    expect(
      service.validateTicketInput({ subject: "عنوان", body: "شرح", attachment: "data:text/plain,hello" }).error,
    ).toBe("attachment_invalid");
  });
});

describe("standalone-installation cloud relay", () => {
  it("leases concurrent delivery once and deletes only after central acceptance", async () => {
    const previousRole = process.env.DEPLOYMENT_ROLE;
    const previousUrl = process.env.SUPPORT_CLOUD_URL;
    const previousToken = process.env.SUPPORT_RELAY_TOKEN;
    const previousInstallation = process.env.SUPPORT_INSTALLATION_ID;
    const previousFetch = globalThis.fetch;
    process.env.DEPLOYMENT_ROLE = "site";
    process.env.SUPPORT_CLOUD_URL = "https://support.example.test";
    process.env.SUPPORT_RELAY_TOKEN = "test-token";
    process.env.SUPPORT_INSTALLATION_ID = randomUUID();
    let requests = 0;
    globalThis.fetch = async () => { requests += 1; return new Response("{}", { status: 200 }); };
    try {
      await db.query(
        `INSERT INTO cloud_exception_outbox(business_id,kind,aggregate_id,payload)
         VALUES($1,'bug_report.created',$2,'{}')`, [alpha.id, randomUUID()],
      );
      const results = await Promise.all([
        dbLib.withTenant(alpha.id, () => cloudRelay.deliverCloudExceptions(alpha.id)),
        dbLib.withTenant(alpha.id, () => cloudRelay.deliverCloudExceptions(alpha.id)),
      ]);
      expect(results.reduce((sum, result) => sum + result.delivered, 0)).toBe(1);
      expect(requests).toBe(1);
      const pending = await db.query<{ count: string }>("SELECT count(*)::text count FROM cloud_exception_outbox WHERE business_id=$1", [alpha.id]);
      expect(pending.rows[0].count).toBe("0");
    } finally {
      globalThis.fetch = previousFetch;
      if (previousRole === undefined) delete process.env.DEPLOYMENT_ROLE; else process.env.DEPLOYMENT_ROLE = previousRole;
      if (previousUrl === undefined) delete process.env.SUPPORT_CLOUD_URL; else process.env.SUPPORT_CLOUD_URL = previousUrl;
      if (previousToken === undefined) delete process.env.SUPPORT_RELAY_TOKEN; else process.env.SUPPORT_RELAY_TOKEN = previousToken;
      if (previousInstallation === undefined) delete process.env.SUPPORT_INSTALLATION_ID; else process.env.SUPPORT_INSTALLATION_ID = previousInstallation;
    }
  });

  it("releases failed leases and schedules bounded retry without provider details", async () => {
    const saved = { role: process.env.DEPLOYMENT_ROLE, url: process.env.SUPPORT_CLOUD_URL, token: process.env.SUPPORT_RELAY_TOKEN, installation: process.env.SUPPORT_INSTALLATION_ID, fetch: globalThis.fetch };
    process.env.DEPLOYMENT_ROLE = "site";
    process.env.SUPPORT_CLOUD_URL = "https://support.example.test";
    process.env.SUPPORT_RELAY_TOKEN = "test-token";
    process.env.SUPPORT_INSTALLATION_ID = randomUUID();
    globalThis.fetch = async () => new Response("upstream secret failure", { status: 503 });
    try {
      const inserted = await db.query<{ event_id: string }>(
        `INSERT INTO cloud_exception_outbox(business_id,kind,aggregate_id,payload)
         VALUES($1,'support.ticket.created',$2,'{}') RETURNING event_id::text`, [alpha.id, randomUUID()],
      );
      await dbLib.withTenant(alpha.id, () => cloudRelay.deliverCloudExceptions(alpha.id));
      const row = await db.query<{ lease_until: string | null; attempt_count: number; last_error_code: string; future: boolean }>(
        `SELECT lease_until::text,attempt_count,last_error_code,next_attempt_at>now() future
           FROM cloud_exception_outbox WHERE event_id=$1`, [inserted.rows[0].event_id],
      );
      expect(row.rows[0]).toMatchObject({ lease_until: null, attempt_count: 1, last_error_code: "relay_unreachable", future: true });
      expect(JSON.stringify(row.rows[0])).not.toContain("upstream secret failure");
    } finally {
      globalThis.fetch = saved.fetch;
      if (saved.role === undefined) delete process.env.DEPLOYMENT_ROLE; else process.env.DEPLOYMENT_ROLE = saved.role;
      if (saved.url === undefined) delete process.env.SUPPORT_CLOUD_URL; else process.env.SUPPORT_CLOUD_URL = saved.url;
      if (saved.token === undefined) delete process.env.SUPPORT_RELAY_TOKEN; else process.env.SUPPORT_RELAY_TOKEN = saved.token;
      if (saved.installation === undefined) delete process.env.SUPPORT_INSTALLATION_ID; else process.env.SUPPORT_INSTALLATION_ID = saved.installation;
    }
  });

  it("stores only a token hash and deduplicates retried envelopes", async () => {
    const issued = await dbLib.withoutTenantScope("platform", () =>
      cloudRelay.provisionCloudExceptionInstallation("Local cafe"),
    );
    expect(await cloudRelay.authenticateCloudExceptionInstallation(issued.installationId, issued.token)).toBe(true);
    expect(await cloudRelay.authenticateCloudExceptionInstallation(issued.installationId, `${issued.token}x`)).toBe(false);
    const event = {
      eventId: randomUUID(), kind: "bug_report.created" as const, aggregateId: randomUUID(),
      payload: { description: "safe diagnostic" }, occurredAt: new Date().toISOString(),
    };
    await cloudRelay.acceptCloudExceptionBatch({ installationId: issued.installationId, events: [event] });
    await cloudRelay.acceptCloudExceptionBatch({ installationId: issued.installationId, events: [event] });
    const count = await db.query<{ count: string }>(
      "SELECT count(*)::text count FROM cloud_exception_inbox WHERE installation_id=$1",
      [issued.installationId],
    );
    expect(count.rows[0].count).toBe("1");
    const credential = await db.query<{ token_hash: string }>(
      "SELECT token_hash FROM cloud_exception_installations WHERE installation_id=$1",
      [issued.installationId],
    );
    expect(credential.rows[0].token_hash).not.toContain(issued.token);
  });

  it("delivers an operator reply back to the Local ticket exactly once and acknowledges it", async () => {
    const ticket = await asAlpha(() => service.createMemberTicket({
      businessId: alpha.id, locationId: alpha.locationId, userId: alpha.ownerId,
      subject: "Need help", category: "other", priority: "normal", body: "Opening message", attachment: null,
    }));
    const issued = await dbLib.withoutTenantScope("platform", () =>
      cloudRelay.provisionCloudExceptionInstallation("Local reply test"),
    );
    const inbox = await db.query<{ id: string }>(
      `INSERT INTO cloud_exception_inbox(installation_id,event_id,kind,aggregate_id,payload,occurred_at)
       VALUES($1,$2,'support.ticket.created',$3,'{}',now()) RETURNING id::text`,
      [issued.installationId, randomUUID(), ticket.id],
    );
    await cloudRelay.queueCloudExceptionResponse(inbox.rows[0].id, admin.id, "Operator answer");

    const saved = { role: process.env.DEPLOYMENT_ROLE, url: process.env.SUPPORT_CLOUD_URL, token: process.env.SUPPORT_RELAY_TOKEN, installation: process.env.SUPPORT_INSTALLATION_ID, fetch: globalThis.fetch };
    process.env.DEPLOYMENT_ROLE = "site";
    process.env.SUPPORT_CLOUD_URL = "https://support.example.test";
    process.env.SUPPORT_RELAY_TOKEN = issued.token;
    process.env.SUPPORT_INSTALLATION_ID = issued.installationId;
    globalThis.fetch = async (_input, init) => {
      if (init?.method === "PATCH") {
        const ack = JSON.parse(String(init.body)) as { responseIds: string[] };
        await cloudRelay.acknowledgeCloudExceptionResponses(issued.installationId, ack.responseIds);
        return new Response("{}", { status: 200 });
      }
      return Response.json({ responses: await cloudRelay.pendingCloudExceptionResponses(issued.installationId) });
    };
    try {
      expect(await cloudRelay.pullCloudExceptionResponses()).toBe(1);
      expect(await cloudRelay.pullCloudExceptionResponses()).toBe(0);
      const messages = await db.query<{ author_type: string; body: string }>(
        "SELECT author_type,body FROM support_ticket_messages WHERE ticket_id=$1 ORDER BY created_at", [ticket.id],
      );
      expect(messages.rows).toEqual([
        { author_type: "member", body: "Opening message" },
        { author_type: "admin", body: "Operator answer" },
      ]);
      const response = await db.query<{ acknowledged: boolean }>(
        "SELECT acknowledged_at IS NOT NULL acknowledged FROM cloud_exception_responses WHERE ticket_id=$1", [ticket.id],
      );
      expect(response.rows[0].acknowledged).toBe(true);
    } finally {
      globalThis.fetch = saved.fetch;
      if (saved.role === undefined) delete process.env.DEPLOYMENT_ROLE; else process.env.DEPLOYMENT_ROLE = saved.role;
      if (saved.url === undefined) delete process.env.SUPPORT_CLOUD_URL; else process.env.SUPPORT_CLOUD_URL = saved.url;
      if (saved.token === undefined) delete process.env.SUPPORT_RELAY_TOKEN; else process.env.SUPPORT_RELAY_TOKEN = saved.token;
      if (saved.installation === undefined) delete process.env.SUPPORT_INSTALLATION_ID; else process.env.SUPPORT_INSTALLATION_ID = saved.installation;
    }
  });
});

describe("visibility rules", () => {
  it("owners see the whole business queue; cashiers only their own", async () => {
    const ownerTicket = await asAlpha(() =>
      service.createMemberTicket({
        businessId: alpha.id,
        locationId: alpha.locationId,
        userId: alpha.ownerId,
        subject: "تیکت مالک",
        category: "other",
        priority: "normal",
        body: "شروع.",
        attachment: null,
      }),
    );
    const cashierTicket = await asAlpha(() =>
      service.createMemberTicket({
        businessId: alpha.id,
        locationId: alpha.locationId,
        userId: alpha.cashierId,
        subject: "تیکت صندوق‌دار",
        category: "other",
        priority: "normal",
        body: "شروع.",
        attachment: null,
      }),
    );

    const ownerView = await asAlpha(() =>
      service.listMemberTickets({ businessId: alpha.id, userId: alpha.ownerId, role: "owner" }),
    );
    expect(ownerView).toHaveLength(2);

    const cashierView = await dbLib.withTenant(alpha.id, () =>
      service.listMemberTickets({ businessId: alpha.id, userId: alpha.cashierId, role: "cashier" }),
    );
    expect(cashierView).toHaveLength(1);
    // The only ticket in the cashier's queue is the one they opened themselves.
    expect(cashierView[0].id).toBe(cashierTicket.id);
    expect(cashierView[0].userId).toBe(alpha.cashierId);
    expect(ownerTicket.id).not.toBe(cashierTicket.id);
  });

  it("a cashier cannot read, reply to, or close an owner's ticket", async () => {
    const ownerTicket = await asAlpha(() =>
      service.createMemberTicket({
        businessId: alpha.id,
        locationId: alpha.locationId,
        userId: alpha.ownerId,
        subject: "محرمانه",
        category: "other",
        priority: "normal",
        body: "شروع.",
        attachment: null,
      }),
    );

    await expect(
      dbLib.withTenant(alpha.id, () =>
        service.getMemberTicket({ businessId: alpha.id, userId: alpha.cashierId, role: "cashier", ticketId: ownerTicket.id }),
      ),
    ).resolves.toBeNull();

    await expect(
      dbLib.withTenant(alpha.id, () =>
        service.addMemberMessage({
          businessId: alpha.id,
          userId: alpha.cashierId,
          role: "cashier",
          ticketId: ownerTicket.id,
          body: "نفوذ",
          attachment: null,
        }),
      ),
    ).rejects.toThrow("ticket_not_found");

    await expect(
      dbLib.withTenant(alpha.id, () =>
        service.setMemberTicketStatus({
          businessId: alpha.id,
          userId: alpha.cashierId,
          role: "cashier",
          ticketId: ownerTicket.id,
          status: "closed",
        }),
      ),
    ).rejects.toThrow("ticket_not_found");
  });

  it("one business cannot see another business's tickets", async () => {
    await asAlpha(() =>
      service.createMemberTicket({
        businessId: alpha.id,
        locationId: alpha.locationId,
        userId: alpha.ownerId,
        subject: "فقط آلفا",
        category: "other",
        priority: "normal",
        body: "شروع.",
        attachment: null,
      }),
    );

    const betaList = await dbLib.withTenant(beta.id, () =>
      service.listMemberTickets({ businessId: beta.id, userId: beta.cashierId, role: "cashier" }),
    );
    expect(betaList).toEqual([]);

    // Even an owner of Beta (who may see the whole queue) sees nothing of Alpha.
    const betaOwnerView = await dbLib.withTenant(beta.id, () =>
      service.listMemberTickets({ businessId: beta.id, userId: beta.cashierId, role: "owner" }),
    );
    expect(betaOwnerView).toEqual([]);
  });
});

describe("the platform desk", () => {
  it("lists tickets across businesses with the reporter's names", async () => {
    const alphaTicket = await seedTicket(alpha.id, alpha.locationId, alpha.ownerId, { subject: "تیکت آلفا" });
    const betaTicket = await seedTicket(beta.id, beta.locationId, beta.cashierId, { subject: "تیکت بتا" });

    const all = (await platformService.querySupportTickets()).tickets;
    expect(all.map((t) => t.id).sort()).toEqual([alphaTicket.id, betaTicket.id].sort());

    const alphaRow = all.find((t) => t.id === alphaTicket.id)!;
    expect(alphaRow.businessName).toBe("Alpha Café");
    expect(alphaRow.userName).toBe("Alpha Owner");
    expect(alphaRow.messageCount).toBe(1);
    expect(alphaRow.lastMessagePreview).toBe("شرح اولیه.");
  });

  it("applies the console's filters: status, priority, category, business, search and «فقطِ من»", async () => {
    const urgent = await seedTicket(alpha.id, alpha.locationId, alpha.ownerId, { priority: "urgent", subject: "فوری آلفا" });
    const billing = await seedTicket(alpha.id, alpha.locationId, alpha.cashierId, { category: "billing", subject: "قبض" });
    const betaTicket = await seedTicket(beta.id, beta.locationId, beta.cashierId, { priority: "urgent" });
    await platformService.updateSupportTicket({ ticketId: billing.id, adminId: admin.id, status: "closed" });

    const ids = async (q: Parameters<typeof platformService.querySupportTickets>[0]) =>
      (await platformService.querySupportTickets(q)).tickets.map((t) => t.id);

    expect((await ids({ priority: "urgent" })).sort()).toEqual([urgent.id, betaTicket.id].sort());
    expect(await ids({ status: "closed" })).toEqual([billing.id]);
    expect(await ids({ category: "billing" })).toEqual([billing.id]);
    expect(await ids({ businessId: beta.id })).toEqual([betaTicket.id]);

    // Search hits the subject and the message bodies.
    expect(await ids({ search: "قبض" })).toEqual([billing.id]);
    expect(await ids({ search: "شرح اولیه" })).toEqual(
      expect.arrayContaining([urgent.id, betaTicket.id]),
    );

    // «فقطِ من» shows only tickets assigned to the acting admin.
    await platformService.updateSupportTicket({ ticketId: betaTicket.id, adminId: admin.id, assignedAdminId: admin.id });
    const mine = await ids({ assignedToMe: true, adminId: admin.id });
    expect(mine).toEqual([betaTicket.id]);
  });

  it("paginates server-side and clamps the page size", async () => {
    // Seed enough tickets to require more than one page at pageSize 2.
    for (let i = 0; i < 5; i++) {
      await seedTicket(alpha.id, alpha.locationId, alpha.ownerId, { subject: `صفحه‌بندی ${i}` });
    }
    const first = await platformService.querySupportTickets({ pageSize: 2, search: "صفحه‌بندی" });
    expect(first.total).toBe(5);
    expect(first.tickets).toHaveLength(2);
    expect(first.page).toBe(1);

    const second = await platformService.querySupportTickets({ pageSize: 2, page: 2, search: "صفحه‌بندی" });
    expect(second.tickets).toHaveLength(2);
    // No overlap between pages.
    expect(second.tickets.some((t) => first.tickets.map((x) => x.id).includes(t.id))).toBe(false);

    const clamped = await platformService.querySupportTickets({ pageSize: 100_000 });
    expect(clamped.pageSize).toBeLessThanOrEqual(100);
  });

  it("an admin reply hands the ticket back to the member and is audited", async () => {
    const ticket = await seedTicket(alpha.id, alpha.locationId, alpha.ownerId);

    const message = await platformService.addSupportMessage({
      ticketId: ticket.id,
      adminId: admin.id,
      body: "بررسی شد؛ به‌روزرسانی نصب کنید.",
      attachment: null,
    });
    expect(message.authorType).toBe("admin");
    expect(message.adminId).toBe(admin.id);

    const detail = await platformService.getSupportTicket(ticket.id);
    expect(detail!.status).toBe("waiting_customer");
    expect(detail!.messages).toHaveLength(2);
    expect(detail!.messages[1].body).toBe("بررسی شد؛ به‌روزرسانی نصب کنید.");

    const audit = await db.query<{ platform_admin_id: string; business_id: string }>(
      `SELECT platform_admin_id::text AS platform_admin_id, business_id::text AS business_id
         FROM platform_audit_log WHERE action = 'support.ticket.reply' AND entity_id = $1`,
      [ticket.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].platform_admin_id).toBe(admin.id);
    expect(audit.rows[0].business_id).toBe(alpha.id);
  });

  it("an admin reply to a closed ticket leaves it closed", async () => {
    const ticket = await seedTicket(alpha.id, alpha.locationId, alpha.ownerId);
    await platformService.updateSupportTicket({ ticketId: ticket.id, adminId: admin.id, status: "closed" });
    await platformService.addSupportMessage({ ticketId: ticket.id, adminId: admin.id, body: "پاسخ به تیکت بسته.", attachment: null });

    const detail = await platformService.getSupportTicket(ticket.id);
    expect(detail!.status).toBe("closed");
    expect(detail!.closedAt).not.toBeNull();
    expect(detail!.messages).toHaveLength(2);
  });

  it("updates status, priority, category and assignee, and stamps closed_at", async () => {
    const ticket = await seedTicket(alpha.id, alpha.locationId, alpha.ownerId);

    const updated = await platformService.updateSupportTicket({
      ticketId: ticket.id,
      adminId: admin.id,
      status: "resolved",
      priority: "urgent",
      category: "billing",
      assignedAdminId: admin.id,
    });
    expect(updated!.status).toBe("resolved");
    expect(updated!.priority).toBe("urgent");
    expect(updated!.category).toBe("billing");
    expect(updated!.assignedAdminId).toBe(admin.id);
    expect(updated!.assignedAdminName).toBe("Support Desk Admin");

    // Closing stamps the timestamp; moving on clears it.
    await platformService.updateSupportTicket({ ticketId: ticket.id, adminId: admin.id, status: "closed" });
    expect((await platformService.getSupportTicket(ticket.id))!.closedAt).not.toBeNull();
    await platformService.updateSupportTicket({ ticketId: ticket.id, adminId: admin.id, status: "open" });
    expect((await platformService.getSupportTicket(ticket.id))!.closedAt).toBeNull();

    // Unassigning works and is audited as a change.
    await platformService.updateSupportTicket({ ticketId: ticket.id, adminId: admin.id, assignedAdminId: null });
    expect((await platformService.getSupportTicket(ticket.id))!.assignedAdminId).toBeNull();

    const audit = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM platform_audit_log WHERE action = 'support.ticket.update' AND entity_id = $1`,
      [ticket.id],
    );
    expect(Number(audit.rows[0].n)).toBe(4);
  });

  it("refuses invalid status, priority, category and assignee", async () => {
    const ticket = await seedTicket(alpha.id, alpha.locationId, alpha.ownerId);

    await expect(
      platformService.updateSupportTicket({ ticketId: ticket.id, adminId: admin.id, status: "banana" }),
    ).rejects.toThrow("invalid_status");
    await expect(
      platformService.updateSupportTicket({ ticketId: ticket.id, adminId: admin.id, priority: "banana" }),
    ).rejects.toThrow("invalid_priority");
    await expect(
      platformService.updateSupportTicket({ ticketId: ticket.id, adminId: admin.id, category: "banana" }),
    ).rejects.toThrow("invalid_category");
    // A random uuid is not an admin.
    await expect(
      platformService.updateSupportTicket({
        ticketId: ticket.id,
        adminId: admin.id,
        assignedAdminId: randomUUID(),
      }),
    ).rejects.toThrow("invalid_assignee");

    // None of the refusals wrote anything.
    const audit = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM platform_audit_log WHERE entity_id = $1`,
      [ticket.id],
    );
    expect(Number(audit.rows[0].n)).toBe(0);
    const detail = await platformService.getSupportTicket(ticket.id);
    expect(detail!.status).toBe("open");
    expect(detail!.priority).toBe("normal");
  });

  it("stats count the open work and the urgent/unassigned backlog", async () => {
    const urgent = await seedTicket(alpha.id, alpha.locationId, alpha.ownerId, { priority: "urgent" });
    await seedTicket(alpha.id, alpha.locationId, alpha.cashierId);
    await seedTicket(beta.id, beta.locationId, beta.cashierId);
    await platformService.updateSupportTicket({ ticketId: urgent.id, adminId: admin.id, status: "closed" });

    const stats = await platformService.supportTicketStats();
    expect(stats.total).toBe(3);
    expect(stats.open).toBe(2);
    expect(stats.inProgress).toBe(0);
    expect(stats.waitingCustomer).toBe(0);
    expect(stats.resolved).toBe(0);
    expect(stats.closed).toBe(1);
    expect(stats.urgentOpen).toBe(0);
    expect(stats.unassignedOpen).toBe(2);
  });

  it("lists only active platform admins as assignable", async () => {
    const inactive = await db.query<{ id: string }>(
      "INSERT INTO platform_admins (email, password_hash, full_name, is_active) VALUES ($1, 'x', 'Inactive Admin', false) RETURNING id",
      [`inactive-${randomUUID().slice(0, 8)}@example.com`],
    );
    const assignable = await platformService.listAssignablePlatformAdmins();
    const ids = assignable.map((a) => a.id);
    expect(ids).toContain(admin.id);
    expect(ids).not.toContain(inactive.rows[0].id);
  });
});

describe("RLS protects the new tables", () => {
  it("both tables are RLS-enabled and forced, with a scoping policy", async () => {
    const { rows } = await db.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean; policies: string }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
              (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::text AS policies
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
        WHERE c.relname IN ('support_tickets', 'support_ticket_messages')`,
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.relrowsecurity, row.relname).toBe(true);
      expect(row.relforcerowsecurity, row.relname).toBe(true);
      expect(Number(row.policies), row.relname).toBeGreaterThan(0);
    }
  });

  it("an unprivileged role can neither read nor write another business's tickets", async () => {
    // Seed one ticket per business, plus a message on Alpha's.
    await seedTicket(alpha.id, alpha.locationId, alpha.ownerId, { subject: "آلفا" });
    const betaTicket = await seedTicket(beta.id, beta.locationId, beta.cashierId, { subject: "بتا" });
    await db.query(
      `INSERT INTO support_ticket_messages (ticket_id, business_id, author_type, user_id, body)
       SELECT id, business_id, 'member', user_id, 'پیام آلفا' FROM support_tickets WHERE subject = 'آلفا'`,
    );
    const alphaTicketRow = await db.query<{ id: string }>(
      "SELECT id FROM support_tickets WHERE subject = 'آلفا'",
    );
    const alphaTicketId = alphaTicketRow.rows[0].id;

    const app = new Client({
      connectionString: urlFor(databaseName, { name: APP_ROLE, password: APP_PASSWORD }),
    });
    await app.connect();
    try {
      // The role itself must be unprivileged, or every RLS assertion is vacuous.
      const { rows: priv } = await app.query<{ privileged: boolean }>(
        "SELECT (rolsuper OR rolbypassrls) AS privileged FROM pg_roles WHERE rolname = current_user",
      );
      expect(priv[0].privileged).toBe(false);

      // Scoped to Alpha: only Alpha's ticket and its messages are visible.
      await app.query("SELECT set_config('app.business_id', $1, false)", [alpha.id]);
      const alphaCount = await app.query<{ n: string }>("SELECT count(*)::text AS n FROM support_tickets");
      expect(Number(alphaCount.rows[0].n)).toBe(1);
      // Alpha's ticket carries its opening message plus the one added below.
      const alphaMessages = await app.query<{ n: string }>("SELECT count(*)::text AS n FROM support_ticket_messages");
      expect(Number(alphaMessages.rows[0].n)).toBe(2);

      // Scoped to Beta: Beta's ticket is visible, Alpha's is not.
      await app.query("SELECT set_config('app.business_id', $1, false)", [beta.id]);
      const betaCount = await app.query<{ n: string }>("SELECT count(*)::text AS n FROM support_tickets");
      expect(Number(betaCount.rows[0].n)).toBe(1);
      const betaIds = await app.query<{ id: string }>("SELECT id::text AS id FROM support_tickets");
      expect(betaIds.rows[0].id).toBe(betaTicket.id);
      // …and Beta sees only its own message (Alpha's two are invisible).
      const betaMessages = await app.query<{ n: string }>("SELECT count(*)::text AS n FROM support_ticket_messages");
      expect(Number(betaMessages.rows[0].n)).toBe(1);

      // A cross-business UPDATE touches zero rows.
      const upd = await app.query(
        "UPDATE support_tickets SET status = 'closed' WHERE id = $1::uuid",
        [alphaTicketId],
      );
      expect(upd.rowCount).toBe(0);

      // A cross-business DELETE touches zero rows.
      const del = await app.query("DELETE FROM support_tickets WHERE id = $1::uuid", [alphaTicketId]);
      expect(del.rowCount).toBe(0);

      // An INSERT naming another business is refused outright (WITH CHECK).
      await expect(
        app.query(
          "INSERT INTO support_tickets (business_id, subject) VALUES ($1::uuid, 'نفوذ')",
          [alpha.id],
        ),
      ).rejects.toThrow("row-level security");
    } finally {
      await app.end();
    }
  });
});
