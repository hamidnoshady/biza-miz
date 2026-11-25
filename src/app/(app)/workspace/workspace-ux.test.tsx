// @vitest-environment jsdom

/**
 * Issue #907's remaining UI/UX findings, pinned:
 *
 * - F05 the create/edit panel is a right-side offcanvas with an action row
 *   whose buttons fit at both widths;
 * - F10 a large picker is searchable and names an empty result;
 * - F11 view/filter state is owned by the URL;
 * - F14 the project owner's role and removal controls are not offered as if
 *   they would succeed.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PickerField, FormActions, WorkspaceFormPanel } from "./workspace-ui";
import { TeamsSection } from "./teams-section";
import { EMPTY_LOOKUPS } from "./use-workspace-lookups";
import { useWorkspaceUrlFlag, useWorkspaceUrlState } from "./use-workspace-url-state";

const mocks = vi.hoisted(() => ({ params: new URLSearchParams() }));

vi.mock("next/navigation", () => ({
  useSearchParams: () => mocks.params,
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("WorkspaceFormPanel — offcanvas form shell (#907 F05)", () => {
  it("is a labelled right-side panel that closes on Escape, not on a stray outside tap", () => {
    const onClose = vi.fn();
    render(
      <WorkspaceFormPanel title="وظیفهٔ جدید" onClose={onClose}>
        <input aria-label="عنوان" />
      </WorkspaceFormPanel>,
    );
    const dialog = screen.getByRole("dialog", { name: "وظیفهٔ جدید" });
    // Radix marks the side on the content; "right" is what makes it a panel.
    expect(dialog.getAttribute("data-slot")).toBe("sheet-content");
    expect(dialog.className).toContain("right-0");

    fireEvent.pointerDown(document.body);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps both actions inside one footer that shrinks them beside each other", () => {
    render(
      <FormActions>
        <button type="button">بستن</button>
        <button type="button">ذخیره</button>
      </FormActions>,
    );
    const footer = screen.getByRole("button", { name: "ذخیره" }).parentElement as HTMLElement;
    expect(footer.className).toContain("sm:[&>button]:w-auto");
    expect(within(footer).getByRole("button", { name: "بستن" })).toBeTruthy();
  });
});

describe("PickerField — searchable large relations (#907 F10)", () => {
  const options = [
    { id: "1", label: "شرکت آلفا" },
    { id: "2", label: "شرکت بتا" },
    { id: "3", label: "طرف حساب گاما" },
  ];

  it("filters the options by name and keeps the current selection", async () => {
    const user = userEvent.setup();
    render(
      <PickerField
        label="طرف قرارداد"
        value="3"
        onChange={() => {}}
        options={options}
        searchable
        searchPlaceholder="جست‌وجوی طرف قرارداد…"
      />,
    );
    await user.type(screen.getByLabelText(/جست‌وجوی طرف قرارداد… طرف قرارداد/), "آلفا");
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    const values = Array.from(select.querySelectorAll("option")).map((option) => option.value);
    // The match and the still-selected party; not an unrelated one.
    expect(values).toEqual(["", "1", "3"]);
  });

  it("says so when nothing matches instead of rendering an empty select", async () => {
    const user = userEvent.setup();
    render(
      <PickerField
        label="طرف قرارداد"
        value=""
        onChange={() => {}}
        options={options}
        searchable
        searchPlaceholder="جست‌وجو…"
      />,
    );
    await user.type(screen.getByLabelText(/جست‌وجو… طرف قرارداد/), "دلتا");
    expect(screen.getByText("موردی با این نام پیدا نشد.")).toBeTruthy();
  });
});

describe("URL-owned view state (#907 F11)", () => {
  function Probe() {
    const [value, setValue] = useWorkspaceUrlState("status", "");
    const [mine, setMine] = useWorkspaceUrlFlag("mine");
    return (
      <div>
        <span data-testid="status">{value || "none"}</span>
        <button type="button" onClick={() => setValue("active")}>
          active
        </button>
        <button type="button" onClick={() => setMine(true)}>
          mine
        </button>
        <span data-testid="mine">{String(mine)}</span>
      </div>
    );
  }

  beforeEach(() => {
    mocks.params = new URLSearchParams();
    window.history.replaceState(null, "", "/workspace/projects");
  });

  it("reads the value the URL carries on first render", () => {
    mocks.params = new URLSearchParams("status=completed&mine=true");
    render(<Probe />);
    expect(screen.getByTestId("status").textContent).toBe("completed");
    expect(screen.getByTestId("mine").textContent).toBe("true");
  });

  it("writes a filter change back to the address", async () => {
    const user = userEvent.setup();
    render(<Probe />);
    await user.click(screen.getByRole("button", { name: "active" }));
    expect(window.location.search).toContain("status=active");
    expect(screen.getByTestId("status").textContent).toBe("active");

    await user.click(screen.getByRole("button", { name: "mine" }));
    expect(window.location.search).toContain("mine=true");
  });
});

describe("TeamsSection — the owner's controls tell the truth (#907 F14)", () => {
  function stubMembers() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/workspace/projects/p1/members") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              members: [
                {
                  id: "m1",
                  projectId: "p1",
                  userId: "u1",
                  fullName: "سارا مالک",
                  role: "owner",
                  createdAt: "2026-01-01T00:00:00.000Z",
                  openTasks: 0,
                  overdueTasks: 0,
                  doneThisWeek: 0,
                },
                {
                  id: "m2",
                  projectId: "p1",
                  userId: "u2",
                  fullName: "رضا ویرایشگر",
                  role: "editor",
                  createdAt: "2026-01-02T00:00:00.000Z",
                  openTasks: 1,
                  overdueTasks: 0,
                  doneThisWeek: 0,
                },
              ],
            }),
          };
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
  }

  it("does not offer to demote or remove the named owner", async () => {
    stubMembers();
    render(
      <TeamsSection
        lookups={{ ...EMPTY_LOOKUPS, projects: [{ id: "p1", name: "پروژهٔ یک" }] }}
        canManage
      />,
    );
    await screen.findByText("سارا مالک");

    expect(screen.queryByLabelText("نقش سارا مالک")).toBeNull();
    expect(screen.getByLabelText("نقش رضا ویرایشگر")).toBeTruthy();

    const removeOwner = screen.getByRole("button", { name: "حذف سارا مالک" });
    expect((removeOwner as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/برای تغییر نقش، ابتدا مالکیت را منتقل کنید/)).toBeTruthy();

    const removeEditor = screen.getByRole("button", { name: "حذف رضا ویرایشگر" });
    expect((removeEditor as HTMLButtonElement).disabled).toBe(false);
  });

  it("ignores an out-of-order member response when the project changes (#907 F12)", async () => {
    let resolveFirst: ((value: unknown) => void) | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url === "/api/workspace/projects/p1/members") {
          return new Promise((resolve) => {
            resolveFirst = resolve;
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            members: [
              {
                id: "m9",
                projectId: "p2",
                userId: "u9",
                fullName: "عضو پروژهٔ دوم",
                role: "viewer",
                createdAt: "2026-01-03T00:00:00.000Z",
                openTasks: 0,
                overdueTasks: 0,
                doneThisWeek: 0,
              },
            ],
          }),
        });
      }),
    );
    render(
      <TeamsSection
        lookups={{
          ...EMPTY_LOOKUPS,
          projects: [
            { id: "p1", name: "پروژهٔ یک" },
            { id: "p2", name: "پروژهٔ دوم" },
          ],
        }}
        canManage
      />,
    );

    await userEvent.setup().selectOptions(screen.getByLabelText("پروژه"), "p2");
    await screen.findByText("عضو پروژهٔ دوم");

    // The slow first project's answer arrives last and must be discarded.
    await act(async () => {
      resolveFirst?.({
        ok: true,
        status: 200,
        json: async () => ({
          members: [
            {
              id: "m1",
              projectId: "p1",
              userId: "u1",
              fullName: "عضو دیررس",
              role: "owner",
              createdAt: "2026-01-01T00:00:00.000Z",
              openTasks: 0,
              overdueTasks: 0,
              doneThisWeek: 0,
            },
          ],
        }),
      });
    });

    await waitFor(() => expect(screen.queryByText("عضو دیررس")).toBeNull());
  });
});
