import { describe, expect, it } from "vitest";
import {
  businessDateSql,
  decodeWarehouseRegisterCursor,
  encodeWarehouseRegisterCursor,
  isWarehouseRegisterSort,
  keysetSql,
  orderBySql,
  parseWarehouseRegisterQuery,
  registerExportTable,
  sortKeySql,
  sortKeyTextSql,
  type WarehouseRegisterRow,
} from "./warehouse-document-register";

const OPS = {
  isKind: (value: string) => value === "receipt" || value === "issue",
  isUuid: (value: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
};

const UUID = "3f7c1b1e-0000-4000-8000-000000000001";

function parse(query: string) {
  return parseWarehouseRegisterQuery(new URL(`https://x.test/api?${query}`), OPS);
}

describe("parseWarehouseRegisterQuery", () => {
  it("defaults to an unfiltered newest-first first page", () => {
    const result = parse("");
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.filters).toEqual({});
    expect(result.sort).toBe("created_desc");
    expect(result.limit).toBe(100);
    expect(result.cursor).toBeNull();
    expect(result.format).toBeNull();
  });

  it("rejects a kind this family does not post", () => {
    expect(parse("kind=internal_use")).toEqual({ error: "bad_request" });
  });

  it("validates dates as real calendar days", () => {
    expect(parse("dateFrom=2026-02-30")).toEqual({ error: "invalid_date" });
    expect(parse("dateFrom=2026-13-01")).toEqual({ error: "invalid_date" });
    expect(parse("dateFrom=2026-02-28")).not.toHaveProperty("error");
    expect(parse("dateFrom=2026-03-01&dateTo=2026-02-01")).toEqual({ error: "invalid_date" });
  });

  it("accepts Persian digits and separators in the amount band", () => {
    const result = parse("amountMin=۱٬۲۰۰٬۰۰۰&amountMax=5000000");
    if ("error" in result) throw new Error(result.error);
    expect(result.filters.amountMin).toBe("1200000");
    expect(result.filters.amountMax).toBe("5000000");
  });

  it("refuses an inverted or non-numeric amount band", () => {
    expect(parse("amountMin=500&amountMax=100")).toEqual({ error: "invalid_amount_range" });
    expect(parse("amountMin=12.5")).toEqual({ error: "bad_request" });
    expect(parse("amountMin=-5")).toEqual({ error: "bad_request" });
  });

  it("requires a uuid for the creator filter", () => {
    expect(parse("createdBy=nope")).toEqual({ error: "unknown_creator" });
    const result = parse(`createdBy=${UUID}`);
    if ("error" in result) throw new Error(result.error);
    expect(result.filters.createdBy).toBe(UUID);
  });

  it("only understands the two posting states", () => {
    expect(parse("postingState=maybe")).toEqual({ error: "bad_request" });
    const result = parse("postingState=missing");
    if ("error" in result) throw new Error(result.error);
    expect(result.filters.postingState).toBe("missing");
  });

  it("falls back to newest-first for an unknown sort rather than failing the page", () => {
    const result = parse("sort=vibes");
    if ("error" in result) throw new Error(result.error);
    expect(result.sort).toBe("created_desc");
  });

  it("clamps the page size and understands the export formats", () => {
    const result = parse("limit=9000&format=xlsx");
    if ("error" in result) throw new Error(result.error);
    expect(result.limit).toBe(500);
    expect(result.format).toBe("xlsx");
    expect(parse("format=pdf")).toEqual({ error: "bad_request" });
  });

  it("refuses a non-empty cursor it cannot decode instead of restarting the page", () => {
    expect(parse("cursor=%%%not-a-cursor")).toEqual({ error: "invalid_cursor" });
  });
});

describe("the register cursor", () => {
  it("round-trips a sort + key + id", () => {
    const encoded = encodeWarehouseRegisterCursor({ sort: "amount_desc", key: "12000", id: UUID });
    expect(decodeWarehouseRegisterCursor(encoded, "amount_desc")).toEqual({
      sort: "amount_desc",
      key: "12000",
      id: UUID,
    });
  });

  it("still decodes the sort-less (createdAt, id) cursor from the previous release", () => {
    const legacy = Buffer.from(`2026-03-21T10:00:00.000Z|${UUID}`).toString("base64url");
    expect(decodeWarehouseRegisterCursor(legacy, "created_desc")).toEqual({
      sort: "created_desc",
      key: "2026-03-21T10:00:00.000Z",
      id: UUID,
    });
    // It cannot describe a page of a differently-ordered register.
    expect(decodeWarehouseRegisterCursor(legacy, "amount_desc")).toBeNull();
  });

  it("refuses a cursor whose sort does not match the request", () => {
    const encoded = encodeWarehouseRegisterCursor({ sort: "date_asc", key: "2026-03-21", id: UUID });
    expect(decodeWarehouseRegisterCursor(encoded, "date_desc")).toBeNull();
  });

  it("validates the key's shape against the sort", () => {
    expect(decodeWarehouseRegisterCursor(encodeWarehouseRegisterCursor({ sort: "date_desc", key: "nope", id: UUID }), "date_desc")).toBeNull();
    expect(decodeWarehouseRegisterCursor(encodeWarehouseRegisterCursor({ sort: "created_asc", key: "2026-03-21", id: UUID }), "created_asc")).toBeNull();
    expect(decodeWarehouseRegisterCursor(encodeWarehouseRegisterCursor({ sort: "amount_asc", key: "-1", id: UUID }), "amount_asc")).toBeNull();
  });

  it("rejects a malformed id", () => {
    expect(decodeWarehouseRegisterCursor(encodeWarehouseRegisterCursor({ sort: "created_desc", key: "2026-03-21T10:00:00Z", id: "x" }), "created_desc")).toBeNull();
  });
});

describe("the sort SQL", () => {
  it("orders and compares in the same direction", () => {
    expect(orderBySql("created_desc", "d.created_at", "d")).toBe("d.created_at DESC, d.id DESC");
    expect(orderBySql("amount_asc", "COALESCE(d.total_value_rial, 0)", "d")).toBe(
      "COALESCE(d.total_value_rial, 0) ASC, d.id ASC",
    );
    expect(keysetSql("created_desc", "d.created_at", "d", "$1", "$2")).toBe(
      "(d.created_at, d.id) < ($1, $2)",
    );
    expect(keysetSql("amount_asc", "COALESCE(d.total_value_rial, 0)", "d", "$1", "$2")).toBe(
      "(COALESCE(d.total_value_rial, 0), d.id) > ($1, $2)",
    );
  });

  it("projects a cursor key the decoder accepts, not Postgres's display text", () => {
    // `timestamptz::text` is `2026-10-22 09:00:00+00` — no `T`, no `Z`, and the
    // cursor decoder refuses it, which would break paging on the default sort.
    const created = sortKeyTextSql("created_desc");
    expect(created).toContain('YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
    expect(created).toContain("AT TIME ZONE 'UTC'");
    expect(sortKeyTextSql("date_desc")).toContain("to_char(");
    expect(sortKeyTextSql("amount_desc")).toBe("COALESCE(d.total_value_rial, 0)::text");
    // A key in the shape the projection emits round-trips through the cursor.
    expect(
      decodeWarehouseRegisterCursor(
        encodeWarehouseRegisterCursor({
          sort: "created_desc",
          key: "2026-10-22T09:00:00.123456Z",
          id: UUID,
        }),
        "created_desc",
      ),
    ).not.toBeNull();
    // …while the raw column text does not.
    expect(
      decodeWarehouseRegisterCursor(
        encodeWarehouseRegisterCursor({
          sort: "created_desc",
          key: "2026-10-22 09:00:00.123456+00",
          id: UUID,
        }),
        "created_desc",
      ),
    ).toBeNull();
  });

  it("values a missing amount at zero so legacy rows sort and filter sanely", () => {
    expect(sortKeySql("amount_desc")).toContain("COALESCE(d.total_value_rial, 0)");
  });
});

describe("the branch-aware business date", () => {
  it("is the location's day, not the database session's", () => {
    const sql = businessDateSql();
    expect(sql).toContain("app_business_date");
    expect(sql).toContain("l.timezone");
    expect(sql).toContain("l.business_day_start_minutes");
    expect(sql).not.toContain("created_at::date");
  });
});

describe("the export table", () => {
  const row = {
    id: UUID,
    kind: "receipt",
    location_id: UUID,
    location_name: "انبار مرکزی",
    location_timezone: "Asia/Tehran",
    supplier_name: "تأمین‌کننده",
    recipient: null,
    document_number: null,
    internal_voucher_number: "R-12",
    voucher_number: "R-12",
    business_date: "2026-03-21",
    reversed_of: null,
    is_reversal: false,
    created_by_name: "مریم",
    note: "یادداشت",
    total_value_rial: "1200000",
    created_at: "2026-03-21T10:00:00Z",
    line_count: 2,
    sort_key: "2026-03-21T10:00:00Z",
  } as WarehouseRegisterRow;

  it("carries the screen's columns, the business unit and branch-kind labels", () => {
    const table = registerExportTable([row], "تومان", "csv", {
      toDisplayAmount: (rial) => rial,
      formatDate: (date) => date,
      kindLabel: (kind) => (kind === "receipt" ? "رسید" : kind),
    });
    expect(table.columns.map((c) => c.key)).toEqual([
      "voucher",
      "date",
      "kind",
      "location",
      "party",
      "lines",
      "amount",
      "actor",
      "reversal",
      "note",
    ]);
    expect(table.columns.find((c) => c.key === "amount")?.label).toBe("مبلغ (تومان)");
    expect(table.rows[0]).toMatchObject({
      voucher: "R-12",
      kind: "رسید",
      party: "تأمین‌کننده",
      amount: "1200000",
      actor: "مریم",
    });
  });

  it("labels a reversal by the voucher it reverses", () => {
    const reversal = { ...row, is_reversal: true, reversed_of: UUID } as WarehouseRegisterRow;
    const table = registerExportTable([reversal], "تومان", "xlsx", {
      toDisplayAmount: (rial) => rial,
      formatDate: (date) => date,
      kindLabel: (kind) => kind,
    });
    expect(table.rows[0].reversal).toContain(UUID);
  });
});

describe("isWarehouseRegisterSort", () => {
  it("knows exactly the six sorts", () => {
    expect(isWarehouseRegisterSort("created_desc")).toBe(true);
    expect(isWarehouseRegisterSort("amount_asc")).toBe(true);
    expect(isWarehouseRegisterSort("voucher_asc")).toBe(false);
  });
});
