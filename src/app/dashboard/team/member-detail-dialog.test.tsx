// @vitest-environment jsdom

/**
 * The member detail surface, rendered (issue #947, TEAM-F08).
 *
 * `team-manager.test.ts` pins the wiring by reading the sources, and the roster's data is
 * pinned in `integration/team.integration.test.ts` — but neither can see what a reader
 * actually gets: which sections appear, which buttons a `team.view` visit is *not* offered,
 * and whether the hand-offs open the dialogs that own the write. That is what this file
 * renders, because the two failure modes it guards are both invisible to a source grep:
 *
 *  1. **A button whose only outcome is a 403.** The screen must offer what the reader may
 *     do, not what would look tidy — so the permission-dependent controls are asserted in
 *     both directions, with the refusal copy instead of the door.
 *  2. **A second editor.** Every mutation here closes this surface and opens the dialog
 *     the API already owns; the test asserts the hand-off happened, not just that a button
 *     exists.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PERMISSIONS } from "@/lib/permissions";
import {
  MemberDetailDialog,
  type MemberDetailSubject,
  type PersonnelFileDriftNotice,
} from "./member-detail-dialog";

afterEach(cleanup);

/** A member with everything a manager may see, and nothing owed. */
const MEMBER: MemberDetailSubject = {
  id: "50000000-0000-4000-8000-000000000001",
  fullName: "زهرا نمونه",
  email: "zahra@example.com",
  role: "cashier",
  customRoleName: null,
  isActive: true,
  status: "active",
  locationScope: "selected",
  locationIds: ["loc-1", "loc-2"],
  defaultLocationId: "loc-1",
  hasPin: true,
  hasLogin: true,
  phone: "09120000000",
  phoneVerified: true,
  effectivePermissions: ["pos.sell", "pos.refund"],
  createdAt: "2026-04-01T09:00:00.000Z",
  personnelFileId: "60000000-0000-4000-8000-000000000001",
  personnelFileDrift: false,
};

const HANDLERS = {
  onClose: vi.fn(),
  onEdit: vi.fn(),
  onEditPhone: vi.fn(),
  onEditCredentials: vi.fn(),
  onLinkFile: vi.fn(),
  onOpenFiles: vi.fn(),
  onRehire: vi.fn(),
};

function renderDialog(
  member: Partial<MemberDetailSubject> = {},
  props: {
    drift?: PersonnelFileDriftNotice | null;
    isSelf?: boolean;
    canManage?: boolean;
    canManageOwners?: boolean;
    permissions?: readonly string[];
  } = {},
) {
  for (const handler of Object.values(HANDLERS)) handler.mockClear();
  render(
    <MemberDetailDialog
      member={{ ...MEMBER, ...member }}
      locationName={(id) => (id === "loc-1" ? "شعبهٔ مرکزی" : null)}
      drift={props.drift ?? null}
      isSelf={props.isSelf ?? false}
      canManage={props.canManage ?? true}
      canManageOwners={props.canManageOwners ?? false}
      permissions={props.permissions ?? [PERMISSIONS.teamManage, PERMISSIONS.payrollView]}
      {...HANDLERS}
    />,
  );
}

describe("the member detail surface (issue #947, TEAM-F08)", () => {
  it("reads the six sections and the facts behind them", () => {
    renderDialog();

    for (const title of [
      "نمای کلی",
      "دسترسی",
      "ورود و اعتبارنامه",
      "پروندهٔ پرسنلی",
      "مالی",
      "تاریخچه",
    ]) {
      expect(screen.getByText(title)).toBeTruthy();
    }

    expect(screen.getByText("زهرا نمونه")).toBeTruthy();
    // The status badge sits next to the name (the credential section states it again as a
    // fact), so the assertion is scoped to the title rather than to the whole surface.
    const title = screen.getByText("زهرا نمونه").parentElement as HTMLElement;
    expect(within(title).getByText("فعال")).toBeTruthy();
    // The branch is named, not spelled as an id, and the scope sentence precedes it.
    expect(screen.getByText(/شعبه‌های انتخابی — شعبهٔ مرکزی، loc-2/)).toBeTruthy();
    expect(screen.getByText(/حساب کاربری با ایمیل zahra@example\.com/)).toBeTruthy();
    expect(screen.getByText("ثبت شده و با حساب کاربری هم‌خوان است")).toBeTruthy();
  });

  it("offers a read-only visit the facts, the directory door and no writer", () => {
    renderDialog({}, { canManage: false, permissions: [PERMISSIONS.teamView] });

    expect(screen.queryByRole("button", { name: "ویرایش نقش و دسترسی" })).toBeNull();
    expect(screen.queryByRole("button", { name: "شمارهٔ موبایل" })).toBeNull();
    expect(screen.queryByRole("button", { name: "رمز ورود و نشست‌ها" })).toBeNull();
    expect(screen.queryByRole("button", { name: "بازگشت به کار" })).toBeNull();

    // Reading the file itself stays available: it is the roster's door, not a mutation.
    expect(screen.getByRole("button", { name: "پروندهٔ کارکنان" })).toBeTruthy();
    // The audit log's door follows `team.manage`, so a `team.view` visit is not offered it.
    expect(screen.queryByRole("link", { name: "مشاهدهٔ گزارش حسابرسی" })).toBeNull();
  });

  it("names the missing permission instead of linking to a screen it would refuse", () => {
    renderDialog({}, { canManage: true, permissions: [PERMISSIONS.teamManage] });

    expect(screen.queryByRole("link", { name: /در حسابداری/ })).toBeNull();
    expect(
      screen.getByText(/برای مشاهدهٔ اطلاعات حقوق و دستمزد به دسترسی «مشاهدهٔ حقوق و دستمزد» نیاز دارید\./),
    ).toBeTruthy();
    // `team.manage` is what the audit log wants, and this reader holds it.
    expect(screen.getByRole("link", { name: "مشاهدهٔ گزارش حسابرسی" })).toBeTruthy();
  });

  it("sends the payroll door to the accounting section it belongs to", () => {
    renderDialog();

    const link = screen.getByRole("link", { name: /در حسابداری/ });
    expect(link.getAttribute("href")).toBe("/accounting/payroll");
  });

  it("never lets a manager edit an owner, and marks the owner's own row", () => {
    renderDialog(
      { role: "owner", fullName: "مالک نهایی" },
      { canManage: true, canManageOwners: false, isSelf: false },
    );

    expect(screen.queryByRole("button", { name: "ویرایش نقش و دسترسی" })).toBeNull();
    expect(screen.getByText("مالک نهایی")).toBeTruthy();

    cleanup();
    renderDialog({ role: "owner" }, { canManage: true, canManageOwners: true, isSelf: true });
    expect(screen.getByText("(شما)")).toBeTruthy();
    expect(screen.getByText(/«پروفایل من» در\s+تنظیمات، مسیر خودسرویس شماست\./)).toBeTruthy();
  });

  it("reports a file the platform still owes, and offers the link only when there is none", () => {
    const drift: PersonnelFileDriftNotice = {
      userId: MEMBER.id,
      fullName: MEMBER.fullName,
      reason: "file_missing",
      lastError: "users_name_missing",
      attempts: 2,
      lastAttemptAt: "2026-10-14T06:00:00.000Z",
    };
    renderDialog(
      { personnelFileId: null, personnelFileDrift: true },
      { drift, canManage: true, permissions: [PERMISSIONS.teamManage] },
    );

    expect(screen.getByText("در انتظار ساخت — پلتفرم این پرونده را بدهکار است")).toBeTruthy();
    // The count and the reason are rendered, so «two attempts» is visible rather than implied.
    expect(screen.getByText(/پروندهٔ ناقص/)).toBeTruthy();
    expect(screen.getByText(/۲ تلاش/)).toBeTruthy();
    expect(screen.getByText(/\(users_name_missing\)/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "اتصال پروندهٔ پرسنلی" })).toBeTruthy();
  });

  it("hands every mutation to the dialog that owns it, and closes first", async () => {
    const user = userEvent.setup();

    renderDialog({ status: "offboarded" }, { canManage: true });
    await user.click(screen.getByRole("button", { name: "ویرایش نقش و دسترسی" }));
    expect(HANDLERS.onClose).toHaveBeenCalledTimes(1);
    expect(HANDLERS.onEdit).toHaveBeenCalledTimes(1);

    cleanup();
    renderDialog({ status: "offboarded" }, { canManage: true });
    await user.click(screen.getByRole("button", { name: "بازگشت به کار" }));
    expect(HANDLERS.onClose).toHaveBeenCalledTimes(1);
    expect(HANDLERS.onRehire).toHaveBeenCalledTimes(1);

    cleanup();
    renderDialog({ status: "offboarded" }, { canManage: true });
    await user.click(screen.getByRole("button", { name: "پروندهٔ کارکنان" }));
    expect(HANDLERS.onOpenFiles).toHaveBeenCalledTimes(1);
    expect(HANDLERS.onEdit).toHaveBeenCalledTimes(0);
  });
});
