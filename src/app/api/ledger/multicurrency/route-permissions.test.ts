/**
 * Route-level permission checks for the multicurrency APIs and the currency
 * settings/rates APIs that the «ارز و تسعیر» tool reads and writes.
 *
 * Menu hiding is not authorization, so these tests do not mock the guard. The
 * real `requirePermission` → `authorize()` chain runs against a role resolved
 * from the same `users` row the production query reads. Only the cookie, the
 * session token and the database boundary are replaced. Each denial must come
 * back as 403 naming the missing capability, and a denied request must never
 * reach a business query.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Role } from "@/lib/auth";
import { PERMISSIONS, type Permission } from "@/lib/permissions";
import { GET as entriesGet, POST as entriesPost } from "./entries/route";
import { GET as reportsGet } from "./reports/route";
import { GET as revaluationsGet, POST as revaluationsPost } from "./revaluations/route";
import { POST as settlementsPost } from "./settlements/route";
import { GET as currencySettingsGet, PUT as currencySettingsPut } from "@/app/api/currencies/settings/route";
import { GET as currencyRatesGet, POST as currencyRatesPost } from "@/app/api/currencies/rates/route";

const mocks = vi.hoisted(() => ({
  cookies: vi.fn(),
  verifySession: vi.fn(),
  query: vi.fn(),
  role: "owner" as string,
}));

vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
vi.mock("@/lib/auth-edge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth-edge")>();
  return { ...actual, verifySession: mocks.verifySession };
});
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, query: mocks.query };
});

const BUSINESS_ID = "00000000-0000-4000-8000-000000000013";
const USER_ID = "00000000-0000-4000-8000-000000000011";
const LOCATION_ID = "00000000-0000-4000-8000-000000000012";

/** The one membership row `loadMembership` reads; the role is the only variable. */
function membershipRow(role: string) {
  return {
    role,
    permissions: null,
    is_active: true,
    membership_status: "active",
    location_id: LOCATION_ID,
    location_scope: "all",
    business_status: "active",
    custom_role_permissions: null,
    deployment_profile: null,
    site_permission_denies: null,
    site_allowed_location_ids: null,
    is_locally_suspended: false,
    local_login_locked: false,
  };
}

const MEMBERSHIP_SQL = /FROM users u\b/;

/**
 * Reads of the books or of currency data. The route wrapper's module and
 * feature-flag lookups are tenant configuration and run before any capability
 * check, so they are not what a refused request must avoid.
 */
const LEDGER_DATA_SQL = /\b(journal|ledger|currenc|exchange_rate|settlement|revaluation|entry_lines|entries|accounts)\b/i;

function ledgerDataQueries(): string[] {
  return mocks.query.mock.calls
    .map(([sql]) => String(sql))
    .filter((sql) => LEDGER_DATA_SQL.test(sql));
}

type Handler = (request: NextRequest, ...rest: unknown[]) => Promise<Response>;

interface Case {
  name: string;
  handler: Handler;
  method: "GET" | "POST" | "PUT";
  url: string;
  permission: Permission;
  allowed: readonly Role[];
  denied: readonly Role[];
}

const LEDGER_VIEW_ROLES: readonly Role[] = ["owner", "admin", "manager", "accountant"];
const LEDGER_POST_ROLES: readonly Role[] = ["owner", "admin", "accountant"];
const SETTINGS_MANAGE_ROLES: readonly Role[] = ["owner", "admin", "manager"];
const FLOOR_ROLES: readonly Role[] = ["cashier", "waiter", "kitchen"];

const API = "https://tenant.example/api";

const CASES: readonly Case[] = [
  {
    name: "GET /api/ledger/multicurrency/entries",
    handler: entriesGet as unknown as Handler,
    method: "GET",
    url: `${API}/ledger/multicurrency/entries`,
    permission: PERMISSIONS.ledgerView,
    allowed: LEDGER_VIEW_ROLES,
    denied: [...FLOOR_ROLES],
  },
  {
    name: "POST /api/ledger/multicurrency/entries",
    handler: entriesPost as unknown as Handler,
    method: "POST",
    url: `${API}/ledger/multicurrency/entries`,
    permission: PERMISSIONS.ledgerPost,
    allowed: LEDGER_POST_ROLES,
    // A manager can read the books but cannot post to them.
    denied: [...FLOOR_ROLES, "manager"],
  },
  {
    name: "GET /api/ledger/multicurrency/reports",
    handler: reportsGet as unknown as Handler,
    method: "GET",
    url: `${API}/ledger/multicurrency/reports`,
    permission: PERMISSIONS.ledgerView,
    allowed: LEDGER_VIEW_ROLES,
    denied: [...FLOOR_ROLES],
  },
  {
    name: "GET /api/ledger/multicurrency/revaluations",
    handler: revaluationsGet as unknown as Handler,
    method: "GET",
    url: `${API}/ledger/multicurrency/revaluations`,
    permission: PERMISSIONS.ledgerView,
    allowed: LEDGER_VIEW_ROLES,
    denied: [...FLOOR_ROLES],
  },
  {
    name: "POST /api/ledger/multicurrency/revaluations",
    handler: revaluationsPost as unknown as Handler,
    method: "POST",
    url: `${API}/ledger/multicurrency/revaluations`,
    permission: PERMISSIONS.ledgerPost,
    allowed: LEDGER_POST_ROLES,
    denied: [...FLOOR_ROLES, "manager"],
  },
  {
    name: "POST /api/ledger/multicurrency/settlements",
    handler: settlementsPost as unknown as Handler,
    method: "POST",
    url: `${API}/ledger/multicurrency/settlements`,
    permission: PERMISSIONS.ledgerPost,
    allowed: LEDGER_POST_ROLES,
    denied: [...FLOOR_ROLES, "manager"],
  },
  {
    name: "GET /api/currencies/settings",
    handler: currencySettingsGet as unknown as Handler,
    method: "GET",
    url: `${API}/currencies/settings`,
    permission: PERMISSIONS.ledgerView,
    allowed: LEDGER_VIEW_ROLES,
    denied: [...FLOOR_ROLES],
  },
  {
    name: "PUT /api/currencies/settings",
    handler: currencySettingsPut as unknown as Handler,
    method: "PUT",
    url: `${API}/currencies/settings`,
    permission: PERMISSIONS.settingsManage,
    allowed: SETTINGS_MANAGE_ROLES,
    // The accountant can post and read, but changing currency settings is a
    // settings capability, not a ledger one.
    denied: [...FLOOR_ROLES, "accountant"],
  },
  {
    name: "GET /api/currencies/rates",
    handler: currencyRatesGet as unknown as Handler,
    method: "GET",
    url: `${API}/currencies/rates`,
    permission: PERMISSIONS.ledgerView,
    allowed: LEDGER_VIEW_ROLES,
    denied: [...FLOOR_ROLES],
  },
  {
    name: "POST /api/currencies/rates",
    handler: currencyRatesPost as unknown as Handler,
    method: "POST",
    url: `${API}/currencies/rates`,
    permission: PERMISSIONS.ledgerPost,
    allowed: LEDGER_POST_ROLES,
    denied: [...FLOOR_ROLES, "manager"],
  },
];

function requestFor(c: Case): NextRequest {
  const init: { method: string; headers?: Record<string, string>; body?: string } = { method: c.method };
  if (c.method !== "GET") {
    init.headers = { "content-type": "application/json" };
    init.body = "{}";
  }
  return new NextRequest(c.url, init);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cookies.mockResolvedValue({ get: () => ({ value: "tenant-session" }) });
  mocks.verifySession.mockImplementation(async () => ({
    businessId: BUSINESS_ID,
    locationId: LOCATION_ID,
    sub: USER_ID,
    role: mocks.role,
  }));
  mocks.query.mockImplementation(async (sql: string) => {
    if (MEMBERSHIP_SQL.test(sql)) return { rows: [membershipRow(mocks.role)] };
    return { rows: [] };
  });
});

describe("multicurrency and currency APIs: real guard, real role resolution", () => {
  for (const c of CASES) {
    describe(c.name, () => {
      for (const role of c.denied) {
        it(`refuses ${role} with 403 naming ${c.permission} and reads no ledger or currency data`, async () => {
          mocks.role = role;
          const response = await c.handler(requestFor(c));
          expect(response.status).toBe(403);
          expect(await response.json()).toEqual({
            error: "forbidden",
            code: "MISSING_PERMISSION",
            permission: c.permission,
          });
          expect(ledgerDataQueries()).toEqual([]);
        });
      }

      for (const role of c.allowed) {
        it(`lets ${role} past the guard`, async () => {
          mocks.role = role;
          const response = await c.handler(requestFor(c));
          // The handler may still answer 400/404 for an empty body; what
          // matters here is that the capability check does not refuse it.
          expect(response.status).not.toBe(401);
          expect(response.status).not.toBe(403);
        });
      }
    });
  }
});
