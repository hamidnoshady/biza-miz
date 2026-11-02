/**
 * Issue #883 P1-6 — the host/token binding policy. `resolveMcpTenant`'s
 * database side is covered by the connector integration suite; the *decision*
 * — which resolutions may serve which business — is pure and pinned here.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  labelledBusinessHost,
  mcpIssuer,
  mcpHostAllowsBusiness,
  mcpTenantErrorDescription,
  type McpTenantResolution,
} from "./origin";

const BIZ_A = "aaaaaaaa-0000-0000-0000-00000000000a";
const BIZ_B = "bbbbbbbb-0000-0000-0000-00000000000b";

function resolved(businessId: string, viaAlias = false): McpTenantResolution {
  return {
    ok: true,
    business: {
      businessId,
      name: "کسب‌وکار",
      subdomain: "shop",
      status: "active",
      viaAlias,
    },
  };
}

describe("mcpHostAllowsBusiness", () => {
  it("lets a token answer on its own business's host", () => {
    expect(mcpHostAllowsBusiness(resolved(BIZ_A), BIZ_A)).toBe(true);
  });

  it("lets an alias host through — it resolves to the same business", () => {
    expect(mcpHostAllowsBusiness(resolved(BIZ_A, true), BIZ_A)).toBe(true);
  });

  it("refuses a token presented on another business's host", () => {
    expect(mcpHostAllowsBusiness(resolved(BIZ_B), BIZ_A)).toBe(false);
  });

  it("refuses every host that names no usable business", () => {
    for (const reason of ["unknown_host", "not_a_business_host", "suspended"] as const) {
      expect(mcpHostAllowsBusiness({ ok: false, reason }, BIZ_A)).toBe(false);
    }
  });

  it("allows the ambiguous single-origin shape, where the token IS the tenant selector", () => {
    // No host routing and more than one business: no host comparison is
    // possible, and forcing one would make a desktop multi-business install
    // unconnectable. The token still names the business by itself.
    expect(mcpHostAllowsBusiness({ ok: false, reason: "ambiguous" }, BIZ_A)).toBe(true);
    expect(mcpHostAllowsBusiness({ ok: false, reason: "ambiguous" }, BIZ_B)).toBe(true);
  });
});

describe("labelledBusinessHost — the routing-off fallback", () => {
  it("reads a business label under the root, the shape OAuth needs with SUBDOMAIN_ROUTING=off", () => {
    expect(labelledBusinessHost("titea.app.eshobe.com", "app.eshobe.com")).toBe("titea");
    expect(labelledBusinessHost("TITEA.app.eshobe.com:443", "app.eshobe.com")).toBe("titea");
  });

  it("names no business for the apex, the console, a foreign host or a missing root", () => {
    expect(labelledBusinessHost("app.eshobe.com", "app.eshobe.com")).toBeNull();
    expect(labelledBusinessHost("admin.app.eshobe.com", "app.eshobe.com")).toBeNull();
    expect(labelledBusinessHost("titea.example.com", "app.eshobe.com")).toBeNull();
    expect(labelledBusinessHost("titea.app.eshobe.com", "")).toBeNull();
  });
});

describe("mcpTenantErrorDescription", () => {
  it("never leaks the internal resolution code", () => {
    for (const reason of ["unknown_host", "not_a_business_host", "suspended", "ambiguous"] as const) {
      const text = mcpTenantErrorDescription(reason);
      expect(text).not.toContain(reason);
      expect(text).not.toContain("unknown resource host");
    }
  });
});

describe("mcpIssuer", () => {
  afterEach(() => vi.unstubAllEnvs());

  function headers(values: Record<string, string>) {
    return new Headers(values);
  }

  it("advertises https for a public host in production even when the proxy declared http", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(mcpIssuer(headers({ host: "titea.app.example.com", "x-forwarded-proto": "http" }), "http:")).toBe(
      "https://titea.app.example.com",
    );
  });

  it("advertises https for a public host in production when no proto was forwarded at all", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(mcpIssuer(headers({ host: "titea.app.example.com" }), "http:")).toBe("https://titea.app.example.com");
  });

  it("keeps the request's own scheme for loopback, LAN and container hosts", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(mcpIssuer(headers({ host: "localhost:3000" }), "http:")).toBe("http://localhost:3000");
    expect(mcpIssuer(headers({ host: "192.168.1.20:3000" }), "http:")).toBe("http://192.168.1.20:3000");
    expect(mcpIssuer(headers({ host: "web-1234.internal:3000" }), "http:")).toBe("http://web-1234.internal:3000");
  });

  it("keeps the declared scheme outside production", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(mcpIssuer(headers({ host: "titea.localtest.me:3000" }), "http:")).toBe("http://titea.localtest.me:3000");
  });

  it("answers an empty issuer when the request names no host", () => {
    expect(mcpIssuer(headers({}), "https:")).toBe("");
  });
});
