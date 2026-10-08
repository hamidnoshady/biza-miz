/**
 * The business workspace's navigation targets, pinned at the source level.
 *
 * Issue #755 §10: the console used to assume `/platform` *was* the business
 * list. It is not — `/platform` is the console home, the list lives at
 * `/platform/businesses` — so "back to the list" and the post-delete redirect
 * both landed on a dashboard and read as "nothing happened".
 *
 * These are client components nested under a data-provider layout, so there is
 * no cheap render harness for them; the failure mode is a literal string in a
 * link or a redirect anyway, which is exactly what this reads. It is written
 * as a scan rather than three one-off assertions so a *new* file in the
 * workspace tree cannot reintroduce the old target.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const WORKSPACE_ROOT = join(process.cwd(), "src", "app", "platform", "businesses");
const CONSOLE_ROOT = join(process.cwd(), "src", "app", "platform");

function collect(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collect(full));
    else if (/\.(tsx?|mts)$/.test(entry)) out.push(full);
  }
  return out;
}

const workspaceFiles = collect(WORKSPACE_ROOT);

function source(file: string): string {
  return readFileSync(file, "utf8");
}

describe("the business workspace points at the business list, not the console home", () => {
  it("found the workspace files (the scan is not vacuously green)", () => {
    expect(workspaceFiles.length).toBeGreaterThan(8);
  });

  it("never links to bare /platform", () => {
    // `href=\"/platform\"` is the old business-list assumption. Other console
    // surfaces are allowed to link their own sections; this tree is the
    // workspace for ONE business, so every link out of it is either the list
    // or a console section with an explicit path.
    for (const file of workspaceFiles) {
      const src = source(file);
      const bare = src.match(/href="\/platform"/g) ?? [];
      expect(
        bare.length,
        `${relative(process.cwd(), file).split(sep).join("/")} still links bare /platform`,
      ).toBe(0);
      const bareRedirect = src.match(/location\.href = "\/platform"/g) ?? [];
      expect(bareRedirect.length).toBe(0);
    }
  });

  it("keeps the workspace's back link on the business list", () => {
    const layout = source(join(WORKSPACE_ROOT, "[id]", "layout.tsx"));
    expect(layout).toContain('href="/platform/businesses"');
  });

  it("redirects to the business list after a hard delete", () => {
    // Issue #822 moved the navigation from `window.location.href` to the
    // router so the danger-zone tests can observe it; what stays pinned is
    // the destination — the business list, never the console home.
    const panels = source(join(WORKSPACE_ROOT, "[id]", "panels.tsx"));
    const removePanel = panels.slice(panels.indexOf("export function RemovePanel"));
    expect(removePanel).toContain('router.push("/platform/businesses")');
    expect(removePanel).not.toContain('href = "/platform"');
  });

  it("does not link to the retired plan address", () => {
    // `/platform/businesses/:id/plan` is a permanent redirect into the billing
    // page's subscription tab; linking it would make it a second route again.
    for (const file of collect(CONSOLE_ROOT)) {
      const src = source(file);
      const links = src.match(/href=\{?[`"'][^`"']*\/plan[`"']/g) ?? [];
      expect(
        links.length,
        `${relative(process.cwd(), file).split(sep).join("/")} links the retired /plan address`,
      ).toBe(0);
    }
  });

  it("keeps /plan a redirect-only page, with no app page of its own", () => {
    const page = source(join(WORKSPACE_ROOT, "[id]", "plan", "page.tsx"));
    expect(page).toContain("redirect(");
    // No UI, no data: the retired address must not render a workspace again.
    expect(page).not.toContain("useBusiness");
    expect(page).not.toContain('"use client"');
  });
});

/**
 * The overview's information architecture (issue #755 §19).
 *
 * The landing page of one business has to answer "who runs this, is it healthy,
 * and is anything wrong?" without the operator opening a section — and it has
 * to do that without reintroducing the duplicate heavy read §11 removed.
 *
 * Written as a scan because the failure mode is structural: somebody adding a
 * fourth card that quietly calls the detail endpoint again would pass every
 * behavioural test while making the workspace slower for everybody.
 */
describe("the workspace overview (§19)", () => {
  const overview = source(join(WORKSPACE_ROOT, "[id]", "page.tsx"));

  it("shows the owner and how to reach them", () => {
    expect(overview).toContain("/owner");
    // Email and phone are the acceptance criterion — the owner's contact details
    // must be on the page, not only behind a link to the profile section.
    expect(overview).toMatch(/p\.email/);
    expect(overview).toMatch(/mfa\.phoneE164/);
    expect(overview).toContain("/profile");
  });

  it("shows operating health from the existing usage snapshot", () => {
    expect(overview).toContain("/usage");
    expect(overview).toMatch(/وضعیت بهره‌برداری/);
  });

  it("surfaces warnings rather than making the operator hunt for them", () => {
    expect(overview).toMatch(/function buildWarnings/);
    expect(overview).toMatch(/نیازمند توجه/);
  });

  it("does not fetch the heavy business detail again", () => {
    // The provider already reads it once for the whole workspace; an overview
    // that read it too would be the duplicate §11 exists to prevent.
    expect(overview).not.toMatch(/api<[^>]*>\(`\/api\/platform\/businesses\/\$\{id\}`\)/);
    expect(overview).not.toContain("/api/platform/businesses/${business.id}`");
  });

  it("keeps AI readiness in the Features section instead of re-probing on the landing page", () => {
    expect(overview).not.toContain("/api/platform/ai/gateway");
    expect(overview).toContain("/features");
  });
});
