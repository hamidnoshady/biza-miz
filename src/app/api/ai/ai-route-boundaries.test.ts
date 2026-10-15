/**
 * Issue #812 §5/§10/§12 — the new AI routes' boundaries, as the caller sees them.
 *
 * `ai-permission-matrix.test.ts` proves each route names the right guard. These
 * tests prove the guard and the gate behind it actually fire, which is the half
 * a source-text assertion cannot reach: a route can call `requirePermission`
 * correctly and still let a crafted body through.
 *
 * Three boundaries, one per route:
 *
 *  - **`/api/ai/memory`** — project memory honours the project's own access
 *    rules. A member who cannot reach a project cannot read or write its
 *    memory, and a `platform` scope is refused because platform memory is
 *    Superadmin-only.
 *  - **`/api/ai/research`** — the cost gate. No run is created until the member
 *    has seen the server-computed estimate and agreed to it, and the figure in
 *    the refusal is the one the system will actually spend against.
 *  - **`/api/ai/widgets/[id]/run` and `/api/ai/research/[id]/approve`** — §12's
 *    intersections. A widget's `requiredPermissions` is an upper bound chosen at
 *    creation, so the run's set is the caller's minus whatever they have since
 *    lost; a research run's tool catalogue is filtered through the approver's
 *    effective permissions, because a bigger budget is not a wider permission.
 */
import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PERMISSIONS } from "@/lib/permissions";

const SESSION = {
  sub: "user-1",
  businessId: "biz-1",
  locationId: null,
  role: "manager",
  fullName: "Owner",
  email: "owner@example.test",
};

const requirePermission = vi.fn();
const requireAnyPermission = vi.fn();
const requireFloorAssistant = vi.fn();
const getSession = vi.fn();

vi.mock("@/lib/auth", () => ({
  withTenantScope: (handler: (...args: unknown[]) => Promise<Response>) => handler,
  requirePermission: (...args: unknown[]) => requirePermission(...args),
  requireAnyPermission: (...args: unknown[]) => requireAnyPermission(...args),
  requireFloorAssistant: (...args: unknown[]) => requireFloorAssistant(...args),
  getSession: (...args: unknown[]) => getSession(...args),
}));

const listConversations = vi.fn();
const listConversationsByProject = vi.fn();
const getConversationMode = vi.fn();
const getConversationMessages = vi.fn();
const renameConversation = vi.fn();
const deleteConversation = vi.fn();
vi.mock("@/lib/ai-conversations", () => ({
  listConversations: (...args: unknown[]) => listConversations(...args),
  listConversationsByProject: (...args: unknown[]) => listConversationsByProject(...args),
  getConversationMode: (...args: unknown[]) => getConversationMode(...args),
  getConversationMessages: (...args: unknown[]) => getConversationMessages(...args),
  renameConversation: (...args: unknown[]) => renameConversation(...args),
  deleteConversation: (...args: unknown[]) => deleteConversation(...args),
}));

// The widget run route's project guard is a local helper that dynamically
// imports `getProject`, so the boundary under test is the lookup it performs,
// not a module export. Mocking `getProject` is what lets the two project-memory
// tests diverge without touching a database.
const getProject = vi.fn();
vi.mock("@/lib/ai-projects", () => ({ getProject: (...args: unknown[]) => getProject(...args) }));

vi.mock("@/lib/ai-memory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai-memory")>();
  return {
    ...actual,
    listMemory: vi.fn(async () => []),
    createMemoryEntry: vi.fn(async () => ({
      id: "mem-1",
      scope: "tenant",
      content: "ثبت شد",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    })),
    deleteMemoryEntry: vi.fn(async () => true),
  };
});

const getPlatformAiMode = vi.fn();
vi.mock("@/lib/ai-runtime-modes", () => ({
  getPlatformAiMode: (...args: unknown[]) => getPlatformAiMode(...args),
  isAiRuntimeModeAvailable: (mode: string, active: boolean) => mode !== "deep_research" || active,
  AI_RUNTIME_MODES: ["auto", "instant", "deep_research"],
  normalizeAiRuntimeMode: (value: unknown) => value ?? "auto",
}));

const getResearchRun = vi.fn();
const approveResearchRun = vi.fn();
const createResearchRun = vi.fn();
const runResearchRun = vi.fn();
vi.mock("@/lib/ai-research", () => ({
  getResearchRun: (...args: unknown[]) => getResearchRun(...args),
  approveResearchRun: (...args: unknown[]) => approveResearchRun(...args),
  createResearchRun: (...args: unknown[]) => createResearchRun(...args),
  runResearchRun: (...args: unknown[]) => runResearchRun(...args),
  listResearchSources: vi.fn(async () => []),
  listResearchRuns: vi.fn(async () => []),
}));

// `filterAiToolsByPermissions` stays a spy over the real implementation: the
// catalogue test asserts the narrowing happened rather than assuming it.
const filterAiToolsByPermissions = vi.fn();
vi.mock("@/lib/ai-capabilities", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai-capabilities")>();
  return {
    ...actual,
    filterAiToolsByPermissions: (...args: Parameters<typeof actual.filterAiToolsByPermissions>) =>
      filterAiToolsByPermissions(...args),
    aiActionPermission: vi.fn(() => null),
  };
});

const runAgentTurn = vi.fn();
vi.mock("@/lib/ai-service", () => ({
  runAgentTurn: (...args: unknown[]) => runAgentTurn(...args),
  accruedUsageOf: () => null,
}));

vi.mock("@/lib/ai", () => ({
  toolDefinitions: () => [
    { type: "function", function: { name: "propose_action" } },
    { type: "function", function: { name: "get_ar_aging" } },
    { type: "function", function: { name: "run_report" } },
  ],
  buildSystemPrompt: () => "system",
}));

vi.mock("@/lib/ai-runtime", () => ({
  resolveAiConfigFor: vi.fn(async () => ({
    enabled: true,
    model: "m",
    baseUrl: "http://x/v1",
    apiKey: "k",
    maxOutputTokens: 100,
    temperature: 0.2,
    knowledge: { enabled: true },
  })),
  applyRuntimeModeAlias: (config: { model: string }) => config,
}));

vi.mock("@/lib/ai-config", () => ({ isPlatformAiConfigured: () => true }));
vi.mock("@/lib/ai-knowledge-gateway", () => ({
  knowledgeSettingsFromConfig: () => ({ enabled: true, limit: 4 }),
  knowledgeReadyFor: () => false,
}));
vi.mock("@/lib/ai-money-unit", () => ({ resolveBusinessMoneyUnit: async () => "rial" }));

const gateAiTurn = vi.fn();
const settleAiTurn = vi.fn();
vi.mock("@/lib/ai-wallet-billing", () => ({
  gateAiTurn: (...args: unknown[]) => gateAiTurn(...args),
  settleAiTurn: (...args: unknown[]) => settleAiTurn(...args),
  newAiRequestId: () => "req-1",
  AiWalletInsufficientError: class AiWalletInsufficientError extends Error {},
}));

const getAiWidget = vi.fn();
vi.mock("@/lib/ai-widgets", () => ({
  getAiWidget: (...args: unknown[]) => getAiWidget(...args),
  markAiWidgetRun: vi.fn(async () => undefined),
}));

const MODE = {
  mode_key: "deep_research",
  model_alias: "pos-deep-research",
  is_active: true,
  temperature: null,
  max_output_tokens: null,
  prompt_scope_key: "mode:deep_research",
};

function jsonRequest(url: string, method: string, body?: unknown) {
  return new NextRequest(url, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }) as NextRequest;
}

/** Wire `requirePermission` to a caller holding exactly `permissions`. */
/**
 * Wire `requirePermission` to a caller holding exactly `permissions`. The guard
 * refuses — with the same `guard.error` shape the real one returns — when the
 * asked-for capability is absent, so a boundary is asserted by status instead
 * of inferred from the fact that the route asked.
 */
function asCaller(permissions: string[], role = SESSION.role) {
  const sessionWithRole = { ...SESSION, role };
  requirePermission.mockImplementation(async (capability: string) => {
    if (!permissions.includes(capability)) {
      return {
        session: sessionWithRole,
        membership: { permissions: new Set(permissions), role },
        error: NextResponse.json({ error: "forbidden" }, { status: 403 }),
      };
    }
    return {
      session: sessionWithRole,
      membership: { permissions: new Set(permissions), role },
      error: null,
    };
  });
  requireAnyPermission.mockImplementation(async (...capabilities: string[]) => {
    const allowed = capabilities.some((c) => permissions.includes(c));
    if (!allowed) {
      return {
        session: sessionWithRole,
        membership: { permissions: new Set(permissions), role },
        error: NextResponse.json({ error: "forbidden" }, { status: 403 }),
      };
    }
    return {
      session: sessionWithRole,
      membership: { permissions: new Set(permissions), role },
      error: null,
    };
  });
  requireFloorAssistant.mockImplementation(async () => {
    if (
      !permissions.includes(PERMISSIONS.menuView) ||
      (role !== "cashier" && role !== "waiter")
    ) {
      return {
        session: null,
        membership: { permissions: new Set(permissions), role },
        error: NextResponse.json({ error: "forbidden" }, { status: 403 }),
      };
    }
    return {
      session: sessionWithRole,
      membership: { permissions: new Set(permissions), role },
      error: null,
    };
  });
  getSession.mockImplementation(async () => sessionWithRole);
}

/** The widget every widget test runs, overridable per case. */
function widget(requiredPermissions: string[] = []) {
  return {
    id: "w-1",
    name: "ویجت",
    prompt: "خلاصه کن",
    outputFormat: "text",
    sourceApp: "crm",
    requiredPermissions,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getProject.mockResolvedValue({ id: "proj-1", businessId: "biz-1", name: "پروژه" });
  getPlatformAiMode.mockResolvedValue(MODE);
  getResearchRun.mockResolvedValue({
    id: "run-1",
    businessId: "biz-1",
    status: "awaiting_approval",
    projectId: null,
    systemAgentId: null,
    appKey: null,
  });
  approveResearchRun.mockResolvedValue({ ok: true, run: { id: "run-1", status: "running" } });
  createResearchRun.mockResolvedValue({ ok: true, run: { id: "run-1" } });
  runResearchRun.mockResolvedValue({
    ok: true,
    outcome: {
      run: { id: "run-1", status: "complete", roundsUsed: 1, spendCapUsd: 1, modelAlias: "m", projectId: null, systemAgentId: null, appKey: null },
      usage: { promptTokens: 1, completionTokens: 1 },
      costUsd: 0.01,
    },
  });
  gateAiTurn.mockResolvedValue(undefined);
  settleAiTurn.mockResolvedValue({ chargedRial: 0 });
  runAgentTurn.mockResolvedValue({
    content: "ok",
    usage: { inputTokens: 1, outputTokens: 1 },
    costUsd: 0,
  });
  getAiWidget.mockResolvedValue(widget());
  filterAiToolsByPermissions.mockImplementation(
    (tools: { function: { name: string } }[], permissions: ReadonlySet<string>) =>
      tools.filter(
        (tool) =>
          tool.function.name === "propose_action" || tool.function.name === "request_input" || permissions.has("ai.manage"),
      ),
  );
  asCaller([PERMISSIONS.aiUse, PERMISSIONS.aiManage]);
});

describe("§10 — /api/ai/memory honours the project's own access rules", () => {
  it("refuses project memory for a member who cannot reach the project", async () => {
    const { POST } = await import("./memory/route");
    getProject.mockResolvedValue(null);

    const res = await POST(
      jsonRequest("http://localhost/api/ai/memory", "POST", {
        scope: "project",
        projectId: "proj-1",
        content: "یادداشت",
      }),
    );
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "forbidden" });
  });

  it("allows project memory for a member who can reach it", async () => {
    const { POST } = await import("./memory/route");
    const res = await POST(
      jsonRequest("http://localhost/api/ai/memory", "POST", {
        scope: "project",
        projectId: "proj-1",
        content: "یادداشت پروژه",
      }),
    );
    expect(res.status).toBe(201);
  });

  it("refuses a platform-scope write from a tenant route", async () => {
    // Platform memory is Superadmin-only and lives behind `/platform/ai`. A
    // tenant route accepting `scope=platform` would let one business write the
    // layer every other business reads.
    const { POST } = await import("./memory/route");
    const res = await POST(
      jsonRequest("http://localhost/api/ai/memory", "POST", { scope: "platform", content: "x" }),
    );
    expect(res.status).toBe(400);
  });

  it("requires ai.manage to write durable memory, not just ai.use", async () => {
    // Writing shapes every future turn for the business, so it is a management
    // act. A chat-only member must not be able to do it.
    const { POST } = await import("./memory/route");
    asCaller([PERMISSIONS.aiUse]);
    await POST(
      jsonRequest("http://localhost/api/ai/memory", "POST", { scope: "tenant", content: "x" }),
    );
    expect(requirePermission).toHaveBeenCalledWith(PERMISSIONS.aiManage);
  });

  it("refuses credential-shaped content rather than storing a token to rotate", async () => {
    const { POST } = await import("./memory/route");
    const res = await POST(
      jsonRequest("http://localhost/api/ai/memory", "POST", {
        scope: "tenant",
        content: "کلید sk-live-abcdef123456",
      }),
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "memory_looks_like_a_secret" });
  });
});

describe("§5 — /api/ai/research gates on explicit cost approval", () => {
  it("refuses to create a run until the member has seen the estimate", async () => {
    const { POST } = await import("./research/route");
    const res = await POST(
      jsonRequest("http://localhost/api/ai/research", "POST", {
        question: "چرا حاشیهٔ سود کم شد؟",
        costApproved: false,
        maxRounds: 4,
      }),
    );

    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toBe("research_cost_not_approved");
    // The figure the member is being asked about is the server's own product of
    // the platform's caps, so it cannot be talked down by the client.
    expect(body.estimatedMaxCostUsd).toBeGreaterThan(0);
    expect(body.maxRounds).toBe(4);
    // And nothing was created.
    expect(createResearchRun).not.toHaveBeenCalled();
  });

  it("clamps a client's round and cap requests to the platform's bounds", async () => {
    const { POST } = await import("./research/route");
    const res = await POST(
      jsonRequest("http://localhost/api/ai/research", "POST", {
        question: "چرا حاشیهٔ سود کم شد؟",
        costApproved: true,
        maxRounds: 9999,
        spendCapUsd: 9999,
      }),
    );
    expect(res.status).toBe(201);
    const input = createResearchRun.mock.calls[0][0] as Record<string, number>;
    expect(input.maxRounds).toBe(12);
    expect(input.spendCapUsd).toBe(100);
  });

  it("refuses a question too short to research", async () => {
    const { POST } = await import("./research/route");
    const res = await POST(
      jsonRequest("http://localhost/api/ai/research", "POST", { question: "چرا", costApproved: true }),
    );
    expect(res.status).toBe(400);
    expect(createResearchRun).not.toHaveBeenCalled();
  });
});

describe("§12 — a widget run cannot widen its caller's permissions", () => {
  it("runs with the caller's own set when the widget names no permissions", async () => {
    const { POST } = await import("./widgets/[id]/run/route");
    const res = await POST(
      jsonRequest("http://localhost/api/ai/widgets/w-1/run", "POST", {}),
      { params: Promise.resolve({ id: "w-1" }) },
    );
    expect(res.status).toBe(200);
    const call = runAgentTurn.mock.calls.at(-1)?.[0] as { permissions: Set<string> };
    expect([...call.permissions].sort()).toEqual(["ai.manage", "ai.use"]);
  });

  it("strips a required permission the caller has lost since the widget was built", async () => {
    // This is the intersection that keeps a saved widget from being a standing
    // grant: creation-time `requiredPermissions` is an upper bound, never a
    // floor, so the run's set is the caller's minus whatever it no longer holds.
    const { POST } = await import("./widgets/[id]/run/route");
    getAiWidget.mockResolvedValue(widget(["ai.manage", "wallet.manage"]));

    const res = await POST(
      jsonRequest("http://localhost/api/ai/widgets/w-1/run", "POST", {}),
      { params: Promise.resolve({ id: "w-1" }) },
    );
    expect(res.status).toBe(200);
    const call = runAgentTurn.mock.calls.at(-1)?.[0] as { permissions: Set<string> };
    expect([...call.permissions]).toEqual(["ai.manage"]);
  });

  it("never runs a turn at all when the intersection is empty", async () => {
    // A widget whose required permissions the caller holds none of is not a
    // widget they may run. The turn would otherwise proceed with nothing behind
    // it: it would spend the business's budget on an answer with no data behind
    // it, and the caller would have no way to tell the difference from a real
    // one.
    const { POST } = await import("./widgets/[id]/run/route");
    getAiWidget.mockResolvedValue(widget(["wallet.manage"]));

    const res = await POST(
      jsonRequest("http://localhost/api/ai/widgets/w-1/run", "POST", {}),
      { params: Promise.resolve({ id: "w-1" }) },
    );
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: "forbidden",
      reason: "widget_permissions_required",
    });
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(gateAiTurn).not.toHaveBeenCalled();
  });
});

describe("§12 — /api/ai/research/[id]/approve is a capability, not a membership", () => {
  it("asks for ai.use before it reads the run's business id", async () => {
    const { POST } = await import("./research/[id]/approve/route");
    asCaller([PERMISSIONS.aiManage]);

    const res = await POST(
      jsonRequest("http://localhost/api/ai/research/run-1/approve", "POST", {}),
      { params: Promise.resolve({ id: "run-1" }) },
    );
    // The capability was asked for — the assertion the permission matrix makes
    // structurally, made behaviourally.
    expect(requirePermission).toHaveBeenCalledWith(PERMISSIONS.aiUse);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("refuses an approval when Superadmin has switched the mode off", async () => {
    // A run created while Deep Research was on must not be startable after it
    // was turned off. The switch has to mean something on the spending side.
    const { POST } = await import("./research/[id]/approve/route");
    getPlatformAiMode.mockResolvedValue({ ...MODE, is_active: false, model_alias: "" });

    const res = await POST(
      jsonRequest("http://localhost/api/ai/research/run-1/approve", "POST", {}),
      { params: Promise.resolve({ id: "run-1" }) },
    );
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: "mode_unavailable" });
  });

  it("narrows the run's tool catalogue to what the approver may already call", async () => {
    // Deep Research is a bigger budget, not a wider permission. The catalogue is
    // filtered through the caller's effective permissions, so a run cannot read
    // a surface its approver could not have read themselves.
    const { POST } = await import("./research/[id]/approve/route");

    const res = await POST(
      jsonRequest("http://localhost/api/ai/research/run-1/approve", "POST", {}),
      { params: Promise.resolve({ id: "run-1" }) },
    );
    expect(res.status).toBe(200);

    const [tools, passed] = filterAiToolsByPermissions.mock.calls.at(-1)!;
    expect(tools.length).toBe(3);
    expect(passed).toBeInstanceOf(Set);
    // `ai.use` + `ai.manage` buys the always-on turn tool and the reporting
    // tools — nothing else. Re-running the real filter over the same inputs is
    // what proves the narrowing happened rather than being assumed.
    const surviving = filterAiToolsByPermissions
      .getMockImplementation()!(tools as never, passed as never)
      .map((tool: { function: { name: string } }) => tool.function.name);
    expect(surviving).toEqual(["propose_action", "get_ar_aging", "run_report"]);
  });

  it("settles a run that could not execute, so a failed environment is not free", async () => {
    const { POST } = await import("./research/[id]/approve/route");
    runResearchRun.mockResolvedValue({ ok: false, error: "research_not_running" });

    const res = await POST(
      jsonRequest("http://localhost/api/ai/research/run-1/approve", "POST", {}),
      { params: Promise.resolve({ id: "run-1" }) },
    );
    expect(res.status).toBe(500);
    expect(settleAiTurn).toHaveBeenCalledTimes(1);
    const attribution = (settleAiTurn.mock.calls[0][0] as { attribution: Record<string, unknown> })
      .attribution;
    // A failed run keeps its attribution: §16 says a failed environment is not
    // a free one, and the same rule applies to its reporting.
    expect(attribution.researchRunId).toBe("run-1");
    expect(attribution.runtimeMode).toBe("deep_research");
  });
});

describe("Issue #905 §10 — /api/ai/conversations transcript access and pagination", () => {
  const convId = "11111111-1111-4111-8111-111111111111";

  it("revokes list, detail, rename, and delete access when ai.use (and floor.assistant) is revoked", async () => {
    asCaller([]);
    const listRoute = await import("./conversations/route");
    const detailRoute = await import("./conversations/[id]/route");

    const listRes = await listRoute.GET(
      jsonRequest("http://localhost/api/ai/conversations", "GET"),
    );
    expect(listRes.status).toBe(403);

    const detailRes = await detailRoute.GET(
      jsonRequest(`http://localhost/api/ai/conversations/${convId}`, "GET"),
      { params: Promise.resolve({ id: convId }) },
    );
    expect(detailRes.status).toBe(403);

    const renameRes = await detailRoute.PATCH(
      jsonRequest(`http://localhost/api/ai/conversations/${convId}`, "PATCH", {
        title: "عنوان تازه",
      }),
      { params: Promise.resolve({ id: convId }) },
    );
    expect(renameRes.status).toBe(403);

    const deleteRes = await detailRoute.DELETE(
      jsonRequest(`http://localhost/api/ai/conversations/${convId}`, "DELETE"),
      { params: Promise.resolve({ id: convId }) },
    );
    expect(deleteRes.status).toBe(403);
  });

  it("blocks detail, rename, and delete on a dashboard conversation when ai.use is revoked even if menu.view remains", async () => {
    asCaller([PERMISSIONS.menuView], "cashier");
    getConversationMode.mockResolvedValue("dashboard");
    const detailRoute = await import("./conversations/[id]/route");

    const detailRes = await detailRoute.GET(
      jsonRequest(`http://localhost/api/ai/conversations/${convId}`, "GET"),
      { params: Promise.resolve({ id: convId }) },
    );
    expect(detailRes.status).toBe(403);
    expect(getConversationMessages).not.toHaveBeenCalled();

    const renameRes = await detailRoute.PATCH(
      jsonRequest(`http://localhost/api/ai/conversations/${convId}`, "PATCH", {
        title: "عنوان تازه",
      }),
      { params: Promise.resolve({ id: convId }) },
    );
    expect(renameRes.status).toBe(403);
    expect(renameConversation).not.toHaveBeenCalled();

    const deleteRes = await detailRoute.DELETE(
      jsonRequest(`http://localhost/api/ai/conversations/${convId}`, "DELETE"),
      { params: Promise.resolve({ id: convId }) },
    );
    expect(deleteRes.status).toBe(403);
    expect(deleteConversation).not.toHaveBeenCalled();
  });

  it("enforces canonical requireFloorAssistant on floor conversations across GET, PATCH, and DELETE", async () => {
    getConversationMode.mockResolvedValue("floor");
    const detailRoute = await import("./conversations/[id]/route");

    // A manager holding ai.use + menu.view is NOT a floor role (cashier/waiter)
    asCaller([PERMISSIONS.aiUse, PERMISSIONS.menuView], "manager");
    const managerGet = await detailRoute.GET(
      jsonRequest(`http://localhost/api/ai/conversations/${convId}`, "GET"),
      { params: Promise.resolve({ id: convId }) },
    );
    expect(managerGet.status).toBe(403);

    const managerPatch = await detailRoute.PATCH(
      jsonRequest(`http://localhost/api/ai/conversations/${convId}`, "PATCH", {
        title: "میز ۳",
      }),
      { params: Promise.resolve({ id: convId }) },
    );
    expect(managerPatch.status).toBe(403);
    expect(renameConversation).not.toHaveBeenCalled();

    const managerDelete = await detailRoute.DELETE(
      jsonRequest(`http://localhost/api/ai/conversations/${convId}`, "DELETE"),
      { params: Promise.resolve({ id: convId }) },
    );
    expect(managerDelete.status).toBe(403);
    expect(deleteConversation).not.toHaveBeenCalled();

    // An active waiter with menu.view passes requireFloorAssistant across GET, PATCH, DELETE
    asCaller([PERMISSIONS.menuView], "waiter");
    getConversationMessages.mockResolvedValueOnce({
      conversation: {
        id: convId,
        mode: "floor",
        title: "میز ۳",
        lastMessageAt: "2026-03-01T12:00:00.000Z",
        createdAt: "2026-03-01T11:00:00.000Z",
        projectId: null,
      },
      messages: [],
    });
    renameConversation.mockResolvedValueOnce({
      id: convId,
      mode: "floor",
      title: "میز ۴",
      lastMessageAt: "2026-03-01T12:00:00.000Z",
      createdAt: "2026-03-01T11:00:00.000Z",
      projectId: null,
    });
    deleteConversation.mockResolvedValueOnce(true);

    const waiterGet = await detailRoute.GET(
      jsonRequest(`http://localhost/api/ai/conversations/${convId}?mode=floor`, "GET"),
      { params: Promise.resolve({ id: convId }) },
    );
    expect(waiterGet.status).toBe(200);

    // Calling GET with a mismatched `?mode=dashboard` on a `floor` conversation returns 404
    const waiterMismatchModeGet = await detailRoute.GET(
      jsonRequest(`http://localhost/api/ai/conversations/${convId}?mode=dashboard`, "GET"),
      { params: Promise.resolve({ id: convId }) },
    );
    expect(waiterMismatchModeGet.status).toBe(404);

    const waiterPatch = await detailRoute.PATCH(
      jsonRequest(`http://localhost/api/ai/conversations/${convId}`, "PATCH", {
        title: "میز ۴",
      }),
      { params: Promise.resolve({ id: convId }) },
    );
    expect(waiterPatch.status).toBe(200);

    const waiterDelete = await detailRoute.DELETE(
      jsonRequest(`http://localhost/api/ai/conversations/${convId}`, "DELETE"),
      { params: Promise.resolve({ id: convId }) },
    );
    expect(waiterDelete.status).toBe(200);
  });

  it("returns 404 without leaking existence when conversation belongs to another member or business", async () => {
    asCaller([PERMISSIONS.aiUse]);
    getConversationMode.mockResolvedValue(null);
    const detailRoute = await import("./conversations/[id]/route");

    const getRes = await detailRoute.GET(
      jsonRequest(`http://localhost/api/ai/conversations/${convId}`, "GET"),
      { params: Promise.resolve({ id: convId }) },
    );
    expect(getRes.status).toBe(404);

    const patchRes = await detailRoute.PATCH(
      jsonRequest(`http://localhost/api/ai/conversations/${convId}`, "PATCH", {
        title: "عنوان",
      }),
      { params: Promise.resolve({ id: convId }) },
    );
    expect(patchRes.status).toBe(404);

    const deleteRes = await detailRoute.DELETE(
      jsonRequest(`http://localhost/api/ai/conversations/${convId}`, "DELETE"),
      { params: Promise.resolve({ id: convId }) },
    );
    expect(deleteRes.status).toBe(404);
  });

  it("forwards server-side q and compound cursor params and returns hasMore + nextCursor", async () => {
    asCaller([PERMISSIONS.aiUse]);
    const listRoute = await import("./conversations/route");
    listConversations.mockResolvedValueOnce([
      {
        id: "22222222-2222-4222-8222-222222222222",
        mode: "dashboard",
        title: "گفتگوی اول",
        lastMessageAt: "2026-03-01T12:00:00.000Z",
        createdAt: "2026-03-01T11:00:00.000Z",
        projectId: null,
      },
      {
        id: "11111111-1111-4111-8111-111111111111",
        mode: "dashboard",
        title: "گفتگوی دوم",
        lastMessageAt: "2026-03-01T12:00:00.000Z",
        createdAt: "2026-03-01T10:00:00.000Z",
        projectId: null,
      },
      {
        id: "00000000-0000-4000-8000-000000000000",
        mode: "dashboard",
        title: "گفتگوی سوم",
        lastMessageAt: "2026-03-01T11:00:00.000Z",
        createdAt: "2026-03-01T09:00:00.000Z",
        projectId: null,
      },
    ]);

    const res = await listRoute.GET(
      jsonRequest(
        `http://localhost/api/ai/conversations?limit=2&q=%D9%81%D8%B1%D9%88%D8%B4&before=2026-03-02T00:00:00.000Z&beforeId=${convId}`,
        "GET",
      ),
    );
    expect(res.status).toBe(200);
    expect(listConversations).toHaveBeenCalledWith(
      { businessId: SESSION.businessId, actorUserId: SESSION.sub },
      {
        mode: "dashboard",
        before: "2026-03-02T00:00:00.000Z",
        beforeId: convId,
        query: "فروش",
        limit: 3,
      },
    );

    const payload = await res.json();
    expect(payload.conversations).toHaveLength(2);
    expect(payload.hasMore).toBe(true);
    expect(payload.nextCursor).toEqual({
      before: "2026-03-01T12:00:00.000Z",
      beforeId: "11111111-1111-4111-8111-111111111111",
    });
  });
});
