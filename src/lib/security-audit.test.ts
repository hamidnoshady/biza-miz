/**
 * Issue #854 follow-up — the security-audit writer's two new guarantees:
 * `transactionAuditExecutor()` refuses to pretend a write is transactional
 * when it is not, and a token-version counter is a fact, not a secret.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  pinned: false,
  statements: [] as Array<{ text: string; params?: unknown[] }>,
  bypasses: [] as string[],
}));

vi.mock("./db", () => ({
  isPinnedToTransaction: () => db.pinned,
  query: vi.fn(async (text: string, params?: unknown[]) => {
    db.statements.push({ text, params });
    return { rows: [], rowCount: 1 };
  }),
  withoutTenantScope: async (reason: string, fn: () => Promise<unknown>) => {
    db.bypasses.push(reason);
    return fn();
  },
}));

import {
  SELF_CREDENTIAL_AUDIT_ACTIONS,
  SecretInAuditPayloadError,
  assertSecretFree,
  recordSecurityAudit,
  transactionAuditExecutor,
} from "./security-audit";

beforeEach(() => {
  db.pinned = false;
  db.statements.length = 0;
  db.bypasses.length = 0;
});

describe("transactionAuditExecutor", () => {
  it("throws outside a transaction instead of degrading to an unretried autocommit", () => {
    expect(() => transactionAuditExecutor()).toThrow(/inside a database transaction/);
  });

  it("inside a transaction, routes the row through the pinned ambient query", async () => {
    db.pinned = true;
    await recordSecurityAudit(
      {
        realm: "tenant",
        businessId: "biz-1",
        actorUserId: "user-1",
        action: SELF_CREDENTIAL_AUDIT_ACTIONS.passwordChangedSelf,
        payload: { tokenVersion: 7, revokedSessions: 2 },
      },
      transactionAuditExecutor(),
    );
    expect(db.statements).toHaveLength(1);
    expect(db.statements[0].text).toMatch(/INSERT INTO audit_log/);
    expect(db.statements[0].params?.[2]).toBe("user.password_changed_self");
    expect(JSON.parse(String(db.statements[0].params?.[5]))).toEqual({
      tokenVersion: 7,
      revokedSessions: 2,
    });
  });
});

describe("platform realm audit", () => {
  it("writes a standalone platform row under the documented platform bypass", async () => {
    // Regression: a background tick (signup retention) has no request scope,
    // and `platform_audit_log` is FORCE RLS. Without the bypass the INSERT was
    // rejected with 42501 and the sweep's accountability row was lost.
    await recordSecurityAudit({
      realm: "platform",
      action: "auth.signup.retention_sweep",
      entity: "platform_signup_request",
      payload: { expiredMarked: 0, deleted: 0 },
    });

    expect(db.bypasses).toEqual(["platform"]);
    expect(db.statements).toHaveLength(1);
    expect(db.statements[0].text).toMatch(/INSERT INTO platform_audit_log/);
  });

  it("does not wrap a caller-supplied transaction executor in a fresh bypass", async () => {
    db.pinned = true;
    await recordSecurityAudit(
      {
        realm: "platform",
        action: "auth.signup.retention_sweep",
        entity: "platform_signup_request",
      },
      transactionAuditExecutor(),
    );

    expect(db.bypasses).toEqual([]);
    expect(db.statements).toHaveLength(1);
  });
});

describe("assertSecretFree", () => {
  it("allows the token-version counter but still refuses anything token-shaped", () => {
    expect(() => assertSecretFree({ tokenVersion: 3 })).not.toThrow();
    expect(() => assertSecretFree({ token: "x" })).toThrow(SecretInAuditPayloadError);
    expect(() => assertSecretFree({ sessionToken: "x" })).toThrow(SecretInAuditPayloadError);
    expect(() => assertSecretFree({ code: "123456" })).toThrow(SecretInAuditPayloadError);
    expect(() => assertSecretFree({ pinHash: "x" })).toThrow(SecretInAuditPayloadError);
  });

  it("accepts every payload the self-credential surfaces write", () => {
    for (const payload of [
      { tokenVersion: 2, revokedSessions: 1 },
      { channel: "sms", deliveredTo: "+989***0001", previouslyVerified: true },
      { surface: "settings/profile", hadPin: true },
      { method: "pin" },
      { sessionId: "00000000-0000-0000-0000-000000000000", currentSession: false },
    ]) {
      expect(() => assertSecretFree(payload)).not.toThrow();
    }
  });
});

describe("SELF_CREDENTIAL_AUDIT_ACTIONS", () => {
  it("keeps the action strings existing rows and the audit screen already use", () => {
    expect(SELF_CREDENTIAL_AUDIT_ACTIONS).toEqual({
      passwordChangedSelf: "user.password_changed_self",
      phoneChangedSelf: "auth.self_phone_changed",
      phoneVerifiedSelf: "auth.self_phone_verified",
      pinChangedSelf: "auth.self_pin_changed",
      stepUp: "auth.step_up",
      stepUpFailed: "auth.step_up_failed",
    });
  });
});
