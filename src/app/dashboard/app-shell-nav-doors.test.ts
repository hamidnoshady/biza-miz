/**
 * Every app that owns a shell must be entered through its own app-home route.
 *
 * The dashboard's flat nav (built in `workspace-shell.tsx`) carries one door per app.
 * For an app with a shell (`src/lib/app-shells.ts` — Growth, the Website
 * manager, the CRM), that door's href must live *inside* the shell's own
 * prefix, e.g. `/crm/overview` and not the legacy `/dashboard/customers`.
 *
 * Two independent behaviours ride on that single fact, which is why a door
 * pointing at a legacy route broke both at once for the CRM:
 *
 *   1. The workspace rail launches each app by finding its app-home href among
 *      the nav's hrefs (`WORKSPACE_APP_LAUNCHERS` in `dashboard-sidebar.tsx`).
 *      A door at `/dashboard/customers` is never `/crm/overview`, so the CRM
 *      launcher matched nothing and «ارتباط با مشتری» vanished from the rail's
 *      «برنامه‌ها» list while Growth and the Website app stayed.
 *   2. In the workspace shell the flat nav drops every entry whose href is
 *      inside an app shell (`isInsideAnyAppShell`), because that app is reached
 *      from the rail instead. A door outside the shell prefix is *not* dropped,
 *      so it kept surfacing while the member was inside another app such as
 *      حسابداری — the CRM leaking into Accounting.
 *
 * This test greps the shell's source (the same source-of-truth approach
 * `design-lint.test.ts` uses) so the invariant holds without importing the
 * server component, which pulls in the database pool.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { APP_SHELLS, isInsideAnyAppShell } from "@/lib/app-shells";

// The nav registry is shared by the shell and the authorized AI route resolver.
const LAYOUT_SOURCE = readFileSync(
  fileURLToPath(new URL("../../lib/tenant-navigation.ts", import.meta.url)),
  "utf8",
);

/** Every `href: "…"` literal that appears in the nav builder. */
function navHrefs(): string[] {
  return [...LAYOUT_SOURCE.matchAll(/href:\s*"([^"]+)"/g)].map((match) => match[1]);
}

describe("app-shell doors in the flat nav", () => {
  it("gives every shell app a flat-nav door inside its own shell prefix", () => {
    const hrefs = navHrefs();
    for (const shell of APP_SHELLS) {
      // At least one nav door points inside this app's shell — the app-home
      // route the rail launcher looks for and the flat-nav filter drops.
      const door = hrefs.find((href) => isInsideAnyAppShell(href) && href.startsWith(shell.prefix));
      expect(
        door,
        `no flat-nav door points inside the "${shell.app}" shell (prefix ${shell.prefix}); ` +
          `the workspace rail cannot launch it and it will leak into other apps`,
      ).toBeDefined();
    }
  });

  it("keeps the CRM's door on its app home, not the legacy customers route", () => {
    const hrefs = navHrefs();
    // The exact regression: the CRM door must be /crm/overview.
    expect(hrefs).toContain("/crm/overview");
    // /dashboard/customers stays a redirect *page* (src/app/dashboard/customers),
    // but it must not be a nav door any more — that is what hid the CRM.
    expect(hrefs).not.toContain("/dashboard/customers");
  });
});
