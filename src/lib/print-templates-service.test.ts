/**
 * The branch's saved templates — the write boundary issue #815 cares about
 * (F1: a saved template must be what the till prints, and F16: its version must
 * move so print history can name the exact revision).
 *
 * The database is mocked; the parser, the paper/document-type matrix and the
 * version arithmetic are real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as db from "./db";
import { listPrintTemplates } from "./print-templates-service";
import { createPrintTemplate, deletePrintTemplate, updatePrintTemplate } from "./print-templates-service";

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return { ...actual, query: vi.fn() };
});

const VALID_TEMPLATE = {
  name: "قالب من",
  docType: "receipt",
  paper: "thermal80",
  options: { fontScale: 1, lineHeight: 1.5, marginMm: 3, bodyWeight: 400, showUnit: true, copies: 1 },
  blocks: [{ id: "b1", type: "businessName", visible: true }],
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "tpl-1",
    name: "قالب من",
    doc_type: "receipt",
    paper: "thermal80",
    layout: { options: VALID_TEMPLATE.options, blocks: VALID_TEMPLATE.blocks },
    is_default: false,
    version: 3,
    updated_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.query).mockResolvedValue({ rows: [row()], rowCount: 1 } as never);
});

describe("createPrintTemplate", () => {
  it("stores the parsed layout and reports the row back", async () => {
    const result = await createPrintTemplate({ locationId: "loc-1", template: VALID_TEMPLATE });
    expect(result.error).toBeUndefined();
    expect(result.template).toMatchObject({ id: "tpl-1", docType: "receipt", paper: "thermal80" });
    const [sql, params] = vi.mocked(db.query).mock.calls[0] as [string, unknown[]];
    expect(String(sql)).toContain("INSERT INTO print_templates");
    expect(params[0]).toBe("loc-1");
    const stored = JSON.parse(String(params[4])) as { options: Record<string, unknown>; blocks: { id: string; type: string }[] };
    // The parsed, normalised shape — blocks equal to what was sent, options
    // filled in with the defaults the renderer expects.
    expect(stored.blocks.map((block) => ({ id: block.id, type: block.type }))).toEqual([{ id: "b1", type: "businessName" }]);
    expect(stored.options).toMatchObject(VALID_TEMPLATE.options);
  });

  it("refuses a layout the renderer could not draw", async () => {
    const result = await createPrintTemplate({
      locationId: "loc-1",
      template: { ...VALID_TEMPLATE, blocks: [{ id: "x", type: "hologram", visible: true }] },
    });
    expect(result.error).toBe("invalid_template");
    expect(db.query).not.toHaveBeenCalled();
  });

  it("refuses a document type its paper cannot carry", async () => {
    // A receipt layout on A4, and an invoice layout on a roll: both are
    // layouts the pipeline can never print.
    expect((await createPrintTemplate({ locationId: "loc-1", template: { ...VALID_TEMPLATE, paper: "a4" } })).error).toBe(
      "incompatible_template",
    );
    expect(
      (
        await createPrintTemplate({
          locationId: "loc-1",
          template: { ...VALID_TEMPLATE, docType: "invoice", paper: "thermal80" },
        })
      ).error,
    ).toBe("incompatible_template");
    // …while the label document happily takes a thermal roll (a sticker on a
    // receipt printer) and the label roll.
    expect((await createPrintTemplate({ locationId: "loc-1", template: { ...VALID_TEMPLATE, docType: "label", paper: "thermal58" } })).template).toBeTruthy();
    expect((await createPrintTemplate({ locationId: "loc-1", template: { ...VALID_TEMPLATE, docType: "label", paper: "label57x40" } })).template).toBeTruthy();
  });

  it("clears the previous default of the same document type inside the same write", async () => {
    await createPrintTemplate({ locationId: "loc-1", template: VALID_TEMPLATE, isDefault: true });
    const [clearSql, clearParams] = vi.mocked(db.query).mock.calls[0] as [string, unknown[]];
    expect(String(clearSql)).toContain("SET is_default = false");
    expect(clearParams).toEqual(["loc-1", "receipt", null]);
    expect(String(vi.mocked(db.query).mock.calls[1][0])).toContain("INSERT INTO print_templates");
  });

  it("maps a duplicate name to its own error instead of throwing", async () => {
    vi.mocked(db.query).mockRejectedValue(Object.assign(new Error("duplicate key"), { code: "23505" }) as never);
    expect((await createPrintTemplate({ locationId: "loc-1", template: VALID_TEMPLATE })).error).toBe("duplicate_template_name");
  });
});

describe("updatePrintTemplate — every write is a new revision", () => {
  it("bumps the version and re-stamps it on the row", async () => {
    vi.mocked(db.query).mockImplementation((async (sql: string) =>
      String(sql).includes("SET name =")
        ? { rows: [row({ version: 4 })], rowCount: 1 }
        : { rows: [row({ version: 3 })], rowCount: 1 }) as never);
    const result = await updatePrintTemplate({ locationId: "loc-1", id: "tpl-1", template: { ...VALID_TEMPLATE, name: "قالب جدید" } });
    const update = vi.mocked(db.query).mock.calls.find(([sql]) => String(sql).includes("SET name ="));
    expect(String(update?.[0])).toContain("version = version + 1");
    expect(result.template?.version).toBe(4);
  });

  it("refuses an unknown row and a template of a different document type than its paper allows", async () => {
    vi.mocked(db.query).mockResolvedValue({ rows: [], rowCount: 0 } as never);
    expect((await updatePrintTemplate({ locationId: "loc-1", id: "gone", template: VALID_TEMPLATE })).error).toBe("template_not_found");
    vi.mocked(db.query).mockResolvedValue({ rows: [row()], rowCount: 1 } as never);
    expect(
      (await updatePrintTemplate({ locationId: "loc-1", id: "tpl-1", template: { ...VALID_TEMPLATE, paper: "a5" } })).error,
    ).toBe("incompatible_template");
  });

  it("keeps a row's own defaultness when the caller does not mention it", async () => {
    vi.mocked(db.query).mockResolvedValue({ rows: [row({ is_default: true })], rowCount: 1 } as never);
    await updatePrintTemplate({ locationId: "loc-1", id: "tpl-1", template: VALID_TEMPLATE });
    // The row-upsert statement, not the default-clearing one that shares its prefix.
    const update = vi.mocked(db.query).mock.calls.find(([sql]) => String(sql).includes("SET name ="));
    expect((update?.[1] as unknown[])[4]).toBe(true);
    // Whatever clearing happens must exclude the row itself.
    const clearCall = vi.mocked(db.query).mock.calls.find(([sql]) => String(sql).includes("SET is_default = false"));
    expect((clearCall?.[1] as unknown[])[2]).toBe("tpl-1");
  });

  it("clears the document type's previous default when this write makes the row the default", async () => {
    vi.mocked(db.query).mockImplementation((async (sql: string) =>
      String(sql).includes("SET name =")
        ? { rows: [row({ is_default: true })], rowCount: 1 }
        : { rows: [row({ is_default: false })], rowCount: 1 }) as never);
    await updatePrintTemplate({ locationId: "loc-1", id: "tpl-1", template: VALID_TEMPLATE, isDefault: true });
    const clearCall = vi.mocked(db.query).mock.calls.find(([sql]) => String(sql).includes("SET is_default = false"));
    expect(clearCall?.[1]).toEqual(["loc-1", "receipt", "tpl-1"]);
  });
});

describe("listPrintTemplates / deletePrintTemplate", () => {
  it("maps rows into the shared template shape, version included", async () => {
    vi.mocked(db.query).mockResolvedValue({
      rows: [row({ id: "tpl-default", is_default: true, version: 7 }), row({ id: "tpl-58", paper: "thermal58" })],
      rowCount: 2,
    } as never);
    const rows = await listPrintTemplates("loc-1");
    expect(rows.map((t) => t.id)).toEqual(["tpl-default", "tpl-58"]);
    expect(rows[0]).toMatchObject({ isDefault: true, version: 7, docType: "receipt", paper: "thermal80" });
    // A row a hand-edit left unparsable is dropped rather than rendered.
    vi.mocked(db.query).mockResolvedValue({ rows: [row({ paper: "a9" }), row()], rowCount: 2 } as never);
    expect((await listPrintTemplates("loc-1")).map((t) => t.id)).toEqual(["tpl-1"]);
  });

  it("deletes scoped to the branch and reports whether anything went", async () => {
    vi.mocked(db.query).mockResolvedValue({ rows: [], rowCount: 1 } as never);
    expect(await deletePrintTemplate("loc-1", "tpl-1")).toBe(true);
    expect(vi.mocked(db.query).mock.calls[0][1]).toEqual(["tpl-1", "loc-1"]);
    vi.mocked(db.query).mockResolvedValue({ rows: [], rowCount: 0 } as never);
    expect(await deletePrintTemplate("loc-1", "someone-elses")).toBe(false);
  });
});
