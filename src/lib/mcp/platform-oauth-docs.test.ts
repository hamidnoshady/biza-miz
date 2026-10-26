import { describe, expect, it } from "vitest";
import {
  PLATFORM_MCP_SCOPE,
  platformAuthorizationServerMetadata,
  platformBearerChallenge,
  platformIssuer,
  platformProtectedResourceMetadata,
  wellKnownIsPlatformRealm,
} from "./platform-oauth-docs";

const origin = "https://admin.example.com";

describe("platform MCP discovery documents", () => {
  it("uses the bare origin as the issuer on the admin host", () => {
    expect(platformIssuer(origin, true)).toBe(origin);
    expect(platformAuthorizationServerMetadata(origin, true).issuer).toBe(origin);
  });

  it("path-inserts the issuer anywhere else, so tenant documents stay the bare ones", () => {
    expect(platformIssuer("https://pos.example.com", false)).toBe("https://pos.example.com/api/platform/mcp");
  });

  it("builds endpoints from the origin, never from the issuer", () => {
    const doc = platformAuthorizationServerMetadata("https://pos.example.com", false);
    expect(doc.authorization_endpoint).toBe("https://pos.example.com/api/platform/mcp/oauth/authorize");
    expect(doc.token_endpoint).toBe("https://pos.example.com/api/platform/mcp/oauth/token");
    expect(doc.registration_endpoint).toBe("https://pos.example.com/api/platform/mcp/oauth/register");
    expect(doc.revocation_endpoint).toBe("https://pos.example.com/api/platform/mcp/oauth/revoke");
  });

  it("offers S256 PKCE and public clients only", () => {
    const doc = platformAuthorizationServerMetadata(origin, true);
    expect(doc.code_challenge_methods_supported).toEqual(["S256"]);
    expect(doc.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(doc.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
  });

  it("describes the console endpoint as the protected resource", () => {
    const doc = platformProtectedResourceMetadata(origin, true);
    expect(doc.resource).toBe(`${origin}/api/platform/mcp`);
    expect(doc.authorization_servers).toEqual([origin]);
    expect(doc.scopes_supported).toEqual([PLATFORM_MCP_SCOPE]);
  });

  it("points the 401 challenge at the path-inserted metadata, valid in both host shapes", () => {
    const challenge = platformBearerChallenge(origin);
    expect(challenge).toContain(`resource_metadata="${origin}/.well-known/oauth-protected-resource/api/platform/mcp"`);
    expect(challenge.startsWith("Bearer ")).toBe(true);
  });

  it("claims a well-known request for the console only by its path or the admin host", () => {
    expect(wellKnownIsPlatformRealm("/api/platform/mcp", false)).toBe(true);
    expect(wellKnownIsPlatformRealm("/api/mcp", false)).toBe(false);
    expect(wellKnownIsPlatformRealm("", false)).toBe(false);
    expect(wellKnownIsPlatformRealm("", true)).toBe(true);
  });
});
