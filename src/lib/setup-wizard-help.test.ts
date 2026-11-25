import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WIZARD_STEPS } from "./wizard-steps";
import { SETUP_STEP_HELP, setupStepHelp, setupStepPageKey } from "./setup-wizard-help";
import { extractGuideStepLines } from "./kb-step-excerpt";
import { KNOWLEDGE_PAGES } from "./knowledge-base";
import { SEED_ARTICLES } from "../../scripts/knowledge-seed/content";

/**
 * Issue #1239 / ESH-90 — every wizard step carries inline help.
 *
 * These pin the two layers the step depends on: the catalogue keys the API
 * resolves, and the fallback lines that must exist even when the published
 * article is missing or the install is offline.
 */
const article = readFileSync(
  join(process.cwd(), "scripts/knowledge-seed/articles/setup-wizard.md"),
  "utf8",
);

describe("setup step inline help", () => {
  it("defines help for every step, with 2–5 short fallback lines", () => {
    for (const step of WIZARD_STEPS) {
      const help = setupStepHelp(step);
      expect(help, step).toBeTruthy();
      expect(help.lines.length, step).toBeGreaterThanOrEqual(2);
      expect(help.lines.length, step).toBeLessThanOrEqual(5);
      for (const line of help.lines) {
        expect(line.trim().length, step).toBeGreaterThan(10);
      }
    }
  });

  it("points every step at a real knowledge page", () => {
    const routes = new Set(KNOWLEDGE_PAGES.map((page) => page.route));
    for (const step of WIZARD_STEPS) {
      const help = SETUP_STEP_HELP[step];
      // `aec_profile` and `app_setup` use the URL spelling, not the step id.
      expect(help.pageKey.startsWith("page:/setup/"), step).toBe(true);
      expect(routes.has(help.pageKey.slice("page:".length)), step).toBe(true);
      expect(setupStepPageKey(step), step).toBe(help.pageKey);
    }
    expect(setupStepPageKey("not-a-step")).toBeNull();
  });

  it("uses a marker the published article actually prints", () => {
    // The API extracts the paragraph after this marker; a renamed heading in
    // the article without a matching marker would silently drop every inline
    // excerpt back to the fallback.
    for (const step of WIZARD_STEPS) {
      const help = SETUP_STEP_HELP[step];
      expect(article, step).toContain(`**${help.marker}**`);
      expect(extractGuideStepLines(article, help.marker).length, step).toBeGreaterThan(0);
    }
  });

  it("attaches the published article to the wizard section and its step pages", () => {
    const entry = SEED_ARTICLES.find((seed) => seed.slug === "setup-wizard");
    expect(entry?.sectionKeys).toContain("setup");
    for (const step of WIZARD_STEPS) {
      expect(entry?.sectionKeys, step).toContain(SETUP_STEP_HELP[step].pageKey);
    }
    // `/setup/finish` is not a WizardStep but is a catalogue page.
    expect(entry?.sectionKeys).toContain("page:/setup/finish");
  });
});
