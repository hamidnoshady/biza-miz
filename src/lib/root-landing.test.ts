import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ROOT_LANDING_PATH,
  resolveRootLanding,
  rewritesToRootLanding,
  type RootLandingDeps,
} from "./root-landing";

/**
 * Issue #1003 item 8. `resolveRootLanding` is the decision src/app/page.tsx
 * used to make by throwing `redirect()` (which, under the root loading
 * boundary, could only ever reach the browser as a 200 + meta refresh). These
 * pin that it is the *same* decision, branch for branch.
 */

function headers(values: Record<string, string>) {
  const map = new Headers(values);
  return { get: (name: string) => map.get(name) };
}

function deps(overrides: Partial<RootLandingDeps> = {}): RootLandingDeps {
  return {
    resolveBusinessByLabel: vi.fn(async () => null),
    getSession: vi.fn(async () => null),
    hasAnyUser: vi.fn(async () => true),
    isSetupComplete: vi.fn(async () => true),
    ...overrides,
  };
}

afterEach(() => vi.unstubAllEnvs());

describe("rewritesToRootLanding", () => {
  it("covers GET and HEAD of exactly / on an install without host routing", () => {
    expect(rewritesToRootLanding("GET", "/", null)).toBe(true);
    expect(rewritesToRootLanding("HEAD", "/", null)).toBe(true);
    expect(rewritesToRootLanding("POST", "/", null)).toBe(false);
    expect(rewritesToRootLanding("GET", "/login", null)).toBe(false);
    expect(rewritesToRootLanding("GET", "//", null)).toBe(false);
  });

  it("leaves the hosts whose answer is a page to the page", () => {
    expect(rewritesToRootLanding("GET", "/", { kind: "business" })).toBe(true);
    expect(rewritesToRootLanding("GET", "/", { kind: "admin" })).toBe(true);
    expect(rewritesToRootLanding("GET", "/", { kind: "apex" })).toBe(false);
    expect(rewritesToRootLanding("GET", "/", { kind: "unknown" })).toBe(false);
  });

  it("points at the landing route under /api/host", () => {
    expect(ROOT_LANDING_PATH).toBe("/api/host/landing");
  });
});

describe("resolveRootLanding — no host routing (the desktop, a single café)", () => {
  it("sends a visitor without a session to the login page, or to the wizard on an empty install", async () => {
    vi.stubEnv("ROOT_DOMAIN", "");
    expect(await resolveRootLanding(headers({ host: "127.0.0.1:3000" }), deps())).toEqual({
      kind: "redirect",
      location: "/login",
    });
    expect(
      await resolveRootLanding(headers({ host: "127.0.0.1:3000" }), deps({ hasAnyUser: async () => false })),
    ).toEqual({ kind: "redirect", location: "/welcome" });
  });

  it("holds an owner or manager in setup until it is finished, and sends everyone else to the dashboard", async () => {
    vi.stubEnv("ROOT_DOMAIN", "");
    const unfinished = { isSetupComplete: async () => false };
    for (const role of ["owner", "manager"]) {
      const result = await resolveRootLanding(
        headers({ host: "127.0.0.1:3000" }),
        deps({ ...unfinished, getSession: async () => ({ role, businessId: "biz-1" }) }),
      );
      expect(result, role).toEqual({ kind: "redirect", location: "/setup" });
    }
    const cashier = await resolveRootLanding(
      headers({ host: "127.0.0.1:3000" }),
      deps({ ...unfinished, getSession: async () => ({ role: "cashier", businessId: "biz-1" }) }),
    );
    expect(cashier).toEqual({ kind: "redirect", location: "/dashboard" });

    const finished = await resolveRootLanding(
      headers({ host: "127.0.0.1:3000" }),
      deps({ getSession: async () => ({ role: "owner", businessId: "biz-1" }) }),
    );
    expect(finished).toEqual({ kind: "redirect", location: "/dashboard" });
  });

  it("never consults the host resolver when there is no root domain", async () => {
    vi.stubEnv("ROOT_DOMAIN", "");
    const resolveBusinessByLabel = vi.fn(async () => null);
    await resolveRootLanding(headers({ host: "acme.pos.example.com" }), deps({ resolveBusinessByLabel }));
    expect(resolveBusinessByLabel).not.toHaveBeenCalled();
  });
});

describe("resolveRootLanding — host routing", () => {
  it("renders the directory on the apex and the explanation on an unknown host", async () => {
    vi.stubEnv("ROOT_DOMAIN", "pos.example.com");
    const getSession = vi.fn(async () => null);
    expect(await resolveRootLanding(headers({ host: "pos.example.com" }), deps({ getSession }))).toEqual({
      kind: "directory",
    });
    expect(await resolveRootLanding(headers({ host: "stray.example.net" }), deps({ getSession }))).toEqual({
      kind: "unresolvable",
    });
    // Neither needs the session: they are the same page for everyone.
    expect(getSession).not.toHaveBeenCalled();
  });

  it("moves a renamed business's old host to its current one, keeping the scheme and port the browser used", async () => {
    vi.stubEnv("ROOT_DOMAIN", "pos.example.com");
    const resolveBusinessByLabel = vi.fn(async () => ({ subdomain: "acme", viaAlias: true }));
    const result = await resolveRootLanding(
      headers({ host: "old-acme.pos.example.com:8443", "x-forwarded-proto": "https" }),
      deps({ resolveBusinessByLabel }),
    );
    expect(resolveBusinessByLabel).toHaveBeenCalledWith("old-acme");
    expect(result).toEqual({ kind: "redirect", location: "https://acme.pos.example.com:8443/" });
  });

  it("treats a business's current host like any other install", async () => {
    vi.stubEnv("ROOT_DOMAIN", "pos.example.com");
    const result = await resolveRootLanding(
      headers({ host: "acme.pos.example.com" }),
      deps({ resolveBusinessByLabel: async () => ({ subdomain: "acme", viaAlias: false }) }),
    );
    expect(result).toEqual({ kind: "redirect", location: "/login" });
  });
});
