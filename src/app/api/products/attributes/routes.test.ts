import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as setup from "@/lib/setup-state";
import * as industry from "@/lib/industry-guard";
import * as service from "@/lib/product-attributes-service";
import { PERMISSIONS } from "@/lib/permissions";
import { GET, POST } from "./route";
import { DELETE, PATCH } from "./[id]/route";

vi.mock("@/lib/auth", () => ({
  withTenantScope: (handler: (...args: unknown[]) => Promise<Response>) => handler,
  requirePermission: vi.fn(),
}));
vi.mock("@/lib/setup-state", () => ({ resolveActiveLocation: vi.fn() }));
vi.mock("@/lib/industry-guard", () => ({ requireProductWorkspaceForApi: vi.fn() }));
vi.mock("@/lib/product-attributes-service", () => ({
  createAttributeDefinition: vi.fn(),
  listAttributeDefinitions: vi.fn(),
  updateAttributeDefinition: vi.fn(),
  deleteAttributeDefinition: vi.fn(),
}));

const session = { businessId: "business-1", locationId: "stale-location", activeLocationId: "branch-a", sub: "member-1", role: "manager" };
const definition = {
  id: "5b04a6c7-df35-4f35-b26b-1534bce6b391",
  locationId: "branch-a",
  name: "رنگ",
  options: ["عسلی", "مشکی"],
  isActive: true,
  version: 3,
  usageCount: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function allowed(): void {
  vi.mocked(auth.requirePermission).mockResolvedValue({ session, error: null } as never);
  vi.mocked(industry.requireProductWorkspaceForApi).mockResolvedValue(null);
  vi.mocked(setup.resolveActiveLocation).mockResolvedValue({ id: "branch-a" } as never);
}

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/products/attributes", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function patch(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/products/attributes/${definition.id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

const context = { params: Promise.resolve({ id: definition.id }) };

beforeEach(() => {
  vi.clearAllMocks();
  allowed();
  vi.mocked(service.listAttributeDefinitions).mockResolvedValue([definition] as never);
  vi.mocked(service.createAttributeDefinition).mockResolvedValue({ definition } as never);
  vi.mocked(service.updateAttributeDefinition).mockResolvedValue({ definition } as never);
  vi.mocked(service.deleteAttributeDefinition).mockResolvedValue({} as never);
});

describe("product attribute API permissions and branch scope", () => {
  it("uses inventory.view for list reads and returns only the resolved branch", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.inventoryView);
    expect(service.listAttributeDefinitions).toHaveBeenCalledWith("branch-a");
    expect(await response.json()).toEqual({ definitions: [definition] });
  });

  it("does not query definitions after view access is revoked", async () => {
    vi.mocked(auth.requirePermission).mockResolvedValue({
      session: null,
      error: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    } as never);
    const response = await GET();
    expect(response.status).toBe(403);
    expect(service.listAttributeDefinitions).not.toHaveBeenCalled();
  });

  it("requires inventory.adjust to create and passes the resolved branch and tenant", async () => {
    const response = await POST(post({ name: "رنگ", options: ["عسلی"] }));
    expect(response.status).toBe(200);
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.inventoryAdjust);
    expect(service.createAttributeDefinition).toHaveBeenCalledWith({
      businessId: "business-1",
      locationId: "branch-a",
      name: "رنگ",
      options: ["عسلی"],
      isActive: true,
    });
  });

  it("rejects unexpected and unbounded create payloads before reaching the service", async () => {
    const invalid = await POST(post({ name: "رنگ", unexpected: true }));
    expect(invalid.status).toBe(400);
    expect(service.createAttributeDefinition).not.toHaveBeenCalled();

    const oversized = new NextRequest("http://localhost/api/products/attributes", {
      method: "POST",
      body: JSON.stringify({ name: "x", options: ["y"] }).padEnd(17_000, " "),
    });
    const tooLarge = await POST(oversized);
    expect(tooLarge.status).toBe(413);
    expect(service.createAttributeDefinition).not.toHaveBeenCalled();
  });

  it("PATCH requires a version and scopes the ID to the active branch", async () => {
    const invalid = await PATCH(patch({ name: "طیف رنگ" }), context);
    expect(invalid.status).toBe(400);
    expect(service.updateAttributeDefinition).not.toHaveBeenCalled();

    vi.mocked(service.updateAttributeDefinition).mockResolvedValue({ error: "not_found" } as never);
    const response = await PATCH(patch({ name: "طیف رنگ", version: 3 }), context);
    expect(response.status).toBe(404);
    expect(service.updateAttributeDefinition).toHaveBeenCalledWith(
      definition.id,
      "branch-a",
      { name: "طیف رنگ", version: 3 },
      "business-1",
    );
  });

  it("surfaces concurrent edits and refuses deleting an in-use definition", async () => {
    vi.mocked(service.updateAttributeDefinition).mockResolvedValue({ error: "version_conflict", current: { ...definition, version: 4 } } as never);
    const conflict = await PATCH(patch({ name: "طیف رنگ", version: 3 }), context);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: "edit_conflict", current: { version: 4 } });

    vi.mocked(service.deleteAttributeDefinition).mockResolvedValue({ error: "in_use", usageCount: 2 } as never);
    const deletion = await DELETE(new NextRequest(`http://localhost/api/products/attributes/${definition.id}`, { method: "DELETE" }), context);
    expect(deletion.status).toBe(409);
    expect(await deletion.json()).toEqual({ error: "in_use", usageCount: 2 });
    expect(service.deleteAttributeDefinition).toHaveBeenCalledWith(definition.id, "branch-a", "business-1");
  });

  it("rejects malformed IDs before looking up or mutating any row", async () => {
    const invalidContext = { params: Promise.resolve({ id: "not-a-uuid" }) };
    const response = await PATCH(patch({ name: "رنگ جدید", version: 1 }), invalidContext);
    expect(response.status).toBe(400);
    expect(service.updateAttributeDefinition).not.toHaveBeenCalled();
  });
});
