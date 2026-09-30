// src/lib/desktop-cloud-window.test.ts
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { cloudTarget, createCloudWindowController, offlinePageUrl } = require("../../electron/cloud-window.js");

type Handler = (...args: unknown[]) => void;

class FakeContents {
  handlers = new Map<string, Handler>();
  navigationHistory = { canGoBack: vi.fn(() => true), goBack: vi.fn() };
  openHandler: ((details: { url: string }) => { action: string }) | null = null;
  setWindowOpenHandler(fn: (details: { url: string }) => { action: string }) {
    this.openHandler = fn;
  }
  on(event: string, fn: Handler) {
    this.handlers.set(event, fn);
  }
}

function fakeElectron() {
  const created: FakeWindow[] = [];
  class FakeWindow {
    webContents = new FakeContents();
    loaded: string[] = [];
    focused = 0;
    closed = 0;
    windowHandlers = new Map<string, Handler>();
    constructor(readonly options: { webPreferences: Record<string, unknown> }) {
      created.push(this);
    }
    loadURL(url: string) {
      this.loaded.push(url);
      return Promise.resolve();
    }
    isDestroyed() {
      return false;
    }
    isMinimized() {
      return false;
    }
    restore() {}
    focus() {
      this.focused += 1;
    }
    close() {
      this.closed += 1;
    }
    on(event: string, fn: Handler) {
      this.windowHandlers.set(event, fn);
    }
  }
  const shell = { openExternal: vi.fn(async () => {}) };
  return { created, shell, BrowserWindow: FakeWindow };
}

describe("cloudTarget", () => {
  it("accepts only https addresses", () => {
    expect(cloudTarget("https://cafe.app.example.com/accounting/reports")?.toString()).toBe(
      "https://cafe.app.example.com/accounting/reports",
    );
    expect(cloudTarget("http://cafe.app.example.com/")).toBeNull();
    expect(cloudTarget("javascript:alert(1)")).toBeNull();
    expect(cloudTarget("not a url")).toBeNull();
  });
});

describe("createCloudWindowController", () => {
  it("opens one sandboxed window with no preload and its own remembered login, and reuses it", () => {
    const electron = fakeElectron();
    const controller = createCloudWindowController(electron);
    expect(controller.open("https://cafe.example.com/accounting/reports")).toBe(true);
    expect(controller.open("https://cafe.example.com/crm/overview")).toBe(true);
    expect(electron.created).toHaveLength(1);
    const prefs = electron.created[0].options.webPreferences;
    expect(prefs.preload).toBeUndefined();
    expect(prefs).toMatchObject({ partition: "persist:cloud", sandbox: true, contextIsolation: true, nodeIntegration: false });
    expect(electron.created[0].loaded).toEqual([
      "https://cafe.example.com/accounting/reports",
      "https://cafe.example.com/crm/overview",
    ]);
  });

  it("refuses a non-https address without creating a window", () => {
    const electron = fakeElectron();
    expect(createCloudWindowController(electron).open("http://cafe.example.com/")).toBe(false);
    expect(electron.created).toHaveLength(0);
  });

  it("keeps navigation on the cloud's origin and sends anything else to the browser", () => {
    const electron = fakeElectron();
    createCloudWindowController(electron).open("https://cafe.example.com/accounting/reports");
    const navigate = electron.created[0].webContents.handlers.get("will-navigate")!;
    const inside = { preventDefault: vi.fn() };
    navigate(inside, "https://cafe.example.com/crm/overview");
    expect(inside.preventDefault).not.toHaveBeenCalled();
    const outside = { preventDefault: vi.fn() };
    navigate(outside, "https://elsewhere.example.org/");
    expect(outside.preventDefault).toHaveBeenCalled();
    expect(electron.shell.openExternal).toHaveBeenCalledWith("https://elsewhere.example.org/");
  });

  it("follows a redirect on the same origin", () => {
    const electron = fakeElectron();
    createCloudWindowController(electron).open("https://cafe.example.com/accounting/reports");
    const redirect = electron.created[0].webContents.handlers.get("will-redirect")!;
    const event = { preventDefault: vi.fn() };
    redirect(event, "https://cafe.example.com/login?next=%2Faccounting%2Freports");
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(electron.shell.openExternal).not.toHaveBeenCalled();
  });

  it("sends a redirect to a sibling subdomain to the browser and keeps the window's origin", () => {
    const electron = fakeElectron();
    createCloudWindowController(electron).open("https://cafe.ac.example.com/accounting/reports");
    const contents = electron.created[0].webContents;
    const event = { preventDefault: vi.fn() };
    contents.handlers.get("will-redirect")!(event, "https://bistro.ac.example.com/accounting/reports");
    expect(event.preventDefault).toHaveBeenCalled();
    expect(electron.shell.openExternal).toHaveBeenCalledWith("https://bistro.ac.example.com/accounting/reports");
    // The origin did not move: the opened one is still the window's own.
    const inside = { preventDefault: vi.fn() };
    contents.handlers.get("will-navigate")!(inside, "https://cafe.ac.example.com/crm/overview");
    expect(inside.preventDefault).not.toHaveBeenCalled();
  });

  it("sends a redirect to any other host to the system browser", () => {
    const electron = fakeElectron();
    createCloudWindowController(electron).open("https://cafe.example.com/accounting/reports");
    const redirect = electron.created[0].webContents.handlers.get("will-redirect")!;
    for (const url of ["https://evil.example.org/", "http://other.example.com/", "https://cafe.example.com.evil.org/"]) {
      const event = { preventDefault: vi.fn() };
      redirect(event, url);
      expect(event.preventDefault).toHaveBeenCalled();
      expect(electron.shell.openExternal).toHaveBeenCalledWith(url);
    }
  });

  it("opens billing and subscription in the system browser instead of the cloud window", () => {
    const electron = fakeElectron();
    const controller = createCloudWindowController(electron);
    expect(controller.open("https://cafe.example.com/settings/billing?topup=1")).toBe(true);
    expect(controller.open("https://cafe.example.com/settings/subscription/plans")).toBe(true);
    expect(electron.created).toHaveLength(0);
    expect(electron.shell.openExternal).toHaveBeenCalledWith("https://cafe.example.com/settings/billing?topup=1");
    expect(electron.shell.openExternal).toHaveBeenCalledWith("https://cafe.example.com/settings/subscription/plans");
  });

  it("sends a same-origin link to billing out to the system browser", () => {
    const electron = fakeElectron();
    createCloudWindowController(electron).open("https://cafe.example.com/accounting/reports");
    const contents = electron.created[0].webContents;
    const event = { preventDefault: vi.fn() };
    contents.handlers.get("will-navigate")!(event, "https://cafe.example.com/settings/billing");
    expect(event.preventDefault).toHaveBeenCalled();
    expect(electron.shell.openExternal).toHaveBeenCalledWith("https://cafe.example.com/settings/billing");
    // A client-side link: out to the browser, and the window steps back.
    contents.handlers.get("did-navigate-in-page")!({}, "https://cafe.example.com/settings/subscription", true);
    expect(electron.shell.openExternal).toHaveBeenCalledWith("https://cafe.example.com/settings/subscription");
    expect(contents.navigationHistory.goBack).toHaveBeenCalledTimes(1);
    contents.handlers.get("did-navigate-in-page")!({}, "https://cafe.example.com/crm/overview", true);
    expect(contents.navigationHistory.goBack).toHaveBeenCalledTimes(1);
  });

  it("shows the offline page when the cloud cannot be reached", () => {
    const electron = fakeElectron();
    createCloudWindowController(electron).open("https://cafe.example.com/accounting/reports");
    const failed = electron.created[0].webContents.handlers.get("did-fail-load")!;
    failed({}, -106, "ERR_INTERNET_DISCONNECTED", "https://cafe.example.com/accounting/reports", true);
    expect(electron.created[0].loaded.at(-1)).toMatch(/^data:text\/html/);
  });
});

describe("the cloud window's lifetime", () => {
  it("forgets a window once it closes, so the next open creates a new one", () => {
    const electron = fakeElectron();
    const controller = createCloudWindowController(electron);
    controller.open("https://cafe.example.com/accounting/reports");
    electron.created[0].windowHandlers.get("closed")!();
    controller.open("https://cafe.example.com/crm/overview");
    expect(electron.created).toHaveLength(2);
  });

  it("close() closes an open window and is a no-op without one", () => {
    const electron = fakeElectron();
    const controller = createCloudWindowController(electron);
    controller.close();
    controller.open("https://cafe.example.com/accounting/reports");
    controller.close();
    expect(electron.created[0].closed).toBe(1);
  });
});

describe("offlinePageUrl", () => {
  it("escapes the retry address", () => {
    const html = decodeURIComponent(offlinePageUrl('https://a.example.com/"><script>x</script>').split(",")[1]);
    expect(html).not.toContain("<script>x");
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
  });
});
