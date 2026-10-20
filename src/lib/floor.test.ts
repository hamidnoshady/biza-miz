import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import * as auth from "./auth";
import * as authorizeMod from "./authorize";
import * as db from "./db";
import * as setup from "./setup-state";
import * as staffEligibility from "./staff-eligibility";
import { PERMISSIONS } from "./permissions";
import {
  canViewSessionCustomerPhone,
  checkTableSectionAuthorization,
  resolveFloorSectionAccessScope,
  resolveFloorSnapshotCapabilities,
  validWaiterId,
} from "./floor";
import { GET as getFloorRoute } from "@/app/api/floor/route";

vi.mock("./auth", () => ({
  withTenantScope: (handler: (...args: unknown[]) => Promise<Response>) => handler,
  requirePermission: vi.fn(),
  requireAnyPermission: vi.fn(),
}));
vi.mock("./authorize", () => ({
  authorize: vi.fn(),
}));
vi.mock("./db", () => ({
  query: vi.fn(),
}));
vi.mock("./setup-state", () => ({
  resolveActiveLocation: vi.fn(),
}));
vi.mock("./staff-eligibility", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./staff-eligibility")>();
  return {
    ...actual,
    isEligibleStaffAtLocation: vi.fn(),
    listEligibleStaffAtLocation: vi.fn(),
  };
});

const businessId = "00000000-0000-0000-0000-000000000001";
const locationId = "00000000-0000-0000-0000-000000000010";
const sectionA = "00000000-0000-0000-0000-000000000031";
const sectionB = "00000000-0000-0000-0000-000000000032";
const tableA = "00000000-0000-0000-0000-000000000041";
const tableB = "00000000-0000-0000-0000-000000000042";
const waiterA = "00000000-0000-0000-0000-000000000051";
const waiterB = "00000000-0000-0000-0000-000000000052";
const cashierId = "00000000-0000-0000-0000-000000000061";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(setup.resolveActiveLocation).mockResolvedValue({
    id: locationId,
    timezone: "Asia/Tehran",
  } as never);
});

describe("Floor & Table Management permission matrix (Issue #916)", () => {
  it("1. Revoked role: denies capabilities, PII access, floor scope, and GET /api/floor", async () => {
    const revokedSession = {
      sub: waiterA,
      fullName: "کاربر لغو شده",
      businessId,
      role: "waiter" as const,
      locationId,
      tokenVersion: 1,
    };

    vi.mocked(authorizeMod.authorize).mockResolvedValue({
      ok: false,
      reason: "forbidden",
      status: 403,
    } as never);
    vi.mocked(db.query).mockResolvedValue({ rows: [] } as never);

    await expect(resolveFloorSnapshotCapabilities(revokedSession)).resolves.toEqual({
      canSeeOrders: false,
      canEditTables: false,
    });
    await expect(canViewSessionCustomerPhone(revokedSession)).resolves.toBe(false);

    const scope = await resolveFloorSectionAccessScope(revokedSession, locationId);
    expect(scope.hasFullFloorAccess).toBe(false);
    expect(scope.permissions.size).toBe(0);

    vi.mocked(auth.requireAnyPermission).mockResolvedValueOnce({
      session: null,
      error: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    } as never);
    const res = await getFloorRoute();
    expect(res.status).toBe(403);
  });

  it("2. Custom role with tables.edit only: can view/edit floor layout and archived tables, but cannot see orders or customer phones", async () => {
    const designerSession = {
      sub: "00000000-0000-0000-0000-000000000071",
      fullName: "طراح سالن",
      businessId,
      role: "waiter" as const,
      locationId,
      tokenVersion: 1,
    };

    vi.mocked(authorizeMod.authorize).mockResolvedValue({
      ok: true,
      membership: {
        permissions: new Set([PERMISSIONS.tablesEdit]),
      },
    } as never);

    const caps = await resolveFloorSnapshotCapabilities(designerSession);
    expect(caps).toEqual({
      canSeeOrders: false,
      canEditTables: true,
    });
    await expect(canViewSessionCustomerPhone(designerSession)).resolves.toBe(false);

    vi.mocked(auth.requireAnyPermission).mockResolvedValueOnce({
      session: designerSession,
      error: null,
    } as never);
    vi.mocked(db.query).mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM dining_tables dt") && sql.includes("WHERE dt.location_id = $1 AND dt.is_active")) {
        // Verify $2 (canSeeOrders) is false so open_orders are redacted in SQL
        expect(params?.[1]).toBe(false);
        return {
          rows: [
            {
              id: tableA,
              name: "میز ۱",
              status: "reserved",
              open_orders: [],
            },
          ],
        } as never;
      }
      if (sql.includes("WHERE dt.location_id = $1 AND NOT dt.is_active")) {
        return {
          rows: [{ id: "archived-1", name: "میز قدیمی", status: "free" }],
        } as never;
      }
      return { rows: [] } as never;
    });

    const floorRes = await getFloorRoute();
    expect(floorRes.status).toBe(200);
    const body = await floorRes.json();
    expect(body.tables).toHaveLength(1);
    expect(body.tables[0].status).toBe("reserved"); // legacy 'reserved' status row preserved
    expect(body.tables[0].open_orders).toEqual([]);
    expect(body.archivedTables).toHaveLength(1);
  });

  it("3. Cashier: eligible for floor section assignment, can view orders and customer phones, but cannot structurally edit tables", async () => {
    expect(staffEligibility.ASSIGNABLE_FLOOR_STAFF_ROLES).toContain("cashier");

    const cashierSession = {
      sub: cashierId,
      fullName: "صندوقدار",
      businessId,
      role: "cashier" as const,
      locationId,
      tokenVersion: 1,
    };

    vi.mocked(authorizeMod.authorize).mockResolvedValue({
      ok: true,
      membership: {
        permissions: new Set([
          PERMISSIONS.tablesManage,
          PERMISSIONS.ordersView,
          PERMISSIONS.ordersCreate,
          PERMISSIONS.reservationsManage,
          PERMISSIONS.partiesView,
        ]),
      },
    } as never);

    await expect(resolveFloorSnapshotCapabilities(cashierSession)).resolves.toEqual({
      canSeeOrders: true,
      canEditTables: false,
    });
    await expect(canViewSessionCustomerPhone(cashierSession)).resolves.toBe(true);

    vi.mocked(staffEligibility.isEligibleStaffAtLocation).mockResolvedValueOnce(true);
    await expect(validWaiterId(businessId, locationId, cashierId)).resolves.toBe(cashierId);
  });

  it("4. Cross-section staff: allows assigned section and blocks mutations on tables in another waiter's section", async () => {
    const waiterSession = {
      sub: waiterA,
      fullName: "گارسون الف",
      businessId,
      role: "waiter" as const,
      locationId,
      tokenVersion: 1,
    };

    vi.mocked(authorizeMod.authorize).mockResolvedValue({
      ok: true,
      membership: {
        permissions: new Set([PERMISSIONS.tablesManage, PERMISSIONS.ordersCreate]),
      },
    } as never);

    vi.mocked(db.query).mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("SELECT id FROM floor_sections WHERE location_id = $1 AND assigned_waiter_id = $2")) {
        return { rows: [{ id: sectionA }] } as never;
      }
      if (sql.includes("SELECT dt.id AS table_id, dt.section_id, fs.assigned_waiter_id")) {
        const ids = (params?.[1] as string[]) ?? [];
        return {
          rows: ids.map((id) =>
            id === tableA
              ? { table_id: tableA, section_id: sectionA, assigned_waiter_id: waiterA }
              : { table_id: tableB, section_id: sectionB, assigned_waiter_id: waiterB },
          ),
        } as never;
      }
      return { rows: [] } as never;
    });

    const ownSectionCheck = await checkTableSectionAuthorization(waiterSession, locationId, [tableA]);
    expect(ownSectionCheck.allowed).toBe(true);
    expect(ownSectionCheck.scope.mode).toBe("assigned_sections");

    const crossSectionCheck = await checkTableSectionAuthorization(waiterSession, locationId, [tableB]);
    expect(crossSectionCheck.allowed).toBe(false);
  });
});
