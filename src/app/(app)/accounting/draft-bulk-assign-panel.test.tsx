// @vitest-environment jsdom

/**
 * The bulk-assignment panel's browser contract (issue #868): selection →
 * dry-run preview → explicit confirmation. The service rules are proven in
 * `draft-dimension-assignment.test.ts` and the integration suite; what is
 * proven here is that the panel never lets «تأیید و اعمال» run a payload the
 * reviewer has not seen a preview of.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DraftBulkAssignPanel } from "./draft-bulk-assign-panel";

const CC = "11111111-1111-4111-8111-111111111111";

const apiMock = vi.fn(async () => ({ ok: true, data: {}, status: 200, aborted: false }));

vi.mock("@/app/dashboard/ui", () => ({
  api: (...args: unknown[]) => apiMock(...(args as [])),
  ErrorBox: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SecondaryButton: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

vi.mock("./dimension-fields", () => ({
  useDimensionCatalog: () => ({
    catalog: {
      settings: [],
      allValues: [{ id: CC, kind: "cost_center", code: "CC-1", name: "دفتر مرکزی", isActive: true }],
      postableValues: [],
    },
    loaded: true,
    error: null,
    retry: () => undefined,
  }),
  DimensionFields: ({ value, onChange }: { value: Record<string, string>; onChange: (next: Record<string, string>) => void }) => (
    <button type="button" onClick={() => onChange({ ...value, cost_center: CC })}>
      انتخاب مرکز هزینه
    </button>
  ),
}));

const DRAFTS = [
  { id: "44444444-4444-4444-8444-444444444444", memo: "سند ۱" },
  { id: "55555555-5555-4555-8555-555555555555", memo: "سند ۲" },
];

beforeEach(() => {
  // mockReset (not mockClear): an unconsumed once-value from a failed case
  // must not leak into the next test's queue.
  apiMock.mockReset();
});

afterEach(cleanup);

function previewResponse() {
  return {
    ok: true,
    status: 200,
    aborted: false,
    data: {
      dryRun: true,
      mode: "fill_blank",
      matchedDrafts: 2,
      changedLines: [
        {
          lineId: "line-1",
          lineNo: 1,
          before: {},
          after: { cost_center: CC },
        },
      ],
      unchangedLines: 0,
    },
  };
}

describe("DraftBulkAssignPanel", () => {
  it("«تأیید و اعمال» stays disabled until a preview of the CURRENT payload exists", async () => {
    apiMock.mockResolvedValueOnce(previewResponse() as never);
    const onChanged = vi.fn();
    render(<DraftBulkAssignPanel drafts={DRAFTS} onChanged={onChanged} />);

    const confirm = screen.getByRole("button", { name: "تأیید و اعمال" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);

    // A draft selected and a value picked still needs the preview.
    fireEvent.click(screen.getByRole("checkbox", { name: "انتخاب پیش‌نویس سند ۱" }));
    fireEvent.click(screen.getByRole("button", { name: "انتخاب مرکز هزینه" }));
    expect((confirm as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "پیش‌نمایش تغییرات" }));
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));

    // Changing the payload invalidates the preview — no confirming a stale one.
    fireEvent.click(screen.getByRole("button", { name: "انتخاب مرکز هزینه" }));
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(true));
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("the preview is a dry-run of exactly the selected drafts, and confirming writes once", async () => {
    apiMock.mockResolvedValueOnce(previewResponse() as never).mockResolvedValueOnce({
      ok: true,
      status: 200,
      aborted: false,
      data: { dryRun: false, mode: "fill_blank", matchedDrafts: 1, changedLines: [{}], unchangedLines: 0 },
    } as never);
    const onChanged = vi.fn();
    render(<DraftBulkAssignPanel drafts={DRAFTS} onChanged={onChanged} />);

    fireEvent.click(screen.getByRole("checkbox", { name: "انتخاب پیش‌نویس سند ۱" }));
    fireEvent.click(screen.getByRole("button", { name: "انتخاب مرکز هزینه" }));
    fireEvent.click(screen.getByRole("button", { name: "پیش‌نمایش تغییرات" }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1));

    const [previewUrl, previewInit] = apiMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(previewUrl).toBe("/api/ledger/dimensions/bulk-assign");
    const previewBody = JSON.parse(String(previewInit.body));
    expect(previewBody).toMatchObject({
      draftIds: [DRAFTS[0].id],
      mode: "fill_blank",
      dryRun: true,
      dimensions: { cost_center: CC },
    });

    fireEvent.click(screen.getByRole("button", { name: "تأیید و اعمال" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const [, confirmInit] = apiMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(JSON.parse(String(confirmInit.body)).dryRun).toBe(false);
  });

  it("«پاک کردن» sends an explicit null — clearing is never implicit", async () => {
    apiMock.mockResolvedValueOnce(previewResponse() as never);
    render(<DraftBulkAssignPanel drafts={DRAFTS} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "انتخاب پیش‌نویس سند ۱" }));
    fireEvent.click(screen.getByRole("button", { name: "انتخاب مرکز هزینه" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "پاک کردن این بُعد" }));
    fireEvent.click(screen.getByRole("button", { name: "پیش‌نمایش تغییرات" }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1));
    const [, init] = apiMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).dimensions).toEqual({ cost_center: null });
  });

  it("a draft approved mid-flight is told in plain words, with nothing written", async () => {
    apiMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      aborted: false,
      data: { error: "draft_approval_race" },
    } as never);
    const onChanged = vi.fn();
    render(<DraftBulkAssignPanel drafts={DRAFTS} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "انتخاب پیش‌نویس سند ۱" }));
    fireEvent.click(screen.getByRole("button", { name: "انتخاب مرکز هزینه" }));
    fireEvent.click(screen.getByRole("button", { name: "پیش‌نمایش تغییرات" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("همین حالا تأیید شد"),
    );
    expect(onChanged).toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "تأیید و اعمال" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
