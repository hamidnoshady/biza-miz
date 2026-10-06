import { describe, expect, it } from "vitest";
import { decodeHolooSyncCursor, buildHolooBaseSelectSql } from "./pull-service";
import { HOLOO_GENERIC_V1 } from "./schema-profile";

describe("Holoo companion cursor SQL", () => {
  it("uses the profiled schema and a stable composite update-time/remote-ID cursor", () => {
    const sql = buildHolooBaseSelectSql(
      HOLOO_GENERIC_V1,
      "goods",
      HOLOO_GENERIC_V1.columns.goods,
      HOLOO_GENERIC_V1.columns.goods.updatedAt,
      HOLOO_GENERIC_V1.columns.goods.id,
      { cursor: "2025-01-15T12:30:00", id: "G-0500" },
    );

    expect(sql).toContain("FROM [dbo].[Goods]");
    expect(sql).toContain("CASE WHEN [ModifiedDate] IS NULL THEN 0 ELSE 1 END");
    expect(sql).toContain("[ModifiedDate] IS NULL THEN 0 ELSE 1 END > 1");
    expect(sql).toContain("COLLATE DATABASE_DEFAULT > N'G-0500'");
    expect(sql).toContain("ORDER BY CASE WHEN [ModifiedDate] IS NULL THEN 0 ELSE 1 END");
    expect(sql).toContain("CONVERT(nvarchar(4000), [ModifiedDate], 126) AS [cursor_key]");
    expect(sql).toContain("COALESCE(CONVERT(nvarchar(4000), [Code], 126), N'') AS [remote_key]");
  });

  it("resumes null update timestamps by remote ID without skipping later ties", () => {
    const sql = buildHolooBaseSelectSql(
      HOLOO_GENERIC_V1,
      "goods",
      HOLOO_GENERIC_V1.columns.goods,
      HOLOO_GENERIC_V1.columns.goods.updatedAt,
      HOLOO_GENERIC_V1.columns.goods.id,
      { cursor: null, id: "G-0500" },
    );

    expect(sql).toContain("CASE WHEN [ModifiedDate] IS NULL THEN 0 ELSE 1 END = 0");
    expect(sql).toContain("COALESCE(CONVERT(nvarchar(4000), [ModifiedDate], 126), N'') COLLATE DATABASE_DEFAULT = N''");
    expect(sql).toContain("COLLATE DATABASE_DEFAULT > N'G-0500'");
  });

  it("decodes legacy scalar cursors inclusively and round-trips composite cursors", () => {
    expect(decodeHolooSyncCursor("2025-01-15T12:30:00")).toEqual({
      cursor: "2025-01-15T12:30:00",
      id: "",
      inclusive: true,
    });
    expect(decodeHolooSyncCursor(JSON.stringify({ cursor: null, id: "G-0500" }))).toEqual({
      cursor: null,
      id: "G-0500",
    });
    expect(decodeHolooSyncCursor(null)).toBeNull();
  });
});
