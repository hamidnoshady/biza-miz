/**
 * Seed-safety decisions (issue #938): a rerun must preserve editorial changes
 * and unpublished state unless the operator explicitly passes --overwrite.
 */
import { describe, expect, it } from "vitest";
import {
  planSeedArticle,
  planSeedCategory,
  planSeedTag,
  seedDecisionLabel,
  SEED_ACTOR,
} from "./knowledge-seed-plan";

const seedRow = {
  createdBy: SEED_ACTOR,
  updatedBy: SEED_ACTOR,
  status: "published",
};

describe("planSeedArticle", () => {
  it("inserts a missing article", () => {
    expect(planSeedArticle(null)).toEqual({ action: "insert", reason: "missing" });
  });

  it("updates an untouched seed article", () => {
    expect(planSeedArticle(seedRow)).toEqual({ action: "update", reason: "seed-owned" });
  });

  it("never republishes an article an operator unpublished", () => {
    expect(planSeedArticle({ ...seedRow, status: "draft" })).toEqual({
      action: "skip",
      reason: "unpublished",
    });
  });

  it("preserves an article edited in the console", () => {
    expect(planSeedArticle({ ...seedRow, updatedBy: "admin-1" })).toEqual({
      action: "skip",
      reason: "edited-by-hand",
    });
  });

  it("never overwrites a hand-written article with the same seed slug", () => {
    expect(planSeedArticle({ ...seedRow, createdBy: "admin-1" })).toEqual({
      action: "skip",
      reason: "not-seed-owned",
    });
  });

  it("restores everything when --overwrite is explicit", () => {
    expect(
      planSeedArticle(
        { ...seedRow, status: "draft", updatedBy: "admin-1" },
        { overwrite: true },
      ),
    ).toEqual({ action: "update", reason: "overwrite" });
  });

  it("honours a custom actor", () => {
    expect(
      planSeedArticle(
        { ...seedRow, createdBy: "importer", updatedBy: "importer" },
        { actor: "importer" },
      ),
    ).toEqual({ action: "update", reason: "seed-owned" });
  });
});

describe("planSeedCategory", () => {
  it("does not reactivate a deliberately disabled category", () => {
    expect(planSeedCategory({ createdBy: SEED_ACTOR, isActive: false })).toEqual({
      action: "skip",
      reason: "inactive",
    });
  });

  it("updates an untouched category and creates a missing one", () => {
    expect(planSeedCategory({ createdBy: SEED_ACTOR, isActive: true }).action).toBe("update");
    expect(planSeedCategory(null).action).toBe("insert");
  });

  it("leaves a hand-made category alone", () => {
    expect(planSeedCategory({ createdBy: "admin", isActive: true }).reason).toBe(
      "not-seed-owned",
    );
  });

  it("does not revert a category edited in the console", () => {
    expect(
      planSeedCategory({ createdBy: SEED_ACTOR, isActive: true, edited: true }),
    ).toEqual({ action: "skip", reason: "edited-by-hand" });
    expect(
      planSeedCategory(
        { createdBy: SEED_ACTOR, isActive: true, edited: true },
        { overwrite: true },
      ).action,
    ).toBe("update");
  });
});

describe("planSeedTag", () => {
  it("updates seed tags and skips hand-made or edited ones", () => {
    expect(planSeedTag({ createdBy: SEED_ACTOR }).action).toBe("update");
    expect(planSeedTag({ createdBy: "admin" }).action).toBe("skip");
    expect(planSeedTag({ createdBy: SEED_ACTOR, edited: true }).reason).toBe(
      "edited-by-hand",
    );
    expect(planSeedTag(null).action).toBe("insert");
  });
});

describe("seedDecisionLabel", () => {
  it("explains every reason in Persian", () => {
    const reasons = [
      "missing",
      "seed-owned",
      "overwrite",
      "not-seed-owned",
      "edited-by-hand",
      "unpublished",
      "inactive",
    ] as const;
    for (const reason of reasons) {
      expect(seedDecisionLabel({ action: "skip", reason }).length).toBeGreaterThan(0);
    }
  });
});
