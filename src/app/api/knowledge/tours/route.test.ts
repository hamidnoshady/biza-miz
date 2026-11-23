/**
 * Issue #972 — the tour routes at the boundary a reviewer cares about: a
 * member is only told about tours they are eligible for, an ineligible and a
 * non-existent tour are indistinguishable, a progress write re-checks
 * eligibility and refuses anything but the five known events, and the
 * client can never name a step it was not given.
 *
 * The automatic baseline tours are exercised here too: a registered page with
 * no authored tour answers with its baseline tour through the same two routes,
 * and a baseline id for a page the authored catalogue owns is unknown.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { PERMISSIONS } from "@/lib/permissions";

const mocks = vi.hoisted(() => ({
  requireMember: vi.fn(),
  industry: vi.fn(),
  loadProgress: vi.fn(),
  record: vi.fn(),
  publishedForPage: vi.fn(),
  publishedById: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requireMember: mocks.requireMember,
  withTenantScope: <A extends unknown[]>(handler: (...args: A) => unknown) => handler,
}));

vi.mock("@/lib/features", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/features")>(),
  effectiveFeatures: vi.fn().mockResolvedValue({ ledger: true }),
}));

vi.mock("@/lib/industry-guard", () => ({ getBusinessIndustry: mocks.industry }));

// The super-admin catalogue (migration 0288) is a database read; the routes are
// exercised here with it replaced, so the HTTP contract is tested without a
// database and the pure merge/validation rules are covered by the unit suite.
vi.mock("@/lib/tour-studio-service", () => ({
  publishedToursForPage: mocks.publishedForPage,
  publishedTourById: mocks.publishedById,
}));

// Real eligibility and tour logic; only the database reads/writes are replaced.
vi.mock("@/lib/tours-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tours-service")>();
  return { ...actual, loadTourProgress: mocks.loadProgress, recordTourEvent: mocks.record };
});

import { baselineTourIdForRoute } from "@/lib/tour-baseline";
import { GET as listTours } from "./route";
import { GET as getTour } from "./[tourId]/route";
import { POST as postProgress } from "./[tourId]/progress/route";

const PAGE = "page:/accounting/products";
const TOUR = "accounting.products.list";
// A registered page nobody has authored a tour for.
const BASELINE_PAGE = "page:/knowledge";
const BASELINE_TOUR = baselineTourIdForRoute("/knowledge");

function member(permissions: string[]) {
  return {
    session: { businessId: "biz-1", sub: "user-1" },
    membership: { permissions: new Set(permissions) },
    error: null,
  };
}
const DENIED = { session: null, error: new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }) };

const req = (url: string, init?: ConstructorParameters<typeof NextRequest>[1]) =>
  new NextRequest(`https://biz.example.test${url}`, init);
const ctx = (tourId: string) => ({ params: Promise.resolve({ tourId }) });
const post = (body: unknown) =>
  req(`/api/knowledge/tours/${TOUR}/progress`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireMember.mockResolvedValue(member([PERMISSIONS.inventoryView]));
  mocks.industry.mockResolvedValue("cosmetics");
  mocks.loadProgress.mockResolvedValue(new Map());
  mocks.record.mockResolvedValue({ ok: true, progress: null });
  mocks.publishedForPage.mockResolvedValue([]);
  mocks.publishedById.mockResolvedValue(null);
});

describe("GET /api/knowledge/tours", () => {
  it("requires a signed-in member", async () => {
    mocks.requireMember.mockResolvedValue(DENIED);
    const res = await listTours(req(`/api/knowledge/tours?page=${encodeURIComponent(PAGE)}`));
    expect(res.status).toBe(401);
  });

  it("rejects a page the server does not know", async () => {
    const res = await listTours(req("/api/knowledge/tours?page=page:/nope"));
    expect(res.status).toBe(400);
  });

  it("lists the eligible tour with counts and progress, but no step copy or anchors", async () => {
    const res = await listTours(req(`/api/knowledge/tours?page=${encodeURIComponent(PAGE)}`));
    const body = await res.json();
    expect(body.tours).toHaveLength(1);
    expect(body.tours[0]).toMatchObject({ id: TOUR, stepCount: 5, progress: { status: "not_started" } });
    expect(JSON.stringify(body)).not.toContain("tour-id");
    expect(body.tours[0].steps).toBeUndefined();
  });

  it("says nothing about a tour the member's permissions or trade rule out", async () => {
    mocks.requireMember.mockResolvedValue(member([]));
    expect((await (await listTours(req(`/api/knowledge/tours?page=${encodeURIComponent(PAGE)}`))).json()).tours).toEqual([]);
    mocks.requireMember.mockResolvedValue(member([PERMISSIONS.inventoryView]));
    mocks.industry.mockResolvedValue("food_service");
    expect((await (await listTours(req(`/api/knowledge/tours?page=${encodeURIComponent(PAGE)}`))).json()).tours).toEqual([]);
  });

  it("offers the automatic baseline tour on a page with no authored tour", async () => {
    const res = await listTours(req(`/api/knowledge/tours?page=${encodeURIComponent(BASELINE_PAGE)}`));
    const body = await res.json();
    expect(body.tours).toHaveLength(1);
    expect(body.tours[0]).toMatchObject({
      id: BASELINE_TOUR,
      route: "/knowledge",
      stepCount: 4,
      progress: { status: "not_started" },
    });
    expect(JSON.stringify(body)).not.toContain("tour-id");
    expect(body.tours[0].steps).toBeUndefined();
  });
});

describe("published Studio tours", () => {
  const STUDIO_ID = "studio.crm.audit";
  const studio = {
    id: STUDIO_ID,
    version: 4,
    pageKey: BASELINE_PAGE,
    route: "/knowledge",
    title: "مرکز آموزش",
    description: "تور منتشرشده از استودیو",
    eligibility: {},
    steps: [
      { id: "intro", kind: "explain" as const, title: "شروع", body: "." },
      { id: "header", kind: "spotlight" as const, anchor: "page.header", title: "سرصفحه", body: "." },
    ],
  };

  it("offers the published tour instead of the automatic baseline", async () => {
    mocks.publishedForPage.mockResolvedValue([studio]);
    const res = await listTours(req(`/api/knowledge/tours?page=${encodeURIComponent(BASELINE_PAGE)}`));
    const body = await res.json();
    expect(body.tours).toHaveLength(1);
    expect(body.tours[0]).toMatchObject({ id: STUDIO_ID, title: "مرکز آموزش", stepCount: 2 });
    expect(mocks.publishedForPage).toHaveBeenCalledWith(BASELINE_PAGE);
  });

  it.each([
    ["cosmetics", STUDIO_ID],
    ["food_service", "accounting.overview.ledger"],
  ])("lists the applicable Accounting Overview tour for %s", async (industry, expectedId) => {
    const pageKey = "page:/accounting/overview";
    mocks.industry.mockResolvedValue(industry);
    mocks.requireMember.mockResolvedValue(member([PERMISSIONS.ledgerView]));
    mocks.publishedForPage.mockResolvedValue([{
      ...studio,
      pageKey,
      route: "/accounting/overview",
      eligibility: { industries: ["cosmetics"] },
    }]);

    const res = await listTours(req(`/api/knowledge/tours?page=${encodeURIComponent(pageKey)}`));
    const body = await res.json();
    expect(body.tours.map((tour: { id: string }) => tour.id)).toEqual([expectedId]);
    expect(mocks.loadProgress).toHaveBeenCalledWith("biz-1", "user-1", [expectedId]);
  });

  it.each([
    ["cosmetics", STUDIO_ID],
    ["food_service", "accounting.pos.order-ticket"],
  ])("lists the applicable POS tour for %s", async (industry, expectedId) => {
    const pageKey = "page:/accounting/pos";
    mocks.industry.mockResolvedValue(industry);
    mocks.requireMember.mockResolvedValue(member([PERMISSIONS.ordersCreate, PERMISSIONS.paymentsTake]));
    mocks.publishedForPage.mockResolvedValue([{
      ...studio,
      pageKey,
      route: "/accounting/pos",
      eligibility: { industries: ["cosmetics"] },
    }]);

    const res = await listTours(req(`/api/knowledge/tours?page=${encodeURIComponent(pageKey)}`));
    const body = await res.json();
    expect(body.tours.map((tour: { id: string }) => tour.id)).toEqual([expectedId]);
    expect(mocks.loadProgress).toHaveBeenCalledWith("biz-1", "user-1", [expectedId]);
  });

  it.each([
    ["cosmetics", STUDIO_ID],
    ["food_service", "accounting.products.list"],
  ])("lists the applicable Products tour for %s", async (industry, expectedId) => {
    const pageKey = "page:/accounting/products";
    mocks.industry.mockResolvedValue(industry);
    mocks.requireMember.mockResolvedValue(member([PERMISSIONS.inventoryView]));
    mocks.publishedForPage.mockResolvedValue([{
      ...studio,
      pageKey,
      route: "/accounting/products",
      eligibility: { industries: ["cosmetics"] },
    }]);

    const res = await listTours(req(`/api/knowledge/tours?page=${encodeURIComponent(pageKey)}`));
    const body = await res.json();
    expect(body.tours.map((tour: { id: string }) => tour.id)).toEqual([expectedId]);
  });

  it.each([
    ["cosmetics", STUDIO_ID],
    ["food_service", "accounting.products.new"],
  ])("lists the applicable add-product tour for %s", async (industry, expectedId) => {
    const pageKey = "page:/accounting/products/new";
    mocks.industry.mockResolvedValue(industry);
    mocks.requireMember.mockResolvedValue(member([PERMISSIONS.inventoryAdjust]));
    mocks.publishedForPage.mockResolvedValue([{
      ...studio,
      pageKey,
      route: "/accounting/products/new",
      eligibility: { industries: ["cosmetics"] },
    }]);

    const res = await listTours(req(`/api/knowledge/tours?page=${encodeURIComponent(pageKey)}`));
    const body = await res.json();
    expect(body.tours.map((tour: { id: string }) => tour.id)).toEqual([expectedId]);
  });

  it.each([
    ["cosmetics", STUDIO_ID],
    ["food_service", "accounting.products.prices"],
  ])("lists the applicable product-prices tour for %s", async (industry, expectedId) => {
    const pageKey = "page:/accounting/products/prices";
    mocks.industry.mockResolvedValue(industry);
    mocks.requireMember.mockResolvedValue(member([PERMISSIONS.inventoryView]));
    mocks.publishedForPage.mockResolvedValue([{
      ...studio,
      pageKey,
      route: "/accounting/products/prices",
      eligibility: { industries: ["cosmetics"] },
    }]);

    const res = await listTours(req(`/api/knowledge/tours?page=${encodeURIComponent(pageKey)}`));
    const body = await res.json();
    expect(body.tours.map((tour: { id: string }) => tour.id)).toEqual([expectedId]);
  });

  it.each([
    ["cosmetics", STUDIO_ID],
    ["food_service", "accounting.products.attributes"],
  ])("lists the applicable product-attributes tour for %s", async (industry, expectedId) => {
    const pageKey = "page:/accounting/products/attributes";
    mocks.industry.mockResolvedValue(industry);
    mocks.requireMember.mockResolvedValue(member([PERMISSIONS.inventoryView]));
    mocks.publishedForPage.mockResolvedValue([{
      ...studio,
      pageKey,
      route: "/accounting/products/attributes",
      eligibility: { industries: ["cosmetics"] },
    }]);

    const res = await listTours(req(`/api/knowledge/tours?page=${encodeURIComponent(pageKey)}`));
    const body = await res.json();
    expect(body.tours.map((tour: { id: string }) => tour.id)).toEqual([expectedId]);
  });

  it.each([
    ["cosmetics", STUDIO_ID, ["cosmetics"]],
    ["cosmetics", "accounting.cosmetics.page", ["accessories"]],
  ])("lists the applicable two-tab Cosmetics tour for %s", async (industry, expectedId, studioIndustries) => {
    const pageKey = "page:/accounting/cosmetics";
    mocks.industry.mockResolvedValue(industry);
    mocks.requireMember.mockResolvedValue(member([PERMISSIONS.inventoryView]));
    mocks.publishedForPage.mockResolvedValue([{
      ...studio,
      pageKey,
      route: "/accounting/cosmetics",
      eligibility: { industries: studioIndustries },
    }]);

    const res = await listTours(req(`/api/knowledge/tours?page=${encodeURIComponent(pageKey)}`));
    const body = await res.json();
    expect(body.tours.map((tour: { id: string }) => tour.id)).toEqual([expectedId]);
  });

  it.each([
    ["cosmetics", STUDIO_ID],
    ["accessories", "accounting.products.reports"],
  ])("lists the applicable product-reports tour for %s", async (industry, expectedId) => {
    const pageKey = "page:/accounting/products/reports";
    mocks.industry.mockResolvedValue(industry);
    mocks.requireMember.mockResolvedValue(member([PERMISSIONS.inventoryView]));
    mocks.publishedForPage.mockResolvedValue([{
      ...studio,
      pageKey,
      route: "/accounting/products/reports",
      eligibility: { industries: ["cosmetics"] },
    }]);

    const res = await listTours(req(`/api/knowledge/tours?page=${encodeURIComponent(pageKey)}`));
    const body = await res.json();
    expect(body.tours.map((tour: { id: string }) => tour.id)).toEqual([expectedId]);
  });

  it.each([
    ["cosmetics", STUDIO_ID],
    ["food_service", "accounting.products.barcode-templates"],
  ])("lists the applicable weighted barcode-templates tour for %s", async (industry, expectedId) => {
    const pageKey = "page:/accounting/products/barcode-templates";
    mocks.industry.mockResolvedValue(industry);
    mocks.requireMember.mockResolvedValue(member([PERMISSIONS.inventoryView]));
    mocks.publishedForPage.mockResolvedValue([{
      ...studio,
      pageKey,
      route: "/accounting/products/barcode-templates",
      eligibility: { industries: ["cosmetics"] },
    }]);

    const res = await listTours(req(`/api/knowledge/tours?page=${encodeURIComponent(pageKey)}`));
    const body = await res.json();
    expect(body.tours.map((tour: { id: string }) => tour.id)).toEqual([expectedId]);
  });

  it.each([
    ["eligible Studio tour", ["ledger.view"], STUDIO_ID],
    ["built-in fallback", ["team.manage"], "accounting.directory.page"],
  ])("lists the accounting-directory %s", async (_caseName, studioPermissions, expectedId) => {
    const pageKey = "page:/accounting/directory";
    mocks.industry.mockResolvedValue("cosmetics");
    mocks.requireMember.mockResolvedValue(member([PERMISSIONS.ledgerView]));
    mocks.publishedForPage.mockResolvedValue([{
      ...studio,
      pageKey,
      route: "/accounting/directory",
      eligibility: { permissions: studioPermissions },
    }]);

    const res = await listTours(req(`/api/knowledge/tours?page=${encodeURIComponent(pageKey)}`));
    const body = await res.json();
    expect(body.tours.map((tour: { id: string }) => tour.id)).toEqual([expectedId]);
  });

  it.each([
    ["eligible Studio tour", ["ledger.view"], STUDIO_ID],
    ["built-in fallback", ["team.manage"], "accounting.ledger.page"],
  ])("lists the accounting-ledger %s", async (_caseName, studioPermissions, expectedId) => {
    const pageKey = "page:/accounting/ledger";
    mocks.industry.mockResolvedValue("cosmetics");
    mocks.requireMember.mockResolvedValue(member([PERMISSIONS.ledgerView]));
    mocks.publishedForPage.mockResolvedValue([{
      ...studio,
      pageKey,
      route: "/accounting/ledger",
      eligibility: { permissions: studioPermissions },
    }]);

    const res = await listTours(req(`/api/knowledge/tours?page=${encodeURIComponent(pageKey)}`));
    const body = await res.json();
    expect(body.tours.map((tour: { id: string }) => tour.id)).toEqual([expectedId]);
  });

  it.each([
    ["eligible Studio tour", ["ledger.view"], STUDIO_ID],
    ["built-in fallback", ["team.manage"], "accounting.trial-balance.list"],
  ])("lists the trial-balance %s", async (_caseName, studioPermissions, expectedId) => {
    const pageKey = "page:/accounting/trial-balance";
    mocks.industry.mockResolvedValue("cosmetics");
    mocks.requireMember.mockResolvedValue(member([PERMISSIONS.ledgerView]));
    mocks.publishedForPage.mockResolvedValue([{
      ...studio,
      pageKey,
      route: "/accounting/trial-balance",
      eligibility: { permissions: studioPermissions },
    }]);

    const res = await listTours(req(`/api/knowledge/tours?page=${encodeURIComponent(pageKey)}`));
    const body = await res.json();
    expect(body.tours.map((tour: { id: string }) => tour.id)).toEqual([expectedId]);
  });

  it.each([
    ["eligible Studio tour", ["ledger.view"], STUDIO_ID],
    ["built-in fallback", ["team.manage"], "accounting.entries.list"],
  ])("lists the journal-entries %s", async (_caseName, studioPermissions, expectedId) => {
    const pageKey = "page:/accounting/entries";
    mocks.industry.mockResolvedValue("cosmetics");
    mocks.requireMember.mockResolvedValue(member([PERMISSIONS.ledgerView]));
    mocks.publishedForPage.mockResolvedValue([{
      ...studio,
      pageKey,
      route: "/accounting/entries",
      eligibility: { permissions: studioPermissions },
    }]);

    const res = await listTours(req(`/api/knowledge/tours?page=${encodeURIComponent(pageKey)}`));
    const body = await res.json();
    expect(body.tours.map((tour: { id: string }) => tour.id)).toEqual([expectedId]);
  });

  it.each([
    ["eligible Studio tour", ["ledger.view"], STUDIO_ID],
    ["built-in fallback", ["team.manage"], "accounting.vouchers.list"],
  ])("lists the vouchers %s", async (_caseName, studioPermissions, expectedId) => {
    const pageKey = "page:/accounting/vouchers";
    mocks.industry.mockResolvedValue("cosmetics");
    mocks.requireMember.mockResolvedValue(member([PERMISSIONS.ledgerView]));
    mocks.publishedForPage.mockResolvedValue([{
      ...studio,
      pageKey,
      route: "/accounting/vouchers",
      eligibility: { permissions: studioPermissions },
    }]);

    const res = await listTours(req(`/api/knowledge/tours?page=${encodeURIComponent(pageKey)}`));
    const body = await res.json();
    expect(body.tours.map((tour: { id: string }) => tour.id)).toEqual([expectedId]);
  });

  it.each([
    ["eligible Studio tour", ["ledger.view"], STUDIO_ID],
    ["built-in fallback", ["team.manage"], "accounting.manual.page"],
  ])("lists the manual-entry %s", async (_caseName, studioPermissions, expectedId) => {
    const pageKey = "page:/accounting/manual";
    mocks.industry.mockResolvedValue("cosmetics");
    mocks.requireMember.mockResolvedValue(member([PERMISSIONS.ledgerView]));
    mocks.publishedForPage.mockResolvedValue([{
      ...studio,
      pageKey,
      route: "/accounting/manual",
      eligibility: { permissions: studioPermissions },
    }]);

    const res = await listTours(req(`/api/knowledge/tours?page=${encodeURIComponent(pageKey)}`));
    const body = await res.json();
    expect(body.tours.map((tour: { id: string }) => tour.id)).toEqual([expectedId]);
  });

  it.each([
    ["eligible Studio tour", ["ledger.view"], STUDIO_ID],
    ["built-in fallback", ["team.manage"], "accounting.multicurrency.list"],
  ])("lists the multicurrency %s", async (_caseName, studioPermissions, expectedId) => {
    const pageKey = "page:/accounting/multicurrency";
    mocks.industry.mockResolvedValue("cosmetics");
    mocks.requireMember.mockResolvedValue(member([PERMISSIONS.ledgerView]));
    mocks.publishedForPage.mockResolvedValue([{
      ...studio,
      pageKey,
      route: "/accounting/multicurrency",
      eligibility: { permissions: studioPermissions },
    }]);

    const res = await listTours(req(`/api/knowledge/tours?page=${encodeURIComponent(pageKey)}`));
    const body = await res.json();
    expect(body.tours.map((tour: { id: string }) => tour.id)).toEqual([expectedId]);
  });

  it.each([
    ["eligible Studio tour", ["ledger.view"], STUDIO_ID],
    ["built-in fallback", ["team.manage"], "accounting.chart-of-accounts.list"],
  ])("lists the chart-of-accounts %s", async (_caseName, studioPermissions, expectedId) => {
    const pageKey = "page:/accounting/chart-of-accounts";
    mocks.industry.mockResolvedValue("cosmetics");
    mocks.requireMember.mockResolvedValue(member([PERMISSIONS.ledgerView]));
    mocks.publishedForPage.mockResolvedValue([{
      ...studio,
      pageKey,
      route: "/accounting/chart-of-accounts",
      eligibility: { permissions: studioPermissions },
    }]);

    const res = await listTours(req(`/api/knowledge/tours?page=${encodeURIComponent(pageKey)}`));
    const body = await res.json();
    expect(body.tours.map((tour: { id: string }) => tour.id)).toEqual([expectedId]);
  });

  it.each([
    ["eligible Studio tour", ["ledger.view"], STUDIO_ID],
    ["built-in fallback", ["team.manage"], "accounting.dimensions.list"],
  ])("lists the accounting-dimensions %s", async (_caseName, studioPermissions, expectedId) => {
    const pageKey = "page:/accounting/dimensions";
    mocks.industry.mockResolvedValue("cosmetics");
    mocks.requireMember.mockResolvedValue(member([PERMISSIONS.ledgerView]));
    mocks.publishedForPage.mockResolvedValue([{
      ...studio,
      pageKey,
      route: "/accounting/dimensions",
      eligibility: { permissions: studioPermissions },
    }]);

    const res = await listTours(req(`/api/knowledge/tours?page=${encodeURIComponent(pageKey)}`));
    const body = await res.json();
    expect(body.tours.map((tour: { id: string }) => tour.id)).toEqual([expectedId]);
  });

  it.each([
    ["eligible Studio tour", ["ledger.view"], STUDIO_ID],
    ["built-in fallback", ["team.manage"], "accounting.receivables.walkthrough"],
  ])("lists the receivables %s", async (_caseName, studioPermissions, expectedId) => {
    const pageKey = "page:/accounting/receivables";
    mocks.industry.mockResolvedValue("cosmetics");
    mocks.requireMember.mockResolvedValue(member([PERMISSIONS.ledgerView]));
    mocks.publishedForPage.mockResolvedValue([{
      ...studio,
      pageKey,
      route: "/accounting/receivables",
      eligibility: { permissions: studioPermissions },
    }]);

    const res = await listTours(req(`/api/knowledge/tours?page=${encodeURIComponent(pageKey)}`));
    const body = await res.json();
    expect(body.tours.map((tour: { id: string }) => tour.id)).toEqual([expectedId]);
  });

  it.each([
    ["eligible Studio tour", ["ledger.view"], STUDIO_ID],
    ["built-in fallback", ["team.manage"], "accounting.installments.list"],
  ])("lists the installments %s", async (_caseName, studioPermissions, expectedId) => {
    const pageKey = "page:/accounting/installments";
    mocks.industry.mockResolvedValue("cosmetics");
    mocks.requireMember.mockResolvedValue(member([PERMISSIONS.ledgerView]));
    mocks.publishedForPage.mockResolvedValue([{
      ...studio,
      pageKey,
      route: "/accounting/installments",
      eligibility: { permissions: studioPermissions },
    }]);

    const res = await listTours(req(`/api/knowledge/tours?page=${encodeURIComponent(pageKey)}`));
    const body = await res.json();
    expect(body.tours.map((tour: { id: string }) => tour.id)).toEqual([expectedId]);
  });

  it.each([
    ["eligible Studio tour", ["ledger.view"], STUDIO_ID],
    ["built-in fallback", ["team.manage"], "accounting.cheques.page"],
  ])("lists the cheques %s", async (_caseName, studioPermissions, expectedId) => {
    const pageKey = "page:/accounting/cheques";
    mocks.industry.mockResolvedValue("cosmetics");
    mocks.requireMember.mockResolvedValue(member([PERMISSIONS.ledgerView]));
    mocks.publishedForPage.mockResolvedValue([{
      ...studio,
      pageKey,
      route: "/accounting/cheques",
      eligibility: { permissions: studioPermissions },
    }]);

    const res = await listTours(req(`/api/knowledge/tours?page=${encodeURIComponent(pageKey)}`));
    const body = await res.json();
    expect(body.tours.map((tour: { id: string }) => tour.id)).toEqual([expectedId]);
  });

  it.each([
    ["eligible Studio tour", ["ledger.view"], STUDIO_ID],
    ["built-in fallback", ["team.manage"], "accounting.receipts.list"],
  ])("lists the receipts and payments %s", async (_caseName, studioPermissions, expectedId) => {
    const pageKey = "page:/accounting/receipts";
    mocks.industry.mockResolvedValue("cosmetics");
    mocks.requireMember.mockResolvedValue(member([PERMISSIONS.ledgerView]));
    mocks.publishedForPage.mockResolvedValue([{
      ...studio,
      pageKey,
      route: "/accounting/receipts",
      eligibility: { permissions: studioPermissions },
    }]);

    const res = await listTours(req(`/api/knowledge/tours?page=${encodeURIComponent(pageKey)}`));
    const body = await res.json();
    expect(body.tours.map((tour: { id: string }) => tour.id)).toEqual([expectedId]);
  });

  it.each([
    ["eligible Studio tour", ["ledger.view"], STUDIO_ID],
    ["built-in fallback", ["team.manage"], "accounting.financial-accounts.page"],
  ])("lists the financial-accounts %s", async (_caseName, studioPermissions, expectedId) => {
    const pageKey = "page:/accounting/financial-accounts";
    mocks.industry.mockResolvedValue("cosmetics");
    mocks.requireMember.mockResolvedValue(member([PERMISSIONS.ledgerView]));
    mocks.publishedForPage.mockResolvedValue([{
      ...studio,
      pageKey,
      route: "/accounting/financial-accounts",
      eligibility: { permissions: studioPermissions },
    }]);

    const res = await listTours(req(`/api/knowledge/tours?page=${encodeURIComponent(pageKey)}`));
    const body = await res.json();
    expect(body.tours.map((tour: { id: string }) => tour.id)).toEqual([expectedId]);
  });

  it.each([
    ["eligible Studio tour", ["ledger.view"], STUDIO_ID],
    ["built-in fallback", ["team.manage"], "accounting.transfers.page"],
  ])("lists the transfers %s", async (_caseName, studioPermissions, expectedId) => {
    const pageKey = "page:/accounting/transfers";
    mocks.industry.mockResolvedValue("cosmetics");
    mocks.requireMember.mockResolvedValue(member([PERMISSIONS.ledgerView]));
    mocks.publishedForPage.mockResolvedValue([{
      ...studio,
      pageKey,
      route: "/accounting/transfers",
      eligibility: { permissions: studioPermissions },
    }]);

    const res = await listTours(req(`/api/knowledge/tours?page=${encodeURIComponent(pageKey)}`));
    const body = await res.json();
    expect(body.tours.map((tour: { id: string }) => tour.id)).toEqual([expectedId]);
  });

  it.each([
    ["eligible Studio tour", ["ledger.view"], STUDIO_ID],
    ["built-in fallback", ["team.manage"], "accounting.expenses.list"],
  ])("lists the expenses %s", async (_caseName, studioPermissions, expectedId) => {
    const pageKey = "page:/accounting/expenses";
    mocks.industry.mockResolvedValue("cosmetics");
    mocks.requireMember.mockResolvedValue(member([PERMISSIONS.ledgerView]));
    mocks.publishedForPage.mockResolvedValue([{
      ...studio,
      pageKey,
      route: "/accounting/expenses",
      eligibility: { permissions: studioPermissions },
    }]);

    const res = await listTours(req(`/api/knowledge/tours?page=${encodeURIComponent(pageKey)}`));
    const body = await res.json();
    expect(body.tours.map((tour: { id: string }) => tour.id)).toEqual([expectedId]);
  });

  it.each([
    ["eligible Studio tour", ["ledger.view"], STUDIO_ID],
    ["built-in fallback", ["team.manage"], "accounting.reconciliation.list"],
  ])("lists the reconciliation %s", async (_caseName, studioPermissions, expectedId) => {
    const pageKey = "page:/accounting/reconciliation";
    mocks.industry.mockResolvedValue("cosmetics");
    mocks.requireMember.mockResolvedValue(member([PERMISSIONS.ledgerView]));
    mocks.publishedForPage.mockResolvedValue([{
      ...studio,
      pageKey,
      route: "/accounting/reconciliation",
      eligibility: { permissions: studioPermissions },
    }]);

    const res = await listTours(req(`/api/knowledge/tours?page=${encodeURIComponent(pageKey)}`));
    const body = await res.json();
    expect(body.tours.map((tour: { id: string }) => tour.id)).toEqual([expectedId]);
  });

  it.each([
    ["eligible Studio tour", ["ledger.view"], STUDIO_ID],
    ["built-in fallback", ["team.manage"], "accounting.fixed-assets.list"],
  ])("lists the fixed-assets %s", async (_caseName, studioPermissions, expectedId) => {
    const pageKey = "page:/accounting/fixed-assets";
    mocks.industry.mockResolvedValue("cosmetics");
    mocks.requireMember.mockResolvedValue(member([PERMISSIONS.ledgerView]));
    mocks.publishedForPage.mockResolvedValue([{
      ...studio,
      pageKey,
      route: "/accounting/fixed-assets",
      eligibility: { permissions: studioPermissions },
    }]);

    const res = await listTours(req(`/api/knowledge/tours?page=${encodeURIComponent(pageKey)}`));
    const body = await res.json();
    expect(body.tours.map((tour: { id: string }) => tour.id)).toEqual([expectedId]);
  });

  it.each([
    ["eligible Studio tour", ["shareholders.view"], ["shareholders.view", "ledger.view"], STUDIO_ID],
    ["built-in fallback", ["shareholders.view"], ["ledger.view"], "accounting.shareholders.list"],
  ])("lists the shareholders %s", async (_caseName, studioPermissions, memberPermissions, expectedId) => {
    const pageKey = "page:/accounting/shareholders";
    mocks.industry.mockResolvedValue("cosmetics");
    mocks.requireMember.mockResolvedValue(member(memberPermissions));
    mocks.publishedForPage.mockResolvedValue([{
      ...studio,
      pageKey,
      route: "/accounting/shareholders",
      eligibility: { permissions: studioPermissions },
    }]);

    const res = await listTours(req(`/api/knowledge/tours?page=${encodeURIComponent(pageKey)}`));
    const body = await res.json();
    expect(body.tours.map((tour: { id: string }) => tour.id)).toEqual([expectedId]);
  });

  it.each([
    ["eligible Studio tour", ["ledger.view"], STUDIO_ID],
    ["built-in fallback", ["team.manage"], "accounting.fiscal-periods.list"],
  ])("lists the fiscal-periods %s", async (_caseName, studioPermissions, expectedId) => {
    const pageKey = "page:/accounting/fiscal-periods";
    mocks.industry.mockResolvedValue("cosmetics");
    mocks.requireMember.mockResolvedValue(member([PERMISSIONS.ledgerView]));
    mocks.publishedForPage.mockResolvedValue([{
      ...studio,
      pageKey,
      route: "/accounting/fiscal-periods",
      eligibility: { permissions: studioPermissions },
    }]);

    const res = await listTours(req(`/api/knowledge/tours?page=${encodeURIComponent(pageKey)}`));
    const body = await res.json();
    expect(body.tours.map((tour: { id: string }) => tour.id)).toEqual([expectedId]);
  });

  it.each([
    ["eligible Studio tour", ["ledger.view"], STUDIO_ID],
    ["built-in fallback", ["team.manage"], "accounting.vat.page"],
  ])("lists the VAT-report %s", async (_caseName, studioPermissions, expectedId) => {
    const pageKey = "page:/accounting/vat";
    mocks.industry.mockResolvedValue("cosmetics");
    mocks.requireMember.mockResolvedValue(member([PERMISSIONS.ledgerView]));
    mocks.publishedForPage.mockResolvedValue([{
      ...studio,
      pageKey,
      route: "/accounting/vat",
      eligibility: { permissions: studioPermissions },
    }]);

    const res = await listTours(req(`/api/knowledge/tours?page=${encodeURIComponent(pageKey)}`));
    const body = await res.json();
    expect(body.tours.map((tour: { id: string }) => tour.id)).toEqual([expectedId]);
  });

  it.each([
    ["eligible Studio tour", ["payroll.view"], STUDIO_ID],
    ["built-in fallback", ["team.manage"], "accounting.payroll.list"],
  ])("lists the payroll %s", async (_caseName, studioPermissions, expectedId) => {
    const pageKey = "page:/accounting/payroll";
    mocks.industry.mockResolvedValue("cosmetics");
    mocks.requireMember.mockResolvedValue(member([PERMISSIONS.payrollView]));
    mocks.publishedForPage.mockResolvedValue([{
      ...studio,
      pageKey,
      route: "/accounting/payroll",
      eligibility: { permissions: studioPermissions },
    }]);

    const res = await listTours(req(`/api/knowledge/tours?page=${encodeURIComponent(pageKey)}`));
    const body = await res.json();
    expect(body.tours.map((tour: { id: string }) => tour.id)).toEqual([expectedId]);
  });

  it.each([
    ["eligible Studio tour", ["ledger.view", "reports.view"], STUDIO_ID],
    ["built-in fallback", ["team.manage"], "accounting.financial-reports.page"],
  ])("lists the financial-reports %s", async (_caseName, studioPermissions, expectedId) => {
    const pageKey = "page:/accounting/financial-reports";
    mocks.industry.mockResolvedValue("cosmetics");
    mocks.requireMember.mockResolvedValue(member([PERMISSIONS.ledgerView, PERMISSIONS.reportsView]));
    mocks.publishedForPage.mockResolvedValue([{
      ...studio,
      pageKey,
      route: "/accounting/financial-reports",
      eligibility: { permissions: studioPermissions },
    }]);

    const res = await listTours(req(`/api/knowledge/tours?page=${encodeURIComponent(pageKey)}`));
    const body = await res.json();
    expect(body.tours.map((tour: { id: string }) => tour.id)).toEqual([expectedId]);
  });

  it.each([
    ["eligible Studio tour", [PERMISSIONS.reportsView], STUDIO_ID],
    ["built-in fallback", [PERMISSIONS.reportsManage], "accounting.reports.page"],
  ])("lists the business-reports %s without duplicating the legacy tour", async (_caseName, studioPermissions, expectedId) => {
    const pageKey = "page:/accounting/reports";
    mocks.industry.mockResolvedValue("cosmetics");
    mocks.requireMember.mockResolvedValue(member([PERMISSIONS.reportsView]));
    mocks.publishedForPage.mockResolvedValue([{
      ...studio,
      pageKey,
      route: "/accounting/reports",
      eligibility: { permissions: studioPermissions },
    }]);

    const res = await listTours(req(`/api/knowledge/tours?page=${encodeURIComponent(pageKey)}`));
    const body = await res.json();
    expect(body.tours.map((tour: { id: string }) => tour.id)).toEqual([expectedId]);
    expect(mocks.loadProgress).toHaveBeenCalledWith("biz-1", "user-1", [expectedId]);
  });

  it("plays a published tour back and records its progress", async () => {
    mocks.publishedById.mockResolvedValue(studio);
    const res = await getTour(req(`/api/knowledge/tours/${STUDIO_ID}`), ctx(STUDIO_ID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tour.id).toBe(STUDIO_ID);
    expect(body.tour.steps).toHaveLength(2);

    const write = await postProgress(
      req(`/api/knowledge/tours/${STUDIO_ID}/progress`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event: "start" }),
      }),
      ctx(STUDIO_ID),
    );
    expect(write.status).toBe(200);
    expect(mocks.record).toHaveBeenCalledWith("biz-1", "user-1", expect.objectContaining({ id: STUDIO_ID }), {
      type: "start",
    });
  });

  it("still answers when the console catalogue cannot be read", async () => {
    // The button must not break because the database is unavailable: the code
    // catalogue and the baseline are the fallback.
    mocks.publishedForPage.mockRejectedValue(new Error("database down"));
    mocks.publishedById.mockRejectedValue(new Error("database down"));
    const list = await listTours(req(`/api/knowledge/tours?page=${encodeURIComponent(PAGE)}`));
    expect((await list.json()).tours).toHaveLength(1);
    const play = await getTour(req(`/api/knowledge/tours/${TOUR}`), ctx(TOUR));
    expect(play.status).toBe(200);
  });

  it("never serves a draft: an unpublished id is indistinguishable from an unknown one", async () => {
    mocks.publishedById.mockResolvedValue(null);
    const res = await getTour(req(`/api/knowledge/tours/${STUDIO_ID}`), ctx(STUDIO_ID));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});

describe("GET /api/knowledge/tours/[tourId]", () => {
  it("returns the steps and the resume point to an eligible member", async () => {
    const res = await getTour(req(`/api/knowledge/tours/${TOUR}`), ctx(TOUR));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.tour.steps.length).toBe(5);
    expect(body.progress.status).toBe("not_started");
  });

  it("plays back a baseline tour, and refuses one for a page the authored catalogue owns", async () => {
    const res = await getTour(req(`/api/knowledge/tours/${BASELINE_TOUR}`), ctx(BASELINE_TOUR));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.tour.id).toBe(BASELINE_TOUR);
    expect(body.tour.steps.length).toBe(4);
    expect(body.progress.status).toBe("not_started");
    // The baseline's page header is still a real step; this page has no
    // section rail, so the header is its only declared region.

    const shadowed = baselineTourIdForRoute("/accounting/products");
    const refused = await getTour(req(`/api/knowledge/tours/${shadowed}`), ctx(shadowed));
    expect(refused.status).toBe(404);
  });

  it("answers an ineligible and an unknown tour identically", async () => {
    mocks.requireMember.mockResolvedValue(member([]));
    const ineligible = await getTour(req(`/api/knowledge/tours/${TOUR}`), ctx(TOUR));
    const unknown = await getTour(req("/api/knowledge/tours/nope"), ctx("nope"));
    expect(ineligible.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await ineligible.json()).toEqual(await unknown.json());
  });
});

describe("POST /api/knowledge/tours/[tourId]/progress", () => {
  it("records a known event for the caller's own row", async () => {
    const res = await postProgress(post({ event: "step_seen", stepId: "welcome" }), ctx(TOUR));
    expect(res.status).toBe(200);
    expect(mocks.record).toHaveBeenCalledWith("biz-1", "user-1", expect.objectContaining({ id: TOUR }), {
      type: "step_seen",
      stepId: "welcome",
    });
  });

  it("re-checks eligibility on every write", async () => {
    mocks.requireMember.mockResolvedValue(member([]));
    const res = await postProgress(post({ event: "start" }), ctx(TOUR));
    expect(res.status).toBe(404);
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("refuses any event it does not know, and any claim of business success", async () => {
    for (const body of [{ event: "verified" }, { event: "action_succeeded", stepId: "table" }, {}, "not json", { event: 7 }]) {
      const res = await postProgress(post(body), ctx(TOUR));
      expect(res.status).toBe(400);
    }
    expect((await postProgress(post({ event: "step_seen" }), ctx(TOUR))).status).toBe(400);
    expect((await postProgress(post({ event: "pause", stepId: "x".repeat(65) }), ctx(TOUR))).status).toBe(400);
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("passes only the typed event on, never extra client fields", async () => {
    await postProgress(post({ event: "start", completed: true, stepId: "table" }), ctx(TOUR));
    expect(mocks.record.mock.calls[0][3]).toEqual({ type: "start" });
  });

  it("maps a service refusal to a status the client can act on", async () => {
    mocks.record.mockResolvedValueOnce({ ok: false, error: "unknown_step" });
    expect((await postProgress(post({ event: "step_seen", stepId: "zzz" }), ctx(TOUR))).status).toBe(400);
    mocks.record.mockResolvedValueOnce({ ok: false, error: "steps_unseen" });
    expect((await postProgress(post({ event: "complete" }), ctx(TOUR))).status).toBe(409);
  });
});
