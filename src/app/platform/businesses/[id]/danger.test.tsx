// @vitest-environment jsdom

/**
 * The danger zone's confirmation contract (issue #822), proven at the DOM:
 *
 *  - reset and delete demand DIFFERENT target-specific phrases
 *    (`RESET {slug}` vs `DELETE {slug}`), and the destructive button stays
 *    disabled until the exact phrase is typed;
 *  - there is no `window.confirm()` anywhere in the flow — one dialog, one
 *    typed confirmation, button labels we control;
 *  - the Persian labels distinguish بازنشانی from حذف دائمی;
 *  - the protected platform-internal business renders no actionable
 *    destructive controls at all;
 *  - an API error is visible inside the dialog, loading blocks repeated
 *    submissions, reset success refreshes the workspace, and delete success
 *    navigates to `/platform/businesses`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { platformErrorText } from "@/lib/platform-errors";
import type { Business } from "./context";
import { RemovePanel, ResetPanel } from "./panels";
import BusinessDangerPage from "./danger/page";

const apiMock = vi.hoisted(() => vi.fn());
const routerPush = vi.hoisted(() => vi.fn());
const capabilitySet = vi.hoisted(() => new Set<string>(["business.reset", "business.delete"]));

const businessFixture = vi.hoisted(() => ({
  id: "biz-1",
  name: "کافه آلفا",
  slug: "cafe-alpha",
  subdomain: "cafe-alpha",
  status: "active",
  plan: "pro",
  timezone: "Asia/Tehran",
  industry: "food_service",
  ownershipKind: "customer",
  createdAt: "2026-01-01T00:00:00.000Z",
  suspendedAt: null,
  archivedAt: null,
  locationCount: 1,
  memberCount: 2,
  orderCount: 3,
  lastActivityAt: null,
})) as Business;

const ctx = vi.hoisted(() => ({
  business: null as Business | null,
  rootDomain: "example.test",
  reload: vi.fn(async () => {}),
  setNotice: vi.fn(),
}));

vi.mock("./context", () => ({
  useBusiness: () => ctx,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush }),
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ id: "biz-1" }),
}));

vi.mock("../../ui", () => ({
  api: apiMock,
  errorMessage: (code?: string) => platformErrorText(code),
  ErrorBox: ({ children }: { children: React.ReactNode }) =>
    children ? <div role="alert">{children}</div> : null,
  InfoBox: ({ children }: { children: React.ReactNode }) =>
    children ? <div>{children}</div> : null,
  Field: ({ label, children }: { label: string; children: React.ReactNode }) => (
    <label>
      <span>{label}</span>
      {children}
    </label>
  ),
  Button: ({
    children,
    onClick,
    disabled,
    variant,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    variant?: string;
    className?: string;
    type?: string;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled} data-variant={variant}>
      {children}
    </button>
  ),
  Card: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  ),
  inputClass: "input",
  useCan: () => (cap: string) => capabilitySet.has(cap),
  SkeletonRows: () => null,
}));

let confirmSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  ctx.business = { ...businessFixture };
  ctx.reload.mockClear();
  ctx.setNotice.mockClear();
  routerPush.mockClear();
  apiMock.mockReset();
  capabilitySet.clear();
  capabilitySet.add("business.reset");
  capabilitySet.add("business.delete");
  confirmSpy = vi.fn(() => true);
  window.confirm = confirmSpy;
});

afterEach(() => {
  cleanup();
});

function findConfirmationInput(): HTMLInputElement {
  return screen.getByLabelText("عبارت تأیید") as HTMLInputElement;
}

function openDialog(ctaLabel: string) {
  fireEvent.click(screen.getByRole("button", { name: ctaLabel }));
}

describe("distinct, target-specific confirmation phrases", () => {
  it("reset demands `RESET {slug}` and delete demands `DELETE {slug}` — never the same phrase", async () => {
    render(
      <>
        <ResetPanel />
        <RemovePanel />
      </>,
    );

    openDialog("بازنشانی و شروع مجدد");
    expect(
      await screen.findByText(/برای تأیید، عبارت زیر را دقیق وارد کنید: RESET cafe-alpha/),
    ).toBeTruthy();
    const resetButton = screen.getByRole("button", { name: "بازنشانی و شروع مجدد" });
    // Inside the dialog the same label is the final destructive action.
    expect((resetButton as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(findConfirmationInput(), { target: { value: "RESET cafe-alpha" } });
    await waitFor(() => {
      expect((screen.getAllByRole("button", { name: "بازنشانی و شروع مجدد" }).at(-1) as HTMLButtonElement).disabled).toBe(false);
    });
    // The delete phrase must not arm the reset action.
    fireEvent.change(findConfirmationInput(), { target: { value: "DELETE cafe-alpha" } });
    await waitFor(() => {
      expect((screen.getAllByRole("button", { name: "بازنشانی و شروع مجدد" }).at(-1) as HTMLButtonElement).disabled).toBe(true);
    });
    // Close via the explicit cancel button.
    fireEvent.click(screen.getByRole("button", { name: "انصراف" }));

    openDialog("حذف دائمی کسب‌وکار");
    expect(
      await screen.findByText(/برای تأیید، عبارت زیر را دقیق وارد کنید: DELETE cafe-alpha/),
    ).toBeTruthy();
    const deleteButton = screen.getAllByRole("button", { name: "حذف دائمی کسب‌وکار" }).at(-1) as HTMLButtonElement;
    expect(deleteButton.disabled).toBe(true);
    fireEvent.change(findConfirmationInput(), { target: { value: "RESET cafe-alpha" } });
    await waitFor(() => {
      expect((screen.getAllByRole("button", { name: "حذف دائمی کسب‌وکار" }).at(-1) as HTMLButtonElement).disabled).toBe(true);
    });
    fireEvent.change(findConfirmationInput(), { target: { value: "DELETE cafe-alpha" } });
    await waitFor(() => {
      expect((screen.getAllByRole("button", { name: "حذف دائمی کسب‌وکار" }).at(-1) as HTMLButtonElement).disabled).toBe(false);
    });
  });
});

describe("no native confirm, Persian labels, dialog flow", () => {
  it("never calls window.confirm and uses the design-system dialog with an explicit cancel", async () => {
    apiMock.mockResolvedValue({ ok: true, status: 200, data: { ok: true } });
    render(<ResetPanel />);

    openDialog("بازنشانی و شروع مجدد");
    expect(await screen.findByText(/کسب‌وکار «کافه آلفا» بازنشانی می‌شود/)).toBeTruthy();
    // The dialog names the target's identity.
    expect(screen.getByText("cafe-alpha")).toBeTruthy();
    expect(screen.getByText("cafe-alpha.example.test")).toBeTruthy();

    fireEvent.change(findConfirmationInput(), { target: { value: "RESET cafe-alpha" } });
    fireEvent.click(screen.getAllByRole("button", { name: "بازنشانی و شروع مجدد" }).at(-1)!);

    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1));
    expect(confirmSpy).not.toHaveBeenCalled();
    // The request carried the typed phrase, not a hardcoded literal.
    expect(apiMock.mock.calls[0][1].body).toContain("RESET cafe-alpha");
    // Success refreshes the workspace.
    await waitFor(() => expect(ctx.reload).toHaveBeenCalled());
  });

  it("renders the Persian card titles and cancel label from the issue", () => {
    render(
      <>
        <ResetPanel />
        <RemovePanel />
      </>,
    );
    expect(screen.getByRole("heading", { name: "بازنشانی کسب‌وکار" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "حذف دائمی کسب‌وکار" })).toBeTruthy();
    openDialog("بازنشانی و شروع مجدد");
    expect(screen.getByRole("button", { name: "انصراف" })).toBeTruthy();
  });

  it("shows API errors inside the dialog and keeps it open", async () => {
    apiMock.mockResolvedValue({
      ok: false,
      status: 409,
      data: { error: "protected_internal_business" },
    });
    render(<ResetPanel />);
    openDialog("بازنشانی و شروع مجدد");

    fireEvent.change(findConfirmationInput(), { target: { value: "RESET cafe-alpha" } });
    fireEvent.click(screen.getAllByRole("button", { name: "بازنشانی و شروع مجدد" }).at(-1)!);

    const message = platformErrorText("protected_internal_business");
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(message)).toBeTruthy();
    // Dialog still open — the typed phrase is still there, the operator can retry.
    expect(screen.getByLabelText("عبارت تأیید")).toBeTruthy();
  });

  it("disables repeated submissions while the request is in flight", async () => {
    let release: (value: { ok: boolean; status: number; data: unknown }) => void = () => {};
    apiMock.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    render(<ResetPanel />);
    openDialog("بازنشانی و شروع مجدد");
    fireEvent.change(findConfirmationInput(), { target: { value: "RESET cafe-alpha" } });

    const action = () => screen.getAllByRole("button", { name: /بازنشانی و شروع مجدد|در حال بازنشانی/ }).at(-1) as HTMLButtonElement;
    fireEvent.click(action());
    await waitFor(() => expect(screen.getByText("در حال بازنشانی…")).toBeTruthy());
    expect(action().disabled).toBe(true);
    fireEvent.click(action());
    fireEvent.click(action());
    expect(apiMock).toHaveBeenCalledTimes(1);

    release({ ok: true, status: 200, data: { ok: true } });
    await waitFor(() => expect(ctx.reload).toHaveBeenCalled());
  });

  it("delete success navigates to the business list, not the console home", async () => {
    apiMock.mockResolvedValue({ ok: true, status: 200, data: { ok: true } });
    render(<RemovePanel />);
    openDialog("حذف دائمی کسب‌وکار");
    fireEvent.change(findConfirmationInput(), { target: { value: "DELETE cafe-alpha" } });
    fireEvent.click(screen.getAllByRole("button", { name: "حذف دائمی کسب‌وکار" }).at(-1)!);
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/platform/businesses"));
  });
});

describe("the protected platform-internal business", () => {
  it("renders no actionable destructive controls, and the page explains why", () => {
    ctx.business = { ...businessFixture, ownershipKind: "platform_internal" };
    render(
      <>
        <BusinessDangerPage />
        <ResetPanel />
        <RemovePanel />
      </>,
    );
    expect(screen.getByText("کسب‌وکار محافظت‌شده")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "بازنشانی و شروع مجدد" })).toBeNull();
    expect(screen.queryByRole("button", { name: "حذف دائمی کسب‌وکار" })).toBeNull();
  });
});
