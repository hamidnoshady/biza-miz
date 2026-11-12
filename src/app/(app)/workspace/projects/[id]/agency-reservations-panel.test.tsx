// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgencyReservationsPanel } from "./agency-reservations-panel";
vi.mock("@/app/dashboard/jalali-date-picker", () => ({
  JalaliDatePicker: ({
    value,
    onChange,
    ariaLabel,
    disabled,
  }: {
    value: string;
    onChange: (s: string) => void;
    ariaLabel: string;
    disabled: boolean;
  }) => (
    <input
      aria-label={ariaLabel}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));
const task = "11111111-1111-4111-8111-111111111111",
  worker = "22222222-2222-4222-8222-222222222222",
  id = "33333333-3333-4333-8333-333333333333";
const row = {
  id,
  taskId: task,
  workerId: worker,
  startAt: "2026-11-01T09:00:00.000Z",
  endAt: "2026-11-01T10:00:00.000Z",
  status: "reserved",
  note: "old note",
  createdByName: "مدیر",
  createdAt: "2026-10-30T12:00:00.000Z",
  workerName: "عضو",
  taskTitle: "کار",
  superseded: false,
};
const payload = (extra: Record<string, unknown> = {}) => ({
  rows: [row],
  nextOffset: null,
  timeZone: "Asia/Tehran",
  tasks: [{ id: task, title: "کار" }],
  workers: [{ id: worker, name: "عضو" }],
  canWrite: true,
  ...extra,
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function change(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}
async function load() {
  change("آغاز فیلتر رزرو", "2026-11-01");
  change("پایان فیلتر رزرو", "2026-11-30");
  await userEvent.click(screen.getByRole("button", { name: "نمایش رزروها" }));
  await screen.findByText(/تاریخ فیلتر و نمایش/);
}
describe("planned resource reservation panel", () => {
  it("requires a bounded query, labels plans distinct from actual time and hides mutation controls for readers", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(payload({ canWrite: false })), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetch);
    render(<AgencyReservationsPanel projectId="project" />);
    expect(fetch).not.toHaveBeenCalled();
    await load();
    expect(screen.getByText(/نه کارکرد واقعی/)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "لغو با ثبت دلیل" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "پیش‌نمایش رزرو" })).toBeNull();
  });
  it("previews explicit offsets before saving, invalidates stale previews and preserves request IDs on refusal", async () => {
    const writes: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          writes.push(JSON.parse(String(init.body)));
          return new Response(
            JSON.stringify({ error: "reservation_conflict" }),
            { status: 409 },
          );
        }
        return new Response(JSON.stringify(payload({ rows: [] })), {
          status: 200,
        });
      }),
    );
    render(<AgencyReservationsPanel projectId="project" />);
    await load();
    await userEvent.selectOptions(screen.getByLabelText("عضو رزرو"), worker);
    await userEvent.selectOptions(screen.getByLabelText("وظیفهٔ رزرو"), task);
    change("روز آغاز رزرو", "2026-11-01");
    change("روز پایان رزرو", "2026-11-01");
    change("ساعت آغاز رزرو", "09:00");
    change("ساعت پایان رزرو", "10:00");
    change("جابه‌جایی UTC زمان واردشده", "+03:30");
    change("شرح یا دلیل تغییر رزرو", "planned");
    await userEvent.click(
      screen.getByRole("button", { name: "پیش‌نمایش رزرو" }),
    );
    expect(writes).toHaveLength(0);
    expect(screen.getByText(/پیش‌نمایش در Asia\/Tehran/)).toBeTruthy();
    change("ساعت پایان رزرو", "10:30");
    expect(
      screen.queryByRole("button", { name: "تأیید و ثبت نسخهٔ رزرو" }),
    ).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "پیش‌نمایش رزرو" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "تأیید و ثبت نسخهٔ رزرو" }),
    );
    await screen.findByText(/نتیجهٔ ثبت نامشخص/);
    await userEvent.click(
      screen.getByRole("button", { name: "تأیید و ثبت نسخهٔ رزرو" }),
    );
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[0]).toEqual(writes[1]);
    expect(writes[0]).toMatchObject({
      startAt: "2026-11-01T05:30:00.000Z",
      endAt: "2026-11-01T07:00:00.000Z",
      workerId: worker,
      taskId: task,
      status: "reserved",
    });
    expect(writes[0]).not.toHaveProperty("createdBy");
  });
  it("keeps cancellation scope locked even for offboarded resources and requires a fresh reason", async () => {
    const writes: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          writes.push(JSON.parse(String(init.body)));
          return new Response(JSON.stringify({ id: "cancel" }), {
            status: 201,
          });
        }
        return new Response(JSON.stringify(payload({ workers: [] })), {
          status: 200,
        });
      }),
    );
    render(<AgencyReservationsPanel projectId="project" />);
    await load();
    await userEvent.click(
      screen.getByRole("button", { name: "لغو با ثبت دلیل" }),
    );
    expect(
      (screen.getByLabelText("عضو رزرو") as HTMLSelectElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByLabelText("روز آغاز رزرو") as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByLabelText("شرح یا دلیل تغییر رزرو") as HTMLTextAreaElement)
        .value,
    ).toBe("");
    change("شرح یا دلیل تغییر رزرو", "پایان همکاری");
    await userEvent.click(
      screen.getByRole("button", { name: "پیش‌نمایش رزرو" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "تأیید و ثبت نسخهٔ رزرو" }),
    );
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({
      status: "cancelled",
      supersedesId: id,
      startAt: row.startAt,
      endAt: row.endAt,
      workerId: worker,
      taskId: task,
    });
  });
  it("loads the next history page without claiming a total and clears previous-window rows", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (url: string) =>
          new Response(
            JSON.stringify(
              url.includes("offset=100")
                ? payload({
                    rows: [{ ...row, id: "second", note: "second page" }],
                  })
                : payload({ nextOffset: 100 }),
            ),
            { status: 200 },
          ),
      ),
    );
    render(<AgencyReservationsPanel projectId="project" />);
    await load();
    await userEvent.click(
      screen.getByRole("button", { name: "صفحهٔ بعدی رزروها" }),
    );
    await screen.findByText("second page");
    expect(screen.getByText("old note")).toBeTruthy();
    change("پایان فیلتر رزرو", "2026-11-29");
    expect(screen.queryByText("second page")).toBeNull();
    expect(screen.queryByText("old note")).toBeNull();
  });
});
