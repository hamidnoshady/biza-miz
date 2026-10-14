import { describe, expect, it } from "vitest";
import {
  cloudLoginPageUrl,
  desktopLoginLink,
  hashLoginCode,
  isLoginToken,
  newLoginToken,
  safeNextPath,
  statesMatch,
} from "./desktop-cloud-login";

describe("login tokens", () => {
  it("are url-safe, long, and unique", () => {
    const a = newLoginToken();
    expect(isLoginToken(a)).toBe(true);
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(newLoginToken()).not.toBe(a);
  });

  it("refuses anything that could carry a second parameter or a path", () => {
    for (const bad of ["short", "a".repeat(129), "abc&state=x-padding-pad", "../../etc/passwd/xx", 42, null]) {
      expect(isLoginToken(bad)).toBe(false);
    }
  });

  it("stores only a sha-256", () => {
    expect(hashLoginCode("x")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashLoginCode("x")).not.toBe(hashLoginCode("y"));
  });
});

describe("statesMatch", () => {
  const state = newLoginToken();
  it("needs the link's state to equal this window's cookie", () => {
    expect(statesMatch(state, state)).toBe(true);
    expect(statesMatch(state, newLoginToken())).toBe(false);
    expect(statesMatch(state, undefined)).toBe(false);
    expect(statesMatch(null, state)).toBe(false);
  });
});

describe("desktopLoginLink", () => {
  it("is the app's own scheme with the code and the state", () => {
    const link = new URL(desktopLoginLink("c".repeat(20), "s".repeat(20)));
    expect(link.protocol).toBe("businesssuite:");
    expect(link.hostname).toBe("cloud-login");
    expect(link.searchParams.get("code")).toBe("c".repeat(20));
    expect(link.searchParams.get("state")).toBe("s".repeat(20));
  });
});

describe("cloudLoginPageUrl", () => {
  it("opens /desktop-login on the paired cloud, https only", () => {
    const url = new URL(cloudLoginPageUrl("https://cafe.example.com/", "s".repeat(20), "device-id")!);
    expect(url.origin + url.pathname).toBe("https://cafe.example.com/desktop-login");
    expect(url.searchParams.get("device")).toBe("device-id");
    expect(cloudLoginPageUrl("http://cafe.example.com", "s".repeat(20), "d")).toBeNull();
    expect(cloudLoginPageUrl("nonsense", "s".repeat(20), "d")).toBeNull();
  });
});

describe("safeNextPath", () => {
  it("keeps a same-origin path and refuses every way to another host", () => {
    expect(safeNextPath("/crm/deals?tab=open")).toBe("/crm/deals?tab=open");
    for (const bad of ["//evil.example.org", "/\\evil.example.org","https://evil.example.org", "crm", "", null]) {
      expect(safeNextPath(bad)).toBe("/dashboard");
    }
  });
});
