/**
 * Issue #808 — the wizard's navigation, pinned.
 *
 * The audit asked for tests covering "back-nav, direct/stale URLs" and an
 * intentional path for every enabled industry, and this is the module that
 * decides all of it: `stepsFor` filters the full sequence down to the steps one
 * business walks, and `nextPath`/`prevPath`/`skipToPath` turn that into the
 * three ways a page can be left —
 *
 *   - forward by saving (`nextPath`),
 *   - backward by the back button (`prevPath`),
 *   - sideways off a step this industry does not have (`skipToPath`), which is
 *     what a bookmarked URL or a restored tab hits.
 *
 * `skipToPath` is the interesting one: it must never return the step it was
 * given (that would be a redirect loop), never a step the industry lacks, and
 * always something the owner can actually use — `/setup/finish` if the step was
 * the last one in the full sequence.
 */
import { describe, expect, it } from "vitest";
import { ENABLED_INDUSTRIES, type Industry } from "@/lib/industries";
import {
  OPTIONAL_STEPS,
  WIZARD_STEPS,
  wizardStepsForIndustry,
} from "@/lib/wizard-steps";
import { STEPS, nextPath, prevPath, skipToPath, stepsFor } from "./steps";

describe("the step metadata table", () => {
  it("describes every step, once, with a unique /setup path", () => {
    // A step in WIZARD_STEPS with no row here would render `undefined` as the
    // page title; a duplicate path would make two steps the same URL.
    expect(STEPS.map((s) => s.id)).toEqual([...WIZARD_STEPS]);
    const paths = STEPS.map((s) => s.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const step of STEPS) {
      expect(step.path).toMatch(/^\/setup\//);
      expect(step.title.length).toBeGreaterThan(0);
      expect(step.short.length).toBeGreaterThan(0);
    }
    // Optionality is declared in exactly one place (wizard-steps.ts) — the
    // metadata row must not carry a second, drifting answer.
    expect(STEPS.filter((s) => s.optional).map((s) => s.id)).toEqual([...OPTIONAL_STEPS]);
  });
});

describe("stepsFor — the sequence one business walks", () => {
  it("matches the industry's step ids, in the canonical order", () => {
    for (const industry of ENABLED_INDUSTRIES) {
      expect(stepsFor(industry).map((s) => s.id), industry).toEqual([
        ...wizardStepsForIndustry(industry),
      ]);
    }
  });

  it("keeps the skippable-but-present steps in every industry's list", () => {
    for (const industry of ENABLED_INDUSTRIES) {
      const ids = stepsFor(industry).map((s) => s.id);
      expect(ids).toContain("business");
      expect(ids).toContain("hardware");
      expect(ids).toContain("backup");
      expect(ids).toContain("opening");
    }
  });
});

describe("nextPath — forward by saving", () => {
  it("walks a food-service business through all nine steps and out to Finish", () => {
    const steps = stepsFor("food_service");
    for (let i = 0; i < steps.length - 1; i++) {
      expect(nextPath(steps[i].id, steps)).toBe(steps[i + 1].path);
    }
    expect(nextPath("opening", steps)).toBe("/setup/finish");
  });

  it("sends a trade-goods business straight from tax to users, never through costing", () => {
    const steps = stepsFor("jewelry");
    expect(nextPath("tax", steps)).toBe("/setup/users");
    expect(nextPath("opening", steps)).toBe("/setup/finish");
  });

  it("falls back to Finish for an id the sequence does not contain", () => {
    expect(nextPath("costing", stepsFor("jewelry"))).toBe("/setup/finish");
  });
});

describe("prevPath — back navigation", () => {
  it("stops at the first step and otherwise returns the industry's own previous step", () => {
    const fnb = stepsFor("food_service");
    expect(prevPath("business", fnb)).toBeNull();
    expect(prevPath("costing", fnb)).toBe("/setup/accounts");

    const retail = stepsFor("wholesale");
    expect(prevPath("users", retail)).toBe("/setup/tax");
    expect(prevPath("business", retail)).toBeNull();
  });
});

describe("skipToPath — direct links and stale tabs", () => {
  it("lands on the next step the industry actually has", () => {
    const retail = stepsFor("jewelry");
    expect(skipToPath("costing", retail)).toBe("/setup/tax");
    expect(skipToPath("menu", retail)).toBe("/setup/hardware");
  });

  it("never returns the step it was given, for any step and any enabled industry", () => {
    // A returning skips path would be a redirect loop; this is the property
    // that makes the guard safe to wire into a `useEffect` redirect.
    for (const industry of ENABLED_INDUSTRIES) {
      const steps = stepsFor(industry);
      for (const step of STEPS) {
        const target = skipToPath(step.id, steps);
        expect(target, `${industry} ${step.id}`).not.toBe(step.path);
      }
    }
  });

  it("only ever points at a step in the industry's own sequence, or Finish", () => {
    for (const industry of ENABLED_INDUSTRIES) {
      const steps = stepsFor(industry);
      const valid = new Set(steps.map((s) => s.path));
      for (const step of STEPS) {
        const target = skipToPath(step.id, steps);
        expect(valid.has(target) || target === "/setup/finish", `${industry} ${step.id} → ${target}`).toBe(
          true,
        );
      }
    }
  });

  it("ends the sequence at Finish when the skipped step is the last one", () => {
    expect(skipToPath("opening", stepsFor("food_service"))).toBe("/setup/finish");
    expect(skipToPath("menu", stepsFor("service_saas"))).toBe("/setup/hardware");
  });

  it("gives every industry somewhere to land from every step", () => {
    for (const industry of ENABLED_INDUSTRIES) {
      const steps = stepsFor(industry);
      // From any step, forward or skip, the owner can always reach Finish
      // without ever being sent to a step their business does not walk.
      for (const step of STEPS.map((s) => s.id)) {
        const target = steps.some((s) => s.id === step)
          ? nextPath(step, steps)
          : skipToPath(step, steps);
        expect(target).toMatch(/^\/setup\//);
        // Either the terminal Finish page, or a step in this business's list —
        // which is what "never send the owner to a step they do not walk" means
        // once the path is resolved back to an id.
        const resolved = steps.find((s) => s.path === target);
        expect(target === "/setup/finish" || resolved !== undefined, `${industry} ${step}`).toBe(true);
      }
    }
  });

  it("degrades safely for an unknown industry and an empty step list", () => {
    // Not a shape any enabled industry produces, but a row written by a newer
    // build (or hand-edited) must not crash a page: an unknown industry falls
    // back to the F&B sequence rather than to "no steps", and an empty list
    // still terminates at Finish, which validates readiness. The F&B sequence
    // is the fallback *shape*, so it excludes AEC's own `aec_profile` step
    // (issue #799) the same way `food_service` does.
    const steps = stepsFor("unknown_trade" as Industry);
    expect(steps.map((s) => s.id)).toEqual(
      WIZARD_STEPS.filter((step) => step !== "aec_profile"),
    );
    expect(skipToPath("business", [])).toBe("/setup/finish");
  });
});
