import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MCP_ACCESS_TOKEN_PREFIX,
  MCP_REFRESH_TOKEN_PREFIX,
  MCP_TOKEN_PREFIX,
  authorizationServerMetadata,
  bearerChallenge,
  buildRedirect,
  createMcpAccessToken,
  createMcpRefreshToken,
  createMcpStaticToken,
  hashMcpToken,
  isAllowedRedirectUri,
  isSupportedCodeChallengeMethod,
  isValidCodeChallenge,
  isValidCodeVerifier,
  looksLikeMcpToken,
  matchesRegisteredRedirectUri,
  mcpTokenDisplayPrefix,
  parseMcpBearerToken,
  protectedResourceMetadata,
  verifyCodeChallenge,
} from "./oauth";

const VERIFIER = "a".repeat(64);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

function headers(value: string | null): Pick<Request, "headers"> {
  return { headers: new Headers(value ? { authorization: value } : {}) } as Pick<Request, "headers">;
}

describe("credential format", () => {
  it("namespaces every credential, so another realm's token is rejected on shape", () => {
    expect(createMcpStaticToken().startsWith(MCP_TOKEN_PREFIX)).toBe(true);
    expect(createMcpAccessToken().startsWith(MCP_ACCESS_TOKEN_PREFIX)).toBe(true);
    expect(createMcpRefreshToken().startsWith(MCP_REFRESH_TOKEN_PREFIX)).toBe(true);
    // Every one of them is recognisable as ours, including the OAuth kinds.
    expect(looksLikeMcpToken(createMcpAccessToken())).toBe(true);
    // …and a public API key pasted by mistake is not.
    expect(looksLikeMcpToken("posk_live_abcdef")).toBe(false);
    expect(looksLikeMcpToken("POS1-abcdef")).toBe(false);
  });

  it("mints unique tokens", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => createMcpStaticToken()));
    expect(tokens.size).toBe(50);
  });

  it("stores a display prefix that can never authenticate", () => {
    const token = createMcpStaticToken();
    const prefix = mcpTokenDisplayPrefix(token);
    expect(token.startsWith(prefix)).toBe(true);
    expect(prefix.length).toBeLessThan(token.length / 2);
  });

  it("hashes with SHA-256, matching every other credential in this codebase", () => {
    expect(hashMcpToken("x")).toHaveLength(64);
    expect(hashMcpToken("x")).toBe(createHash("sha256").update("x").digest("hex"));
  });
});

describe("parseMcpBearerToken", () => {
  it("takes exactly one bearer credential from this realm", () => {
    expect(parseMcpBearerToken(headers(`Bearer ${MCP_TOKEN_PREFIX}abc`))).toBe(
      `${MCP_TOKEN_PREFIX}abc`,
    );
    expect(parseMcpBearerToken(headers(`bearer ${MCP_TOKEN_PREFIX}abc`))).toBe(
      `${MCP_TOKEN_PREFIX}abc`,
    );
  });

  it("ignores another realm's credential rather than looking it up", () => {
    expect(parseMcpBearerToken(headers("Bearer posk_live_abc"))).toBeNull();
    expect(parseMcpBearerToken(headers("Basic abc"))).toBeNull();
    expect(parseMcpBearerToken(headers(null))).toBeNull();
  });
});

describe("PKCE", () => {
  it("accepts only S256", () => {
    expect(isSupportedCodeChallengeMethod("S256")).toBe(true);
    // `plain` is no protection against an intercepted code, and refusing it
    // outright means there is no downgrade to request.
    expect(isSupportedCodeChallengeMethod("plain")).toBe(false);
    expect(isSupportedCodeChallengeMethod(undefined)).toBe(false);
  });

  it("verifies a genuine verifier/challenge pair", () => {
    expect(verifyCodeChallenge(VERIFIER, CHALLENGE)).toBe(true);
  });

  it("refuses a wrong verifier", () => {
    expect(verifyCodeChallenge("b".repeat(64), CHALLENGE)).toBe(false);
  });

  it("refuses a verifier that is merely a prefix of the right one", () => {
    expect(verifyCodeChallenge(VERIFIER.slice(0, 43), CHALLENGE)).toBe(false);
  });

  it("enforces RFC 7636's length and character bounds on both halves", () => {
    expect(isValidCodeVerifier("a".repeat(42))).toBe(false);
    expect(isValidCodeVerifier("a".repeat(43))).toBe(true);
    expect(isValidCodeVerifier("a".repeat(129))).toBe(false);
    expect(isValidCodeVerifier(`${"a".repeat(42)}/`)).toBe(false);
    expect(isValidCodeChallenge(CHALLENGE)).toBe(true);
    expect(isValidCodeChallenge("short")).toBe(false);
    expect(isValidCodeChallenge(null)).toBe(false);
  });

  it("refuses a malformed challenge rather than comparing against it", () => {
    expect(verifyCodeChallenge(VERIFIER, "nope")).toBe(false);
  });
});

describe("isAllowedRedirectUri", () => {
  it("allows https, loopback http, and private-use schemes", () => {
    expect(isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(isAllowedRedirectUri("http://127.0.0.1:8765/callback")).toBe(true);
    expect(isAllowedRedirectUri("http://localhost/callback")).toBe(true);
    expect(isAllowedRedirectUri("com.example.app:/oauth")).toBe(true);
  });

  it("refuses plain http to a real host, and every dangerous scheme", () => {
    expect(isAllowedRedirectUri("http://evil.example/callback")).toBe(false);
    expect(isAllowedRedirectUri("javascript:alert(1)")).toBe(false);
    expect(isAllowedRedirectUri("data:text/html,x")).toBe(false);
    expect(isAllowedRedirectUri("file:///etc/passwd")).toBe(false);
    expect(isAllowedRedirectUri("not a url")).toBe(false);
    expect(isAllowedRedirectUri("")).toBe(false);
    expect(isAllowedRedirectUri(null)).toBe(false);
  });

  it("refuses a URI with a fragment, which the code would be appended behind", () => {
    expect(isAllowedRedirectUri("https://claude.ai/cb#x")).toBe(false);
  });
});

describe("matchesRegisteredRedirectUri", () => {
  const registered = ["https://claude.ai/api/mcp/auth_callback"];

  it("matches exactly and nothing else", () => {
    expect(matchesRegisteredRedirectUri(registered[0], registered)).toBe(true);
    // The classic way an authorization code is delivered to an attacker's path
    // on a legitimate host.
    expect(matchesRegisteredRedirectUri("https://claude.ai/api/mcp/auth_callback/x", registered)).toBe(
      false,
    );
    expect(matchesRegisteredRedirectUri("https://claude.ai/", registered)).toBe(false);
    expect(matchesRegisteredRedirectUri("https://claude.ai.evil.example/api/mcp/auth_callback", registered)).toBe(
      false,
    );
  });

  it("ignores the port on a loopback URI, as RFC 8252 requires", () => {
    // A desktop client binds an ephemeral port it cannot know at registration.
    const loopback = ["http://127.0.0.1:1234/callback"];
    expect(matchesRegisteredRedirectUri("http://127.0.0.1:54321/callback", loopback)).toBe(true);
    expect(matchesRegisteredRedirectUri("http://127.0.0.1:54321/other", loopback)).toBe(false);
    // …and the concession is loopback-only.
    expect(matchesRegisteredRedirectUri("https://claude.ai:8443/api/mcp/auth_callback", registered)).toBe(
      false,
    );
  });

  it("does not treat localhost and 127.0.0.1 as interchangeable", () => {
    expect(matchesRegisteredRedirectUri("http://localhost:9/cb", ["http://127.0.0.1:9/cb"])).toBe(false);
  });
});

describe("buildRedirect", () => {
  it("adds params without disturbing the ones already there", () => {
    const url = buildRedirect("https://claude.ai/cb?keep=1", { code: "abc", state: "xyz" });
    expect(url).toContain("keep=1");
    expect(url).toContain("code=abc");
    expect(url).toContain("state=xyz");
  });

  it("omits an absent state rather than writing 'null' into the URL", () => {
    expect(buildRedirect("https://claude.ai/cb", { code: "abc", state: null })).not.toContain("state");
  });
});

describe("discovery documents", () => {
  const issuer = "https://vanak.example.com";

  it("names the MCP endpoint as the resource and this origin as its authorization server", () => {
    const doc = protectedResourceMetadata(issuer);
    expect(doc!.resource).toBe(`${issuer}/api/mcp`);
    expect(doc!.authorization_servers).toEqual([issuer]);
    expect(doc!.scopes_supported).toEqual(["pos.read", "pos.write"]);
  });

  it("answers metadata for any inserted path with the tenant document", () => {
    expect(protectedResourceMetadata(issuer, "/api/mcp")!.resource).toBe(`${issuer}/api/mcp`);
  });

  it("deliberately declines to describe the platform realm as a protected resource", () => {
    expect(protectedResourceMetadata(issuer, "/api/platform/mcp")).toBeNull();
  });

  it("advertises dynamic registration, which is what makes 'paste a URL' work", () => {
    const doc = authorizationServerMetadata(issuer);
    expect(doc.registration_endpoint).toBe(`${issuer}/api/mcp/oauth/register`);
    expect(doc.code_challenge_methods_supported).toEqual(["S256"]);
    expect(doc.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    // Public clients only: PKCE authenticates the exchange, so no secret is
    // issued and none can leak.
    expect(doc.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(doc.issuer).toBe(issuer);
  });

  it("points the 401 challenge at the protected-resource document", () => {
    // This header is the whole discovery chain: without it a client that has
    // never seen this business has no way to find the authorization server.
    expect(bearerChallenge(issuer)).toBe(
      `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource", scope="pos.read pos.write"`,
    );
  });
});
