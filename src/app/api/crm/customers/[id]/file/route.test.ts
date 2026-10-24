import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  getCustomerFile: vi.fn(),
  listCustomerNotes: vi.fn(),
  requirePermission: vi.fn(),
  tenantId: "tenant-a",
  customerId: "8a86d451-f018-4bc9-bcb1-e04bcd96c91c",
  foreignCustomerId: "f6d26594-ddfa-4785-a760-1ddc6fa5858c",
}));

vi.mock("@/lib/auth", () => ({
  withTenantScope: (handler: unknown) => handler,
  requirePermission: fixture.requirePermission,
}));

vi.mock("@/lib/crm-service", () => ({
  getCustomerFile: fixture.getCustomerFile,
  listCustomerNotes: fixture.listCustomerNotes,
}));

import { GET } from "./route";

function requestFor(id: string) {
  return [
    new NextRequest(`http://localhost/api/crm/customers/${id}/file`),
    { params: Promise.resolve({ id }) },
  ] as const;
}

const sameTenantFile = { id: fixture.customerId, name: "مشتری همین کسب‌وکار", stats: { orderCount: 2 } };

beforeEach(() => {
  fixture.requirePermission.mockReset().mockResolvedValue({
    session: { businessId: fixture.tenantId },
    membership: { permissions: new Set(["parties.view"]) },
    error: null,
  });
  fixture.getCustomerFile.mockReset().mockImplementation(async (businessId: string, id: string) => {
    if (businessId === fixture.tenantId && id === fixture.customerId) return sameTenantFile;
    return null;
  });
  fixture.listCustomerNotes.mockReset().mockResolvedValue([]);
});

describe("GET /api/crm/customers/[id]/file tenant boundary", () => {
  it("returns the same-tenant customer's file", async () => {
    const response = await GET(...requestFor(fixture.customerId));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ file: sameTenantFile, notes: [] });
    expect(fixture.getCustomerFile).toHaveBeenCalledWith(
      fixture.tenantId,
      fixture.customerId,
      expect.anything(),
    );
    expect(fixture.listCustomerNotes).toHaveBeenCalledWith(fixture.tenantId, fixture.customerId);
  });

  it.each([
    ["another tenant's UUID", fixture.foreignCustomerId],
    ["an unknown UUID", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
  ])("returns a body-free 404 for %s", async (_description, id) => {
    const response = await GET(...requestFor(id));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "customer_not_found" });
    expect(fixture.listCustomerNotes).not.toHaveBeenCalled();
  });

  it("refuses malformed IDs before reaching the customer service", async () => {
    const response = await GET(...requestFor("not-a-uuid"));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "customer_not_found" });
    expect(fixture.getCustomerFile).not.toHaveBeenCalled();
    expect(fixture.listCustomerNotes).not.toHaveBeenCalled();
  });
});
