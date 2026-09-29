import { describe, expect, it } from "vitest";
import {
  LIFECYCLE_TRANSITIONS,
  allowedLifecycleTransitions,
  businessLifecycleTransition,
  lifecycleTransitionsFrom,
  type BusinessLifecycleStatus,
} from "./platform-business-lifecycle";
import { CAPABILITIES_FOR, PLATFORM_ADMIN_ROLES } from "./platform-admin";

const STATUSES: BusinessLifecycleStatus[] = ["active", "suspended", "archived"];

/** The audited expectation, written out instead of derived from the table. */
const EXPECTED: Record<string, { capability: string; auditAction: string } | "invalid"> = {
  "active->active": "invalid",
  "active->suspended": { capability: "business.suspend", auditAction: "business.suspended" },
  "active->archived": { capability: "business.archive", auditAction: "business.archived" },
  "suspended->active": { capability: "business.suspend", auditAction: "business.active" },
  "suspended->suspended": "invalid",
  "suspended->archived": { capability: "business.archive", auditAction: "business.archived" },
  "archived->active": { capability: "business.archive", auditAction: "business.active" },
  "archived->suspended": "invalid",
  "archived->archived": "invalid",
};

describe("businessLifecycleTransition", () => {
  it("covers every status pair exactly once", () => {
    const seen = new Set<string>();
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        const key = `${from}->${to}`;
        seen.add(key);
        const decision = businessLifecycleTransition(from, to);
        const expected = EXPECTED[key];
        if (expected === "invalid") {
          expect(decision.ok).toBe(false);
          expect(decision.ok ? "" : decision.error).toBe(
            from === to ? "same_status" : "invalid_transition",
          );
        } else {
          expect(decision.ok, key).toBe(true);
          if (decision.ok) {
            expect(decision.transition.capability).toBe(expected.capability);
            expect(decision.transition.auditAction).toBe(expected.auditAction);
          }
        }
      }
    }
    expect(seen.size).toBe(9);
  });

  it("does not offer a second way to leave a status", () => {
    for (const t of LIFECYCLE_TRANSITIONS) {
      const same = LIFECYCLE_TRANSITIONS.filter((o) => o.from === t.from && o.to === t.to);
      expect(same).toHaveLength(1);
    }
  });

  it("never authorizes a transition with an empty or unknown capability", () => {
    for (const t of LIFECYCLE_TRANSITIONS) {
      expect(t.capability).toBeTruthy();
      expect(t.label).toBeTruthy();
      expect(t.auditAction).toMatch(/^business\./);
    }
    expect(lifecycleTransitionsFrom("active")).toHaveLength(2);
    expect(lifecycleTransitionsFrom("suspended")).toHaveLength(2);
    expect(lifecycleTransitionsFrom("archived")).toHaveLength(1);
  });
});

/**
 * The authorization gap the issue calls out: an engineer can suspend and
 * reactivate but cannot archive, so they must not be able to *un*-archive
 * either. This is asserted per role, not per capability name.
 */
describe("lifecycle authorization per platform role", () => {
  function allowed(role: (typeof PLATFORM_ADMIN_ROLES)[number], from: BusinessLifecycleStatus) {
    return allowedLifecycleTransitions(from, CAPABILITIES_FOR(role)).map((t) => t.to);
  }

  it("support may make no lifecycle change at all", () => {
    for (const from of STATUSES) expect(allowed("support", from)).toEqual([]);
  });

  it("engineer may suspend and reactivate, but never touch the archive", () => {
    expect(allowed("engineer", "active").sort()).toEqual(["suspended"]);
    expect(allowed("engineer", "suspended").sort()).toEqual(["active"]);
    expect(allowed("engineer", "archived")).toEqual([]);
  });

  it("an engineer cannot reactivate an archived business", () => {
    const decision = businessLifecycleTransition("archived", "active");
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(CAPABILITIES_FOR("engineer")).not.toContain(decision.transition.capability);
    expect(CAPABILITIES_FOR("owner")).toContain(decision.transition.capability);
  });

  it("owner may archive, restore, suspend and reactivate", () => {
    expect(allowed("owner", "active").sort()).toEqual(["archived", "suspended"]);
    expect(allowed("owner", "suspended").sort()).toEqual(["active", "archived"]);
    expect(allowed("owner", "archived").sort()).toEqual(["active"]);
  });

  it("every capability the policy names is held by at least one role", () => {
    for (const t of LIFECYCLE_TRANSITIONS) {
      expect(PLATFORM_ADMIN_ROLES.some((r) => CAPABILITIES_FOR(r).includes(t.capability))).toBe(true);
    }
  });
});
