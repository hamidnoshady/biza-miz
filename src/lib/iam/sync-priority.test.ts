import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The Hybrid tick's ordering, and (since issue #988) its evidence.
 *
 * Two separate guarantees, both of which the reported outage turned on:
 *  1. security reconciliation gates operational traffic — a suspension must
 *     land before the orders queued behind it;
 *  2. a gated tick *records* that it gated, so the block outlives the console.
 * An earlier version of this file only checked (1), which is exactly how a
 * silently blocked install kept passing review: the gate was right and nobody
 * could see it firing.
 */

const tickSource = () => {
  const source = readFileSync(new URL("../server-sync.ts", import.meta.url), "utf8");
  return source.slice(source.indexOf("export async function runServerSyncTick"));
};

describe("Hybrid reconnect ordering", () => {
  it("gates operational push and pull on IAM reconciliation", () => {
    const source = readFileSync(new URL("../server-sync.ts", import.meta.url), "utf8");
    const tick = source.slice(source.indexOf("export async function runServerSyncTick"));
    // The tick reads the gate — the one function that runs the IAM
    // reconciliation — before anything operational may run.
    expect(tick.indexOf("runOperationalSyncGate")).toBeGreaterThan(-1);
    expect(tick.indexOf("runOperationalSyncGate")).toBeLessThan(tick.indexOf("runServerPush"));
    expect(tick.indexOf("runOperationalSyncGate")).toBeLessThan(tick.indexOf("runServerPull"));
    expect(tick).toContain("if (!iamReady)");
  });

  it("records a gated tick durably before it skips the rest of the tick", () => {
    const tick = tickSource();
    expect(tick).toContain("recordOperationalSyncBlocked");
    expect(tick.indexOf("recordOperationalSyncBlocked")).toBeLessThan(tick.indexOf("runServerPush"));
    expect(tick).toContain("clearOperationalSyncBlock");
  });

  it("still refuses to degrade the gate into best-effort sync", () => {
    const tick = tickSource();
    // The block is recorded *instead of* weakening the gate: a gated tick still
    // skips master data, push and pull outright.
    const recordAt = tick.indexOf("recordOperationalSyncBlocked");
    const continueAt = tick.indexOf("continue;", recordAt);
    expect(continueAt).toBeGreaterThan(-1);
    expect(tick.slice(continueAt).indexOf("runServerPush")).toBeGreaterThan(-1);
    expect(tick.slice(0, continueAt)).toContain("if (!iamReady)");
    // …and nothing after the skip is allowed to run before it.
    expect(tick.indexOf("runMasterSync")).toBeGreaterThan(continueAt);
  });

  it("closes the record for an install that is merely unconfigured", () => {
    const tick = tickSource();
    // A local or still-pairing install must never read as blocked; and a block
    // recorded before the switch went off has to be lifted, not left accusing a
    // cloud this install no longer talks to.
    const clearAt = tick.indexOf("clearOperationalSyncBlock");
    expect(clearAt).toBeGreaterThan(-1);
    expect(tick.slice(0, clearAt)).toContain('gate.reason === "reconciled" || gate.reason === "not_configured"');
    // …and only a real gate failure is recorded as a blocked tick.
    expect(tick.slice(0, tick.indexOf("recordOperationalSyncBlocked"))).not.toContain("else if (gate.reason === \"not_configured\")");
  });

  it("evaluates the whole gate in one place so obeying and recording cannot drift", () => {
    const source = readFileSync(new URL("../server-sync.ts", import.meta.url), "utf8");
    const gate = source.slice(
      source.indexOf("export async function runOperationalSyncGate"),
      source.indexOf("export async function runServerSyncTick"),
    );
    expect(gate.length).toBeGreaterThan(0);
    // All three steps that can close the gate are inside it.
    expect(gate).toContain("acknowledgePendingPairing");
    expect(gate).toContain("refreshStagedSiteCredential");
    expect(gate).toContain("runIamSyncAttempt");
    // A gate that cannot be evaluated is closed, never silently open.
    expect(gate).toContain('return { ready: false, reason: "iam_failed"');
  });

  it("folds the pairing acknowledgement into the gate it records", () => {
    // Issue #987 made a pending acknowledgement skip the tick. That is the
    // same shape of defect #988 is about — a `continue` whose only trace was a
    // log line — so the step now reports into the gate instead of jumping past
    // it, and the tick must not grow a second silent skip of its own.
    const source = readFileSync(new URL("../server-sync.ts", import.meta.url), "utf8");
    const gate = source.slice(
      source.indexOf("export async function runOperationalSyncGate"),
      source.indexOf("export async function runServerSyncTick"),
    );
    expect(gate).toContain('reason: "pairing_pending"');
    // Only an install that was already activated is a *blocked* one; a pairing
    // still in flight is `not_configured`, and has nothing held back from it.
    expect(gate.indexOf('reason: "not_configured", siteDeviceId, error: ack.error')).toBeGreaterThan(
      gate.indexOf('reason: "pairing_pending"'),
    );
    const tick = tickSource();
    expect(tick).not.toContain("acknowledgePendingPairing");
    expect(tick).not.toContain("credentialReady");
  });

  it("keeps the boolean contract runIamSync has always had", () => {
    const sync = readFileSync(new URL("./sync.ts", import.meta.url), "utf8");
    expect(sync).toContain("export async function runIamSync(businessId:string):Promise<boolean>");
    // …as a projection of the outcome, not a second implementation.
    expect(sync).toContain('(await runIamSyncAttempt(businessId)).ready');
    // The gate's own reason must survive: that is what the durable record reads.
    expect(sync).toContain('reason:IamSyncReason');
  });
});
