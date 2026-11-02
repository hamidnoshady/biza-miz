// @vitest-environment jsdom

/**
 * «مدیریت وب‌سایت» home (issue #1215 / P1‑1): one card per actual site, the two
 * ways to get another one at the bottom, onboarding only for a verified empty
 * portfolio, and an honest error where the old page said «هنوز سایتی ندارید».
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type React from "react";
import type { WebsiteHomeState } from "@/lib/website/managers-service";
import type { SitePortfolioState, StoreSiteCard } from "@/lib/website/site-portfolio";

const home = vi.hoisted(() => ({ state: null as unknown as WebsiteHomeState }));
const portfolio = vi.hoisted(() => ({ state: null as unknown as SitePortfolioState }));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));
vi.mock("@/lib/auth", () => ({ getSession: async () => ({ businessId: "b1" }) }));
vi.mock("@/lib/member-access", () => ({
  memberAccessFor: async () => ({
    role: "owner",
    isActive: true,
    permissions: new Set(["cms.view", "cms.configure", "woocommerce.view", "woocommerce.configure"]),
  }),
}));
vi.mock("@/lib/website/managers-service", () => ({ websiteHomeState: async () => home.state }));
vi.mock("@/lib/website/portfolio-service", () => ({ websitePortfolioState: async () => portfolio.state }));
vi.mock("@/app/dashboard/knowledge-help", () => ({ KnowledgeHelpButton: () => null }));
vi.mock("@/components/ai/ask-assistant", () => ({ AskAssistant: () => null }));

import { WebsiteAppHome } from "./website-home";
import { WORDPRESS_PLUGIN_ZIP_URL } from "@/lib/integrations/wp-plugin-release";

const setup = {
  stage: "domain",
  domain: null,
  siteType: null,
  lastError: null,
} as unknown as WebsiteHomeState["setup"];

const READ_AT = "2026-11-01T09:00:00.000Z";

function homeState(patch: Partial<WebsiteHomeState["managers"]> = {}): WebsiteHomeState {
  return {
    setup,
    managers: {
      cms: { connected: false, domain: null, setupStep: null, siteType: null },
      wp: { connected: false, storeCount: 0 },
      ...patch,
    },
  };
}

function portfolioState(patch: Partial<SitePortfolioState> = {}): SitePortfolioState {
  return {
    readAt: READ_AT,
    cms: { status: "ok", value: null },
    stores: { status: "ok", value: [] },
    ...patch,
  };
}

function storeCard(patch: Partial<StoreSiteCard> = {}): StoreSiteCard {
  return {
    kind: "woocommerce",
    id: "store-1",
    name: "فروشگاه مرکزی",
    domain: "shop.example.com",
    url: "https://shop.example.com",
    linkMode: "plugin",
    state: "active",
    lastVerifiedAt: "2026-11-01T08:55:00.000Z",
    verificationSource: "plugin_heartbeat",
    lastAppliedAt: "2026-11-01T08:40:00.000Z",
    products: 12,
    orders: 4,
    work: { pending: 0, failed: 0 },
    ...patch,
  };
}

const CMS_CARD = {
  kind: "cms" as const,
  id: "cms-1",
  domain: "acme.example",
  state: "active" as const,
  lastCheckedAt: "2026-11-01T08:00:00.000Z",
  lastAppliedAt: null,
  syncedProducts: 3,
  work: { pending: 0, failed: 0 },
};

async function renderHome() {
  render(await WebsiteAppHome());
}

beforeEach(() => {
  home.state = homeState();
  portfolio.state = portfolioState();
});
afterEach(cleanup);

describe("WebsiteAppHome — no site yet", () => {
  it("offers the two real options, the official plugin zip and the comparison", async () => {
    await renderHome();
    expect(screen.getByText("ساخت سایت در بیزامیز")).toBeTruthy();
    expect(screen.getAllByText("اتصال فروشگاه وردپرسی").length).toBeGreaterThan(0);
    expect(screen.getByText("پیشرفت راه‌اندازی")).toBeTruthy();
    expect(screen.getByText("کدام گزینه برای من مناسب است؟")).toBeTruthy();

    const downloads = screen.getAllByRole("link", { name: /افزونهٔ رسمی بیزامیز|دانلود افزونه/ });
    expect(downloads.length).toBeGreaterThan(0);
    expect(downloads[0].getAttribute("href")).toBe(WORDPRESS_PLUGIN_ZIP_URL);
    // The REST alternative is named beside the plugin, not hidden behind it.
    expect(screen.getByText(/REST/)).toBeTruthy();
  });
});

describe("WebsiteAppHome — sites exist", () => {
  it("shows one card per WordPress store with that store's own facts and links", async () => {
    home.state = homeState({ wp: { connected: true, storeCount: 2 } });
    portfolio.state = portfolioState({
      stores: {
        status: "ok",
        value: [
          storeCard({ id: "s1", name: "شعبهٔ یک", domain: "one.example.com", products: 12, orders: 4 }),
          storeCard({ id: "s2", name: "شعبهٔ دو", domain: "two.example.com", state: "paused", products: 7, orders: 0 }),
        ],
      },
    });
    await renderHome();

    expect(screen.queryByText("کدام گزینه برای من مناسب است؟")).toBeNull();
    expect(screen.queryByText("پیشرفت راه‌اندازی")).toBeNull();

    expect(screen.getByText("شعبهٔ یک — one.example.com")).toBeTruthy();
    expect(screen.getByText("شعبهٔ دو — two.example.com")).toBeTruthy();
    // Two independent cards, each with its own store-scoped navigation — and
    // the store that needs attention comes first.
    // «بازکردن فروشگاه» opens the store's recorded address, not a guessed host.
    expect(screen.getAllByRole("link", { name: /بازکردن فروشگاه/ })[0].getAttribute("href")).toBe(
      "https://shop.example.com",
    );
    const manageLinks = screen.getAllByRole("link", { name: /مدیریت فروشگاه/ });
    expect(manageLinks.map((link) => link.getAttribute("href"))).toEqual([
      "/websites/wp?store=s2",
      "/websites/wp?store=s1",
    ]);
    const ordersLinks = screen.getAllByRole("link", { name: "سفارش‌ها" });
    expect(ordersLinks.map((link) => link.getAttribute("href"))).toEqual([
      "/websites/wp/orders?store=s2",
      "/websites/wp/orders?store=s1",
    ]);
    // The paused store says so, instead of inheriting the configured «active».
    expect(screen.getByText("متوقف")).toBeTruthy();
  });

  it("keeps «افزودن سایت دیگر» at the bottom even when both systems are in use", async () => {
    home.state = homeState({
      cms: { connected: true, domain: "acme.example", setupStep: "built", siteType: "store" },
      wp: { connected: true, storeCount: 1 },
    });
    portfolio.state = portfolioState({ cms: { status: "ok", value: CMS_CARD }, stores: { status: "ok", value: [storeCard()] } });
    await renderHome();

    expect(screen.getAllByText("acme.example").length).toBeGreaterThan(0);
    expect(screen.getByText("افزودن سایت دیگر")).toBeTruthy();
    // One CMS site per business: no «build another CMS» offer, but another store is fine.
    expect(screen.queryByRole("link", { name: /ساخت سایت در بیزامیز/ })).toBeNull();
    expect(screen.getByRole("link", { name: /اتصال فروشگاه وردپرسی دیگر/ }).getAttribute("href")).toBe(
      "/settings/connections?tab=woocommerce",
    );
  });

  it("shows «نامشخص» for facts nobody could read instead of a green summary", async () => {
    portfolio.state = portfolioState({
      stores: {
        status: "ok",
        value: [
          storeCard({
            id: "s1",
            domain: null,
            state: "unverified",
            lastVerifiedAt: null,
            verificationSource: null,
            lastAppliedAt: null,
          }),
        ],
      },
    });
    await renderHome();
    expect(screen.getByText("تأییدنشده")).toBeTruthy();
    expect(screen.getAllByText("نامشخص").length).toBeGreaterThan(0);
  });
});

describe("WebsiteAppHome — failed and refused reads", () => {
  it("never tells a business with an unreadable portfolio that it has no website", async () => {
    portfolio.state = portfolioState({ cms: { status: "error" }, stores: { status: "error" } });
    await renderHome();

    expect(screen.queryByText("کدام گزینه برای من مناسب است؟")).toBeNull();
    expect(screen.queryByText("ساخت سایت در بیزامیز")).toBeNull();
    expect(screen.getByText("وضعیت سایت‌ها خوانده نشد")).toBeTruthy();
    expect(screen.getByRole("link", { name: /تلاش دوباره/ }).getAttribute("href")).toBe("/websites/overview");
  });

  it("renders the half it could read and a retry for the other half", async () => {
    portfolio.state = portfolioState({ stores: { status: "ok", value: [storeCard()] }, cms: { status: "error" } });
    await renderHome();

    expect(screen.getByText("فروشگاه مرکزی — shop.example.com")).toBeTruthy();
    expect(screen.getByText("وضعیت سایت بیزامیز خوانده نشد")).toBeTruthy();
    expect(screen.queryByText("کدام گزینه برای من مناسب است؟")).toBeNull();
  });

  it("shows a permission card — never onboarding — when neither half is readable", async () => {
    portfolio.state = portfolioState({ cms: { status: "denied" }, stores: { status: "denied" } });
    await renderHome();

    expect(screen.queryByText("کدام گزینه برای من مناسب است؟")).toBeNull();
    expect(screen.getByText("دسترسی به وضعیت سایت‌ها")).toBeTruthy();
    expect(screen.getByText(/به معنی نبودِ سایت نیست/)).toBeTruthy();
    // A refusal is not an error: no «تلاش دوباره» that could never succeed.
    expect(screen.queryByRole("link", { name: /تلاش دوباره/ })).toBeNull();
  });

  it("treats a missing permission as missing access, not as a missing store", async () => {
    portfolio.state = portfolioState({ stores: { status: "denied" } });
    await renderHome();

    expect(screen.queryByText("کدام گزینه برای من مناسب است؟")).toBeNull();
    const notice = screen.getByText("دسترسی به فروشگاه‌های وردپرس");
    expect(within(notice.closest("section") as HTMLElement).getByText(/به معنی نبودِ فروشگاه نیست/)).toBeTruthy();
  });
});
