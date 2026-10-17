import { describe, expect, it } from "vitest";
import {
  isLegalRepairRunTransition,
  isSupportAiProfile,
  isSupportAiTool,
  isSupportAssistanceCap,
  isSupportAssistanceState,
  isSupportConsentSubject,
  isSupportDiagnosticModule,
  isSupportOperation,
  isSupportRepairRisk,
  isSupportRepairRunState,
  isSupportRequestState,
  isSupportRunState,
  isSupportTokenPurpose,
  isTerminalAssistanceState,
  isTerminalRepairRunState,
  isTerminalRequestState,
  normalizeSupportModules,
  SUPPORT_ASSISTANCE_STATE_LABELS,
  SUPPORT_DIAGNOSTIC_MODULES,
  SUPPORT_OPERATIONS,
  SUPPORT_REPAIR_RUN_STATE_LABELS,
  SUPPORT_REQUEST_STATE_LABELS,
} from "./types";

describe("support companion vocabulary (issue #984)", () => {
  it("accepts only the fixed diagnostic modules", () => {
    for (const module of SUPPORT_DIAGNOSTIC_MODULES) {
      expect(isSupportDiagnosticModule(module)).toBe(true);
    }
    expect(isSupportDiagnosticModule("arbitrary_sql")).toBe(false);
    expect(isSupportDiagnosticModule("")).toBe(false);
    expect(isSupportDiagnosticModule(null)).toBe(false);
  });

  it("normalizes module lists against the fixed catalog, defaulting to all", () => {
    expect(normalizeSupportModules(["storage", "bogus", "storage"])).toEqual(["storage"]);
    expect(normalizeSupportModules([])).toEqual([...SUPPORT_DIAGNOSTIC_MODULES]);
    expect(normalizeSupportModules("nope")).toEqual([...SUPPORT_DIAGNOSTIC_MODULES]);
    expect(normalizeSupportModules(null)).toEqual([...SUPPORT_DIAGNOSTIC_MODULES]);
  });

  it("accepts only the fixed operation vocabulary", () => {
    for (const op of SUPPORT_OPERATIONS) expect(isSupportOperation(op)).toBe(true);
    expect(isSupportOperation("shell.exec")).toBe(false);
    expect(isSupportOperation("sql.query")).toBe(false);
  });

  it("pins terminal request states so replays cannot revive them", () => {
    for (const state of ["declined", "partial", "completed", "failed", "cancelled", "expired"] as const) {
      expect(isTerminalRequestState(state)).toBe(true);
    }
    for (const state of ["pending", "delivered", "opened", "consented", "running"] as const) {
      expect(isTerminalRequestState(state)).toBe(false);
    }
  });

  it("pins terminal repair and assistance states", () => {
    for (const state of [
      "succeeded",
      "rolled_back",
      "failed",
      "recovery_required",
      "declined",
      "blocked",
      "cancelled",
    ] as const) {
      expect(isTerminalRepairRunState(state)).toBe(true);
    }
    expect(isTerminalRepairRunState("executing")).toBe(false);
    for (const state of ["ended", "revoked", "expired", "failed"] as const) {
      expect(isTerminalAssistanceState(state)).toBe(true);
    }
    expect(isTerminalAssistanceState("active_control")).toBe(false);
  });

  it("labels every request, repair and assistance state in Persian", () => {
    for (const state of Object.keys(SUPPORT_REQUEST_STATE_LABELS)) {
      expect(isSupportRequestState(state)).toBe(true);
      expect(SUPPORT_REQUEST_STATE_LABELS[state as keyof typeof SUPPORT_REQUEST_STATE_LABELS].length).toBeGreaterThan(0);
    }
    for (const state of Object.keys(SUPPORT_REPAIR_RUN_STATE_LABELS)) {
      expect(isSupportRepairRunState(state)).toBe(true);
    }
    for (const state of Object.keys(SUPPORT_ASSISTANCE_STATE_LABELS)) {
      expect(isSupportAssistanceState(state)).toBe(true);
    }
  });

  it("enforces the repair run state graph", () => {
    // The happy path: propose → authorize → execute → verify → succeed.
    expect(isLegalRepairRunTransition("proposed", "authorized")).toBe(true);
    expect(isLegalRepairRunTransition("authorized", "executing")).toBe(true);
    expect(isLegalRepairRunTransition("executing", "verifying")).toBe(true);
    expect(isLegalRepairRunTransition("verifying", "succeeded")).toBe(true);
    // The P1-3 attack edges: jumping to execution or inventing success.
    expect(isLegalRepairRunTransition("proposed", "executing")).toBe(false);
    expect(isLegalRepairRunTransition("proposed", "succeeded")).toBe(false);
    expect(isLegalRepairRunTransition("proposed", "verifying")).toBe(false);
    expect(isLegalRepairRunTransition("authorized", "succeeded")).toBe(false);
    expect(isLegalRepairRunTransition("authorized", "verifying")).toBe(false);
    expect(isLegalRepairRunTransition("executing", "succeeded")).toBe(false);
    // Terminal states have no outgoing edges; nothing self-transitions.
    expect(isLegalRepairRunTransition("succeeded", "executing")).toBe(false);
    expect(isLegalRepairRunTransition("failed", "proposed")).toBe(false);
    expect(isLegalRepairRunTransition("blocked", "authorized")).toBe(false);
    expect(isLegalRepairRunTransition("executing", "executing")).toBe(false);
    // Stop/drift stay reachable from every live state.
    for (const from of ["proposed", "dry_run_ready", "awaiting_approval", "authorized", "executing"] as const) {
      expect(isLegalRepairRunTransition(from, "blocked")).toBe(true);
      expect(isLegalRepairRunTransition(from, "cancelled")).toBe(true);
    }
  });

  it("guards every other vocabulary", () => {
    expect(isSupportRunState("running")).toBe(true);
    expect(isSupportRunState("green")).toBe(false);
    expect(isSupportRepairRisk("high")).toBe(true);
    expect(isSupportRepairRisk("extreme")).toBe(false);
    expect(isSupportAssistanceCap("view")).toBe(true);
    expect(isSupportAssistanceCap("clipboard")).toBe(false);
    expect(isSupportTokenPurpose("offline_onsite")).toBe(true);
    expect(isSupportTokenPurpose("master")).toBe(false);
    expect(isSupportConsentSubject("remote_control")).toBe(true);
    expect(isSupportConsentSubject("everything")).toBe(false);
    expect(isSupportAiTool("support.evidence.read")).toBe(true);
    expect(isSupportAiTool("shell.exec")).toBe(false);
    expect(isSupportAiTool("sql.query")).toBe(false);
    expect(isSupportAiProfile("support-default")).toBe(true);
    expect(isSupportAiProfile("tenant-chat")).toBe(false);
  });
});
