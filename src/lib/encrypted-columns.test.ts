// GH #1567 C1 — the sealed-column registry (ciphertext with no plaintext twin).
// The schema half (bytea exists, no plaintext copy beside it) runs against a
// live database in integration/field-encryption.integration.test.ts; this file
// pins the code-side guarantees.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AI_EXCLUDED_PERMISSIONS } from "./ai-capabilities";
import { ENCRYPTED_TABLES, SEALED_COLUMNS, encryptedPhysicalColumns } from "./encrypted-columns";
import { partyReferenceFor } from "./party-merge-references";
import type { Permission } from "./permissions";

describe("sealed columns (GH #1567 C1)", () => {
  it("registers the tailoring measurements", () => {
    expect(SEALED_COLUMNS.map((s) => `${s.table}.${s.encColumn}`)).toContain("tailoring_measurement_profiles.measurements_enc");
  });

  it("are part of the physical-column schema assertion", () => {
    for (const s of SEALED_COLUMNS) {
      expect(encryptedPhysicalColumns()).toContainEqual({ table: s.table, column: s.encColumn, dataType: "bytea" });
    }
  });

  it("are never in the list bulk tenant export decrypts", () => {
    for (const s of SEALED_COLUMNS) {
      const dual = ENCRYPTED_TABLES[s.table]?.columns ?? [];
      expect(dual.some((c) => c.encColumn === s.encColumn)).toBe(false);
    }
  });

  it("are guarded by an AI-excluded permission", () => {
    for (const s of SEALED_COLUMNS) expect(AI_EXCLUDED_PERMISSIONS.has(s.permission as Permission)).toBe(true);
  });

  it("block party merge for their table", () => {
    for (const s of SEALED_COLUMNS) expect(partyReferenceFor(s.table, "party_id")?.disposition).toBe("blocked");
  });

  it("are read by one service only", () => {
    for (const s of SEALED_COLUMNS) {
      const hits = (readdirSync("src", { recursive: true }) as string[])
        .map((f) => path.join("src", f).split(path.sep).join("/"))
        .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) && f !== "src/lib/encrypted-columns.ts")
        .filter((f) => readFileSync(f, "utf8").includes(s.encColumn));
      expect(hits).toEqual([s.readPath]);
    }
  });
});
