import { describe, expect, it } from "vitest";
import {
  classifyIamFailure,
  IAM_FAILURE_CODES,
  IAM_FAILURE_LABELS,
  isIamFailureCode,
  nextBlockedWrite,
  operationalSyncBlockedSummary,
  operationalSyncHealth,
  OPERATIONAL_SYNC_ALERT_AFTER_TICKS,
  type OperationalBlockBefore,
} from "./operational-sync-health";

/**
 * The rules behind issue #988 — an IAM-sync failure that silently gates
 * operational sync. Pure logic only: what a failure is called, how a blocked
 * episode is counted, and when it is loud enough to alert. The DB half
 * (`operational-sync-block.ts`) is covered against a real Postgres in
 * integration/hybrid-operational-sync-block.integration.test.ts.
 */

function episode(overrides: Partial<OperationalBlockBefore> = {}): OperationalBlockBefore {
  return {
    status: "blocked",
    consecutiveBlockedTicks: 1,
    totalBlockedTicks: 1,
    episodesBlocked: 1,
    alerted: false,
    ...overrides,
  };
}

describe("classifyIamFailure", () => {
  it("separates the answers an operator acts on differently", () => {
    // A refused credential or a suspension: re-pair, or ask the cloud why.
    expect(classifyIamFailure("snapshot_http_401")).toBe("unauthorized");
    expect(classifyIamFailure("events_http_403")).toBe("forbidden");
    // A cloud too old to have the endpoint at all: upgrading is the fix.
    expect(classifyIamFailure("drift_snapshot_http_404")).toBe("unsupported_cloud");
    expect(classifyIamFailure("snapshot_http_503")).toBe("cloud_error");
    // Nothing to do but wait for the network.
    expect(classifyIamFailure("fetch failed")).toBe("transport");
    expect(classifyIamFailure("TypeError: fetch failed")).toBe("transport");
    expect(classifyIamFailure("The operation was aborted due to timeout")).toBe("timeout");
  });

  it("reads the contract failures before the generic buckets", () => {
    // A gap and a mismatch both carry an HTTP-looking or generic tail; they are
    // the two cases a retry cannot fix, so they win.
    expect(classifyIamFailure("sequence_gap:12:14")).toBe("sequence_gap");
    expect(classifyIamFailure("snapshot_checksum_mismatch")).toBe("contract_mismatch");
    expect(classifyIamFailure("iam_drift_detected")).toBe("contract_mismatch");
    expect(classifyIamFailure("snapshot_identity_mismatch")).toBe("contract_mismatch");
  });

  it("tells a waiting credential hand-off apart from a cloud that refused it", () => {
    // Both come out of `refreshStagedSiteCredentialAttempt()`, and the owner's
    // next step is the opposite in each case: wait, or fix the connection.
    expect(classifyIamFailure("site_credential_rotation_pending")).toBe("credential_rotation_pending");
    expect(classifyIamFailure("credential_rotation_http_503")).toBe("cloud_error");
    expect(classifyIamFailure("credential_rotation_ack_http_401")).toBe("unauthorized");
  });

  it("keeps an absent or unknown reason honest instead of inventing one", () => {
    expect(classifyIamFailure(null)).toBe("sync_error");
    expect(classifyIamFailure("   ")).toBe("sync_error");
    expect(classifyIamFailure("relation \"users\" does not exist")).toBe("sync_error");
    expect(classifyIamFailure("not_configured")).toBe("not_configured");
  });

  it("gives every code it can produce an operator-facing sentence", () => {
    for (const code of IAM_FAILURE_CODES) {
      expect(IAM_FAILURE_LABELS[code].length).toBeGreaterThan(0);
      // A label is read by an owner; a status code is read by support.
      expect(IAM_FAILURE_LABELS[code]).not.toMatch(/http_|Error|\[object/);
    }
    expect(IAM_FAILURE_CODES.every((code) => isIamFailureCode(code))).toBe(true);
    expect(isIamFailureCode("made_up_code")).toBe(false);
  });
});

describe("nextBlockedWrite", () => {
  it("opens an episode on the first blocked tick", () => {
    const next = nextBlockedWrite(null);
    expect(next).toEqual({
      consecutiveBlockedTicks: 1,
      totalBlockedTicks: 1,
      episodesBlocked: 1,
      startsEpisode: true,
      alertDue: false,
    });
  });

  it("counts a continuing episode consecutively, and a total alongside it", () => {
    const next = nextBlockedWrite(episode({ consecutiveBlockedTicks: 7, totalBlockedTicks: 41 }));
    expect(next.consecutiveBlockedTicks).toBe(8);
    expect(next.totalBlockedTicks).toBe(42);
    expect(next.startsEpisode).toBe(false);
    // One episode, however many ticks: the episode counter is what says "again".
    expect(next.episodesBlocked).toBe(1);
  });

  it("starts a new episode after a clear instead of resuming the old count", () => {
    const next = nextBlockedWrite(episode({ status: "clear", consecutiveBlockedTicks: 0, totalBlockedTicks: 90 }));
    expect(next.consecutiveBlockedTicks).toBe(1);
    expect(next.episodesBlocked).toBe(2);
    expect(next.startsEpisode).toBe(true);
  });

  it("treats a row whose counters lost sync as one blocked tick, not zero", () => {
    expect(nextBlockedWrite(episode({ consecutiveBlockedTicks: 0 })).consecutiveBlockedTicks).toBe(1);
    expect(nextBlockedWrite({}).consecutiveBlockedTicks).toBe(1);
    expect(nextBlockedWrite(undefined).startsEpisode).toBe(true);
  });

  it("alerts at the threshold, once per episode", () => {
    const justShort = nextBlockedWrite(episode({ consecutiveBlockedTicks: OPERATIONAL_SYNC_ALERT_AFTER_TICKS - 2 }));
    expect(justShort.alertDue).toBe(false);
    const crossing = nextBlockedWrite(episode({ consecutiveBlockedTicks: OPERATIONAL_SYNC_ALERT_AFTER_TICKS - 1 }));
    expect(crossing.consecutiveBlockedTicks).toBe(OPERATIONAL_SYNC_ALERT_AFTER_TICKS);
    expect(crossing.alertDue).toBe(true);
    // Tick 11 of the same outage must stay quiet — nine days of blocking is one
    // alert, not 25 920 of them, which is the noise this replaces.
    const later = nextBlockedWrite(episode({
      consecutiveBlockedTicks: OPERATIONAL_SYNC_ALERT_AFTER_TICKS,
      alerted: true,
    }));
    expect(later.alertDue).toBe(false);
  });

  it("alerts again when a block returns after a recovery", () => {
    // A row left over from an alerted episode that then converged: the old
    // `alerted` stamp must not silence the next outage.
    let before: OperationalBlockBefore = {
      status: "clear",
      consecutiveBlockedTicks: 0,
      totalBlockedTicks: 90,
      episodesBlocked: 3,
      alerted: true,
    };
    for (let tick = 1; tick < OPERATIONAL_SYNC_ALERT_AFTER_TICKS; tick += 1) {
      const next = nextBlockedWrite(before);
      expect(next.alertDue).toBe(false);
      before = {
        status: "blocked",
        consecutiveBlockedTicks: next.consecutiveBlockedTicks,
        totalBlockedTicks: next.totalBlockedTicks,
        episodesBlocked: next.episodesBlocked,
        alerted: next.alertDue,
      };
      // The first tick after the clear is the start of a new episode.
      if (tick === 1) expect(next.episodesBlocked).toBe(4);
    }
    expect(nextBlockedWrite(before).alertDue).toBe(true);
  });
});

describe("operationalSyncHealth", () => {
  it("never calls an unconfigured install blocked", () => {
    // A local profile has no cloud to be gated by; it must not inherit the
    // Hybrid plane's alarms (the same rule hybridIdentityHealth applies).
    expect(operationalSyncHealth({
      configured: false,
      block: { status: "blocked", consecutiveBlockedTicks: 40, lastCode: "forbidden" },
    })).toMatchObject({ state: "not_configured", alertDue: false, reason: null });
  });

  it("reads an absent row as flowing, not as unknown", () => {
    // The tick writes this row only when it gates something, so "no row" is a
    // statement of health rather than a missing measurement.
    expect(operationalSyncHealth({ configured: true, block: null })).toMatchObject({
      state: "healthy", consecutiveBlockedTicks: 0, code: null,
    });
    expect(operationalSyncHealth({ configured: true, block: { status: "clear" } }).state).toBe("healthy");
  });

  it("reports the block with its code and its size", () => {
    const result = operationalSyncHealth({
      configured: true,
      block: { status: "blocked", consecutiveBlockedTicks: OPERATIONAL_SYNC_ALERT_AFTER_TICKS + 3, lastCode: "transport" },
    });
    expect(result).toMatchObject({
      state: "blocked",
      alertDue: true,
      consecutiveBlockedTicks: OPERATIONAL_SYNC_ALERT_AFTER_TICKS + 3,
      code: "transport",
      reason: "operational_sync_blocked:transport",
    });
  });

  it("keeps a below-threshold block visible but quiet", () => {
    const result = operationalSyncHealth({
      configured: true,
      block: { status: "blocked", consecutiveBlockedTicks: 2, lastCode: "sequence_gap" },
    });
    expect(result.state).toBe("blocked");
    expect(result.alertDue).toBe(false);
  });

  it("falls back to sync_error for a code it does not know", () => {
    expect(operationalSyncHealth({
      configured: true,
      block: { status: "blocked", consecutiveBlockedTicks: 1, lastCode: "future_cloud_code" },
    }).code).toBe("sync_error");
  });
});

describe("operationalSyncBlockedSummary", () => {
  it("says what is blocked, since when, and how much is waiting", () => {
    const text = operationalSyncBlockedSummary({
      since: "۱۴۰۴/۰۷/۲۵ ۰۹:۱۰",
      pendingOutbox: 12,
      code: "forbidden",
    });
    expect(text).toContain("مسدود");
    expect(text).toContain("از ۱۴۰۴/۰۷/۲۵ ۰۹:۱۰");
    expect(text).toContain(IAM_FAILURE_LABELS.forbidden);
    // Persian digits, like every other number a user reads.
    expect(text).toContain("۱۲ رویداد در انتظار ارسال");
  });

  it("stays readable with nothing queued and no episode start yet", () => {
    const text = operationalSyncBlockedSummary({ since: null, pendingOutbox: 0 });
    expect(text).toContain("مسدود");
    expect(text).not.toContain("از ");
    expect(text).not.toContain("رویداد در انتظار ارسال");
  });

  it("never puts a raw error string in front of the owner", () => {
    const text = operationalSyncBlockedSummary({ since: null, pendingOutbox: 3, code: "transport" });
    expect(text).not.toMatch(/fetch failed|http_\d|Error:/);
  });
});
