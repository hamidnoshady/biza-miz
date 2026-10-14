// @vitest-environment jsdom

/**
 * `CrmAssigneePicker` — the one control that answers «مسئول کدام عضو است؟»
 * on the deals board, the activity dialog, the service desk and the leads list.
 *
 * What is pinned here, in order of how much damage the alternative does:
 *
 *  1. **A legacy name survives.** A row written before the id columns existed
 *     has a name and no member. Opening its dialog and saving an unrelated
 *     field must not erase the assignment — the picker offers the recorded name
 *     and keeps it selected.
 *  2. **A choice is an id plus the name to snapshot.** The two are written
 *     together; a picker that emitted only one would leave the row with an
 *     owner nobody can display, or a name nobody can act on.
 *  3. **Departures stay visible.** An inactive member is offered, marked — the
 *     reassignment list is exactly where a person who has left needs to appear.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CrmAssigneePicker } from "./crm-assignee-picker";

afterEach(cleanup);

const MEMBERS = [
  { id: "member-active", name: "زهرا کریمی", role: "manager", isActive: true },
  { id: "member-gone", name: "عضو غیرفعال", role: "manager", isActive: false },
];

function stubMembers() {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ members: MEMBERS }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function select() {
  return screen.getByRole("combobox") as HTMLSelectElement;
}

describe("CrmAssigneePicker", () => {
  it("offers the members, marking the ones who have left", async () => {
    stubMembers();
    render(<CrmAssigneePicker value={{ userId: "", name: "" }} onChange={() => {}} />);
    await waitFor(() => expect(screen.getByText("زهرا کریمی")).toBeTruthy());
    // Offered rather than filtered out: reassignment starts by seeing who holds
    // what, and a hidden member is one nobody can take work from.
    expect(screen.getByText("عضو غیرفعال (غیرفعال)")).toBeTruthy();
    expect(select().value).toBe("");
  });

  it("emits the id and the name the row will keep", async () => {
    stubMembers();
    const onChange = vi.fn();
    render(<CrmAssigneePicker value={{ userId: "", name: "" }} onChange={onChange} />);
    await waitFor(() => expect(screen.getByText("زهرا کریمی")).toBeTruthy());
    await userEvent.selectOptions(select(), "member-active");
    expect(onChange).toHaveBeenCalledWith({ userId: "member-active", name: "زهرا کریمی" });
  });

  it("keeps a recorded name that has no member", async () => {
    stubMembers();
    const onChange = vi.fn();
    render(
      <CrmAssigneePicker value={{ userId: "", name: "آقای قدیمی" }} onChange={onChange} />,
    );
    const option = await screen.findByText("آقای قدیمی (نام ثبت‌شدهٔ قبلی)");
    expect(option).toBeTruthy();
    // Selected, so saving something else leaves the row as it was.
    expect(select().value).toBe("__legacy__");
  });

  it("hands the recorded name back when it is re-chosen", async () => {
    stubMembers();
    const onChange = vi.fn();
    render(<CrmAssigneePicker value={{ userId: "", name: "آقای قدیمی" }} onChange={onChange} />);
    await waitFor(() => expect(screen.getByText("زهرا کریمی")).toBeTruthy());
    // Pick a member, then the legacy name again — the second choice must be the
    // name, not an empty assignment.
    await userEvent.selectOptions(select(), "member-active");
    await userEvent.selectOptions(select(), "__legacy__");
    expect(onChange).toHaveBeenLastCalledWith({ userId: "", name: "آقای قدیمی" });
  });

  it("clears both halves on «بدون مسئول»", async () => {
    stubMembers();
    const onChange = vi.fn();
    render(
      <CrmAssigneePicker value={{ userId: "member-active", name: "زهرا کریمی" }} onChange={onChange} />,
    );
    await waitFor(() => expect(screen.getByText("زهرا کریمی")).toBeTruthy());
    await userEvent.selectOptions(select(), "");
    expect(onChange).toHaveBeenCalledWith({ userId: "", name: "" });
  });

  it("does not offer a superseded name once a member is chosen", async () => {
    stubMembers();
    const { rerender } = render(
      <CrmAssigneePicker value={{ userId: "", name: "آقای قدیمی" }} onChange={() => {}} />,
    );
    rerender(
      <CrmAssigneePicker value={{ userId: "member-active", name: "زهرا کریمی" }} onChange={() => {}} />,
    );
    await waitFor(() => expect(screen.getByText("زهرا کریمی")).toBeTruthy());
    expect(screen.queryByText("آقای قدیمی (نام ثبت‌شدهٔ قبلی)")).toBeNull();
  });
});
