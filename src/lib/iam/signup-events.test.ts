import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SIGNUP_EVENT_NAMES,
  SIGNUP_FAILURE_CATEGORIES,
  aggregateSignupFunnel,
  authSmsStatus,
  isPlatformAccountId,
  maskEmail,
} from "./signup-events";

/**
 * Issue #1388 — the funnel's shape, its masking rules, and the two privacy
 * invariants that must not regress:
 *
 *  - the event ledger has no column capable of holding PII, an OTP or a token;
 *  - the authentication-SMS path never reaches tenant/Growth billing.
 */

describe("aggregateSignupFunnel", () => {
  it("zero-fills every known event and sums grouped rows", () => {
    const funnel = aggregateSignupFunnel(
      [
        { event: "otp_requested", failure_category: null, count: "12" },
        { event: "otp_requested", failure_category: null, count: "3" },
        { event: "otp_sent", failure_category: null, count: "9" },
        { event: "account_created", failure_category: null, count: 4 },
      ],
      30,
    );

    expect(funnel.windowDays).toBe(30);
    expect(funnel.totals).toHaveLength(SIGNUP_EVENT_NAMES.length);
    expect(funnel.totals.find((row) => row.event === "otp_requested")).toEqual({
      event: "otp_requested",
      label: "درخواست کد",
      count: 15,
    });
    expect(funnel.totals.find((row) => row.event === "onboarding_started")?.count).toBe(0);
    expect(funnel.hasData).toBe(true);
  });

  it("counts failures only on OTP outcome events, by closed category", () => {
    const funnel = aggregateSignupFunnel(
      [
        { event: "otp_failed", failure_category: "rate_limited", count: "5" },
        { event: "otp_verified", failure_category: "invalid_code", count: "2" },
        // Impossible under the table's CHECK; if it ever appears it must not be
        // folded into a failure category.
        { event: "account_created", failure_category: "provider_failure", count: "99" },
      ],
      7,
    );
    expect(funnel.failures.find((row) => row.category === "rate_limited")?.count).toBe(5);
    expect(funnel.failures.find((row) => row.category === "invalid_code")?.count).toBe(2);
    expect(funnel.failures.find((row) => row.category === "provider_failure")?.count).toBe(0);
    expect(funnel.failures).toHaveLength(SIGNUP_FAILURE_CATEGORIES.length);
  });

  it("drops an unknown event name rather than inventing a bucket", () => {
    const funnel = aggregateSignupFunnel([{ event: "something_new", count: "1" }], 30);
    expect(funnel.hasData).toBe(false);
    expect(funnel.totals.every((row) => row.count === 0)).toBe(true);
  });
});

describe("masking", () => {
  it("keeps one leading character and the domain", () => {
    expect(maskEmail("negar@example.com")).toBe("n***@example.com");
    expect(maskEmail(null)).toBeNull();
    expect(maskEmail("not-an-email")).toBe("***");
  });

  it("accepts only a full account uuid as a search key", () => {
    expect(isPlatformAccountId("11111111-1111-4111-8111-111111111111")).toBe(true);
    expect(isPlatformAccountId("11111111-1111-4111-8111-11111111111")).toBe(false);
    expect(isPlatformAccountId("neg@r@example.com")).toBe(false);
    expect(isPlatformAccountId(42)).toBe(false);
  });
});

describe("authentication SMS status", () => {
  it("never claims ready without readable evidence", () => {
    expect(
      authSmsStatus({
        configured: true,
        readable: false,
        openCritical: 0,
        openWarning: 0,
        failures24h: 0,
      }),
    ).toBe("unknown");
  });

  it("separates 'not configured' from 'configured but degraded'", () => {
    expect(
      authSmsStatus({
        configured: false,
        readable: true,
        openCritical: 0,
        openWarning: 0,
        failures24h: 0,
      }),
    ).toBe("not_configured");
    expect(
      authSmsStatus({
        configured: true,
        readable: true,
        openCritical: 0,
        openWarning: 1,
        failures24h: 0,
      }),
    ).toBe("degraded");
    expect(
      authSmsStatus({
        configured: true,
        readable: true,
        openCritical: 0,
        openWarning: 0,
        failures24h: 3,
      }),
    ).toBe("degraded");
    expect(
      authSmsStatus({
        configured: true,
        readable: true,
        openCritical: 0,
        openWarning: 0,
        failures24h: 0,
      }),
    ).toBe("ready");
  });
});

describe("privacy invariants", () => {
  const root = process.cwd();

  it("the funnel ledger cannot store PII, a code or a token", () => {
    const migration = readFileSync(
      join(root, "migrations", "0319_signup_controls_and_funnel.sql"),
      "utf8",
    );
    const table = migration.slice(
      migration.indexOf("CREATE TABLE IF NOT EXISTS platform_signup_events"),
      migration.indexOf("CREATE INDEX IF NOT EXISTS idx_platform_signup_events_event_created"),
    );
    // Event names legitimately contain "otp"; no column may hold the code.
    for (const forbidden of ["phone", "email", "full_name", "first_name", "last_name", "password", "national_id", "token", "payload", "message"]) {
      expect(table.toLowerCase(), forbidden).not.toContain(forbidden);
    }
    expect(table).toContain("failure_category");
    expect(table).toContain("platform_user_id");
    expect(table).toContain("business_id");
  });

  it("authentication SMS never debits a tenant wallet or reaches Growth billing", () => {
    // The signup/OTP path resolves the platform's own SMS provider. A wallet
    // debit would have to import one of these modules; none may appear.
    for (const file of [
      join(root, "src/lib/iam/public-signup.ts"),
      join(root, "src/lib/sms-config.ts"),
      join(root, "src/lib/phone-otp.ts"),
    ]) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/messaging-billing|message-credit|growth-wallet|debitWallet|chargeMessage/);
    }
  });
});
