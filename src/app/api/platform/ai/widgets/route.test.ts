/**
 * Issue #799 §22 — the platform widget-catalogue route's boundary.
 *
 * The service is covered against a real database in
 * `integration/ai-widget-admin.integration.test.ts`; what is asserted here is
 * the part a reviewer of the console cares about: reading rides `ai.read`,
 * every write rides `ai.config.manage` (so an AI reader cannot rewrite what
 * every tenant of an industry is offered), a malformed id is a 404 rather than
 * a Postgres cast error, and the audit entry is written with the admin who did
 * it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "./route";
import { PATCH } from "./[id]/route";
import { listAiWidgetTemplates, saveAiWidgetTemplate, setAiWidgetTemplateEnabled } from "@/lib/ai-widget-admin";
import { requirePlatformAdmin, requirePlatformCapability } from "@/lib/platform-auth";

vi.mock("@/lib/platform-auth", () => ({
  requirePlatformAdmin: vi.fn(async () => ({ session: { padmin: "admin-1", role: "owner" } })),
  requirePlatformCapability: vi.fn(async (cap: string) => {
    if (cap === "ai.config.manage") {
      return { session: { padmin: "admin-1", role: "owner" } };
    }
    return { error: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }) };
  }),
  withPlatformScope: (fn: (req: NextRequest, ctx?: unknown) => Promise<Response>) => fn,
  platformAudit: vi.fn(async () => {}),
}));

vi.mock("@/lib/ai-widget-admin", () => ({
  listAiWidgetTemplates: vi.fn(async () => [
    {
      id: "11111111-1111-1111-1111-111111111111",
      name: "نقاط عطف پیش رو",
      description: "",
      industry: "architecture_construction",
      sourceApp: "workspace",
      prompt: "…",
      outputFormat: "bullets",
      requiredPermissions: ["workspace.view"],
      defaultWidth: 2,
      defaultHeight: 1,
      enabled: true,
      createdBy: "system",
      createdAt: "2026-10-04T00:00:00.000Z",
      updatedAt: "2026-10-04T00:00:00.000Z",
    },
  ]),
  saveAiWidgetTemplate: vi.fn(async () => ({
    ok: true as const,
    template: {
      id: "22222222-2222-2222-2222-222222222222",
      name: "حاشیهٔ پروژه",
      description: "",
      industry: "architecture_construction",
      sourceApp: "workspace",
      prompt: "…",
      outputFormat: "metric",
      requiredPermissions: ["workspace.view"],
      defaultWidth: 2,
      defaultHeight: 1,
      enabled: true,
      createdBy: "platform:admin-1",
      createdAt: "2026-10-04T00:00:00.000Z",
      updatedAt: "2026-10-04T00:00:00.000Z",
    },
  })),
  setAiWidgetTemplateEnabled: vi.fn(async (_id: string, enabled: boolean) => ({
    id: "11111111-1111-1111-1111-111111111111",
    name: "نقاط عطف پیش رو",
    description: "",
    industry: "architecture_construction",
    sourceApp: "workspace",
    prompt: "…",
    outputFormat: "bullets",
    requiredPermissions: ["workspace.view"],
    defaultWidth: 2,
    defaultHeight: 1,
    enabled,
    createdBy: "system",
    createdAt: "2026-10-04T00:00:00.000Z",
    updatedAt: "2026-10-04T00:00:00.000Z",
  })),
  widgetTemplateIndustryOptions: () => [
    { value: "all", label: "همهٔ کسب‌وکارها" },
    { value: "architecture_construction", label: "مهندسی عمران، معماری و پیمانکاری" },
  ],
}));

import { platformAudit } from "@/lib/platform-auth";

beforeEach(() => {
  // Call counts, not implementations: every test asserts what *it* triggered,
  // and the `not.toHaveBeenCalled` below would otherwise see its neighbour's call.
  vi.clearAllMocks();
});

function jsonRequest(body: unknown): NextRequest {
  return new NextRequest(new URL("http://localhost:3000/api/platform/ai/widgets"), {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("the platform recommended-widgets route", () => {
  it("lists the catalogue for any admin, with the industry labels", async () => {
    const response = await GET();
    const body = (await response.json()) as { templates: unknown[]; industries: unknown[] };
    expect(response.status).toBe(200);
    expect(body.templates).toHaveLength(1);
    expect(body.industries.length).toBeGreaterThan(0);
    expect(requirePlatformAdmin).toHaveBeenCalled();
  });

  it("writes only with ai.config.manage, and audits the create", async () => {
    const response = await POST(jsonRequest({ name: "حاشیهٔ پروژه", prompt: "…" }));
    expect(response.status).toBe(201);
    expect(requirePlatformCapability).toHaveBeenCalledWith("ai.config.manage");
    expect(saveAiWidgetTemplate).toHaveBeenCalledWith(
      "admin-1",
      expect.objectContaining({ name: "حاشیهٔ پروژه" }),
    );
    expect(platformAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ai_widget_template.create", entity: "ai_widget_templates" }),
    );
  });

  it("refuses a malformed id with 404 rather than a database cast error", async () => {
    const response = await POST(jsonRequest({ id: "not-a-uuid", name: "x", prompt: "y" }));
    expect(response.status).toBe(404);
    expect(saveAiWidgetTemplate).not.toHaveBeenCalled();
  });

  it("offers and retires through PATCH, and audits which way it went", async () => {
    const enabled = await PATCH(
      new NextRequest(new URL("http://localhost:3000/api/platform/ai/widgets/11111111-1111-1111-1111-111111111111"), {
        method: "PATCH",
        body: JSON.stringify({ enabled: true }),
      }),
      { params: Promise.resolve({ id: "11111111-1111-1111-1111-111111111111" }) },
    );
    expect(enabled.status).toBe(200);
    expect(setAiWidgetTemplateEnabled).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
      true,
    );
    expect(platformAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "ai_widget_template.enable" }),
    );

    const bad = await PATCH(
      new NextRequest(new URL("http://localhost:3000/api/platform/ai/widgets/11111111-1111-1111-1111-111111111111"), {
        method: "PATCH",
        body: JSON.stringify({ enabled: "yes" }),
      }),
      { params: Promise.resolve({ id: "11111111-1111-1111-1111-111111111111" }) },
    );
    expect(bad.status).toBe(400);
  });
});
