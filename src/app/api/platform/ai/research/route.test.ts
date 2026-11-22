import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #1367 — the platform Deep Research switches are read-only.
 *
 * A tenant can never reach this route (it takes a platform capability), and
 * after the retirement not even Superadmin can change the caps: there is no new
 * run for a cap to apply to. The GET stays so the caps a historical run was
 * created under remain answerable for audit.
 */
const requirePlatformCapability = vi.fn();
vi.mock("@/lib/platform-auth", () => ({
  requirePlatformCapability: (...args: unknown[]) => requirePlatformCapability(...args),
}));

const getResearchPlatformSettings = vi.fn(async () => ({
  enabled: true,
  modelAlias: "pos-deep-research",
  maxRounds: 4,
  maxContextBytes: 2_000_000,
  ttlHours: 24,
  maxSpendRial: 0,
  minDataReadiness: 1,
  externalWeb: false,
}));
vi.mock("@/lib/ai-control-plane", () => ({
  getResearchPlatformSettings: () => getResearchPlatformSettings(),
  // Deliberately present in the mock: the retired route must not call it, and
  // the assertion below proves it does not.
  updateResearchPlatformSettings: vi.fn(),
}));

function capability(capabilityName: string) {
  requirePlatformCapability.mockImplementation(async (asked: string) =>
    asked === capabilityName
      ? { session: { email: "admin@example.test" } }
      : {
          error: NextResponse.json({ error: "forbidden" }, { status: 403 }),
        },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  capability("ai.read");
});

describe("issue #1367 — /api/platform/ai/research", () => {
  it("refuses a PUT with 410 and never writes a cap", async () => {
    capability("ai.config.manage");
    const { PUT } = await import("./route");
    const { updateResearchPlatformSettings } = await import("@/lib/ai-control-plane");

    const res = await PUT(
      new NextRequest("http://localhost/api/platform/ai/research", {
        method: "PUT",
        body: JSON.stringify({ enabled: true, maxRounds: 12 }),
      }),
    );

    expect(res.status).toBe(410);
    await expect(res.json()).resolves.toMatchObject({
      error: "research_retired",
      supersededBy: ["auto", "instant", "thinking"],
    });
    expect(updateResearchPlatformSettings).not.toHaveBeenCalled();
  });

  it("keeps the historical settings readable for audit with ai.read", async () => {
    const { GET } = await import("./route");
    const res = await GET();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      retired: true,
      settings: { modelAlias: "pos-deep-research", maxRounds: 4 },
    });
  });

  it("answers 403 before the retirement when the platform capability is absent", async () => {
    capability("something.else");
    const { GET, PUT } = await import("./route");

    expect((await GET()).status).toBe(403);
    expect(
      (
        await PUT(
          new NextRequest("http://localhost/api/platform/ai/research", {
            method: "PUT",
            body: JSON.stringify({ enabled: true }),
          }),
        )
      ).status,
    ).toBe(403);
  });
});
