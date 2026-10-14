import { beforeEach, describe, expect, it, vi } from "vitest";
import * as auth from "@/lib/auth";
import * as industryGuard from "@/lib/industry-guard";
import { GET } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: never[]) => Promise<Response>) => handler,
  };
});

vi.mock("@/lib/industry-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/industry-guard")>();
  return { ...actual, getBusinessIndustry: vi.fn() };
});

const SESSION = { businessId: "business-1", sub: "user-1", role: "manager" as const };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(industryGuard.getBusinessIndustry).mockResolvedValue("food_service");
});

describe("GET /api/reports/views", () => {
  it("publishes each filter's canonical typed control beside its SQL-whitelisted key", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(vi.mocked(auth.requirePermission).mock.calls[0][0]).toBe("reports.view");
    const data = await response.json();
    const menu = data.views.find((view: { key: string }) => view.key === "v_menu_item_performance");
    expect(menu.filters).toContainEqual({
      key: "category",
      label: "دسته",
      control: { kind: "entity", source: "menu-category" },
    });
    const delivery = data.views.find((view: { key: string }) => view.key === "v_delivery_performance");
    expect(delivery.filters[0].control).toMatchObject({
      kind: "enum",
      options: expect.arrayContaining([{ value: "delivered", label: "تحویل‌شده" }]),
    });
  });

  it("refuses the catalogue before querying the business when reports.view is absent", async () => {
    const denied = new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: null, error: denied } as never);
    const response = await GET();
    expect(response.status).toBe(403);
    expect(industryGuard.getBusinessIndustry).not.toHaveBeenCalled();
  });
});
