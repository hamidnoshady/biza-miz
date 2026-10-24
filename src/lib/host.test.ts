import { describe, expect, it } from "vitest";
import {
  hostDebugEnabled,
  businessHost,
  leadingHostLabel,
  normalizeHost,
  parseHost,
  preferredProto,
  resolveRequestHost,
  subdomainRoutingEnabled,
  swapHostLabel,
  trustForwardedHost,
  websocketOriginAllowed,
} from "./host";

const ROOT = "pos.eshobe.com";

describe("normalizeHost", () => {
  it("drops the port, the trailing dot, and case", () => {
    expect(normalizeHost("Acme.LocalTest.me:3000")).toBe("acme.localtest.me");
    expect(normalizeHost("acme.pos.eshobe.com.")).toBe("acme.pos.eshobe.com");
    expect(normalizeHost("  acme.pos.eshobe.com  ")).toBe("acme.pos.eshobe.com");
  });
});

describe("parseHost", () => {
  it("recognises the apex", () => {
    expect(parseHost(ROOT, ROOT)).toEqual({ kind: "apex", label: "" });
    expect(parseHost(`${ROOT}:3000`, ROOT)).toEqual({ kind: "apex", label: "" });
  });

  it("recognises the console's own host", () => {
    expect(parseHost(`admin.${ROOT}`, ROOT)).toEqual({ kind: "admin", label: "admin" });
  });

  it("recognises a business subdomain and returns its label", () => {
    expect(parseHost(`acme.${ROOT}`, ROOT)).toEqual({ kind: "business", label: "acme" });
    expect(parseHost(`biz-1a2b3c4d.${ROOT}:3000`, ROOT)).toEqual({ kind: "business", label: "biz-1a2b3c4d" });
  });

  it("works against a dev root that resolves to loopback", () => {
    expect(parseHost("acme.localtest.me:3000", "localtest.me")).toEqual({ kind: "business", label: "acme" });
  });

  it("works when the root is itself a subdomain", () => {
    // The deployment lives at ac.eshobe.com and businesses hang off it, so a
    // host is three labels deep and still perfectly ordinary: what parseHost
    // limits is the depth *below* the root, not the root's own.
    const nested = "ac.eshobe.com";
    expect(parseHost(nested, nested)).toEqual({ kind: "apex", label: "" });
    expect(parseHost(`biz1.${nested}`, nested)).toEqual({ kind: "business", label: "biz1" });
    expect(parseHost(`admin.${nested}`, nested)).toEqual({ kind: "admin", label: "admin" });
    // One level deeper still has no wildcard certificate covering it.
    expect(parseHost(`a.biz1.${nested}`, nested)).toEqual({ kind: "unknown", label: "" });
    // The parent zone is not the root, so it addresses no tenant here.
    expect(parseHost("biz1.eshobe.com", nested)).toEqual({ kind: "unknown", label: "" });
  });

  it("refuses a host outside the root domain", () => {
    expect(parseHost("pos.example.com", ROOT)).toEqual({ kind: "unknown", label: "" });
    // Suffix-shaped but not a subdomain: "evilpos.eshobe.com" merely ends with
    // the root's text. Getting this wrong would hand an attacker-controlled
    // host a tenant label.
    expect(parseHost(`evil${ROOT}`, ROOT)).toEqual({ kind: "unknown", label: "" });
  });

  it("refuses a deeper subdomain, which no wildcard certificate covers", () => {
    expect(parseHost(`a.b.${ROOT}`, ROOT)).toEqual({ kind: "unknown", label: "" });
  });

  it("refuses everything when no root domain is configured", () => {
    expect(parseHost(`acme.${ROOT}`, "")).toEqual({ kind: "unknown", label: "" });
    expect(parseHost(`acme.${ROOT}`, undefined)).toEqual({ kind: "unknown", label: "" });
  });

  it("refuses a missing or empty host", () => {
    expect(parseHost(null, ROOT)).toEqual({ kind: "unknown", label: "" });
    expect(parseHost("", ROOT)).toEqual({ kind: "unknown", label: "" });
  });

  it("tolerates a root domain written with stray dots", () => {
    expect(parseHost(`acme.${ROOT}`, `.${ROOT}.`)).toEqual({ kind: "business", label: "acme" });
  });
});

describe("leadingHostLabel — naming a tenant when host routing is off", () => {
  it("reads the first label of a real hostname", () => {
    expect(leadingHostLabel("titea.app.eshobe.com")).toBe("titea");
    expect(leadingHostLabel("TITEA.app.eshobe.com:3000")).toBe("titea");
    expect(leadingHostLabel("biz-1a2b3c4d.pos.eshobe.com.")).toBe("biz-1a2b3c4d");
  });

  it("refuses everything that cannot be a business label", () => {
    // A bare name has no label below anything, an address literal has no
    // labels at all, and a candidate that survived either would go on to be
    // matched against `businesses.subdomain` — cheap to refuse here instead.
    expect(leadingHostLabel("localhost")).toBe("");
    expect(leadingHostLabel("localhost:3000")).toBe("");
    expect(leadingHostLabel("10.0.0.5")).toBe("");
    expect(leadingHostLabel("203.0.113.10:3000")).toBe("");
    expect(leadingHostLabel("[::1]:3000")).toBe("");
    expect(leadingHostLabel("")).toBe("");
    expect(leadingHostLabel(null)).toBe("");
    expect(leadingHostLabel(undefined)).toBe("");
  });

  it("is not parseHost: it knows nothing about ROOT_DOMAIN, apex or console", () => {
    // Which is the whole point — it is asked precisely when parseHost has
    // already answered "unknown" for every host on the deployment. The label
    // it returns is a candidate the database still has to claim.
    expect(parseHost("titea.app.eshobe.com", "")).toEqual({ kind: "unknown", label: "" });
    expect(leadingHostLabel("titea.app.eshobe.com")).toBe("titea");
    expect(leadingHostLabel("admin.app.eshobe.com")).toBe("admin");
  });
});

describe("businessHost", () => {
  it("joins a label to the root domain", () => {
    expect(businessHost("acme", ROOT)).toBe("acme.pos.eshobe.com");
    expect(businessHost("acme", `.${ROOT}`)).toBe("acme.pos.eshobe.com");
  });
});

describe("swapHostLabel", () => {
  it("keeps the port the client is actually talking to", () => {
    // The regression this guards: building a redirect by mutating
    // request.nextUrl kept the *container's* port (3000) rather than the one
    // the browser used, so `/platform` behind Traefik pointed at
    // https://admin.example.com:3000/platform — a dead address.
    expect(swapHostLabel("acme.localtest.me:8443", "admin", "localtest.me")).toBe("admin.localtest.me:8443");
    expect(swapHostLabel("acme.localtest.me:3000", "beta", "localtest.me")).toBe("beta.localtest.me:3000");
  });

  it("emits no port when the request carried none, as on 443", () => {
    expect(swapHostLabel("acme.pos.eshobe.com", "admin", ROOT)).toBe("admin.pos.eshobe.com");
  });

  it("survives a missing Host header", () => {
    expect(swapHostLabel(null, "admin", ROOT)).toBe("admin.pos.eshobe.com");
    expect(swapHostLabel("", "admin", ROOT)).toBe("admin.pos.eshobe.com");
  });

  it("does not mistake an IPv6-looking host's colons for a port", () => {
    expect(swapHostLabel("acme.pos.eshobe.com:not-a-port", "admin", ROOT)).toBe("admin.pos.eshobe.com");
  });
});

describe("preferredProto", () => {
  it("trusts a proxy's x-forwarded-proto over the request's own scheme", () => {
    expect(preferredProto("https", "http:")).toBe("https");
    expect(preferredProto("http", "https:")).toBe("http");
  });

  it("takes the first hop when the header has been appended to", () => {
    expect(preferredProto("https, http", "http:")).toBe("https");
  });

  it("falls back to the request's own scheme when there is no proxy", () => {
    expect(preferredProto(null, "http:")).toBe("http");
    expect(preferredProto(undefined, "https:")).toBe("https");
  });

  it("ignores a value that is neither http nor https rather than trusting it", () => {
    // Client-supplied unless a proxy overwrote it, so `javascript:` and
    // friends must never end up as the scheme of a redirect we emit.
    expect(preferredProto("javascript", "https:")).toBe("https");
    expect(preferredProto("", "http:")).toBe("http");
  });
});

describe("subdomainRoutingEnabled", () => {
  it("is on as soon as a root domain is declared", () => {
    // Declaring a root domain IS the request for per-business origins. The old
    // opt-in existed only while the path-prefix rewrite was still the default;
    // with that gone, "root domain set, routing off" would mean several
    // tenants sharing one origin with no boundary at all.
    expect(subdomainRoutingEnabled({ ROOT_DOMAIN: ROOT })).toBe(true);
    expect(subdomainRoutingEnabled({ ROOT_DOMAIN: "ac.eshobe.com" })).toBe(true);
    expect(subdomainRoutingEnabled({ SUBDOMAIN_ROUTING: "on", ROOT_DOMAIN: ROOT })).toBe(true);
    expect(subdomainRoutingEnabled({ SUBDOMAIN_ROUTING: " ON ", ROOT_DOMAIN: ROOT })).toBe(true);
  });

  it("can still be switched off explicitly, for a deployment whose certificate is not ready", () => {
    expect(subdomainRoutingEnabled({ SUBDOMAIN_ROUTING: "off", ROOT_DOMAIN: ROOT })).toBe(false);
    expect(subdomainRoutingEnabled({ SUBDOMAIN_ROUTING: " OFF ", ROOT_DOMAIN: ROOT })).toBe(false);
    expect(subdomainRoutingEnabled({ SUBDOMAIN_ROUTING: "false", ROOT_DOMAIN: ROOT })).toBe(false);
    expect(subdomainRoutingEnabled({ SUBDOMAIN_ROUTING: "0", ROOT_DOMAIN: ROOT })).toBe(false);
  });

  it("reads as off with no root domain, rather than failing every host closed", () => {
    expect(subdomainRoutingEnabled({})).toBe(false);
    expect(subdomainRoutingEnabled({ SUBDOMAIN_ROUTING: "on" })).toBe(false);
    expect(subdomainRoutingEnabled({ SUBDOMAIN_ROUTING: "on", ROOT_DOMAIN: "  " })).toBe(false);
  });
});

describe("resolveRequestHost", () => {
  it("reads the real Host header and ignores the forwarded one by default", () => {
    // The default has to be this way round: X-Forwarded-Host is client-supplied
    // unless a proxy overwrote it, and this value decides which tenant a
    // request belongs to. Traefik passes the original Host through untouched.
    expect(resolveRequestHost("acme.pos.eshobe.com", "evil.pos.eshobe.com", {})).toBe(
      "acme.pos.eshobe.com",
    );
  });

  it("reads the forwarded host when the platform is declared to rewrite Host", () => {
    // A managed platform routes by hostname itself and hands the container an
    // internal name; without this, Host names no tenant ever and host tenancy
    // cannot work at all.
    const env = { TRUST_FORWARDED_HOST: "on" };
    expect(resolveRequestHost("web-1234.internal:3000", "acme.ac.eshobe.com", env)).toBe(
      "acme.ac.eshobe.com",
    );
  });

  it("takes the first hop when several proxies have appended to the header", () => {
    const env = { TRUST_FORWARDED_HOST: "on" };
    expect(resolveRequestHost("internal:3000", "acme.ac.eshobe.com, edge.internal", env)).toBe(
      "acme.ac.eshobe.com",
    );
  });

  it("falls back to Host when the forwarded header is absent or empty", () => {
    const env = { TRUST_FORWARDED_HOST: "on" };
    expect(resolveRequestHost("acme.ac.eshobe.com", null, env)).toBe("acme.ac.eshobe.com");
    expect(resolveRequestHost("acme.ac.eshobe.com", "  ", env)).toBe("acme.ac.eshobe.com");
  });

  it("returns an empty string when there is no host at all, which parses as unknown", () => {
    expect(resolveRequestHost(null, null, {})).toBe("");
    expect(parseHost(resolveRequestHost(null, null, {}), ROOT)).toEqual({ kind: "unknown", label: "" });
  });
});

describe("trustForwardedHost", () => {
  it("is off unless explicitly turned on", () => {
    expect(trustForwardedHost({})).toBe(false);
    expect(trustForwardedHost({ TRUST_FORWARDED_HOST: "off" })).toBe(false);
    expect(trustForwardedHost({ TRUST_FORWARDED_HOST: "" })).toBe(false);
  });

  it("accepts the usual affirmatives", () => {
    for (const value of ["on", " ON ", "true", "1"]) {
      expect(trustForwardedHost({ TRUST_FORWARDED_HOST: value }), value).toBe(true);
    }
  });
});

describe("websocketOriginAllowed", () => {
  const BIZ = "acme.pos.eshobe.com";

  it("allows a browser whose Origin matches the Host (Traefik / desktop)", () => {
    expect(websocketOriginAllowed(`https://${BIZ}`, BIZ, null, {})).toBe(true);
  });

  it("rejects a cross-origin upgrade when Host is authoritative", () => {
    expect(websocketOriginAllowed("https://evil.example.com", BIZ, null, {})).toBe(false);
  });

  it("ignores a forged X-Forwarded-Host unless the platform is declared to rewrite Host", () => {
    // Same default as resolveRequestHost: an attacker who can reach the app
    // directly must not be able to name their own expected host.
    expect(
      websocketOriginAllowed("https://evil.example.com", BIZ, "evil.example.com", {}),
    ).toBe(false);
  });

  it("compares against X-Forwarded-Host behind a managed platform edge", () => {
    // The regression this function exists for: Runflare/ParsPack hand the
    // container an internal Host, so comparing Origin to it 403s every single
    // upgrade and the dashboard shows "connection to server lost" forever.
    const env = { TRUST_FORWARDED_HOST: "on" };
    expect(
      websocketOriginAllowed(`https://${BIZ}`, "web-1234.internal:3000", BIZ, env),
    ).toBe(true);
    expect(
      websocketOriginAllowed("https://evil.example.com", "web-1234.internal:3000", BIZ, env),
    ).toBe(false);
  });

  it("takes the first entry when several proxies appended to X-Forwarded-Host", () => {
    expect(
      websocketOriginAllowed(`https://${BIZ}`, "web-1234.internal:3000", `${BIZ}, edge.internal`, {
        TRUST_FORWARDED_HOST: "on",
      }),
    ).toBe(true);
  });

  it("ignores a port rewritten by the edge, and case", () => {
    expect(websocketOriginAllowed(`https://${BIZ}`, `${BIZ}:3000`, null, {})).toBe(true);
    expect(websocketOriginAllowed(`https://ACME.pos.eshobe.com`, BIZ, null, {})).toBe(true);
  });

  it("allows a non-browser client that sends no Origin at all", () => {
    // The desktop shell, the print agent and platform health probes send none;
    // Origin is a browser-supplied header and browsers are what this defends
    // against.
    expect(websocketOriginAllowed(undefined, BIZ, null, {})).toBe(true);
    expect(websocketOriginAllowed(null, BIZ, null, {})).toBe(true);
  });

  it("rejects an unparseable Origin, and a request with no host at all", () => {
    expect(websocketOriginAllowed("not-a-url", BIZ, null, {})).toBe(false);
    expect(websocketOriginAllowed(`https://${BIZ}`, "", null, {})).toBe(false);
  });
});

// Issue #1003 / SECURITY_AUDIT L5 — /api/host/resolve?debug=1 echoes the
// routing headers and configuration (the container's internal hostname
// included) to anyone, so a production server only answers it on request.
describe("hostDebugEnabled", () => {
  it("is always on outside production", () => {
    expect(hostDebugEnabled({})).toBe(true);
    expect(hostDebugEnabled({ NODE_ENV: "development" })).toBe(true);
    expect(hostDebugEnabled({ NODE_ENV: "test", HOST_RESOLVE_DEBUG: "off" })).toBe(true);
  });

  it("is off in production unless an operator switches it on", () => {
    expect(hostDebugEnabled({ NODE_ENV: "production" })).toBe(false);
    for (const value of ["", "off", "0", "false", "yes", "enabled"]) {
      expect(hostDebugEnabled({ NODE_ENV: "production", HOST_RESOLVE_DEBUG: value }), value).toBe(false);
    }
    for (const value of ["on", "ON", " true ", "1"]) {
      expect(hostDebugEnabled({ NODE_ENV: "production", HOST_RESOLVE_DEBUG: value }), value).toBe(true);
    }
  });
});
