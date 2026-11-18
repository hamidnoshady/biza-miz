// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlatformAiChatPanel, PlatformAiChatProvider } from "./platform-ai-chat-session";

afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); });

const panel = (scope: string) => render(<PlatformAiChatProvider sessionScope={scope}>
  <PlatformAiChatPanel />
</PlatformAiChatProvider>);

function stream(...parts: object[]) {
  return new Response(parts.map((part) => `data: ${JSON.stringify(part)}\n\n`).join(""), {
    headers: { "Content-Type": "text/event-stream" },
  });
}

function send(message: string) {
  fireEvent.change(screen.getByRole("textbox", { name: "پیام آزمایشی" }), { target: { value: message } });
  fireEvent.click(screen.getByRole("button", { name: "ارسال پیام آزمایشی" }));
}

describe("shared Superadmin chat", () => {
  it("defaults to model-only and restores history only for the matching authentication session", async () => {
    const fetchMock = vi.fn(async () => stream({ type: "text-delta", delta: "پاسخ ذخیره‌شده" }, { type: "finish" }));
    vi.stubGlobal("fetch", fetchMock);
    const view = panel("first-login");
    fireEvent.click(screen.getByRole("button", { name: "حالت پاسخ‌گویی: سریع" }));
    send("سؤال");
    await screen.findByText("پاسخ ذخیره‌شده");
    await waitFor(() => expect((screen.getByRole("textbox", { name: "پیام آزمایشی" }) as HTMLTextAreaElement).value).toBe(""));
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(String(init.body))).toMatchObject({ tools: false, mode: "instant" });
    view.unmount();
    const other = panel("second-login");
    expect(screen.queryByText("پاسخ ذخیره‌شده")).toBeNull();
    other.unmount();
    panel("first-login");
    expect(screen.getByText("پاسخ ذخیره‌شده")).toBeTruthy();
    expect(screen.getByRole("button", { name: "حالت پاسخ‌گویی: سریع" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps the draft on failure and retries a tool-enabled turn with tools off", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(stream({ type: "text-delta", delta: "بخشی از پاسخ" }))
      .mockResolvedValueOnce(stream({ type: "text-delta", delta: "پاسخ کامل" }, { type: "finish" }));
    vi.stubGlobal("fetch", fetchMock);
    panel("test-login");
    fireEvent.click(screen.getByRole("checkbox"));
    send("سؤال");
    await screen.findByRole("alert");
    expect(screen.getByText("بخشی از پاسخ")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "پیام آزمایشی" }) as HTMLTextAreaElement).value).toBe("سؤال");
    fireEvent.click(screen.getByRole("button", { name: "ارسال دوبارهٔ پیام آزمایشی" }));
    await screen.findByText("پاسخ کامل");
    expect(JSON.parse(String(fetchMock.mock.calls[1][1].body))).toMatchObject({ tools: false, history: [] });
    expect(sessionStorage.getItem("platform-ai:test-login")).toBeNull();
  });

  it("reports Stop after the final event arrives and keeps the turn available for retry", async () => {
    const encoder = new TextEncoder();
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(encoder.encode(
          'data: {"type":"text-delta","delta":"پاسخ متوقف‌شده"}\n\ndata: {"type":"finish"}\n\n',
        ));
      },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(body, { headers: { "Content-Type": "text/event-stream" } }))
      .mockResolvedValueOnce(stream({ type: "text-delta", delta: "پاسخ دوباره" }, { type: "finish" }));
    vi.stubGlobal("fetch", fetchMock);
    panel("stop-login");
    send("سؤال");
    await screen.findByText("پاسخ متوقف‌شده");
    fireEvent.click(screen.getByRole("button", { name: "توقف پاسخ" }));
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true);
    streamController.close();

    expect((await screen.findByRole("alert")).textContent).toBe("تولید پاسخ متوقف شد.");
    expect(JSON.parse(sessionStorage.getItem("platform-ai:stop-login") ?? "{}").turns).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "ارسال دوبارهٔ پیام آزمایشی" }));
    await screen.findByText("پاسخ دوباره");
    expect(JSON.parse(String(fetchMock.mock.calls[1][1].body))).toMatchObject({ message: "سؤال", history: [] });
  });
});
