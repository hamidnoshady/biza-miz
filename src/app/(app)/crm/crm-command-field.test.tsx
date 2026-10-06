// @vitest-environment jsdom

/**
 * «جست‌وجو یا بپرس…» — the CRM command field, as a reader uses it.
 *
 * The unit tests in `src/lib/crm-commands.test.ts` pin the grammar. These pin
 * the three things only the rendered field can get wrong:
 *
 *  1. a match opens the screen that owns it — including the anchor that puts
 *     the queue's card on screen;
 *  2. a destination the member may not open is **not drawn**, so the field
 *     cannot leak the shape of a menu the sidebar hides;
 *  3. a phrase the vocabulary does not know becomes a directory search, not a
 *     guess and not a statement.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectivePermissions } from "@/lib/permissions";
import type { Role } from "@/lib/auth-edge";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  usePathname: () => "/crm/overview",
  useSearchParams: () => new URLSearchParams(),
}));

import { CrmCommandField } from "./crm-command-field";
import { CRM_QUEUE_PRESENTATION } from "@/lib/crm-shared";

const queueLabel = (key: keyof typeof CRM_QUEUE_PRESENTATION) => CRM_QUEUE_PRESENTATION[key].label;

afterEach(cleanup);
beforeEach(() => push.mockClear());

/**
 * The keys the layout actually threads in: the *effective* set, expanded
 * through the implication graph — `crm.view` alone opens nothing, because each
 * section's read is a real requirement (`crm-permissions.ts`).
 */
const MANAGER = [...effectivePermissions("manager" as Role, null)];

/** The floor's set, as `crm-permissions.test.ts` pins its three sections. */
const CASHIER = [...effectivePermissions("cashier" as Role, null)];

/** A manager who may work the pipeline but has no business in the directory. */
const NO_DIRECTORY = MANAGER.filter((key) => key !== "parties.view");

function box() {
  return screen.getByRole("combobox", { name: "جست‌وجو یا پرسش در ارتباط با مشتری" });
}

async function type(text: string) {
  await userEvent.clear(box());
  await userEvent.type(box(), text);
}

describe("CrmCommandField", () => {
  it("shows what it understood before opening anything", async () => {
    render(<CrmCommandField permissions={MANAGER} />);
    await type("معامله‌های راکد");
    expect(screen.getByText(/فهمیدم/)).toBeTruthy();
    // The queue's own label — quoted from the presentation table rather than
    // retyped, so renaming a queue does not break this test's intent.
    expect(queueLabel("stalled_deals")).toBe("فرصت‌های راکد");
    expect(screen.getByText(queueLabel("stalled_deals"), { selector: "span" })).toBeTruthy();
  });

  it("opens the screen that owns a queue, at the queue", async () => {
    render(<CrmCommandField permissions={MANAGER} />);
    await type("پیگیری‌های عقب‌افتاده");
    await userEvent.keyboard("{Enter}");
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][0]).toBe("/crm/activities#crm-queue-overdue_follow_ups");
  });

  it("opens a section by name", async () => {
    render(<CrmCommandField permissions={MANAGER} />);
    await type("تیکت‌ها");
    // The option is a real link (`href`), so it works with middle-click and
    // 「open in a new tab」; the keyboard path is asserted separately above.
    const option = screen.getByRole("option", { name: /تیکت‌های خدمات/ });
    expect(option.getAttribute("href")).toBe("/crm/cases");
  });

  it("hands a name over to the directory as a search", async () => {
    render(<CrmCommandField permissions={MANAGER} />);
    await type("مریم احمدی");
    expect(screen.getByRole("option", { name: /جست‌وجو در مشتریان/ })).toBeTruthy();
    await userEvent.keyboard("{Enter}");
    expect(push).toHaveBeenCalledWith(`/crm/directory?q=${encodeURIComponent("مریم احمدی")}`);
  });

  it("never draws a destination the member cannot open", async () => {
    render(<CrmCommandField permissions={CASHIER} />);
    await type("فرصت‌ها");
    expect(screen.queryByRole("option", { name: /فرصت‌ها/ })).toBeNull();
    // …while the floor's own surfaces stay reachable.
    await type("تیکت‌ها");
    expect(screen.getByRole("option", { name: /تیکت‌های خدمات/ })).toBeTruthy();
  });

  it("does not offer a person search it could not complete", async () => {
    // No `parties.view`, so the directory is closed — the field must not
    // promise a screen that would bounce the member to the app's fallback
    // section. The rest of the answer still stands: the pipeline is open, so
    // «معامله‌های مریم» still offers the board, just not the name search.
    render(<CrmCommandField permissions={NO_DIRECTORY} />);
    await type("معامله‌های مریم");
    expect(screen.queryByRole("option", { name: /جست‌وجو در مشتریان/ })).toBeNull();
    expect(screen.getByRole("option", { name: /فرصت‌ها/ })).toBeTruthy();
  });

  it("moves the highlight with the arrow keys", async () => {
    render(<CrmCommandField permissions={MANAGER} />);
    await type("سرنخ تازه");
    const options = screen.getAllByRole("option");
    expect(options.length).toBeGreaterThan(1);
    expect(options[0].getAttribute("aria-selected")).toBe("true");
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getAllByRole("option")[1].getAttribute("aria-selected")).toBe("true");
    await userEvent.keyboard("{Enter}");
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][0]).toBe(options[1].getAttribute("href"));
  });

  it("clears on Escape", async () => {
    render(<CrmCommandField permissions={MANAGER} />);
    await type("تیکت‌ها");
    await userEvent.keyboard("{Escape}");
    expect((box() as HTMLInputElement).value).toBe("");
  });

  it("focuses itself on Ctrl+K from anywhere in the app", () => {
    render(
      <div>
        <button type="button">جای دیگری</button>
        <CrmCommandField permissions={MANAGER} />
      </div>,
    );
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(document.activeElement).toBe(box());
  });
});
