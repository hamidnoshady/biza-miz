/**
 * Issue #883 P1-6 — the host/token binding policy. `resolveMcpTenant`'s
 * database side is covered by the connector integration suite; the *decision*
 * — which resolutions may serve which business — is pure and pinned here.
 */
import { describe, expect, it } from "vitest";
import { mcpHostAllowsBusiness, type McpTenantResolution } from "./origin";

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
