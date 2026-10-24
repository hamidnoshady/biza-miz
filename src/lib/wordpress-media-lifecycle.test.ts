import { beforeEach, describe, expect, it, vi } from "vitest";
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("./db", () => ({ query }));
import { confirmWordPressMediaSync, failWordPressMediaSync, reconcileWordPressMediaLifecycle, recordWordPressMediaPush } from "./media-service";

beforeEach(() => { query.mockReset(); query.mockResolvedValue({ rows: [] }); });

describe("WordPress mapping lifecycle SQL boundaries", () => {
  it("confirms only within the delivering tenant and connection, and excludes tombstones", async () => {
    await confirmWordPressMediaSync("op", "42", "https://site.test/a.jpg", { businessId: "tenant", connectionId: "site" });
    const [sql, values] = query.mock.calls[0];
    expect(values).toEqual(["op", "42", "https://site.test/a.jpg", "tenant", "site"]);
    expect(sql).toContain("business_id = $4 AND connection_id = $5");
    expect(sql).toContain("remote_attachment_deleted");
    expect(sql).toContain("remote_attachment_trashed");
    expect(sql).toContain("wp_media_id IS NULL OR wp_media_id = $2");
  });

  it("keeps deletion identity/history without touching the canonical file", async () => {
    await reconcileWordPressMediaLifecycle("tenant", "site", "42", "deleted");
    const [sql, values] = query.mock.calls[0];
    expect(values).toEqual(["tenant", "site", "42", "remote_attachment_deleted"]);
    expect(sql).toContain("business_id = $1 AND connection_id = $2 AND wp_media_id = $3");
    expect(sql).not.toMatch(/DELETE|media_assets/);
    expect(sql).toContain("THEN NULL ELSE wp_url END");
  });

  it("restores trash but cannot revive a permanent deletion with a delayed update", async () => {
    await reconcileWordPressMediaLifecycle("tenant", "site", "42", "active");
    expect(query.mock.calls[0][0]).toContain("last_error = 'remote_attachment_trashed'");
  });

  it("late failed ACKs cannot downgrade a confirmed attachment or a deletion", async () => {
    await failWordPressMediaSync("op", "failure");
    expect(query.mock.calls[0][0]).toContain("AND status = 'pending'");
  });

  it("a new operation clears the old remote identity", async () => {
    query.mockResolvedValue({ rows: [{ id: "mapping" }] });
    await recordWordPressMediaPush({ businessId: "tenant", connectionId: "site", mediaAssetId: "asset", operationId: "new-op" });
    const sql = query.mock.calls[0][0];
    expect(sql).toContain("wp_media_id = NULL, wp_url = NULL, synced_at = NULL");
  });
});
