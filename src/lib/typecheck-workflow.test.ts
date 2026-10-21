import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/test.yml", "utf8");
const typecheck = workflow.match(/^  typecheck:\n([\s\S]*?)(?=^  [\w-]+:)/m)?.[1] ?? "";

describe("CI cold typecheck budget", () => {
  it("overrides the shared 3 GiB heap for the full-project checker", () => {
    expect(typecheck).toMatch(/NODE_OPTIONS:\s*--max-old-space-size=4096/);
    expect(workflow).toContain("NODE_OPTIONS: --max-old-space-size=3072");
  });

  it("keeps the full check blocking and reports resource diagnostics", () => {
    expect(typecheck).toContain("npx tsc --noEmit --extendedDiagnostics");
    expect(typecheck).toContain("node-version: 24");
    expect(typecheck).not.toContain("continue-on-error");
    expect(typecheck).not.toContain("--noCheck");
  });
});
