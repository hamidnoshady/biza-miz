// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CampaignReports } from "./campaign-reports";
vi.mock("@/app/dashboard/jalali-date-picker", () => ({
  JalaliDatePicker: ({
    value,
    onChange,
    ariaLabel,
    disabled,
  }: {
    value: string;
    onChange: (s: string) => void;
    ariaLabel: string;
    disabled: boolean;
  }) => (
    <input
      aria-label={ariaLabel}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));
const report = (extra: Record<string, unknown> = {}) => ({
  id: "report",
  periodStart: "2026-10-01",
  periodEnd: "2026-10-07",
  evidenceReference: "source.csv",
  attributionNote: "تطبیق دوره‌ای",
  attributionConfirmed: false,
  spendRial: 1000,
  reach: null,
  campaignBudgetRial: 5000,
  impressions: 100,
  clicks: 10,
  leadsGenerated: 5,
  conversions: 2,
  revenueRial: null,
  supersedesId: null,
  createdAt: "2026-10-08T12:00:00Z",
  createdByName: "مدیر",
  superseded: false,
  metrics: { ctrPct: 10, cplRial: null, cpaRial: null, roas: null },
  ...extra,
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("period campaign reporting screen", () => {
  it("labels uncertainty, unknown revenue and reach without displaying fabricated ratios or write controls", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ reports: [report()], canWrite: false }),
            { status: 200 },
          ),
      ),
    );
    render(<CampaignReports campaignId="campaign" />);
    await screen.findByText(/انتساب نامطمئن/);
    expect(
      screen.queryByRole("button", { name: "ثبت نسخهٔ غیرقابل‌ویرایش گزارش" }),
    ).toBeNull();
    expect(screen.getByText("ROAS").parentElement?.textContent).toContain("—");
    const link = screen.getByRole("link", {
      name: "دریافت نسخهٔ JSON همین گزارش",
    });
    expect(decodeURIComponent(link.getAttribute("href") ?? "")).toContain(
      '"evidenceReference": "source.csv"',
    );
    expect(screen.getByText(/اتصال تبلیغاتی خودکار نیست/)).toBeTruthy();
  });
  it("imports explicit integer-rial JSON with period/evidence, never silently attesting attribution", async () => {
    const writes: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          writes.push(JSON.parse(String(init.body)));
          return new Response(JSON.stringify({ report: { id: "r" } }), {
            status: 201,
          });
        }
        return new Response(JSON.stringify({ reports: [], canWrite: true }), {
          status: 200,
        });
      }),
    );
    render(<CampaignReports campaignId="campaign" />);
    await screen.findByRole("button", {
      name: "ثبت نسخهٔ غیرقابل‌ویرایش گزارش",
    });
    fireEvent.change(screen.getByLabelText("آغاز دورهٔ گزارش"), {
      target: { value: "2026-10-01" },
    });
    fireEvent.change(screen.getByLabelText("پایان دورهٔ گزارش"), {
      target: { value: "2026-10-07" },
    });
    fireEvent.change(screen.getByLabelText("شناسهٔ منبع یا فایل خروجی"), {
      target: { value: "export.csv" },
    });
    fireEvent.change(
      screen.getByLabelText("روش انتساب، محدودیت و تطبیق منبع"),
      { target: { value: "منبع تطبیق داده نشده" } },
    );
    const measurements = {
      spendRial: 1000,
      impressions: 100,
      clicks: 10,
      leadsGenerated: 5,
      conversions: 2,
      revenueRial: null,
    };
    fireEvent.change(screen.getByLabelText(/دادهٔ اندازه‌گیری JSON/), {
      target: { value: JSON.stringify(measurements) },
    });
    await userEvent.click(
      screen.getByRole("button", { name: "ثبت نسخهٔ غیرقابل‌ویرایش گزارش" }),
    );
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({
      ...measurements,
      periodStart: "2026-10-01",
      periodEnd: "2026-10-07",
      evidenceReference: "export.csv",
      attributionNote: "منبع تطبیق داده نشده",
      attributionConfirmed: false,
      supersedesId: null,
    });
  });
  it("corrects the same period without deleting history or carrying an old attestation into a new version", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              reports: [report({ attributionConfirmed: true })],
              canWrite: true,
            }),
            { status: 200 },
          ),
      ),
    );
    render(<CampaignReports campaignId="campaign" />);
    await userEvent.click(
      await screen.findByRole("button", {
        name: "اصلاح همین دوره با حفظ نسخهٔ قبلی",
      }),
    );
    expect(
      (screen.getByLabelText("آغاز دورهٔ گزارش") as HTMLInputElement).disabled,
    ).toBe(true);
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(
      false,
    );
    expect(
      screen.getByText("ثبت اصلاحیه؛ نسخهٔ قبلی حذف نمی‌شود"),
    ).toBeTruthy();
  });
  it("keeps a refused correction visible rather than reporting a successful import", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_url: string, init?: RequestInit) =>
          new Response(
            JSON.stringify(
              init?.method === "POST"
                ? { error: "report_conflict" }
                : { reports: [report()], canWrite: true },
            ),
            { status: init?.method === "POST" ? 409 : 200 },
          ),
      ),
    );
    render(<CampaignReports campaignId="campaign" />);
    await userEvent.click(
      await screen.findByRole("button", {
        name: "اصلاح همین دوره با حفظ نسخهٔ قبلی",
      }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "ثبت نسخهٔ غیرقابل‌ویرایش گزارش" }),
    );
    await screen.findByText(/گزارش ثبت نشد/);
    expect(
      screen.getByText("ثبت اصلاحیه؛ نسخهٔ قبلی حذف نمی‌شود"),
    ).toBeTruthy();
  });
});
