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
  measurementAccessLog: vi.fn(async () => []),
  getRetentionDays: vi.fn(async () => 730),
  setRetentionDays: vi.fn(async () => ({ retentionDays: 365 })),
  purgeExpiredMeasurements: vi.fn(async () => ({ eligible: 0, purged: 0 })),
}));

vi.mock("@/lib/auth", () => ({
  withTenantScope: (handler: unknown) => handler,
  requirePermissions: mocks.requirePermissions,
}));
vi.mock("@/lib/industry-guard", () => ({ getBusinessIndustry: mocks.industry }));
vi.mock("@/lib/tailoring-service", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tailoring-service")>("@/lib/tailoring-service");
  return { ...actual, viewMeasurements: mocks.viewMeasurements, recordMeasurements: mocks.recordMeasurements,
    exportMeasurements: mocks.exportMeasurements, eraseMeasurements: mocks.eraseMeasurements,
    measurementAccessLog: mocks.measurementAccessLog, getRetentionDays: mocks.getRetentionDays,
    setRetentionDays: mocks.setRetentionDays, purgeExpiredMeasurements: mocks.purgeExpiredMeasurements };
});

import { DELETE, GET, POST } from "./route";

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
    let res = await GET(new NextRequest(`https://app.test/api/tailoring/measurements?view=export&partyId=${PARTY}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="measurements-${PARTY}.json"`);
    expect(mocks.requirePermissions).toHaveBeenLastCalledWith("tailoring.measurements", "crm.export");
    expect(mocks.exportMeasurements).toHaveBeenCalledTimes(1);
    expect(mocks.viewMeasurements).not.toHaveBeenCalled();
    res = await DELETE(new NextRequest("https://app.test/api/tailoring/measurements", {
      method: "DELETE", body: JSON.stringify({ partyId: PARTY, reason: "درخواست مشتری" }) }));
    expect(res.status).toBe(400);
    expect(mocks.eraseMeasurements).not.toHaveBeenCalled();
    res = await DELETE(new NextRequest("https://app.test/api/tailoring/measurements", {
      method: "DELETE", body: JSON.stringify({ partyId: PARTY, reason: "درخواست مشتری", confirm: true }) }));
    expect(res.status).toBe(200);
    expect(mocks.requirePermissions).toHaveBeenLastCalledWith("tailoring.measurements", "crm.delete");
    expect(mocks.eraseMeasurements).toHaveBeenCalledWith({ businessId: "biz", userId: "u1", name: "خیاط" }, PARTY, "درخواست مشتری");
  });

  it("the access log needs only tailoring.measurements, no purpose, and never decrypts", async () => {
    const res = await GET(new NextRequest(`https://app.test/api/tailoring/measurements?view=log&partyId=${PARTY}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ entries: [] });
    expect(mocks.requirePermissions).toHaveBeenLastCalledWith("tailoring.measurements");
    expect(mocks.viewMeasurements).not.toHaveBeenCalled();
    expect(mocks.exportMeasurements).not.toHaveBeenCalled();
  });

  it("an unknown view is refused before any permission check or service call", async () => {
    const res = await GET(new NextRequest(`https://app.test/api/tailoring/measurements?view=values&partyId=${PARTY}&purpose=test`));
    expect(res.status).toBe(400);
    expect(mocks.requirePermissions).not.toHaveBeenCalled();
    expect(mocks.viewMeasurements).not.toHaveBeenCalled();
  });

  it("retention (read + dry run, set, purge) also needs settings.manage; purge needs confirm", async () => {
    let res = await GET(new NextRequest("https://app.test/api/tailoring/measurements?view=retention"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ retentionDays: 730, preview: { eligible: 0, purged: 0 } });
    expect(mocks.requirePermissions).toHaveBeenLastCalledWith("tailoring.measurements", "settings.manage");
    expect(mocks.purgeExpiredMeasurements).toHaveBeenLastCalledWith(expect.anything(), { apply: false });
    res = await POST(new NextRequest("https://app.test/api/tailoring/measurements?view=retention", {
      method: "POST", body: JSON.stringify({ action: "set", days: 365 }) }));
    expect(res.status).toBe(200);
    expect(mocks.setRetentionDays).toHaveBeenCalledWith(expect.anything(), 365);
    expect(mocks.requirePermissions).toHaveBeenLastCalledWith("tailoring.measurements", "settings.manage");
    res = await POST(new NextRequest("https://app.test/api/tailoring/measurements?view=retention", {
      method: "POST", body: JSON.stringify({ action: "purge" }) }));
    expect(res.status).toBe(400);
    res = await POST(new NextRequest("https://app.test/api/tailoring/measurements?view=retention", {
      method: "POST", body: JSON.stringify({ action: "purge", confirm: true }) }));
    expect(res.status).toBe(200);
    expect(mocks.purgeExpiredMeasurements).toHaveBeenLastCalledWith(expect.anything(), { apply: true });
    expect(mocks.recordMeasurements).not.toHaveBeenCalled();
  });

  it("a retention command is never read as a measurement record, nor a record as a retention command", async () => {
    let res = await POST(new NextRequest("https://app.test/api/tailoring/measurements", {
      method: "POST", body: JSON.stringify({ action: "purge", confirm: true }) }));
    expect(res.status).toBe(400);
    res = await POST(new NextRequest("https://app.test/api/tailoring/measurements?view=retention", {
      method: "POST", body: JSON.stringify({ partyId: PARTY, measurements: { unit: "cm", values: {} } }) }));
    expect(res.status).toBe(400);
    res = await POST(new NextRequest("https://app.test/api/tailoring/measurements?view=log", { method: "POST", body: "{}" }));
    expect(res.status).toBe(400);
    expect(mocks.purgeExpiredMeasurements).not.toHaveBeenCalled();
    expect(mocks.recordMeasurements).not.toHaveBeenCalled();
  });
});
