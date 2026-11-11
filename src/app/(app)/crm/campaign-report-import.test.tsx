// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CampaignReportImport } from "./campaign-report-import";
import { CAMPAIGN_IMPORT_FIELDS } from "@/lib/agency-campaign-report-import";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const props = {
  start: "2026-10-01",
  end: "2026-10-07",
  note: "Source reconciliation pending",
};
async function upload(text: string) {
  const file = new File([text], "source.csv", { type: "text/csv" });
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => new TextEncoder().encode(text).buffer,
  });
  await userEvent.upload(screen.getByLabelText("فایل گزارش CSV"), file);
  await screen.findByText(/source.csv — SHA-256/);
}
function cryptoMock() {
  vi.stubGlobal("crypto", {
    subtle: { digest: vi.fn(async () => new Uint8Array(32).fill(1).buffer) },
  });
}
describe("manual CSV report preparation", () => {
  it("requires explicit mapping and preview, prepares one row without posting or attesting", async () => {
    cryptoMock();
    const onPrepared = vi.fn(),
      fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    render(<CampaignReportImport {...props} onPrepared={onPrepared} />);
    await upload(CAMPAIGN_IMPORT_FIELDS.join(",") + "\n100,1000,100,10,5,,0");
    await userEvent.click(
      screen.getByRole("button", { name: "پیش‌نمایش ردیف CSV" }),
    );
    expect(screen.getByText(/واحد پول فایل را صریحاً/)).toBeTruthy();
    expect(onPrepared).not.toHaveBeenCalled();
    for (const field of CAMPAIGN_IMPORT_FIELDS)
      await userEvent.selectOptions(
        screen.getByLabelText(`ستون ${field}`),
        field,
      );
    await userEvent.selectOptions(
      screen.getByLabelText("واحد پول فایل CSV"),
      "toman",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "پیش‌نمایش ردیف CSV" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "انتقال پیش‌نمایش به فرم؛ بدون ثبت" }),
    );
    expect(onPrepared).toHaveBeenCalledWith(
      expect.objectContaining({
        spendRial: 1000,
        revenueRial: 0,
        reach: null,
        attributionConfirmed: false,
        supersedesId: null,
        ...propsToContext(),
      }),
    );
    expect(onPrepared.mock.calls[0][0].evidenceReference).toContain(
      `data row 1; SHA-256 ${"01".repeat(32)}`,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it("invalidates a preview when period/source interpretation changes", async () => {
    cryptoMock();
    const onPrepared = vi.fn();
    const view = render(
      <CampaignReportImport {...props} onPrepared={onPrepared} />,
    );
    await upload(CAMPAIGN_IMPORT_FIELDS.join(",") + "\n100,1000,100,10,5,,");
    for (const field of CAMPAIGN_IMPORT_FIELDS.slice(0, 5))
      await userEvent.selectOptions(
        screen.getByLabelText(`ستون ${field}`),
        field,
      );
    await userEvent.selectOptions(
      screen.getByLabelText("واحد پول فایل CSV"),
      "rial",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "پیش‌نمایش ردیف CSV" }),
    );
    expect(
      screen.getByRole("button", { name: "انتقال پیش‌نمایش به فرم؛ بدون ثبت" }),
    ).toBeTruthy();
    view.rerender(
      <CampaignReportImport
        {...props}
        start="2026-10-02"
        onPrepared={onPrepared}
      />,
    );
    expect(
      screen.queryByRole("button", {
        name: "انتقال پیش‌نمایش به فرم؛ بدون ثبت",
      }),
    ).toBeNull();
    expect(onPrepared).not.toHaveBeenCalled();
  });
  it("refuses malformed file before source preparation", async () => {
    cryptoMock();
    const onPrepared = vi.fn();
    render(<CampaignReportImport {...props} onPrepared={onPrepared} />);
    const file = new File(["a,a\n1,2"], "bad.csv", { type: "text/csv" });
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => new TextEncoder().encode("a,a\n1,2").buffer,
    });
    await userEvent.upload(screen.getByLabelText("فایل گزارش CSV"), file);
    await screen.findByText(/CSV معتبر UTF-8/);
    expect(
      screen.queryByRole("button", { name: "پیش‌نمایش ردیف CSV" }),
    ).toBeNull();
    expect(onPrepared).not.toHaveBeenCalled();
  });
});
function propsToContext() {
  return {
    periodStart: props.start,
    periodEnd: props.end,
    attributionNote: props.note,
  };
}
