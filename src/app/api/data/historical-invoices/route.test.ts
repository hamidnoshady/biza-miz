import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), owner: vi.fn(), entity: vi.fn(), location: vi.fn(), activation: vi.fn(), availability: vi.fn(), module: vi.fn(), feature: vi.fn(), preview: vi.fn(), review: vi.fn(), confirm: vi.fn() }));
vi.mock("@/lib/auth", () => ({ withTenantScope: (handler: unknown) => handler, requirePermissions: mocks.auth }));
vi.mock("../guard", async () => {
  const { PERMISSIONS } = await import("@/lib/permissions");
  return { PERMISSIONS, dataOwner: mocks.owner, entityAccess: mocks.entity };
});
vi.mock("@/lib/setup-state", () => ({ resolveActiveLocation: mocks.location }));
vi.mock("@/lib/app-availability-service", () => ({ isAppAvailable: mocks.availability }));
vi.mock("@/lib/industry-guard", () => ({ isModuleEnabled: mocks.module }));
vi.mock("@/lib/features", () => ({ isFeatureEnabled: mocks.feature }));
vi.mock("@/lib/service-activation/app-gate-service", () => ({ serviceActivationState: mocks.activation }));
vi.mock("@/lib/data-transfer/historical-invoice-job-preview", () => ({ previewHistoricalImportJob: mocks.preview }));
vi.mock("@/lib/data-transfer/historical-invoice-archive-service", () => ({
  HistoricalArchiveError: class extends Error { constructor(readonly code: string) { super(code); } },
  previewHistoricalCustomerReview: mocks.review, confirmHistoricalCustomerReview: mocks.confirm,
}));
import { POST } from "./route";
import { HistoricalArchiveError } from "@/lib/data-transfer/historical-invoice-archive-service";

const jobId = "8a86d451-f018-4bc9-bcb1-e04bcd96c91c";
const partyId = "50d5410a-3b65-4aaa-a300-0349d4d77d94";
const job = { jobId, sourceKey: "old-shop", provider: "generic", currency: "rial", calendar: "jalali",
  mapping: { columns: [{ field: "externalInvoiceId", column: 0 }] } };
function request(body: unknown) { return new NextRequest("http://localhost/api/data/historical-invoices", { method: "POST", body: JSON.stringify(body) }); }

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ session: { businessId: "tenant", sub: "user", fullName: "Owner" }, error: null });
  mocks.owner.mockResolvedValue({ owner: { businessId: "tenant", session: { businessId: "tenant", sub: "user", fullName: "Owner" } }, error: null });
  mocks.entity.mockResolvedValue({ entity: {}, error: null });
  mocks.location.mockResolvedValue({ id: "active-branch" });
  mocks.activation.mockResolvedValue(null);
  mocks.availability.mockResolvedValue(true);
  mocks.module.mockResolvedValue(true);
  mocks.feature.mockResolvedValue(true);
  mocks.preview.mockResolvedValue({ crossSourceChecked: false });
  mocks.review.mockResolvedValue({ reviewToken: "a".repeat(64) });
  mocks.confirm.mockResolvedValue("created");
});

describe("historical invoice review API", () => {
  it("requires all transfer, accounting and customer permissions", async () => {
    mocks.auth.mockResolvedValueOnce({ error: NextResponse.json({ error: "forbidden" }, { status: 403 }) });
    expect((await POST(request({ action: "preview", ...job }))).status).toBe(403);
    expect(mocks.owner).toHaveBeenCalledWith("data.import");
    expect(mocks.entity).toHaveBeenCalledWith(expect.anything(), "crm.customers", "import");
    expect(mocks.auth).toHaveBeenCalledWith("orders.view", "parties.view", "parties.manage");
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.activation).not.toHaveBeenCalled();
  });
  it("enforces the transfer and CRM registry gates on each request", async () => {
    mocks.owner.mockResolvedValueOnce({ owner: null, error: NextResponse.json({ error: "forbidden" }, { status: 403 }) });
    expect((await POST(request({ action: "preview", ...job }))).status).toBe(403);
    expect(mocks.entity).not.toHaveBeenCalled();
    mocks.entity.mockResolvedValueOnce({ entity: null, error: NextResponse.json({ error: "forbidden" }, { status: 403 }) });
    expect((await POST(request({ action: "preview", ...job }))).status).toBe(403);
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
  it("requires the active branch and both app activations, failing closed on lookup errors", async () => {
    mocks.location.mockResolvedValueOnce(null);
    expect((await POST(request({ action: "preview", ...job }))).status).toBe(409);
    mocks.activation.mockResolvedValueOnce("disabled_retained");
    expect((await POST(request({ action: "preview", ...job }))).status).toBe(403);
    mocks.activation.mockResolvedValueOnce(null).mockResolvedValueOnce("disabled_retained");
    expect((await POST(request({ action: "preview", ...job }))).status).toBe(403);
    mocks.activation.mockRejectedValueOnce(new Error("database unavailable"));
    expect((await POST(request({ action: "preview", ...job }))).status).toBe(503);
    mocks.availability.mockResolvedValueOnce(false);
    expect((await POST(request({ action: "preview", ...job }))).status).toBe(503);
    mocks.module.mockResolvedValueOnce(false);
    expect((await POST(request({ action: "preview", ...job }))).status).toBe(403);
    mocks.feature.mockResolvedValueOnce(false);
    expect((await POST(request({ action: "preview", ...job }))).status).toBe(403);
    expect(mocks.preview).not.toHaveBeenCalled();
  });
  it("uses tenant and branch from the session and returns no-store previews", async () => {
    const res = await POST(request({ action: "preview", ...job, sampleLimit: 20, documentOffset: 10 }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ executionAvailable: false, preview: { crossSourceChecked: false } });
    expect(mocks.preview).toHaveBeenCalledWith({ ...job, sampleLimit: 20, documentOffset: 10, businessId: "tenant", locationId: "active-branch" });
    expect(mocks.activation.mock.calls).toEqual([["tenant", "app", "accounting"], ["tenant", "app", "crm"]]);
    expect(mocks.module.mock.calls).toEqual([["tenant", "ledger"], ["tenant", "crm"]]);
  });
  it("rejects scope spoofing, unsafe mappings, oversized bodies and archive actions", async () => {
    for (const body of [
      { action: "preview", ...job, businessId: "other" },
      { action: "preview", ...job, locationId: "other" },
      { action: "preview", ...job, mapping: { columns: [{ field: "total", column: 0, constant: "1" }] } },
      { action: "preview", ...job, mapping: { columns: [{ field: "total", column: 0, transform: "number" }] } },
      { action: "run", ...job }, { action: "confirm-customer", ...job, externalCustomerCode: "c", partyId, reviewToken: "a".repeat(64), confirmed: false },
    ]) expect((await POST(request(body))).status).toBe(400);
    expect((await POST(request({ action: "preview", ...job, oversized: "x".repeat(40_000) }))).status).toBe(413);
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.review).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
  it("reviews and confirms only the selected customer, with actor from the session", async () => {
    const evidence = { ...job, externalCustomerCode: "c", partyId };
    const review = await POST(request({ action: "review-customer", ...evidence }));
    expect(review.status).toBe(200);
    expect(mocks.review).toHaveBeenCalledWith({ ...evidence, businessId: "tenant", locationId: "active-branch" });
    const confirmed = await POST(request({ action: "confirm-customer", ...evidence, reviewToken: "a".repeat(64), confirmed: true }));
    expect(confirmed.status).toBe(200);
    expect(mocks.confirm).toHaveBeenCalledWith({ ...evidence, businessId: "tenant", locationId: "active-branch",
      reviewToken: "a".repeat(64), confirmed: true, actor: { userId: "user", name: "Owner" } });
  });
  it("maps conflicts and inaccessible jobs without returning exception details", async () => {
    mocks.confirm.mockRejectedValueOnce(new HistoricalArchiveError("customer_review_stale"));
    const res = await POST(request({ action: "confirm-customer", ...job, externalCustomerCode: "c", partyId, reviewToken: "a".repeat(64), confirmed: true }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "customer_review_stale" });
  });
});
