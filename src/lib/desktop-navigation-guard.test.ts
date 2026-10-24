/**
 * Issue #1001 — no foreign document may load in the till window.
 *
 * `will-navigate` alone missed HTTP redirects and frame navigations, so a
 * server-side (or open) redirect to an external origin could replace the app
 * page with one that still carried the privileged preload bridge. These cases
 * drive the real guard with a fake webContents: the three events, the
 * subframe rule, and the one-browser-tab-per-click dedupe.
 */
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { navigationDecision, installNavigationGuard } = require("../../electron/navigation-guard.js") as {
  navigationDecision: (url: string, appUrl: string) => "allow" | "external" | "deny";
  installNavigationGuard: (
    contents: FakeContents,
    appUrl: string,
    shell: { openExternal: (url: string) => Promise<void> },
    options?: { now?: () => number },
  ) => void;
};

const APP_URL = "http://127.0.0.1:3000";

type Handler = (...args: unknown[]) => void;

class FakeContents {
  handlers = new Map<string, Handler[]>();
  on(event: string, fn: Handler) {
    const list = this.handlers.get(event) ?? [];
    list.push(fn);
    this.handlers.set(event, list);
  }
  emit(event: string, ...args: unknown[]) {
    for (const fn of this.handlers.get(event) ?? []) fn(...args);
  }
}

function event(overrides: { isMainFrame?: boolean } = {}) {
  const prevented: number[] = [];
  return {
    ...overrides,
    preventDefault: () => prevented.push(1),
    get prevented() {
      return prevented.length > 0;
    },
  };
}

function fixture(now = () => 1_000) {
  const contents = new FakeContents();
  const shell = { openExternal: vi.fn(async () => {}) };
  installNavigationGuard(contents, APP_URL, shell, { now });
  return { contents, shell };
}

describe("navigationDecision", () => {
  it("keeps the app origin, sends plain web links to the browser, refuses every other scheme", () => {
    expect(navigationDecision(`${APP_URL}/accounting/ledger?x=1`, APP_URL)).toBe("allow");
    expect(navigationDecision("https://cafe.example.com/reports", APP_URL)).toBe("external");
    expect(navigationDecision("http://127.0.0.1:3001/other-instance", APP_URL)).toBe("external");
    expect(navigationDecision("javascript:alert(1)", APP_URL)).toBe("deny");
    expect(navigationDecision("file:///C:/Windows/System32/drivers/etc/hosts", APP_URL)).toBe("deny");
    expect(navigationDecision("data:text/html,<script>alert(1)</script>", APP_URL)).toBe("deny");
    expect(navigationDecision("not a url", APP_URL)).toBe("deny");
  });
});

describe("installNavigationGuard", () => {
  it("lets the app navigate and stay", () => {
    const { contents, shell } = fixture();
    const navigate = event();
    contents.emit("will-navigate", navigate, `${APP_URL}/accounting`);
    expect(navigate.prevented).toBe(false);
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  it("blocks an external will-navigate and opens one browser tab", () => {
    const { contents, shell } = fixture();
    const navigate = event();
    contents.emit("will-navigate", navigate, "https://cafe.example.com/cloud");
    expect(navigate.prevented).toBe(true);
    expect(shell.openExternal).toHaveBeenCalledWith("https://cafe.example.com/cloud");
  });

  it("covers will-redirect and will-frame-navigate, not just will-navigate", () => {
    for (const name of ["will-redirect", "will-frame-navigate"]) {
      const { contents, shell } = fixture();
      const redirect = event();
      contents.emit(name, redirect, "https://evil.example/login");
      expect(redirect.prevented, name).toBe(true);
      expect(shell.openExternal, name).toHaveBeenCalledWith("https://evil.example/login");
    }
  });

  it("opens one browser tab even though one redirect fires several events", () => {
    const { contents, shell } = fixture(() => 5_000);
    const url = "https://evil.example/login";
    contents.emit("will-navigate", event(), url);
    contents.emit("will-redirect", event(), url);
    contents.emit("will-frame-navigate", event(), url);
    expect(shell.openExternal).toHaveBeenCalledTimes(1);

    // A later, separate click on the same URL is a real navigation again.
    const later = fixture(() => 9_000);
    later.contents.emit("will-redirect", event(), url);
    later.contents.emit("will-navigate", event(), url);
    expect(later.shell.openExternal).toHaveBeenCalledTimes(1);
  });

  it("stops a subframe from leaving the app without opening a browser", () => {
    const { contents, shell } = fixture();
    const frame = event({ isMainFrame: false });
    contents.emit("will-frame-navigate", frame, "https://www.youtube.com/embed/x");
    expect(frame.prevented).toBe(true);
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  it("honours Electron's isMainFrame on the redirect event object", () => {
    const { contents, shell } = fixture();
    const redirect = event({ isMainFrame: false });
    contents.emit("will-redirect", redirect, "https://www.youtube.com/embed/x");
    expect(redirect.prevented).toBe(true);
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  it("refuses a non-web scheme without handing it to the OS", () => {
    const { contents, shell } = fixture();
    const navigate = event();
    contents.emit("will-navigate", navigate, "file:///C:/secrets.txt");
    expect(navigate.prevented).toBe(true);
    expect(shell.openExternal).not.toHaveBeenCalled();
  });
});
