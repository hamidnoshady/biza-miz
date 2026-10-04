/**
 * Issue #808 §8 — the wizard assistant must follow the business's own step
 * list, not F&B's.
 *
 * The setup assistant (`mode: "wizard"`) is offered on every `/setup/*` page
 * and can propose `setup.*` actions. Before this scoping it saw the whole
 * catalogue whatever the industry, so a jewelry owner could be walked into
 * creating menu items and picking an inventory-costing method — steps their own
 * wizard never shows, whose tables (`menu_items`, `inventory.costing`) their
 * business does not use. The rule is one line: a setup action survives only if
 * its `wizardStep` is in `wizardStepsForIndustry(industry)`.
 *
 * The pair of assertions that matter most: the *prompt* and the *tool enum* say
 * the same thing (a model that is told one thing and allowed another will
 * mislead the owner), and both are unchanged when no industry is supplied.
 */
import { describe, expect, it } from "vitest";
import {
  ACTION_CATALOG,
  BASE_ACTION_TYPES,
  buildSystemPrompt,
  toolDefinitions,
  wizardActionTypesForIndustry,
  type ActionType,
} from "./ai";
import { ENABLED_INDUSTRIES } from "./industries";
import { wizardStepsForIndustry } from "./wizard-steps";

/** Every setup.* action in the catalogue, with the wizard step it belongs to. */
const SETUP_ACTIONS = (Object.keys(ACTION_CATALOG) as ActionType[]).filter(
  (type) => ACTION_CATALOG[type].wizardStep,
);

function proposeEnum(tools: ReturnType<typeof toolDefinitions>): string[] {
  const tool = tools.find((t) => t.function.name === "propose_action");
  const parameters = tool?.function.parameters as
    | { properties: { type: { enum: string[] } } }
    | undefined;
  return parameters?.properties.type.enum ?? [];
}

/** The step ids whose setup actions survive for one industry. */
function survivingSteps(industry: Parameters<typeof wizardStepsForIndustry>[0]): Set<string> {
  return new Set(
    wizardActionTypesForIndustry(BASE_ACTION_TYPES, industry)
      .filter((type) => ACTION_CATALOG[type]?.wizardStep)
      .map((type) => ACTION_CATALOG[type].wizardStep as string),
  );
}

describe("wizardActionTypesForIndustry", () => {
  it("drops F&B-only setup actions for trade-goods businesses", () => {
    const types = wizardActionTypesForIndustry(BASE_ACTION_TYPES, "jewelry");
    expect(types).toContain("setup.business");
    expect(types).toContain("setup.accounts");
    expect(types).toContain("setup.tax");
    expect(types).not.toContain("setup.costing");
    expect(types).not.toContain("setup.menu.category");
    expect(types).not.toContain("setup.menu.item");
    // Non-setup actions (reports, menu edits in the normal app) are untouched.
    expect(types).toContain("menu.item.priceUpdate");
  });

  it("keeps every setup action for food service", () => {
    const types = wizardActionTypesForIndustry(BASE_ACTION_TYPES, "food_service");
    for (const type of SETUP_ACTIONS) expect(types).toContain(type);
  });

  it("is a no-op without an industry", () => {
    expect(wizardActionTypesForIndustry(BASE_ACTION_TYPES, null)).toEqual(BASE_ACTION_TYPES);
    expect(wizardActionTypesForIndustry(BASE_ACTION_TYPES, undefined)).toEqual(BASE_ACTION_TYPES);
  });

  it("never offers a step the industry's wizard does not walk (all enabled industries)", () => {
    for (const industry of ENABLED_INDUSTRIES) {
      const walked = new Set(wizardStepsForIndustry(industry));
      for (const step of survivingSteps(industry)) {
        expect(walked.has(step as never), `${industry} → ${step}`).toBe(true);
      }
      // The three steps every shape keeps are always proposable.
      expect(survivingSteps(industry).has("business")).toBe(true);
      expect(survivingSteps(industry).has("accounts")).toBe(true);
      expect(survivingSteps(industry).has("tax")).toBe(true);
    }
  });
});

describe("propose_action enum (wizard mode)", () => {
  it("follows the industry, so a hand-crafted response cannot name an absent step", () => {
    const tradeGoods = proposeEnum(toolDefinitions("wizard", { industry: "accessories" }));
    expect(tradeGoods).toContain("setup.accounts");
    expect(tradeGoods).not.toContain("setup.menu.item");
    expect(tradeGoods).not.toContain("setup.costing");

    const foodService = proposeEnum(toolDefinitions("wizard", { industry: "food_service" }));
    expect(foodService).toContain("setup.menu.item");
    expect(foodService).toContain("setup.costing");
  });

  it("stays unscoped when the caller supplies no industry, and outside wizard mode", () => {
    expect(proposeEnum(toolDefinitions("wizard"))).toContain("setup.menu.item");
    expect(proposeEnum(toolDefinitions("dashboard", { industry: "jewelry" }))).toContain(
      "setup.menu.item",
    );
  });
});

describe("wizard system prompt", () => {
  it("states the business's own step list and points trades at their catalogue door", () => {
    const prompt = buildSystemPrompt({ mode: "wizard", industry: "jewelry" });
    expect(prompt).toMatch(/مراحل راه‌اندازی[^\n]*اطلاعات کسب‌وکار/);
    expect(prompt).toContain("پنل محصولات");
    // The propose catalogue it is shown excludes the absent steps too.
    expect(prompt).not.toContain("setup.menu.item");
    expect(prompt).not.toContain("setup.costing");
  });

  it("lists all nine F&B steps — including the Backup destination", () => {
    const prompt = buildSystemPrompt({ mode: "wizard", industry: "food_service" });
    expect(prompt).toMatch(/مراحل راه‌اندازی[^\n]*ورود منو[^\n]*مقصد پشتیبان‌گیری/);
    expect(prompt).toContain("setup.menu.item");
    expect(prompt).toContain("setup.costing");
  });

  it("keeps today's prompt when no industry is known", () => {
    const prompt = buildSystemPrompt({ mode: "wizard" });
    expect(prompt).not.toContain("مراحل راه‌اندازی");
    expect(prompt).toContain("setup.menu.item");
  });
});
