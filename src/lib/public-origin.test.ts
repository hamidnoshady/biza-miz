import { describe, expect, it } from "vitest";
import {
  classifyHostname,
  parsePublicOrigin,
  resolveHandoffOrigin,
  splitHostPort,
  type HandoffOriginContext,
} from "./public-origin";

const ROOT = "pos.eshobe.com";

/**
 * The canonical context for the two deployment shapes the policy serves.
 * Everything else in a case is a deliberate deviation from one of these.
 */
function cloudCtx(overrides: Partial<HandoffOriginContext> = {}): HandoffOriginContext {
  return {
    env: { ROOT_DOMAIN: ROOT },
    allowLocal: false,
    hostHeader: `admin.${ROOT}`,
    forwardedHost: null,
    forwardedProto: "https",
    requestProtocol: "http:",
    tenantSubdomain: "acme",
    ...overrides,
  };
}

function singleHostCtx(overrides: Partial<HandoffOriginContext> = {}): HandoffOriginContext {
  return {
    env: {},
    allowLocal: false,
    hostHeader: "panel.example.com",
    forwardedHost: null,
    forwardedProto: "https",
    requestProtocol: "http:",
    tenantSubdomain: null,
    ...overrides,
  };
}

describe("classifyHostname — what a browser outside the container can open", () => {
  it("treats loopback names and addresses as loopback", () => {
    expect(classifyHostname("localhost")).toBe("loopback");
    expect(classifyHostname("LOCALHOST")).toBe("loopback");
    expect(classifyHostname("app.localhost")).toBe("loopback");
    expect(classifyHostname("127.0.0.1")).toBe("loopback");
    expect(classifyHostname("127.200.30.40")).toBe("loopback");
    expect(classifyHostname("::1")).toBe("loopback");
    expect(classifyHostname("0:0:0:0:0:0:0:1")).toBe("loopback");
  });

  it("treats private and link-local addresses as private", () => {
    expect(classifyHostname("10.0.0.5")).toBe("private");
    expect(classifyHostname("172.16.0.1")).toBe("private");
    expect(classifyHostname("172.31.255.255")).toBe("private");
    expect(classifyHostname("192.168.1.20")).toBe("private");
    expect(classifyHostname("169.254.10.10")).toBe("private");
    expect(classifyHostname("fd12:3456::1")).toBe("private");
    expect(classifyHostname("fe80::1")).toBe("private");
  });

  it("treats container-internal names as internal", () => {
    expect(classifyHostname("web")).toBe("internal");
    expect(classifyHostname("api-1")).toBe("internal");
    expect(classifyHostname("web-1234.internal")).toBe("internal");
    expect(classifyHostname("host.docker.internal")).toBe("internal");
    expect(classifyHostname("printer.local")).toBe("internal");
    expect(classifyHostname("svc.cluster.local")).toBe("internal");
    expect(classifyHostname("box.localdomain")).toBe("internal");
    expect(classifyHostname("0.0.0.0")).toBe("internal");
    expect(classifyHostname("")).toBe("internal");
  });

  it("treats real DNS names — including the loopback-resolving dev root — as public", () => {
    // The distinction is names, not resolution: localtest.me resolves to
    // 127.0.0.1 but a browser can open it, which is exactly why the dev root
    // must not be classified with localhost.
    expect(classifyHostname("localtest.me")).toBe("public");
    expect(classifyHostname("acme.localtest.me")).toBe("public");
    expect(classifyHostname("example.com")).toBe("public");
    expect(classifyHostname("acme.pos.eshobe.com")).toBe("public");
    expect(classifyHostname("203.0.113.10")).toBe("public");
    expect(classifyHostname("example.com.")).toBe("public");
  });
});

describe("splitHostPort", () => {
  it("splits names and IPv4 literals", () => {
    expect(splitHostPort("acme.pos.eshobe.com:3000")).toEqual({ hostname: "acme.pos.eshobe.com", port: "3000" });
    expect(splitHostPort("Acme.LocalTest.me:3000")).toEqual({ hostname: "acme.localtest.me", port: "3000" });
    expect(splitHostPort("acme.pos.eshobe.com")).toEqual({ hostname: "acme.pos.eshobe.com", port: "" });
    expect(splitHostPort("127.0.0.1:3000")).toEqual({ hostname: "127.0.0.1", port: "3000" });
    expect(splitHostPort("")).toEqual({ hostname: "", port: "" });
  });

  it("splits bracketed IPv6 and leaves bare IPv6 alone", () => {
    expect(splitHostPort("[::1]:3000")).toEqual({ hostname: "::1", port: "3000" });
    expect(splitHostPort("[::1]")).toEqual({ hostname: "::1", port: "" });
    // A bare literal's colons are the address, not a port separator.
    expect(splitHostPort("::1")).toEqual({ hostname: "::1", port: "" });
  });
});

describe("parsePublicOrigin", () => {
  it("accepts a bare http(s) origin and normalises it", () => {
    expect(parsePublicOrigin("https://panel.example.com")).toEqual({
      scheme: "https",
      hostname: "panel.example.com",
      port: "",
      origin: "https://panel.example.com",
    });
    expect(parsePublicOrigin("https://panel.example.com/")).toEqual({
      scheme: "https",
      hostname: "panel.example.com",
      port: "",
      origin: "https://panel.example.com",
    });
    expect(parsePublicOrigin("http://localhost:3000")?.origin).toBe("http://localhost:3000");
    // Default ports are dropped by URL.origin, which is what the browser shows.
    expect(parsePublicOrigin("https://panel.example.com:443")?.origin).toBe("https://panel.example.com");
  });

  it("refuses anything that is not exactly an origin", () => {
    expect(parsePublicOrigin("")).toBeNull();
    expect(parsePublicOrigin("panel.example.com")).toBeNull();
    expect(parsePublicOrigin("https://panel.example.com/app")).toBeNull();
    expect(parsePublicOrigin("https://panel.example.com?x=1")).toBeNull();
    expect(parsePublicOrigin("https://panel.example.com#frag")).toBeNull();
    expect(parsePublicOrigin("https://user:pass@panel.example.com")).toBeNull();
    expect(parsePublicOrigin("ftp://panel.example.com")).toBeNull();
    expect(parsePublicOrigin("javascript:alert(1)")).toBeNull();
    expect(parsePublicOrigin("https://")).toBeNull();
  });
});

describe("resolveHandoffOrigin — host tenancy on (Cloud)", () => {
  it("builds the company's own tenant origin under the configured root", () => {
    const result = resolveHandoffOrigin(cloudCtx());
    expect(result).toEqual({ ok: true, origin: `https://acme.${ROOT}` });
  });

  it("keeps a non-default external port and drops the scheme default", () => {
    expect(resolveHandoffOrigin(cloudCtx({ hostHeader: `admin.${ROOT}:8443` }))).toEqual({
      ok: true,
      origin: `https://acme.${ROOT}:8443`,
    });
    expect(resolveHandoffOrigin(cloudCtx({ hostHeader: `admin.${ROOT}:443` }))).toEqual({
      ok: true,
      origin: `https://acme.${ROOT}`,
    });
  });

  it("works against the dev root that resolves to loopback", () => {
    const result = resolveHandoffOrigin(
      cloudCtx({
        env: { ROOT_DOMAIN: "localtest.me" },
        hostHeader: "admin.localtest.me:3000",
        forwardedProto: "http",
        allowLocal: true,
      }),
    );
    expect(result).toEqual({ ok: true, origin: "http://acme.localtest.me:3000" });
  });

  it("resolves an internal request host with a public X-Forwarded-Host when the proxy contract declares it trusted", () => {
    // The managed-edge shape: Host is the container's internal name, the
    // browser's hostname rides in X-Forwarded-Host. request.url here is
    // http://web-1234.internal:3000 — the #1062 trap — and must play no part.
    const result = resolveHandoffOrigin(
      cloudCtx({
        hostHeader: "web-1234.internal:3000",
        forwardedHost: `admin.${ROOT}`,
        env: { ROOT_DOMAIN: ROOT, TRUST_FORWARDED_HOST: "on" },
      }),
    );
    expect(result).toEqual({ ok: true, origin: `https://acme.${ROOT}` });
  });

  it("fails closed when the forwarded host would decide but is untrusted", () => {
    const result = resolveHandoffOrigin(
      cloudCtx({
        hostHeader: "web-1234.internal:3000",
        forwardedHost: `admin.${ROOT}`,
        env: { ROOT_DOMAIN: ROOT },
      }),
    );
    expect(result).toEqual({ ok: false, code: "forwarded_host_untrusted" });
  });

  it("fails closed on a plain internal host with no forwarded host at all", () => {
    const result = resolveHandoffOrigin(
      cloudCtx({ hostHeader: "localhost:3000", env: { ROOT_DOMAIN: ROOT } }),
    );
    expect(result).toEqual({ ok: false, code: "request_host_internal" });
  });

  it("ignores a spoofed X-Forwarded-Host when trust is off, and uses the Host header", () => {
    const result = resolveHandoffOrigin(
      cloudCtx({
        hostHeader: `admin.${ROOT}`,
        forwardedHost: "evil.example",
        env: { ROOT_DOMAIN: ROOT },
      }),
    );
    expect(result).toEqual({ ok: true, origin: `https://acme.${ROOT}` });
  });

  it("takes the first hop of an appended X-Forwarded-Host", () => {
    const result = resolveHandoffOrigin(
      cloudCtx({
        hostHeader: "web.internal:3000",
        forwardedHost: `admin.${ROOT}, proxy.internal`,
        env: { ROOT_DOMAIN: ROOT, TRUST_FORWARDED_HOST: "on" },
      }),
    );
    expect(result).toEqual({ ok: true, origin: `https://acme.${ROOT}` });
  });

  it("fails closed on a forwarded proto that is not a scheme", () => {
    const result = resolveHandoffOrigin(cloudCtx({ forwardedProto: "javascript" }));
    expect(result).toEqual({ ok: false, code: "forwarded_proto_invalid" });
    expect(resolveHandoffOrigin(cloudCtx({ forwardedProto: "gopher, https" }))).toEqual({
      ok: false,
      code: "forwarded_proto_invalid",
    });
  });

  it("fails closed when production traffic resolves to plain http (TLS proxy forgot X-Forwarded-Proto)", () => {
    // requestProtocol is the container's own http; without the forwarded
    // scheme there is no proof the browser spoke https, and a production
    // central deployment must not emit a mixed-scheme redirect.
    const result = resolveHandoffOrigin(cloudCtx({ forwardedProto: null }));
    expect(result).toEqual({ ok: false, code: "origin_insecure" });
  });

  it("accepts an explicit https request scheme when nothing forwarded it", () => {
    const result = resolveHandoffOrigin(
      cloudCtx({ forwardedProto: null, requestProtocol: "https:" }),
    );
    expect(result).toEqual({ ok: true, origin: `https://acme.${ROOT}` });
  });

  it("refuses an unknown or malformed root domain", () => {
    expect(resolveHandoffOrigin(cloudCtx({ env: {} }))).toEqual({
      ok: false,
      code: "root_domain_missing",
    });
    expect(resolveHandoffOrigin(cloudCtx({ env: { ROOT_DOMAIN: "https://pos.eshobe.com" } }))).toEqual({
      ok: false,
      code: "root_domain_invalid",
    });
    expect(resolveHandoffOrigin(cloudCtx({ env: { ROOT_DOMAIN: "pos.eshobe.com:3000" } }))).toEqual({
      ok: false,
      code: "root_domain_invalid",
    });
    expect(resolveHandoffOrigin(cloudCtx({ env: { ROOT_DOMAIN: "localdomain" } }))).toEqual({
      ok: false,
      code: "root_domain_invalid",
    });
    expect(resolveHandoffOrigin(cloudCtx({ env: { ROOT_DOMAIN: "web.internal" } }))).toEqual({
      ok: false,
      code: "root_domain_internal",
    });
  });

  it("refuses a malformed subdomain", () => {
    for (const label of ["", "a", "-acme", "acme-", "ac_me", "AC ME", "a".repeat(64), "admin"]) {
      expect(
        resolveHandoffOrigin(cloudCtx({ tenantSubdomain: label })),
        `label ${JSON.stringify(label)}`,
      ).toEqual({ ok: false, code: "subdomain_invalid" });
    }
  });

  it("refuses a request host outside the root when host tenancy is on", () => {
    const result = resolveHandoffOrigin(cloudCtx({ hostHeader: "panel.other-example.com" }));
    expect(result).toEqual({ ok: false, code: "request_host_outside_root" });
    // Suffix-shaped but not a subdomain: must not slip through.
    expect(
      resolveHandoffOrigin(cloudCtx({ hostHeader: `evil${ROOT}` })),
    ).toEqual({ ok: false, code: "request_host_outside_root" });
  });

  it("refuses a missing request host", () => {
    const result = resolveHandoffOrigin(cloudCtx({ hostHeader: "", forwardedProto: "https" }));
    expect(result).toEqual({ ok: false, code: "request_host_missing" });
  });
});

describe("resolveHandoffOrigin — single-host deployments (host routing off)", () => {
  it("returns the browser-facing origin of the request itself — never request.url's internal one", () => {
    // The #1062 regression: request.url said http://localhost:3000 while the
    // browser was on https://panel.example.com. The policy derives the
    // destination from the validated Host header, so the loopback origin is
    // unreachable by construction.
    const result = resolveHandoffOrigin(singleHostCtx());
    expect(result).toEqual({ ok: true, origin: "https://panel.example.com" });
  });

  it("keeps a browser-typed external port", () => {
    expect(resolveHandoffOrigin(singleHostCtx({ hostHeader: "panel.example.com:8443" }))).toEqual({
      ok: true,
      origin: "https://panel.example.com:8443",
    });
  });

  it("uses a trusted X-Forwarded-Host when the proxy rewrites Host", () => {
    const result = resolveHandoffOrigin(
      singleHostCtx({
        hostHeader: "web-1234.internal:3000",
        forwardedHost: "panel.example.com",
        env: { TRUST_FORWARDED_HOST: "on" },
      }),
    );
    expect(result).toEqual({ ok: true, origin: "https://panel.example.com" });
  });

  it("fails closed — with the actionable code — when the proxy rewrites Host but trust is off", () => {
    // The exact P0 deployment shape: Host is localhost:3000, the browser's
    // name is in X-Forwarded-Host, and nobody declared that header trusted.
    // The fix is operator configuration (TRUST_FORWARDED_HOST=on or
    // PUBLIC_ORIGIN), not a credential minted for a loopback destination.
    const result = resolveHandoffOrigin(
      singleHostCtx({
        hostHeader: "localhost:3000",
        forwardedHost: "panel.example.com",
        env: {},
      }),
    );
    expect(result).toEqual({ ok: false, code: "forwarded_host_untrusted" });
  });

  it("refuses loopback and internal hosts in production central", () => {
    for (const host of ["localhost:3000", "127.0.0.1:3000", "web-1234.internal:3000", "10.0.0.5:3000"]) {
      expect(
        resolveHandoffOrigin(singleHostCtx({ hostHeader: host })),
        host,
      ).toEqual({ ok: false, code: "request_host_internal" });
    }
  });

  it("keeps localhost for explicitly local scenarios — the desktop site and development", () => {
    for (const allowLocal of [true]) {
      const result = resolveHandoffOrigin(
        singleHostCtx({
          allowLocal,
          hostHeader: "localhost:3000",
          forwardedProto: "http",
          requestProtocol: "http:",
        }),
      );
      expect(result).toEqual({ ok: true, origin: "http://localhost:3000" });
    }
  });

  it("fails closed on plain-http production traffic", () => {
    const result = resolveHandoffOrigin(singleHostCtx({ forwardedProto: null }));
    expect(result).toEqual({ ok: false, code: "origin_insecure" });
  });
});

describe("resolveHandoffOrigin — PUBLIC_ORIGIN pins the browser-facing origin", () => {
  it("overrides broken request headers in single-host mode", () => {
    // One env var turns the #1062 deployment green: the pin is the
    // destination regardless of what the container thinks its own name is.
    const result = resolveHandoffOrigin(
      singleHostCtx({
        hostHeader: "localhost:3000",
        forwardedHost: null,
        env: { PUBLIC_ORIGIN: "https://panel.example.com" },
      }),
    );
    expect(result).toEqual({ ok: true, origin: "https://panel.example.com" });
  });

  it("pins scheme and port for tenant origins too, while the host stays the company's own", () => {
    const result = resolveHandoffOrigin(
      cloudCtx({
        hostHeader: "web.internal:3000",
        forwardedHost: null,
        env: { ROOT_DOMAIN: ROOT, PUBLIC_ORIGIN: `https://admin.${ROOT}:8443` },
      }),
    );
    expect(result).toEqual({ ok: true, origin: `https://acme.${ROOT}:8443` });
  });

  it("refuses a pin that does not name this deployment's root zone", () => {
    const result = resolveHandoffOrigin(
      cloudCtx({
        env: { ROOT_DOMAIN: ROOT, PUBLIC_ORIGIN: "https://someone-else.example.com" },
      }),
    );
    expect(result).toEqual({ ok: false, code: "public_origin_invalid" });
  });

  it("refuses malformed, insecure or internal pins in production", () => {
    expect(
      resolveHandoffOrigin(singleHostCtx({ env: { PUBLIC_ORIGIN: "panel.example.com" } })),
    ).toEqual({ ok: false, code: "public_origin_invalid" });
    expect(
      resolveHandoffOrigin(singleHostCtx({ env: { PUBLIC_ORIGIN: "https://panel.example.com/app" } })),
    ).toEqual({ ok: false, code: "public_origin_invalid" });
    expect(
      resolveHandoffOrigin(singleHostCtx({ env: { PUBLIC_ORIGIN: "http://panel.example.com" } })),
    ).toEqual({ ok: false, code: "public_origin_insecure" });
    expect(
      resolveHandoffOrigin(singleHostCtx({ env: { PUBLIC_ORIGIN: "https://localhost:3000" } })),
    ).toEqual({ ok: false, code: "public_origin_internal" });
  });

  it("allows local pins in explicitly local scenarios", () => {
    const result = resolveHandoffOrigin(
      singleHostCtx({
        allowLocal: true,
        env: { PUBLIC_ORIGIN: "http://localhost:3000" },
      }),
    );
    expect(result).toEqual({ ok: true, origin: "http://localhost:3000" });
  });
});
