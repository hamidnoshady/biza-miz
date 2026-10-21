/**
 * The #1062 regression contract, pinned at the source.
 *
 * The bug: the company handoff built its browser redirect from `request.url`
 * (the container's internal origin behind a proxy — `http://localhost:3000`)
 * and the receiver rebuilt its post-redemption Location from a raw,
 * client-supplied `X-Forwarded-Host`. The fix is a shared policy
 * (`resolveHandoffOrigin` in src/lib/public-origin.ts) that produces one
 * validated, browser-reachable canonical origin or fails closed before any
 * credential exists. Pure unit tests prove the policy; this suite proves the
 * routes *use* it — in the right order, with the right headers, and with no
 * path back to the two old constructions.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function read(...parts: string[]): string {
  return readFileSync(join(ROOT, ...parts), "utf8");
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const openRoute = stripComments(read("src", "app", "api", "platform", "company", "open", "route.ts"));
const receiverRoute = stripComments(
  read("src", "app", "api", "auth", "company-handoff", "route.ts"),
);
const impersonateRoute = stripComments(
  read("src", "app", "api", "auth", "impersonate-handoff", "route.ts"),
);
const hostRedirectRoute = stripComments(read("src", "app", "api", "host", "redirect", "route.ts"));
const policy = stripComments(read("src", "lib", "public-origin.ts"));
const consoleShell = read("src", "app", "platform", "company", "_components", "company-workspace.tsx");

describe("the handoff destination origin comes from the shared policy", () => {
  it("the open route resolves the origin BEFORE minting a credential", () => {
    const resolvedAt = openRoute.indexOf("resolveHandoffOrigin(");
    const mintedAt = openRoute.indexOf("createCompanyHandoff(");
    expect(resolvedAt, "open route must call resolveHandoffOrigin").toBeGreaterThan(-1);
    expect(mintedAt, "open route must mint through createCompanyHandoff").toBeGreaterThan(-1);
    expect(resolvedAt, "origin must be validated before a token exists").toBeLessThan(mintedAt);
  });

  it("the receiver resolves the origin BEFORE redeeming the credential", () => {
    const resolvedAt = receiverRoute.indexOf("resolveHandoffOrigin(");
    const redeemedAt = receiverRoute.indexOf("redeemCompanyHandoff(");
    expect(resolvedAt).toBeGreaterThan(-1);
    expect(redeemedAt).toBeGreaterThan(-1);
    expect(resolvedAt, "a spoofed request must not spend the one-use token").toBeLessThan(redeemedAt);
  });

  it("the receiver redirects to the validated origin, never to a forwarded host", () => {
    // The old construction: headers.get("x-forwarded-host") ?? headers.get("host")
    expect(receiverRoute).not.toMatch(/headers\.get\(\s*["']x-forwarded-host/);
    expect(receiverRoute).toMatch(/\$\{origin\.origin\}\$\{result\.returnPath\}/);
  });

  it("the impersonation handoff receiver got the same construction fix", () => {
    expect(impersonateRoute).not.toMatch(/headers\.get\(\s*["']x-forwarded-host/);
    expect(impersonateRoute).toMatch(/resolveHandoffOrigin\(/);
    expect(impersonateRoute).toMatch(/\$\{origin\.origin\}\/dashboard/);
  });

  it("the host resolver's redirect route no longer trusts X-Forwarded-Host unconditionally", () => {
    expect(hostRedirectRoute).not.toMatch(/headers\.get\(\s*["']x-forwarded-host/);
    expect(hostRedirectRoute).toMatch(/requestHost\(/);
  });
});

describe("no handoff redirect is rebuilt from the container's internal origin", () => {
  it("the open route never reads request.url (the #1062 construction)", () => {
    expect(openRoute).not.toMatch(/request\.url/);
    expect(openRoute).not.toMatch(/new URL\([^)]*\brequest\b/);
  });

  it("the receiver and the impersonation handoff never read request.url either", () => {
    expect(receiverRoute).not.toMatch(/request\.url/);
    expect(impersonateRoute).not.toMatch(/request\.url/);
  });

  it("the policy itself cannot consult request.url — it takes hosts, not URLs", () => {
    // Reading nextUrl.protocol is fine (it is an input to the scheme rule), and
    // nextUrl.host is fine as a host-*string* input — same value the Host
    // header carries, validated by resolveRequestHost like any host. What
    // stays banned is deriving an origin from the request URL itself
    // (request.url / nextUrl.origin) — exactly the #1062 construction.
    expect(policy).not.toMatch(/request\.url/);
    expect(policy).not.toMatch(/request\.nextUrl\.origin\b/);
    expect(policy).not.toMatch(/new URL\([^)]*nextUrl/);
    // The host input is the Host header with the URL's host as fallback, and
    // it flows into the validators — it is never formatted into an origin.
    expect(policy).toMatch(/headers\.get\("host"\) \?\? request\.nextUrl\.host/);
  });
});

describe("handoff responses carry the credential-hygiene headers", () => {
  it("the policy's headers are no-store and no-referrer", () => {
    expect(policy).toMatch(/"Cache-Control":\s*"no-store"/);
    expect(policy).toMatch(/"Referrer-Policy":\s*"no-referrer"/);
  });

  for (const [name, src] of [
    ["open", openRoute],
    ["receiver", receiverRoute],
    ["impersonation handoff", impersonateRoute],
  ] as const) {
    it(`${name} returns every response through withHandoffHeaders`, () => {
      expect(src).toMatch(/import[^;]*withHandoffHeaders/);
      // No bare response constructors may escape the wrapper: these routes
      // answer navigations that at some point carry the one-use token, so
      // every response — including the boring 400s — stays no-store/no-referrer.
      expect(src, name).not.toMatch(/\breturn\s+NextResponse\.(json|redirect|text)\b/);
      expect(src, name).not.toMatch(/\breturn\s+new NextResponse\b/);
    });
  }
});

describe("no credential reaches logs or the failure feedback", () => {
  for (const [name, src] of [
    ["open", openRoute],
    ["receiver", receiverRoute],
    ["impersonation handoff", impersonateRoute],
    ["policy", policy],
  ] as const) {
    it(`${name} logs no token`, () => {
      expect(src).not.toMatch(
        /platformCompanyLog\([^)]*\b(token|tokenHash|password|secret)\b/i,
      );
      expect(src).not.toMatch(/console\.[a-z]+\s*\([^)]*\btoken\b/i);
    });
  }

  it("the failure redirect carries only a stable error code, never a token", () => {
    expect(openRoute).toMatch(/handoff_error=\$\{encodeURIComponent\(outcome\.code\)\}/);
    // The minted token may appear in exactly one place: the success Location.
    const mintedTokenUses = openRoute.match(/outcome\.token/g) ?? [];
    expect(mintedTokenUses.length).toBe(1);
    expect(openRoute).not.toMatch(/back[^;]*outcome\.token/);
  });

  it("the console shell explains the failure codes instead of a raw network error", () => {
    expect(consoleShell).toMatch(/handoff_error/);
    expect(consoleShell).toMatch(/HANDOFF_ERROR_MESSAGES/);
    // Every code the resolver can return has a message, so a new code cannot
    // ship silently generic.
    for (const code of [
      "public_origin_invalid",
      "public_origin_insecure",
      "public_origin_internal",
      "root_domain_missing",
      "root_domain_invalid",
      "root_domain_internal",
      "request_host_missing",
      "request_host_internal",
      "forwarded_host_untrusted",
      "forwarded_proto_invalid",
      "origin_insecure",
      "request_host_outside_root",
      "subdomain_invalid",
    ]) {
      expect(consoleShell, `console must explain ${code}`).toContain(`${code}:`);
    }
  });
});
