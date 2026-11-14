import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({ query: vi.fn() }));

import { query } from "./db";
import { updatePlatformAiMode } from "./ai-control-plane";
import { getPlatformAiMode } from "./ai-runtime-modes";

const databaseRow = {
  mode_key: "auto",
  model_alias: "pos-auto",
  is_active: true,
  temperature: null,
  max_output_tokens: null,
  prompt_scope_key: "mode:auto",
  updated_by: "admin@example.test",
};

beforeEach(() => {
  vi.mocked(query).mockReset();
  vi.mocked(query).mockResolvedValue({ rows: [databaseRow] } as never);
});

describe("Superadmin mode overrides — null restores gateway defaults", () => {
  it("writes SQL NULL for an explicitly cleared temperature and token limit", async () => {
    const saved = await updatePlatformAiMode({
      mode: "auto",
      temperature: null,
      maxOutputTokens: null,
      updatedBy: "admin@example.test",
    });

    expect(saved?.temperature).toBeNull();
    expect(saved?.maxOutputTokens).toBeNull();

    const [sql, params] = vi.mocked(query).mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("temperature = $3");
    expect(sql).toContain("max_output_tokens = $4");
    expect(params).toEqual(["auto", "admin@example.test", null, null]);
  });

  it("leaves overrides untouched when they are omitted", async () => {
    await updatePlatformAiMode({ mode: "auto", modelAlias: "  pos-thinking  ", updatedBy: "admin@example.test" });
    const [sql, params] = vi.mocked(query).mock.calls[0] as [string, unknown[]];
    expect(sql).not.toContain("temperature = ");
    expect(sql).not.toContain("max_output_tokens = ");
    expect(params).toEqual(["auto", "admin@example.test", "pos-thinking"]);
  });

  it("rejects invalid values before touching the database", async () => {
    expect(await updatePlatformAiMode({ mode: "auto", temperature: 3, updatedBy: "admin@example.test" })).toBeNull();
    expect(await updatePlatformAiMode({ mode: "auto", maxOutputTokens: 0, updatedBy: "admin@example.test" })).toBeNull();
    expect(await updatePlatformAiMode({ mode: "auto", modelAlias: "bad alias", updatedBy: "admin@example.test" })).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it("allows valid boundary values", async () => {
    await updatePlatformAiMode({ mode: "auto", temperature: 0, maxOutputTokens: 200000, updatedBy: "admin@example.test" });
    expect(vi.mocked(query).mock.calls[0]?.[1]).toEqual(["auto", "admin@example.test", 0, 200000]);
  });
});

describe("tenant mode settings read from PostgreSQL", () => {
  it("converts a numeric temperature to a number and preserves SQL NULL", async () => {
    vi.mocked(query).mockResolvedValueOnce({ rows: [{ ...databaseRow, temperature: "0.25" }] } as never);
    expect((await getPlatformAiMode("auto")).temperature).toBe(0.25);
    expect((await getPlatformAiMode("auto")).temperature).toBeNull();
  });
});
