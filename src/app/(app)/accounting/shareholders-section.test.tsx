// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ChangeEvent, ReactNode } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MoneyProvider } from "@/components/money/money-context";
import { PERMISSIONS } from "@/lib/permissions";
import type {
  ShareholderDistributionLinePage,
  ShareholderDistributionPage,
  ShareholderDistributionRow,
  ShareholderWorkspace,
} from "@/lib/shareholder-service";
import { ShareholdersSection } from "./shareholders-section";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children?: ReactNode } & Record<string, unknown>) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

vi.mock("@/components/ui/searchable-select", () => ({
  SearchableSelect: ({ value, onChange, options, disabled, ariaLabel, placeholder }: {
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

const distributionId = "3c11e482-ea57-4bf7-8db4-18871c2a74db";
const detail: ShareholderDistributionRow = {
  id: distributionId,
  fiscalYearId: "4405cda3-4bac-4bc6-9f80-1084c97a214e",
  fiscalYearLabel: "1404",
  closingEntryId: "c2449a75-20e0-4dbe-9cdf-70fc202a94dc",
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
};

const workspace = {
  today: "2026-10-15",
  asOf: "2026-10-15",
  totalPolicy: "at_most_100",
  register: [{
    shareholderId: "54fc1b20-8b68-4d80-980a-21186d904cf3",
    partyId: "c140f6e2-cb68-4e75-a150-d21137aa3229",
    partyName: "Shareholder A",
    partyRole: "customer",
    active: true,
    ownershipPercent: "100.000000",
    shareUnits: "100",
    effectiveFrom: "2026-01-01",
    createdAt: "2026-01-01T00:00:00.000Z",
  }],
  fiscalYears: [],
  distributionSummary: {
    distributionCount: 1,
    reservedRial: "10000",
    draftReservedRial: "10000",
    pendingPostingRial: "0",
    distributedRial: "0",
    paidRial: "0",
    outstandingRial: "0",
  },
  fiscalYearReconciliation: [],
  glReconciliation: [],
  shareholderBalances: [],
} as unknown as ShareholderWorkspace;

const distributionPage: ShareholderDistributionPage = {
  distributions: [detail],
  totalCount: 1,
  summary: {
    distributionCount: 1,
    reservedRial: "10000",
    draftReservedRial: "10000",
    pendingPostingRial: "0",
    distributedRial: "0",
    paidRial: "0",
    outstandingRial: "0",
  },
  limit: 25,
  hasMore: false,
  nextCursor: null,
};

const targetedLine = {
  distributionId,
  shareholderId: "54fc1b20-8b68-4d80-980a-21186d904cf3",
  partyId: "c140f6e2-cb68-4e75-a150-d21137aa3229",
  partyName: "Frozen recipient A",
  ownershipPercent: "100.000000",
  shareUnits: "100",
  allocatedRial: "10000",
  paidRial: "0",
  outstandingRial: "0",
};

const linesPage: ShareholderDistributionLinePage = {
  lines: [targetedLine],
  totalCount: 1,
  totalAllocatedRial: "10000",
  totalPaidRial: "0",
  totalOutstandingRial: "0",
  limit: 25,
  offset: 0,
  nextOffset: null,
};

describe("ShareholdersSection route, independent detail loading and read permissions (#864)", () => {
  it("loads a selected distribution through its own endpoint and keeps ownership controls read-only", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const parsed = new URL(url, "http://localhost");
      let data: unknown;
      if (parsed.pathname === "/api/parties") data = { parties: [] };
      else if (parsed.pathname === "/api/accounting/shareholders") data = workspace;
      else if (parsed.pathname === "/api/accounting/shareholders/events") data = { events: [], totalCount: 0, netCapitalMovementRial: "0", limit: 50, hasMore: false, nextCursor: null };
      else if (parsed.pathname === "/api/accounting/shareholders/distributions") data = distributionPage;
      else if (parsed.pathname === `/api/accounting/shareholders/distributions/${distributionId}`) data = detail;
      else if (parsed.pathname === `/api/accounting/shareholders/distributions/${distributionId}/lines`) data = linesPage;
      else if (parsed.pathname === "/api/accounting/shareholders/distributions/payments") data = { payments: [], totalCount: 0, netPaidRial: "0", limit: 25, hasMore: false, nextCursor: null };
      else data = { error: "unexpected_endpoint" };
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
    expect((await screen.findAllByText("Frozen recipient A")).length).toBeGreaterThan(0);

    await waitFor(() => {
      const requestedUrls = fetchMock.mock.calls.map(([input]) => String(input));
      expect(requestedUrls.some((url) => url === `/api/accounting/shareholders/distributions/${distributionId}`)).toBe(true);
      expect(requestedUrls.some((url) => url.startsWith(`/api/accounting/shareholders/distributions/${distributionId}/lines?`))).toBe(true);
    });
  });
});
