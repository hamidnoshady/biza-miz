/**
 * Issue #1546 (Fast truthfulness) — the mode picker's discovery payload.
 *
 * The picker may only disable a mode when the server said so, and must fail open
 * otherwise: a broken or older response cannot be allowed to hide a working
 * mode. These tests pin both halves, plus the deliberate absence of provider
 * detail in the payload the browser receives.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { GET } from "./route";

vi.mock("@/lib/auth", () => ({
  withTenantScope: (fn: () => Promise<Response>) => fn,
  requirePermission: vi.fn(async () => ({
    session: { businessId: "biz-1", sub: "user-1", locationId: null },
    error: null,
  })),
}));

const query = vi.fn();
vi.mock("@/lib/db", () => ({
  query: (...args: unknown[]) => query(...args),
}));

const row = (mode: string, overrides: Record<string, unknown> = {}) => ({
  mode_key: mode,
  model_alias: "",
  is_active: true,
  temperature: null,
  max_output_tokens: null,
  prompt_scope_key: `mode:${mode}`,
  ...overrides,
});

describe("issue #1546 — /api/ai/modes reports which chat modes are configured", () => {
  beforeEach(() => {
    query.mockReset();
  });

  it("marks Fast unavailable when it has no alias, and says why without naming the alias", async () => {
    query.mockResolvedValue({ rows: [row("auto"), row("instant"), row("thinking")] });

    const response = await GET();
    const body = (await response.json()) as {
      modes: Array<{ mode: string; available: boolean; reason: string | null }>;
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body.modes).toEqual([
      { mode: "auto", available: true, reason: null },
      { mode: "instant", available: false, reason: "fast_alias_not_configured" },
      { mode: "thinking", available: true, reason: null },
    ]);
    // No provider detail: the alias never travels to the browser.
    expect(JSON.stringify(body)).not.toContain("model_alias");
    expect(JSON.stringify(body)).not.toContain("prompt_scope_key");
  });

  it("offers Fast once it names its own alias, and hides a mode switched off in the console", async () => {
    query.mockResolvedValue({
      rows: [
        row("auto", { model_alias: "pos-auto" }),
        row("instant", { model_alias: "pos-instant" }),
        row("thinking", { model_alias: "pos-thinking", is_active: false }),
      ],
    });

    const body = (await (await GET()).json()) as {
      modes: Array<{ mode: string; available: boolean; reason: string | null }>;
    };

    expect(body.modes).toEqual([
      { mode: "auto", available: true, reason: null },
      { mode: "instant", available: true, reason: null },
      { mode: "thinking", available: false, reason: "disabled" },
    ]);
    // The alias itself is still not echoed, only the availability decision.
    expect(JSON.stringify(body)).not.toContain("pos-instant");
  });

  it("keeps the console's default when the settings table has never been written", async () => {
    query.mockResolvedValue({ rows: [] });

    const body = (await (await GET()).json()) as {
      modes: Array<{ mode: string; available: boolean; reason: string | null }>;
    };

    expect(body.modes).toEqual([
      { mode: "auto", available: true, reason: null },
      { mode: "instant", available: false, reason: "fast_alias_not_configured" },
      { mode: "thinking", available: true, reason: null },
    ]);
  });
});
