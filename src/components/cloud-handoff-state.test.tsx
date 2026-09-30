// src/components/cloud-handoff-state.test.tsx
// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudHandoffState, cloudHandoffUrl } from "./cloud-handoff-state";

afterEach(() => {
  cleanup();
  delete window.businessSuiteDesktop;
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
});

describe("cloudHandoffUrl", () => {
  it("builds the same screen on the cloud, https only", () => {
    expect(cloudHandoffUrl("https://cafe.example.com", "/accounting/reports?tab=sales")).toBe(
      "https://cafe.example.com/accounting/reports?tab=sales",
    );
    expect(cloudHandoffUrl("http://cafe.example.com", "/crm/overview")).toBeNull();
    expect(cloudHandoffUrl(null, "/crm/overview")).toBeNull();
  });
});

describe("CloudHandoffState", () => {
  it("opens the screen in the cloud window on the desktop", async () => {
    const openCloud = vi.fn(async () => true);
    window.businessSuiteDesktop = { openCloud } as unknown as NonNullable<typeof window.businessSuiteDesktop>;
    render(<CloudHandoffState pathname="/accounting/reports" cloudUrl="https://cafe.example.com" />);
    await waitFor(() => expect(openCloud).toHaveBeenCalledWith("https://cafe.example.com/accounting/reports"));
    expect(await screen.findByText(/در پنجرهٔ «نسخهٔ ابری» باز شد/)).toBeTruthy();
  });

  it("gives a phone on the LAN a new-tab link instead", async () => {
    render(<CloudHandoffState pathname="/crm/overview" cloudUrl="https://cafe.example.com" />);
    const link = await screen.findByRole("link", { name: /بازکردن نسخهٔ ابری/ });
    expect(link.getAttribute("href")).toBe("https://cafe.example.com/crm/overview");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("says the screen needs the Internet when offline, and does not try to open it", async () => {
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    const openCloud = vi.fn(async () => true);
    window.businessSuiteDesktop = { openCloud } as unknown as NonNullable<typeof window.businessSuiteDesktop>;
    render(<CloudHandoffState pathname="/accounting/reports" cloudUrl="https://cafe.example.com" />);
    expect(await screen.findByText("این بخش به اینترنت نیاز دارد")).toBeTruthy();
    expect(openCloud).not.toHaveBeenCalled();
  });

  it("explains when no cloud address is configured", () => {
    render(<CloudHandoffState pathname="/accounting/reports" cloudUrl={null} />);
    expect(screen.getByText(/نشانی نسخهٔ ابری تنظیم نشده است/)).toBeTruthy();
  });
});
