import { afterEach, describe, expect, it } from "vitest";
import {
  REMEMBERED_LOGIN_COOKIE,
  REMEMBERED_LOGIN_COOKIE_PATH,
  REMEMBERED_CONCURRENCY_GRACE_MS,
  clearedRememberedLoginCookieOptions,
  digestsEqual,
  generateRememberedSecret,
  nextIdleExpiry,
  rememberedLoginCookieMaxAge,
  rememberedLoginCookieOptions,
  rememberedLoginExpiries,
  rememberedLoginPolicy,
} from "./remembered-login";

const DAY = 24 * 60 * 60 * 1000;

afterEach(() => {
  delete process.env.REMEMBERED_LOGIN_IDLE_DAYS;
  delete process.env.REMEMBERED_LOGIN_ABSOLUTE_DAYS;
});

describe("remembered-login policy", () => {
  it("defaults to a 30-day idle window and a 90-day hard maximum", () => {
    const policy = rememberedLoginPolicy();
    expect(policy.idleDays).toBe(30);
    expect(policy.absoluteDays).toBe(90);
    expect(policy.idleMs).toBe(30 * DAY);
    expect(policy.absoluteMs).toBe(90 * DAY);
  });

  it("can be tightened by deployment configuration", () => {
    process.env.REMEMBERED_LOGIN_IDLE_DAYS = "7";
    process.env.REMEMBERED_LOGIN_ABSOLUTE_DAYS = "21";
    const policy = rememberedLoginPolicy();
    expect(policy.idleDays).toBe(7);
    expect(policy.absoluteDays).toBe(21);
  });

  it("never allows an absolute maximum shorter than the idle window", () => {
    process.env.REMEMBERED_LOGIN_IDLE_DAYS = "30";
    process.env.REMEMBERED_LOGIN_ABSOLUTE_DAYS = "5";
    const policy = rememberedLoginPolicy();
    expect(policy.absoluteDays).toBe(30);
    expect(policy.absoluteMs).toBe(policy.idleMs);
  });

  it("ignores nonsense configuration rather than disabling expiry", () => {
    process.env.REMEMBERED_LOGIN_IDLE_DAYS = "-1";
    process.env.REMEMBERED_LOGIN_ABSOLUTE_DAYS = "not-a-number";
    expect(rememberedLoginPolicy()).toMatchObject({ idleDays: 30, absoluteDays: 90 });
  });
});

describe("expiry arithmetic", () => {
  const now = new Date("2026-11-27T10:00:00.000Z");

  it("sets both deadlines from the issue instant", () => {
    const { idleExpiresAt, absoluteExpiresAt } = rememberedLoginExpiries(now);
    expect(idleExpiresAt.toISOString()).toBe("2026-12-27T10:00:00.000Z");
    expect(absoluteExpiresAt.toISOString()).toBe("2027-02-25T10:00:00.000Z");
  });

  it("rolls the idle deadline forward on use", () => {
    const absolute = new Date(now.getTime() + 90 * DAY);
    const later = new Date(now.getTime() + 10 * DAY);
    expect(nextIdleExpiry(later, absolute).toISOString()).toBe(
      new Date(later.getTime() + 30 * DAY).toISOString(),
    );
  });

  it("never lets a renewal extend past the hard maximum", () => {
    // Absolute life ends in two days, so a 30-day idle roll is clamped to it.
    const absolute = new Date(now.getTime() + 2 * DAY);
    expect(nextIdleExpiry(now, absolute).toISOString()).toBe(absolute.toISOString());
  });
});

describe("cookie contract", () => {
  const now = new Date("2026-11-27T10:00:00.000Z");

  it("is HttpOnly, SameSite=Lax, path-narrowed and host-only", () => {
    const absolute = new Date(now.getTime() + 90 * DAY);
    const options = rememberedLoginCookieOptions(absolute);
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe("lax");
    expect(options.path).toBe(REMEMBERED_LOGIN_COOKIE_PATH);
    expect(options.path).toBe("/api/auth");
    expect(options).not.toHaveProperty("domain");
  });

  it("is Secure in production", () => {
    const previous = process.env.NODE_ENV;
    // @ts-expect-error NODE_ENV is read-only in the Next types but writable here.
    process.env.NODE_ENV = "production";
    try {
      expect(rememberedLoginCookieOptions(new Date(now.getTime() + DAY)).secure).toBe(true);
    } finally {
      // @ts-expect-error restore
      process.env.NODE_ENV = previous;
    }
  });

  it("never outlives the idle window or the hard deadline, whichever is sooner", () => {
    const policy = rememberedLoginPolicy();
    expect(rememberedLoginCookieMaxAge(new Date(now.getTime() + 90 * DAY), now)).toBe(
      Math.floor(policy.idleMs / 1000),
    );
    expect(rememberedLoginCookieMaxAge(new Date(now.getTime() + DAY), now)).toBe(24 * 60 * 60);
    expect(rememberedLoginCookieMaxAge(new Date(now.getTime() - DAY), now)).toBe(0);
  });

  it("clears on the same path it was set on", () => {
    expect(clearedRememberedLoginCookieOptions()).toMatchObject({
      path: REMEMBERED_LOGIN_COOKIE_PATH,
      maxAge: 0,
      httpOnly: true,
    });
  });

  it("uses a cookie name that cannot collide with the session or device trust", () => {
    expect(REMEMBERED_LOGIN_COOKIE).toBe("pos_remember");
  });
});

describe("opaque secrets", () => {
  it("are prefixed, high-entropy and different every time", () => {
    const secrets = new Set(Array.from({ length: 50 }, () => generateRememberedSecret()));
    expect(secrets.size).toBe(50);
    for (const secret of secrets) {
      expect(secret.startsWith("rlog_")).toBe(true);
      // 256 bits base64url-encoded is 43 characters.
      expect(secret.slice("rlog_".length).length).toBeGreaterThanOrEqual(43);
    }
  });

  it("compares digests in constant time and rejects unequal lengths", () => {
    expect(digestsEqual("abcd", "abcd")).toBe(true);
    expect(digestsEqual("abcd", "abce")).toBe(false);
    expect(digestsEqual("abcd", "abcde")).toBe(false);
    expect(digestsEqual("", "")).toBe(false);
  });
});

describe("concurrency grace", () => {
  it("is short, bounded, and does not hand out a reusable window", () => {
    expect(REMEMBERED_CONCURRENCY_GRACE_MS).toBeGreaterThan(0);
    expect(REMEMBERED_CONCURRENCY_GRACE_MS).toBeLessThanOrEqual(10_000);
  });
});
