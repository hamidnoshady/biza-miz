import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("preserves the request CSP nonce while acknowledging browser nonce-attribute hiding", () => {
  const source = readFileSync("src/app/layout.tsx", "utf8");
  expect(source).toContain('(await headers()).get("x-nonce")');
  expect(source).toContain('<script nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: CLOUD_EMBED_MARKER_SCRIPT }} />');
  expect(source).toContain('<ThemeProvider nonce={nonce}>');
});
