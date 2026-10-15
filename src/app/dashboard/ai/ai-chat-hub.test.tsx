// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const replaceMock = vi.fn();
const refreshMock = vi.fn();
let currentSearchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: replaceMock,
    push: vi.fn(),
    refresh: refreshMock,
  }),
  useSearchParams: () => currentSearchParams,
  usePathname: () => "/dashboard",
}));

vi.mock("@gsap/react", () => ({
  useGSAP: (cb: () => void) => {
    React.useEffect(() => {
      cb();
    }, [cb]);
  },
}));

vi.mock("@/components/feature-lock", () => ({
  useFeatureLocked: () => false,
}));

vi.mock("@/components/money/money-context", () => ({
  useMoney: () => ({
    unit: "rial",
    format: (v: number) => `${v} ریال`,
  }),
}));

import { AiChatHub } from "./ai-chat-hub";
import { AiConversationsSidebar } from "./ai-conversations-sidebar";
import { AiWorkspaceContext } from "./ai-workspace-context";
import { AiManagementSheet } from "./ai-management-sheet";
import { AiMemoryPanel } from "./ai-memory-panel";
import { AiResearchPanel } from "./ai-research-panel";
import { AiTaskSelector } from "@/components/ai/ai-task-selector";

describe("Issue #905 — AI Chat Hub, Context, History, and Management UX/UI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentSearchParams = new URLSearchParams();
    window.HTMLElement.prototype.scrollTo = vi.fn();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders a single-canvas welcome layout without competing permanent sidebars or auto-running widgets, and starter cards fill draft instead of sending", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/ai/projects")) {
        return {
          ok: true,
          json: async () => ({ projects: [{ id: "p-1", name: "برج ساحلی" }] }),
        } as Response;
      }
      if (url.startsWith("/api/ai/conversations")) {
        return {
          ok: true,
          json: async () => ({ conversations: [], hasMore: false, nextCursor: null }),
        } as Response;
      }
      if (url.startsWith("/api/ai/chat")) {
        return {
          ok: true,
          body: null,
          json: async () => ({}),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({}),
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const starterPrompts = [
      "وضعیت پروژه‌های عمرانی و صورت‌وضعیت‌ها را خلاصه کن.",
      "خلاصهٔ وضعیت مالی، مطالبات و هزینه‌های این ماه را نشان بده.",
      "کدام وظایف در میز کار عقب افتاده‌اند؟",
    ];

    const { container } = render(
      <AiChatHub
        canManageAi={true}
        canAutoApply={false}
        allowedPanelSections={["memory", "usage"]}
        deepResearchEnabled={true}
        eligibleTaskIds={["general", "sales", "accounting", "customers"]}
        starterPrompts={starterPrompts}
        accessibleFocuses={["all", "workspace", "accounting"]}
        industry="architecture_construction"
      />,
    );

    // Heading and starter prompts are visible
    expect(
      screen.getByRole("heading", { name: "امروز چطور می‌توانم کمکتان کنم؟" }),
    ).toBeTruthy();

    // No restaurant-only starter prompts for an AEC tenant
    expect(container.textContent).not.toContain("آیتم‌های منو");

    // No permanent second aside or 18rem grid column reservation
    expect(container.querySelector("aside")).toBeNull();
    expect(container.innerHTML).not.toContain("18rem");
    expect(container.innerHTML).not.toContain("min-h-[60vh]");

    // Opening chat must NOT auto-fetch or auto-run /api/ai/widgets
    const widgetCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).startsWith("/api/ai/widgets"),
    );
    expect(widgetCalls).toHaveLength(0);

    // Deep research mode is offered when deepResearchEnabled=true from server
    const modeSelect = screen.getByLabelText("حالت پاسخ‌گویی") as HTMLSelectElement;
    const modeValues = Array.from(modeSelect.options).map((o) => o.value);
    expect(modeValues).toContain("deep_research");

    // Clicking a starter card fills the composer draft and focuses it WITHOUT calling /api/ai/chat
    const starterBtn = screen.getByRole("button", {
      name: starterPrompts[0]!,
    });
    fireEvent.click(starterBtn);

    const textarea = screen.getByLabelText("پیام") as HTMLTextAreaElement;
    expect(textarea.value).toBe(starterPrompts[0]);

    const chatCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).startsWith("/api/ai/chat"),
    );
    expect(chatCalls).toHaveLength(0);

    // IME composition Enter (isComposing / keyCode 229) must NOT send the message
    fireEvent.keyDown(textarea, {
      key: "Enter",
      shiftKey: false,
      isComposing: true,
      keyCode: 229,
    });
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/ai/chat")),
    ).toHaveLength(0);
  });

  it("shows a distinct error state with Retry when project loading fails in AiWorkspaceContext", async () => {
    let shouldFail = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (shouldFail) {
          return { ok: false, status: 500, json: async () => ({}) } as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ projects: [{ id: "p-1", name: "پروژهٔ الف" }] }),
        } as Response;
      }),
    );

    render(
      <AiWorkspaceContext
        appFocus="all"
        onAppFocusChange={vi.fn()}
        runtimeMode="auto"
        onRuntimeModeChange={vi.fn()}
        deepResearchEnabled={false}
        projectId={null}
        onProjectChange={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("خطا در خواندن پروژه‌ها")).toBeTruthy();
    });

    // Clicking Retry reloads the project list
    shouldFail = false;
    fireEvent.click(screen.getByRole("button", { name: /تلاش مجدد/ }));

    await waitFor(() => {
      const projectSelect = screen.getByLabelText("پروژه") as HTMLSelectElement;
      expect(
        Array.from(projectSelect.options).some((o) => o.textContent?.includes("پروژهٔ الف")),
      ).toBe(true);
    });
  });

  it("renders persistent inline error with Retry, server-backed search, and older pagination in AiConversationsSidebar", async () => {
    let failFirst = true;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (failFirst) {
        return {
          ok: false,
          status: 500,
          json: async () => ({ message: "خطا در دریافت گفتگوها" }),
        } as Response;
      }
      if (url.includes("before=")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            conversations: [
              {
                id: "conv-older",
                mode: "dashboard",
                title: "گفتگوی قدیمی‌تر",
                lastMessageAt: "2026-02-01T10:00:00.000Z",
                createdAt: "2026-02-01T09:00:00.000Z",
              },
            ],
            hasMore: false,
            nextCursor: null,
          }),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          conversations: [
            {
              id: "conv-1",
              mode: "dashboard",
              title: "بررسی فروش امروز",
              lastMessageAt: new Date().toISOString(),
              createdAt: new Date().toISOString(),
            },
          ],
          hasMore: true,
          nextCursor: {
            before: "2026-03-01T12:00:00.000Z",
            beforeId: "11111111-1111-4111-8111-111111111111",
          },
        }),
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AiConversationsSidebar
        activeId="conv-1"
        refreshToken={0}
        onSelect={vi.fn()}
      />,
    );

    // Persistent inline error state is shown with Retry button (not disguised as empty history)
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
      expect(screen.getByText("خطا در دریافت گفتگوها")).toBeTruthy();
    });

    // Retry succeeds and loads first page + "نمایش گفتگوهای قدیمی‌تر" button
    failFirst = false;
    fireEvent.click(screen.getByRole("button", { name: /تلاش مجدد/ }));

    await waitFor(() => {
      expect(screen.getByText("بررسی فروش امروز")).toBeTruthy();
      expect(screen.getByText("امروز")).toBeTruthy();
    });

    const loadOlderBtn = screen.getByRole("button", {
      name: /نمایش گفتگوهای قدیمی‌تر/,
    });
    fireEvent.click(loadOlderBtn);

    await waitFor(() => {
      expect(screen.getByText("گفتگوی قدیمی‌تر")).toBeTruthy();
    });

    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes("before=2026-03-01T12%3A00%3A00.000Z") &&
        String(url).includes("beforeId=11111111-1111-4111-8111-111111111111"),
      ),
    ).toBe(true);
  });

  it("filters management sheet tabs by allowedSections and updates retired Knowledge copy in AiMemoryPanel", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ entries: [], runs: [] }),
      })) as unknown as typeof fetch,
    );

    render(
      <AiManagementSheet
        section="usage"
        canAutoApply={false}
        allowedSections={["usage"]}
        deepResearchEnabled={false}
        onSectionChange={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    // Only "مصرف و هزینه" tab is shown; "حافظهٔ دستیار" and "همکاران هوشمند" are hidden
    expect(screen.getByRole("button", { name: /مصرف و هزینه/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /حافظهٔ دستیار/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /همکاران هوشمند/ })).toBeNull();

    // AiMemoryPanel references actual destinations instead of retired «دانش»
    const { container: memContainer } = render(<AiMemoryPanel />);
    expect(memContainer.textContent).toContain("میز کار من");
    expect(memContainer.textContent).toContain("کتابخانهٔ رسانه");
    expect(memContainer.textContent).not.toContain("«دانش»");
  });

  it("handles HTTP 402 research_cost_not_approved in AiResearchPanel by showing the inline cost-approval step", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (!init || init.method !== "POST") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ runs: [] }),
        } as Response;
      }
      const body = JSON.parse(String(init.body)) as { costApproved?: boolean };
      if (!body.costApproved) {
        return {
          ok: false,
          status: 402,
          json: async () => ({
            error: "research_cost_not_approved",
            estimatedMaxCostUsd: 0.45,
          }),
        } as Response;
      }
      return {
        ok: true,
        status: 201,
        json: async () => ({
          run: {
            id: "run-1",
            question: "تحلیل جامع فروش سه ماه گذشته",
            status: "awaiting_approval",
            roundsUsed: 0,
            maxRounds: 4,
            estimatedMaxCostUsd: 0.45,
            spendCapUsd: 1,
            actualCostUsd: 0,
            findings: [],
            answer: null,
            error: null,
          },
        }),
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AiResearchPanel deepResearchEnabled={true} />);

    const textarea = screen.getByPlaceholderText(/فروش سه ماه گذشته/);
    await act(async () => {
      fireEvent.change(textarea, {
        target: { value: "تحلیل جامع فروش سه ماه گذشته به تفکیک شعبه" },
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /ساخت پژوهش/ }));
    });

    await waitFor(() => {
      expect(screen.getByText(/حداکثر هزینهٔ تخمینی این پژوهش: \$0\.45/)).toBeTruthy();
    });

    const approveCostBtn = screen.getByRole("button", {
      name: /تأیید سقف هزینه و ثبت پژوهش/,
    });
    await act(async () => {
      fireEvent.click(approveCostBtn);
    });

    expect(
      fetchMock.mock.calls.some(([, init]) => {
        if (!init?.body) return false;
        const parsed = JSON.parse(String(init.body)) as { costApproved?: boolean };
        return parsed.costApproved === true;
      }),
    ).toBe(true);
  });

  it("deduplicates the custom task option in AiTaskSelector, filters by eligibleTaskIds, and clears stale customTask when switching to a preset", () => {
    const onSelectTask = vi.fn();
    const onCustomTask = vi.fn();

    render(
      <AiTaskSelector
        mode="dashboard"
        task="custom"
        customTask="بررسی سفارشی قبلی"
        onSelectTask={onSelectTask}
        onCustomTask={onCustomTask}
        eligibleTaskIds={["general", "sales", "accounting", "custom"]}
      />,
    );

    const trigger = screen.getByRole("button", { name: /وظیفهٔ دستیار/ });
    fireEvent.keyDown(trigger, { key: "Enter" });

    // Only one "سفارشی…" menuitem is rendered in the menu
    const customOptions = screen.getAllByRole("menuitem", { name: /سفارشی…/ });
    expect(customOptions).toHaveLength(1);

    // Menu task is filtered out because it is not in eligibleTaskIds
    expect(screen.queryByRole("menuitem", { name: /منو/ })).toBeNull();

    // Selecting a preset clears stale customTask and switches taskId
    const salesOption = screen.getByRole("menuitem", { name: /تحلیل فروش/ });
    fireEvent.click(salesOption);

    expect(onSelectTask).toHaveBeenCalledWith("sales");
    expect(onCustomTask).toHaveBeenCalledWith("");
  });
});
