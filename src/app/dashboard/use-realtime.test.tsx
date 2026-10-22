// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRealtime, type RealtimeLifecycle } from "./use-realtime";

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  drop() {
    this.readyState = 3;
    this.onclose?.(new Event("close"));
  }

  close() {
    this.readyState = 3;
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useRealtime recovery lifecycle", () => {
  it("signals reconnect and visible-tab recovery so snapshot consumers can refetch", () => {
    const onLifecycle = vi.fn<(status: RealtimeLifecycle) => void>();
    renderHook(() => useRealtime(vi.fn(), onLifecycle));
    const first = FakeWebSocket.instances[0]!;
    expect(first.url).toMatch(/^ws:\/\//);

    act(() => first.open());
    expect(onLifecycle).toHaveBeenLastCalledWith({ connected: true, recovery: undefined });
    act(() => first.drop());
    expect(onLifecycle).toHaveBeenLastCalledWith({ connected: false });

    act(() => vi.advanceTimersByTime(1_000));
    const second = FakeWebSocket.instances[1]!;
    act(() => second.open());
    expect(onLifecycle).toHaveBeenLastCalledWith({ connected: true, recovery: "reconnect" });

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(onLifecycle).toHaveBeenLastCalledWith({ connected: true, recovery: "visibility" });
  });
});
