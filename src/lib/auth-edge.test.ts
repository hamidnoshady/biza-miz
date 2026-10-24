import { afterEach, describe, expect, it } from "vitest";
import { sessionCookieOptions } from "./auth-edge";

describe("sessionCookieOptions", () => {
  // `@types/node` declares NODE_ENV readonly; the test still has to set it.
  const env = process.env as Record<string, string | undefined>;
  const originalNodeEnv = env.NODE_ENV;

  afterEach(() => {
    if (originalNodeEnv === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = originalNodeEnv;
  });

  it("keeps ordinary browser cookies host-scoped and SameSite=Lax", () => {
    env.NODE_ENV = "development";
    const options = sessionCookieOptions();
    expect(options).toMatchObject({ httpOnly: true, sameSite: "lax", secure: false, path: "/" });
    expect("domain" in options).toBe(false);
    expect("partitioned" in options).toBe(false);
  });

  it("partitions Telegram Mini App sessions for Telegram Web without setting a cookie domain", () => {
    env.NODE_ENV = "development";
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
