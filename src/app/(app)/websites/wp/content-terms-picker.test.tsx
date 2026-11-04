// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContentTermsPicker } from "./content-terms-picker";

afterEach(cleanup);

const CATEGORIES = [
  { id: 2, name: "دستهٔ اصلی", parent: 0, count: 12 },
  { id: 5, name: "فرش", parent: 2, count: 4 },
];
const TAGS = [
  { id: 9, name: "راهنما", parent: 0, count: 3 },
  { id: 11, name: "نگهداری", parent: 0, count: 0 },
];

function setup(overrides: Partial<Parameters<typeof ContentTermsPicker>[0]> = {}) {
  const onChange = vi.fn();
  render(
    <ContentTermsPicker
      categories={CATEGORIES}
      tags={TAGS}
      selected={{ categories: [], tags: [] }}
      loading={false}
      unsupported={false}
      partial={false}
      disabled={false}
      onChange={onChange}
      {...overrides}
    />,
  );
  return { onChange };
}

describe("content terms picker", () => {
  it("offers the site's own terms with their usage, and nothing else", () => {
    setup();

    expect(screen.getByRole("checkbox", { name: "دستهٔ اصلی" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "راهنما" })).toBeTruthy();
    // A term nobody used yet still appears — the owner may be about to use it.
    expect(screen.getByRole("checkbox", { name: "نگهداری" })).toBeTruthy();
  });

  it("adds a term to the selection and removes it again", async () => {
    const user = userEvent.setup();
    const { onChange } = setup({ selected: { categories: [2], tags: [] } });

    await user.click(screen.getByRole("checkbox", { name: "راهنما" }));
    expect(onChange).toHaveBeenCalledWith({ categories: [2], tags: [9] });
  });

  it("keeps a selected term the reported list does not carry, and lets it be removed", () => {
    setup({ selected: { categories: [], tags: [77] } });

    // The plugin reports the most-used terms; a post's own rare tag must not
    // disappear from the screen that describes it.
    expect(screen.getByText(/۱ مورد از برچسب‌ها این نوشته در فهرست سایت نیست/)).toBeTruthy();
    expect(screen.getByText(/#۷۷/)).toBeTruthy();
  });

  it("says a plugin reported no list instead of drawing an empty one", () => {
    setup({ unsupported: true, categories: [], tags: [] });

    expect(screen.getByText(/فهرست دسته‌ها و برچسب‌ها را گزارش نمی‌کند/)).toBeTruthy();
    expect(screen.queryByLabelText("دستهٔ اصلی")).toBeNull();
  });

  it("names a partial read and keeps the half that loaded", () => {
    setup({ partial: true, categories: [] });

    expect(screen.getByText(/بخشی از فهرست خوانده نشد/)).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "راهنما" })).toBeTruthy();
    expect(screen.getByText(/این سایت هنوز دسته‌ها ندارد/)).toBeTruthy();
  });

  it("shows a reading state while the terms are on their way", () => {
    setup({ loading: true, categories: [], tags: [] });

    expect(screen.getByLabelText("در حال خواندن دسته‌ها و برچسب‌های سایت")).toBeTruthy();
  });

  it("disables every input while a save is in flight", () => {
    setup({ disabled: true });

    expect((screen.getByRole("checkbox", { name: "راهنما" }) as HTMLInputElement).disabled).toBe(true);
  });
});
