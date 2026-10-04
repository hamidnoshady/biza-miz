/**
 * Issue #799 §25 — the field catalogue without a database.
 *
 * The board itself is asserted against real registers in
 * `integration/aec-field.integration.test.ts`; what can be proven here is that
 * §25's own list is covered, that the safety rules the issue states are encoded
 * rather than remembered (drafts only where safe, decisions never drafted), and
 * that the queue caps stay caps.
 */
import { describe, expect, it } from "vitest";
import { AEC_CAPABILITY_KEYS, type AecCapabilityKey } from "./aec";
import { AEC_COCKPIT_SECTION_KEYS, WORKSPACE_PROJECT_TABS } from "./aec-cockpit";
import {
  AEC_FIELD_ACTIONS,
  AEC_FIELD_ACTION_KEYS,
  AEC_FIELD_QUEUE_LIMIT,
  AEC_FIELD_RULES,
  aecFieldAction,
  fieldDateJalali,
  fieldDaysBetween,
} from "./aec-field";

/** §25's list, verbatim from the issue — the audit this test performs. */
const ISSUE_FLOWS = [
  "create site log",
  "take/upload site photos",
  "create snag",
  "create inspection",
  "create RFI",
  "review submittal",
  "view latest drawing",
  "complete checklist",
  "approve/reject",
  "update task",
  "record material delivery",
];

describe("§25's field flows", () => {
  it("covers every flow the issue lists, exactly once", () => {
    const covered = AEC_FIELD_ACTIONS.map((action) => action.requirement);
    expect(covered.slice().sort()).toEqual(ISSUE_FLOWS.slice().sort());
    expect(new Set(AEC_FIELD_ACTION_KEYS).size).toBe(AEC_FIELD_ACTION_KEYS.length);
  });

  it("keeps the issue's rules as data the screen can quote", () => {
    expect(AEC_FIELD_RULES).toContain("no desktop-only large tables for critical work");
    expect(AEC_FIELD_RULES).toContain("drafts where safe");
    expect(AEC_FIELD_RULES).toContain("clear upload progress");
    expect(AEC_FIELD_RULES).toContain("Shamsi dates");
  });

  it("gives every action a capability that exists, or none for the project register", () => {
    for (const action of AEC_FIELD_ACTIONS) {
      if (action.capability === null) continue;
      expect(AEC_CAPABILITY_KEYS as readonly AecCapabilityKey[]).toContain(action.capability);
    }
    // The project register itself has no switch: RFIs and tasks are §9's and
    // Phase G's, and `projects` is the root capability every AEC business has.
    expect(aecFieldAction("rfi")?.capability).toBeNull();
    expect(aecFieldAction("task")?.capability).toBeNull();
  });

  it("drafts captures, never decisions", () => {
    for (const action of AEC_FIELD_ACTIONS) {
      if (action.kind === "review") {
        // §25's "drafts where safe": an approval kept locally is a decision
        // that never happened, so a review is never draftable.
        expect(action.draftSafe, action.key).toBe(false);
      }
      expect(action.label.trim().length, action.key).toBeGreaterThan(2);
      expect(action.hint.trim().length, action.key).toBeGreaterThan(10);
      expect(action.section, action.key).toBeTruthy();
    }
    // A binary is not a draft either: a half-uploaded photo cannot be resumed.
    expect(aecFieldAction("site_photo")?.draftSafe).toBe(false);
    expect(aecFieldAction("site_log")?.draftSafe).toBe(true);
    expect(aecFieldAction("snag")?.draftSafe).toBe(true);
    expect(aecFieldAction("delivery")?.draftSafe).toBe(true);
  });

  it("hands every action to the panel that owns the long form (§34)", () => {
    const sections = new Set(AEC_FIELD_ACTIONS.map((action) => action.section));
    // The phone never grows a second editor: each action names a project tab
    // that the project page actually has.
    const tabKeys = new Set<string>([
      ...WORKSPACE_PROJECT_TABS.map((tab) => tab.key),
      ...AEC_COCKPIT_SECTION_KEYS,
    ]);
    for (const section of sections) expect(tabKeys.has(section), section).toBe(true);
    expect([...sections].sort()).toEqual(
      ["files", "inspections", "procurement", "rfis", "site", "submittals", "work"],
    );
  });

  it("keeps the board a queue", () => {
    expect(AEC_FIELD_QUEUE_LIMIT).toBeGreaterThan(0);
    expect(AEC_FIELD_QUEUE_LIMIT).toBeLessThanOrEqual(10);
  });
});

describe("the field date helpers", () => {
  it("shows a Gregorian ISO date as a Shamsi day", () => {
    // 2026-03-21 is Farvardin 1, 1405.
    expect(fieldDateJalali("2026-03-21")).toBe("۱ فروردین ۱۴۰۵");
    expect(fieldDateJalali(null)).toBeNull();
    expect(fieldDateJalali("")).toBeNull();
  });

  it("measures days from the business's today, negative when late", () => {
    expect(fieldDaysBetween("2026-03-21", "2026-03-31")).toBe(10);
    expect(fieldDaysBetween("2026-03-21", "2026-03-01")).toBe(-20);
    // Across a Gregorian month boundary and a leap day.
    expect(fieldDaysBetween("2024-02-28", "2024-03-01")).toBe(2);
    expect(fieldDaysBetween("2026-04-10", "2026-04-10")).toBe(0);
  });
});
