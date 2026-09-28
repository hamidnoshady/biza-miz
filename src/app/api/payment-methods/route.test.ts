import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as service from "@/lib/payment-methods-service";
import { PERMISSIONS } from "@/lib/permissions";
import { GET } from "./route";

vi.mock("@/lib/auth", () => ({
  withTenantScope: (handler: () => Promise<Response>) => handler,
  requireAnyPermission: vi.fn(),
}));
vi.mock("@/lib/payment-methods-service", () => ({ listPaymentMethods: vi.fn() }));

const session = { businessId: "business-1", sub: "cashier-1", role: "cashier" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requireAnyPermission).mockResolvedValue({ session, error: null } as never);
  vi.mocked(service.listPaymentMethods).mockResolvedValue([{ id: "cash", name: "نقدی" }] as never);
});

describe("GET /api/payment-methods runtime authorization", () => {
  it("uses transaction capabilities, never payment configuration authority", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(auth.requireAnyPermission).toHaveBeenCalledWith(
      PERMISSIONS.paymentsTake,
      PERMISSIONS.ordersAmendClosed,
      PERMISSIONS.paymentsRefund,
    );
    expect(auth.requireAnyPermission).not.toHaveBeenCalledWith(PERMISSIONS.settingsManage);
    expect(service.listPaymentMethods).toHaveBeenCalledWith(session.businessId);
  });

  it("propagates a canonical 403 and never reads tenant configuration after revocation", async () => {
    vi.mocked(auth.requireAnyPermission).mockResolvedValue({
      session: null,
      error: NextResponse.json({ error: "forbidden", code: "MISSING_PERMISSION" }, { status: 403 }),
    } as never);
    const response = await GET();
    expect(response.status).toBe(403);
    expect(service.listPaymentMethods).not.toHaveBeenCalled();
  });
});
