// @vitest-environment jsdom

/**
 * Issue #824 §8 / review item 4 — the platform settings «حسابداری» tab must be
 * a *shortcut* to the canonical editor, not a second one.
 *
 * The regression this pins down is the shape of the tab: it may explain and
 * link, but it must not render any chart-of-accounts UI, and its links must
 * point at the real accounting routes so old `/settings/accounts` deep links
 * land somewhere useful.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AccountsSettings } from "./accounts-settings";
import { accountingSectionHref } from "@/app/(app)/accounting/accounting-routes";
import { settingsTabForSlug, canonicalSettingsHrefForTabParam } from "@/lib/settings-routes";

afterEach(cleanup);

describe("Settings → «حسابداری» is a shortcut, not an editor", () => {
  it("links to the canonical chart-of-accounts route and the accounting settings", () => {
    render(<AccountsSettings />);

    const canonical = screen.getByRole("link", { name: /باز کردن مدیریت سرفصل/ }) as HTMLAnchorElement;
    expect(canonical.getAttribute("href")).toBe(accountingSectionHref("chart-of-accounts"));
    expect(canonical.getAttribute("href")).toBe("/accounting/chart-of-accounts");

    const settings = screen.getByRole("link", { name: /تنظیمات حسابداری/ }) as HTMLAnchorElement;
    expect(settings.getAttribute("href")).toBe(accountingSectionHref("settings"));
  });

  it("renders no chart editing controls at all", () => {
    render(<AccountsSettings />);
    // The old duplicate editor's controls must be gone, not merely hidden.
    expect(screen.queryByRole("button", { name: "افزودن حساب" })).toBeNull();
    expect(screen.queryByRole("button", { name: "حذف" })).toBeNull();
    expect(screen.queryByRole("button", { name: "ویرایش" })).toBeNull();
    expect(screen.queryByPlaceholderText("نام حساب")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    // …and it says where the editor went.
    expect(screen.getByText(/منتقل شده است/)).toBeTruthy();
  });

  it("stays a known settings section so old deep links keep resolving", () => {
    // `/settings/accounts` (and the older `/settings?tab=accounts`) must still
    // land on this tab rather than a 404.
    expect(settingsTabForSlug("accounts")).toBe("accounts");
    expect(canonicalSettingsHrefForTabParam("accounts")).toBe("/settings/accounts");
  });
});
