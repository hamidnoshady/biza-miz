// @vitest-environment jsdom

/**
 * «مدیریت وب‌سایت» home: the onboarding material (setup progress, the «which
 * option» comparison) is for a business with no website. Once a site exists the
 * page is that site's status.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type React from "react";
import type { WebsiteHomeState } from "@/lib/website/managers-service";

const home = vi.hoisted(() => ({ state: null as unknown as WebsiteHomeState }));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));
vi.mock("@/lib/auth", () => ({ getSession: async () => ({ businessId: "b1" }) }));
vi.mock("@/lib/website/managers-service", () => ({ websiteHomeState: async () => home.state }));
vi.mock("@/app/dashboard/knowledge-help", () => ({ KnowledgeHelpButton: () => null }));
vi.mock("@/components/ai/ask-assistant", () => ({ AskAssistant: () => null }));

import { WebsiteAppHome } from "./website-home";

const setup = {
  stage: "domain",
  domain: null,
  siteType: null,
  lastError: null,
} as unknown as WebsiteHomeState["setup"];

function state(patch: Partial<WebsiteHomeState["managers"]> = {}): WebsiteHomeState {
  return {
    setup,
    managers: {
      cms: { connected: false, domain: null, setupStep: null, siteType: null },
      wp: { connected: false, storeCount: 0 },
      ...patch,
    },
  };
}

async function renderHome() {
  render(await WebsiteAppHome());
}

beforeEach(() => {
  home.state = state();
});
afterEach(cleanup);

describe("WebsiteAppHome", () => {
  it("offers onboarding and the comparison to a business with no website", async () => {
    await renderHome();
    expect(screen.getByText("کدام گزینه برای من مناسب است؟")).toBeTruthy();
    expect(screen.getByText("پیشرفت راه‌اندازی")).toBeTruthy();
    expect(screen.getByRole("link", { name: /اتصال فروشگاه وردپرسی/ })).toBeTruthy();
  });

  it("shows only the connected site's status — no onboarding — once a WordPress store exists", async () => {
    home.state = state({ wp: { connected: true, storeCount: 1 } });
    await renderHome();
    expect(screen.queryByText("کدام گزینه برای من مناسب است؟")).toBeNull();
    expect(screen.queryByText("پیشرفت راه‌اندازی")).toBeNull();
    expect(screen.getByRole("link", { name: /مدیریت فروشگاه/ }).getAttribute("href")).toBe("/websites/wp");
    // Section shortcuts, and a quiet offer for the manager that is not connected.
    expect(screen.getByRole("link", { name: "سفارش‌ها" }).getAttribute("href")).toBe("/websites/wp/orders");
    expect(screen.getByText("افزودن سایت دیگر")).toBeTruthy();
  });

  it("shows both sites and no «add another» offer when both are connected", async () => {
    home.state = state({
      cms: { connected: true, domain: "acme.ir", setupStep: "built", siteType: "store" },
      wp: { connected: true, storeCount: 2 },
    });
    await renderHome();
    expect(screen.getByText("acme.ir")).toBeTruthy();
    expect(screen.getByRole("link", { name: /مدیریت سایت$/ }).getAttribute("href")).toBe("/websites/cms");
    expect(screen.queryByText("افزودن سایت دیگر")).toBeNull();
    expect(screen.queryByText("پیشرفت راه‌اندازی")).toBeNull();
  });
});
