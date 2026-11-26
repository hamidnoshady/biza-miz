import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GH #1567 6A — the measurement routes' gates: the exact permission set each
 * route asks for, the fashion-only industry gate, and a stated purpose before
 * anything is decrypted. Service behaviour is covered by
 * integration/tailoring.integration.test.ts.
 */
const mocks = vi.hoisted(() => ({
  requirePermissions: vi.fn(),
  industry: vi.fn(async () => "fashion_apparel"),
  viewMeasurements: vi.fn(async () => ({ current: null, versions: [] })),
  recordMeasurements: vi.fn(async () => ({ version: 1 })),
  exportMeasurements: vi.fn(async () => ({ versions: [] })),
  eraseMeasurements: vi.fn(async () => ({ erased: 1 })),
}));

vi.mock("@/lib/auth", () => ({
  withTenantScope: (handler: unknown) => handler,
  requirePermissions: mocks.requirePermissions,
}));
vi.mock("@/lib/industry-guard", () => ({ getBusinessIndustry: mocks.industry }));
vi.mock("@/lib/tailoring-service", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tailoring-service")>("@/lib/tailoring-service");
  return { ...actual, viewMeasurements: mocks.viewMeasurements, recordMeasurements: mocks.recordMeasurements,
    exportMeasurements: mocks.exportMeasurements, eraseMeasurements: mocks.eraseMeasurements };
});

import { GET, POST } from "./route";
import { GET as EXPORT } from "./export/route";
import { POST as ERASE } from "./erase/route";

const PARTY = "8a86d451-f018-4bc9-bcb1-e04bcd96c91c";
const allow = () => mocks.requirePermissions.mockResolvedValue({ session: { businessId: "biz", sub: "u1", fullName: "خیاط", role: "manager" }, error: null });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.industry.mockResolvedValue("fashion_apparel");
  allow();
});

describe("GH #1567 6A — measurement route gates", () => {
  it("view requires tailoring.measurements and a purpose, and passes the purpose to the logged service call", async () => {
    let res = await GET(new NextRequest(`https://app.test/api/tailoring/measurements?partyId=${PARTY}`));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "tailoring_purpose_required" });
    expect(mocks.viewMeasurements).not.toHaveBeenCalled();
    res = await GET(new NextRequest(`https://app.test/api/tailoring/measurements?partyId=${PARTY}&purpose=${encodeURIComponent("پرو دوم")}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(mocks.requirePermissions).toHaveBeenCalledWith("tailoring.measurements");
    expect(mocks.viewMeasurements).toHaveBeenCalledWith({ businessId: "biz", userId: "u1", name: "خیاط" }, PARTY, "پرو دوم");
  });

  it("a member without the key is refused before any service call", async () => {
    mocks.requirePermissions.mockResolvedValue({ session: null, error: NextResponse.json({ error: "forbidden" }, { status: 403 }) });
    const res = await POST(new NextRequest("https://app.test/api/tailoring/measurements", {
      method: "POST", body: JSON.stringify({ partyId: PARTY, measurements: { unit: "cm", values: { chest: 90 } } }) }));
    expect(res.status).toBe(403);
    expect(mocks.recordMeasurements).not.toHaveBeenCalled();
  });

  it("is closed to other trades", async () => {
    mocks.industry.mockResolvedValue("food_service");
    const res = await GET(new NextRequest(`https://app.test/api/tailoring/measurements?partyId=${PARTY}&purpose=test`));
    expect(res.status).toBe(403);
    expect(mocks.viewMeasurements).not.toHaveBeenCalled();
  });

  it("export also needs crm.export; erase also needs crm.delete and an explicit confirmation", async () => {
    await EXPORT(new NextRequest(`https://app.test/api/tailoring/measurements/export?partyId=${PARTY}`));
    expect(mocks.requirePermissions).toHaveBeenLastCalledWith("tailoring.measurements", "crm.export");
    let res = await ERASE(new NextRequest("https://app.test/api/tailoring/measurements/erase", {
      method: "POST", body: JSON.stringify({ partyId: PARTY, reason: "درخواست مشتری" }) }));
    expect(res.status).toBe(400);
    expect(mocks.eraseMeasurements).not.toHaveBeenCalled();
    res = await ERASE(new NextRequest("https://app.test/api/tailoring/measurements/erase", {
      method: "POST", body: JSON.stringify({ partyId: PARTY, reason: "درخواست مشتری", confirm: true }) }));
    expect(res.status).toBe(200);
    expect(mocks.requirePermissions).toHaveBeenLastCalledWith("tailoring.measurements", "crm.delete");
  });
});
