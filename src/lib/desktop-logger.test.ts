import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
const require = createRequire(import.meta.url);
const { redact } = require("../../electron/logger.js");

describe("desktop structured logging", () => {
  it("preserves metadata while removing nested secrets", () => {
    const value = JSON.parse(redact({ port: 3000, nested: { masterKey: "secret", pgPassword: "secret", cookie: "secret", "x-eshobe-billing-signature": "secret" } }));
    expect(value.port).toBe(3000);
    expect(Object.values(value.nested)).toEqual(Array(4).fill("[REDACTED]"));
  });
  it("handles errors, cycles, and bigint without dropping all metadata", () => {
    const value: Record<string, unknown> = { error: new Error("failed"), count: 1n };
    value.self = value;
    expect(JSON.parse(redact(value))).toMatchObject({ error: { message: "failed" }, count: "1", self: "[Circular]" });
  });
  it("keeps serialized JSON valid when a message contains credentials", () => {
    expect(JSON.parse(redact({ message: "password=secret", detail: "pgPassword=secret" }))).toEqual({
      message: "password=[REDACTED]", detail: "pgPassword=[REDACTED]",
    });
  });
  it("redacts secrets in plain child output", () => {
    expect(redact("pgPassword=secret")).not.toContain("secret");
    expect(redact("cookie: session=secret; other=secret")).not.toContain("secret");
  });
});
