"use client";

import { useEffect, useRef } from "react";

export interface RealtimeEvent {
  type:
    | "order.created"
    | "order.updated"
    | "order.item_status"
    | "table.status"
    | "table_session.updated"
    | "floor.updated"
    | "inventory.low_stock";
  [key: string]: unknown;
}

export interface RealtimeLifecycle {
  connected: boolean;
  recovery?: "reconnect" | "visibility";
}

/**
 * Connects to the server's `/ws` sync channel and calls `onEvent` for every
 * message. Lifecycle notifications let snapshot-based consumers refetch after
 * a transport gap or when a suspended tab becomes visible again; a WebSocket
 * is a change signal, not a durable event log.
 */
export function useRealtime(
  onEvent: (event: RealtimeEvent) => void,
  onLifecycle?: (status: RealtimeLifecycle) => void,
): void {
  const handlerRef = useRef(onEvent);
  const lifecycleRef = useRef(onLifecycle);
  handlerRef.current = onEvent;
  lifecycleRef.current = onLifecycle;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closedByCleanup = false;
    let hasConnected = false;
    let wasHidden = document.visibilityState === "hidden";
    let retryMs = 1000;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      if (closedByCleanup) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
      ws.onopen = () => {
        const recovery = hasConnected ? "reconnect" : undefined;
        hasConnected = true;
        retryMs = 1000;
        lifecycleRef.current?.({ connected: true, recovery });
      };
      ws.onmessage = (ev) => {
        try {
          handlerRef.current(JSON.parse(ev.data));
        } catch {
          // Ignore malformed frames.
        }
      };
      ws.onclose = () => {
        if (closedByCleanup) return;
        lifecycleRef.current?.({ connected: false });
        retryTimer = setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, 15_000);
      };
    }

    function onVisibilityChange() {
      if (document.visibilityState === "hidden") {
        wasHidden = true;
        return;
      }
      if (!wasHidden) return;
      wasHidden = false;
      lifecycleRef.current?.({
        connected: ws?.readyState === WebSocket.OPEN,
        recovery: "visibility",
      });
    }

    document.addEventListener("visibilitychange", onVisibilityChange);
    connect();

    return () => {
      closedByCleanup = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (retryTimer) clearTimeout(retryTimer);
      ws?.close();
    };
  }, []);
}
