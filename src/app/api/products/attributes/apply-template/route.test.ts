import { beforeEach, describe, expect, it, vi } from "vitest";
import * as auth from "@/lib/auth";
import * as guard from "@/lib/industry-guard";
import * as setup from "@/lib/setup-state";
import * as service from "@/lib/product-attributes-service";
import { PERMISSIONS } from "@/lib/permissions";
import { attributeTemplateByKey } from "@/lib/product-attribute-templates";
import { POST } from "./route";

vi.mock("@/lib/auth", () => ({
  withTenantScope: (handler: (...args: unknown[]) => Promise<Response>) => handler,
  requirePermission: vi.fn(),
}));
vi.mock("@/lib/industry-guard", () => ({
  requireProductWorkspaceForApi: vi.fn(),
  getBusinessIndustry: vi.fn(),
}));
vi.mock("@/lib/setup-state", () => ({ resolveActiveLocation: vi.fn() }));
vi.mock("@/lib/product-attributes-service", () => ({ applyAttributeTemplate: vi.fn() }));
vi.mock("@/lib/db", () => ({
  withTenantTransaction: vi.fn(async (_businessId: string, fn: (client: unknown) => Promise<unknown>) =>
    fn({ id: "pinned-client" })),
}));

const SESSION = { businessId: "business-1", sub: "user-1" };
const handler = POST as unknown as (request: Request) => Promise<Response>;

function post(body: unknown): Request {
  return new Request("http://test.local/api/products/attributes/apply-template", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(guard.requireProductWorkspaceForApi).mockResolvedValue(null);
  vi.mocked(guard.getBusinessIndustry).mockResolvedValue("fashion_apparel" as never);
  vi.mocked(setup.resolveActiveLocation).mockResolvedValue({ id: "location-1" } as never);
  vi.mocked(service.applyAttributeTemplate).mockResolvedValue({ created: 11, skipped: 0 } as never);
});

describe("POST /api/products/attributes/apply-template (#1567)", () => {
  it("requires inventory.adjust and applies the template inside a tenant transaction", async () => {
    const response = await handler(post({ templateKey: "fashion_apparel" }));
    expect(response.status).toBe(200);
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.inventoryAdjust);
    expect(guard.requireProductWorkspaceForApi).toHaveBeenCalledWith(SESSION);
    expect(service.applyAttributeTemplate).toHaveBeenCalledWith(
      { id: "pinned-client" },
      { locationId: "location-1", template: attributeTemplateByKey("fashion_apparel") },
    );
    expect(await response.json()).toEqual({ ok: true, created: 11, skipped: 0 });
  });

  it("refuses without inventory.adjust", async () => {
    const forbidden = Response.json({ error: "forbidden" }, { status: 403 });
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: null, error: forbidden } as never);
    const response = await handler(post({ templateKey: "fashion_apparel" }));
    expect(response.status).toBe(403);
    expect(service.applyAttributeTemplate).not.toHaveBeenCalled();
  });

  it("answers 400 when the template key is missing or not a string", async () => {
    for (const body of [{}, { templateKey: 7 }, { templateKey: "  " }, []]) {
      const response = await handler(post(body));
      expect(response.status).toBe(400);
    }
    expect(service.applyAttributeTemplate).not.toHaveBeenCalled();
  });

  it("answers the same 404 for an unknown key and for one another industry owns", async () => {
    vi.mocked(guard.getBusinessIndustry).mockResolvedValue("fashion_apparel" as never);
    expect((await handler(post({ templateKey: "no-such-template" }))).status).toBe(404);

    // A wholesale shop asking for the fashion preset is not an error to
    // distinguish — the catalog is public in the client bundle anyway.
    vi.mocked(guard.getBusinessIndustry).mockResolvedValue("wholesale" as never);
    expect((await handler(post({ templateKey: "fashion_apparel" }))).status).toBe(404);
    expect(service.applyAttributeTemplate).not.toHaveBeenCalled();
  });

  it("answers 409 without an active branch", async () => {
    vi.mocked(setup.resolveActiveLocation).mockResolvedValue(null as never);
    const response = await handler(post({ templateKey: "fashion_apparel" }));
    expect(response.status).toBe(409);
    expect(service.applyAttributeTemplate).not.toHaveBeenCalled();
  });
});
