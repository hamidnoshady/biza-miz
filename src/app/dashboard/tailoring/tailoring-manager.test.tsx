// @vitest-environment jsdom
//
// GH #1567 Phase 6A — the tailoring desk UI.
//   - a job manager without `tailoring.measurements` runs the workflow and
//     never causes a request for body measurements;
//   - the measurements panel requests nothing until a purpose is stated, then
//     shows allow-listed labels with units and the version history;
//   - QC fail sends the rework transition with the job's version (optimistic lock);
//   - a priced job in `ready` cannot be handed over before a sale is linked.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TailoringManager, isOverdue, progressLabel, type TailoringJob, type TailoringPermissions } from "./tailoring-manager";
import { MeasurementsPanel, parseMeasurementInput } from "./measurements-panel";

const PARTY = "11111111-1111-4111-8111-111111111111";
const JOB_ID = "22222222-2222-4222-8222-222222222222";

function job(overrides: Partial<TailoringJob> = {}): TailoringJob {
  return {
    id: JOB_ID, locationId: "loc", partyId: PARTY, partyName: "سارا رضایی", measurementProfileId: null,
    kind: "alteration", description: "کوتاه‌کردن آستین کت", status: "qc", estimateRial: "1500000",
    approvedAt: null, dueDate: "2026-12-01", orderId: null, fittingCount: 1, reworkCount: 0, version: 4,
    createdAt: "2026-11-20T10:00:00Z", updatedAt: "2026-11-21T10:00:00Z", ...overrides,
  };
}

const calls: { url: string; method: string; body: unknown }[] = [];
let currentJob: TailoringJob = job();

beforeEach(() => {
  calls.length = 0;
  currentJob = job();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.startsWith("/api/tailoring/jobs/") && method === "GET") {
      return new Response(JSON.stringify({ job: currentJob, events: [{ id: "1", fromStatus: null, toStatus: "intake", actorName: "مدیر", note: null, at: "2026-11-20T10:00:00Z" }] }));
    }
    if (url.startsWith("/api/tailoring/jobs/") && method === "POST") {
      return new Response(JSON.stringify({ job: { ...currentJob, version: currentJob.version + 1 } }));
    }
    if (url.startsWith("/api/tailoring/jobs")) return new Response(JSON.stringify({ jobs: [currentJob] }));
    if (url.startsWith("/api/tailoring/measurements?")) {
      return new Response(JSON.stringify({
        current: { id: "v2", version: 2, unit: "cm", fieldCount: 2, recordedAt: "2026-11-01T00:00:00Z", supersededAt: null, erasedAt: null,
          measurements: { unit: "cm", values: { chest: 98.5, waist: 84 } } },
        versions: [
          { id: "v2", version: 2, unit: "cm", fieldCount: 2, recordedAt: "2026-11-01T00:00:00Z", supersededAt: null, erasedAt: null },
          { id: "v1", version: 1, unit: "cm", fieldCount: 1, recordedAt: "2026-10-01T00:00:00Z", supersededAt: "2026-11-01T00:00:00Z", erasedAt: null },
        ],
      }));
    }
    return new Response(JSON.stringify({ error: "not_mocked" }), { status: 404 });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const MANAGER_ONLY: TailoringPermissions = {
  canManage: true, canMeasure: false, canExport: false, canErase: false, canRetention: false, canViewOrders: true,
};

describe("tailoring desk (GH #1567 6A)", () => {
  it("a manager without the measurements permission runs the board and never requests measurements", async () => {
    render(<TailoringManager permissions={MANAGER_ONLY} />);
    fireEvent.click(await screen.findByRole("row", { name: /باز کردن سفارش/u }));
    await screen.findByText("مرحلهٔ بعد");
    expect(screen.getAllByText(/فقط برای کاربران دارای دسترسی «اندازه‌های بدن»/u).length).toBeGreaterThan(0);
    expect(screen.queryByText("اندازه‌های مشتری")).toBeNull();
    expect(calls.some((call) => call.url.includes("/api/tailoring/measurements"))).toBe(false);
  });

  it("QC fail sends the rework transition under the job's version", async () => {
    render(<TailoringManager permissions={MANAGER_ONLY} />);
    fireEvent.click(await screen.findByRole("row", { name: /باز کردن سفارش/u }));
    fireEvent.click(await screen.findByRole("button", { name: /رد کنترل کیفیت/u }));
    await waitFor(() => expect(calls.some((call) => call.method === "POST")).toBe(true));
    const post = calls.find((call) => call.method === "POST")!;
    expect(post.url).toBe(`/api/tailoring/jobs/${JOB_ID}`);
    expect(post.body).toMatchObject({ action: "transition", to: "fitting", qcPassed: false, expectedVersion: 4 });
  });

  it("a priced job that is ready cannot be handed over before a sale is linked", async () => {
    currentJob = job({ status: "ready" });
    render(<TailoringManager permissions={MANAGER_ONLY} />);
    fireEvent.click(await screen.findByRole("row", { name: /باز کردن سفارش/u }));
    const handover = await screen.findByRole("button", { name: "تحویل به مشتری" });
    expect((handover as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("پیوند فروش")).toBeTruthy();
  });

  it("the measurements panel fetches nothing until a purpose is given, then shows labels with units and versions", async () => {
    render(<MeasurementsPanel partyId={PARTY} customerName="سارا" canExport={false} canErase={false} />);
    const show = screen.getByRole("button", { name: /نمایش اندازه‌ها/u }) as HTMLButtonElement;
    expect(show.disabled).toBe(true);
    expect(calls).toHaveLength(0);
    fireEvent.change(screen.getByLabelText("دلیل مشاهده"), { target: { value: "پرو" } });
    fireEvent.click(show);
    const table = await screen.findByRole("table", { name: /اندازه‌های فعلی/u });
    expect(within(table).getByText("دور سینه")).toBeTruthy();
    expect(within(table).getByText(/۹۸\.۵ سانتی‌متر/u)).toBeTruthy();
    expect(calls[0].url).toContain("purpose=");
    const history = screen.getByRole("table", { name: "تاریخچهٔ نسخه‌های اندازه" });
    expect(within(history).getByText("نسخهٔ قبلی")).toBeTruthy();
    expect(within(history).getByText("فعلی")).toBeTruthy();
  });

  it("parses typed measurements strictly and computes progress and overdue", () => {
    expect(parseMeasurementInput("۹۸٫۵")).toBe(98.5);
    expect(parseMeasurementInput("")).toBeNull();
    expect(parseMeasurementInput("98.55")).toBe("invalid");
    expect(parseMeasurementInput("-1")).toBe("invalid");
    expect(progressLabel("qc")).toBe("مرحلهٔ ۵ از ۷");
    expect(progressLabel("cancelled")).toBe("—");
    expect(isOverdue({ dueDate: "2026-11-01", status: "fitting" }, "2026-11-25")).toBe(true);
    expect(isOverdue({ dueDate: "2026-11-01", status: "picked_up" }, "2026-11-25")).toBe(false);
  });
});
