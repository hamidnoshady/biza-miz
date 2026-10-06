// @vitest-environment jsdom

/**
 * The spoken-request box: what it offers, and when it refuses to offer it.
 *
 * `crm-audience-request.test.ts` pins the reading of a sentence. This file pins
 * the two affordances that turn a reading into an action:
 *
 *  1. **The clause list is the builder's language**, so the member recognises
 *     the sentence in the form they are about to open.
 *  2. **The seed button is withheld the moment a word goes unread.** The
 *     dangerous failure is not a refusal — it is a half-read sentence that looks
 *     complete, because its count would be computed from rules the member never
 *     saw. So the button's absence is asserted, not the error text alone.
 *  3. **Seeding is not saving.** The box hands rules to its caller; it has no
 *     fetch of its own, which the stub below proves by failing the test on any
 *     request.
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MoneyProvider } from "@/components/money/money-context";
import { AudienceRequestBox } from "./audience-request-box";

afterEach(cleanup);

function renderBox(onSeed: (definition: unknown) => void = () => {}) {
  // Any network call from this component is a bug: it composes rules, and the
  // builder owns the only SQL path.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("the request box must not talk to the server");
    }),
  );
  render(
    <MoneyProvider unit="toman">
      <AudienceRequestBox onSeed={onSeed as never} />
    </MoneyProvider>,
  );
}

describe("the audience request box", () => {
  it("says nothing until a sentence has been typed", () => {
    renderBox();
    expect(screen.queryByText("این شرط‌ها خوانده شد:")).toBeNull();
    expect(screen.queryByText("این واژه‌ها خوانده نشد:")).toBeNull();
    expect(screen.queryByRole("button", { name: "ریختن در فرم بخش" })).toBeNull();
  });

  it("shows the clause in the builder's own words", async () => {
    const user = userEvent.setup();
    renderBox();
    await user.type(
      screen.getByLabelText("درخواست بخش با جمله"),
      "بیش از ۱ میلیون تومان خرید کرده‌اند",
    );
    expect(await screen.findByText("این شرط‌ها خوانده شد:")).toBeTruthy();
    // The readback is the builder's own `describeRule` — the same sentence the
    // segment card shows — so the box never invents a second dialect.
    expect(screen.getByText(/مجموع خرید حداقل/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "ریختن در فرم بخش" }),
    ).toBeTruthy();
  });

  it("hands the understood rules to the builder, and nothing else", async () => {
    const user = userEvent.setup();
    const seeds: unknown[] = [];
    renderBox((definition) => seeds.push(definition));
    await user.type(
      screen.getByLabelText("درخواست بخش با جمله"),
      "بیش از ۱ میلیون تومان خرید کرده‌اند و ایمیل دارند",
    );
    await user.click(screen.getByRole("button", { name: "ریختن در فرم بخش" }));
    // Spoken in Toman, handed over in Rial: the conversion happened once, in the
    // reading, so the builder's form receives what its own inputs store.
    expect(seeds).toEqual([
      {
        all: [
          { field: "totalSpentRial", op: "gte", value: 10_000_000 },
          { field: "hasEmail", op: "is", value: true },
        ],
      },
    ]);
  });

  it("withholds the seed when a word went unread", async () => {
    const user = userEvent.setup();
    renderBox();
    await user.type(screen.getByLabelText("درخواست بخش با جمله"), "ساکن تهران و خوش‌شانس");
    // The words come back, in the member's own spelling…
    expect(await screen.findByText("این واژه‌ها خوانده نشد:")).toBeTruthy();
    expect(screen.getByText("خوش‌شانس")).toBeTruthy();
    // …and the half-understood sentence cannot be poured into the form.
    expect(screen.queryByRole("button", { name: "ریختن در فرم بخش" })).toBeNull();
  });

  it("reads an example sentence when one is clicked", async () => {
    const user = userEvent.setup();
    renderBox();
    await user.click(screen.getByRole("button", { name: /ساکن تهران/ }));
    expect(await screen.findByText("این شرط‌ها خوانده شد:")).toBeTruthy();
    expect(screen.getByText("نشانی شامل «تهران»")).toBeTruthy();
    expect(screen.getByText("بیش از 90 روز است خرید نکرده")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "ریختن در فرم بخش" }),
    ).toBeTruthy();
  });
});
