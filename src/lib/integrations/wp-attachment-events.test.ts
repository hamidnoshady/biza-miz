import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  confirm: vi.fn(),
  reconcile: vi.fn(),
  upsert: vi.fn(),
  remove: vi.fn(),
  safeUrl: vi.fn(),
}));

vi.mock("../db", () => ({
  query: mocks.query,
  isPinnedToTransaction: () => false,
  withTenantTransaction: async (_: string, fn: () => unknown) => fn(),
}));
vi.mock("../media-service", () => ({
  confirmWordPressMediaSync: mocks.confirm,
  reconcileWordPressMediaLifecycle: mocks.reconcile,
}));
vi.mock("./wp-content-service", () => ({
  upsertWpContent: mocks.upsert,
  deleteWpContent: mocks.remove,
  safeWpUrl: mocks.safeUrl,
}));

import { applyWpAttachmentEvent, attachmentRevision } from "./wp-attachment-events";
import type { ConnectionRow } from "./connections-service";

const connection = { id: "site", business_id: "tenant", status: "active" } as unknown as ConnectionRow;

/** Serves the one read applyWpAttachmentEvent makes: the stored media state. */
function state(rows: Array<{ revision: string; deleted: boolean }>) {
  mocks.query.mockImplementation(async (sql: string) => {
    if (String(sql).includes("FROM integration_wp_media_state")) return { rows };
    return { rows: [] };
  });
}

const callsMatching = (fragment: string) =>
  mocks.query.mock.calls.filter(([sql]) => String(sql).includes(fragment));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.safeUrl.mockImplementation((value: unknown) =>
    typeof value === "string" && value.startsWith("https://shop.test/") ? value : null,
  );
  mocks.confirm.mockResolvedValue(true);
  mocks.upsert.mockResolvedValue(undefined);
  mocks.remove.mockResolvedValue(undefined);
  mocks.reconcile.mockResolvedValue(undefined);
  state([]);
});

describe("#941 attachment revision guard", () => {
  it("accepts only positive integers as revisions", () => {
    expect(attachmentRevision("1")).toBe("1");
    expect(attachmentRevision("9007199254740993")).toBe("9007199254740993");
    expect(attachmentRevision("0")).toBeNull();
    expect(attachmentRevision("-1")).toBeNull();
    expect(attachmentRevision("1.5")).toBeNull();
    expect(attachmentRevision(7)).toBeNull();
    expect(attachmentRevision(undefined)).toBeNull();
  });

  it("rejects a malformed id or revision before touching the database", async () => {
    await expect(
      applyWpAttachmentEvent(connection, { id: "0", type: "attachment" } as never, false),
    ).rejects.toThrow("invalid_attachment_id");
    await expect(
      applyWpAttachmentEvent(connection, { id: "42", revision: "x", type: "attachment" } as never, false),
    ).rejects.toThrow("invalid_attachment_revision");
    expect(mocks.query).not.toHaveBeenCalled();
  });
});

describe("#941 versioned events are idempotent and monotonic", () => {
  it("applies and records a newer revision", async () => {
    state([{ revision: "4", deleted: false }]);
    expect(
      await applyWpAttachmentEvent(connection, { id: "42", revision: "5", type: "attachment" } as never, false),
    ).toBe(true);
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    expect(callsMatching("INSERT INTO integration_wp_media_state")[0]?.[1]).toEqual([
      "tenant",
      "site",
      "42",
      "5",
      false,
    ]);
  });

  it("ignores a replay of the same or an older revision without rewriting the mirror", async () => {
    state([{ revision: "5", deleted: false }]);
    expect(
      await applyWpAttachmentEvent(connection, { id: "42", revision: "5", type: "attachment" } as never, false),
    ).toBe(false);
    expect(
      await applyWpAttachmentEvent(connection, { id: "42", revision: "3", type: "attachment" } as never, false),
    ).toBe(false);
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(callsMatching("INSERT INTO integration_wp_media_state")).toHaveLength(0);
  });

  it("never lets an unversioned legacy delivery override a versioned one", async () => {
    state([{ revision: "5", deleted: false }]);
    expect(await applyWpAttachmentEvent(connection, { id: "42", type: "attachment" } as never, false)).toBe(false);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("treats a permanent deletion as terminal for that WordPress id", async () => {
    state([{ revision: "6", deleted: true }]);
    expect(
      await applyWpAttachmentEvent(
        connection,
        { id: "42", revision: "7", type: "attachment", source_url: "https://shop.test/a.jpg" } as never,
        false,
      ),
    ).toBe(false);
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });
});

describe("#941 deletion invalidates pending pushes instead of a second store", () => {
  it("marks the operation's pending mapping failed and clears its remote URL", async () => {
    await applyWpAttachmentEvent(
      connection,
      { id: "42", revision: "3", type: "attachment", operation_id: "op-1" } as never,
      true,
    );
    expect(mocks.remove).toHaveBeenCalledWith("tenant", "site", { id: "42", type: "attachment" });
    expect(mocks.reconcile).toHaveBeenCalledWith("tenant", "site", "42", "deleted");
    const [update] = callsMatching("UPDATE wordpress_media_mapping");
    expect(String(update[0])).toContain("last_error = 'remote_attachment_deleted'");
    expect(String(update[0])).toContain("wp_url = NULL");
    expect(update[1]).toEqual(["tenant", "site", "op-1", "42"]);
  });

  it("invalidates a pending push reported by a tombstone even after the id is gone", async () => {
    state([{ revision: "6", deleted: true }]);
    expect(
      await applyWpAttachmentEvent(
        connection,
        { id: "42", revision: "6", type: "attachment", operation_id: "op-1" } as never,
        false,
      ),
    ).toBe(false);
    expect(String(callsMatching("UPDATE wordpress_media_mapping")[0]?.[0])).toContain(
      "last_error = 'remote_attachment_deleted'",
    );
  });

  it("records a durable tombstone for a legacy delete that carries no revision", async () => {
    await applyWpAttachmentEvent(connection, { id: "42", type: "attachment" } as never, true);
    expect(callsMatching("INSERT INTO integration_wp_media_state")[0]?.[1]).toEqual([
      "tenant",
      "site",
      "42",
      "0",
      true,
    ]);
    expect(mocks.reconcile).toHaveBeenCalledWith("tenant", "site", "42", "deleted");
  });
});

describe("#941 confirmations require a stable remote identity", () => {
  it("confirms only when the push's own operation id and a safe URL come back", async () => {
    await applyWpAttachmentEvent(
      connection,
      {
        id: "42",
        revision: "1",
        type: "attachment",
        operation_id: "op-1",
        source_url: "https://shop.test/a.jpg",
      } as never,
      false,
    );
    expect(mocks.confirm).toHaveBeenCalledWith("op-1", "42", "https://shop.test/a.jpg", {
      businessId: "tenant",
      connectionId: "site",
    });
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.reconcile).toHaveBeenCalledWith("tenant", "site", "42", "active");
  });

  it("never confirms from an operation-less event or an unsafe URL", async () => {
    await applyWpAttachmentEvent(
      connection,
      { id: "42", revision: "1", type: "attachment", source_url: "http://127.0.0.1:8080/a.jpg" } as never,
      false,
    );
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
  });

  it("keeps a trashed attachment in the mirror but marks its mapping trashed", async () => {
    await applyWpAttachmentEvent(
      connection,
      { id: "42", revision: "2", type: "attachment", status: "trash", operation_id: "op-1", source_url: "https://shop.test/a.jpg" } as never,
      false,
    );
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.reconcile.mock.calls).toEqual([
      ["tenant", "site", "42", "trash"],
      ["tenant", "site", "42", "trash"],
    ]);
  });

  it("restores a previously trashed attachment to synced", async () => {
    await applyWpAttachmentEvent(
      connection,
      { id: "42", revision: "2", type: "attachment", status: "inherit", operation_id: "op-1", source_url: "https://shop.test/a.jpg" } as never,
      false,
    );
    expect(mocks.reconcile).toHaveBeenCalledWith("tenant", "site", "42", "active");
  });
});
