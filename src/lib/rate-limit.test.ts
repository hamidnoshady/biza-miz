import { describe, it, expect, afterEach } from "vitest";
import { PEER_ADDRESS_HEADER, clientIpFrom, internalBaseOrigin, normalizePeerAddress } from "./rate-limit";

describe("internalBaseOrigin", () => {
  const savedPort = process.env.PORT;
  const savedInternal = process.env.INTERNAL_BASE_URL;

  afterEach(() => {
    if (savedPort === undefined) delete process.env.PORT;
    else process.env.PORT = savedPort;
    if (savedInternal === undefined) delete process.env.INTERNAL_BASE_URL;
    else process.env.INTERNAL_BASE_URL = savedInternal;
  });

  it("defaults to this process's loopback listener, not the request's public origin", () => {
    // Aimed at the public origin behind a TLS-terminating proxy, the call
    // died with "fetch failed" (no NAT hairpin / local DNS for the public
    // hostname) and the durable counter silently fell back per-process.
    expect(internalBaseOrigin({})).toBe("http://127.0.0.1:3000");
  });

  it("tracks PORT", () => {
    expect(internalBaseOrigin({ PORT: "8080" })).toBe("http://127.0.0.1:8080");
    // Garbage PORT falls back to 3000 rather than producing a bad URL.
    expect(internalBaseOrigin({ PORT: "not-a-port" })).toBe("http://127.0.0.1:3000");
  });

  it("lets INTERNAL_BASE_URL override for split-tier deploys", () => {
    expect(
      internalBaseOrigin({ INTERNAL_BASE_URL: "http://internal-runtime:3100" }),
    ).toBe("http://internal-runtime:3100");
  });

  it("trims whitespace and strips trailing slashes so the path join never doubles up", () => {
    expect(
      internalBaseOrigin({ INTERNAL_BASE_URL: "  http://127.0.0.1:3000///  " }),
    ).toBe("http://127.0.0.1:3000");
  });

  it("ignores a whitespace-only INTERNAL_BASE_URL", () => {
    expect(internalBaseOrigin({ INTERNAL_BASE_URL: "   " })).toBe(
      "http://127.0.0.1:3000",
    );
  });
});

describe("rate-limit clientIpFrom", () => {
  it("resolves IP using trusted hops when > 0", () => {
    const headers = new Headers();
    headers.set("x-forwarded-for", "1.1.1.1, 2.2.2.2, 3.3.3.3");

    // 1 hop -> our proxy appended 3.3.3.3, naming the peer it saw. That is the
    // client; 1.1.1.1 and 2.2.2.2 are whatever the caller chose to send.
    expect(clientIpFrom(headers, 1)).toBe("3.3.3.3");

    // 2 hops -> we also trust 3.3.3.3, which appended 2.2.2.2.
    expect(clientIpFrom(headers, 2)).toBe("2.2.2.2");

    // > available hops -> clamp to the leftmost entry
    expect(clientIpFrom(headers, 5)).toBe("1.1.1.1");
  });

  it("does not let a forged x-forwarded-for prefix choose the rate-limit key", () => {
    // The attack the hop count exists to stop: the caller sends a header
    // naming somebody else, the trusted proxy appends their real address, and
    // the limiter must bill the real one.
    const headers = new Headers();
    headers.set("x-forwarded-for", "1.2.3.4, 203.0.113.9");
    expect(clientIpFrom(headers, 1)).toBe("203.0.113.9");
  });

  it("resolves IP right-to-left skipping private IPs when trustedHops = 0", () => {
    const headers = new Headers();

    // Public IP, then private proxies
    headers.set("x-forwarded-for", "1.1.1.1, 10.0.0.1, 192.168.1.1");
    expect(clientIpFrom(headers, 0)).toBe("1.1.1.1");

    // Spoofed public IP, real public IP, then private proxies
    headers.set("x-forwarded-for", "8.8.8.8, 1.1.1.1, 10.0.0.1");
    expect(clientIpFrom(headers, 0)).toBe("1.1.1.1");
  });

  it("returns the rightmost IP if all are private when trustedHops = 0", () => {
    const headers = new Headers();
    headers.set("x-forwarded-for", "10.0.0.2, 192.168.1.1");
    expect(clientIpFrom(headers, 0)).toBe("192.168.1.1");
  });

  it("ignores x-real-ip by default, because nothing in front of us sets it", () => {
    // Caddy appends to x-forwarded-for and never touches x-real-ip, so an
    // x-real-ip arriving here came from the client. Believing it hands the
    // caller their own rate-limit key.
    const headers = new Headers();
    headers.set("x-real-ip", "10.0.0.1");
    headers.set("x-forwarded-for", "1.1.1.1, 2.2.2.2");
    expect(clientIpFrom(headers, 1)).toBe("2.2.2.2");
  });

  it("honours x-real-ip only where the operator says the proxy overwrites it", () => {
    const previous = process.env.TRUST_X_REAL_IP;
    process.env.TRUST_X_REAL_IP = "true";
    try {
      const headers = new Headers();
      headers.set("x-real-ip", "10.0.0.1");
      headers.set("x-forwarded-for", "1.1.1.1, 2.2.2.2");
      expect(clientIpFrom(headers, 1)).toBe("10.0.0.1");
    } finally {
      if (previous === undefined) delete process.env.TRUST_X_REAL_IP;
      else process.env.TRUST_X_REAL_IP = previous;
    }
  });

  it("returns unknown if neither is present", () => {
    const headers = new Headers();
    expect(clientIpFrom(headers, 1)).toBe("unknown");
  });

  // Issue #1003 item 6 — with nothing usable forwarded, every such caller used
  // to share the one `unknown` bucket: one person's failed sign-ins locked
  // out everyone else in it. server.ts now stamps the TCP peer it saw.
  it("falls back to the peer server.ts saw when nothing is forwarded", () => {
    const headers = new Headers({ [PEER_ADDRESS_HEADER]: "192.168.1.20" });
    expect(clientIpFrom(headers, 1)).toBe("192.168.1.20");
    expect(clientIpFrom(headers, 0)).toBe("192.168.1.20");
  });

  it("falls back to the peer when the forwarded header is empty, or empty where the hop count points", () => {
    for (const forwarded of ["", " ", ",", "1.2.3.4, "]) {
      const headers = new Headers({ "x-forwarded-for": forwarded, [PEER_ADDRESS_HEADER]: "192.168.1.21" });
      expect(clientIpFrom(headers, 1), JSON.stringify(forwarded)).toBe("192.168.1.21");
    }
  });

  it("never prefers the peer over a usable forwarded address", () => {
    // Behind a proxy the peer is the proxy itself: keying on it would put
    // every client in one bucket again.
    const headers = new Headers({ "x-forwarded-for": "203.0.113.9", [PEER_ADDRESS_HEADER]: "10.0.0.2" });
    expect(clientIpFrom(headers, 1)).toBe("203.0.113.9");
    expect(clientIpFrom(headers, 0)).toBe("203.0.113.9");
  });
});

describe("rate-limit normalizePeerAddress", () => {
  it("keeps IPv4 and IPv6 peers, unwrapping IPv4-mapped IPv6", () => {
    expect(normalizePeerAddress("127.0.0.1")).toBe("127.0.0.1");
    expect(normalizePeerAddress("::ffff:192.168.1.20")).toBe("192.168.1.20");
    expect(normalizePeerAddress("::FFFF:10.0.0.7")).toBe("10.0.0.7");
    expect(normalizePeerAddress("::1")).toBe("::1");
    expect(normalizePeerAddress("2001:db8::1")).toBe("2001:db8::1");
    expect(normalizePeerAddress("fe80::1%eth0")).toBe("fe80::1%eth0");
  });

  it("refuses anything that is not an address", () => {
    for (const value of [undefined, null, "", "  ", "evil.example", "1.2.3.4, 5.6.7.8", "1.2.3.4\r\nx: y"]) {
      expect(normalizePeerAddress(value), JSON.stringify(value)).toBeNull();
    }
  });
});
