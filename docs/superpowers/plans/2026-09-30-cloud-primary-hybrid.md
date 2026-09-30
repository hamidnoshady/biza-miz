# Cloud-primary Hybrid Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A paired Windows desktop becomes the till (selling, floor & kitchen, shifts work offline and sync up), every other screen opens the cloud in a second app window, and the desktop keeps branch settings and feature switches in step with the cloud.

**Architecture:** One pure route list (`src/lib/site-routes.ts`) decides which screens a Hybrid desktop renders locally. Everything else is handed to a sandboxed Electron «نسخهٔ ابری» window. Two new sync events (`shift.opened@1`, `shift.closed@1`) carry shifts through the existing outbox. A new bearer-authenticated read (`GET /api/server-sync/site-profile`) lets the desktop refresh branch settings, feature switches and app availability on every tick. The cloud's behaviour for its own users does not change.

**Tech Stack:** Next.js 15 App Router (TypeScript), PostgreSQL 16, Electron, vitest (+ jsdom / @testing-library/react), node-postgres.

**Spec:** [docs/phases/Phase-45-Cloud-Primary-Hybrid.md](../../phases/Phase-45-Cloud-Primary-Hybrid.md)

## Global Constraints

- Behaviour changes only where `deployment.profile === "hybrid"` **and** `deploymentRole() === "site"`. A `local` install and the cloud (`central`) behave exactly as before.
- The cloud stays standalone: it is never made read-only for a paired branch, and nothing removes or gates a cloud screen.
- No schema change and no new migration. Shifts use `employee_shifts`; the profile state lives in `settings`.
- A remote (cloud) page never gets the till window's preload/IPC. The cloud window has **no preload**.
- Every date a user sees is Shamsi (`formatJalali` or `toLocaleString("fa-IR")`); money stays integer Rial.
- Dashboard UI is built from `page-chrome.tsx` primitives and `<Button>`. No `animate-spin`, no `gray-*`/`slate-*`, no `shadow-sm` on cards, no `dark:` additions.
- Every new or changed `src/lib/*.ts` gets a `*.test.ts` beside it.
- New bearer route paths are added to **all three** session-less lists in `src/middleware.ts`.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Before the final commit run the full local checklist from CLAUDE.md: `npx tsc --noEmit`, `npm test`, `npm run test:db`, `npm run test:design`, `npm run build`.

## Review Focus

1. **The same person has an open shift on both sides** (clocked in on the cloud POS, then on the desktop). The replay must dead-letter visibly on the receiver with `shift_already_open` and must not stall the push queue. Test: Task 5 integration "refuses, visibly, a second open shift".
2. **A shift with no branch** (session without a location and no fallback). Clock-in must still work; the shift simply stays local. Test: Task 5 unit "records nothing for a shift with no branch".
3. **The cloud refuses, is down, or answers with an old or malformed body** for the site profile. The desktop keeps the last applied copy, records the error, backs off, and push/pull continue. Tests: Task 6 unit `validateSiteProfile` rejections and Task 6 integration "keeps the last copy and backs off".
4. **A cloud address that is missing or not https, or a LAN phone with no desktop bridge**, reaching a cloud screen. The till window must never navigate to the cloud itself; a phone gets a new-tab link. Tests: Task 2 unit `cloudTarget` and Task 3 component tests.
5. **Sub-pages and look-alike paths.** `/accounting/orders/123` stays local; `/accounting/posx` and `/accounting/orders-archive` go to the cloud. Test: Task 1 unit "does not match a longer sibling path".

---

### Task 1: The till route list

**Files:**
- Create: `src/lib/site-routes.ts`
- Test: `src/lib/site-routes.test.ts`

**Interfaces:**
- Consumes: `ACCOUNTING_WORKSPACE_HREFS` (`src/lib/app-routes.ts`), `settingsTabHref` (`src/lib/settings-routes.ts`), `NavNode` (`src/lib/nav-tree.ts`), `DeploymentProfile` (`src/lib/deployment-mode.ts`), `DeploymentRole` (`src/lib/deployment-role.ts`).
- Produces:
  - `SITE_LOCAL_ROUTES: readonly string[]`
  - `isHybridSite(profile: DeploymentProfile, runtimeRole: DeploymentRole): boolean`
  - `isSiteLocalRoute(pathname: string): boolean`
  - `tillNavItems<T extends NavNode>(items: readonly T[]): T[]`
  - `siteHomeFor(role: string): string`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/site-routes.test.ts
import { describe, expect, it } from "vitest";
import { ACCOUNTING_WORKSPACE_HREFS } from "./app-routes";
import { settingsTabHref } from "./settings-routes";
import { isHybridSite, isSiteLocalRoute, siteHomeFor, tillNavItems } from "./site-routes";

describe("isSiteLocalRoute", () => {
  it("keeps every till screen and its sub-pages on the desktop", () => {
    for (const href of [
      ACCOUNTING_WORKSPACE_HREFS.pos,
      ACCOUNTING_WORKSPACE_HREFS.orders,
      ACCOUNTING_WORKSPACE_HREFS.waiter,
      ACCOUNTING_WORKSPACE_HREFS.floor,
      ACCOUNTING_WORKSPACE_HREFS.kitchen,
      ACCOUNTING_WORKSPACE_HREFS.reservations,
      ACCOUNTING_WORKSPACE_HREFS.delivery,
    ]) {
      expect(isSiteLocalRoute(href)).toBe(true);
      expect(isSiteLocalRoute(`${href}/123`)).toBe(true);
    }
  });

  it("keeps this computer's own settings on the desktop", () => {
    for (const key of ["shifts", "cloud-sync", "devices", "desktop", "printers", "backup", "logs"] as const) {
      expect(isSiteLocalRoute(settingsTabHref(key))).toBe(true);
    }
  });

  it("sends every other screen to the cloud", () => {
    for (const path of [
      "/dashboard",
      "/accounting/overview",
      "/accounting/reports",
      "/accounting/inventory",
      "/accounting/products",
      "/accounting/directory",
      "/crm/overview",
      "/growth/overview",
      "/websites/overview",
      "/workspace",
      "/media",
      "/knowledge",
      "/settings",
      "/settings/business",
      "/settings/team",
      "/settings/menu",
    ]) {
      expect(isSiteLocalRoute(path)).toBe(false);
    }
  });

  it("does not match a longer sibling path", () => {
    expect(isSiteLocalRoute("/accounting/posx")).toBe(false);
    expect(isSiteLocalRoute("/accounting/orders-archive")).toBe(false);
  });
});

describe("isHybridSite", () => {
  it("is only the desktop of a Hybrid business", () => {
    expect(isHybridSite("hybrid", "site")).toBe(true);
    expect(isHybridSite("hybrid", "central")).toBe(false);
    expect(isHybridSite("local", "site")).toBe(false);
    expect(isHybridSite("cloud", "central")).toBe(false);
  });
});

describe("tillNavItems", () => {
  it("keeps only till entries, and a group only when a till entry is left in it", () => {
    const items = [
      { label: "pos", href: "/accounting/pos" },
      { label: "crm", href: "/crm/overview" },
      { label: "ops", children: [{ label: "kitchen", href: "/accounting/kitchen" }, { label: "stock", href: "/accounting/inventory" }] },
      { label: "reports", children: [{ label: "sales", href: "/accounting/reports?tab=sales" }] },
    ];
    expect(tillNavItems(items)).toEqual([
      { label: "pos", href: "/accounting/pos" },
      { label: "ops", children: [{ label: "kitchen", href: "/accounting/kitchen" }] },
    ]);
  });
});

describe("siteHomeFor", () => {
  it("opens the screen each role works on", () => {
    expect(siteHomeFor("kitchen")).toBe(ACCOUNTING_WORKSPACE_HREFS.kitchen);
    expect(siteHomeFor("waiter")).toBe(ACCOUNTING_WORKSPACE_HREFS.waiter);
    expect(siteHomeFor("owner")).toBe(ACCOUNTING_WORKSPACE_HREFS.pos);
    expect(siteHomeFor("cashier")).toBe(ACCOUNTING_WORKSPACE_HREFS.pos);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/lib/site-routes.test.ts`
Expected: FAIL, `Failed to resolve import "./site-routes"`.

- [ ] **Step 3: Write the module**

```ts
// src/lib/site-routes.ts
/**
 * Phase 45 — which screens a Hybrid desktop renders itself.
 *
 * The cloud is the system of record; the desktop is the till. Selling, floor
 * & kitchen, shifts and this computer's own settings run on the local server
 * and keep working offline. Every other screen is cloud-by-default: the
 * desktop hands it to the «نسخهٔ ابری» window instead of showing a partial
 * local copy that disagrees with the cloud. A screen added later is therefore
 * cloud unless someone adds it here on purpose.
 *
 * Framework-free and unit-tested; the dashboard gate, the till menu and the
 * home redirect all read this one list.
 */
import { ACCOUNTING_WORKSPACE_HREFS } from "./app-routes";
import type { DeploymentProfile } from "./deployment-mode";
import type { DeploymentRole } from "./deployment-role";
import type { NavNode } from "./nav-tree";
import { settingsTabHref } from "./settings-routes";

export const SITE_LOCAL_ROUTES: readonly string[] = [
  ACCOUNTING_WORKSPACE_HREFS.pos,
  ACCOUNTING_WORKSPACE_HREFS.orders,
  ACCOUNTING_WORKSPACE_HREFS.waiter,
  ACCOUNTING_WORKSPACE_HREFS.floor,
  ACCOUNTING_WORKSPACE_HREFS.kitchen,
  ACCOUNTING_WORKSPACE_HREFS.reservations,
  ACCOUNTING_WORKSPACE_HREFS.delivery,
  settingsTabHref("shifts"),
  settingsTabHref("cloud-sync"),
  settingsTabHref("devices"),
  settingsTabHref("desktop"),
  settingsTabHref("printers"),
  settingsTabHref("backup"),
  settingsTabHref("logs"),
];

/** The desktop of a Hybrid business — the only place the till split applies. */
export function isHybridSite(profile: DeploymentProfile, runtimeRole: DeploymentRole): boolean {
  return profile === "hybrid" && runtimeRole === "site";
}

export function isSiteLocalRoute(pathname: string): boolean {
  return SITE_LOCAL_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`));
}

/** The dashboard nav reduced to till screens; a group survives only with a till entry in it. */
export function tillNavItems<T extends NavNode>(items: readonly T[]): T[] {
  return items.flatMap((item) => {
    const children = item.children ? tillNavItems(item.children as T[]) : undefined;
    const local = item.href ? isSiteLocalRoute(item.href.split("?")[0]) : false;
    if (local) return [children ? { ...item, children } : item];
    if (!children?.length) return [];
    // A cloud page with till pages under it stays only as their group heading.
    return [{ ...item, href: undefined, children }];
  });
}

/** Where a signed-in member lands on the desktop (the assistant home is cloud-only). */
export function siteHomeFor(role: string): string {
  if (role === "kitchen") return ACCOUNTING_WORKSPACE_HREFS.kitchen;
  if (role === "waiter") return ACCOUNTING_WORKSPACE_HREFS.waiter;
  return ACCOUNTING_WORKSPACE_HREFS.pos;
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `npx vitest run src/lib/site-routes.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/site-routes.ts src/lib/site-routes.test.ts
git commit -m "feat(hybrid): one list of the screens a Hybrid desktop renders itself

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The «نسخهٔ ابری» window (Electron)

**Files:**
- Create: `electron/cloud-window.js`
- Modify: `electron/main.js` (requires near line 16; `registerIpc()` near line 138)
- Modify: `electron/preload.js` (the `businessSuiteDesktop` object)
- Modify: `electron/package.json` (`build.files`)
- Modify: `src/lib/desktop-bridge.ts` (`DesktopBridge`)
- Test: `src/lib/desktop-cloud-window.test.ts`

**Interfaces:**
- Produces (JS, CommonJS): `cloudTarget(raw): URL | null`, `sameOrigin(raw, origin): boolean`, `offlinePageUrl(retryUrl): string`, `createCloudWindowController({ BrowserWindow, shell }): { open(raw): boolean }`.
- Produces (TS): `DesktopBridge.openCloud?(url: string): Promise<boolean>`, which Task 3 calls.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/desktop-cloud-window.test.ts
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { cloudTarget, createCloudWindowController, offlinePageUrl } = require("../../electron/cloud-window.js");

type Handler = (...args: unknown[]) => void;

class FakeContents {
  handlers = new Map<string, Handler>();
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
    on() {}
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

  it("shows the offline page when the cloud cannot be reached", () => {
    const electron = fakeElectron();
    createCloudWindowController(electron).open("https://cafe.example.com/accounting/reports");
    const failed = electron.created[0].webContents.handlers.get("did-fail-load")!;
    failed({}, -106, "ERR_INTERNET_DISCONNECTED", "https://cafe.example.com/accounting/reports", true);
    expect(electron.created[0].loaded.at(-1)).toMatch(/^data:text\/html/);
  });
});

describe("offlinePageUrl", () => {
  it("escapes the retry address", () => {
    const html = decodeURIComponent(offlinePageUrl('https://a.example.com/"><script>x</script>').split(",")[1]);
    expect(html).not.toContain("<script>x");
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/lib/desktop-cloud-window.test.ts`
Expected: FAIL, `Cannot find module '../../electron/cloud-window.js'`.

- [ ] **Step 3: Write `electron/cloud-window.js`**

```js
"use strict";

/**
 * Phase 45 — the «نسخهٔ ابری» window.
 *
 * On a Hybrid desktop the till window shows only the till; every back-office
 * screen opens the cloud here. This window is deliberately powerless: no
 * preload, so a page from the Internet can never reach the till's IPC
 * (folders, firewall, printers), a sandboxed renderer, and a persistent
 * partition of its own so the cloud login survives restarts without sharing
 * the local server's cookies. Navigation stays on the cloud's origin;
 * anything else goes to the system browser.
 */

function cloudTarget(raw) {
  try {
    const url = new URL(String(raw));
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function sameOrigin(raw, origin) {
  try {
    return new URL(String(raw)).origin === origin;
  } catch {
    return false;
  }
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

function offlinePageUrl(retryUrl) {
  const html = `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><title>نسخهٔ ابری</title></head>
<body style="margin:0;height:100vh;display:grid;place-items:center;font-family:Tahoma,sans-serif;background:#faf9f7;color:#292524">
<div style="text-align:center;line-height:2">
<p>اتصال به اینترنت برقرار نیست.</p>
<p>صندوق، میزها، آشپزخانه و شیفت روی این دستگاه کار می‌کنند؛ این بخش با برگشت اینترنت باز می‌شود.</p>
<a href="${escapeHtml(retryUrl)}" style="color:#0f766e">دوباره تلاش کنید</a>
</div></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function createCloudWindowController({ BrowserWindow, shell }) {
  let win = null;
  let origin = null;

  function create() {
    const created = new BrowserWindow({
      width: 1280,
      height: 800,
      minWidth: 900,
      minHeight: 620,
      title: "نسخهٔ ابری",
      autoHideMenuBar: true,
      webPreferences: {
        partition: "persist:cloud",
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    created.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    created.webContents.on("will-navigate", (event, url) => {
      if (sameOrigin(url, origin)) return;
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    });
    created.webContents.on("did-fail-load", (_event, code, _description, url, isMainFrame) => {
      // -3 is ERR_ABORTED: one navigation replaced by another, not a failure.
      if (isMainFrame && code !== -3 && !String(url).startsWith("data:")) void created.loadURL(offlinePageUrl(url));
    });
    created.on("closed", () => {
      win = null;
    });
    return created;
  }

  return {
    open(raw) {
      const target = cloudTarget(raw);
      if (!target) return false;
      if (!win || win.isDestroyed()) win = create();
      origin = target.origin;
      void win.loadURL(target.toString());
      if (win.isMinimized()) win.restore();
      win.focus();
      return true;
    },
  };
}

module.exports = { cloudTarget, sameOrigin, offlinePageUrl, createCloudWindowController };
```

- [ ] **Step 4: Run it to see it pass**

Run: `npx vitest run src/lib/desktop-cloud-window.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Wire it into the desktop shell**

In `electron/main.js`, after the `require("./update-engine")` line add:

```js
const { createCloudWindowController } = require("./cloud-window");

// Phase 45: back-office screens open the cloud in their own powerless window.
const cloudWindow = createCloudWindowController({ BrowserWindow, shell });
```

Inside `registerIpc()`, next to the `desktop:open-logs` handler, add:

```js
    ipcMain.handle("desktop:open-cloud", (_event, payload) => cloudWindow.open(payload?.url));
```

In `electron/preload.js`, inside the `businessSuiteDesktop` object right after `pickFolder: ...,` add:

```js
  /** Phase 45: open a cloud screen in the «نسخهٔ ابری» window (https only). */
  openCloud: (url) => ipcRenderer.invoke("desktop:open-cloud", { url }),
```

In `electron/package.json` `build.files`, add `"cloud-window.js"` after `"update-engine.js"`.

In `src/lib/desktop-bridge.ts`, inside `interface DesktopBridge` after `pickFolder(...)`, add:

```ts
  /** Phase 45: opens `url` (https only) in the «نسخهٔ ابری» window; false when refused. Optional for older shells. */
  openCloud?(url: string): Promise<boolean>;
```

- [ ] **Step 6: Check the Electron sources still parse, and types**

Run: `node --check electron/main.js && node --check electron/preload.js && node --check electron/cloud-window.js && npx tsc --noEmit`
Expected: no output from `node --check`, and `tsc` exits 0.

- [ ] **Step 7: Commit**

```bash
git add electron/cloud-window.js electron/main.js electron/preload.js electron/package.json src/lib/desktop-bridge.ts src/lib/desktop-cloud-window.test.ts
git commit -m "feat(desktop): a sandboxed «نسخهٔ ابری» window for back-office screens

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The desktop hands back-office screens to the cloud

**Files:**
- Create: `src/components/cloud-handoff-state.tsx`
- Create: `src/app/dashboard/till-navigation.tsx`
- Modify: `src/app/dashboard/deployment-capability-gate.tsx`
- Modify: `src/app/dashboard/dashboard-sidebar.tsx` (`SidebarProps` near line 188; the nav slot in `DashboardSidebar` near line 1030)
- Modify: `src/app/dashboard/workspace-shell.tsx` (after `const runtimeRole = deploymentRole();` near line 377, and the `<DashboardSidebar …>` props near line 445)
- Modify: `src/app/dashboard/page.tsx` (top of `DashboardPage`)
- Test: `src/components/cloud-handoff-state.test.tsx`

**Interfaces:**
- Consumes: `isHybridSite`, `isSiteLocalRoute`, `tillNavItems`, `siteHomeFor` (Task 1); `window.businessSuiteDesktop?.openCloud` (Task 2).
- Produces: `cloudHandoffUrl(cloudUrl: string | null, pathAndQuery: string): string | null`; `<CloudHandoffState pathname cloudUrl />`; `<TillNavigation navItems pathname cloudUrl />`; `DashboardSidebar` prop `till?: { cloudUrl: string | null }`.

- [ ] **Step 1: Write the failing component test**

```tsx
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
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/components/cloud-handoff-state.test.tsx`
Expected: FAIL, `Failed to resolve import "./cloud-handoff-state"`.

- [ ] **Step 3: Write the hand-off screen**

```tsx
// src/components/cloud-handoff-state.tsx
"use client";

/**
 * Phase 45 — a Hybrid desktop does not render back-office screens. It hands
 * the same address to the «نسخهٔ ابری» window (a phone on the LAN gets a
 * new-tab link), and says so here. Offline it says the screen needs the
 * Internet: the till keeps working, this part waits for the connection.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { CloudIcon, CloudOffIcon } from "lucide-react";
import { cardClass, PageHeader, PageShell } from "@/app/dashboard/page-chrome";
import { Button } from "@/components/ui/button";
import { ACCOUNTING_WORKSPACE_HREFS } from "@/lib/app-routes";

export function cloudHandoffUrl(cloudUrl: string | null, pathAndQuery: string): string | null {
  if (!cloudUrl) return null;
  try {
    const url = new URL(pathAndQuery, cloudUrl);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function CloudHandoffState({ pathname, cloudUrl }: { pathname: string; cloudUrl: string | null }) {
  const [target, setTarget] = useState<string | null>(() => cloudHandoffUrl(cloudUrl, pathname));
  const [online, setOnline] = useState(true);
  const [opened, setOpened] = useState(false);
  const [desktop, setDesktop] = useState(false);

  useEffect(() => {
    const next = cloudHandoffUrl(cloudUrl, `${pathname}${window.location.search}`);
    const bridge = window.businessSuiteDesktop;
    setTarget(next);
    setOnline(navigator.onLine);
    setDesktop(Boolean(bridge?.openCloud));
    setOpened(false);
    if (next && navigator.onLine && bridge?.openCloud) void bridge.openCloud(next).then(setOpened);
  }, [pathname, cloudUrl]);

  const reopen = () => {
    if (target) void window.businessSuiteDesktop?.openCloud?.(target).then(setOpened);
  };

  const message = !target
    ? "نشانی نسخهٔ ابری تنظیم نشده است. اتصال را از «تنظیمات ← ابر و همگام‌سازی» بررسی کنید."
    : !online
      ? "صندوق، میزها، آشپزخانه و شیفت بدون اینترنت روی همین دستگاه کار می‌کنند. این بخش با برگشت اینترنت باز می‌شود."
      : opened
        ? "این بخش در پنجرهٔ «نسخهٔ ابری» باز شد."
        : "حسابداری، گزارش‌ها، انبار، مشتریان و تنظیمات در نسخهٔ ابری کار می‌کنند.";

  return (
    <PageShell className="py-6">
      <PageHeader title="نسخهٔ ابری" description="این بخش روی نسخهٔ ابری کسب‌وکار شما کار می‌کند." />
      <section className={`${cardClass} mx-auto mt-6 max-w-2xl p-6 sm:p-8`}>
        <div className="flex items-start gap-4">
          <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-amber-100 text-amber-800">
            {online ? <CloudIcon className="size-5" aria-hidden="true" /> : <CloudOffIcon className="size-5" aria-hidden="true" />}
          </span>
          <div className="min-w-0">
            {!online && target ? <h2 className="font-bold text-foreground">این بخش به اینترنت نیاز دارد</h2> : null}
            <p className="mt-2 text-sm leading-7 text-muted-foreground">{message}</p>
            <div className="mt-5 flex flex-wrap gap-2">
              {target && online ? (
                desktop ? (
                  <Button onClick={reopen}>
                    <CloudIcon className="size-4" aria-hidden="true" />
                    بازکردن دوباره در نسخهٔ ابری
                  </Button>
                ) : (
                  <Button asChild>
                    <a href={target} target="_blank" rel="noopener noreferrer">
                      <CloudIcon className="size-4" aria-hidden="true" />
                      بازکردن نسخهٔ ابری
                    </a>
                  </Button>
                )
              ) : null}
              <Button variant="outline" asChild>
                <Link href={ACCOUNTING_WORKSPACE_HREFS.pos}>بازگشت به صندوق</Link>
              </Button>
            </div>
          </div>
        </div>
      </section>
    </PageShell>
  );
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `npx vitest run src/components/cloud-handoff-state.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Hand every non-till page off in the gate**

In `src/app/dashboard/deployment-capability-gate.tsx` add imports:

```tsx
import { CloudHandoffState } from "@/components/cloud-handoff-state";
import { isHybridSite, isSiteLocalRoute } from "@/lib/site-routes";
```

and make the first lines of `DeploymentCapabilityGate`'s body:

```tsx
  const pathname = usePathname();
  // Phase 45: on a Hybrid desktop only the till renders locally; every other
  // screen is the cloud's (src/lib/site-routes.ts).
  if (isHybridSite(profile, runtimeRole) && !isSiteLocalRoute(pathname)) {
    return <CloudHandoffState pathname={pathname} cloudUrl={cloudUrl} />;
  }
```

Delete the old `const pathname = usePathname();` line below it so it isn't declared twice.

- [ ] **Step 6: Land on the till instead of the assistant home**

In `src/app/dashboard/page.tsx` add imports:

```tsx
import { withTenant } from "@/lib/db";
import { readDeploymentProfile } from "@/lib/deployment-mode";
import { deploymentRole } from "@/lib/deployment-role";
import { isHybridSite, siteHomeFor } from "@/lib/site-routes";
```

and directly after `if (!session) redirect("/login");` add:

```tsx
  // Phase 45: the assistant is a cloud screen; a Hybrid desktop opens on the till.
  const deployment = await withTenant(session.businessId, () => readDeploymentProfile(session.businessId));
  if (isHybridSite(deployment.profile, deploymentRole())) redirect(siteHomeFor(session.role));
```

- [ ] **Step 7: Write the till menu**

```tsx
// src/app/dashboard/till-navigation.tsx
"use client";

/**
 * Phase 45 — the sidebar of a Hybrid desktop: the till screens this member
 * may open (already reduced by `tillNavItems`), plus one «نسخهٔ ابری» door.
 * No app rail and no app menus — those are the cloud's.
 */
import Link from "next/link";
import { CircleIcon, CloudIcon } from "lucide-react";
import { SidebarContent, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { bestNavMatch, flattenNav } from "@/lib/nav-tree";
import type { NavItem } from "./dashboard-sidebar";
import { NAV_ICONS } from "./sidebar-nav-icons";
import { APP_NAV_BUTTON_CLASS, NAV_LABEL_CLASS } from "./sidebar-nav-styles";

export function TillNavigation({
  navItems,
  pathname,
  cloudUrl,
}: {
  navItems: NavItem[];
  pathname: string;
  cloudUrl: string | null;
}) {
  const items = flattenNav(navItems);
  const active = bestNavMatch(items, (href) => pathname === href || pathname.startsWith(`${href}/`));
  const openCloud = () => {
    if (!cloudUrl) return;
    const bridge = window.businessSuiteDesktop;
    if (bridge?.openCloud) void bridge.openCloud(cloudUrl);
    else window.open(cloudUrl, "_blank", "noopener,noreferrer");
  };
  return (
    <SidebarContent className="px-3 py-4">
      <nav aria-label="صندوق" className="space-y-4">
        <SidebarMenu className="space-y-1.5">
          {items.map((item) => {
            const Icon = NAV_ICONS[item.href] ?? CircleIcon;
            const isActive = active?.href === item.href;
            return (
              <SidebarMenuItem key={item.href}>
                <SidebarMenuButton asChild isActive={isActive} tooltip={item.label} className={APP_NAV_BUTTON_CLASS}>
                  <Link href={item.href} aria-current={isActive ? "page" : undefined}>
                    <Icon aria-hidden="true" className="size-5 shrink-0" />
                    <span className={NAV_LABEL_CLASS}>{item.label}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
        {cloudUrl ? (
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton tooltip="نسخهٔ ابری" className={APP_NAV_BUTTON_CLASS} onClick={openCloud}>
                <CloudIcon aria-hidden="true" className="size-5 shrink-0" />
                <span className={NAV_LABEL_CLASS}>نسخهٔ ابری</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        ) : null}
      </nav>
    </SidebarContent>
  );
}
```

- [ ] **Step 8: Use the till menu on the desktop**

In `src/app/dashboard/dashboard-sidebar.tsx`:
1. Add `import { TillNavigation } from "./till-navigation";` beside the other `./` imports.
2. In `interface SidebarProps` add:

```ts
  /** Phase 45: set on a Hybrid desktop — the sidebar is the till menu plus a cloud door. */
  till?: { cloudUrl: string | null };
```

3. Add `till` to the `DashboardSidebar({ … })` destructuring.
4. Replace the nav-slot conditional (`{workspaceRoute ? ( <WorkspaceNavigation … /> ) : appShell ? ( … ) : ( <WorkspaceRail … /> )}`) with:

```tsx
        {till ? (
          <TillNavigation navItems={navItems} pathname={pathname} cloudUrl={till.cloudUrl} />
        ) : workspaceRoute ? (
          <WorkspaceNavigation pathname={pathname} sections={workspaceSections} />
        ) : appShell ? (
          <AppShellNavigation
            nav={appShell.nav}
            shell={appShell.shell}
            role={role}
            permissions={permissions}
            pathname={pathname}
            navItems={navItems}
          />
        ) : (
          <WorkspaceRail navItems={navItems} pathname={pathname} />
        )}
```

In `src/app/dashboard/workspace-shell.tsx`:
1. Add `import { isHybridSite, tillNavItems } from "@/lib/site-routes";`.
2. After `const runtimeRole = deploymentRole();` add:

```ts
  // Phase 45: a Hybrid desktop is the till — its menu lists only till screens.
  const tillMode = isHybridSite(deployment.profile, runtimeRole);
  const cloudUrl = serverSyncConfig?.enabled ? serverSyncConfig.remoteUrl : null;
```

3. On `<DashboardSidebar …>` change `navItems={navItems}` to `navItems={tillMode ? tillNavItems(navItems) : navItems}` and add the prop `till={tillMode ? { cloudUrl } : undefined}`.
4. On `<DeploymentCapabilityGate …>` change `cloudUrl={serverSyncConfig?.enabled ? serverSyncConfig.remoteUrl : null}` to `cloudUrl={cloudUrl}`.

- [ ] **Step 9: Type check and the design lints**

Run: `npx tsc --noEmit && npm run test:design && npx vitest run src/components/cloud-handoff-state.test.tsx src/app/dashboard`
Expected: all PASS. A design-lint failure names the file and pattern; fix it with the page-chrome primitive it names rather than changing the lint.

- [ ] **Step 10: Commit**

```bash
git add src/components/cloud-handoff-state.tsx src/components/cloud-handoff-state.test.tsx src/app/dashboard/till-navigation.tsx src/app/dashboard/deployment-capability-gate.tsx src/app/dashboard/dashboard-sidebar.tsx src/app/dashboard/workspace-shell.tsx src/app/dashboard/page.tsx
git commit -m "feat(hybrid): the desktop is the till; back-office screens open the cloud window

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: «از دستیار بپرس» follows the AI switch

**Files:**
- Modify: `src/components/ai/ask-assistant.tsx`
- Modify: `src/app/dashboard/workspace-shell.tsx` (wrap `{children}` inside `<DeploymentCapabilityGate>`)
- Test: `src/components/ai/ask-assistant.test.tsx`

**Interfaces:**
- Consumes: `features` (already read by `WorkspaceShell` via `effectiveFeatures`), `tillMode` (Task 3).
- Produces: `AssistantLinkProvider({ enabled, children })`.

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/ai/ask-assistant.test.tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AskAssistant, AssistantLinkProvider } from "./ask-assistant";

afterEach(cleanup);

describe("AskAssistant", () => {
  it("renders nothing outside a shell that says the assistant is on", () => {
    const { container } = render(<AskAssistant context="گزارش فروش" />);
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when the business's AI is switched off", () => {
    const { container } = render(
      <AssistantLinkProvider enabled={false}>
        <AskAssistant context="گزارش فروش" />
      </AssistantLinkProvider>,
    );
    expect(container.innerHTML).toBe("");
  });

  it("links to the chat home with the page's context when AI is on", () => {
    render(
      <AssistantLinkProvider enabled>
        <AskAssistant context="گزارش فروش" app="growth" />
      </AssistantLinkProvider>,
    );
    const link = screen.getByRole("link", { name: /از دستیار بپرس/ });
    expect(link.getAttribute("href")).toBe(`/dashboard?${new URLSearchParams({ ctx: "گزارش فروش", app: "growth" })}`);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/components/ai/ask-assistant.test.tsx`
Expected: FAIL, `AssistantLinkProvider` is not exported (and the first test renders a link).

- [ ] **Step 3: Gate the link**

In `src/components/ai/ask-assistant.tsx` change the imports to:

```tsx
import { createContext, useContext, type ReactNode } from "react";
import Link from "next/link";
import { SparklesIcon } from "lucide-react";
```

add above `export function AskAssistant`:

```tsx
/**
 * Whether this business may use the assistant here. The shell sets it from the
 * `ai_assistant` switch (and off on a Hybrid desktop, where the assistant is a
 * cloud screen). The default is off: a link must never invite a member into a
 * surface the super-admin console switched off.
 */
const AssistantLinkContext = createContext(false);

export function AssistantLinkProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  return <AssistantLinkContext.Provider value={enabled}>{children}</AssistantLinkContext.Provider>;
}
```

and make the first line of `AskAssistant`'s body:

```tsx
  if (!useContext(AssistantLinkContext)) return null;
```

- [ ] **Step 4: Provide it from the shell**

In `src/app/dashboard/workspace-shell.tsx` add `import { AssistantLinkProvider } from "@/components/ai/ask-assistant";` and replace the `{children}` inside `<DeploymentCapabilityGate …>` with:

```tsx
              <AssistantLinkProvider enabled={features.ai_assistant === true && !tillMode}>
                {children}
              </AssistantLinkProvider>
```

- [ ] **Step 5: Run the tests and type check**

Run: `npx vitest run src/components/ai/ask-assistant.test.tsx && npx tsc --noEmit`
Expected: PASS (3 tests), tsc exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/components/ai/ask-assistant.tsx src/components/ai/ask-assistant.test.tsx src/app/dashboard/workspace-shell.tsx
git commit -m "fix(ai): hide «از دستیار بپرس» when the assistant is switched off

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Shifts sync (`shift.opened@1`, `shift.closed@1`)

**Files:**
- Create: `src/lib/shift-sync.ts`
- Test: `src/lib/shift-sync.test.ts`
- Modify: `src/lib/sync-event-registry.ts` (`EffectClass`; two registry rows)
- Modify: `src/lib/sync-domain-handlers.ts` (two `case`s in `switch (context.definition.handler)`)
- Modify: `src/lib/data-ownership.ts` (contract v3; a `shifts` domain)
- Modify: `src/lib/data-ownership.test.ts` (only if it pins the version number)
- Modify: `src/lib/shift-service.ts` (`openShift`, `closeShiftRow`, `closeOwnShift`, `closeShiftById`)
- Modify: `src/app/api/shifts/start/route.ts`, `src/app/api/shifts/end/route.ts`, `src/app/api/shifts/[id]/close/route.ts`
- Modify: `integration/hybrid-sync.integration.test.ts`

**Interfaces:**
- Consumes: `appendSyncOutboxEvent(client, { locationId, clientEventId, eventType, payload, actorUserId, actorRole, occurredAt })` (`src/lib/sync-outbox.ts`); `EmployeeShift` (`src/lib/shift-service.ts`); `isUuid(value: unknown): value is string` (`src/lib/uuid.ts`).
- Produces:
  - `type ShiftSyncEventType = "shift.opened" | "shift.closed"`
  - `interface ShiftSyncPayload { shiftId; employeeId; businessDate; openingFloat: number | null; closingFloat: number | null; startedAt: string; endedAt: string | null; closedBy: string | null }`
  - `shiftSyncPayload(shift: EmployeeShift): ShiftSyncPayload`
  - `parseShiftSyncPayload(raw: Record<string, unknown>): ShiftSyncPayload | null`
  - `shiftSyncClientEventId(type, shiftId): string`
  - `recordShiftSyncEvent(client, type, shift, actor: { userId: string | null; role: Role }): Promise<void>`
  - `applyShiftReplay(client, businessId, locationId, shift): Promise<string>`
  - New trailing params: `openShift(…, actorRole: Role = "cashier")`, `closeOwnShift(…, actorRole: Role = "cashier")`, `closeShiftById(…, actorRole: Role = "manager")`

- [ ] **Step 1: Register the events** (so `SyncEventType` accepts them)

In `src/lib/sync-event-registry.ts` change `type EffectClass = … | "transfer";` to end with `| "transfer" | "shift";`, and add after `const INVENTORY_PERMISSION = …`:

```ts
/** The permission `/api/shifts/start` already requires to clock in. */
const SHIFT_PERMISSION = "orders.create" as const;
```

Append to `SYNC_EVENT_REGISTRY` (before the closing `] as const`):

```ts

  // Phase 45: a shift opened or cashed up at the till reaches the cloud's
  // shift reports; the row travels whole and replays idempotently by id.
  { type: "shift.opened", schemaVersion: 1, handler: "shift.opened", permission: SHIFT_PERMISSION, effectClass: "shift", locationRule: "event_location", dependencyErrors: ["employee_not_found"], payloadFields: ["shiftId", "employeeId", "businessDate", "openingFloat", "closingFloat", "startedAt", "endedAt", "closedBy"] },
  { type: "shift.closed", schemaVersion: 1, handler: "shift.closed", permission: SHIFT_PERMISSION, effectClass: "shift", locationRule: "event_location", dependencyErrors: ["employee_not_found"], payloadFields: ["shiftId", "employeeId", "businessDate", "openingFloat", "closingFloat", "startedAt", "endedAt", "closedBy"] },
```

- [ ] **Step 2: Write the failing unit test**

```ts
// src/lib/shift-sync.test.ts
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { EmployeeShift } from "./shift-service";
import { parseShiftSyncPayload, recordShiftSyncEvent, shiftSyncClientEventId, shiftSyncPayload } from "./shift-sync";

function shift(overrides: Partial<EmployeeShift> = {}): EmployeeShift {
  return {
    id: randomUUID(),
    employeeId: randomUUID(),
    businessId: randomUUID(),
    locationId: randomUUID(),
    sessionId: randomUUID(),
    deviceId: null,
    openingFloat: 5_000_000,
    closingFloat: null,
    businessDate: "2026-09-29",
    startedAt: "2026-09-29T14:30:00.000Z",
    endedAt: null,
    closedBy: null,
    ...overrides,
  };
}

describe("shift sync payload", () => {
  it("round-trips an open and a cashed-up shift, without the device-local session", () => {
    const open = shift();
    expect(parseShiftSyncPayload({ ...shiftSyncPayload(open) })).toEqual(shiftSyncPayload(open));
    expect(shiftSyncPayload(open)).not.toHaveProperty("sessionId");
    const closed = shift({ closingFloat: 7_500_000, endedAt: "2026-09-29T23:10:00.000Z", closedBy: randomUUID() });
    expect(parseShiftSyncPayload({ ...shiftSyncPayload(closed) })).toEqual(shiftSyncPayload(closed));
  });

  it("refuses a payload it cannot trust", () => {
    const good = shiftSyncPayload(shift({ endedAt: "2026-09-29T23:10:00.000Z", closingFloat: 1 }));
    for (const bad of [
      { ...good, shiftId: "not-a-uuid" },
      { ...good, employeeId: 7 },
      { ...good, businessDate: "2026/09/29" },
      { ...good, startedAt: "yesterday" },
      { ...good, endedAt: "2026-09-29T10:00:00.000Z" },
      { ...good, openingFloat: -1 },
      { ...good, closingFloat: 1.5 },
      { ...good, closedBy: "someone" },
    ]) {
      expect(parseShiftSyncPayload(bad as Record<string, unknown>)).toBeNull();
    }
  });

  it("names both events after the shift, so a retry is the same event", () => {
    expect(shiftSyncClientEventId("shift.opened", "abc")).toBe("shift.opened:abc");
    expect(shiftSyncClientEventId("shift.closed", "abc")).toBe("shift.closed:abc");
  });
});

describe("recordShiftSyncEvent", () => {
  it("records nothing for a shift with no branch", async () => {
    const client = { query: vi.fn() } as unknown as PoolClient;
    await recordShiftSyncEvent(client, "shift.opened", shift({ locationId: null }), { userId: null, role: "cashier" });
    expect(client.query).not.toHaveBeenCalled();
  });

  it("appends one outbox row named after the shift", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    const opened = shift();
    await recordShiftSyncEvent({ query } as unknown as PoolClient, "shift.opened", opened, { userId: opened.employeeId, role: "cashier" });
    expect(query).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(query.mock.calls[0])).toContain(`shift.opened:${opened.id}`);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `npx vitest run src/lib/shift-sync.test.ts`
Expected: FAIL, `Failed to resolve import "./shift-sync"`.

- [ ] **Step 4: Write `src/lib/shift-sync.ts`**

```ts
/**
 * Phase 45 — shifts cross between a Hybrid desktop and the cloud.
 *
 * The desktop is the till, so clocking in and the cash-up happen there, and
 * the cloud's shift reports need them. Each event carries the whole row; the
 * receiver upserts it by id, so a replay is idempotent and an `opened` that
 * arrives after its `closed` changes nothing. The session and device are
 * device-local and never travel.
 */
import type { PoolClient } from "pg";
import type { Role } from "./auth";
import type { EmployeeShift } from "./shift-service";
import { appendSyncOutboxEvent } from "./sync-outbox";
import { isUuid } from "./uuid";

export type ShiftSyncEventType = "shift.opened" | "shift.closed";

export interface ShiftSyncPayload {
  shiftId: string;
  employeeId: string;
  businessDate: string;
  openingFloat: number | null;
  closingFloat: number | null;
  startedAt: string;
  endedAt: string | null;
  closedBy: string | null;
}

export function shiftSyncPayload(shift: EmployeeShift): ShiftSyncPayload {
  return {
    shiftId: shift.id,
    employeeId: shift.employeeId,
    businessDate: shift.businessDate,
    openingFloat: shift.openingFloat,
    closingFloat: shift.closingFloat,
    startedAt: shift.startedAt,
    endedAt: shift.endedAt,
    closedBy: shift.closedBy,
  };
}

function instant(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

/** A float in integer Rial, null, or `undefined` when invalid. */
function float(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function parseShiftSyncPayload(raw: Record<string, unknown>): ShiftSyncPayload | null {
  if (!isUuid(raw.shiftId) || !isUuid(raw.employeeId)) return null;
  if (typeof raw.businessDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw.businessDate)) return null;
  const startedAt = instant(raw.startedAt);
  if (!startedAt) return null;
  let endedAt: string | null = null;
  if (raw.endedAt !== null && raw.endedAt !== undefined) {
    endedAt = instant(raw.endedAt);
    if (!endedAt || Date.parse(endedAt) < Date.parse(startedAt)) return null;
  }
  const openingFloat = float(raw.openingFloat);
  const closingFloat = float(raw.closingFloat);
  if (openingFloat === undefined || closingFloat === undefined) return null;
  let closedBy: string | null = null;
  if (raw.closedBy !== null && raw.closedBy !== undefined) {
    if (!isUuid(raw.closedBy)) return null;
    closedBy = raw.closedBy;
  }
  return {
    shiftId: raw.shiftId,
    employeeId: raw.employeeId,
    businessDate: raw.businessDate,
    openingFloat,
    closingFloat,
    startedAt,
    endedAt,
    closedBy,
  };
}

/** The shift's own id names both events, so a retried request is one event. */
export function shiftSyncClientEventId(type: ShiftSyncEventType, shiftId: string): string {
  return `${type}:${shiftId}`;
}

/** Called inside the transaction that opened or closed the shift. */
export async function recordShiftSyncEvent(
  client: PoolClient,
  type: ShiftSyncEventType,
  shift: EmployeeShift,
  actor: { userId: string | null; role: Role },
): Promise<void> {
  // A shift with no branch cannot be routed to a peer; it stays local.
  if (!shift.locationId) return;
  await appendSyncOutboxEvent(client, {
    locationId: shift.locationId,
    clientEventId: shiftSyncClientEventId(type, shift.id),
    eventType: type,
    payload: { ...shiftSyncPayload(shift) },
    actorUserId: actor.userId,
    actorRole: actor.role,
    occurredAt: type === "shift.closed" ? (shift.endedAt ?? shift.startedAt) : shift.startedAt,
  });
}

/** The receiver's side: upsert the row by id. Returns the shift id. */
export async function applyShiftReplay(
  client: PoolClient,
  businessId: string,
  locationId: string,
  shift: ShiftSyncPayload,
): Promise<string> {
  // employee_shifts references employees(id), which is keyed on the member's
  // user id; staff sync brings the user, this brings the employee row.
  await client.query(
    `INSERT INTO employees (id, business_id)
     SELECT id, business_id FROM users WHERE id = $1 AND business_id = $2
     ON CONFLICT DO NOTHING`,
    [shift.employeeId, businessId],
  );
  const known = await client.query("SELECT 1 FROM employees WHERE id = $1 AND business_id = $2", [
    shift.employeeId,
    businessId,
  ]);
  if (known.rowCount !== 1) throw new Error("employee_not_found");
  await client.query("SAVEPOINT shift_replay");
  try {
    await client.query(
      `INSERT INTO employee_shifts
         (id, employee_id, business_id, location_id, opening_float, closing_float,
          business_date, started_at, ended_at, closed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8, $9,
               (SELECT id FROM users WHERE id = $10 AND business_id = $3))
       ON CONFLICT (id) DO UPDATE SET
         closing_float = COALESCE(employee_shifts.closing_float, EXCLUDED.closing_float),
         ended_at      = COALESCE(employee_shifts.ended_at, EXCLUDED.ended_at),
         closed_by     = COALESCE(employee_shifts.closed_by, EXCLUDED.closed_by)`,
      [
        shift.shiftId,
        shift.employeeId,
        businessId,
        locationId,
        shift.openingFloat,
        shift.closingFloat,
        shift.businessDate,
        shift.startedAt,
        shift.endedAt,
        shift.closedBy,
      ],
    );
    await client.query("RELEASE SAVEPOINT shift_replay");
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT shift_replay");
    // idx_employee_shifts_employee_open: this person already has an open shift
    // on this side. Not a missing prerequisite; the owner has to see it.
    if ((error as { code?: string }).code === "23505") throw new Error("shift_already_open");
    throw error;
  }
  return shift.shiftId;
}
```

- [ ] **Step 5: Run it to see it pass**

Run: `npx vitest run src/lib/shift-sync.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Handle the events**

In `src/lib/sync-domain-handlers.ts` add `import { applyShiftReplay, parseShiftSyncPayload } from "./shift-sync";` and, before the `default:` of `switch (context.definition.handler)`, add:

```ts
    case "shift.opened":
    case "shift.closed": {
      const shift = parseShiftSyncPayload(payload);
      if (!shift) throw new SyncPayloadError("invalid_shift");
      const effectId = await applyShiftReplay(client, businessId, locationId, shift);
      return { effectType: context.definition.handler === "shift.closed" ? "shift_close" : "shift_open", effectId };
    }
```

- [ ] **Step 7: Record them where shifts change**

In `src/lib/shift-service.ts` add `import type { Role } from "./auth";` and `import { recordShiftSyncEvent } from "./shift-sync";`.

Replace the `try { const { rows } = await query<ShiftRow>(… INSERT INTO employee_shifts …); if (!rows[0]) …; const shift = toShift(rows[0]);` opening of `openShift` so the insert and the outbox row commit together. The full new function head (keep the audit/coworker/notification calls that follow unchanged):

```ts
export async function openShift(
  employeeId: string,
  businessId: string,
  sessionId: string | null,
  openingFloat: number | null = null,
  fallbackLocationId: string | null = null,
  actorRole: Role = "cashier",
): Promise<EmployeeShift> {
  let shift: EmployeeShift;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<ShiftRow>(
      `INSERT INTO employee_shifts
         (employee_id, business_id, location_id, session_id, device_id, opening_float, business_date)
       SELECT $1, $2, coalesce(s.location_id, $5::uuid), s.id, s.device_id, $4,
              app_business_date(now(), l.timezone, l.business_day_start_minutes)
         FROM employee_sessions s
         LEFT JOIN locations l ON l.id = coalesce(s.location_id, $5::uuid)
        WHERE s.id = $3 AND s.business_id = $2
       RETURNING ${SHIFT_COLUMNS}`,
      [employeeId, businessId, sessionId, openingFloat, fallbackLocationId],
    );
    if (!rows[0]) throw new ShiftError("session_required", 400);
    shift = toShift(rows[0]);
    // Phase 45: the cloud's shift reports hear about it in the same commit.
    await recordShiftSyncEvent(client, "shift.opened", shift, { userId: employeeId, role: actorRole });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if ((err as { code?: string }).code === "23505") throw new ShiftError("shift_already_open", 409);
    throw err;
  } finally {
    client.release();
  }
  await auditShift(businessId, employeeId, "shift.opened", shift.id, { openingFloat });
```

…followed by the existing `recordCoworkerEvent`, `recordNotification` and `return shift;`. Remove the old outer `try { … } catch (err) { if (…23505…) … }` wrapper, because the new block above handles 23505.

In `closeShiftRow` add a trailing parameter `actorRole: Role`, and immediately before its `await client.query("COMMIT");` add:

```ts
    await recordShiftSyncEvent(client, "shift.closed", toShift(rows[0]), { userId: actorId, role: actorRole });
```

Update the two callers:

```ts
export async function closeOwnShift(
  employeeId: string,
  businessId: string,
  closingFloat: number | null = null,
  actorRole: Role = "cashier",
): Promise<CloseShiftResult> {
  return closeShiftRow({ employeeId }, businessId, employeeId, closingFloat, actorRole);
}
```

```ts
export async function closeShiftById(
  shiftId: string,
  businessId: string,
  actorId: string | null,
  closingFloat: number | null = null,
  actorRole: Role = "manager",
): Promise<CloseShiftResult> {
  if (!isUuid(shiftId)) throw new ShiftError("no_active_shift", 404);
  return closeShiftRow({ id: shiftId }, businessId, actorId, closingFloat, actorRole);
}
```

Pass the caller's role from the three routes:
- `src/app/api/shifts/start/route.ts`: add `session.role,` as the last argument of `openShift(…)` (after `location?.id ?? null,`).
- `src/app/api/shifts/end/route.ts`: `closeOwnShift(session.sub, session.businessId, body.closingFloat ?? null, session.role)`.
- `src/app/api/shifts/[id]/close/route.ts`: `closeShiftById(id, session.businessId, session.sub, body.closingFloat ?? null, session.role)`.

- [ ] **Step 8: Declare the domain in the contract**

In `src/lib/data-ownership.ts` change the version line and its comment to:

```ts
/** v3 (Phase 45): shifts travel as events; v2 (migration 0190): customers and the menu sync continuously. */
export const REPLICATION_CONTRACT_VERSION = 3 as const;
```

and add a domain right after the `payments: replicated({ … }),` entry:

```ts
  shifts: replicated({
    domain: "shifts",
    authority: "site_authoritative",
    direction: "bidirectional",
    conflictPolicy: "immutable_idempotent",
    tombstonePolicy: "not_applicable",
    bootstrap: "none",
    continuousSync: "active",
    identity: "shift UUID; client_event_id shift.opened:<id> / shift.closed:<id>",
    retry:
      "transactional sync_events outbox; the row is upserted by id; a missing employee defers; a second open shift for the same person dead-letters",
    transport: "events",
    events: [event("shift.opened", 1), event("shift.closed", 1)],
  }),
```

- [ ] **Step 9: Run the sync unit tests**

Run: `npx vitest run src/lib/sync-event-registry.test.ts src/lib/data-ownership.test.ts src/lib/shift-sync.test.ts src/lib/sync-outbox.test.ts && npx tsc --noEmit`
Expected: PASS. If `data-ownership.test.ts` pins `REPLICATION_CONTRACT_VERSION` to `2`, change that expectation to `3`. That is the only test edit allowed here.

- [ ] **Step 10: Write the failing integration tests**

In `integration/hybrid-sync.integration.test.ts`:
1. Add `import { closeOwnShift, openShift } from "../src/lib/shift-service";`.
2. Add, above `describe("drift check", …)`:

```ts
/** A signed-in till session for the owner on the desktop (openShift needs one). */
async function desktopTillSession(): Promise<string> {
  return withTenant(biz.businessId, async () => {
    await query("INSERT INTO employees (id, business_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [biz.ownerId, biz.businessId]);
    const created = await query<{ id: string }>(
      `INSERT INTO employee_sessions (employee_id, business_id, location_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '1 hour') RETURNING id`,
      [biz.ownerId, biz.businessId, biz.locationId, `test-${randomUUID()}`],
    );
    return created.rows[0].id;
  });
}

describe("shifts", () => {
  it("brings a shift opened and cashed up at the till to the cloud", async () => {
    const sessionId = await desktopTillSession();
    const opened = await withTenant(biz.businessId, () =>
      openShift(biz.ownerId, biz.businessId, sessionId, 5_000_000, biz.locationId, "owner"),
    );
    await withTenant(biz.businessId, () => closeOwnShift(biz.ownerId, biz.businessId, 7_500_000, "owner"));
    await syncRound();
    const cloud = await onCentral(() =>
      withTenant(biz.businessId, () =>
        query<{ employee_id: string; location_id: string; opening: string; closing: string; closed: boolean; session_id: string | null }>(
          `SELECT employee_id, location_id, opening_float::text AS opening, closing_float::text AS closing,
                  ended_at IS NOT NULL AS closed, session_id
             FROM employee_shifts WHERE id = $1`,
          [opened.id],
        ),
      ),
    );
    expect(cloud.rows[0]).toEqual({
      employee_id: biz.ownerId,
      location_id: biz.locationId,
      opening: "5000000",
      closing: "7500000",
      closed: true,
      session_id: null,
    });
  });

  it("refuses, visibly, a second open shift for the same person", async () => {
    const cloudShiftId = await onCentral(() =>
      withTenant(biz.businessId, async () => {
        await query("INSERT INTO employees (id, business_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [biz.ownerId, biz.businessId]);
        return (
          await query<{ id: string }>(
            `INSERT INTO employee_shifts (employee_id, business_id, location_id, business_date)
             VALUES ($1, $2, $3, current_date) RETURNING id`,
            [biz.ownerId, biz.businessId, biz.locationId],
          )
        ).rows[0].id;
      }),
    );
    const sessionId = await desktopTillSession();
    const desktopShift = await withTenant(biz.businessId, () =>
      openShift(biz.ownerId, biz.businessId, sessionId, null, biz.locationId, "owner"),
    );
    await syncRound();
    const deadLetters = await onCentral(() =>
      withTenant(biz.businessId, () =>
        query<{ error_code: string }>(
          `SELECT error_code FROM sync_event_dead_letters WHERE business_id = $1 AND client_event_id = $2`,
          [biz.businessId, `shift.opened:${desktopShift.id}`],
        ),
      ),
    );
    expect(deadLetters.rows.map((row) => row.error_code)).toEqual(["shift_already_open"]);
    // Tidy both sides so later tests start with nobody clocked in.
    await onCentral(() =>
      withTenant(biz.businessId, () => query("UPDATE employee_shifts SET ended_at = now() WHERE id = $1", [cloudShiftId])),
    );
    await withTenant(biz.businessId, () => closeOwnShift(biz.ownerId, biz.businessId, null, "owner"));
  });
});
```

- [ ] **Step 11: Run the integration tests**

Start Postgres first if it isn't running: `npm run db:dev:start`.
Run: `npm run test:db -- integration/hybrid-sync.integration.test.ts`
Expected: all tests PASS, including the two new `shifts` tests. If the second test finds the event **deferred** instead of dead-lettered, the replay error is being classified as a dependency: check that `shift_already_open` is not listed in `dependencyErrors`.

- [ ] **Step 12: Commit**

```bash
git add src/lib/shift-sync.ts src/lib/shift-sync.test.ts src/lib/sync-event-registry.ts src/lib/sync-domain-handlers.ts src/lib/data-ownership.ts src/lib/data-ownership.test.ts src/lib/shift-service.ts src/app/api/shifts integration/hybrid-sync.integration.test.ts
git commit -m "feat(hybrid): shifts opened and cashed up at the till sync to the cloud

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Site profile — branch settings and switches from the cloud

**Files:**
- Create: `src/lib/site-profile.ts`
- Test: `src/lib/site-profile.test.ts`
- Create: `src/lib/site-profile-service.ts`
- Create: `src/app/api/server-sync/site-profile/route.ts`
- Modify: `src/lib/settings.ts` (`SETTING_KEYS`)
- Modify: `src/middleware.ts` (three lists; each already contains `"/api/server-sync/digest"`)
- Modify: `src/lib/server-sync.ts` (`runServerSyncTick`, after the master-data `try` block)
- Modify: `src/app/api/connection/status/route.ts` and `src/app/(app)/settings/cloud-sync-settings.tsx`
- Modify: `integration/hybrid-sync.integration.test.ts`

**Interfaces:**
- Consumes: `requireSiteCredential` (`src/lib/server-sync-auth.ts`), `effectiveFeatures` (`src/lib/features.ts`), `effectiveAppAvailability` (`src/lib/app-availability-service.ts`), `APP_KEYS`/`AppKey` (`src/lib/apps.ts`), `isAppAvailabilityState`/`AppAvailabilityRecord` (`src/lib/app-availability.ts`), `nextAttemptAt`/`attemptDue` (`src/lib/sync-backoff.ts`), `getSetting`/`setSetting` (`src/lib/settings.ts`).
- Produces:
  - `interface SiteProfile { schemaVersion: 1; location: SiteProfileLocation; features: Record<string, boolean>; apps: Partial<Record<AppKey, AppAvailabilityRecord>> }`
  - `validateSiteProfile(raw: unknown): SiteProfile | null`, `siteProfileHash(profile): string`
  - `interface SiteProfileState { hash; appliedAt; checkedAt; lastError; failures; nextAttemptAt }`, `EMPTY_SITE_PROFILE_STATE`, `siteProfileSucceeded(prev, hash, applied, now)`, `siteProfileFailed(prev, error, now, random?)`
  - `buildSiteProfile(businessId, locationId): Promise<SiteProfile | null>`, `applySiteProfile(businessId, locationId, profile)`, `runSiteProfileSync(businessId, now?): Promise<SiteProfileState>`
  - `SETTING_KEYS.siteProfileState = "server_sync.site_profile_state"`

- [ ] **Step 1: Write the failing unit test**

```ts
// src/lib/site-profile.test.ts
import { describe, expect, it } from "vitest";
import {
  EMPTY_SITE_PROFILE_STATE,
  siteProfileFailed,
  siteProfileHash,
  siteProfileSucceeded,
  validateSiteProfile,
  type SiteProfile,
} from "./site-profile";

const profile: SiteProfile = {
  schemaVersion: 1,
  location: {
    id: "b74b6234-5af6-4ba2-9cc7-1c6492c3e04b",
    name: "شعبه مرکزی",
    address: null,
    phone: "02100000000",
    timezone: "Asia/Tehran",
    businessDayStartMinutes: 1080,
    isActive: true,
  },
  features: { ai_assistant: false, reservations: true },
  apps: { growth: { state: "maintenance", note: null, availableFrom: null } },
};

describe("validateSiteProfile", () => {
  it("accepts what the cloud sends", () => {
    expect(validateSiteProfile(JSON.parse(JSON.stringify(profile)))).toEqual(profile);
  });

  it("refuses a body it cannot trust, rather than applying part of it", () => {
    const bad = [
      null,
      { ...profile, schemaVersion: 2 },
      { ...profile, location: { ...profile.location, id: "x" } },
      { ...profile, location: { ...profile.location, businessDayStartMinutes: 1440 } },
      { ...profile, location: { ...profile.location, timezone: "" } },
      { ...profile, features: { ai_assistant: "no" } },
      { ...profile, apps: { growth: { state: "broken", note: null, availableFrom: null } } },
      { ...profile, apps: { nosuchapp: { state: "available", note: null, availableFrom: null } } },
      { ...profile, apps: { growth: { state: "coming_soon", note: null, availableFrom: "1405-07-08" } } },
    ];
    for (const raw of bad) expect(validateSiteProfile(raw)).toBeNull();
  });
});

describe("siteProfileHash", () => {
  it("does not depend on key order", () => {
    const reordered = { ...profile, features: { reservations: true, ai_assistant: false } };
    expect(siteProfileHash(reordered)).toBe(siteProfileHash(profile));
    expect(siteProfileHash({ ...profile, features: { ...profile.features, ai_assistant: true } })).not.toBe(siteProfileHash(profile));
  });
});

describe("site profile state", () => {
  const now = new Date("2026-09-30T12:00:00.000Z");

  it("records when a changed profile was applied and clears a failure", () => {
    const failed = siteProfileFailed(EMPTY_SITE_PROFILE_STATE, "HTTP 502", now, () => 0.5);
    const next = siteProfileSucceeded(failed, "h1", true, now);
    expect(next).toEqual({ hash: "h1", appliedAt: now.toISOString(), checkedAt: now.toISOString(), lastError: null, failures: 0, nextAttemptAt: null });
  });

  it("keeps the old applied time when nothing changed", () => {
    const applied = siteProfileSucceeded(EMPTY_SITE_PROFILE_STATE, "h1", true, new Date("2026-09-29T00:00:00.000Z"));
    expect(siteProfileSucceeded(applied, "h1", false, now).appliedAt).toBe("2026-09-29T00:00:00.000Z");
  });

  it("keeps the last copy and backs off on failure", () => {
    const applied = siteProfileSucceeded(EMPTY_SITE_PROFILE_STATE, "h1", true, now);
    const failed = siteProfileFailed(applied, "site_profile_rejected: HTTP 404", now, () => 0.5);
    expect(failed.hash).toBe("h1");
    expect(failed.failures).toBe(1);
    expect(failed.lastError).toBe("site_profile_rejected: HTTP 404");
    expect(Date.parse(failed.nextAttemptAt!)).toBeGreaterThan(now.getTime());
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/lib/site-profile.test.ts`
Expected: FAIL, `Failed to resolve import "./site-profile"`.

- [ ] **Step 3: Write `src/lib/site-profile.ts`**

```ts
/**
 * Phase 45 — what a Hybrid desktop reads from the cloud and does not own: the
 * branch's own settings (the business-day start that decides which day a
 * night's bills belong to) and the switches the super-admin console flips
 * (features, app availability). Pairing copied these once; this keeps them
 * current. Pure: shape validation, a stable hash, and the state transitions.
 */
import { createHash } from "node:crypto";
import { isAppAvailabilityState, type AppAvailabilityRecord } from "./app-availability";
import { APP_KEYS, type AppKey } from "./apps";
import { nextAttemptAt } from "./sync-backoff";
import { isUuid } from "./uuid";

export interface SiteProfileLocation {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  timezone: string;
  businessDayStartMinutes: number | null;
  isActive: boolean;
}

export interface SiteProfile {
  schemaVersion: 1;
  location: SiteProfileLocation;
  features: Record<string, boolean>;
  apps: Partial<Record<AppKey, AppAvailabilityRecord>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nullableText(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function validLocation(raw: unknown): SiteProfileLocation | null {
  if (!isRecord(raw)) return null;
  const start = raw.businessDayStartMinutes;
  if (
    !isUuid(raw.id) ||
    typeof raw.name !== "string" ||
    !raw.name.trim() ||
    !nullableText(raw.address) ||
    !nullableText(raw.phone) ||
    typeof raw.timezone !== "string" ||
    !raw.timezone.trim() ||
    !(start === null || (Number.isInteger(start) && (start as number) >= 0 && (start as number) < 1440)) ||
    typeof raw.isActive !== "boolean"
  ) {
    return null;
  }
  return {
    id: raw.id,
    name: raw.name,
    address: raw.address,
    phone: raw.phone,
    timezone: raw.timezone,
    businessDayStartMinutes: start as number | null,
    isActive: raw.isActive,
  };
}

export function validateSiteProfile(raw: unknown): SiteProfile | null {
  if (!isRecord(raw) || raw.schemaVersion !== 1) return null;
  const location = validLocation(raw.location);
  if (!location || !isRecord(raw.features) || !isRecord(raw.apps)) return null;
  const features: Record<string, boolean> = {};
  for (const [key, enabled] of Object.entries(raw.features)) {
    if (typeof enabled !== "boolean") return null;
    features[key] = enabled;
  }
  const apps: Partial<Record<AppKey, AppAvailabilityRecord>> = {};
  for (const [key, record] of Object.entries(raw.apps)) {
    if (!(APP_KEYS as readonly string[]).includes(key) || !isRecord(record)) return null;
    if (!isAppAvailabilityState(record.state) || !nullableText(record.note)) return null;
    const from = record.availableFrom;
    if (!(from === null || (typeof from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(from) && from.startsWith("20")))) return null;
    apps[key as AppKey] = { state: record.state, note: record.note, availableFrom: from };
  }
  return { schemaVersion: 1, location, features, apps };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function siteProfileHash(profile: SiteProfile): string {
  return createHash("sha256").update(JSON.stringify(canonical(profile))).digest("hex");
}

export interface SiteProfileState {
  /** Hash of the last profile applied; unchanged profiles are not re-applied. */
  hash: string | null;
  appliedAt: string | null;
  checkedAt: string | null;
  lastError: string | null;
  failures: number;
  nextAttemptAt: string | null;
}

export const EMPTY_SITE_PROFILE_STATE: SiteProfileState = {
  hash: null,
  appliedAt: null,
  checkedAt: null,
  lastError: null,
  failures: 0,
  nextAttemptAt: null,
};

export function siteProfileSucceeded(previous: SiteProfileState, hash: string, applied: boolean, now: Date): SiteProfileState {
  return {
    hash,
    appliedAt: applied ? now.toISOString() : previous.appliedAt,
    checkedAt: now.toISOString(),
    lastError: null,
    failures: 0,
    nextAttemptAt: null,
  };
}

/** The last applied copy stays in force; only the error and the backoff move. */
export function siteProfileFailed(
  previous: SiteProfileState,
  error: string,
  now: Date,
  random: () => number = Math.random,
): SiteProfileState {
  const failures = previous.failures + 1;
  return {
    ...previous,
    checkedAt: now.toISOString(),
    lastError: error.slice(0, 300),
    failures,
    nextAttemptAt: nextAttemptAt(failures, now, random),
  };
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `npx vitest run src/lib/site-profile.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Add the setting key**

In `src/lib/settings.ts`, inside `SETTING_KEYS` after `syncDriftState: "server_sync.drift_state",` add:

```ts
  /** Phase 45: the desktop's copy of the cloud's branch settings and switches (site-profile-service.ts). */
  siteProfileState: "server_sync.site_profile_state",
```

- [ ] **Step 6: Write the service**

```ts
// src/lib/site-profile-service.ts
/**
 * Phase 45 — the cloud serves a paired branch its profile
 * (GET /api/server-sync/site-profile); the desktop applies it on every sync
 * tick. The branch row and the switches are the cloud's, so the desktop
 * overwrites its copy. App availability lands as this business's override,
 * so the desktop's global catalogue is never rewritten. Offline, the last
 * applied copy stays in force.
 */
import { effectiveAppAvailability } from "./app-availability-service";
import { getPool, query } from "./db";
import { effectiveFeatures } from "./features";
import type { ServerSyncConfig } from "./server-sync-config";
import { getSetting, setSetting, SETTING_KEYS } from "./settings";
import {
  EMPTY_SITE_PROFILE_STATE,
  siteProfileFailed,
  siteProfileHash,
  siteProfileSucceeded,
  validateSiteProfile,
  type SiteProfile,
  type SiteProfileState,
} from "./site-profile";
import { attemptDue } from "./sync-backoff";

/** The cloud's side. Null when the branch is not this business's. */
export async function buildSiteProfile(businessId: string, locationId: string): Promise<SiteProfile | null> {
  const { rows } = await query<{
    id: string;
    name: string;
    address: string | null;
    phone: string | null;
    timezone: string;
    business_day_start_minutes: number | null;
    is_active: boolean;
  }>(
    `SELECT id, name, address, phone, timezone, business_day_start_minutes, is_active
       FROM locations WHERE id = $1 AND business_id = $2`,
    [locationId, businessId],
  );
  const row = rows[0];
  if (!row) return null;
  const [features, availability] = await Promise.all([effectiveFeatures(businessId), effectiveAppAvailability(businessId)]);
  return {
    schemaVersion: 1,
    location: {
      id: row.id,
      name: row.name,
      address: row.address,
      phone: row.phone,
      timezone: row.timezone,
      businessDayStartMinutes: row.business_day_start_minutes,
      isActive: row.is_active,
    },
    features,
    apps: Object.fromEntries(
      Object.values(availability).map((app) => [app.app, { state: app.state, note: app.note, availableFrom: app.availableFrom }]),
    ),
  };
}

/** The desktop's side, in one transaction. */
export async function applySiteProfile(businessId: string, locationId: string, profile: SiteProfile): Promise<void> {
  if (profile.location.id !== locationId) throw new Error("site_profile_location_mismatch");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE locations
          SET name = $3, address = $4, phone = $5, timezone = $6,
              business_day_start_minutes = $7, is_active = $8
        WHERE id = $1 AND business_id = $2`,
      [
        locationId,
        businessId,
        profile.location.name,
        profile.location.address,
        profile.location.phone,
        profile.location.timezone,
        profile.location.businessDayStartMinutes,
        profile.location.isActive,
      ],
    );
    const flags = Object.entries(profile.features);
    await client.query(
      `INSERT INTO business_features (business_id, flag_key, enabled)
       SELECT $1, input.key, input.enabled
         FROM unnest($2::text[], $3::boolean[]) AS input(key, enabled)
        WHERE EXISTS (SELECT 1 FROM feature_flags f WHERE f.key = input.key)
       ON CONFLICT (business_id, flag_key) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
      [businessId, flags.map(([key]) => key), flags.map(([, enabled]) => enabled)],
    );
    const apps = Object.entries(profile.apps);
    await client.query(
      `INSERT INTO business_app_availability (business_id, app_key, state, note, available_from)
       SELECT $1, input.app, input.state, input.note, input.available_from::date
         FROM unnest($2::text[], $3::text[], $4::text[], $5::text[]) AS input(app, state, note, available_from)
       ON CONFLICT (business_id, app_key) DO UPDATE
         SET state = EXCLUDED.state, note = EXCLUDED.note, available_from = EXCLUDED.available_from, updated_at = now()`,
      [
        businessId,
        apps.map(([app]) => app),
        apps.map(([, record]) => record!.state),
        apps.map(([, record]) => record!.note),
        apps.map(([, record]) => record!.availableFrom),
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** One desktop tick. Never throws for a cloud-side failure; it records it and backs off. */
export async function runSiteProfileSync(businessId: string, now: Date = new Date()): Promise<SiteProfileState> {
  const previous = (await getSetting<SiteProfileState>(businessId, SETTING_KEYS.siteProfileState)) ?? EMPTY_SITE_PROFILE_STATE;
  const config = await getSetting<ServerSyncConfig>(businessId, SETTING_KEYS.serverSyncConfig);
  if (!config?.enabled || !config.remoteUrl?.trim() || !config.token?.trim() || !config.locationId) return previous;
  if (!attemptDue(previous.nextAttemptAt, now)) return previous;
  let next: SiteProfileState;
  try {
    const response = await fetch(`${config.remoteUrl.trim().replace(/\/+$/, "")}/api/server-sync/site-profile`, {
      headers: { Authorization: `Bearer ${config.token.trim()}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`site_profile_rejected: HTTP ${response.status}`);
    const profile = validateSiteProfile(await response.json());
    if (!profile) throw new Error("invalid_site_profile");
    const hash = siteProfileHash(profile);
    const changed = hash !== previous.hash;
    // ponytail: nothing changed and nothing to clear — skip the settings write every 30 s.
    if (!changed && previous.lastError === null) return previous;
    if (changed) await applySiteProfile(businessId, config.locationId, profile);
    next = siteProfileSucceeded(previous, hash, changed, now);
  } catch (error) {
    next = siteProfileFailed(previous, error instanceof Error ? error.message : String(error), now);
  }
  await setSetting(businessId, SETTING_KEYS.siteProfileState, next);
  return next;
}
```

- [ ] **Step 7: Serve it from the cloud**

```ts
// src/app/api/server-sync/site-profile/route.ts
import { NextRequest, NextResponse } from "next/server";
import { withTenant } from "@/lib/db";
import { requireSiteCredential } from "@/lib/server-sync-auth";
import { buildSiteProfile } from "@/lib/site-profile-service";

/**
 * Phase 45: a paired desktop's branch settings and switches, read on every
 * sync tick. Bearer-authenticated with the site device credential, which —
 * never a parameter — names the business and the branch.
 */
export async function GET(request: NextRequest) {
  const auth = await requireSiteCredential(request);
  if ("response" in auth) return auth.response;
  const { identity } = auth;
  const profile = await withTenant(
    identity.businessId,
    () => buildSiteProfile(identity.businessId, identity.locationId),
    { locationId: identity.locationId },
  );
  if (!profile) return NextResponse.json({ error: "location_not_found" }, { status: 404 });
  return NextResponse.json(profile);
}
```

In `src/middleware.ts`, in each of the three lists that contain `"/api/server-sync/digest",`, add on the next line:

```ts
  "/api/server-sync/site-profile",
```

Verify: `grep -c "/api/server-sync/site-profile" src/middleware.ts` prints `3`.

- [ ] **Step 8: Call it on every tick**

In `src/lib/server-sync.ts` add `import { runSiteProfileSync } from "./site-profile-service";` and, in `runServerSyncTick`, directly after the master-data `try { … runMasterSync … } catch { … }` block:

```ts
    try {
      // Phase 45: the branch settings and switches the cloud owns, before this
      // tick's events, so the bills pulled below land on the cloud's business day.
      await withTenant(row.business_id, () => runSiteProfileSync(row.business_id));
    } catch (err) {
      console.error(`site profile sync failed for business ${row.business_id}:`, err);
    }
```

- [ ] **Step 9: Show it on the sync panel**

In `src/app/api/connection/status/route.ts`: add `import type { SiteProfileState } from "@/lib/site-profile";` (and `getSetting`/`SETTING_KEYS` from `@/lib/settings` if not already imported). After the `iamError` block add:

```ts
  const siteProfile = await getSetting<SiteProfileState>(session.businessId, SETTING_KEYS.siteProfileState);
```

and in the final `NextResponse.json({ profile: deployment.profile, ...state, … })` add, right after `...state,`:

```ts
    siteProfile: siteProfile ? { appliedAt: siteProfile.appliedAt, lastError: siteProfile.lastError } : null,
```

In `src/app/(app)/settings/cloud-sync-settings.tsx`, change the response type to:

```ts
interface StatusResponse extends PlatformConnectionState {
  profile: DeploymentProfile;
  siteProfile?: { appliedAt: string | null; lastError: string | null } | null;
}
```

and directly under the `<p …>` that shows «آخرین همگرایی دوطرفه» (inside the same `<div>`) add:

```tsx
            {!local ? (
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                {`تنظیمات شعبه از ابر: ${state.siteProfile?.appliedAt ? new Date(state.siteProfile.appliedAt).toLocaleString("fa-IR") : "هنوز دریافت نشده"}`}
                {state.siteProfile?.lastError ? ` — خطای آخرین دریافت: ${state.siteProfile.lastError}` : ""}
              </p>
            ) : null}
```

Replace the data-domains paragraph («سفارش، حسابداری و موجودی در سایت محلی مرجع‌اند؛ …») with:

```tsx
        <p className="mt-2 text-sm leading-6 text-muted-foreground">صندوق، میزها، آشپزخانه و شیفت روی این دستگاه کار می‌کنند و با برگشت اینترنت به ابر فرستاده می‌شوند. حسابداری، گزارش‌ها، انبار، مشتریان و تنظیمات کسب‌وکار در نسخهٔ ابری‌اند؛ مسیر پشتیبان و چاپگر فقط روی این دستگاه می‌مانند.</p>
```

- [ ] **Step 10: Write the failing integration tests**

In `integration/hybrid-sync.integration.test.ts`:
1. Add imports: `import { runSiteProfileSync } from "../src/lib/site-profile-service";`, `import { EMPTY_SITE_PROFILE_STATE } from "../src/lib/site-profile";`, `import { effectiveFeatures } from "../src/lib/features";`, `import { effectiveAppAvailability } from "../src/lib/app-availability-service";`, `import { setSetting, SETTING_KEYS } from "../src/lib/settings";`.
2. In `centralFetch`'s `switch (url.pathname)` add:

```ts
      case "/api/server-sync/site-profile":
        return (await import("../src/app/api/server-sync/site-profile/route")).GET(request);
```

3. Add, above `describe("drift check", …)`:

```ts
describe("site profile", () => {
  const syncProfile = () => withTenant(biz.businessId, () => runSiteProfileSync(biz.businessId));

  it("brings the branch's business-day start, so both sides put an after-midnight bill on the same day", async () => {
    await onCentral(() =>
      withTenant(biz.businessId, () =>
        query("UPDATE locations SET business_day_start_minutes = 1080 WHERE id = $1", [biz.locationId]),
      ),
    );
    await syncProfile();
    const desktop = await withTenant(biz.businessId, () =>
      query<{ start: number | null; day: string }>(
        `SELECT business_day_start_minutes AS start,
                app_business_date('2026-09-30T00:30:00+03:30'::timestamptz, timezone, business_day_start_minutes)::text AS day
           FROM locations WHERE id = $1`,
        [biz.locationId],
      ),
    );
    expect(desktop.rows[0]).toEqual({ start: 1080, day: "2026-09-29" });
  });

  it("follows the cloud's switches: the assistant on, then off, and an app under maintenance", async () => {
    const setAssistant = (enabled: boolean) =>
      onCentral(() =>
        withTenant(biz.businessId, () =>
          query(
            `INSERT INTO business_features (business_id, flag_key, enabled) VALUES ($1, 'ai_assistant', $2)
             ON CONFLICT (business_id, flag_key) DO UPDATE SET enabled = EXCLUDED.enabled`,
            [biz.businessId, enabled],
          ),
        ),
      );
    await setAssistant(true);
    await syncProfile();
    expect((await withTenant(biz.businessId, () => effectiveFeatures(biz.businessId))).ai_assistant).toBe(true);
    await setAssistant(false);
    await syncProfile();
    expect((await withTenant(biz.businessId, () => effectiveFeatures(biz.businessId))).ai_assistant).toBe(false);

    await onCentral(() =>
      withTenant(biz.businessId, () =>
        query(
          `INSERT INTO business_app_availability (business_id, app_key, state) VALUES ($1, 'growth', 'maintenance')
           ON CONFLICT (business_id, app_key) DO UPDATE SET state = EXCLUDED.state`,
          [biz.businessId],
        ),
      ),
    );
    await syncProfile();
    expect((await withTenant(biz.businessId, () => effectiveAppAvailability(biz.businessId))).growth.state).toBe("maintenance");
  });

  it("keeps the last copy and backs off when the cloud refuses", async () => {
    const routed = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response("", { status: 502 })) as typeof fetch;
    try {
      const failed = await syncProfile();
      expect(failed.lastError).toBe("site_profile_rejected: HTTP 502");
      expect(failed.nextAttemptAt).not.toBeNull();
      expect(failed.hash).not.toBeNull();
      const start = await withTenant(biz.businessId, () =>
        query<{ start: number | null }>("SELECT business_day_start_minutes AS start FROM locations WHERE id = $1", [biz.locationId]),
      );
      expect(start.rows[0].start).toBe(1080);
      // Inside the backoff window the cloud is not asked again.
      await syncProfile();
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = routed;
      await withTenant(biz.businessId, () => setSetting(biz.businessId, SETTING_KEYS.siteProfileState, EMPTY_SITE_PROFILE_STATE));
    }
  });
});
```

- [ ] **Step 11: Run unit and integration tests**

Run: `npx tsc --noEmit && npx vitest run src/lib/site-profile.test.ts && npm run test:db -- integration/hybrid-sync.integration.test.ts`
Expected: all PASS. If `drift check` now reports a different day, it is because the branch's business day moved to 18:00 in this suite; a drift test that compares the same fixtures on both sides must still agree, because both sides now read the same start.

- [ ] **Step 12: Commit**

```bash
git add src/lib/site-profile.ts src/lib/site-profile.test.ts src/lib/site-profile-service.ts src/app/api/server-sync/site-profile src/lib/settings.ts src/middleware.ts src/lib/server-sync.ts src/app/api/connection/status/route.ts "src/app/(app)/settings/cloud-sync-settings.tsx" integration/hybrid-sync.integration.test.ts
git commit -m "feat(hybrid): the desktop keeps branch settings and switches in step with the cloud

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Documentation and the full checklist

**Files:**
- Modify: `docs/server-sync.md`
- Modify: `docs/phases/Phase-45-Cloud-Primary-Hybrid.md`
- Modify: `docs/phases/README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: `docs/server-sync.md`**

After the opening paragraph («This is **not full-database replication**…») add:

```markdown
## Cloud-primary split (Phase 45)

The cloud is the system of record; a paired desktop is the till. On a Hybrid
desktop only the till screens render locally — selling (`/accounting/pos`,
`/accounting/orders`, `/accounting/waiter`), floor & kitchen
(`/accounting/floor`, `/accounting/kitchen`, `/accounting/reservations`,
`/accounting/delivery`), shifts, and this computer's own settings (cloud sync,
devices, desktop, printers, backup, logs). The list is `src/lib/site-routes.ts`.
Every other screen opens the cloud in the «نسخهٔ ابری» window
(`electron/cloud-window.js`: no preload, sandboxed, `persist:cloud`
partition, navigation locked to the cloud's origin). The cloud itself is
unchanged and standalone.

Each tick the desktop also reads `GET /api/server-sync/site-profile`
(bearer, the credential names the branch): the branch row (name, address,
phone, timezone, business-day start) and the effective feature switches and
app availability. It applies a changed profile in one transaction and keeps
the last copy offline (`site-profile-service.ts`, state in
`server_sync.site_profile_state`).
```

In "Supported event scope", add `shifts opened and cashed up (`shift.opened@1`, `shift.closed@1`, upserted by shift id)` to the list of active outbox/inbox events.

- [ ] **Step 2: Phase doc and index**

In `docs/phases/Phase-45-Cloud-Primary-Hybrid.md` change `**Status:** Designed — awaiting implementation plan.` to `**Status:** Implemented (no migration).` and append under "Exit criteria":

```markdown
Where each is satisfied: `src/lib/site-routes.test.ts`; `src/lib/desktop-cloud-window.test.ts`;
`src/components/cloud-handoff-state.test.tsx`; `src/components/ai/ask-assistant.test.tsx`;
`src/lib/shift-sync.test.ts`; `src/lib/site-profile.test.ts`; the `shifts` and `site profile`
blocks of `integration/hybrid-sync.integration.test.ts`.
```

In `docs/phases/README.md` add a row after row 44:

```markdown
| 45 | Phase-45-Cloud-Primary-Hybrid.md | Implemented — the cloud is the system of record and a paired desktop is the till. Only selling, floor & kitchen, shifts and the computer's own settings render on the desktop (`site-routes.ts`); every other screen opens the cloud in a sandboxed «نسخهٔ ابری» window with no preload. Shifts sync as `shift.opened@1`/`shift.closed@1`, and the desktop reads branch settings (business-day start), feature switches and app availability from `/api/server-sync/site-profile` on every tick. The cloud is unchanged and standalone. «از دستیار بپرس» now follows the `ai_assistant` switch |
```

- [ ] **Step 3: `CLAUDE.md`**

At the end of the "Hybrid sync — read before touching an order, a master table or the outbox" section add:

```markdown
- **The desktop is the till; the cloud is the system of record (Phase 45).** On a Hybrid desktop
  only the routes in `src/lib/site-routes.ts` render locally; everything else hands off to the
  «نسخهٔ ابری» window. A new screen is cloud-by-default — add it to that list only if it must
  work offline at the till, and then give its writes a sync event. Never give the cloud window
  a preload. Branch settings and switches reach the desktop through
  `/api/server-sync/site-profile`, not through a copy at pairing.
```

- [ ] **Step 4: Run the full local checklist**

Run each, in order, and read the output:

```bash
npx tsc --noEmit
npm test
npm run test:design
npm run test:db
npm run build
```

Expected: all five succeed. `npm run build` needs `JWT_SECRET` set to any value. Report exactly which steps ran and what they printed; do not call the change done on a partial run.

- [ ] **Step 5: Commit**

```bash
git add docs/server-sync.md docs/phases/Phase-45-Cloud-Primary-Hybrid.md docs/phases/README.md CLAUDE.md
git commit -m "docs: Phase 45 — cloud-primary Hybrid, the desktop is the till

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Verify on the real desktop (manual, owner)**

After building an installer from this branch (`build-desktop-installer.yml`, after `verify-shippables.yml` passes):
1. The desktop opens on the POS, and the sidebar lists only till screens plus «نسخهٔ ابری».
2. «نسخهٔ ابری» opens a second window; sign in once; «حسابداری» reports show the cloud's figures.
3. With the network cable out: a sale, a kitchen ticket and a shift close all work; the cloud window shows the offline page.
4. Cable back in: within a minute the cloud shows the sale and the shift, and the sync panel shows «تنظیمات شعبه از ابر» with a Shamsi time.
5. Switch AI off for the business in the super-admin console: within a minute «از دستیار بپرس» is gone on the cloud, and nothing AI-related appears on the desktop.
