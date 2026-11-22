import { describe, expect, it } from "vitest";

import {
  assertOutboundTarget,
  checkOutboundUrl,
  isLoopbackHostname,
  isReservedAddress,
  outboundPolicyFromEnv,
  parseAllowedHosts,
  type OutboundTargetPolicy,
} from "./guard";

const policy = (allowed: string[], allowLoopbackHttp = false): OutboundTargetPolicy => ({
  allowedHosts: new Set(allowed),
  allowLoopbackHttp,
});

describe("parseAllowedHosts", () => {
  it("accepts hosts and host:port, trimmed and lower-cased", () => {
    expect([...parseAllowedHosts(" CMS.Example.com , localhost:4010 ")]).toEqual([
      "cms.example.com",
      "localhost:4010",
    ]);
  });

  it("ignores entries that carry a scheme, path or wildcard", () => {
    // A malformed option must fail closed rather than be interpreted generously.
    expect([...parseAllowedHosts("https://a.example, b.example/x, *.c.example, ok.example")]).toEqual([
      "ok.example",
    ]);
  });

  it("is empty for unset or blank input", () => {
    expect(parseAllowedHosts(undefined).size).toBe(0);
    expect(parseAllowedHosts("   ").size).toBe(0);
  });
});

describe("isReservedAddress", () => {
  it.each([
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "127.0.0.1",
    "0.0.0.0",
    "169.254.169.254",
    "100.64.0.1",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fe80::1",
    "fd00::1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    "not-an-address",
  ])("refuses %s", (address) => {
    expect(isReservedAddress(address)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "172.15.0.1", "2606:4700:4700::1111"])(
    "allows the public address %s",
    (address) => {
      expect(isReservedAddress(address)).toBe(false);
    },
  );
});

describe("checkOutboundUrl", () => {
  const allow = policy(["cms.example.com", "localhost:4010"]);

  it("accepts an allowlisted https endpoint", () => {
    const result = checkOutboundUrl("https://cms.example.com/api/mcp", allow);
    expect(result.ok).toBe(true);
  });

  it("refuses a host that is not allowlisted", () => {
    expect(checkOutboundUrl("https://evil.example.com/mcp", allow)).toEqual({
      ok: false,
      reason: "host_not_allowed",
    });
  });

  it("refuses plain http on a network host", () => {
    expect(checkOutboundUrl("http://cms.example.com/mcp", allow)).toEqual({
      ok: false,
      reason: "scheme_not_allowed",
    });
  });

  it("allows http on an explicitly allowlisted loopback entry in development", () => {
    const dev = policy(["localhost:4010"], true);
    expect(checkOutboundUrl("http://localhost:4010/mcp", dev).ok).toBe(true);
    // …and only when the flag is on.
    expect(checkOutboundUrl("http://localhost:4010/mcp", policy(["localhost:4010"]))).toEqual({
      ok: false,
      reason: "scheme_not_allowed",
    });
  });

  it("refuses a literal address even when it would resolve to the same place", () => {
    expect(checkOutboundUrl("https://127.0.0.1/mcp", policy(["127.0.0.1"]))).toEqual({
      ok: false,
      reason: "ip_literal",
    });
    expect(checkOutboundUrl("https://[::1]/mcp", policy(["::1"]))).toEqual({
      ok: false,
      reason: "ip_literal",
    });
  });

  it("refuses credentials embedded in the URL", () => {
    expect(checkOutboundUrl("https://user:secret@cms.example.com/mcp", allow)).toEqual({
      ok: false,
      reason: "credentials_in_url",
    });
  });

  it("refuses internal-only suffixes", () => {
    expect(
      checkOutboundUrl("https://metadata.internal/mcp", policy(["metadata.internal"])),
    ).toEqual({ ok: false, reason: "reserved_hostname" });
    expect(checkOutboundUrl("https://printer.local/mcp", policy(["printer.local"]))).toEqual({
      ok: false,
      reason: "reserved_hostname",
    });
  });

  it("refuses a port the allowlist entry did not name", () => {
    expect(checkOutboundUrl("https://cms.example.com:8443/mcp", allow)).toEqual({
      ok: false,
      reason: "host_not_allowed",
    });
    expect(checkOutboundUrl("https://localhost:9999/mcp", allow)).toEqual({
      ok: false,
      reason: "host_not_allowed",
    });
  });

  it("refuses a fragment and a malformed or oversized value", () => {
    expect(checkOutboundUrl("https://cms.example.com/mcp#x", allow)).toEqual({
      ok: false,
      reason: "fragment_not_allowed",
    });
    expect(checkOutboundUrl("not a url", allow)).toEqual({ ok: false, reason: "invalid_url" });
    expect(checkOutboundUrl(`https://cms.example.com/${"a".repeat(2100)}`, allow)).toEqual({
      ok: false,
      reason: "invalid_url",
    });
  });

  it("allows the default https port spelled out", () => {
    expect(checkOutboundUrl("https://cms.example.com:443/api/mcp", allow).ok).toBe(true);
  });
});

describe("isLoopbackHostname", () => {
  it.each(["localhost", "LOCALHOST", "app.localhost", "127.0.0.1", "::1", "[::1]"])(
    "recognises %s",
    (host) => {
      expect(isLoopbackHostname(host)).toBe(true);
    },
  );

  it("does not treat a public name as loopback", () => {
    expect(isLoopbackHostname("cms.example.com")).toBe(false);
  });
});

describe("assertOutboundTarget", () => {
  const allow = policy(["cms.example.com"]);

  it("refuses when any resolved address is private", async () => {
    // A hostile name often answers with one public and one private record; checking
    // only the first would connect to whichever the resolver returned first.
    const result = await assertOutboundTarget("https://cms.example.com/api/mcp", allow, async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ]);

    expect(result).toEqual({ ok: false, reason: "resolves_to_private_address" });
  });

  it("accepts a name that resolves only to public addresses", async () => {
    const result = await assertOutboundTarget("https://cms.example.com/api/mcp", allow, async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]);

    expect(result.ok).toBe(true);
  });

  it("refuses when resolution fails or returns nothing", async () => {
    const failing = async () => {
      throw new Error("ENOTFOUND");
    };
    expect(await assertOutboundTarget("https://cms.example.com/api/mcp", allow, failing)).toEqual({
      ok: false,
      reason: "dns_failed",
    });

    expect(
      await assertOutboundTarget("https://cms.example.com/api/mcp", allow, async () => []),
    ).toEqual({ ok: false, reason: "dns_failed" });
  });

  it("does not resolve at all when the URL is already refused", async () => {
    let called = false;
    const result = await assertOutboundTarget("https://evil.example.com/mcp", allow, async () => {
      called = true;
      return [];
    });

    expect(result).toEqual({ ok: false, reason: "host_not_allowed" });
    expect(called).toBe(false);
  });
});

describe("outboundPolicyFromEnv", () => {
  it("reads the allowlist and the loopback flag", () => {
    const policyFromEnv = outboundPolicyFromEnv({
      MCP_OUTBOUND_ALLOWED_HOSTS: "cms.example.com,localhost:4010",
      MCP_OUTBOUND_ALLOW_LOOPBACK_HTTP: "true",
    });

    expect([...policyFromEnv.allowedHosts]).toEqual(["cms.example.com", "localhost:4010"]);
    expect(policyFromEnv.allowLoopbackHttp).toBe(true);
  });

  it("defaults to refusing everything", () => {
    const policyFromEnv = outboundPolicyFromEnv({});
    expect(policyFromEnv.allowedHosts.size).toBe(0);
    expect(policyFromEnv.allowLoopbackHttp).toBe(false);
  });
});
