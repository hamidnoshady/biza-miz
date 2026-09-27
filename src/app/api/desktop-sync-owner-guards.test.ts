import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(process.cwd(), "src", "app", "api");
const ownerOnlyRoutes = [
  "connections/desktop/route.ts",
  "server-sync/config/route.ts",
  "server-sync/config/generate-token/route.ts",
  "server-sync/reconcile/route.ts",
  "setup/reconnect/route.ts",
] as const;

describe("desktop/cloud machine-trust API boundary", () => {
  it("requires the Owner role on every browser-facing machine-trust operation", () => {
    for (const route of ownerOnlyRoutes) {
      const source = readFileSync(join(ROOT, route), "utf8");
      expect(source, route).toMatch(/requireRole\("owner"\)/);
      expect(source, route).not.toMatch(/requirePermission\(PERMISSIONS\.integrations(?:View|Manage)\)/);
    }
  });
});
