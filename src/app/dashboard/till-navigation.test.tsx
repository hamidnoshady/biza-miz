// src/app/dashboard/till-navigation.test.tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SidebarProvider } from "@/components/ui/sidebar";
import { TillNavigation } from "./till-navigation";

beforeAll(() => {
  window.matchMedia ??= ((query: string) =>
    ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList);
});

afterEach(() => {
  cleanup();
  delete window.businessSuiteDesktop;
});

function renderTill(cloudUrl: string | null) {
  render(
    <SidebarProvider>
      <TillNavigation navItems={[]} pathname="/pos" cloudUrl={cloudUrl} />
    </SidebarProvider>,
  );
}

describe("TillNavigation's cloud door", () => {
  it("opens the cloud's home through the same address the hand-off builds", () => {
    const openCloud = vi.fn(async () => true);
    window.businessSuiteDesktop = { openCloud } as unknown as NonNullable<typeof window.businessSuiteDesktop>;
    renderTill("https://cafe.example.com/some/path");
    fireEvent.click(screen.getByRole("button", { name: /نسخهٔ ابری/ }));
    expect(openCloud).toHaveBeenCalledWith("https://cafe.example.com/");
  });

  it("is not drawn for an address the hand-off would refuse", () => {
    for (const cloudUrl of [null, "http://cafe.example.com", "not a url"]) {
      renderTill(cloudUrl);
      expect(screen.queryByRole("button", { name: /نسخهٔ ابری/ })).toBeNull();
      cleanup();
    }
  });
});
