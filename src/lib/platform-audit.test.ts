/**
 * `platformAudit` is the accountability write for every privileged action; it
 * must be loud on failure but must not lose the row because the business it
 * attributed the action to no longer exists.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("./db", () => ({ query: mocks.query }));

import { platformAudit } from "./platform-auth";

const entry = {
  adminId: "admin-1",
  businessId: "00000000-0000-0000-0000-000000000000",
  action: "business.inspect",
  entity: "business",
  entityId: "00000000-0000-0000-0000-000000000000",
};

const missingBusiness = Object.assign(new Error("Key is not present in table \"businesses\"."), {
  code: "23503",
  constraint: "platform_audit_log_business_id_fkey",
});

beforeEach(() => {
  mocks.query.mockReset();
});

describe("platformAudit attribution", () => {
  it("files the row unattributed when the business id no longer exists", async () => {
    mocks.query
      .mockRejectedValueOnce(missingBusiness)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await expect(platformAudit(entry)).resolves.toBeUndefined();

    expect(mocks.query).toHaveBeenCalledTimes(2);
    // The subject is still named by entity/entity_id; only the FK-checked
    // attribution column is dropped.
    expect(mocks.query.mock.calls[1][1][1]).toBeNull();
    expect(mocks.query.mock.calls[1][1][4]).toBe(entry.entityId);
  });

  it("still throws, loudly, for any other audit failure", async () => {
    mocks.query.mockRejectedValueOnce(new Error("database is down"));

    await expect(platformAudit(entry)).rejects.toThrow("database is down");
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });
});
