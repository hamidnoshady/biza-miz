// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => vi.fn());

vi.mock("@/app/dashboard/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/dashboard/ui")>();
  return { ...actual, api: apiMock };
});

import { EditorialAssistant, describeAssistantError, draftTarget } from "./editorial-assistant";

function setup(overrides: Partial<Parameters<typeof EditorialAssistant>[0]> = {}) {
  const onInsert = vi.fn();
  render(
    <EditorialAssistant
      connectionId="store-1"
      type="post"
      title="نگهداری فرش"
      content="<p>متن فعلی</p>"
      excerpt="خلاصه"
      disabled={false}
      canEditContent
      onInsert={onInsert}
      {...overrides}
    />,
  );
  return { onInsert };
}

beforeEach(() => {
  apiMock.mockReset();
  apiMock.mockResolvedValue({ ok: true, status: 200, data: { ok: true, draft: { text: "پیش‌نویس تازه" }, costRial: 1500 } });
});

afterEach(cleanup);

describe("editorial assistant", () => {
  it("sends the editor's unsaved text and the chosen action", async () => {
    const user = userEvent.setup();
    setup();

    await user.selectOptions(screen.getByLabelText("کار دستیار تحریریه"), "shorten");
    await user.click(screen.getByRole("button", { name: "تولید پیش‌نویس" }));

    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1));
    const [path, init] = apiMock.mock.calls[0];
    expect(path).toBe("/api/integrations/wp-manager/content/posts/ai");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      connectionId: "store-1",
      type: "post",
      action: "shorten",
      title: "نگهداری فرش",
      content: "<p>متن فعلی</p>",
      excerpt: "خلاصه",
    });
  });

  it("only fills a field when the owner presses insert — the draft itself saves nothing", async () => {
    const user = userEvent.setup();
    const { onInsert } = setup();

    await user.click(screen.getByRole("button", { name: "تولید پیش‌نویس" }));
    expect(await screen.findByText("پیش‌نویس تازه")).toBeTruthy();
    // Nothing has been placed anywhere yet, and only the AI endpoint was called.
    expect(onInsert).not.toHaveBeenCalled();
    expect(apiMock).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "جایگزینی متن با این پیش‌نویس" }));
    expect(onInsert).toHaveBeenCalledWith("content", "پیش‌نویس تازه", "replace");
    expect(screen.getByText(/هنوز ذخیره نشده است/)).toBeTruthy();
  });

  it("offers append for an expansion and replacement for a rewrite", async () => {
    const user = userEvent.setup();
    const { onInsert } = setup();

    await user.selectOptions(screen.getByLabelText("کار دستیار تحریریه"), "expand");
    await user.click(screen.getByRole("button", { name: "تولید پیش‌نویس" }));
    expect(screen.queryByRole("button", { name: "جایگزینی متن با این پیش‌نویس" })).toBeNull();
    await user.click(await screen.findByRole("button", { name: "افزودن به پایان متن" }));

    expect(onInsert).toHaveBeenCalledWith("content", "پیش‌نویس تازه", "append");
  });

  it("puts a title suggestion in the title field, not the body", async () => {
    const user = userEvent.setup();
    const { onInsert } = setup();

    await user.selectOptions(screen.getByLabelText("کار دستیار تحریریه"), "title");
    await user.click(screen.getByRole("button", { name: "تولید پیش‌نویس" }));
    await user.click(await screen.findByRole("button", { name: "گذاشتن در فیلد عنوان" }));

    expect(onInsert).toHaveBeenCalledWith("title", "پیش‌نویس تازه", "replace");
  });

  it("shows tone and language pickers only for the actions that use them", async () => {
    const user = userEvent.setup();
    setup();

    expect(screen.queryByLabelText("لحن پیشنهادی")).toBeNull();
    await user.selectOptions(screen.getByLabelText("کار دستیار تحریریه"), "tone");
    expect(screen.getByLabelText("لحن پیشنهادی")).toBeTruthy();
    expect(screen.queryByLabelText("زبان مقصد ترجمه")).toBeNull();

    await user.selectOptions(screen.getByLabelText("کار دستیار تحریریه"), "translate");
    expect(screen.getByLabelText("زبان مقصد ترجمه")).toBeTruthy();
    expect(screen.queryByLabelText("لحن پیشنهادی")).toBeNull();
  });

  it("sends the tone it was given", async () => {
    const user = userEvent.setup();
    setup();

    await user.selectOptions(screen.getByLabelText("کار دستیار تحریریه"), "tone");
    await user.selectOptions(screen.getByLabelText("لحن پیشنهادی"), "formal");
    await user.click(screen.getByRole("button", { name: "تولید پیش‌نویس" }));

    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(apiMock.mock.calls[0][1].body)).tone).toBe("formal");
  });

  it("names each refusal instead of showing a raw code", async () => {
    const user = userEvent.setup();
    setup();

    for (const [code, text] of [
      ["ai_credit_required", /اعتبار کیف پول/],
      ["ai_unavailable", /سرویس هوش مصنوعی/],
      ["connection_paused", /اتصال این سایت متوقف است/],
    ] as const) {
      apiMock.mockResolvedValueOnce({ ok: false, status: 402, data: { error: code } });
      await user.click(screen.getByRole("button", { name: "تولید پیش‌نویس" }));
      expect(await screen.findByText(text)).toBeTruthy();
      cleanup();
      setup();
    }
  });

  it("will not improve an empty editor", () => {
    setup({ title: "", content: "", excerpt: "" });

    expect((screen.getByRole("button", { name: "تولید پیش‌نویس" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/اول عنوان یا متنی بنویسید/)).toBeTruthy();
  });

  it("asks for a title before outlining a blank page", async () => {
    const user = userEvent.setup();
    setup({ title: "", content: "", excerpt: "" });

    await user.selectOptions(screen.getByLabelText("کار دستیار تحریریه"), "outline");
    expect(screen.getByText(/برای «طرح کلی پیشنهادی» اول عنوان را بنویسید/)).toBeTruthy();
  });

  it("keeps the draft out of the body when the raw HTML never arrived", async () => {
    const user = userEvent.setup();
    setup({ canEditContent: false });

    await user.click(screen.getByRole("button", { name: "تولید پیش‌نویس" }));
    const replace = await screen.findByRole("button", { name: "جایگزینی متن با این پیش‌نویس" });
    expect((replace as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/متن خام این مورد در دسترس نیست/)).toBeTruthy();
  });
});

describe("editorial assistant helpers", () => {
  it("maps each action to the field it belongs in", () => {
    expect(draftTarget("title")).toBe("title");
    expect(draftTarget("excerpt")).toBe("excerpt");
    expect(draftTarget("outline")).toBe("content");
    expect(draftTarget("translate")).toBe("content");
  });

  it("falls back to the server message for an unknown code", () => {
    expect(describeAssistantError("unknown_thing", "پیام سرور")).toBe("پیام سرور");
    expect(describeAssistantError("")).toContain("دستیار تحریریه");
  });
});
