import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #1207 §C — the duplicate review endpoint.
 *
 * The route's own job is small and load-bearing: refuse a partial request,
 * refuse a confirmation without the token the reader was shown, and pass the
 * two decisions to the service with the session's business and actor. What the
 * service then does (archive the proven orphan, record the keep-separate
 * decision) is covered by `duplicate-items-resolution.test.ts` and the DB
 * integration tests.
 */
const mocks = vi.hoisted(() => ({
  loadDuplicateReviewGroups: vi.fn(),
  listDuplicateCandidateSkus: vi.fn(),
  recordDuplicateKeepSeparate: vi.fn(),
  archiveDuplicateOrphanFromReview: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  withTenantScope: (handler: unknown) => handler,
  requirePermission: vi.fn(async () => ({
    session: { businessId: "tenant-a", sub: "user-1" },
    error: null,
  })),
}));

vi.mock("@/lib/industry-guard", () => ({
  requireProductWorkspaceForApi: vi.fn(async () => null),
}));

vi.mock("@/lib/duplicate-items-review-service", () => mocks);

import { GET, POST } from "./route";

const UUID = "8a86d451-f018-4bc9-bcb1-e04bcd96c91c";

function post(body: unknown) {
  return POST(
    new NextRequest("https://app.test/api/products/duplicates", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadDuplicateReviewGroups.mockResolvedValue([]);
  mocks.listDuplicateCandidateSkus.mockResolvedValue(["zza05023"]);
  mocks.recordDuplicateKeepSeparate.mockResolvedValue({ sku: "zza05023", reviewed: true });
  mocks.archiveDuplicateOrphanFromReview.mockResolvedValue({ archived: { orphanItemId: UUID }, blockers: [] });
});

describe("GET", () => {
  it("returns the flagged SKUs for the list's summary read", async () => {
    const response = await GET(new NextRequest("https://app.test/api/products/duplicates?summary=1"));
    expect(await response.json()).toEqual({ skus: ["zza05023"] });
    expect(mocks.loadDuplicateReviewGroups).not.toHaveBeenCalled();
  });

  it("reads one SKU's review when asked", async () => {
    await GET(new NextRequest("https://app.test/api/products/duplicates?sku=ZZA05023"));
    expect(mocks.loadDuplicateReviewGroups).toHaveBeenCalledWith("tenant-a", { sku: "ZZA05023" });
  });
});

describe("POST", () => {
  it("records «نگهداری جداگانه» with the session's actor", async () => {
    const response = await post({
      sku: "zza05023",
      action: "keep_separate",
      confirm: true,
      reviewToken: "token-1",
    });
    expect(response.status).toBe(200);
    expect(mocks.recordDuplicateKeepSeparate).toHaveBeenCalledWith("tenant-a", {
      sku: "zza05023",
      reviewToken: "token-1",
      actorUserId: "user-1",
    });
  });

  it("archives the proven orphan and re-reads the group", async () => {
    const response = await post({
      sku: "zza05023",
      action: "archive_orphan",
      orphanItemId: UUID,
      confirm: true,
      reviewToken: "token-1",
    });
    expect(response.status).toBe(200);
    expect(mocks.archiveDuplicateOrphanFromReview).toHaveBeenCalledWith("tenant-a", {
      sku: "zza05023",
      orphanItemId: UUID,
      reviewToken: "token-1",
      actorUserId: "user-1",
    });
  });

  it("refuses a confirmation without `confirm: true`", async () => {
    const response = await post({ sku: "zza05023", action: "keep_separate", reviewToken: "token-1" });
    expect(response.status).toBe(400);
    expect(mocks.recordDuplicateKeepSeparate).not.toHaveBeenCalled();
  });

  it("refuses a decision without the review token", async () => {
    const response = await post({ sku: "zza05023", action: "keep_separate", confirm: true });
    expect(response.status).toBe(400);
  });

  it("refuses an unknown action and a malformed orphan id", async () => {
    expect((await post({ sku: "zza05023", action: "merge", confirm: true, reviewToken: "t" })).status).toBe(400);
    expect(
      (await post({ sku: "zza05023", action: "archive_orphan", orphanItemId: "1", confirm: true, reviewToken: "t" }))
        .status,
    ).toBe(400);
    expect(mocks.archiveDuplicateOrphanFromReview).not.toHaveBeenCalled();
  });

  it("answers a stale review with 409 instead of acting on it", async () => {
    mocks.recordDuplicateKeepSeparate.mockRejectedValueOnce(new Error("duplicate_review_changed"));
    const response = await post({ sku: "zza05023", action: "keep_separate", confirm: true, reviewToken: "stale" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "duplicate_review_changed" });
  });

  it("reports blockers when the plan refuses the archive", async () => {
    mocks.archiveDuplicateOrphanFromReview.mockResolvedValueOnce({ archived: null, blockers: ["has_references"] });
    const response = await post({
      sku: "zza05023",
      action: "archive_orphan",
      orphanItemId: UUID,
      confirm: true,
      reviewToken: "token-1",
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "duplicate_not_safe_to_archive", blockers: ["has_references"] });
  });

  it("lets an unexpected failure through rather than disguising it as a 409", async () => {
    mocks.recordDuplicateKeepSeparate.mockRejectedValueOnce(new Error("connection terminated"));
    await expect(
      post({ sku: "zza05023", action: "keep_separate", confirm: true, reviewToken: "token-1" }),
    ).rejects.toThrow("connection terminated");
  });
});
