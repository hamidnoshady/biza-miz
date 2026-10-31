import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  EMPTY_MASTER_BALANCE_MIRROR,
  MASTER_BALANCE_STALE_HOURS,
  masterBalanceView,
  type MasterBalanceMirror,
} from "./master-balance";

/**
 * Issue #902 §9 item 4 — the console must be able to show the master balance the
 * last funding pass observed, and must not present a leftover figure as a live
 * one. These are the rules for that second half; the SQL is exercised by the
 * `kavenegar-managed-accounts` database suite.
 */

const NOW = new Date("2026-10-30T12:00:00.000Z");

function mirror(overrides: Partial<MasterBalanceMirror>): MasterBalanceMirror {
  return { ...EMPTY_MASTER_BALANCE_MIRROR, ...overrides };
}

function minutesAgo(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

const repoRoot = path.resolve(__dirname, "../../..");
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), "utf8");

describe("the master balance mirror", () => {
  it("says nothing rather than zero when the provider has never reported", () => {
    const view = masterBalanceView(EMPTY_MASTER_BALANCE_MIRROR, NOW);
    expect(view.state).toBe("unknown");
    expect(view.rial).toBeNull();
    expect(view.ageMinutes).toBeNull();

    // A value with no observation time is not a measurement: it cannot be aged,
    // so it cannot be trusted, so it is unknown. Migration 0269 forbids the pair
    // ever being split, and this is the runtime half of that rule.
    expect(masterBalanceView(mirror({ rial: 5_000_000 }), NOW).state).toBe("unknown");
  });

  it("calls a recent observation current", () => {
    const view = masterBalanceView(
      mirror({ rial: 41_000_000, observedAt: minutesAgo(14), checkedAt: minutesAgo(14) }),
      NOW,
    );
    expect(view).toMatchObject({ state: "current", rial: 41_000_000, ageMinutes: 14 });
  });

  it("marks a figure a failed read left behind as unreadable, not current", () => {
    // Observed 20 minutes ago, and a pass tried again 5 minutes ago and failed.
    // The number is honest history; calling it current is how an operator
    // concludes the floor is safe while the provider is actually unreachable.
    const view = masterBalanceView(
      mirror({ rial: 41_000_000, observedAt: minutesAgo(20), checkedAt: minutesAgo(5) }),
      NOW,
    );
    expect(view.state).toBe("unreadable");
    expect(view.rial).toBe(41_000_000);
  });

  it("outranks stale with unreadable: the failure is the more urgent fact", () => {
    const view = masterBalanceView(
      mirror({ rial: 41_000_000, observedAt: minutesAgo(60 * 30), checkedAt: minutesAgo(1) }),
      NOW,
    );
    expect(view.state).toBe("unreadable");
  });

  it("ages a figure out of 'current' after the window, without forgetting it", () => {
    const fresh = masterBalanceView(
      mirror({ rial: 1, observedAt: minutesAgo(MASTER_BALANCE_STALE_HOURS * 60) }),
      NOW,
    );
    expect(fresh.state).toBe("current");

    const old = masterBalanceView(
      mirror({ rial: 1, observedAt: minutesAgo(MASTER_BALANCE_STALE_HOURS * 60 + 1) }),
      NOW,
    );
    expect(old.state).toBe("stale");
    expect(old.rial).toBe(1);
  });

  it("treats a future timestamp as age zero, never as fresher than possible", () => {
    const view = masterBalanceView(
      mirror({ rial: 1, observedAt: new Date(NOW.getTime() + 90_000).toISOString() }),
      NOW,
    );
    expect(view.ageMinutes).toBe(0);
    expect(view.state).toBe("current");
  });
});

describe("where the mirror is written", () => {
  it("is written only by the pass that read the provider", () => {
    const pricing = read("src/lib/kavenegar/pricing-service.ts");
    const write = pricing.slice(pricing.indexOf("recordMasterBalanceObservation({"));
    expect(write.length).toBeGreaterThan(0);

    // Guard the condition, not just the call: an operator-supplied figure must
    // never overwrite evidence about what the provider actually said.
    expect(pricing).toMatch(/if \(input\.masterBalanceRial === undefined\) \{\s*\n\s*await recordMasterBalanceObservation/);

    // A mirror that fails to write must not fail the pass it describes.
    expect(write.slice(0, 400)).toMatch(/\.catch\(/);
  });

  it("never writes a value without its observation time", () => {
    const lib = read("src/lib/kavenegar/master-balance.ts");
    const write = lib.slice(lib.indexOf("export async function recordMasterBalanceObservation"));
    // Both halves in one statement: the schema's pairing constraint can then
    // never observe a half-written observation.
    expect(write).toMatch(/managed_master_balance_rial = \$1,[\s\S]{0,200}managed_master_balance_at = \$2/);
    expect(write).toMatch(/managed_master_balance_checked_at = \$2/);
  });

  it("does its reads and writes in the documented platform scope", () => {
    const lib = read("src/lib/kavenegar/master-balance.ts");
    expect(lib).toMatch(/const SCOPE = "kavenegar-master-balance";/);
    const scopes = lib.match(/withoutTenantScope\(SCOPE,/g) ?? [];
    expect(scopes.length).toBe(2);
    // The row is platform configuration: one tenant must never read or alter it.
    expect(lib).not.toMatch(/withTenant\(/);
  });

  it("reaches the console through the snapshot, not a live provider call", () => {
    const service = read("src/lib/kavenegar/provisioning-service.ts");
    expect(service).toMatch(/masterBalance: MasterBalanceMirror/);
    expect(service).toMatch(/readMasterBalanceMirror\(\)/);

    const route = read("src/app/api/platform/sms/accounts/route.ts");
    expect(route).toMatch(/masterBalance: masterBalanceView\(snapshot\.masterBalance\)/);
    // The cons‌ole must never call the provider to render a page: the GET is
    // cached evidence, and the funding tick is the only reader.
    const get = route.slice(0, route.indexOf("export const POST"));
    expect(get).not.toMatch(/fetchAccountInfo|readMasterBalanceRial/);

    const card = read("src/app/platform/messaging/managed-accounts-card.tsx");
    expect(card).toMatch(/masterBalanceLine\(snapshot\.masterBalance\)/);
  });
});
