import { describe, expect, it, vi } from "vitest";
import { parsePlatformAiEvent, readPlatformAiStream } from "./platform-ai-stream";

describe("playground SSE framing", () => {
  it("parses a named event and keeps Persian text intact", () => {
    expect(parsePlatformAiEvent('event: delta\ndata: {"content":"سلام دنیا"}\n\n')).toEqual({
      event: "delta",
      data: { content: "سلام دنیا" },
    });
  });

  it("ignores comments, malformed JSON, and non-object payloads", () => {
    expect(parsePlatformAiEvent(": keep-alive\n\n")).toBeNull();
    expect(parsePlatformAiEvent('event: delta\ndata: {not json}\n\n')).toBeNull();
    expect(parsePlatformAiEvent('event: delta\ndata: [1,2]\n\n')).toBeNull();
  });

  it("delivers an event split across arbitrary byte boundaries", async () => {
    const text = [
      'event: start\ndata: {"requestId":"r1","tools":[]}\n\n',
      'event: delta\ndata: {"content":"الف"}\n\n',
      'event: done\ndata: {"answer":"الف"}\n\n',
    ].join("");
    const bytes = new TextEncoder().encode(text);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        // Two-byte chunks split every event, including the Persian UTF-8 bytes.
        for (let index = 0; index < bytes.length; index += 2) controller.enqueue(bytes.slice(index, index + 2));
        controller.close();
      },
    });
    const seen: string[] = [];
    const onEvent = vi.fn((event: { event: string }) => {
      seen.push(event.event);
      return event.event === "done";
    });
    await expect(readPlatformAiStream(body, onEvent)).resolves.toEqual({ terminal: true });
    expect(seen).toEqual(["start", "delta", "done"]);
  });

  it("reports an unterminated stream as non-terminal", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: delta\ndata: {"content":"نیمه"}\n\n'));
        controller.close();
      },
    });
    const onEvent = vi.fn(() => false);
    await expect(readPlatformAiStream(body, onEvent)).resolves.toEqual({ terminal: false });
    expect(onEvent).toHaveBeenCalledTimes(1);
  });
});
