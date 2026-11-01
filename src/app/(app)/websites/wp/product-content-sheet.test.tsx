/** @vitest-environment jsdom */
//
// The storefront content sheet (issue #1215, P1-2). What is asserted is the
// promise the screen makes to an owner looking at a live shopfront:
//
//   * the text shown is the *store's* text, fetched per product;
//   * typing saves nothing, and Apply is the only path to the store — and it
//     posts exactly the two description fields the route accepts;
//   * the AI button asks for a draft and puts it beside the field; it never
//     posts an edit;
//   * a paused connection is readable but not writable;
//   * images are shown with the store's alt text and editing is not pretended.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children?: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("@/app/dashboard/ui", () => ({
  api: vi.fn(),
  errorMessageOrRaw: (message: string) => message,
  ErrorBox: ({ children }: { children?: React.ReactNode }) => <div role="alert">{children}</div>,
  InfoBox: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  inputClass: "",
}));

import { api } from "@/app/dashboard/ui";
import { ProductContentSheet } from "./product-content-sheet";

const CONNECTION_ID = "conn-1";
const REMOTE_ID = "55";

function content(overrides: Record<string, unknown> = {}) {
  return {
    remoteId: REMOTE_ID,
    localId: "item-55",
    name: "جاکفشی چوبی",
    sku: "SKU-55",
    wooType: "simple",
    remoteStatus: "publish",
    shortDescription: "کوتاه فروشگاه",
    description: "<p>بلند فروشگاه</p>",
    image: { src: "https://shop.example/a.jpg", alt: "جاکفشی از روبه‌رو" },
    gallery: [{ src: "https://shop.example/b.jpg", alt: "از پهلو" }],
    galleryCount: 2,
    remoteModifiedAt: "2026-10-30T10:00:00Z",
    lastSeenAt: "2026-10-31T10:00:00Z",
    queue: null,
    ...overrides,
  };
}

function mockRead(overrides: Record<string, unknown> = {}, canWrite = true) {
  vi.mocked(api).mockImplementation(async (url: string) => {
    if (typeof url === "string" && url.endsWith(`/store/products/${REMOTE_ID}`)) {
      return { ok: true, status: 200, aborted: false, data: { product: content(overrides), canWrite } };
    }
    return { ok: true, status: 200, aborted: false, data: {} };
  });
}

const call = vi.fn(async () => ({ ok: true, queued: true })) as unknown as React.ComponentProps<
  typeof ProductContentSheet
>["call"];

function renderSheet(overrides: Partial<React.ComponentProps<typeof ProductContentSheet>> = {}) {
  return render(
    <ProductContentSheet
      connectionId={CONNECTION_ID}
      remoteId={REMOTE_ID}
      productName="جاکفشی چوبی"
      canWrite
      call={call}
      onClose={vi.fn()}
      {...overrides}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRead();
});

afterEach(() => cleanup());

describe("ProductContentSheet — the store's text, edited on purpose", () => {
  it("reads the product's own storefront text from the store", async () => {
    renderSheet();
    expect(await screen.findByLabelText("توضیح کوتاه فروشگاه")).toHaveProperty("value", "کوتاه فروشگاه");
    expect(api).toHaveBeenCalledWith(
      `/api/integrations/connections/${CONNECTION_ID}/store/products/${REMOTE_ID}`,
      expect.anything(),
    );
  });

  it("saves nothing while typing, and Apply posts only the two description fields", async () => {
    const user = userEvent.setup();
    renderSheet();
    const short = await screen.findByLabelText("توضیح کوتاه فروشگاه");
    await user.clear(short);
    await user.type(short, "کوتاه تازه");

    // Typing is a draft: nothing has been sent anywhere.
    expect(call).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "اعمال در فروشگاه (صف ارسال)" }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    const [path, method, body] = vi.mocked(call).mock.calls[0] as unknown as [string, string, Record<string, unknown>];
    expect(path).toBe(`/api/integrations/connections/${CONNECTION_ID}/store/products`);
    expect(method).toBe("POST");
    expect(body).toEqual({
      remoteId: REMOTE_ID,
      fields: { short_description: "کوتاه تازه", description: "<p>بلند فروشگاه</p>" },
    });
    // The confirmation is honest about the outbox: queued, not applied.
    expect(await screen.findByText(/در صف ارسال به فروشگاه قرار گرفت/)).toBeTruthy();
  });

  it("shows the line diff of an unsaved change before anything is sent", async () => {
    const user = userEvent.setup();
    renderSheet();
    const long = await screen.findByLabelText("توضیح بلند فروشگاه");
    await user.clear(long);
    await user.type(long, "<p>بلند تازه</p>");
    await user.click(screen.getByRole("button", { name: "پیش‌نمایش تغییرات" }));
    expect(await screen.findByText("− <p>بلند فروشگاه</p>")).toBeTruthy();
    expect(screen.getByText("+ <p>بلند تازه</p>")).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
  });

  it("asks the AI for a draft and leaves the decision to the human", async () => {
    const user = userEvent.setup();
    vi.mocked(api).mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.endsWith("/ai")) {
        return {
          ok: true,
          status: 200,
          aborted: false,
          data: { ok: true, draft: { shortDescription: "پیشنهاد کوتاه", longDescription: "پیشنهاد بلند" }, costRial: 1200 },
        };
      }
      if (typeof url === "string" && url.endsWith(`/store/products/${REMOTE_ID}`)) {
        return { ok: true, status: 200, aborted: false, data: { product: content(), canWrite: true } };
      }
      return { ok: true, status: 200, aborted: false, data: {} };
    });
    renderSheet();
    await screen.findByLabelText("توضیح کوتاه فروشگاه");
    await user.click(screen.getByRole("button", { name: "تولید با هوش مصنوعی" }));

    expect(await screen.findByText("پیشنهاد کوتاه")).toBeTruthy();
    // The draft is a suggestion in the panel; no edit left the browser.
    expect(call).not.toHaveBeenCalled();
    expect(screen.getByLabelText("توضیح کوتاه فروشگاه")).toHaveProperty("value", "کوتاه فروشگاه");

    await user.click(screen.getByRole("button", { name: "گذاشتن در فیلد کوتاه" }));
    expect(screen.getByLabelText("توضیح کوتاه فروشگاه")).toHaveProperty("value", "پیشنهاد کوتاه");
    // Still nothing sent: the field is dirty, the store is untouched.
    expect(call).not.toHaveBeenCalled();
  });

  it("keeps a paused connection readable and disables its writes", async () => {
    renderSheet({ canWrite: false });
    const short = await screen.findByLabelText("توضیح کوتاه فروشگاه");
    expect(short).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "اعمال در فروشگاه (صف ارسال)" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "تولید با هوش مصنوعی" })).toHaveProperty("disabled", true);
    expect(screen.getByText(/این اتصال متوقف است/)).toBeTruthy();
  });

  it("shows the store's imagery with its alt text and says editing it is not supported yet", async () => {
    const user = userEvent.setup();
    renderSheet();
    await screen.findByLabelText("توضیح کوتاه فروشگاه");
    await user.click(screen.getByRole("button", { name: "تصاویر و گالری" }));
    const figure = await screen.findByAltText("جاکفشی از روبه‌رو");
    expect(figure).toBeTruthy();
    expect(screen.getByAltText("از پهلو")).toBeTruthy();
    expect(screen.getByText(/جایگزینی یا جابه‌جایی تصاویر از این صفحه هنوز پشتیبانی نمی‌شود/)).toBeTruthy();
  });

  it("warns before closing over unsaved text instead of silently dropping it", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderSheet({ onClose });
    const short = await screen.findByLabelText("توضیح کوتاه فروشگاه");
    await user.type(short, "!");
    await user.click(screen.getByRole("button", { name: "بستن پنجره" }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText(/تغییرهای ذخیره‌نشده دارید/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "بستن بدون ذخیره" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("reports a read failure instead of showing an empty, editable product", async () => {
    vi.mocked(api).mockResolvedValue({
      ok: false,
      status: 404,
      aborted: false,
      data: { error: "product_not_mapped" },
    } as never);
    renderSheet();
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(/نگاشت نشده/)).toBeTruthy();
    expect(screen.queryByLabelText("توضیح کوتاه فروشگاه")).toBeNull();
  });
});
