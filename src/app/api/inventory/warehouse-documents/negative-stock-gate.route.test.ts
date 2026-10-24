/**
 * The negative-stock confirmation is a privilege, not a body flag (#922).
 *
 * The حواله form asks the user to confirm before issuing more than the branch
 * holds, and the confirmed flag travels as `allowNegativeStock` on the POST
 * body. Before this test existed, any client could send `allowNegativeStock:
 * true` and the service would post the shortage — the "confirmation" was a UI
 * convention. The route now forwards the flag only when the member holds
 * `inventory.negative_stock_override`; otherwise the flag is dropped and the
 * service answers `negative_stock_requires_confirm`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import * as auth from "@/lib/auth";
import * as authorizeModule from "@/lib/authorize";
import * as service from "@/lib/warehouse-document-service";
import { PERMISSIONS } from "@/lib/permissions";
import { POST } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler,
  };
});

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, query: vi.fn(async () => ({ rows: [] })) };
});

vi.mock("@/lib/authorize", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/authorize")>();
  return {
    ...actual,
    authorize: vi.fn().mockResolvedValue({ ok: true }),
    denialResponse: vi.fn(() => NextResponse.json({ error: "forbidden" }, { status: 403 })),
  };
});

const BUSINESS_ID = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
const USER_ID = "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12";
const LOCATION_ID = "c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13";
const ITEM_ID = "d0eebc99-9c0b-4ef8-bb6d-6bb9bd380a14";

const SESSION = { businessId: BUSINESS_ID, sub: USER_ID, role: "manager" };

/** A guard result shaped like `requirePermission`'s: session and membership are siblings. */
function guardWith(permissions: string[]) {
  return {
    session: SESSION,
    membership: { permissions: new Set(permissions) },
    error: null,
  };
}

function request(body: Record<string, unknown>) {
  return {
    json: async () => body,
    headers: { get: () => null },
  } as unknown as NextRequest;
}

const ISSUE_BODY = {
  kind: "issue",
  locationId: LOCATION_ID,
  allowNegativeStock: true,
  lines: [{ inventoryItemId: ITEM_ID, quantity: "5", unitCost: 100 }],
};

let createSpy: MockInstance<typeof service.createWarehouseDocument>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(authorizeModule.authorize).mockResolvedValue({ ok: true } as never);
  createSpy = vi.spyOn(service, "createWarehouseDocument").mockResolvedValue({
    id: "e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a15",
    totalValue: "0",
  } as never);
});

describe("POST /api/inventory/warehouse-documents — negative-stock privilege", () => {
  it("drops the confirmation from a member without the override permission", async () => {
    vi.mocked(auth.requirePermission).mockResolvedValue(
      guardWith([PERMISSIONS.inventoryAdjust]) as never,
    );

    const response = await POST(request(ISSUE_BODY));

    expect(response.status).toBe(200);
    const params = createSpy.mock.calls[0][0] as { allowNegativeStock?: boolean };
    expect(params.allowNegativeStock).toBe(false);
  });

  it("honours the confirmation for a member holding the override permission", async () => {
    vi.mocked(auth.requirePermission).mockResolvedValue(
      guardWith([
        PERMISSIONS.inventoryAdjust,
        PERMISSIONS.inventoryNegativeStockOverride,
      ]) as never,
    );

    await POST(request(ISSUE_BODY));

    const params = createSpy.mock.calls[0][0] as { allowNegativeStock?: boolean };
    expect(params.allowNegativeStock).toBe(true);
  });

  it("never turns on the confirmation when the body does not ask for it", async () => {
    vi.mocked(auth.requirePermission).mockResolvedValue(
      guardWith([
        PERMISSIONS.inventoryAdjust,
        PERMISSIONS.inventoryNegativeStockOverride,
      ]) as never,
    );

    await POST(request({ ...ISSUE_BODY, allowNegativeStock: undefined }));

    const params = createSpy.mock.calls[0][0] as { allowNegativeStock?: boolean };
    expect(params.allowNegativeStock).toBe(false);
  });
});
