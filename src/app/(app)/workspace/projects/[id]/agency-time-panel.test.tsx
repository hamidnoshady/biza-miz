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
import { AgencyTimePanel } from "./agency-time-panel";
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
const record = {
  id: "time",
  taskId: "task",
  workDate: "2026-10-01",
  minutes: 60,
  note: "actual work",
  createdBy: "actor",
  createdByName: "عضو",
  createdAt: "2026-10-02T12:00:00Z",
  taskTitle: "کار",
  superseded: false,
};
const payload = (extra: Record<string, unknown> = {}) => ({
  rows: [record],
  tasks: [{ id: "task", title: "کار" }],
  totalMinutes: "600",
  canWrite: true,
  actorUserId: "actor",
  ...extra,
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("manual actual time panel", () => {
  it("labels missing time unknown and does not display write controls for readers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify(
              payload({ rows: [], totalMinutes: null, canWrite: false }),
            ),
            { status: 200 },
          ),
      ),
    );
    render(<AgencyTimePanel projectId="project" />);
    await screen.findByText(/نامشخص؛ ثبت فعالی نیست/);
    expect(screen.queryByRole("button", { name: "ثبت نسخهٔ زمان" })).toBeNull();
    expect(screen.getByText(/نه حضور و غیاب/)).toBeTruthy();
  });
  it("uses the complete server total, not a sum of loaded history", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify(payload()), { status: 200 }),
      ),
    );
    render(<AgencyTimePanel projectId="project" />);
    await screen.findByText(/۶۰۰/);
    expect(screen.getByText(/جمع بالا از کل ثبت‌های فعال/)).toBeTruthy();
  });
  it("preserves retry key and entered facts after refusal and never sends another worker ID", async () => {
    const writes: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          writes.push(JSON.parse(String(init.body)));
          return new Response(JSON.stringify({ error: "time_conflict" }), {
            status: 409,
          });
        }
        return new Response(JSON.stringify(payload({ rows: [] })), {
          status: 200,
        });
      }),
    );
    render(<AgencyTimePanel projectId="project" />);
    await screen.findByRole("button", { name: "ثبت نسخهٔ زمان" });
    await userEvent.selectOptions(screen.getByLabelText("وظیفهٔ زمان"), "task");
    fireEvent.change(screen.getByLabelText("روز انجام کار"), {
      target: { value: "2026-10-01" },
    });
    fireEvent.change(screen.getByLabelText("مدت کار به دقیقه"), {
      target: { value: "60" },
    });
    fireEvent.change(screen.getByLabelText("شرح کار یا دلیل اصلاح و ابطال"), {
      target: { value: "measured" },
    });
    await userEvent.click(
      screen.getByRole("button", { name: "ثبت نسخهٔ زمان" }),
    );
    await screen.findByText(/ثبت زمان پذیرفته نشد/);
    await userEvent.click(
      screen.getByRole("button", { name: "ثبت نسخهٔ زمان" }),
    );
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[0]).toEqual(writes[1]);
    expect(writes[0]).toMatchObject({
      minutes: 60,
      note: "measured",
      workDate: "2026-10-01",
      taskId: "task",
      supersedesId: null,
    });
    expect(writes[0]).not.toHaveProperty("createdBy");
  });
  it("locks correction lineage and requires a fresh explanation; zero explicitly voids", async () => {
    const writes: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          writes.push(JSON.parse(String(init.body)));
          return new Response(JSON.stringify({ id: "void" }), { status: 201 });
        }
        return new Response(JSON.stringify(payload()), { status: 200 });
      }),
    );
    render(<AgencyTimePanel projectId="project" />);
    await userEvent.click(
      await screen.findByRole("button", {
        name: "اصلاح یا ابطال با حفظ تاریخچه",
      }),
    );
    expect(
      (screen.getByLabelText("روز انجام کار") as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByLabelText("وظیفهٔ زمان") as HTMLSelectElement).disabled,
    ).toBe(true);
    expect(
      (
        screen.getByLabelText(
          "شرح کار یا دلیل اصلاح و ابطال",
        ) as HTMLTextAreaElement
      ).value,
    ).toBe("");
    fireEvent.change(screen.getByLabelText("مدت کار به دقیقه"), {
      target: { value: "0" },
    });
    fireEvent.change(screen.getByLabelText("شرح کار یا دلیل اصلاح و ابطال"), {
      target: { value: "wrong log" },
    });
    await userEvent.click(
      screen.getByRole("button", { name: "ثبت نسخهٔ زمان" }),
    );
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({
      minutes: 0,
      supersedesId: "time",
      taskId: "task",
      workDate: "2026-10-01",
    });
  });
});
