import { beforeEach, describe, expect, it, vi } from "vitest";
import { query } from "../db";
import { enqueueWpPostUpsert, findWpContentCreateRequest, wpContentWriteStatuses } from "./wp-content-service";
import type { ConnectionRow } from "./connections-service";

vi.mock("../db", () => ({ query: vi.fn() }));

const connection = {
  id: "connection-1",
  business_id: "business-1",
  plugin_capabilities: { jobTypes: ["post_upsert"] },
} as unknown as ConnectionRow;

const mockedQuery = vi.mocked(query);

describe("enqueueWpPostUpsert", () => {
  beforeEach(() => mockedQuery.mockReset());

  it("uses field-wise JSON merge for pending partial edits", async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
    const outcome = await enqueueWpPostUpsert(connection, "post", "42", undefined, { title: "New title" });

    expect(outcome).toBe("queued");
    const [sql, params] = mockedQuery.mock.calls[0];
    expect(String(sql)).toContain("integration_outbox_events.payload || EXCLUDED.payload");
    expect(String(sql)).toContain("status = 'pending'");
    expect(String(sql)).toContain("leased_until < now()");
    expect(String(sql)).not.toContain("leased_until = NULL");
    expect(JSON.parse(String(params?.[3]))).toMatchObject({ title: "New title", id: "42", post_type: "post" });
  });

  it("does not overwrite leased/in-flight rows", async () => {
    mockedQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [{ status: "processing" }], rowCount: 1 } as never);

    await expect(enqueueWpPostUpsert(connection, "page", "8", undefined, { excerpt: "latest" }))
      .resolves.toBe("in_flight");
  });

  it("recognizes an acknowledged create retry instead of enqueueing a duplicate", async () => {
    mockedQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [{ status: "sent" }], rowCount: 1 } as never);

    await expect(enqueueWpPostUpsert(connection, "post", undefined, "request-uuid", { title: "New" }))
      .resolves.toBe("already_applied");
  });

  it("returns pending/error states for the visible posts without returning job payloads", async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [{ remote_id: "42", status: "pending" }, { remote_id: "43", status: "failed" }], rowCount: 2 } as never);
    await expect(wpContentWriteStatuses("business-1", "connection-1", ["42", "43"])).resolves.toEqual({
      "42": "pending",
      "43": "failed",
    });
    expect(String(mockedQuery.mock.calls[0][0])).not.toContain("payload,");
  });

  it("looks up a successful REST create by its request key", async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [{ remote_id: "77" }], rowCount: 1 } as never);
    await expect(findWpContentCreateRequest("business-1", "connection-1", "post", "request-uuid"))
      .resolves.toBe("77");
    expect(String(mockedQuery.mock.calls[0][0])).toContain("payload->>'_create_request_id'");
  });

  it("does not create work for plugins that did not advertise post_upsert", async () => {
    const olderPlugin = { ...connection, plugin_capabilities: null } as ConnectionRow;
    await expect(enqueueWpPostUpsert(olderPlugin, "post", undefined, "request-uuid", { title: "New" }))
      .resolves.toBe("unsupported");
    expect(mockedQuery).not.toHaveBeenCalled();
  });
});
