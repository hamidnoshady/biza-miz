import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Hybrid reconnect ordering", () => {
  it("gates operational push and pull on IAM reconciliation", () => {
    const source=readFileSync(new URL("../server-sync.ts",import.meta.url),"utf8");
    const tick=source.slice(source.indexOf("export async function runServerSyncTick"));
    expect(tick.indexOf("runIamSync")).toBeGreaterThan(-1);
    expect(tick.indexOf("runIamSync")).toBeLessThan(tick.indexOf("runServerPush"));
    expect(tick.indexOf("runIamSync")).toBeLessThan(tick.indexOf("runServerPull"));
    expect(tick).toContain("if (!iamReady)");
  });
});
