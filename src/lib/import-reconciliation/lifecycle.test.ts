import { describe, expect, it } from "vitest";
import {
  canPublishOutbound,
  canTransitionRun,
  countOutcomes,
  effectForDecision,
  evaluateFirstRunGate,
  isBatchApprovable,
  isPreviewStale,
  progressStage,
  summarizeItems,
} from "./lifecycle";
import type { ReconciliationItemStatus, ReconciliationOutcome } from "./types";

const view = (outcome: ReconciliationOutcome, status: ReconciliationItemStatus) => ({ outcome, status });

describe("run state machine", () => {
  it("only moves along declared edges and closes at applied/cancelled", () => {
    expect(canTransitionRun("discovering", "staged")).toBe(true);
    expect(canTransitionRun("staged", "applied")).toBe(false);
    expect(canTransitionRun("applied", "applying")).toBe(false);
    expect(canTransitionRun("stale", "applying")).toBe(false);
    expect(canTransitionRun("stale", "discovering")).toBe(true);
    expect(canTransitionRun("partially_applied", "applying")).toBe(true);
  });
});

describe("first-run gate", () => {
  it("stages anything that overlaps a populated domain", () => {
    const counts = countOutcomes(["create_new", "create_new"]);
    expect(evaluateFirstRunGate({ canonicalCount: 12, counts, mode: "one_time" }).path).toBe("staged");
  });

  it("uses the fast path for an empty domain with nothing to decide", () => {
    const counts = countOutcomes(["create_new", "create_new"]);
    expect(evaluateFirstRunGate({ canonicalCount: 0, counts, mode: "one_time" })).toEqual({ path: "fast", reasons: ["empty_domain"] });
  });

  it("uses the fast path when every record rides a verified mapping", () => {
    const counts = countOutcomes(["already_linked", "already_linked"]);
    expect(evaluateFirstRunGate({ canonicalCount: 50, counts, mode: "live_link" }).path).toBe("fast");
  });

  it("never fast-paths a record that needs a person, even into an empty domain", () => {
    const counts = countOutcomes(["create_new", "ambiguous"]);
    expect(evaluateFirstRunGate({ canonicalCount: 0, counts, mode: "one_time" }).path).toBe("staged");
    expect(evaluateFirstRunGate({ canonicalCount: 0, counts: countOutcomes(["safe_match"]), mode: "one_time" }).path).toBe("staged");
  });

  it("always stages a preview-only run", () => {
    const counts = countOutcomes(["already_linked"]);
    expect(evaluateFirstRunGate({ canonicalCount: 0, counts, mode: "preview_only" })).toEqual({ path: "staged", reasons: ["preview_only"] });
  });
});

describe("stale preview", () => {
  const staged = { sourceFingerprint: "f1", policyVersion: 1, canonicalToken: "c1", stagedAt: new Date("2026-10-25T00:00:00Z") };
  const now = new Date("2026-10-25T01:00:00Z");

  it("is fresh when nothing moved", () => {
    expect(isPreviewStale({ staged, current: { sourceFingerprint: "f1", policyVersion: 1, canonicalToken: "c1" }, now })).toEqual({
      stale: false,
      reasons: [],
      unverified: false,
    });
  });

  it("goes stale on a changed source, policy, canonical state or age", () => {
    const check = isPreviewStale({
      staged,
      current: { sourceFingerprint: "f2", policyVersion: 2, canonicalToken: "c2" },
      now,
      maxAgeMs: 30 * 60 * 1000,
    });
    expect(check.stale).toBe(true);
    expect(check.reasons.sort()).toEqual(["canonical_changed", "expired", "policy_changed", "source_changed"]);
  });

  it("is unverified — not fresh, not stale — when the source or canonical side cannot be read", () => {
    const offline = isPreviewStale({ staged, current: { sourceFingerprint: null, policyVersion: 1, canonicalToken: "c1" }, now });
    expect(offline).toEqual({ stale: false, reasons: [], unverified: true });
    const noCanonical = isPreviewStale({ staged, current: { sourceFingerprint: "f1", policyVersion: 1, canonicalToken: null }, now });
    expect(noCanonical.unverified).toBe(true);
  });

  it("still reports a changed source when the canonical side is unreadable", () => {
    const check = isPreviewStale({ staged, current: { sourceFingerprint: "f9", policyVersion: 1, canonicalToken: null }, now });
    expect(check.stale).toBe(true);
    expect(check.unverified).toBe(true);
  });
});

describe("decisions", () => {
  it("offers only what the verdict allows", () => {
    expect(effectForDecision("ambiguous", "link", true)).toBe("link");
    expect(effectForDecision("ambiguous", "link", false)).toBeNull();
    expect(effectForDecision("create_new", "link", false)).toBeNull();
    expect(effectForDecision("invalid", "create_separate", false)).toBeNull();
    expect(effectForDecision("field_conflict", "choose_authority", true)).toBe("link");
    expect(effectForDecision("ambiguous", "keep_for_review", true)).toBe("none");
    expect(effectForDecision("ambiguous", "skip", false)).toBe("skip");
  });

  it("batch-approves only the safe classes", () => {
    expect(isBatchApprovable({ outcome: "safe_match", status: "proposed" })).toBe(true);
    expect(isBatchApprovable({ outcome: "create_new", status: "proposed" })).toBe(true);
    expect(isBatchApprovable({ outcome: "ambiguous", status: "proposed" })).toBe(false);
    expect(isBatchApprovable({ outcome: "field_conflict", status: "proposed" })).toBe(false);
    expect(isBatchApprovable({ outcome: "safe_match", status: "applied" })).toBe(false);
  });
});

describe("truthful progress", () => {
  it("counts every outcome and status", () => {
    const counts = summarizeItems([
      view("already_linked", "applied"),
      view("safe_match", "proposed"),
      view("create_new", "approved"),
      view("ambiguous", "held"),
      view("field_conflict", "proposed"),
      view("invalid", "held"),
      view("historical_match", "applied"),
      view("create_new", "failed"),
      view("ambiguous", "skipped"),
    ]);
    expect(counts).toMatchObject({
      read: 9,
      alreadyMapped: 1,
      proposedLinks: 1,
      newRecords: 2,
      conflicts: 3,
      invalid: 1,
      historical: 1,
      pending: 4,
      approved: 1,
      skipped: 1,
      applied: 2,
      failed: 1,
    });
  });

  it("never says fully reconciled while anything is pending, approved, failed or unchecked", () => {
    const partial = summarizeItems([view("create_new", "applied"), view("ambiguous", "proposed")]);
    expect(progressStage({ runStatus: "partially_applied", counts: partial, crossChecked: true }).fullyReconciled).toBe(false);

    const failed = summarizeItems([view("create_new", "applied"), view("create_new", "failed")]);
    expect(progressStage({ runStatus: "partially_applied", counts: failed, crossChecked: true }).fullyReconciled).toBe(false);

    const done = summarizeItems([view("create_new", "applied"), view("ambiguous", "skipped")]);
    expect(progressStage({ runStatus: "applied", counts: done, crossChecked: false })).toMatchObject({ stage: "acknowledged", fullyReconciled: false });
    expect(progressStage({ runStatus: "applied", counts: done, crossChecked: true })).toMatchObject({ stage: "reconciled", fullyReconciled: true });
  });

  it("reports queued-but-unapplied work as reviewed, not synced", () => {
    const counts = summarizeItems([view("create_new", "approved"), view("create_new", "approved")]);
    expect(progressStage({ runStatus: "in_review", counts, crossChecked: false }).stage).toBe("reviewed");
    expect(progressStage({ runStatus: "applying", counts, crossChecked: false }).stage).toBe("applying");
    expect(progressStage({ runStatus: "discovering", counts, crossChecked: false }).stage).toBe("read");
  });
});

describe("outbound publish gate", () => {
  const ok = { runStatus: "applied" as const, itemStatus: "applied" as const, mappingCommitted: true, ownershipConfirmed: true };
  it("publishes only after mapping and ownership are committed and the item applied", () => {
    expect(canPublishOutbound(ok)).toBe(true);
    expect(canPublishOutbound({ ...ok, mappingCommitted: false })).toBe(false);
    expect(canPublishOutbound({ ...ok, ownershipConfirmed: false })).toBe(false);
    expect(canPublishOutbound({ ...ok, itemStatus: "approved" })).toBe(false);
    expect(canPublishOutbound({ ...ok, runStatus: "stale" })).toBe(false);
  });
});
