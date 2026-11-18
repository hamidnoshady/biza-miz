// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformAiChatPanel, PlatformAiChatProvider, usePlatformAiChat } from "./platform-ai-chat-session";
let chat: ReturnType<typeof usePlatformAiChat>;
function Probe({ page = "playground" }: { page?: string }) { chat = usePlatformAiChat(); return <span>{page}</span>; }

function sse(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function streamResponse(signal?: AbortSignal | null) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(next) { controller = next; },
  });
  signal?.addEventListener("abort", () => {
    try { controller.error(new DOMException("Aborted", "AbortError")); } catch { /* already closed */ }
  }, { once: true });
  const response = { ok: true, body, json: async () => ({}) } as unknown as Response;
  return { response, push: (event: string, data: unknown) => controller.enqueue(sse(event, data)) };
}

const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("persistent Superadmin conversation", () => {
  it("keeps an in-flight stream and draft across page presentation changes, with one request", async () => {
    const stream = streamResponse();
    vi.stubGlobal("fetch", vi.fn(async () => stream.response));
    const view = render(<PlatformAiChatProvider><Probe page="playground" /></PlatformAiChatProvider>);
    act(() => chat.setText("سؤال"));
    let pending!: Promise<void>;
    act(() => { pending = chat.send(); void chat.send(); });
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(chat.busy).toBe(true);
    expect(chat.text).toBe("سؤال");
    view.rerender(<PlatformAiChatProvider><Probe page="prompts" /></PlatformAiChatProvider>);
    expect(chat.busy).toBe(true);
    await act(async () => {
      stream.push("start", { requestId: "req-p", modelAlias: "alias-auto", promptVersions: { base: 1, mode: 1 }, tools: [] });
      stream.push("done", { answer: "پاسخ", requestId: "req-p", modelAlias: "alias-auto", tokens: 1, costUsd: null, toolsUsed: [], latencyMs: 1 });
    });
    await act(async () => { await pending; });
    expect(chat.turns.at(-1)).toMatchObject({ role: "assistant", content: "پاسخ", status: "complete" });
    expect(chat.busy).toBe(false);
  });

  it("streams a turn into the transcript and records diagnostics", async () => {
    const { response, push } = streamResponse();
    vi.stubGlobal("fetch", vi.fn(async () => response));
    render(<PlatformAiChatProvider><Probe /></PlatformAiChatProvider>);
    act(() => chat.setText("سؤال"));
    let pending!: Promise<void>;
    act(() => { pending = chat.send(); });
    await flush();
    expect(chat.busy).toBe(true);
    expect(chat.text).toBe("سؤال");

    await act(async () => {
      push("start", {
        requestId: "req-1", mode: "auto", modelAlias: "alias-auto",
        promptVersions: { base: 3, mode: 4 }, tools: ["get_backup_health"], startedAt: Date.now(),
      });
      push("delta", { content: "سلام " });
      push("delta", { content: "دنیا" });
    });
    await flush();
    expect(chat.turns.at(-1)).toMatchObject({ role: "assistant", content: "سلام دنیا", status: "streaming" });
    expect(chat.turns.at(-1)?.diagnostics).toMatchObject({ requestId: "req-1", modelAlias: "alias-auto" });

    await act(async () => {
      push("done", {
        answer: "سلام دنیا", requestId: "req-1", modelAlias: "alias-auto",
        promptVersions: { base: 3, mode: 4 }, tokens: 12, costUsd: 0.001,
        toolsUsed: ["get_backup_health"], latencyMs: 42, finishReason: "stop",
      });
    });
    await act(async () => { await pending; });
    expect(chat.turns).toEqual([
      { role: "user", content: "سؤال" },
      {
        role: "assistant", content: "سلام دنیا", status: "complete",
        diagnostics: {
          requestId: "req-1", mode: "auto", modelAlias: "alias-auto",
          promptVersions: { base: 3, mode: 4 }, authorizedTools: ["get_backup_health"],
          tokens: 12, costUsd: 0.001, toolsUsed: ["get_backup_health"], latencyMs: 42, finishReason: "stop",
        },
      },
    ]);
    expect(chat.busy).toBe(false);
    expect(chat.text).toBe("");
    expect(chat.model).toBe("alias-auto");
  });

  it("keeps partial text and labels it cancelled when the operator stops", async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      const stream = streamResponse(signal);
      queueMicrotask(() => stream.push("delta", { content: "نیمهٔ پاسخ" }));
      return stream.response;
    }));
    render(<PlatformAiChatProvider><Probe /></PlatformAiChatProvider>);
    act(() => chat.setText("سؤال"));
    let pending!: Promise<void>;
    act(() => { pending = chat.send(); });
    await flush();
    expect(chat.turns.at(-1)?.content).toBe("نیمهٔ پاسخ");

    act(() => chat.stop());
    await flush();
    expect(signal?.aborted).toBe(true);
    await act(async () => { await pending; });
    expect(chat.turns.at(-1)).toMatchObject({ role: "assistant", content: "نیمهٔ پاسخ", status: "cancelled" });
    expect(chat.busy).toBe(false);
  });

  it("does not request tools unless the operator turns them on", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      const { response, push } = streamResponse();
      queueMicrotask(() => {
        push("start", { requestId: "r", modelAlias: "a", promptVersions: { base: 1, mode: 1 }, tools: [] });
        push("done", { answer: "ok", requestId: "r", modelAlias: "a", tokens: 1, costUsd: null, toolsUsed: [], latencyMs: 1 });
      });
      return response;
    }));
    render(<PlatformAiChatProvider><Probe /></PlatformAiChatProvider>);

    act(() => chat.setText("بدون ابزار"));
    await act(async () => { await chat.send(); });
    expect(bodies[0].tools).toBeUndefined();

    act(() => { chat.setTools(true); chat.setText("با ابزار"); });
    await act(async () => { await chat.send(); });
    expect(bodies[1].tools).toBe(true);
  });

  it("drops a late response after reset and aborts its request", async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return streamResponse(signal).response;
    }));
    render(<PlatformAiChatProvider><Probe /></PlatformAiChatProvider>);
    act(() => chat.setText("قدیمی"));
    let pending!: Promise<void>;
    act(() => { pending = chat.send(); });
    await flush();
    act(() => chat.reset());
    expect(signal?.aborted).toBe(true);
    await act(async () => { await pending; });
    expect(chat.turns).toEqual([]);
    expect(chat.busy).toBe(false);
  });
});

describe("the playground is Persian RTL and shows its diagnostics", () => {
  it("renders a right-to-left panel with Persian controls and the explicit tool switch off", () => {
    render(<PlatformAiChatProvider><PlatformAiChatPanel /></PlatformAiChatProvider>);
    const panel = screen.getByLabelText("پیام آزمایشی").closest("section");
    expect(panel?.getAttribute("dir")).toBe("rtl");
    expect(screen.getByRole("button", { name: "ارسال پیام آزمایشی" })).toBeTruthy();
    const tools = screen.getByRole("button", { name: /ابزارهای سلامت/ });
    expect(tools.getAttribute("aria-pressed")).toBe("false");
    expect(panel?.getAttribute("aria-label")).toBe("گفتگوی مدیر پلتفرم");
  });

  it("renders request diagnostics inside the assistant bubble", async () => {
    const { response, push } = streamResponse();
    vi.stubGlobal("fetch", vi.fn(async () => response));
    render(<PlatformAiChatProvider><PlatformAiChatPanel /><Probe /></PlatformAiChatProvider>);
    act(() => chat.setText("سؤال"));
    let pending!: Promise<void>;
    act(() => { pending = chat.send(); });
    await flush();
    await act(async () => {
      push("start", { requestId: "req-rtl", mode: "auto", modelAlias: "alias-auto", promptVersions: { base: 3, mode: 4 }, tools: [] });
      push("done", {
        answer: "پاسخ فارسی", requestId: "req-rtl", modelAlias: "alias-auto",
        promptVersions: { base: 3, mode: 4 }, tokens: 12, costUsd: 0.001, toolsUsed: [], latencyMs: 42,
      });
    });
    await act(async () => { await pending; });
    expect(screen.getByText("جزئیات فنی پاسخ")).toBeTruthy();
    expect(screen.getByText("req-rtl")).toBeTruthy();
    expect(screen.getByText("alias-auto")).toBeTruthy();
    expect(screen.getByText("پاسخ فارسی")).toBeTruthy();
  });
});
