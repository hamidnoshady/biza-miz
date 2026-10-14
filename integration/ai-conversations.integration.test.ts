/**
 * AI Hub Wave 1 (Issue #141) exit criterion, against a real database.
 *
 * The generic `tenant-isolation.integration.test.ts` proves ai_conversations/
 * ai_messages carry RLS like every other tenant table, but RLS alone only
 * draws the business boundary. This wave's product decision goes narrower —
 * a conversation is visible only to the member who started it, not the whole
 * business — and that ownership boundary is enforced by ai-conversations.ts,
 * not by a database policy, so it needs its own coverage: user A must not be
 * able to read or delete user B's conversation even though both share one
 * business (and therefore one RLS scope).
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;

let ai: typeof import("../src/lib/ai-conversations");
let dbLib: typeof import("../src/lib/db");

const alpha = { businessId: "", userA: "", userB: "" };
const beta = { businessId: "", userA: "" };

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
  databaseName = `pos_ai_conv_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  ai = await import("../src/lib/ai-conversations");
  dbLib = await import("../src/lib/db");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

beforeEach(async () => {
  await db.query("DELETE FROM businesses");
  const alphaBiz = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Alpha', $1) RETURNING id",
    [`alpha-${randomUUID().slice(0, 8)}`],
  );
  const betaBiz = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Beta', $1) RETURNING id",
    [`beta-${randomUUID().slice(0, 8)}`],
  );
  alpha.businessId = alphaBiz.rows[0].id;
  alpha.userA = randomUUID();
  alpha.userB = randomUUID();
  beta.businessId = betaBiz.rows[0].id;
  beta.userA = randomUUID();
});

/** Runs `fn` scoped to a business, the way an authenticated request would be. */
function asBusiness<T>(businessId: string, fn: () => Promise<T>): Promise<T> {
  return dbLib.withTenant(businessId, fn);
}

describe("conversation ownership within one business", () => {
  it("keeps user A's conversation out of user B's list, get, and delete", async () => {
    const created = await asBusiness(alpha.businessId, () =>
      ai.getOrCreateConversation({
        businessId: alpha.businessId,
        actorUserId: alpha.userA,
        mode: "dashboard",
        conversationId: null,
        firstMessageContent: "فروش امروز چقدر بود؟",
      }),
    );
    expect(created.isNew).toBe(true);
    await asBusiness(alpha.businessId, () =>
      ai.appendMessage({ conversationId: created.id, role: "user", content: "فروش امروز چقدر بود؟" }),
    );

    const bList = await asBusiness(alpha.businessId, () =>
      ai.listConversations({ businessId: alpha.businessId, actorUserId: alpha.userB }),
    );
    expect(bList).toHaveLength(0);

    const bGet = await asBusiness(alpha.businessId, () =>
      ai.getConversationMessages({
        businessId: alpha.businessId,
        actorUserId: alpha.userB,
        conversationId: created.id,
      }),
    );
    expect(bGet).toBeNull();

    const bDelete = await asBusiness(alpha.businessId, () =>
      ai.deleteConversation({ businessId: alpha.businessId, actorUserId: alpha.userB, conversationId: created.id }),
    );
    expect(bDelete).toBe(false);

    const aList = await asBusiness(alpha.businessId, () =>
      ai.listConversations({ businessId: alpha.businessId, actorUserId: alpha.userA }),
    );
    expect(aList).toHaveLength(1);
    expect(aList[0].id).toBe(created.id);
  });

  it("never resumes another user's conversation id — starts a new one instead", async () => {
    const ownedByA = await asBusiness(alpha.businessId, () =>
      ai.getOrCreateConversation({
        businessId: alpha.businessId,
        actorUserId: alpha.userA,
        mode: "dashboard",
        conversationId: null,
        firstMessageContent: "گزارش هفتگی",
      }),
    );

    const resumedByB = await asBusiness(alpha.businessId, () =>
      ai.getOrCreateConversation({
        businessId: alpha.businessId,
        actorUserId: alpha.userB,
        mode: "dashboard",
        conversationId: ownedByA.id,
        firstMessageContent: "موجودی انبار",
      }),
    );

    expect(resumedByB.isNew).toBe(true);
    expect(resumedByB.id).not.toBe(ownedByA.id);
  });

  it("does not resume across businesses even for a matching conversation id (defense in depth over RLS)", async () => {
    const ownedByAlpha = await asBusiness(alpha.businessId, () =>
      ai.getOrCreateConversation({
        businessId: alpha.businessId,
        actorUserId: alpha.userA,
        mode: "dashboard",
        conversationId: null,
        firstMessageContent: "سود امروز",
      }),
    );

    const resumedFromBeta = await asBusiness(beta.businessId, () =>
      ai.getOrCreateConversation({
        businessId: beta.businessId,
        actorUserId: beta.userA,
        mode: "dashboard",
        conversationId: ownedByAlpha.id,
        firstMessageContent: "سود امروز",
      }),
    );

    expect(resumedFromBeta.isNew).toBe(true);
    expect(resumedFromBeta.id).not.toBe(ownedByAlpha.id);
  });
});

describe("searchConversations (AI Hub Wave 5, issue #145)", () => {
  it("matches on title or message content, scoped to the searching user's own conversations", async () => {
    const ownedByA = await asBusiness(alpha.businessId, () =>
      ai.getOrCreateConversation({
        businessId: alpha.businessId,
        actorUserId: alpha.userA,
        mode: "dashboard",
        conversationId: null,
        firstMessageContent: "موجودی انبار چقدر است؟",
      }),
    );
    await asBusiness(alpha.businessId, () =>
      ai.appendMessage({ conversationId: ownedByA.id, role: "user", content: "موجودی انبار چقدر است؟" }),
    );
    await asBusiness(alpha.businessId, () =>
      ai.appendMessage({ conversationId: ownedByA.id, role: "assistant", content: "کالای الف رو به اتمام است." }),
    );

    const ownedByB = await asBusiness(alpha.businessId, () =>
      ai.getOrCreateConversation({
        businessId: alpha.businessId,
        actorUserId: alpha.userB,
        mode: "dashboard",
        conversationId: null,
        firstMessageContent: "موجودی انبار امروز",
      }),
    );

    const aByTitle = await asBusiness(alpha.businessId, () =>
      ai.searchConversations({ businessId: alpha.businessId, actorUserId: alpha.userA }, "انبار"),
    );
    expect(aByTitle.map((r) => r.id)).toEqual([ownedByA.id]);
    expect(aByTitle.map((r) => r.id)).not.toContain(ownedByB.id);

    const aByMessageContent = await asBusiness(alpha.businessId, () =>
      ai.searchConversations({ businessId: alpha.businessId, actorUserId: alpha.userA }, "کالای الف"),
    );
    expect(aByMessageContent.map((r) => r.id)).toEqual([ownedByA.id]);

    const noMatch = await asBusiness(alpha.businessId, () =>
      ai.searchConversations({ businessId: alpha.businessId, actorUserId: alpha.userA }, "چیزی که وجود ندارد"),
    );
    expect(noMatch).toHaveLength(0);

    const emptyQuery = await asBusiness(alpha.businessId, () =>
      ai.searchConversations({ businessId: alpha.businessId, actorUserId: alpha.userA }, "   "),
    );
    expect(emptyQuery).toHaveLength(0);
  });
});

describe("listConversationsByProject (Phase F — a project's own threads)", () => {
  async function seedProject(businessId: string, name: string): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      "INSERT INTO ai_projects (business_id, name, created_by) VALUES ($1, $2, 'seed') RETURNING id",
      [businessId, name],
    );
    return rows[0].id;
  }

  it("returns only the caller's own conversations for one project, newest first", async () => {
    const projX = await seedProject(alpha.businessId, "کمپین بهار");
    const projY = await seedProject(alpha.businessId, "کمپین پاییز");

    // Two of user A's threads in project X, one in project Y, plus a project-less
    // thread; and one of user B's threads in project X.
    const aX1 = await asBusiness(alpha.businessId, () =>
      ai.getOrCreateConversation({
        businessId: alpha.businessId, actorUserId: alpha.userA, mode: "dashboard",
        conversationId: null, firstMessageContent: "اول", projectId: projX,
      }),
    );
    const aX2 = await asBusiness(alpha.businessId, () =>
      ai.getOrCreateConversation({
        businessId: alpha.businessId, actorUserId: alpha.userA, mode: "dashboard",
        conversationId: null, firstMessageContent: "دوم", projectId: projX,
      }),
    );
    const aY = await asBusiness(alpha.businessId, () =>
      ai.getOrCreateConversation({
        businessId: alpha.businessId, actorUserId: alpha.userA, mode: "dashboard",
        conversationId: null, firstMessageContent: "پاییزی", projectId: projY,
      }),
    );
    const aNone = await asBusiness(alpha.businessId, () =>
      ai.getOrCreateConversation({
        businessId: alpha.businessId, actorUserId: alpha.userA, mode: "dashboard",
        conversationId: null, firstMessageContent: "بدون پروژه",
      }),
    );
    const bX = await asBusiness(alpha.businessId, () =>
      ai.getOrCreateConversation({
        businessId: alpha.businessId, actorUserId: alpha.userB, mode: "dashboard",
        conversationId: null, firstMessageContent: "مال بی", projectId: projX,
      }),
    );

    const aInX = await asBusiness(alpha.businessId, () =>
      ai.listConversationsByProject({
        businessId: alpha.businessId, actorUserId: alpha.userA, projectId: projX,
      }),
    );
    // Only A's two X threads, newest-active first; not Y, not the project-less
    // one, and not B's X thread.
    expect(aInX.map((c) => c.id)).toEqual([aX2.id, aX1.id]);
    expect(aInX.map((c) => c.id)).not.toContain(aY.id);
    expect(aInX.map((c) => c.id)).not.toContain(aNone.id);
    expect(aInX.map((c) => c.id)).not.toContain(bX.id);
    expect(aInX.every((c) => c.projectId === projX)).toBe(true);

    // B sees only B's own X thread.
    const bInX = await asBusiness(alpha.businessId, () =>
      ai.listConversationsByProject({
        businessId: alpha.businessId, actorUserId: alpha.userB, projectId: projX,
      }),
    );
    expect(bInX.map((c) => c.id)).toEqual([bX.id]);
  });

  it("honours the limit so a busy project never overflows a page", async () => {
    const proj = await seedProject(alpha.businessId, "پرترافیک");
    for (let i = 0; i < 3; i++) {
      await asBusiness(alpha.businessId, () =>
        ai.getOrCreateConversation({
          businessId: alpha.businessId, actorUserId: alpha.userA, mode: "dashboard",
          conversationId: null, firstMessageContent: `t${i}`, projectId: proj,
        }),
      );
    }
    const firstPage = await asBusiness(alpha.businessId, () =>
      ai.listConversationsByProject(
        { businessId: alpha.businessId, actorUserId: alpha.userA, projectId: proj },
        { limit: 2 },
      ),
    );
    expect(firstPage).toHaveLength(2);
  });
});

/**
 * §29 "reopening restores valid metadata".
 *
 * Reopening is a read of one conversation and everything hanging off it. The
 * failure mode worth pinning is not "it 404s" — that is covered above — but a
 * transcript that comes back hollow: the right messages with the wrong mode, or
 * a proposal card that lost the state that decides whether it is still
 * clickable. Both are what the sidebar and the transcript render from, so both
 * are asserted here rather than assumed.
 */
describe("reopening restores the metadata the transcript renders from", () => {
  it("returns the conversation's own mode, so a reopened turn is not re-typed", async () => {
    // The mode is not decoration: it selects the runtime alias and the prompt
    // layers the next turn composes under. Reopening under the wrong one would
    // silently move the conversation onto another model.
    const created = await asBusiness(alpha.businessId, () =>
      ai.getOrCreateConversation({
        businessId: alpha.businessId,
        actorUserId: alpha.userA,
        mode: "dashboard",
        conversationId: null,
        firstMessageContent: "سلام",
      }),
    );
    await asBusiness(alpha.businessId, () =>
      ai.appendMessage({ conversationId: created.id, role: "user", content: "سلام" }),
    );

    const reopened = await asBusiness(alpha.businessId, () =>
      ai.getConversationMessages({
        businessId: alpha.businessId,
        actorUserId: alpha.userA,
        conversationId: created.id,
      }),
    );
    expect(reopened).not.toBeNull();
    expect(reopened!.conversation.mode).toBe("dashboard");
    expect(reopened!.conversation.id).toBe(created.id);
    expect(reopened!.messages).toHaveLength(1);
    expect(reopened!.messages[0].content).toBe("سلام");
  });

  it("keeps a proposal's status on the message, so a reloaded card is still correct", async () => {
    // A proposed mutation that was already applied must reload as applied, not
    // as a fresh clickable proposal — otherwise a reload invites the same write
    // twice, which is exactly what confirm-before-apply exists to prevent.
    const created = await asBusiness(alpha.businessId, () =>
      ai.getOrCreateConversation({
        businessId: alpha.businessId,
        actorUserId: alpha.userA,
        mode: "dashboard",
        conversationId: null,
        firstMessageContent: "قیمت را بالا ببر",
      }),
    );
    // An audit row in the `applied` state is what a write that already happened
    // leaves behind; the message links to it by id.
    const audit = await asBusiness(alpha.businessId, async () => {
      const { rows } = await dbLib.getPool().query<{ id: string }>(
        `INSERT INTO ai_action_audit
           (business_id, actor_user_id, prompt_excerpt, action_type, action_title, action_summary, proposal_payload, status)
         VALUES ($1, $2, 'قیمت را بالا ببر', 'menu.item.priceUpdate', 'تغییر قیمت', 'افزایش قیمت', $3::jsonb, 'applied')
         RETURNING id`,
        [alpha.businessId, alpha.userA, JSON.stringify({ price: 120000 })],
      );
      return rows[0].id;
    });
    await asBusiness(alpha.businessId, () =>
      ai.appendMessage({
        conversationId: created.id,
        role: "assistant",
        content: "پیشنهاد تغییر قیمت",
        proposal: {
          type: "menu.item.priceUpdate",
          title: "تغییر قیمت",
          summary: "افزایش قیمت",
          payload: { menuItemId: "00000000-0000-0000-0000-000000000000", price: 120000 },
        },
        auditId: audit,
      }),
    );

    const reopened = await asBusiness(alpha.businessId, () =>
      ai.getConversationMessages({
        businessId: alpha.businessId,
        actorUserId: alpha.userA,
        conversationId: created.id,
      }),
    );
    const message = reopened!.messages[0];
    expect(message.proposal).not.toBeNull();
    expect(message.proposal!.type).toBe("menu.item.priceUpdate");
    expect(message.auditId).toBe(audit);
    // The status comes back applied, so the reloaded card is locked rather than
    // a fresh invitation to write the same mutation a second time.
    expect(message.proposalStatus).toBe("applied");
  });

  it("reports a foreign conversation as absent rather than as an empty transcript", async () => {
    // A hollow transcript is worse than a 404: it renders as "this conversation
    // is empty" and invites the member to start typing into someone else's.
    const created = await asBusiness(alpha.businessId, () =>
      ai.getOrCreateConversation({
        businessId: alpha.businessId,
        actorUserId: alpha.userA,
        mode: "dashboard",
        conversationId: null,
        firstMessageContent: "سلام",
      }),
    );
    const foreign = await asBusiness(alpha.businessId, () =>
      ai.getConversationMessages({
        businessId: alpha.businessId,
        actorUserId: alpha.userB,
        conversationId: created.id,
      }),
    );
    expect(foreign).toBeNull();
  });
});
