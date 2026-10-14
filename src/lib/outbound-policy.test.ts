import { describe, expect, it, vi } from "vitest";
import {
  addressAllowed,
  authorizeResolvedTarget,
  classifyAddress,
  evaluateOutboundUrl,
  fetchWithOutboundPolicy,
  isBlockedTargetError,
} from "./outbound-policy";

/**
 * Issue #807 — the SSRF policy for peer and direct-URL restore.
 *
 * Everything here is the difference between "a URL is syntactically valid" and
 * "this server is allowed to make a request to it": metadata, link-local and
 * redirects were the audit's concrete findings, so they are pinned by name.
 */
describe("address classification", () => {
  it("separates the ranges the policy treats differently", () => {
    expect(classifyAddress("169.254.169.254")).toBe("metadata");
    expect(classifyAddress("fd00:ec2::254")).toBe("metadata");
    expect(classifyAddress("127.0.0.1")).toBe("loopback");
    expect(classifyAddress("::1")).toBe("loopback");
    expect(classifyAddress("10.1.2.3")).toBe("private");
    expect(classifyAddress("172.16.5.4")).toBe("private");
    expect(classifyAddress("192.168.0.9")).toBe("private");
    expect(classifyAddress("100.64.0.1")).toBe("private");
    expect(classifyAddress("169.254.1.1")).toBe("link-local");
    expect(classifyAddress("fe80::1")).toBe("link-local");
    expect(classifyAddress("0.0.0.0")).toBe("unspecified");
    expect(classifyAddress("8.8.8.8")).toBe("public");
    expect(classifyAddress("not-an-ip")).toBe("reserved");
  });

  it("never admits metadata, link-local, multicast or unspecified — even opted in", () => {
    const permissive = { allowInsecure: true, allowPrivateNetwork: true, allowLoopback: true };
    for (const kind of ["metadata", "link-local", "multicast", "unspecified", "reserved"] as const) {
      expect(addressAllowed(kind, permissive)).toBe(false);
    }
    expect(addressAllowed("private", permissive)).toBe(true);
    expect(addressAllowed("private", {})).toBe(false);
    expect(addressAllowed("loopback", { allowPrivateNetwork: true })).toBe(true);
  });
});

describe("evaluateOutboundUrl", () => {
  it("requires https unless the operator allowed insecure peers", () => {
    const blocked = evaluateOutboundUrl("http://peer.example.com/backup.dump");
    expect(blocked.ok).toBe(false);
    expect(blocked.ok ? "" : blocked.error).toBe("https_required");
    const allowed = evaluateOutboundUrl("http://peer.example.com/backup.dump", {
      allowInsecure: true,
    });
    expect(allowed.ok).toBe(true);
  });

  it("refuses credentials in the URL, fragments and non-http schemes", () => {
    expect(evaluateOutboundUrl("https://user:pw@peer.example.com/x")).toEqual({
      ok: false,
      error: "credentials_in_url",
    });
    expect(evaluateOutboundUrl("ftp://peer.example.com/x").ok).toBe(false);
    expect(evaluateOutboundUrl("https://peer.example.com/x#frag").ok).toBe(false);
    expect(evaluateOutboundUrl("   ").ok).toBe(false);
  });

  it("blocks a literal metadata/loopback/private host before any DNS work", () => {
    expect(evaluateOutboundUrl("http://169.254.169.254/latest/meta-data/", { allowInsecure: true })).toEqual({
      ok: false,
      error: "blocked_address:metadata",
    });
    expect(evaluateOutboundUrl("https://127.0.0.1:5432/")).toEqual({
      ok: false,
      error: "blocked_address:loopback",
    });
    expect(evaluateOutboundUrl("https://192.168.1.10/dump")).toEqual({
      ok: false,
      error: "blocked_address:private",
    });
    // …and the private one is admitted only under the explicit switch.
    expect(evaluateOutboundUrl("https://192.168.1.10/dump", { allowPrivateNetwork: true }).ok).toBe(true);
  });

  it("treats local names as private unless the LAN switch is on", () => {
    expect(evaluateOutboundUrl("http://localhost:3000/x", { allowInsecure: true })).toEqual({
      ok: false,
      error: "blocked_address:private",
    });
  });
});

describe("authorizeResolvedTarget", () => {
  it("refuses a hostname if *any* answer is inadmissible", async () => {
    // The DNS-rebinding shape: a public answer plus a private one.
    const resolver = vi.fn(async () => ["93.184.216.34", "127.0.0.1"]);
    const result = await authorizeResolvedTarget("https://peer.example.com/x", {}, resolver);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toBe("blocked_address:loopback");
  });

  it("admits a hostname whose answers are all public", async () => {
    const resolver = vi.fn(async () => ["93.184.216.34", "2606:2800::1"]);
    const result = await authorizeResolvedTarget("https://peer.example.com/x", {}, resolver);
    expect(result.ok).toBe(true);
    expect(result.ok ? result.addresses : []).toEqual(["93.184.216.34", "2606:2800::1"]);
  });

  it("reports a resolution failure rather than falling through to fetch", async () => {
    const resolver = vi.fn(async () => {
      throw new Error("ENOTFOUND");
    });
    const result = await authorizeResolvedTarget("https://nope.example.com/x", {}, resolver);
    expect(result).toEqual({ ok: false, error: "dns_resolution_failed" });
  });
});

describe("fetchWithOutboundPolicy", () => {
  const ok = (body = "data", headers: Record<string, string> = {}) =>
    new Response(body, { status: 200, headers });
  /** A resolver that maps every test hostname to a public address. */
  const publicResolver = async () => ["93.184.216.34"];

  it("never forwards the peer token to a different origin after a redirect", async () => {
    const seen: { url: string; authorization: string | null }[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      if (seen.length === 1) {
        return new Response(null, { status: 302, headers: { location: "https://elsewhere.example.com/x" } });
      }
      return ok();
    }) as unknown as typeof fetch;

    const result = await fetchWithOutboundPolicy(
      "https://peer.example.com/x",
      { headers: { authorization: "Bearer POS1-secret" } },
      {},
      fetcher,
      publicResolver,
    );
    expect("response" in result).toBe(true);
    expect(seen).toHaveLength(2);
    expect(seen[0].authorization).toBe("Bearer POS1-secret");
    expect(seen[1].authorization).toBeNull();
  });

  it("re-validates each redirect hop and refuses a blocked target", async () => {
    const fetcher = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: "https://169.254.169.254/x" } }),
    ) as unknown as typeof fetch;
    const result = await fetchWithOutboundPolicy("https://peer.example.com/x", {}, {}, fetcher, publicResolver);
    expect("error" in result).toBe(true);
    expect("error" in result ? result.error : "").toBe("redirect_blocked_address:metadata");
  });

  it("caps the redirect chain", async () => {
    const fetcher = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: "https://peer.example.com/again" } }),
    ) as unknown as typeof fetch;
    const result = await fetchWithOutboundPolicy("https://peer.example.com/x", {}, {}, fetcher, publicResolver);
    expect("error" in result ? result.error : "").toBe("too_many_redirects");
  });

  it("maps a transport failure to a bounded unreachable error", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const result = await fetchWithOutboundPolicy("https://peer.example.com/x", {}, {}, fetcher, publicResolver);
    expect("error" in result ? result.error : "").toMatch(/^unreachable:ECONNREFUSED/);
  });

  it("recognises its own refusal codes", () => {
    expect(isBlockedTargetError("blocked_address:metadata")).toBe(true);
    expect(isBlockedTargetError("redirect_blocked_address:private")).toBe(true);
    expect(isBlockedTargetError("https_required")).toBe(false);
  });
});
