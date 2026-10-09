// @vitest-environment jsdom

/**
 * Focused regressions for the canonical chart-of-accounts editor (issue #824).
 *
 * These cover the behaviours an independent review found untested:
 *   * the section mounts and fetches on its own (`?all=1`), so a failure of the
 *     unrelated active-account picker fetch cannot blank the page;
 *   * the delete control is *draft-aware* and announces why it is blocked;
 *   * the add form inherits and locks the parent's type;
 *   * read-only members see the statement but no mutation/history controls;
 *   * Persian-digit search keeps the ancestor context of a matching row;
 *   * the archived parent stays visible while editing.
 *
 * The API is the real boundary; the component mocks `fetch` only.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChartOfAccountsSection } from "./chart-of-accounts-section";
import type { Runner } from "./accounting-manager";

afterEach(cleanup);

/** Two expense ancestors plus a leaf, so ancestor-context search is provable. */
const ROWS = [
  {
    id: "g-1", code: "6100", name: "هزینه‌ها", type: "expense", parentId: null, parentCode: null,
    isActive: true, hasPostings: false, hasDraftPostings: false, hasChildren: true,
    level: "group", normalBalance: "debit", isContra: false,
  },
  {
    id: "k-1", code: "6110", name: "اجاره", type: "expense", parentId: "g-1", parentCode: "5000",
    isActive: true, hasPostings: false, hasDraftPostings: false, hasChildren: true,
    level: "kol", normalBalance: "debit", isContra: false,
  },
  {
    id: "m-1", code: "6120", name: "اجاره مغازه", type: "expense", parentId: "k-1", parentCode: "6110",
    isActive: false, hasPostings: true, hasDraftPostings: true, hasChildren: false,
    level: "moein", normalBalance: "debit", isContra: false,
  },
  {
    id: "m-2", code: "6130", name: "اجاره انبار", type: "expense", parentId: "k-1", parentCode: "6110",
    isActive: true, hasPostings: false, hasDraftPostings: false, hasChildren: false,
    level: "moein", normalBalance: "debit", isContra: false,
  },
];

function fetchMockOnce(rows: unknown[] = ROWS) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "PATCH" || init?.method === "DELETE" || init?.method === "POST") {
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    expect(url).toContain("/api/ledger/accounts?all=1");
    return new Response(JSON.stringify({ accounts: rows }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

const runner = (): Runner =>
  vi.fn(async (fn: () => Promise<{ ok: boolean; data: { error?: string } }>) => {
    await fn();
    return true;
  });

/**
 * The section renders a desktop table *and* a mobile card list from the same
 * rows, so every account name appears twice. `rowFor` picks the table row, and
 * `seen` asserts the name is present at all.
 */
function rowFor(name: string): HTMLElement {
  const nodes = screen.getAllByText(name);
  const row = nodes.map((n) => n.closest("tr")).find((r): r is HTMLTableRowElement => r !== null);
  if (!row) throw new Error(`no table row for ${name}`);
  return row;
}

function seen(name: string): boolean {
  return screen.getAllByText(name).length > 0;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("issue #824 §7: the chart owns its own fetch", () => {
  it("requests the full chart itself and renders it without any picker request", async () => {
    const fetchMock = fetchMockOnce();
    vi.stubGlobal("fetch", fetchMock);
    render(<ChartOfAccountsSection busy={false} run={runner()} />);

    await waitFor(() => expect(seen("اجاره انبار")).toBe(true));

    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls).toEqual(["/api/ledger/accounts?all=1"]);
    // No `?all=0` / active-only picker call: the accounting workspace's shared
    // account list is only needed by the manual/expense flows (item §7).
    expect(urls.some((u) => u.includes("all=0"))).toBe(false);
  });

  it("still renders the chart when the section is mounted while another screen's account fetch failed", async () => {
    // The manager no longer gates this section on the picker fetch, so the
    // section's own request is the only thing that can fail it.
    const fetchMock = fetchMockOnce();
    vi.stubGlobal("fetch", fetchMock);
    render(<ChartOfAccountsSection busy={false} run={runner()} />);
    await waitFor(() => expect(seen("هزینه‌ها")).toBe(true));
    expect(screen.queryByText(/بارگذاری سرفصل/)).toBeNull();
  });

  it("shows a retry affordance when its own fetch fails", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("offline");
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ChartOfAccountsSection busy={false} run={runner()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /تلاش دوباره/ })).toBeTruthy());
  });
});

describe("issue #824 §4: draft-aware delete eligibility is discoverable", () => {
  it("blocks delete for an account with draft postings and states the reason inline", async () => {
    vi.stubGlobal("fetch", fetchMockOnce());
    render(<ChartOfAccountsSection busy={false} run={runner()} />);
    await waitFor(() => expect(seen("اجاره مغازه")).toBe(true));

    // The leaf has real postings, drafts and no children: the draft is what a
    // real-posting-only check would have missed.
    const row = rowFor("اجاره مغازه");

    // The control stays a real, *focusable* button so a keyboard user reaches
    // it and a screen reader announces the reason; it is marked unavailable
    // through aria-disabled rather than being removed from the tab order.
    const control = within(row).getByRole("button", { name: /حذف/ }) as HTMLButtonElement;
    expect(control.getAttribute("aria-disabled")).toBe("true");
    expect(control.hasAttribute("disabled")).toBe(false);

    // The reason is both the button's accessible description and visible text
    // (touch users get no tooltip).
    const describedBy = control.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const reason = document.getElementById(describedBy!)!;
    expect(reason).toBeTruthy();
    expect(reason.textContent).toMatch(/سند|پیش‌نویس|زیرمجموعه/);
    expect(reason.textContent).toMatch(/دارای سند ثبت‌شده/);

    // Activating it reports the reason instead of silently doing nothing.
    fireEvent.click(control);
    const notice = await screen.findByRole("status");
    expect(notice.textContent).toMatch(/دارای سند ثبت‌شده/);
  });

  it("offers a real delete button for a leaf with no postings, no drafts and no children", async () => {
    vi.stubGlobal("fetch", fetchMockOnce());
    render(<ChartOfAccountsSection busy={false} run={runner()} />);
    await waitFor(() => expect(seen("اجاره انبار")).toBe(true));
    const row = rowFor("اجاره انبار");
    const control = within(row).getByRole("button", { name: /حذف/ }) as HTMLButtonElement;
    expect(control.getAttribute("aria-disabled")).toBeNull();
    expect(control.hasAttribute("disabled")).toBe(false);
    expect(control.className).toContain("destructive");
  });
});

describe("issue #824 §2: the add form inherits the parent's type", () => {
  it("locks the type picker to the chosen parent's type and explains the inheritance", async () => {
    vi.stubGlobal("fetch", fetchMockOnce());
    render(<ChartOfAccountsSection busy={false} run={runner()} />);
    await waitFor(() => expect(seen("هزینه‌ها")).toBe(true));

    const parentTrigger = screen.getByRole("button", { name: "حساب والد" });
    fireEvent.click(parentTrigger);
    // Pick the expense ancestor; the type must follow without user input.
    const option = (await screen.findAllByRole("option")).find((o) => /۶۱۱۰|6110/.test(o.textContent ?? ""));
    expect(option).toBeTruthy();
    fireEvent.click(option!);

    await waitFor(() => {
      expect(screen.getByText(/از والد به ارث رسیده/)).toBeTruthy();
    });
    // The pill's label must read the inherited type, and the picker is locked.
    const typeTrigger = screen.getByRole("button", { name: "نوع حساب" }) as HTMLButtonElement;
    expect(typeTrigger.disabled).toBe(true);
  });
});

describe("issue #824 §3: the archived current parent stays visible while editing", () => {
  it("keeps an archived parent in the edit picker so a no-op save is not a silent move", async () => {
    // A child whose parent has since been archived: the parent is filtered out
    // of the *new-parent* options but must remain representable here.
    const rows = [
      ...ROWS.map((r) => (r.id === "k-1" ? { ...r, isActive: false } : r)),
      {
        id: "m-3", code: "6140", name: "اجاره پارکینگ", type: "expense", parentId: "k-1", parentCode: "6110",
        isActive: true, hasPostings: false, hasDraftPostings: false, hasChildren: false,
        level: "moein", normalBalance: "debit", isContra: false,
      },
    ];
    vi.stubGlobal("fetch", fetchMockOnce(rows));
    render(<ChartOfAccountsSection busy={false} run={runner()} />);
    await waitFor(() => expect(seen("اجاره پارکینگ")).toBe(true));

    const row = rowFor("اجاره پارکینگ");
    fireEvent.click(within(row).getByRole("button", { name: "ویرایش" }));

    const dialog = await screen.findByRole("dialog");
    const picker = within(dialog).getByRole("button", { name: "حساب والد" });
    fireEvent.click(picker);
    // The archived parent shows, flagged as archived, so the user can see the
    // current value rather than believing the account is top-level.
    const options = await screen.findAllByRole("option");
    expect(options.some((o) => /بایگانی/.test(o.textContent ?? ""))).toBe(true);
  });
});

describe("issue #824: read-only members", () => {
  it("hides every mutation and history control but keeps «گردش حساب»", async () => {
    vi.stubGlobal("fetch", fetchMockOnce());
    render(<ChartOfAccountsSection busy={false} run={runner()} canEdit={false} />);
    await waitFor(() => expect(seen("اجاره انبار")).toBe(true));

    expect(screen.queryByRole("button", { name: "ویرایش" })).toBeNull();
    expect(screen.queryByRole("button", { name: "حذف" })).toBeNull();
    expect(screen.queryByRole("button", { name: "بایگانی" })).toBeNull();
    expect(screen.queryByRole("button", { name: "تاریخچه" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "گردش حساب" }).length).toBeGreaterThan(0);
    // And the add form is replaced by the explanation, not merely disabled.
    expect(screen.getByText(/دسترسی «ویرایش سرفصل‌ها» ندارید/)).toBeTruthy();
  });
});

describe("Persian-digit search", () => {
  it("finds a match typed in Persian digits and keeps its ancestors in view", async () => {
    vi.stubGlobal("fetch", fetchMockOnce());
    render(<ChartOfAccountsSection busy={false} run={runner()} />);
    await waitFor(() => expect(seen("اجاره انبار")).toBe(true));

    const search = screen.getByLabelText("جست‌وجوی سرفصل حساب‌ها") as HTMLInputElement;
    // ۶۱۳۰ — the leaf's code in Persian digits.
    fireEvent.change(search, { target: { value: "۶۱۳۰" } });

    expect(await screen.findByText("اجاره انبار", { selector: "span" })).toBeTruthy();
    // Ancestors are retained for context, so the row is not orphaned.
    expect(seen("هزینه‌ها")).toBe(true);
    expect(seen("اجاره")).toBe(true);
    // A non-matching sibling disappears.
    await waitFor(() => expect(screen.queryByText("اجاره مغازه")).toBeNull());
  });
});

describe("issue #824 §13: heading ownership", () => {
  it("does not repeat the page title inside the section card", async () => {
    vi.stubGlobal("fetch", fetchMockOnce());
    render(<ChartOfAccountsSection busy={false} run={runner()} />);
    await waitFor(() => expect(seen("هزینه‌ها")).toBe(true));
    // The PageHeader (ACCOUNTING_HEADINGS) owns «سرفصل حساب‌ها»; the nested
    // SectionCard must not draw a second one.
    expect(screen.queryByText("سرفصل حساب‌ها")).toBeNull();
  });
});
