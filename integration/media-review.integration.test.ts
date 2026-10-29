/**
 * §E's client media review against a real database (issue #1128).
 *
 * Three layers of this feature are proved in three different places, and it is
 * worth being clear about which is which:
 *
 *   - `src/lib/media-review.test.ts` pins the *vocabulary* — the two state
 *     machines, the transition table, the derived round state, the token shape —
 *     with no database at all.
 *   - The migration's own guards were proved against live Postgres by a harness of
 *     raw SQL: composite foreign keys, the state↔stamp couplings, the frozen
 *     sent-round, the append-only trail, and the freeze on a live link's
 *     authority.
 *   - **This file** proves the service: that ~1150 lines of hand-written SQL name
 *     real columns, that the joins resolve, that each refusal arrives as the code
 *     a screen can translate, and that the whole flow works end to end. Types
 *     cannot catch a misspelled column, and neither can a trigger harness that
 *     never calls the service.
 *
 * What is deliberately *not* here: byte streaming. That needs an object store, and
 * the point of `authorizeReviewAsset` being separate from `streamReviewAssetBytes`
 * is that every security decision — purpose, round membership, existence — is made
 * before storage is touched. So the authorization is tested to the last gate, and
 * only the fetch is left out.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let provisioning: typeof import("../src/lib/business-provisioning");
let review: typeof import("../src/lib/media-review-service");

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
  databaseName = `media_review_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  // Imported only after the environment points at the throwaway database, so every
  // module below binds its pool to it rather than to the runner's default.
  process.env.DATABASE_URL = urlFor(databaseName);
  dbLib = await import("../src/lib/db");
  provisioning = await import("../src/lib/business-provisioning");
  review = await import("../src/lib/media-review-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 180_000);

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

/* ------------------------------------------------------------------ fixtures */

let seq = 0;

/** Structurally identical to the service's ReviewActor. */
type Actor = { userId: string; fullName: string };

type Tenant = {
  businessId: string;
  locationId: string;
  ownerUserId: string;
  actor: Actor;
};

/**
 * A real tenant, provisioned through the product's own path.
 *
 * §E is deliberately not industry-gated — the Media Library is a platform feature
 * and "send files to a client, get an approval" is not an agency idea — so this
 * takes the industry as a parameter and one test below runs the same flow on a
 * trade that is not an agency at all.
 */
async function provisionTenant(industry: "advertising_agency" | "jewelry"): Promise<Tenant> {
  seq += 1;
  const result = await provisioning.provisionBusiness({
    businessName: `کسب‌وکار آزمایشی ${seq}`,
    ownerName: "مالک",
    email: `review-owner-${seq}@example.test`,
    password: "correct-horse",
    subdomain: `review${seq}`,
    industry,
    seedChartOfAccounts: true,
  });
  return {
    businessId: result.businessId,
    locationId: result.locationId,
    ownerUserId: result.userId,
    actor: { userId: result.userId, fullName: "مالک" },
  };
}

/** 64 hex characters, the shape `media_assets.sha256` and a token hash both use. */
function hex64(): string {
  return (randomUUID() + randomUUID()).replaceAll("-", "");
}

async function seedAsset(
  businessId: string,
  fileName: string,
  kind: "image" | "video" | "document" = "image",
): Promise<{ id: string; storageKey: string }> {
  const storageKey = `media/${businessId}/seed/${fileName}`;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO media_assets (business_id, kind, file_name, mime_type, byte_size, storage_key, sha256)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [businessId, kind, fileName, "image/png", 4096, storageKey, hex64()],
  );
  return { id: rows[0].id, storageKey };
}

async function seedParty(businessId: string, name: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO parties (business_id, name) VALUES ($1, $2) RETURNING id`,
    [businessId, name],
  );
  return rows[0].id;
}

async function seedProject(businessId: string, ownerUserId: string, name: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO ai_projects (business_id, name, created_by, owner_user_id)
     VALUES ($1, $2, $3::text, $3::uuid) RETURNING id`,
    [businessId, name, ownerUserId],
  );
  return rows[0].id;
}

async function seedCampaign(businessId: string, name: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO growth_campaigns (business_id, name) VALUES ($1, $2) RETURNING id`,
    [businessId, name],
  );
  return rows[0].id;
}

/** Assert a service call was refused, and refused *as the code a screen expects*. */
async function expectRefusal(promise: Promise<unknown>, code: string): Promise<void> {
  let caught: unknown = null;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught, `expected a refusal, got success (wanted ${code})`).toBeInstanceOf(
    review.MediaReviewError,
  );
  expect((caught as { code: string }).code).toBe(code);
}

/**
 * Move a link's clock forward.
 *
 * This has to disable the row trigger to do it, and that is the point rather than
 * an inconvenience: migration 0265 freezes `expires_at` on a live link, because
 * extending one is how a "short-lived" link quietly becomes permanent. Time cannot
 * be fast-forwarded any other way, so the test says so explicitly, disables every
 * user trigger on the table, moves the stamp, and puts them back.
 */
async function expireLink(linkId: string): Promise<void> {
  const { rows } = await db.query<{ tgname: string }>(
    `SELECT t.tgname
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
      WHERE c.relname = 'media_review_links' AND NOT t.tgisinternal`,
  );
  for (const row of rows) {
    await db.query(`ALTER TABLE media_review_links DISABLE TRIGGER "${row.tgname}"`);
  }
  try {
    await db.query(`UPDATE media_review_links SET expires_at = now() - interval '1 minute' WHERE id = $1`, [
      linkId,
    ]);
  } finally {
    for (const row of rows) {
      await db.query(`ALTER TABLE media_review_links ENABLE TRIGGER "${row.tgname}"`);
    }
  }
}

/* --------------------------------------------------------------------- tests */

describe("media client review against a real database (issue #1128 §E)", () => {
  it("runs a round from draft to approved, and the client is never a member", async () => {
    const tenant = await provisionTenant("advertising_agency");
    const first = await seedAsset(tenant.businessId, "poster-v1.png");
    const second = await seedAsset(tenant.businessId, "poster-v2.png");
    const client = await seedParty(tenant.businessId, "کارفرمای نمونه");
    const project = await seedProject(tenant.businessId, tenant.ownerUserId, "کمپین نوروز");

    const draft = await review.createReviewRound(tenant.businessId, tenant.actor, {
      title: "پوسترهای نوروز",
      projectId: project,
      clientPartyId: client,
      assetIds: [first.id, second.id],
      formats: { [first.id]: "poster" },
    });

    expect(draft.status).toBe("draft");
    expect(draft.itemCount).toBe(2);
    expect(draft.decidedCount).toBe(0);
    expect(draft.clientName).toBe("کارفرمای نمونه");
    expect(draft.projectName).toBe("کمپین نوروز");
    // The action lists come from the pure module, so a screen cannot offer a move
    // the state machine would refuse.
    expect([...draft.actions]).toEqual(["send"]);
    expect([...draft.clientActions]).toEqual([]);
    expect(draft.items.map((i) => i.status)).toEqual(["pending", "pending"]);
    // A member's file URL is the library's own route, which authorizes from their
    // session — not the token route, and never a storage key.
    expect(draft.items[0].fileUrl).toBe(`/api/media/${first.id}/file`);

    const sent = await review.transitionReviewRound(tenant.businessId, tenant.actor, draft.id, "send");
    expect(sent.status).toBe("sent");
    expect(sent.sentAt).not.toBeNull();
    // Two doors over one act table: the client decides, and the agency may only
    // pull the round back. A member is never offered "approve" on work their own
    // client is still deciding — the API would refuse it, and so must the screen.
    expect([...sent.clientActions]).toEqual(["approve", "request_changes", "reject"]);
    expect([...sent.actions]).toEqual(["withdraw"]);

    const { link, token } = await review.createReviewLink(tenant.businessId, tenant.actor, draft.id, {
      purpose: "review",
    });
    expect(link.purpose).toBe("review");
    expect(token.startsWith(link.tokenPrefix)).toBe(true);

    // The client's own URL, which the library route would answer 403 to.
    const view = await review.getClientReviewView(token);
    expect(view.round.status).toBe("sent");
    expect(view.items[0].fileUrl).toBe(review.clientFileUrl(token, first.id));
    expect(view.items[0].fileUrl).toContain(`/api/media/review/${token}/assets/${first.id}/file`);

    const afterFirst = await review.decideReviewItem(token, first.id, "approved");
    expect(afterFirst.round.decidedCount).toBe(1);
    // Approving the round with an item still pending is refused — see its own test.
    await expectRefusal(
      review.decideReviewRound(token, { action: "approve", clientName: "نازنین" }),
      "items_pending",
    );

    const afterSecond = await review.decideReviewItem(token, second.id, "approved");
    expect(afterSecond.round.decidedCount).toBe(2);

    const approved = await review.decideReviewRound(token, {
      action: "approve",
      clientName: "نازنین رضایی",
    });
    expect(approved.round.status).toBe("approved");
    // The client is an actor with no user row: the name is free text on the round,
    // and nothing here created a membership.
    expect(approved.round.decidedByName).toBe("نازنین رضایی");
    // The view's own `actions` is the client's door; the nested round carries both
    // doors. On an approved round every door is closed — a client who changes their
    // mind does not un-approve, the agency sends a new round instead.
    expect([...approved.actions]).toEqual([]);
    expect([...approved.round.actions]).toEqual([]);
    expect([...approved.round.clientActions]).toEqual([]);

    // The client is an actor with no identity in the tenant. Membership here means
    // a `users` row, and project membership means a `workspace_members` row — the
    // review flow creates neither, which is exactly what §B means by "without a new
    // staff identity system". Nothing below counts on the owner having been added
    // to the project; it only insists that nobody else was.
    const users = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM users WHERE business_id = $1`,
      [tenant.businessId],
    );
    expect(users.rows[0].n, "the client must not have been given a user row").toBe(1);

    const strangers = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM workspace_members wm
         JOIN ai_projects p ON p.id = wm.project_id
        WHERE p.business_id = $1 AND wm.user_id <> $2`,
      [tenant.businessId, tenant.ownerUserId],
    );
    expect(strangers.rows[0].n, "no project membership was created for the client").toBe(0);
  });

  it("is not gated on the advertising agency industry", async () => {
    // §E is a platform feature. A jeweller photographing pieces for a client to
    // approve has exactly the same need, and a gate here would be an agency idea
    // imposed on every other trade. The format vocabulary is nullable metadata,
    // not a door.
    const tenant = await provisionTenant("jewelry");
    const asset = await seedAsset(tenant.businessId, "ring-shot.png");

    const draft = await review.createReviewRound(tenant.businessId, tenant.actor, {
      title: "عکس انگشتر",
      assetIds: [asset.id],
    });
    const sent = await review.transitionReviewRound(tenant.businessId, tenant.actor, draft.id, "send");
    const { token } = await review.createReviewLink(tenant.businessId, tenant.actor, sent.id, {});
    await review.decideReviewItem(token, asset.id, "approved");
    const approved = await review.decideReviewRound(token, { action: "approve" });

    expect(approved.round.status).toBe("approved");
  });

  it("stores only the hash of a minted token, and shows the plaintext once", async () => {
    const tenant = await provisionTenant("advertising_agency");
    const asset = await seedAsset(tenant.businessId, "brand-board.png");
    const draft = await review.createReviewRound(tenant.businessId, tenant.actor, {
      title: "تخته برند",
      assetIds: [asset.id],
    });
    await review.transitionReviewRound(tenant.businessId, tenant.actor, draft.id, "send");

    const { link, token } = await review.createReviewLink(tenant.businessId, tenant.actor, draft.id, {});

    const { rows } = await db.query<Record<string, unknown>>(
      `SELECT * FROM media_review_links WHERE id = $1`,
      [link.id],
    );
    const row = rows[0];
    expect(row.token_hash).toBe(review.hashMediaReviewToken(token));
    expect(String(row.token_hash)).toMatch(/^[0-9a-f]{64}$/);
    // The whole plaintext appears nowhere in the row — only its hash and a
    // non-secret display prefix that lets an agency tell two links apart.
    expect(JSON.stringify(row)).not.toContain(token);
    expect(String(row.token_prefix).length).toBeGreaterThan(0);
    expect(token.startsWith(String(row.token_prefix))).toBe(true);

    // And the hash is not a lookup oracle for a wrong token.
    const wrong = await review.resolveReviewToken(`${token.slice(0, -4)}AAAA`);
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.code).toBe("invalid_token");

    const right = await review.resolveReviewToken(token);
    expect(right.ok).toBe(true);
    if (right.ok) {
      expect(right.grant.businessId).toBe(tenant.businessId);
      expect(right.grant.roundId).toBe(draft.id);
      expect(right.grant.purpose).toBe("review");
    }
  });

  it("allows one live link per purpose, and re-issues after revocation", async () => {
    const tenant = await provisionTenant("advertising_agency");
    const asset = await seedAsset(tenant.businessId, "campaign-a.png");
    const draft = await review.createReviewRound(tenant.businessId, tenant.actor, {
      title: "کمپین الف",
      assetIds: [asset.id],
    });
    await review.transitionReviewRound(tenant.businessId, tenant.actor, draft.id, "send");

    const first = await review.createReviewLink(tenant.businessId, tenant.actor, draft.id, {
      purpose: "review",
    });
    // A second live link for the same purpose is refused rather than accumulated: a
    // drawer full of valid tokens nobody can enumerate is a drawer full of leaks.
    await expectRefusal(
      review.createReviewLink(tenant.businessId, tenant.actor, draft.id, { purpose: "review" }),
      "link_exists",
    );
    // A different purpose is a different grant, so it is allowed alongside.
    const download = await review.createReviewLink(tenant.businessId, tenant.actor, draft.id, {
      purpose: "download",
    });
    expect(download.link.purpose).toBe("download");

    await review.revokeReviewLink(tenant.businessId, tenant.actor, first.link.id);
    // Revocation is the supported way to rotate: re-issuing now succeeds, and the
    // revoked row stays as history.
    const reissued = await review.createReviewLink(tenant.businessId, tenant.actor, draft.id, {
      purpose: "review",
    });
    expect(reissued.token).not.toBe(first.token);

    const { rows } = await db.query<{ live: number; total: number }>(
      `SELECT count(*) FILTER (WHERE revoked_at IS NULL AND expires_at > now())::int AS live,
              count(*)::int AS total
         FROM media_review_links WHERE round_id = $1`,
      [draft.id],
    );
    expect(rows[0].live).toBe(2); // review (reissued) + download
    expect(rows[0].total).toBe(3); // the revoked one is still there
  });

  it("makes revocation take effect on the next request", async () => {
    const tenant = await provisionTenant("advertising_agency");
    const asset = await seedAsset(tenant.businessId, "story-1.png");
    const draft = await review.createReviewRound(tenant.businessId, tenant.actor, {
      title: "استوری",
      assetIds: [asset.id],
    });
    await review.transitionReviewRound(tenant.businessId, tenant.actor, draft.id, "send");
    const { link, token } = await review.createReviewLink(tenant.businessId, tenant.actor, draft.id, {});

    const before = await review.getClientReviewView(token);
    expect(before.round.id).toBe(draft.id);

    const revoked = await review.revokeReviewLink(tenant.businessId, tenant.actor, link.id);
    expect(revoked.revokedAt).not.toBeNull();

    // This is the whole argument for streaming bytes through the app instead of
    // handing out a presigned URL: with a presigned URL, "revoke" would mean "wait
    // up to thirty days". Here the next request is refused.
    await expectRefusal(review.getClientReviewView(token), "token_revoked");

    // Revoking twice is idempotent — a double-submitted screen is told it worked.
    const again = await review.revokeReviewLink(tenant.businessId, tenant.actor, link.id);
    expect(again.revokedAt).not.toBeNull();
  });

  it("refuses an expired link as expired, not as invalid", async () => {
    const tenant = await provisionTenant("advertising_agency");
    const asset = await seedAsset(tenant.businessId, "billboard.png");
    const draft = await review.createReviewRound(tenant.businessId, tenant.actor, {
      title: "بیلبورد",
      assetIds: [asset.id],
    });
    await review.transitionReviewRound(tenant.businessId, tenant.actor, draft.id, "send");
    const { link, token } = await review.createReviewLink(tenant.businessId, tenant.actor, draft.id, {});
    await expireLink(link.id);

    // A distinct code, because it tells the client something different from
    // "revoked" and from "that is not a token": ask the agency for a new link.
    await expectRefusal(review.getClientReviewView(token), "token_expired");
    const resolved = await review.resolveReviewToken(token);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.code).toBe("token_expired");
  });

  it("gates bytes on the download purpose and on membership of that round", async () => {
    const tenant = await provisionTenant("advertising_agency");
    const inRound = await seedAsset(tenant.businessId, "final-art.png");
    const notInRound = await seedAsset(tenant.businessId, "unrelated.png");
    const draft = await review.createReviewRound(tenant.businessId, tenant.actor, {
      title: "آرت‌ورک نهایی",
      assetIds: [inRound.id],
    });
    await review.transitionReviewRound(tenant.businessId, tenant.actor, draft.id, "send");

    // A review link may be *looked at* — refusing it every fetch would make the
    // default link useless, because a client who cannot see the artwork cannot
    // approve it. What it may not do is be asked for the file itself.
    const reviewLink = await review.createReviewLink(tenant.businessId, tenant.actor, draft.id, {
      purpose: "review",
    });
    const viewable = await review.authorizeReviewAsset(reviewLink.token, inRound.id);
    expect(viewable.ok, "a review link must still render the artwork").toBe(true);

    const refusedPurpose = await review.authorizeReviewAsset(reviewLink.token, inRound.id, {
      wantsDownload: true,
    });
    expect(refusedPurpose.ok).toBe(false);
    if (!refusedPurpose.ok) expect(refusedPurpose.code).toBe("download_not_permitted");

    const downloadLink = await review.createReviewLink(tenant.businessId, tenant.actor, draft.id, {
      purpose: "download",
    });
    const allowed = await review.authorizeReviewAsset(downloadLink.token, inRound.id);
    expect(allowed.ok).toBe(true);
    if (allowed.ok) {
      expect(allowed.asset.fileName).toBe("final-art.png");
      expect(allowed.asset.sha256).toMatch(/^[0-9a-f]{64}$/);
      // The storage key never leaves the service — a key that escapes is a key that
      // can end up in a log, a payload, or a URL somebody forwards.
      expect(JSON.stringify(allowed)).not.toContain(inRound.storageKey);
      expect("storageKey" in allowed.asset).toBe(false);
    }

    // The token grants one round, not the library. Guessing another asset's UUID
    // gets nothing, even a valid asset of the same tenant.
    const outside = await review.authorizeReviewAsset(downloadLink.token, notInRound.id);
    expect(outside.ok).toBe(false);
    if (!outside.ok) expect(outside.code).toBe("asset_not_found");

    const garbage = await review.authorizeReviewAsset(downloadLink.token, "not-a-uuid");
    expect(garbage.ok).toBe(false);
    if (!garbage.ok) expect(garbage.code).toBe("asset_not_found");
  });

  it("shows the client their round and nothing else", async () => {
    const tenant = await provisionTenant("advertising_agency");
    const mine = await seedAsset(tenant.businessId, "client-proof.png");
    const other = await seedAsset(tenant.businessId, "internal-only.png");
    const draft = await review.createReviewRound(tenant.businessId, tenant.actor, {
      title: "نمونه کار",
      assetIds: [mine.id],
    });
    // A second round the client has no link to.
    await review.createReviewRound(tenant.businessId, tenant.actor, {
      title: "دور داخلی",
      assetIds: [other.id],
    });
    await review.transitionReviewRound(tenant.businessId, tenant.actor, draft.id, "send");
    const { link, token } = await review.createReviewLink(tenant.businessId, tenant.actor, draft.id, {
      purpose: "download",
    });

    const view = await review.getClientReviewView(token);
    expect(view.round.id).toBe(draft.id);
    expect(view.items.map((i) => i.assetId)).toEqual([mine.id]);

    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(other.id);
    expect(serialized).not.toContain(mine.storageKey);
    // The token itself does appear, inside each item's fileUrl — that is how the
    // client's browser is told where to fetch bytes from, and the client already
    // holds it, since it is in the URL they requested. What must not appear is the
    // storage key, the agency's links, or the trail.
    // No links and no audit trail: those are the agency's, and a client who could
    // read the events would see every internal note ever filed on the round.
    expect("links" in view).toBe(false);
    expect("events" in view).toBe(false);
    expect(link.tokenPrefix.length).toBeGreaterThan(0);

    // Viewing counts as use, which is how an agency answers "did they open it?".
    const { rows } = await db.query<{ use_count: number; last_used_at: string | null }>(
      `SELECT use_count, last_used_at FROM media_review_links WHERE id = $1`,
      [link.id],
    );
    expect(rows[0].use_count).toBeGreaterThan(0);
    expect(rows[0].last_used_at).not.toBeNull();
  });

  it("freezes a round once the client is reading it", async () => {
    const tenant = await provisionTenant("advertising_agency");
    const asset = await seedAsset(tenant.businessId, "layout.png");
    const extra = await seedAsset(tenant.businessId, "layout-alt.png");
    const draft = await review.createReviewRound(tenant.businessId, tenant.actor, {
      title: "لی‌اوت",
      assetIds: [asset.id],
    });
    await review.transitionReviewRound(tenant.businessId, tenant.actor, draft.id, "send");

    // A client must not find the batch changed underneath them: approving something
    // they were never shown is the failure this prevents.
    await expectRefusal(
      review.updateReviewRound(tenant.businessId, tenant.actor, draft.id, { title: "لی‌اوت جدید" }),
      "round_frozen",
    );
    // Items get their own code: "this round is not taking assets right now" is a
    // more useful thing to tell a screen than "this round is frozen", because a
    // round sent back for changes IS frozen in title and scope yet happily takes
    // assets again. One code for both would make that distinction unsayable.
    await expectRefusal(
      review.addReviewRoundItems(tenant.businessId, tenant.actor, draft.id, [extra.id]),
      "round_not_open_for_items",
    );
    await expectRefusal(
      review.removeReviewRoundItem(tenant.businessId, tenant.actor, draft.id, asset.id),
      "round_not_open_for_items",
    );
    await expectRefusal(review.deleteReviewRound(tenant.businessId, tenant.actor, draft.id), "round_frozen");

    // A draft cannot even be *given* a link: createReviewLink requires a round in
    // `sent`, so the refusal happens at mint and there is no token with which to
    // reach the round at all. That is a stronger guarantee than the one this test
    // started out asserting — refusing the view later would still leave a mintable
    // link to a batch nobody has sent.
    const second = await review.createReviewRound(tenant.businessId, tenant.actor, {
      title: "پیش‌نویس",
      assetIds: [extra.id],
    });
    await expectRefusal(
      review.createReviewLink(tenant.businessId, tenant.actor, second.id, {}),
      "round_not_sent",
    );
  });

  it("needs every item decided, and every item approved, before a round is approved", async () => {
    const tenant = await provisionTenant("advertising_agency");
    const a = await seedAsset(tenant.businessId, "ad-a.png");
    const b = await seedAsset(tenant.businessId, "ad-b.png");
    const draft = await review.createReviewRound(tenant.businessId, tenant.actor, {
      title: "دو بنر",
      assetIds: [a.id, b.id],
    });
    await review.transitionReviewRound(tenant.businessId, tenant.actor, draft.id, "send");
    const { token } = await review.createReviewLink(tenant.businessId, tenant.actor, draft.id, {});

    await expectRefusal(
      review.decideReviewRound(token, { action: "approve" }),
      "items_pending",
    );
    await review.decideReviewItem(token, a.id, "approved");
    await expectRefusal(
      review.decideReviewRound(token, { action: "approve" }),
      "items_pending",
    );

    // One item sent back is not an approvable round, and the refusal says so with a
    // different code: "you have not finished" and "they said no" are different
    // conversations for the agency to have.
    await review.decideReviewItem(token, b.id, "changes_requested", "رنگ زمینه را تیره‌تر کنید");
    await expectRefusal(
      review.decideReviewRound(token, { action: "approve" }),
      "items_not_approved",
    );

    // Asking for changes on the whole round is allowed regardless — the client does
    // not have to approve anything to say what they want.
    const changed = await review.decideReviewRound(token, {
      action: "request_changes",
      clientName: "کارفرما",
      note: "هر دو بنر نیاز به بازبینی دارد",
    });
    expect(changed.round.status).toBe("changes_requested");
  });

  it("requires a note when the answer is not yes", async () => {
    const tenant = await provisionTenant("advertising_agency");
    const asset = await seedAsset(tenant.businessId, "banner.png");
    const draft = await review.createReviewRound(tenant.businessId, tenant.actor, {
      title: "بنر",
      assetIds: [asset.id],
    });
    await review.transitionReviewRound(tenant.businessId, tenant.actor, draft.id, "send");
    const { token } = await review.createReviewLink(tenant.businessId, tenant.actor, draft.id, {});

    // "Changes requested" with no reason is not actionable — the agency would have
    // to guess. Approval needs no note because there is nothing to act on.
    await expectRefusal(review.decideReviewItem(token, asset.id, "changes_requested"), "note_required");
    await expectRefusal(review.decideReviewItem(token, asset.id, "rejected", "   "), "note_required");
    await expectRefusal(
      review.decideReviewRound(token, { action: "request_changes" }),
      "note_required",
    );

    const noted = await review.decideReviewItem(token, asset.id, "changes_requested", "فونت عوض شود");
    expect(noted.items[0].status).toBe("changes_requested");
    expect(noted.items[0].note).toBe("فونت عوض شود");
  });

  it("lets a rejected round take new assets and be re-sent without losing its first sent_at", async () => {
    const tenant = await provisionTenant("advertising_agency");
    const original = await seedAsset(tenant.businessId, "v1.png");
    const revision = await seedAsset(tenant.businessId, "v2.png");
    const draft = await review.createReviewRound(tenant.businessId, tenant.actor, {
      title: "نسخه‌ها",
      assetIds: [original.id],
    });
    const sent = await review.transitionReviewRound(tenant.businessId, tenant.actor, draft.id, "send");
    const firstSentAt = sent.sentAt;
    expect(firstSentAt).not.toBeNull();

    const { token } = await review.createReviewLink(tenant.businessId, tenant.actor, draft.id, {});
    await review.decideReviewItem(token, original.id, "rejected", "این نسخه را نمی‌خواهیم");
    const changed = await review.decideReviewRound(token, {
      action: "request_changes",
      note: "نسخه دوم را بفرستید",
    });
    expect(changed.round.status).toBe("changes_requested");

    // Sent back is open for items again — that is the whole point of the state.
    const withRevision = await review.addReviewRoundItems(tenant.businessId, tenant.actor, draft.id, [
      revision.id,
    ]);
    expect(withRevision.itemCount).toBe(2);

    const resent = await review.transitionReviewRound(tenant.businessId, tenant.actor, draft.id, "send");
    expect(resent.status).toBe("sent");
    // `sent_at` is set once and never overwritten: when the client first saw the
    // work is a fact about the engagement, and a re-send must not erase it.
    expect(resent.sentAt).toBe(firstSentAt);

    // The agency's own move set is the same after a send-back as after a draft.
    expect([...resent.actions]).toEqual(["withdraw"]);
  });

  it("refuses a round bigger than it can carry", async () => {
    const tenant = await provisionTenant("advertising_agency");
    const ids: string[] = [];
    for (let i = 0; i < review.MAX_REVIEW_ROUND_ITEMS + 1; i += 1) {
      ids.push((await seedAsset(tenant.businessId, `bulk-${i}.png`)).id);
    }
    await expectRefusal(
      review.createReviewRound(tenant.businessId, tenant.actor, { title: "خیلی بزرگ", assetIds: ids }),
      "too_many_items",
    );

    // Exactly at the cap is fine — the limit is about a usable batch, not a
    // punishment for being one short of it.
    const atCap = await review.createReviewRound(tenant.businessId, tenant.actor, {
      title: "در حد مجاز",
      assetIds: ids.slice(0, review.MAX_REVIEW_ROUND_ITEMS),
    });
    expect(atCap.itemCount).toBe(review.MAX_REVIEW_ROUND_ITEMS);

    // And a round cannot be grown past the cap afterwards either.
    await expectRefusal(
      review.addReviewRoundItems(tenant.businessId, tenant.actor, atCap.id, [
        ids[review.MAX_REVIEW_ROUND_ITEMS],
      ]),
      "too_many_items",
    );
  });

  it("deletes a draft, cascades cleanly, and still leaves an audit row", async () => {
    const tenant = await provisionTenant("advertising_agency");
    const asset = await seedAsset(tenant.businessId, "scratch.png");
    const draft = await review.createReviewRound(tenant.businessId, tenant.actor, {
      title: "پیش‌نویس حذفی",
      assetIds: [asset.id],
    });

    // No link is minted here, and none could be: minting requires a round in
    // `sent`, and no transition leads back to `draft` — so a deletable round can
    // never have carried a link. The link cascade is therefore a database-level
    // guarantee (ON DELETE CASCADE, proved against live Postgres by the migration
    // harness) which the service has no path to exercise. Asserting it here would
    // mean sending the round first, which is exactly what makes it undeletable.
    await review.deleteReviewRound(tenant.businessId, tenant.actor, draft.id);

    const orphans = await db.query<{ n: number }>(
      `SELECT (SELECT count(*)::int FROM media_review_rounds WHERE id = $1)
            + (SELECT count(*)::int FROM media_review_round_items WHERE round_id = $1)
            + (SELECT count(*)::int FROM media_review_links WHERE round_id = $1)
            + (SELECT count(*)::int FROM media_review_events WHERE round_id = $1) AS n`,
      [draft.id],
    );
    expect(orphans.rows[0].n).toBe(0);

    // The round's own events cascade with it, so the deletion is recorded where it
    // survives: `audit_log`. An append-only trail with a draft exception would be a
    // hole, not a kindness.
    const audit = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log
        WHERE business_id = $1 AND entity_id = $2::text`,
      [tenant.businessId, draft.id],
    );
    expect(audit.rows[0].n).toBeGreaterThan(0);
  });

  it("keeps one tenant's rounds out of another's reach", async () => {
    const mine = await provisionTenant("advertising_agency");
    const theirs = await provisionTenant("jewelry");
    const myAsset = await seedAsset(mine.businessId, "mine.png");
    const theirAsset = await seedAsset(theirs.businessId, "theirs.png");

    const round = await review.createReviewRound(mine.businessId, mine.actor, {
      title: "دور من",
      assetIds: [myAsset.id],
    });

    // Reading another tenant's round by id is simply not found — no leak of whether
    // it exists.
    expect(await review.getReviewRound(theirs.businessId, round.id)).toBeNull();
    expect(await review.listReviewRounds(theirs.businessId)).toHaveLength(0);

    // And a round cannot be built over another tenant's asset. The trigger refuses
    // it, which is a stronger guarantee than anything the service could assert: it
    // holds for a hand-written query too.
    await expect(
      review.createReviewRound(mine.businessId, mine.actor, {
        title: "تلاش ناموفق",
        assetIds: [theirAsset.id],
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(await review.listReviewRounds(mine.businessId)).toHaveLength(1);

    // A token minted by one tenant resolves to that tenant only.
    await review.transitionReviewRound(mine.businessId, mine.actor, round.id, "send");
    const { token } = await review.createReviewLink(mine.businessId, mine.actor, round.id, {});
    const resolved = await review.resolveReviewToken(token);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.grant.businessId).toBe(mine.businessId);
  });

  it("lists rounds newest-first with progress, live-link counts and scope filters", async () => {
    const tenant = await provisionTenant("advertising_agency");
    const client = await seedParty(tenant.businessId, "کارفرمای لیست");
    const otherClient = await seedParty(tenant.businessId, "کارفرمای دیگر");
    const campaign = await seedCampaign(tenant.businessId, "کمپین لیست");
    const project = await seedProject(tenant.businessId, tenant.ownerUserId, "پروژه لیست");

    const older = await review.createReviewRound(tenant.businessId, tenant.actor, {
      title: "دور قدیمی‌تر",
      clientPartyId: otherClient,
      assetIds: [(await seedAsset(tenant.businessId, "old.png")).id],
    });
    const newer = await review.createReviewRound(tenant.businessId, tenant.actor, {
      title: "دور جدیدتر",
      clientPartyId: client,
      campaignId: campaign,
      projectId: project,
      assetIds: [(await seedAsset(tenant.businessId, "new.png")).id],
    });

    const all = await review.listReviewRounds(tenant.businessId);
    expect(all.map((r) => r.title)).toEqual(["دور جدیدتر", "دور قدیمی‌تر"]);
    expect(all.every((r) => r.liveLinkCount === 0)).toBe(true);
    expect(all[0].campaignName).toBe("کمپین لیست");
    expect(all[0].clientName).toBe("کارفرمای لیست");
    expect(await review.listReviewRounds(tenant.businessId, { status: "draft" })).toHaveLength(2);
    expect(await review.listReviewRounds(tenant.businessId, { status: "sent" })).toHaveLength(0);

    // A link may only be minted on a sent round, so both move before the counts
    // below mean anything — and the status filter moves with them.
    await review.transitionReviewRound(tenant.businessId, tenant.actor, newer.id, "send");
    await review.transitionReviewRound(tenant.businessId, tenant.actor, older.id, "send");
    expect(await review.listReviewRounds(tenant.businessId, { status: "draft" })).toHaveLength(0);
    expect(await review.listReviewRounds(tenant.businessId, { status: "sent" })).toHaveLength(2);
    // "open" is anything a client could still act on or an agency could still amend.
    expect(await review.listReviewRounds(tenant.businessId, { status: "open" })).toHaveLength(2);

    // Mint one live link and revoke another, so the count means something: a round
    // with a live link is a round somebody outside the tenant can open right now.
    const live = await review.createReviewLink(tenant.businessId, tenant.actor, newer.id, {});
    const doomed = await review.createReviewLink(tenant.businessId, tenant.actor, older.id, {});
    await review.revokeReviewLink(tenant.businessId, tenant.actor, doomed.link.id);

    const after = await review.listReviewRounds(tenant.businessId);
    expect(after.find((r) => r.id === newer.id)?.liveLinkCount).toBe(1);
    expect(after.find((r) => r.id === older.id)?.liveLinkCount).toBe(0);
    expect(live.link.ttlDays).toBeGreaterThan(0);

    expect(await review.listReviewRounds(tenant.businessId, { clientPartyId: client })).toHaveLength(1);
    expect(await review.listReviewRounds(tenant.businessId, { campaignId: campaign })).toHaveLength(1);
    expect(await review.listReviewRounds(tenant.businessId, { projectId: project })).toHaveLength(1);
    expect(await review.listReviewRounds(tenant.businessId, { limit: 1 })).toHaveLength(1);
  });

  it("records the trail as the round moves, and never rewrites it", async () => {
    const tenant = await provisionTenant("advertising_agency");
    const asset = await seedAsset(tenant.businessId, "trailed.png");
    const draft = await review.createReviewRound(tenant.businessId, tenant.actor, {
      title: "دور با رد پا",
      assetIds: [asset.id],
    });
    await review.transitionReviewRound(tenant.businessId, tenant.actor, draft.id, "send");
    const { token } = await review.createReviewLink(tenant.businessId, tenant.actor, draft.id, {});
    await review.decideReviewItem(token, asset.id, "approved");
    await review.decideReviewRound(token, { action: "approve", clientName: "کارفرما" });

    const detail = await review.getReviewRound(tenant.businessId, draft.id);
    expect(detail).not.toBeNull();
    if (!detail) return;

    // Both halves of the conversation are on one trail: what the agency did, and
    // what the client did, distinguished by actor kind rather than by a user id the
    // client does not have.
    const kinds = detail.events.map((e) => e.actorKind);
    expect(kinds).toContain("member");
    expect(kinds).toContain("client");
    const actions = detail.events.map((e) => e.action);
    expect(actions.length).toBeGreaterThan(0);

    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM media_review_events WHERE round_id = $1`,
      [draft.id],
    );
    expect(rows[0].n).toBe(detail.events.length);

    // The trail is append-only, including for a round that has finished: the
    // database refuses an edit or a delete, so the service cannot rewrite history
    // even if a future caller asks it to.
    await expect(
      db.query(`UPDATE media_review_events SET note = 'بازنویسی' WHERE round_id = $1`, [draft.id]),
    ).rejects.toBeInstanceOf(Error);
    await expect(
      db.query(`DELETE FROM media_review_events WHERE round_id = $1`, [draft.id]),
    ).rejects.toBeInstanceOf(Error);
  });

  it("withdraws a round and revokes its live links in the same act", async () => {
    const tenant = await provisionTenant("advertising_agency");
    const asset = await seedAsset(tenant.businessId, "withdraw-me.png");
    const draft = await review.createReviewRound(tenant.businessId, tenant.actor, {
      title: "دور بازپس‌گرفته",
      assetIds: [asset.id],
    });
    await review.transitionReviewRound(tenant.businessId, tenant.actor, draft.id, "send");
    const { token } = await review.createReviewLink(tenant.businessId, tenant.actor, draft.id, {});

    const withdrawn = await review.transitionReviewRound(
      tenant.businessId,
      tenant.actor,
      draft.id,
      "withdraw",
    );
    expect(withdrawn.status).toBe("withdrawn");

    // A withdrawn round whose link still worked would be a round the agency
    // believes it has taken back and has not.
    await expectRefusal(review.getClientReviewView(token), "token_revoked");

    // Withdrawn is not terminal: the agency can send again.
    const resent = await review.transitionReviewRound(
      tenant.businessId,
      tenant.actor,
      draft.id,
      "send",
    );
    expect(resent.status).toBe("sent");

    // The agency's decisions are not the client's: `send` and `withdraw` are refused
    // to a token holder, who may only approve, ask for changes, or reject.
    const { token: fresh } = await review.createReviewLink(
      tenant.businessId,
      tenant.actor,
      draft.id,
      {},
    );
    await expectRefusal(
      review.decideReviewRound(fresh, { action: "withdraw" }),
      "invalid_action",
    );
    await expectRefusal(
      review.decideReviewRound(fresh, { action: "send" }),
      "invalid_action",
    );
  });
});
