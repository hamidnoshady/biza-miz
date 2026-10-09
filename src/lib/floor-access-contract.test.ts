import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("floor page and API access contract", () => {
  it("uses tables.manage for reading the floor and tables.edit only for structural editing", () => {
    const page = source("src/app/(app)/accounting/floor/page.tsx");
    const api = source("src/app/api/floor/route.ts");

    expect(page).toContain("access.permissions.has(PERMISSIONS.tablesManage)");
    expect(api).toContain("requirePermission(PERMISSIONS.tablesManage)");
    expect(page).toContain("access.permissions.has(PERMISSIONS.tablesEdit)");
  });
});
