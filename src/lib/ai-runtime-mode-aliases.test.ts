/**
 * Issue #812 §3/§7 — the runtime modes resolve different configurable aliases.
 *
 * The issue's exit criterion is narrow and easy to fake: "Auto/Instant resolve
 * different configurable LiteLLM aliases **when configured**". A mode picker
 * that renders three options but routes every one of them to the same model
 * passes a UI test and fails the criterion.
 *
 * So this pins the resolution itself, and the three states that matter:
 *
 *  1. A configured alias WINS. `auto` on `pos-auto` and `instant` on
 *     `pos-instant` must produce two different models, or the picker is
 *     decoration.
 *  2. A blank alias is a SUPPORTED state, not an error. It means "the gateway's
 *     default chat model", which is what a deployment that has not set aliases
 *     up yet keeps doing — so turning the console on has to be additive.
 *  3. The mode beats a branch-level model override. A branch override is a
 *     per-branch *model* choice; the mode is a per-turn *routing* choice made by
 *     the member in front of the screen. If the override silently won, the mode
 *     picker would lie about where the turn went.
 */
import { describe, expect, it } from "vitest";
import { applyRuntimeModeAlias } from "./ai-runtime";

const BASE = { model: "gpt-4o-mini", embeddingModel: "text-embedding-3-small" };

describe("issue #812 §3/§7 — a mode's alias decides the model", () => {
  it("routes each mode to its own configured alias", () => {
    const auto = applyRuntimeModeAlias(BASE, { model_alias: "pos-auto" });
    const instant = applyRuntimeModeAlias(BASE, { model_alias: "pos-instant" });
    const research = applyRuntimeModeAlias(BASE, { model_alias: "pos-deep-research" });

    expect(auto.model).toBe("pos-auto");
    expect(instant.model).toBe("pos-instant");
    expect(research.model).toBe("pos-deep-research");
    // The whole point: three distinct models, not one model with three labels.
    expect(new Set([auto.model, instant.model, research.model]).size).toBe(3);
  });

  it("leaves the gateway default in place when no alias is configured", () => {
    // A deployment that has not set aliases up yet must keep working exactly as
    // it does today. `applyRuntimeModeAlias` is therefore additive: blank means
    // "unchanged", never "error" and never "fall back to some hardcoded model".
    for (const mode of [null, undefined, { model_alias: "" }, { model_alias: "   " }, { model_alias: null }]) {
      expect(applyRuntimeModeAlias(BASE, mode)).toEqual(BASE);
    }
  });

  it("trims a padded alias rather than sending whitespace to the gateway", () => {
    expect(applyRuntimeModeAlias(BASE, { model_alias: "  pos-instant\n" }).model).toBe("pos-instant");
  });

  it("overrides a branch-level model, so the mode picker cannot lie", () => {
    // `decorate()` has already applied the branch override by the time this
    // runs; the mode is the member's per-turn choice and wins over it.
    const branchOverridden = { ...BASE, model: "branch-specific-model" };
    expect(applyRuntimeModeAlias(branchOverridden, { model_alias: "pos-instant" }).model).toBe("pos-instant");
  });

  it("leaves the rest of the config untouched", () => {
    const config = { ...BASE, maxOutputTokens: 4096, enabled: true };
    const out = applyRuntimeModeAlias(config, { model_alias: "pos-auto" });
    expect(out.maxOutputTokens).toBe(4096);
    expect(out.enabled).toBe(true);
    expect(out.embeddingModel).toBe("text-embedding-3-small");
    // And it does not mutate the caller's object — the same resolved config is
    // reused for the settlement's pricing, so an in-place edit would price the
    // turn against a model it never called.
    expect(config.model).toBe("gpt-4o-mini");
  });
});
