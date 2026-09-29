import { afterEach, describe, expect, it, vi } from "vitest";
import { appendSyncOutboxEvent, syncClientEventId } from "./sync-outbox";

const originalRole = process.env.DEPLOYMENT_ROLE;
afterEach(() => {
  if (originalRole === undefined) delete process.env.DEPLOYMENT_ROLE;
  else process.env.DEPLOYMENT_ROLE = originalRole;
});

describe("transactional sync outbox", () => {
  it("keeps UUID identities and deterministically maps textual domain identities", () => {
    const uuid = "8d5d4db9-28fd-4fa2-8a8c-0e612a7f6bb6";
    expect(syncClientEventId(uuid)).toBe(uuid);
    expect(syncClientEventId("purchase:receive:123")).toBe(syncClientEventId("purchase:receive:123"));
    expect(syncClientEventId("purchase:receive:123")).toMatch(/^[0-9a-f-]{36}$/);
    expect(syncClientEventId("purchase:receive:123")).not.toBe(syncClientEventId("purchase:receive:124"));
  });

  it("writes through the caller-owned client only on a site runtime", async () => {
    process.env.DEPLOYMENT_ROLE = "site";
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    await appendSyncOutboxEvent({ query } as never, {
      locationId: "07d30bc2-11e8-47d8-8fb4-a81cc967986a",
      clientEventId: "waste:domain-id",
      eventType: "inventory.waste.recorded",
      payload: { quantity: "1" },
      actorUserId: null,
      actorRole: "manager",
    });
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0][0]).toContain("INSERT INTO sync_events");
    expect(query.mock.calls[0][1][1]).toBe(syncClientEventId("waste:domain-id"));
    // A site always records.
    expect(query.mock.calls[0][1][8]).toBe(true);
  });

  it("never records while a peer's event is being replayed", async () => {
    process.env.DEPLOYMENT_ROLE = "site";
    const query = vi.fn().mockResolvedValue({ rowCount: 0 });
    await appendSyncOutboxEvent({ query } as never, {
      locationId: "07d30bc2-11e8-47d8-8fb4-a81cc967986a",
      clientEventId: "8d5d4db9-28fd-4fa2-8a8c-0e612a7f6bb6",
      eventType: "inventory.waste.recorded",
      payload: {},
      actorUserId: null,
      actorRole: "manager",
    });
    expect(query.mock.calls[0][0]).toContain("current_setting('app.sync_replay', true)");
  });

  it("records on the central server only for a branch with a paired desktop", async () => {
    process.env.DEPLOYMENT_ROLE = "central";
    const query = vi.fn().mockResolvedValue({ rowCount: 0 });
    await appendSyncOutboxEvent({ query } as never, {
      locationId: "07d30bc2-11e8-47d8-8fb4-a81cc967986a",
      clientEventId: "8d5d4db9-28fd-4fa2-8a8c-0e612a7f6bb6",
      eventType: "inventory.waste.recorded",
      payload: {},
      actorUserId: null,
      actorRole: "manager",
    });
    expect(query.mock.calls[0][1][8]).toBe(false);
    expect(query.mock.calls[0][0]).toContain("FROM site_devices");
  });
});
