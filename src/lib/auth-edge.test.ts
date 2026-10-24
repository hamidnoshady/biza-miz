import { afterEach, describe, expect, it } from "vitest";
import { sessionCookieOptions } from "./auth-edge";

describe("sessionCookieOptions", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  it("keeps ordinary browser cookies host-scoped and SameSite=Lax", () => {
    process.env.NODE_ENV = "development";
    const options = sessionCookieOptions();
    expect(options).toMatchObject({ httpOnly: true, sameSite: "lax", secure: false, path: "/" });
    expect("domain" in options).toBe(false);
    expect("partitioned" in options).toBe(false);
  });

  it("partitions Telegram Mini App sessions for Telegram Web without setting a cookie domain", () => {
    process.env.NODE_ENV = "development";
    const options = sessionCookieOptions({
      telegramIdentityLinkId: "123e4567-e89b-42d3-a456-426614174000",
      telegramIdentityGeneration: 1,
    });
    expect(options).toMatchObject({
      httpOnly: true,
      sameSite: "none",
      secure: true,
      partitioned: true,
      path: "/",
    });
    expect("domain" in options).toBe(false);
  });
});
