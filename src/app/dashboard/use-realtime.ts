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

/**
 * Connects to the server's `/ws` sync channel (server.ts + src/lib/realtime.ts)
 * and calls `onEvent` for every message. Reconnects with backoff so a screen
 * left open across a server restart keeps syncing. The session cookie is
 * sent automatically (same-origin WebSocket handshake).
 */
export function useRealtime(onEvent: (event: RealtimeEvent) => void): void {
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closedByCleanup = false;
    let retryMs = 1000;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
      ws.onopen = () => {
        retryMs = 1000;
      };
      ws.onmessage = (ev) => {
        try {
          handlerRef.current(JSON.parse(ev.data));
        } catch {
          // ignore malformed frames
        }
      };
      ws.onclose = () => {
        if (closedByCleanup) return;
        retryTimer = setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, 15_000);
      };
    }
    connect();

    return () => {
      closedByCleanup = true;
      if (retryTimer) clearTimeout(retryTimer);
      ws?.close();
    };
  }, []);
}
