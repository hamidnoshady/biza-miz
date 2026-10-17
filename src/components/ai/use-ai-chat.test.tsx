// @vitest-environment jsdom

/**
 * Issue #812 §17/§18/§19 — the chat hook's lifecycle, against a real stream.
 *
 * §29 names five client-chat cases and this hook had no test at all. Three of
 * the five are §17/§18/§19, and all three are races: they only misbehave when
 * two things happen close together, which is exactly what a test that awaits
 * one thing at a time cannot see.
 *
 *   - rapid A → B conversation switching
 *   - a stale stream finalizer from the conversation you left
 *   - an incomplete/cancelled reply being marked rather than passed off as done
 *
 * The stream is driven through a real `ReadableStream` over a stubbed `fetch`,
 * so the hook's own reader, buffering and event framing are exercised rather
 * than bypassed. That matters: the SSE framing bug class (an event split across
 * two chunks) lives in the buffer handling below, and a mock that handed the
 * hook parsed events would never touch it.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeAiAppFocus, useAiChat, type LoadedConversationMeta } from "./use-ai-chat";

/** Builds an SSE body the hook's reader can consume chunk by chunk. */
function sseBody(events: { event: string; data: unknown }[], chunkEvery = 1) {
  const text = events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join("");
  // Split on a byte boundary that does NOT respect event boundaries, so an
  // event can arrive in two chunks and the hook's buffer has to hold it.
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += chunkEvery) {
    chunks.push(bytes.slice(i, i + chunkEvery));
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function chatResponse(events: { event: string; data: unknown }[], chunkEvery = 1) {
  return {
    ok: true,
    body: sseBody(events, chunkEvery),
    json: async () => ({}),
  } as unknown as Response;
}

const DONE = { event: "done", data: { content: "پاسخ کامل", conversationId: "conv-1" } };

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => chatResponse([{ event: "delta", data: { content: "سلام" } }, DONE])),
  );
  // The hook uses the Next router for its reset/redirect paths.
  vi.stubGlobal("navigator", { ...globalThis.navigator });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A router stub, because `useRouter` needs a provider otherwise. */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
}));

function setup(overrides: Partial<Parameters<typeof useAiChat>[0]> = {}) {
  return renderHook(() =>
    useAiChat({ mode: "dashboard", appFocus: "all", runtimeMode: "auto", ...overrides }),
  );
}

describe("§19 — an incomplete reply is marked, never passed off as complete", () => {
  it("marks a stream that ended without its terminal event as incomplete", async () => {
    // A stream that delivers text and then simply ends. No `done`, no `error` —
    // the connection went away underneath a real answer.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            ok: true,
            body: sseBody([{ event: "delta", data: { content: "نیمهٔ پاسخ" } }]),
            json: async () => ({}),
          }) as unknown as Response,
      ),
    );
    const { result } = setup();

    await act(async () => {
      await result.current.sendMessage("سلام");
    });

    const reply = result.current.messages.at(-1);
    expect(reply?.role).toBe("assistant");
    // The text that arrived is kept — it is real — but it is not a finished answer.
    expect(reply?.content).toBe("نیمهٔ پاسخ");
    expect(reply?.status).toBe("incomplete");
  });

  it("marks a cancelled reply as cancelled rather than replacing it", async () => {
    // A stream that delivers text and then hangs, and that honours the abort
    // signal the hook passes — which is what a real fetch does and a naive stub
    // does not, so a stub that ignores the signal cannot reach this path.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: { signal: AbortSignal }) =>
          ({
            ok: true,
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode("event: delta\ndata: {\"content\":\"نیمهٔ\"}\n\n"),
                );
                init.signal.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
              },
            }),
            json: async () => ({}),
          }) as unknown as Response,
      ),
    );

    const { result } = setup();
    await act(async () => {
      void result.current.sendMessage("سلام");
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.messages.at(-1)?.content).toBe("نیمهٔ");

    await act(async () => {
      result.current.cancelGeneration();
      await Promise.resolve();
    });

    const reply = result.current.messages.at(-1);
    expect(reply?.status).toBe("cancelled");
    // The partial text survives the cancel; it is marked, not discarded.
    expect(reply?.content).toBe("نیمهٔ");
    expect(result.current.busy).toBe(false);
  });

  it("marks a provider error as an error and keeps what arrived before it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          ({
            ok: true,
            body: sseBody([
              { event: "delta", data: { content: "قبل از خطا" } },
              { event: "error", data: { message: "اعتبار کافی نیست" } },
            ]),
            json: async () => ({}),
          }) as unknown as Response,
      ),
    );

    const { result } = setup();
    await act(async () => {
      await result.current.sendMessage("سلام");
    });

    const reply = result.current.messages.at(-1);
    expect(reply?.status).toBe("error");
    expect(reply?.content).toContain("قبل از خطا");
    expect(reply?.content).toContain("اعتبار کافی نیست");
  });
});

describe("§17 — a stale stream finalizer cannot write to the current conversation", () => {
  it("drops deltas from a turn the member has already switched away from", async () => {
    // Two conversations loaded back to back. The first turn's stream is still
    // in flight when the second starts, and its `done` event must not land in
    // the second conversation's thread.
    const gates: (() => void)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body) as { conversationId: string | null };
        return {
          ok: true,
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              const tag = body.conversationId ?? "new";
              controller.enqueue(
                new TextEncoder().encode(`event: delta\ndata: ${JSON.stringify({ content: `از ${tag}` })}\n\n`),
              );
              // Hold the stream open until this test releases it.
              gates.push(() => {
                controller.enqueue(
                  new TextEncoder().encode(
                    `event: done\ndata: ${JSON.stringify({ content: `پایان ${tag}`, conversationId: tag })}\n\n`,
                  ),
                );
                controller.close();
              });
            },
          }),
          json: async () => ({}),
        } as unknown as Response;
      }),
    );

    const { result } = setup();

    // Start conversation A's turn; it streams one delta and then waits.
    await act(async () => {
      void result.current.sendMessage("الف");
      await Promise.resolve();
      await Promise.resolve();
    });
    const afterA = result.current.messages.at(-1);
    expect(afterA?.content).toBe("از new");

    // Load conversation B while A's stream is still open.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ messages: [{ role: "assistant", content: "تاريخچهٔ ب" }] }),
      })) as unknown as typeof fetch,
    );
    await act(async () => {
      await result.current.loadConversation("conv-b");
    });
    expect(result.current.messages.map((m) => m.content)).toEqual(["تاريخچهٔ ب"]);

    // Now let A's stream finish. Its terminal event must NOT reach B's thread.
    await act(async () => {
      gates.forEach((gate) => gate());
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.messages.map((m) => m.content)).toEqual(["تاريخچهٔ ب"]);
  });

  it("holds a second send until the first has settled, so turns cannot interleave", async () => {
    const order: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body) as { messages: { content: string }[] };
        const prompt = body.messages.at(-1)?.content ?? "";
        order.push(prompt);
        return chatResponse([
          { event: "delta", data: { content: `پاسخ به ${prompt}` } },
          { event: "done", data: { content: `پاسخ به ${prompt}`, conversationId: "conv-1" } },
        ]);
      }),
    );

    const { result } = setup();
    await act(async () => {
      await result.current.sendMessage("اول");
    });
    await act(async () => {
      await result.current.sendMessage("دوم");
    });

    // Two turns, in the order they were sent, each with its own reply — and no
    // reply carrying the other turn's text.
    const replies = result.current.messages.filter((m) => m.role === "assistant");
    expect(replies).toHaveLength(2);
    expect(replies[0].content).toBe("پاسخ به اول");
    expect(replies[1].content).toBe("پاسخ به دوم");
    expect(order).toEqual(["اول", "دوم"]);
  });
});

describe("the SSE framing survives a chunk boundary", () => {
  it("reassembles an event split across two chunks", async () => {
    // The buffer handling below the hook is where an event split mid-JSON gets
    // corrupted. One byte per chunk is the worst case.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          chatResponse(
            [{ event: "delta", data: { content: "تکه" } }, { event: "done", data: { content: "تکهٔ کامل" } }],
            1,
          ),
      ),
    );

    const { result } = setup();
    await act(async () => {
      await result.current.sendMessage("سلام");
    });

    const reply = result.current.messages.at(-1);
    // The terminal event arrived intact despite being split byte by byte.
    expect(reply?.status).toBe("complete");
    expect(reply?.content).toBe("تکهٔ کامل");
  });
});

describe("Issue #905 — New Chat load invalidation, conversation metadata, and focus normalization", () => {
  it("invalidates an in-flight loadConversation when startNewConversation is called", async () => {
    let resolveLoad: ((value: unknown) => void) | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((resolve) => {
            resolveLoad = resolve;
          }),
      ) as unknown as typeof fetch,
    );

    const { result } = setup();

    // Start loading an older conversation
    let loadPromise!: Promise<unknown>;
    await act(async () => {
      loadPromise = result.current.loadConversation("conv-stale");
    });
    expect(result.current.loadingConversation).toBe(true);

    // User clicks New Chat before the history fetch resolves
    await act(async () => {
      result.current.startNewConversation();
    });
    expect(result.current.loadingConversation).toBe(false);
    expect(result.current.conversationId).toBeNull();

    // Now the slow fetch resolves: it must NOT overwrite the New Chat state
    await act(async () => {
      resolveLoad?.({
        ok: true,
        json: async () => ({
          conversation: { id: "conv-stale", title: "گفتگوی قدیمی", projectId: "proj-old" },
          messages: [{ id: "m-1", role: "user", content: "پیام قدیمی" }],
        }),
      });
      await loadPromise;
    });

    expect(result.current.conversationId).toBeNull();
    expect(result.current.conversationTitle).toBeNull();
    expect(result.current.messages.map((m) => m.content)).not.toContain("پیام قدیمی");
  });

  it("extracts title and projectId metadata when loadConversation completes", async () => {
    let loadedMeta: LoadedConversationMeta | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          conversation: {
            id: "conv-proj",
            title: "بررسی بودجه پروژه",
            projectId: "proj-42",
          },
          messages: [
            { id: "m-1", role: "user", content: "بودجه چقدر است؟" },
            { id: "m-2", role: "assistant", content: "۵۰۰ میلیون ریال" },
          ],
        }),
      })) as unknown as typeof fetch,
    );

    const { result } = renderHook(() =>
      useAiChat({
        mode: "dashboard",
        onConversationLoaded: (meta) => {
          loadedMeta = meta;
        },
      }),
    );

    await act(async () => {
      await result.current.loadConversation("conv-proj");
    });

    expect(result.current.conversationId).toBe("conv-proj");
    expect(result.current.conversationTitle).toBe("بررسی بودجه پروژه");
    expect(loadedMeta).toEqual({
      id: "conv-proj",
      title: "بررسی بودجه پروژه",
      projectId: "proj-42",
    });
  });

  it("normalizes missing, unknown, or inaccessible focus values to all", () => {
    expect(normalizeAiAppFocus(null)).toBe("all");
    expect(normalizeAiAppFocus(undefined)).toBe("all");
    expect(normalizeAiAppFocus("invalid-focus")).toBe("all");
    expect(normalizeAiAppFocus("accounting")).toBe("accounting");
    expect(normalizeAiAppFocus("growth", ["all", "workspace", "accounting"])).toBe("all");
    expect(normalizeAiAppFocus("workspace", ["all", "workspace", "accounting"])).toBe("workspace");
  });
});
