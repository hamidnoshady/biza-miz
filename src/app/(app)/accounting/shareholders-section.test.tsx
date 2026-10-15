// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ChangeEvent, ReactNode } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MoneyProvider } from "@/components/money/money-context";
import { PERMISSIONS } from "@/lib/permissions";
import type { ShareholderWorkspace } from "@/lib/shareholder-service";
import { ShareholdersSection } from "./shareholders-section";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children?: ReactNode } & Record<string, unknown>) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

vi.mock("@/components/ui/searchable-select", () => ({
  SearchableSelect: ({
    value,
    onChange,
    options,
    disabled,
    ariaLabel,
    placeholder,
  }: {
    value: string;
    onChange: (value: string) => void;
    options: Array<{ value: string; label: string }>;
    disabled?: boolean;
    ariaLabel?: string;
    placeholder?: string;
  }) => (
    <select aria-label={ariaLabel} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
      <option value="">{placeholder ?? "انتخاب کنید"}</option>
      {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  ),
}));

vi.mock("@/app/dashboard/jalali-date-picker", () => ({
  JalaliDatePicker: ({ value, onChange, disabled, ariaLabel }: {
    value: string;
    onChange: (value: string) => void;
    disabled?: boolean;
    ariaLabel: string;
  }) => <input type="date" aria-label={ariaLabel} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} />,
}));

vi.mock("@/components/ui/persian-number-input", () => ({
  PersianNumberInput: ({ value, onChange, disabled, step, placeholder, className, "aria-label": ariaLabel }: {
    value?: string | number;
    onChange?: (event: ChangeEvent<HTMLInputElement>) => void;
    disabled?: boolean;
    step?: string | number;
    placeholder?: string;
    className?: string;
    "aria-label"?: string;
  }) => <input value={value ?? ""} onChange={onChange} disabled={disabled} step={step} placeholder={placeholder} className={className} aria-label={ariaLabel} />,
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const distributionId = "distribution-older-than-the-recent-lines";
const workspace = {
  today: "2026-10-15",
  asOf: "2026-10-15",
  totalPolicy: "at_most_100",
  register: [{
    shareholderId: "shareholder-a",
    partyId: "party-a",
    partyName: "Shareholder A",
    partyRole: "customer",
    active: true,
    ownershipPercent: "100.000000",
    shareUnits: "100",
    effectiveFrom: "2026-01-01",
    createdAt: "2026-01-01T00:00:00.000Z",
  }],
  events: [],
  eventsTruncated: false,
  distributions: [{
    id: distributionId,
    fiscalYearId: "fiscal-year-1404",
    fiscalYearLabel: "1404",
    closingEntryId: "closing-entry",
    snapshotOn: "2026-03-20",
    sourceProfitRial: "10000",
    taxAdjustmentRial: "0",
    reserveAdjustmentRial: "0",
    manualAdjustmentRial: "0",
    adjustmentReason: null,
    distributableRial: "10000",
    status: "draft",
    postingEntryId: null,
    reversalEntryId: null,
    createdById: "creator-id",
    createdByName: "Accountant",
    createdAt: "2026-10-01T00:00:00.000Z",
    approvedByName: null,
    approvedAt: null,
    postedByName: null,
    postedAt: null,
    reversedByName: null,
    reversedAt: null,
    cancelledByName: null,
    cancelledAt: null,
    cancelReason: null,
    paidRial: "0",
    outstandingRial: "10000",
  }],
  distributionLines: [],
  payments: [],
  fiscalYears: [],
  glReconciliation: [],
  shareholderBalances: [],
} as unknown as ShareholderWorkspace;

const targetedLine = {
  distributionId,
  shareholderId: "shareholder-a",
  partyId: "party-a",
  partyName: "Frozen recipient A",
  ownershipPercent: "100.000000",
  shareUnits: "100",
  allocatedRial: "10000",
  paidRial: "0",
  outstandingRial: "10000",
};

describe("ShareholdersSection route, snapshot loading and read permissions (#864)", () => {
  it("loads selected distribution details by id and keeps ownership controls read-only without manage permission", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const requested = new URL(url, "http://localhost").searchParams.get("distributionId");
      const data = url.startsWith("/api/parties")
        ? { parties: [] }
        : { ...workspace, distributionLines: requested === distributionId ? [targetedLine] : [] };
      return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      <MoneyProvider unit="toman">
        <ShareholdersSection
          accounts={[]}
          permissions={[PERMISSIONS.shareholdersView]}
          currentUserId="viewer-id"
          refreshKey={0}
          onRefresh={vi.fn()}
        />
      </MoneyProvider>,
    );

    expect(await screen.findByText("Shareholder A")).toBeTruthy();
    expect((screen.getByRole("button", { name: "ثبت رویداد مالکیت" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("combobox", { name: "انتخاب شخص از فهرست canonical اشخاص" }) as HTMLSelectElement).disabled).toBe(true);

    await user.click(screen.getByRole("tab", { name: "تقسیم سود" }));
    expect(await screen.findByText("ساخت توزیع سود از سال مالی بسته‌شده")).toBeTruthy();
    expect(await screen.findByText("Frozen recipient A")).toBeTruthy();

    await waitFor(() => {
      const workspaceUrls = fetchMock.mock.calls
        .map(([input]) => String(input))
        .filter((url) => url.startsWith("/api/accounting/shareholders"));
      expect(workspaceUrls.some((url) => new URL(url, "http://localhost").searchParams.get("distributionId") === distributionId)).toBe(true);
    });
    const targetedUrl = fetchMock.mock.calls
      .map(([input]) => String(input))
      .find((url) => new URL(url, "http://localhost").searchParams.get("distributionId") === distributionId);
    expect(targetedUrl).toContain("asOf=2026-10-15");
  });
});
