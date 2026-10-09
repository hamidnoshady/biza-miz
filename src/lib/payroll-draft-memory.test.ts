import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DRAFT_MEMORY_TTL_MS,
  clearAllDrafts,
  forgetDrafts,
  recallDrafts,
  rememberDrafts,
} from "./payroll-draft-memory";
import type { TermDrafts } from "./payroll-amount-drafts";

afterEach(clearAllDrafts);

const DRAFTS: Record<string, TermDrafts> = {
  "staff-a": { monthlyWage: { text: "10000000", unit: "rial" }, taxableAllowance: { text: "500", unit: "toman" } },
  "staff-b": { monthlyWage: { text: "", unit: "toman" } },
};

describe("payroll draft memory", () => {
  it("hands back what a member left unsaved, units intact", () => {
    rememberDrafts("member-1", DRAFTS);
    expect(recallDrafts("member-1")).toEqual(DRAFTS);
  });

  it("is per member: somebody else never sees another member's drafts", () => {
    rememberDrafts("member-1", DRAFTS);
    expect(recallDrafts("member-2")).toEqual({});
  });

  it("returns a copy, so a caller's later edit cannot rewrite the memory", () => {
    rememberDrafts("member-1", DRAFTS);
    const recalled = recallDrafts("member-1");
    recalled["staff-a"] = { monthlyWage: { text: "1", unit: "rial" } };
    delete recalled["staff-b"];
    expect(recallDrafts("member-1")).toEqual(DRAFTS);
  });

  it("forgets after the time limit", () => {
    const start = 1_000_000;
    rememberDrafts("member-1", DRAFTS, start);
    expect(recallDrafts("member-1", start + DRAFT_MEMORY_TTL_MS)).toEqual(DRAFTS);
    expect(recallDrafts("member-1", start + DRAFT_MEMORY_TTL_MS + 1)).toEqual({});
    // …and once expired it is gone, not merely hidden.
    expect(recallDrafts("member-1", start)).toEqual({});
  });

  it("forgets on an explicit discard and when there is nothing left to protect", () => {
    rememberDrafts("member-1", DRAFTS);
    forgetDrafts("member-1");
    expect(recallDrafts("member-1")).toEqual({});

    rememberDrafts("member-1", DRAFTS);
    rememberDrafts("member-1", {});
    expect(recallDrafts("member-1")).toEqual({});
  });

  it("never touches browser storage", () => {
    // Compensation data: memory only. The module has no storage access to call
    // and spy on, so pin the contract by its code (comments stripped — they say
    // why it is not used).
    const code = readFileSync(join(__dirname, "payroll-draft-memory.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
  });
});
