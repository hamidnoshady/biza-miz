// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLOUD_EMBED_UA_TOKEN, cloudThemeScript } from "@/lib/cloud-embed";
import { CloudPane } from "./cloud-pane";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const theme = vi.hoisted(() => ({ resolvedTheme: "dark" as string | undefined }));
vi.mock("next-themes", () => ({ useTheme: () => theme }));

function desktop(sessionCode: string | null = null) {
  window.businessSuiteDesktop = { embedsCloud: true } as unknown as NonNullable<typeof window.businessSuiteDesktop>;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ code: sessionCode }), { status: 200 })),
  );
}

afterEach(() => {
  cleanup();
  delete window.businessSuiteDesktop;
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
});

describe("CloudPane", () => {
  it("renders the cloud screen in a pinned, separate session on the desktop", async () => {
    desktop();
    const { container } = render(<CloudPane pathAndQuery="/crm/deals?tab=open" cloudUrl="https://cafe.example.com" />);
    await waitFor(() => expect(container.querySelector("webview")).not.toBeNull());
    const guest = container.querySelector("webview")!;
    expect(guest.getAttribute("src")).toBe("https://cafe.example.com/crm/deals?tab=open");
    expect(guest.getAttribute("partition")).toBe("persist:cloud");
    expect(guest.getAttribute("useragent")).toContain(CLOUD_EMBED_UA_TOKEN);
  });

  it("dresses the cloud screen in the desktop's theme and follows the toggle", async () => {
    desktop();
    theme.resolvedTheme = "dark";
    const { container, rerender } = render(<CloudPane pathAndQuery="/reports" cloudUrl="https://cafe.example.com" />);
    await waitFor(() => expect(container.querySelector("webview")).not.toBeNull());
    const guest = container.querySelector("webview") as HTMLElement & Record<string, unknown>;
    const executeJavaScript = vi.fn(async () => undefined);
    guest.executeJavaScript = executeJavaScript;
    guest.getURL = () => "https://cafe.example.com/reports";

    // The pane becomes `embedded` asynchronously (outside act), so the webview can
    // be in the DOM a tick before the passive effect that listens for dom-ready
    // has run. Fire dom-ready until that listener answers, instead of racing it.
    await waitFor(() => {
      guest.dispatchEvent(new Event("dom-ready"));
      expect(executeJavaScript).toHaveBeenLastCalledWith(cloudThemeScript("dark"));
    });

    theme.resolvedTheme = "light";
    rerender(<CloudPane pathAndQuery="/reports" cloudUrl="https://cafe.example.com" />);
    await waitFor(() => expect(executeJavaScript).toHaveBeenLastCalledWith(cloudThemeScript("light")));
  });

  it("spends a one-click sign-in code on its first load, then lands on the screen asked for", async () => {
    desktop("s".repeat(43));
    const { container } = render(<CloudPane pathAndQuery="/growth" cloudUrl="https://cafe.example.com" />);
    await waitFor(() => expect(container.querySelector("webview")).not.toBeNull());
    const src = new URL(container.querySelector("webview")!.getAttribute("src")!);
    expect(src.origin + src.pathname).toBe("https://cafe.example.com/api/auth/desktop-session");
    expect(src.searchParams.get("code")).toBe("s".repeat(43));
    expect(src.searchParams.get("next")).toBe("/growth");
  });

  it("says the screen needs the Internet when offline, and points back to the till", async () => {
    desktop();
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    const { container } = render(<CloudPane pathAndQuery="/crm/overview" cloudUrl="https://cafe.example.com" />);
    expect(await screen.findByText("این بخش به اینترنت نیاز دارد")).toBeTruthy();
    expect(container.querySelector("webview")).toBeNull();
    expect(screen.getByText("بازگشت به صندوق").closest("a")?.getAttribute("href")).toBe("/accounting/pos");
  });

  it("gives a browser on the LAN a link instead of a pane", async () => {
    render(<CloudPane pathAndQuery="/crm/overview" cloudUrl="https://cafe.example.com" />);
    const link = await screen.findByText("بازکردن نسخهٔ ابری");
    expect(link.closest("a")?.getAttribute("href")).toBe("https://cafe.example.com/crm/overview");
  });

  it("explains a missing cloud address instead of opening anything", async () => {
    desktop();
    const { container } = render(<CloudPane pathAndQuery="/crm/overview" cloudUrl={null} />);
    expect(await screen.findByText(/نشانی نسخهٔ ابری تنظیم نشده است/)).toBeTruthy();
    expect(container.querySelector("webview")).toBeNull();
  });
});
