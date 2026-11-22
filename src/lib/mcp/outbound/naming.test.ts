import { describe, expect, it } from "vitest";

import {
  externalToolName,
  isExternalMcpToolName,
  MAX_SERVER_SLUG,
  parseExternalToolName,
  SERVER_SLUG_RE,
} from "./naming";

describe("externalToolName", () => {
  it("prefixes the server slug and separates with a double underscore", () => {
    expect(externalToolName("acme", "findPages")).toBe("mcp_acme__findpages");
  });

  it("reduces a remote name to the characters an OpenAI function allows", () => {
    expect(externalToolName("cms", "find pages")).toBe("mcp_cms__find_pages");
    expect(externalToolName("cms", "cms.site-context")).toBe("mcp_cms__cms_site_context");
    expect(externalToolName("cms", "__leading__trailing__")).toBe("mcp_cms__leading_trailing");
  });

  it("falls back to a non-empty tool segment", () => {
    expect(externalToolName("cms", "...")).toBe("mcp_cms__tool");
  });

  it("fits OpenAI's 64-character function name even with a maximum slug", () => {
    const slug = "a".repeat(MAX_SERVER_SLUG);
    const name = externalToolName(slug, "t".repeat(200));
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });

  it("matches the server slug rule the API enforces", () => {
    expect(SERVER_SLUG_RE.test("acme")).toBe(true);
    expect(SERVER_SLUG_RE.test("acme-cms")).toBe(true);
    expect(SERVER_SLUG_RE.test("Acme")).toBe(false);
    expect(SERVER_SLUG_RE.test("-acme")).toBe(false);
    expect(SERVER_SLUG_RE.test("a".repeat(MAX_SERVER_SLUG + 1))).toBe(false);
  });
});

describe("isExternalMcpToolName", () => {
  it("recognises the prefix + separator pair", () => {
    expect(isExternalMcpToolName("mcp_acme__findpages")).toBe(true);
    expect(isExternalMcpToolName("find_pages")).toBe(false);
    expect(isExternalMcpToolName("mcp_acme")).toBe(false);
    // A built-in tool that happens to start with the prefix is not routed out.
    expect(isExternalMcpToolName("mcp_state")).toBe(false);
  });
});

describe("parseExternalToolName", () => {
  it("round-trips an exposed name", () => {
    expect(parseExternalToolName(externalToolName("acme", "findPages"))).toEqual({
      slug: "acme",
      tool: "findpages",
    });
  });

  it("refuses a name whose slug could not have been issued", () => {
    expect(parseExternalToolName("mcp_ACME__findpages")).toBeNull();
    expect(parseExternalToolName("mcp___findpages")).toBeNull();
    expect(parseExternalToolName("mcp_acme__")).toBeNull();
    expect(parseExternalToolName("mcp_acme")).toBeNull();
  });
});
