import { describe, expect, it } from "vitest";
import {
  canonicalRecipeJson,
  isBoundedRecipeAction,
  recipeHashFor,
} from "./repair-catalog";

describe("repair catalog integrity (issue #984)", () => {
  it("canonicalises recipes so key order never changes the hash", () => {
    const a = { action: "main.restart_backend", params: { timeoutSec: 30, force: false } };
    const b = { params: { force: false, timeoutSec: 30 }, action: "main.restart_backend" };
    expect(canonicalRecipeJson(a)).toBe(canonicalRecipeJson(b));
    expect(recipeHashFor(a)).toBe(recipeHashFor(b));
    expect(recipeHashFor(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("accepts only bounded action verbs", () => {
    expect(isBoundedRecipeAction({ action: "main.restart_backend", params: {} })).toBe(true);
    expect(isBoundedRecipeAction({ action: "companion.clean_temp" })).toBe(true);
    expect(isBoundedRecipeAction({ action: "rm -rf /" })).toBe(false);
    expect(isBoundedRecipeAction({})).toBe(false);
  });

  it("refuses escape hatches anywhere in the recipe", () => {
    for (const key of ["command", "sql", "query", "script", "url", "powershell", "shell", "code"]) {
      expect(isBoundedRecipeAction({ action: "main.restart_backend", [key]: "x" })).toBe(false);
      expect(
        isBoundedRecipeAction({ action: "main.restart_backend", nested: { deep: [{ [key]: "x" }] } }),
      ).toBe(false);
    }
  });
});
