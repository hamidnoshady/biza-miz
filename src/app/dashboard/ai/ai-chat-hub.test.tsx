// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

describe("Issue #905 — AI Chat Hub, Clean Composer (+ Menu), Left History Panel, and Management UX/UI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentSearchParams = new URLSearchParams();
    window.localStorage.clear();
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: 1366,
    });
    window.HTMLElement.prototype.scrollTo = vi.fn();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders a clean default composer, minimal header without New Chat or context chips, bottom-left send button, and collapsible physical-left history panel", async () => {
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
    expect(container.innerHTML).not.toContain("min-h-[60vh]");

    // Minimal header: NO New Chat button in header, NO task/focus/mode/project chips
    const header = container.querySelector("header")!;
    expect(within(header).queryByRole("button", { name: "گفت‌وگوی جدید" })).toBeNull();
    expect(header.textContent).not.toContain("تمرکز:");
    expect(header.textContent).not.toContain("حالت:");
    expect(header.textContent).not.toContain("پروژه:");

    // The main composer exposes task selection and three explicit model-profile buttons.
    const composerBox = container.querySelector("[data-composer-box]")!;
    expect(composerBox.querySelectorAll("select")).toHaveLength(1);
    expect(within(composerBox as HTMLElement).getByRole("combobox", { name: /وظیفه دستیار/ })).toBeTruthy();
    for (const label of ["خودکار", "سریع", "تفکر عمیق"]) {
      expect(within(composerBox as HTMLElement).getByRole("button", { name: `حالت پاسخ‌گویی: ${label}` })).toBeTruthy();
    }
    expect(within(composerBox as HTMLElement).queryByLabelText("تنظیمات این پیام")).toBeNull();
    expect(within(composerBox as HTMLElement).queryByLabelText("جست‌وجو در گزارش‌ها و گفتگوهای قبلی")).toBeNull();

    const sendBtn = within(composerBox as HTMLElement).getByRole("button", { name: "ارسال پیام" });
    expect(sendBtn.parentElement?.className).toContain("right-2.5");
    expect(sendBtn.parentElement?.className).toContain("bottom-2.5");
    const plusBtn = within(composerBox as HTMLElement).getByRole("button", { name: "افزودن پیوست و ابزارهای گفتگو" });
    expect(plusBtn.parentElement?.className).toContain("left-2.5");
    expect(plusBtn.parentElement?.className).toContain("bottom-2.5");

    // Desktop physical-left history panel is rendered with New Chat inside it
    const historyAside = screen.getByRole("complementary", {
      name: "تاریخچهٔ گفتگوها",
    });
    expect(
      within(historyAside).getByRole("button", { name: "گفت‌وگوی جدید" }),
    ).toBeTruthy();

    // Opening chat must NOT auto-fetch or auto-run /api/ai/widgets
    const widgetCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).startsWith("/api/ai/widgets"),
    );
    expect(widgetCalls).toHaveLength(0);

    // Clicking a starter card fills the composer draft and focuses it WITHOUT calling /api/ai/chat
    const starterBtn = screen.getByRole("button", {
      name: starterPrompts[0]!,
    });
    fireEvent.click(starterBtn);

    const textarea = screen.getByLabelText("پیام") as HTMLTextAreaElement;
    expect(textarea.value).toBe(starterPrompts[0]);

    // Collapsing the left history panel releases the panel completely, saves preference,
    // shows only the minimal reopen button, and preserves the composer draft
    fireEvent.click(
      within(historyAside).getByRole("button", {
        name: "جمع کردن تاریخچهٔ گفتگوها",
      }),
    );
    expect(
      screen.queryByRole("complementary", { name: "تاریخچهٔ گفتگوها" }),
    ).toBeNull();
    expect(window.localStorage.getItem("ai-history-panel-preference")).toBe(
      "collapsed",
    );
    expect(textarea.value).toBe(starterPrompts[0]);

    // Reopening from the minimal control restores the left history panel
    const reopenBtn = screen.getByRole("button", {
      name: "باز کردن تاریخچهٔ گفتگوها",
    });
    fireEvent.click(reopenBtn);
    expect(
      screen.getByRole("complementary", { name: "تاریخچهٔ گفتگوها" }),
    ).toBeTruthy();
    expect(window.localStorage.getItem("ai-history-panel-preference")).toBe(
      "expanded",
    );

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

  it("keeps task and Auto/Fast/Thinking beside Send, and limits + to supported attachments and context", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/ai/projects")) {
        return { ok: true, json: async () => ({ projects: [{ id: "p-1", name: "برج ساحلی" }] }) } as Response;
      }
      if (url.startsWith("/api/ai/conversations")) {
        return { ok: true, json: async () => ({ conversations: [], hasMore: false, nextCursor: null }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AiChatHub
        canManageAi={true}
        canAutoApply={false}
        allowedPanelSections={["memory"]}
        deepResearchEnabled={true}
        eligibleTaskIds={["general", "sales", "accounting"]}
        accessibleFocuses={["all", "workspace", "accounting"]}
        industry="architecture_construction"
      />,
    );

    const textarea = screen.getByLabelText("پیام") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "پیش‌نویس تستی من" } });

    const modeButton = screen.getByRole("button", { name: "حالت پاسخ‌گویی: تفکر عمیق" });
    fireEvent.click(modeButton);
    expect(modeButton.getAttribute("aria-pressed")).toBe("true");
    expect(replaceMock).toHaveBeenCalledWith(expect.stringContaining("mode=thinking"), { scroll: false });

    const taskSelect = screen.getByRole("combobox", { name: /وظیفه دستیار/ });
    fireEvent.change(taskSelect, { target: { value: "sales" } });
    expect((taskSelect as HTMLSelectElement).value).toBe("sales");

    fireEvent.change(taskSelect, { target: { value: "custom" } });
    const customInput = screen.getByPlaceholderText(/پاسخ‌ها را کوتاه/);
    fireEvent.change(customInput, { target: { value: "خروجی فقط بولت‌پوینت" } });
    fireEvent.click(screen.getByRole("button", { name: "اعمال وظیفه" }));
    expect((taskSelect as HTMLSelectElement).value).toBe("custom");
    fireEvent.change(taskSelect, { target: { value: "sales" } });
    expect((taskSelect as HTMLSelectElement).value).toBe("sales");

    const plusBtn = screen.getByRole("button", { name: "افزودن پیوست و ابزارهای گفتگو" });
    fireEvent.click(plusBtn);
    expect(screen.getByText("بارگذاری فایل")).toBeTruthy();
    expect(screen.getByText("انتخاب از کتابخانه رسانه")).toBeTruthy();
    expect(screen.queryByText("تصویر فاکتور / رسید")).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "تنظیمات این پیام" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /جست‌وجو در گزارش‌ها و گفتگوها/ })).toBeNull();

    fireEvent.click(screen.getByRole("menuitem", { name: "تمرکز دستیار: همهٔ بخش‌ها" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "حسابداری و فروش" }));
    expect(replaceMock).toHaveBeenCalledWith(expect.stringContaining("focus=accounting"), { scroll: false });

    fireEvent.click(plusBtn);
    fireEvent.click(screen.getByRole("menuitem", { name: /^پروژه:/ }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "برج ساحلی" }));
    expect(replaceMock).toHaveBeenCalledWith(expect.stringContaining("project=p-1"), { scroll: false });
    expect(textarea.value).toBe("پیش‌نویس تستی من");
  });

  it("opens history in a left-side Sheet drawer with New Chat on narrow viewports without rendering a permanent desktop history rail", async () => {
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: 390,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ conversations: [], hasMore: false, nextCursor: null }),
      }),
    );

    render(
      <AiChatHub
        canManageAi={false}
        canAutoApply={false}
        allowedPanelSections={[]}
        deepResearchEnabled={false}
        eligibleTaskIds={["general"]}
        accessibleFocuses={["all"]}
      />,
    );

    // No permanent desktop aside on narrow viewport
    expect(
      screen.queryByRole("complementary", { name: "تاریخچهٔ گفتگوها" }),
    ).toBeNull();

    // Clicking the history button opens the left-side Sheet drawer with New Chat inside
    const openHistoryBtn = screen.getByRole("button", {
      name: "باز کردن تاریخچهٔ گفتگوها",
    });
    fireEvent.click(openHistoryBtn);

    const dialog = await screen.findByRole("dialog", {
      name: "گفتگوهای اخیر",
    });
    expect(dialog.className).toContain("left-0");
    expect(
      within(dialog).getByRole("button", { name: "گفت‌وگوی جدید" }),
    ).toBeTruthy();
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

  it("keeps starter cards and `+` menu project controls restricted to eligible functions when focus or URL project changes in AiChatHub", async () => {
    currentSearchParams = new URLSearchParams({
      focus: "accounting",
      project: "proj-1",
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ projects: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AiChatHub
        canManageAi={false}
        canAutoApply={false}
        allowedPanelSections={[]}
        deepResearchEnabled={false}
        eligibleTaskIds={["general", "inventory"]}
        accessibleFocuses={["all", "accounting"]}
        industry="wholesale"
      />,
    );

    expect(
      screen.getByRole("button", {
        name: "کدام اقلام رو به اتمام‌اند و باید خرید شوند؟",
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: "حساب‌هایم را کامل بررسی کن و یافته‌ها را بگو.",
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: /وضعیت وظایف و موانع این پروژه/,
      }),
    ).toBeNull();

    // Open `+` menu and verify the project item is hidden when `workspace` is not in `accessibleFocuses`
    fireEvent.click(
      screen.getByRole("button", { name: "افزودن پیوست و ابزارهای گفتگو" }),
    );
    expect(screen.queryByRole("menuitem", { name: /^پروژه:/ })).toBeNull();
  });

  it("loads a conversation from the left history panel without resetting while router.replace is in-flight, and supports project retry & search inside `+`", async () => {
    let failProjects = true;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/ai/projects")) {
        if (failProjects) {
          return {
            ok: false,
            status: 500,
            json: async () => ({ error: "خطای دریافت پروژه‌ها" }),
          } as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            projects: [{ id: "proj-9", name: "پروژه مالی پاییز" }],
          }),
        } as Response;
      }
      if (url.startsWith("/api/ai/conversations/conv-42")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            conversation: {
              id: "conv-42",
              mode: "dashboard",
              title: "تحلیل سود مهرماه",
              projectId: null,
            },
            messages: [
              {
                id: "m-1",
                role: "user",
                content: "سود مهرماه چقدر بود؟",
                createdAt: new Date().toISOString(),
              },
              {
                id: "m-2",
                role: "assistant",
                content: "سود خالص مهرماه ۹۵٬۰۰۰٬۰۰۰ ریال بوده است.",
                createdAt: new Date().toISOString(),
              },
            ],
          }),
        } as Response;
      }
      if (url.startsWith("/api/ai/conversations")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            conversations: [
              {
                id: "conv-42",
                mode: "dashboard",
                title: "تحلیل سود مهرماه",
                lastMessageAt: new Date().toISOString(),
                createdAt: new Date().toISOString(),
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
        json: async () => ({ results: [] }),
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AiChatHub canManageAi={true} canAutoApply={true} />);

    // Wait for conversation in left history panel and click it (router.replace does not mutate currentSearchParams in this mock)
    const convBtn = await screen.findByText("تحلیل سود مهرماه");
    fireEvent.click(convBtn);

    await waitFor(() => {
      expect(
        screen.getByText("سود خالص مهرماه ۹۵٬۰۰۰٬۰۰۰ ریال بوده است."),
      ).toBeTruthy();
    });

    // Open `+` menu -> Project sub-view shows error + Retry button (`تلاش مجدد`)
    fireEvent.keyDown(
      screen.getByRole("button", { name: "افزودن پیوست و ابزارهای گفتگو" }),
      { key: "Enter" },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: /^پروژه:/ }));

    const retryBtn = await screen.findByRole("button", {
      name: /تلاش مجدد/,
    });
    failProjects = false;
    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(
        screen.getByRole("menuitemradio", { name: /پروژه مالی پاییز/ }),
      ).toBeTruthy();
    });

    // Search was intentionally removed from the attachment menu.
    fireEvent.click(screen.getByRole("button", { name: "بازگشت به منوی ابزارها" }));
    expect(screen.queryByRole("menuitem", { name: /جست‌وجو در گزارش‌ها و گفتگوها/ })).toBeNull();
  });
});
