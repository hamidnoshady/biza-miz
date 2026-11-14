// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { AssignmentPlanFilters } from "./assignment-plan-filters";

vi.mock("@/app/dashboard/jalali-date-picker", () => ({
  JalaliDatePicker: ({ ariaLabel, value, onChange }: { ariaLabel: string; value: string; onChange: (value: string) => void }) =>
    <input aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)} />,
}));
afterEach(cleanup);
it("applies only valid ranges and clears all draft and applied filters", async () => {
  const onApply = vi.fn(); const user = userEvent.setup();
  render(<AssignmentPlanFilters disabled={false} onApply={onApply} />);
  await user.selectOptions(screen.getByLabelText("وضعیت ماموریت"), "planned");
  await user.selectOptions(screen.getByLabelText("ترتیب ماموریت‌ها"), "due_asc");
  await user.type(screen.getByLabelText("مهلت از"), "2026-11-03");
  await user.type(screen.getByLabelText("مهلت تا"), "2026-11-01");
  await user.click(screen.getByRole("button", { name: "اعمال فیلتر ماموریت‌ها" }));
  expect(onApply).not.toHaveBeenCalled(); expect(screen.getByText(/بازهٔ مهلت معتبر نیست/)).toBeTruthy();
  await user.clear(screen.getByLabelText("مهلت تا")); await user.type(screen.getByLabelText("مهلت تا"), "2026-11-30");
  await user.click(screen.getByRole("button", { name: "اعمال فیلتر ماموریت‌ها" }));
  expect(onApply).toHaveBeenLastCalledWith({ status: "planned", dueFrom: "2026-11-03", dueTo: "2026-11-30", sort: "due_asc" });
  await user.click(screen.getByRole("button", { name: "پاک کردن فیلتر ماموریت‌ها" }));
  expect(onApply).toHaveBeenLastCalledWith({ status: null, dueFrom: null, dueTo: null, sort: "newest" });
  expect((screen.getByLabelText("مهلت از") as HTMLInputElement).value).toBe("");
});
