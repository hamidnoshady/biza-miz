// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlatformAiChatProvider, usePlatformAiChat } from "./platform-ai-chat-session";
import { api } from "@/app/platform/ui";
vi.mock("@/app/platform/ui", () => ({ api: vi.fn() }));
let chat: ReturnType<typeof usePlatformAiChat>;
function Probe({ page }: { page: string }) { chat = usePlatformAiChat(); return <span>{page}</span>; }
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe("persistent Superadmin conversation", () => {
  it("keeps an in-flight turn and draft across page presentation changes, with one request", async () => {
    let resolve!: (value: Awaited<ReturnType<typeof api>>) => void;
    vi.mocked(api).mockImplementation(() => new Promise((done) => { resolve = done; }));
    const view = render(<PlatformAiChatProvider><Probe page="playground" /></PlatformAiChatProvider>);
    act(() => chat.setText("سؤال"));
    let pending!: Promise<void>;
    act(() => { pending = chat.send(); void chat.send(); });
    expect(api).toHaveBeenCalledTimes(1);
    view.rerender(<PlatformAiChatProvider><Probe page="prompts" /></PlatformAiChatProvider>);
    expect(chat.busy).toBe(true);
    expect(chat.text).toBe("سؤال");
    await act(async () => { resolve({ ok: true, status: 200, aborted: false, data: { answer: "پاسخ", modelAlias: "thinking" } }); await pending; });
    expect(chat.turns).toEqual([{ role: "user", content: "سؤال" }, { role: "assistant", content: "پاسخ" }]);
    expect(chat.busy).toBe(false);
  });
  it("drops a late response after reset and aborts its request", async () => {
    let resolve!: (value: Awaited<ReturnType<typeof api>>) => void;
    vi.mocked(api).mockImplementation(() => new Promise((done) => { resolve = done; }));
    render(<PlatformAiChatProvider><Probe page="playground" /></PlatformAiChatProvider>);
    act(() => chat.setText("قدیمی"));
    let pending!: Promise<void>;
    act(() => { pending = chat.send(); });
    const signal = vi.mocked(api).mock.calls[0][1]?.signal;
    act(() => chat.reset());
    expect(signal?.aborted).toBe(true);
    await act(async () => { resolve({ ok: true, status: 200, aborted: false, data: { answer: "پاسخ قدیمی" } }); await pending; });
    expect(chat.turns).toEqual([]);
    expect(chat.busy).toBe(false);
  });
});
