// @vitest-environment jsdom

/**
 * The manual-journal screen's own contract: the parts of «سند دستی» that
 * cannot be proven by calling a function, because they are about what the
 * browser does with a click.
 *
 * Each case here is one thing that went wrong on a real screen:
 *
 *  - «افزودن ردیف» lives inside a `<form>`, so without `type="button"` it both
 *    added a row and filed the draft the person was still typing.
 *  - The page opens on `ledger.view`, so a member who cannot propose got a
 *    complete live form and a 403 after typing a whole document.
 *  - A half-typed row was filtered out of the payload, so a document submitted
 *    successfully while silently dropping a line the accountant had typed.
 *  - Totals were summed in JS `number`, so an aggregate past
 *    `Number.MAX_SAFE_INTEGER` rounded two different sides into «متوازن».
 *  - The account picker derived "leaf" from the active accounts only, so a
 *    parent whose only child was archived was offered and then refused.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toPersianDigits } from "@/lib/digits";
import { AUTOPILOT_NOTE_PREFIX } from "@/lib/ai-provenance";
import { ManualEntrySection } from "./manual-entry-section";
import type { AccountRow, Runner } from "./accounting-manager";

afterEach(cleanup);

const CASH = "11111111-1111-4111-8111-111111111111";
const EXPENSE = "22222222-2222-4222-8222-222222222222";
const HEADING = "33333333-3333-4333-8333-333333333333";

/**
 * `۵۰۰۰ هزینه‌ها` is a heading whose only child has been archived, so it is
 * absent from the active list — which is exactly why the picker used to derive
 * it as a leaf and offer it. The server says `is_postable: false`.
 */
const ACCOUNTS: AccountRow[] = [
  { id: HEADING, code: "5000", name: "هزینه‌ها", type: "expense", parent_code: null, is_postable: false, has_children: true },
  { id: CASH, code: "1001", name: "صندوق", type: "asset", parent_code: null, is_postable: true, has_children: false },
  { id: EXPENSE, code: "5100", name: "اجاره", type: "expense", parent_code: "5000", is_postable: true, has_children: false },
];

const DRAFT_ID = "44444444-4444-4444-8444-444444444444";

function draftPage(overrides: Record<string, unknown> = {}) {
  return {
    drafts: [
      {
        id: DRAFT_ID,
        entryDate: "2026-03-10",
        locationId: "loc-1",
        locationName: "شعبهٔ مرکزی",
        memo: "اجاره اسفند",
        createdBy: "user-2",
        createdByName: "زهرا احمدی",
        createdAt: "2026-03-01T09:00:00.000Z",
        proposedBy: "user-2",
        proposedByName: "زهرا احمدی",
        proposedAt: "2026-03-01T09:00:00.000Z",
        lines: [
          { accountId: EXPENSE, accountCode: "5100", accountName: "اجاره", debit: 50_000_000, credit: 0 },
          { accountId: CASH, accountCode: "1001", accountName: "صندوق", debit: 0, credit: 50_000_000 },
        ],
        ...overrides,
      },
    ],
    total: 1,
    hasMore: false,
    limit: 25,
    offset: 0,
    activeLocation: { id: "loc-1", name: "شعبهٔ مرکزی" },
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () => (url.startsWith("/api/ledger/entries/drafts") ? draftPage() : {}),
  }));
  vi.stubGlobal("fetch", fetchMock);
});

function renderSection(props: Partial<Parameters<typeof ManualEntrySection>[0]> = {}) {
  const run: Runner = async (fn) => {
    const { ok } = await fn();
    return ok;
  };
  return render(
    <ManualEntrySection
      accounts={ACCOUNTS}
      busy={false}
      run={run}
      refreshKey={0}
      canPropose
      canApprove
      currentUserId="user-1"
      {...props}
    />,
  );
}

/** Fills one row through the real controls — account, side, amount. */
async function fillRow(
  user: ReturnType<typeof userEvent.setup>,
  row: number,
  accountLabel: string,
  side: "بدهکار" | "بستانکار",
  amount: string,
) {
  const rowNumber = toPersianDigits(String(row));
  await user.click(screen.getByRole("button", { name: `حساب ردیف ${rowNumber}` }));
  await user.click(await screen.findByRole("option", { name: accountLabel }));
  await user.type(screen.getByLabelText(`مبلغ ردیف ${rowNumber} به تومان`), amount);
  // Every row defaults to «بدهکار»; a document needs one of each side.
  await user.click(screen.getByRole("button", { name: `طرف ردیف ${rowNumber}` }));
  await user.click(await screen.findByRole("option", { name: side }));
}

/**
 * Fills a balanced document of `pairs` debit rows against `pairs` credit rows.
 *
 * `pairs: 2` is what the aggregate-total test needs: a single row a side cannot
 * push a total past `Number.MAX_SAFE_INTEGER`, because any one amount that
 * large is already rejected as unrepresentable before it reaches the sum.
 */
async function fillBalancedDocument(
  user: ReturnType<typeof userEvent.setup>,
  amount = "10000",
  pairs = 1,
) {
  // The wrapper <label> also carries the hint text, so this matches the
  // label's whole text content rather than just the field name.
  await user.type(screen.getByLabelText(/^شرح سند/), "اجاره اسفند");
  for (let i = 0; i < pairs; i += 1) {
    await fillRow(user, i * 2 + 1, "5100 — اجاره", "بدهکار", amount);
    await fillRow(user, i * 2 + 2, "1001 — صندوق", "بستانکار", amount);
    if (i < pairs - 1) {
      await user.click(screen.getByRole("button", { name: /افزودن ردیف/ }));
      await user.click(screen.getByRole("button", { name: /افزودن ردیف/ }));
    }
  }
}

describe("ManualEntrySection — the create form", () => {
  it("adds a row without submitting the document underneath", async () => {
    const user = userEvent.setup();
    renderSection();
    await fillBalancedDocument(user);
    expect((screen.getByRole("button", { name: /ثبت پیش‌نویس/ }) as HTMLButtonElement).disabled).toBe(
      false,
    );

    const addRow = screen.getByRole("button", { name: /افزودن ردیف/ });
    // A <button> inside a <form> submits unless told otherwise, and this one
    // used to: the row was added *and* the draft was filed.
    expect(addRow.getAttribute("type")).toBe("button");
    await user.click(addRow);

    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/ledger/entries/drafts",
      expect.objectContaining({ method: "POST" }),
    );
    // …and the row really was added, so `type="button"` has not quietly
    // disabled the button instead of fixing it.
    await waitFor(() => expect(screen.getByLabelText("مبلغ ردیف ۳ به تومان")).toBeTruthy());
  });

  it("offers a read-only page instead of a form the API is going to refuse", async () => {
    // The page gate is `ledger.view`; drafting is `ledger.propose`. A member
    // holding only the first used to get a live form and a 403 on submit.
    renderSection({ canPropose: false });
    await screen.findByText(/فقط برای مشاهده و بررسی/);
    expect(screen.queryByRole("button", { name: /ثبت پیش‌نویس/ })).toBeNull();
    expect(screen.queryByLabelText(/^شرح سند/)).toBeNull();
  });

  it("hides «تأیید و ثبت» from a member without ledger.approve", async () => {
    // Their own draft: withdrawing it is allowed without ledger.approve, and
    // that is the one review action the API leaves them.
    renderSection({ canApprove: false, currentUserId: "user-2" });
    await screen.findByText("اجاره اسفند");
    expect(screen.queryByRole("button", { name: /تأیید و ثبت/ })).toBeNull();
    expect(screen.getByRole("button", { name: "رد کردن" })).toBeTruthy();
  });

  it("leaves somebody else's draft to a member who can only propose", async () => {
    renderSection({ canApprove: false, currentUserId: "user-1" });
    await screen.findByText("اجاره اسفند");
    expect(screen.queryByRole("button", { name: /تأیید و ثبت/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "رد کردن" })).toBeNull();
    expect(screen.getByText(/بررسی این پیش‌نویس با دارندهٔ دسترسی/)).toBeTruthy();
  });

  it("shows «تأیید و ثبت» to a member with ledger.approve", async () => {
    renderSection({ canApprove: true });
    await screen.findByText("اجاره اسفند");
    expect(screen.getByRole("button", { name: /تأیید و ثبت/ })).toBeTruthy();
  });

  it("refuses to submit while a row is half-typed, instead of dropping it silently", async () => {
    const user = userEvent.setup();
    renderSection();
    await fillBalancedDocument(user);

    // A third row with an amount but no account: the payload filter drops it,
    // so the document balances and used to submit — minus one line.
    await user.click(screen.getByRole("button", { name: /افزودن ردیف/ }));
    await user.type(screen.getByLabelText("مبلغ ردیف ۳ به تومان"), "5000");

    const submit = screen.getByRole("button", { name: /ثبت پیش‌نویس/ });
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(true));
    // Named twice on purpose: once in the live region under the totals, and
    // once as the reason beside the disabled button, which is the one a person
    // reading left-to-right actually sees.
    expect(screen.getAllByText(/ردیف ناقص است/).length).toBeGreaterThan(0);

    const form = document.querySelector("form") as HTMLFormElement;
    await act(async () => {
      fireEvent.submit(form);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/ledger/entries/drafts",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("keeps the totals exact past Number.MAX_SAFE_INTEGER", async () => {
    const user = userEvent.setup();
    renderSection();
    // Two rows a side at ۹۰۰٬۰۰۰٬۰۰۰٬۰۰۰٬۰۰۰ تومان. Every individual amount is
    // a legal, safely-representable Rial figure, but each side then totals
    // 1.8e16 Rial — past `Number.MAX_SAFE_INTEGER`, where a JS-number sum
    // rounds two genuinely different sides into one value and calls an
    // unbalanced document balanced.
    await fillBalancedDocument(user, "900000000000000", 2);
    expect(BigInt("18000000000000000") > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    await waitFor(() =>
      expect(screen.getByText("جمع بدهکار").parentElement?.textContent).toContain(
        "۱٬۸۰۰٬۰۰۰٬۰۰۰٬۰۰۰٬۰۰۰ تومان",
      ),
    );
    expect(screen.getByText("جمع بستانکار").parentElement?.textContent).toContain(
      "۱٬۸۰۰٬۰۰۰٬۰۰۰٬۰۰۰٬۰۰۰ تومان",
    );
    // The screen's own verdict has to agree with the server's arithmetic: these
    // two sides really are equal, so the document is balanced.
    expect((screen.getByRole("button", { name: /ثبت پیش‌نویس/ }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    // Typing four sixteen-digit amounts through `userEvent` costs ~2.5s on a
    // quiet machine, which left nothing under the 5s default: the same commit
    // passed on one CI runner and timed out on another. The work is the same
    // either way, so the budget is the thing to state.
  }, 30_000);

  it("never offers an account the server has marked not postable", async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(screen.getByRole("button", { name: "حساب ردیف ۱" }));

    // `۵۰۰۰ هزینه‌ها` has one child, archived, so it is not a parent inside the
    // active-only list — deriving "leaf" client-side offered it, and approval
    // then refused with `not_a_leaf_account`.
    await waitFor(() => expect(screen.getByRole("option", { name: "1001 — صندوق" })).toBeTruthy());
    expect(screen.queryByRole("option", { name: "5000 — هزینه‌ها" })).toBeNull();
  });

  it("says which branch a new draft will post to", async () => {
    renderSection();
    await screen.findByText(/شعبهٔ ثبت/);
  });
});

describe("ManualEntrySection — the review queue", () => {
  it("pages the queue instead of loading it whole", async () => {
    // The queue is business-wide and open-ended; the screen used to render
    // every pending draft the business had ever drafted.
    const many = Array.from({ length: 3 }, (_, i) => ({
      ...draftPage().drafts[0],
      id: `55555555-5555-4555-8555-00000000000${i}`,
      memo: `سند ${i + 1}`,
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        status: 200,
        json: async () => ({
          ...draftPage(),
          drafts: many,
          total: 60,
          hasMore: true,
          limit: 25,
          offset: url.includes("offset=25") ? 25 : 0,
        }),
      })),
    );
    const user = userEvent.setup();
    renderSection();
    await screen.findByText("سند 1");

    // The heading counts the whole queue, not the page, and the pager says
    // which slice is on screen.
    expect(screen.getByText("(۶۰ سند)")).toBeTruthy();
    expect(screen.getByText(/نمایش ۱ تا ۳ از ۶۰/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "صفحهٔ بعد" }));
    expect(screen.getByText(/نمایش ۲۶ تا ۲۸ از ۶۰/)).toBeTruthy();
  });


  it("shows the branch, the proposer and the reference before the reviewer decides", async () => {
    renderSection();
    await screen.findByText("اجاره اسفند");
    // The queue is business-wide while approval posts to the draft's own
    // branch, so the branch badge is the only place that is visible.
    // Twice: the branch this draft will post to, and the branch the form above
    // is currently targeting.
    expect(screen.getAllByText("شعبهٔ مرکزی").length).toBeGreaterThan(0);
    expect(screen.getByText(/زهرا احمدی/)).toBeTruthy();
    expect(screen.getByText(`#${toPersianDigits(DRAFT_ID.slice(0, 8))}`)).toBeTruthy();
  });

  it("says when a draft was written by the assistant rather than a person", async () => {
    // The mark on the memo is the only place that difference is recorded, and
    // a reviewer weighs an autopilot draft differently from a typed one.
    renderSection();
    await screen.findByText("اجاره اسفند");
    expect(screen.queryByText(/پیش‌نویس خودکار دستیار/)).toBeNull();

    cleanup();
    // `draftPage`'s overrides land on the draft row, so this replaces the
    // whole list with the same draft under an autopilot memo.
    const asstDraft = { ...draftPage().drafts[0], memo: `${AUTOPILOT_NOTE_PREFIX}اجاره اسفند` };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ ...draftPage(), drafts: [asstDraft] }),
      })),
    );
    renderSection();
    await screen.findByText(/پیش‌نویس خودکار دستیار/);
  });

  it("labels each line's debit and credit for a screen reader", async () => {
    renderSection();
    await screen.findByText("اجاره اسفند");
    // The heading row used to be aria-hidden with plain spans underneath, so
    // nothing said which number was the debit.
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "بدهکار" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "بستانکار" })).toBeTruthy();
  });

  it("requires a reason before rejecting somebody else's draft", async () => {
    const user = userEvent.setup();
    renderSection({ canApprove: true });
    await screen.findByText("اجاره اسفند");
    await user.click(screen.getByRole("button", { name: "رد کردن" }));

    const confirm = screen.getByRole("button", { name: /بله، رد کن/ });
    // A rejection with no reason is indistinguishable from a deletion.
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText("علت رد"), "مبلغ با فاکتور مطابقت ندارد");
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));

    await user.click(confirm);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/ledger/entries/drafts/${DRAFT_ID}/reject`,
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("lets a drafter withdraw their own draft without giving a reason", async () => {
    const user = userEvent.setup();
    renderSection({ canApprove: false, currentUserId: "user-2" });
    await screen.findByText("اجاره اسفند");
    await user.click(screen.getByRole("button", { name: "رد کردن" }));
    // Not a rejection: «اشتباه تایپ کردم» is a complete explanation to oneself.
    expect(screen.getByLabelText("علت رد (اختیاری)")).toBeTruthy();
    expect((screen.getByRole("button", { name: /بله، رد کن/ }) as HTMLButtonElement).disabled).toBe(false);
  });
});
