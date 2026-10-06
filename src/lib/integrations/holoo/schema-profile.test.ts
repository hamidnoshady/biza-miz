import { describe, expect, it } from "vitest";
import {
  diagnoseProfile,
  HOLOO_PROFILES,
  matchProfile,
  profileAllowsDirectSql,
  profileForKey,
  type HolooSchemaColumn,
  type HolooSchemaSnapshot,
} from "./schema-profile";

function supportedSnapshot(): HolooSchemaSnapshot {
  const profile = HOLOO_PROFILES[0];
  const tables = Object.values(profile.requirements).map((requirement) => {
    const columns: HolooSchemaColumn[] = requirement.requiredColumns.map((column) => ({
      name: column.name,
      dataType: column.compatibleTypes[0],
      nullable: !column.notNull,
      collation: column.databaseCollation ? "Persian_100_CI_AS" : null,
    }));
    return {
      schema: "dbo",
      name: requirement.name,
      columns,
      primaryKey: [...(requirement.primaryKey ?? [])],
    };
  });
  const dateSamples = Object.values(profile.requirements).flatMap((requirement) =>
    requirement.requiredColumns
      .filter((column) => column.semantic === "date")
      .map((column) => ({
        schema: "dbo",
        table: requirement.name,
        column: column.name,
        values: ["2025-01-15T00:00:00"],
      })),
  );
  return {
    fingerprint: {
      serverVersion: "Microsoft SQL Server 2022 (RTM)",
      productVersion: "16.0.1000.6",
      productLevel: "RTM",
      edition: "Standard Edition (64-bit)",
      databaseCollation: "Persian_100_CI_AS",
    },
    tables,
    dateSamples,
  };
}

describe("matchProfile — structural, versioned matching", () => {
  it("matches a complete v1 structure and SQL Server fingerprint", () => {
    const profile = matchProfile(supportedSnapshot());
    expect(profile?.key).toBe("holoo-generic-v1");
    expect(profile?.profileVersion).toBe(1);
    expect(profile?.dateMode).toBe("native_sql_date");
  });

  it("rejects a table-name-only lookalike", () => {
    const snapshot = supportedSnapshot();
    snapshot.tables.forEach((table) => {
      (table as { columns: readonly HolooSchemaColumn[] }).columns = [];
    });
    expect(matchProfile(snapshot)).toBeNull();
    expect(diagnoseProfile(snapshot).diagnostics.some((issue) => issue.code === "missing_column")).toBe(true);
  });

  it("returns unknown when any required table is missing", () => {
    const snapshot = supportedSnapshot();
    snapshot.tables = snapshot.tables.filter((table) => table.name !== "SanadRow");
    expect(matchProfile(snapshot)).toBeNull();
    expect(diagnoseProfile(snapshot).diagnostics).toContainEqual({ code: "missing_table", table: "SanadRow" });
  });

  it("returns unknown when a required column is missing", () => {
    const snapshot = supportedSnapshot();
    const goods = snapshot.tables.find((table) => table.name === "Goods")!;
    (goods as { columns: readonly HolooSchemaColumn[] }).columns = goods.columns.filter((column) => column.name !== "SellPrice");
    expect(matchProfile(snapshot)).toBeNull();
    expect(diagnoseProfile(snapshot).diagnostics).toContainEqual({ code: "missing_column", table: "Goods", column: "SellPrice" });
  });

  it("rejects incompatible money types instead of inferring from a familiar name", () => {
    const snapshot = supportedSnapshot();
    const total = snapshot.tables.find((table) => table.name === "Invoice")!.columns.find((column) => column.name === "TotalPrice")!;
    (total as { dataType: string }).dataType = "float";
    expect(matchProfile(snapshot)).toBeNull();
    expect(diagnoseProfile(snapshot).diagnostics).toContainEqual({ code: "incompatible_column_type", table: "Invoice", column: "TotalPrice" });
  });

  it("rejects a nullable remote key", () => {
    const snapshot = supportedSnapshot();
    const goodsCode = snapshot.tables.find((table) => table.name === "Goods")!.columns.find((column) => column.name === "Code")!;
    (goodsCode as { nullable: boolean }).nullable = true;
    expect(matchProfile(snapshot)).toBeNull();
    expect(diagnoseProfile(snapshot).diagnostics).toContainEqual({ code: "nullable_required_column", table: "Goods", column: "Code" });
  });

  it("rejects an unexpected primary-key shape", () => {
    const snapshot = supportedSnapshot();
    const invoice = snapshot.tables.find((table) => table.name === "Invoice")!;
    (invoice as { primaryKey: readonly string[] }).primaryKey = ["PersonCode"];
    expect(matchProfile(snapshot)).toBeNull();
    expect(diagnoseProfile(snapshot).diagnostics).toContainEqual({ code: "primary_key_mismatch", table: "Invoice" });
  });

  it("rejects a different date representation and invalid representative samples", () => {
    const snapshot = supportedSnapshot();
    const invoice = snapshot.tables.find((table) => table.name === "Invoice")!;
    const date = invoice.columns.find((column) => column.name === "Date")!;
    (date as { dataType: string }).dataType = "nvarchar";
    expect(matchProfile(snapshot)).toBeNull();

    const validDateSnapshot = supportedSnapshot();
    validDateSnapshot.dateSamples = validDateSnapshot.dateSamples.map((sample) =>
      sample.table === "Invoice" && sample.column === "Date" ? { ...sample, values: ["1404/01/25"] } : sample,
    );
    expect(matchProfile(validDateSnapshot)).toBeNull();
    expect(diagnoseProfile(validDateSnapshot).diagnostics).toContainEqual({ code: "invalid_date_sample", table: "Invoice", column: "Date" });
  });

  it("rejects unsupported edition/runtime fingerprints", () => {
    const snapshot = supportedSnapshot();
    snapshot.fingerprint = { ...snapshot.fingerprint, edition: "Azure SQL Database" };
    expect(matchProfile(snapshot)).toBeNull();
    expect(diagnoseProfile(snapshot).diagnostics).toContainEqual({ code: "unsupported_edition" });

    const unsupportedVersion = supportedSnapshot();
    unsupportedVersion.fingerprint = { ...unsupportedVersion.fingerprint, productVersion: "9.0.0.0" };
    expect(matchProfile(unsupportedVersion)).toBeNull();
    expect(diagnoseProfile(unsupportedVersion).diagnostics).toContainEqual({ code: "unsupported_sql_server_version" });
  });

  it("does not enable direct SQL for the canonical profile", () => {
    expect(profileAllowsDirectSql("holoo-generic-v1")).toBe(false);
    expect(profileAllowsDirectSql("unknown")).toBe(false);
  });
});

describe("profileForKey", () => {
  it("returns a versioned profile and refuses retired or unknown keys", () => {
    expect(profileForKey("holoo-generic-v1")?.label).toBe(HOLOO_PROFILES[0].label);
    expect(profileForKey("holoo-generic")).toBeNull();
    expect(profileForKey("nope")).toBeNull();
  });
});
