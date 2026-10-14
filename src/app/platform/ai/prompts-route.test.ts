/**
 * Route-surface regression for the prompt-layers console (audit F08).
 *
 * `/platform/ai/prompts` is a real, supported page with its own API. The nav
 * links to it, so no redirect may shadow it: a redirect here would make the
 * linked page unreachable while the implementation still ships.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

describe("platform AI prompt layers route (audit F08)", () => {
  it("has a page at /platform/ai/prompts", () => {
    expect(existsSync(join(ROOT, "src", "app", "platform", "ai", "prompts", "page.tsx"))).toBe(true);
  });

  it("is linked from the AI console nav to that exact path", () => {
    const nav = readFileSync(join(ROOT, "src", "app", "platform", "ai", "ai-console-nav.tsx"), "utf8");
    expect(nav).toContain('href: "/platform/ai/prompts"');
  });

  it("is not shadowed by any redirect in next.config.ts", () => {
    const config = readFileSync(join(ROOT, "next.config.ts"), "utf8");
    const redirectsBlock = config.slice(
      config.indexOf("async redirects()"),
      config.indexOf("async rewrites()"),
    );
    expect(redirectsBlock).not.toMatch(/\/platform\/ai\/prompts/);
  });
});
