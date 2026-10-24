import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/test.yml", "utf8");
const typecheck = workflow.match(/^  typecheck:\n([\s\S]*?)(?=^  [\w-]+:)/m)?.[1] ?? "";

describe("CI cold typecheck budget", () => {
  it("overrides the shared 3 GiB heap for the full-project checker", () => {
    const heap = typecheck.match(/NODE_OPTIONS:\s*--max-old-space-size=(\d+)/)?.[1];
    expect(Number(heap)).toBeGreaterThanOrEqual(4096);
    // The workflow-wide default must stay at least the old shared 3 GiB.
    const shared = workflow.match(/^env:\n(?:.*\n)*?\s+NODE_OPTIONS:\s*--max-old-space-size=(\d+)/m)?.[1];
    expect(Number(shared)).toBeGreaterThanOrEqual(3072);
  });

  it("keeps the full check blocking and reports resource diagnostics", () => {
    // main calls the compiler directly (node node_modules/typescript/lib/tsc.js), not via npx.
    expect(typecheck).toMatch(/tsc(?:\.js)? --noEmit --extendedDiagnostics/);
    expect(typecheck).toContain("node-version: 24");
    expect(typecheck).not.toContain("continue-on-error");
    expect(typecheck).not.toContain("--noCheck");
  });
});
