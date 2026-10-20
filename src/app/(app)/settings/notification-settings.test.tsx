// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationSettings } from "./notification-settings";
vi.mock("@/components/native/native-provider", () => ({ useNative: () => ({ kind: "web" }) }));
vi.mock("./push-client", () => ({
  pushSupport: () => ({ supported: true }),
  currentSubscriptionEndpoint: vi.fn(async () => null),
  enablePush: vi.fn(async () => {
    throw new Error("offline");
  }),
  disablePush: vi.fn(),
}));
const base = {
  eventKey: "shift.cash_variance",
  ruleId: null as string | null,
  isDefault: true,
  enabled: true,
  channels: ["push", "inapp"],
  minSeverity: "info",
  minAmountRial: 10000,
  quietFromMinutes: null,
  quietToMinutes: null,
};
let preference = { ...base };
let posts: Record<string, unknown>[];
let pending: ((value: Response) => void)[];
let hold: boolean;
let fail: boolean;
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
beforeEach(() => {
  preference = { ...base };
  posts = [];
  pending = [];
  hold = false;
  fail = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/rules") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as typeof preference;
        posts.push(body);
        if (hold) return new Promise<Response>((resolve) => pending.push(resolve));
        if (fail) return json({ messages: ["server failed"] }, 500);
        preference = { ...body, ruleId: "rule" };
        return json({ rule: { id: "rule" } });
      }
      if (url.includes("/rules"))
        return json({
          events: [
            {
              key: "shift.cash_variance",
              group: "money",
              label: "کسری صندوق",
              description: "توضیح",
              hasAmount: true,
              defaultSeverity: "important",
            },
          ],
          preferences: [preference],
          locations: [],
        });
      if (url.includes("/devices")) return json({ devices: [], stats: [] });
      if (url.includes("/preferences"))
        return json({ mode: "digest", timezone: "UTC", digest_minutes: 5 });
      throw new Error(`unexpected ${url}`);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
async function amount() {
  render(<NotificationSettings />);
  return screen.findByLabelText(
    "فقط اگر مبلغ از این بیشتر بود (تومان)",
  ) as Promise<HTMLInputElement>;
}
describe("notification amount and mutation controls", () => {
  it("preserves Persian typed drafts across rerenders and stores integer Rial including zero and clearing", async () => {
    const input = await amount();
    fireEvent.change(input, { target: { value: "۱۲٬۳۴۵" } });
    fireEvent.change(screen.getByLabelText("منطقه زمانی شما (IANA؛ خالی = شعبه)"), {
      target: { value: "Asia/Tehran" },
    });
    expect(input.value).toBe("۱۲٬۳۴۵");
    fireEvent.blur(input);
    await waitFor(() => expect(posts[0]?.minAmountRial).toBe(123450));
    await screen.findByText("ذخیره شد");
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.blur(input);
    await waitFor(() => expect(posts[1]?.minAmountRial).toBe(0));
    await screen.findByText("ذخیره شد");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    await waitFor(() => expect(posts[2]?.minAmountRial).toBeNull());
  });
  it("preserves the amount draft on a server error and allows retry", async () => {
    fail = true;
    const input = await amount();
    fireEvent.change(input, { target: { value: "۵۰۰" } });
    fireEvent.blur(input);
    await screen.findByText("server failed");
    expect(input.value).toBe("۵۰۰");
    fail = false;
    fireEvent.blur(input);
    await waitFor(() => expect(posts).toHaveLength(2));
    await screen.findByText("ذخیره شد");
  });
  it("rejects an unsafe amount without writing it", async () => {
    const input = await amount();
    fireEvent.change(input, { target: { value: "9999999999999999" } });
    fireEvent.blur(input);
    await screen.findByText("حداقل مبلغ باید عددی صحیح و مثبت باشد.");
    expect(posts).toHaveLength(0);
  });
  it("serializes rapid changes and ignores stale responses", async () => {
    hold = true;
    await amount();
    const checkbox = screen.getByRole("checkbox", { name: /کسری صندوق/ });
    fireEvent.click(checkbox);
    await waitFor(() => expect(posts).toHaveLength(1));
    fireEvent.click(checkbox);
    expect((checkbox as HTMLInputElement).checked).toBe(true);
    expect(posts).toHaveLength(1);
    await act(async () => {
      pending.shift()!(json({ rule: { id: "old" } }));
    });
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1].enabled).toBe(true);
    expect((checkbox as HTMLInputElement).checked).toBe(true);
    await act(async () => {
      pending.shift()!(json({ rule: { id: "latest" } }));
    });
    await screen.findByText("ذخیره شد");
    expect((checkbox as HTMLInputElement).checked).toBe(true);
  });
  it("clears device pending state after a rejected browser operation", async () => {
    await amount();
    const button = screen.getByRole("button", { name: "فعال کردن روی این دستگاه" });
    fireEvent.click(button);
    await screen.findByText("offline");
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });
});
