"use client";

/**
 * Issue #1546 (Fast truthfulness) — the picker's view of which chat modes are
 * configured for this deployment.
 *
 * Every mode starts available: discovery must never hide a working mode because
 * a request failed or an older server answered. When the server does answer, its
 * decision replaces the optimistic default, so Fast disappears for a tenant
 * whose alias is not configured instead of being offered and then refused. The
 * chat route's refusal remains the backstop either way.
 */
import { useEffect, useState } from "react";
import {
  AI_CHAT_MODES,
  normalizeAiModeAvailability,
  type AiModeAvailability,
} from "@/lib/ai-runtime-modes-shared";

function allModesAvailable(): AiModeAvailability[] {
  return AI_CHAT_MODES.map((mode) => ({ mode, available: true, reason: null }));
}

export function useAiModeAvailability({
  enabled = true,
}: { enabled?: boolean } = {}): {
  modes: AiModeAvailability[];
  loading: boolean;
} {
  const [modes, setModes] = useState<AiModeAvailability[]>(allModesAvailable);
  const [loading, setLoading] = useState(enabled);

  useEffect(() => {
    if (!enabled) {
      setModes(allModesAvailable());
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const response = await fetch("/api/ai/modes", {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!response.ok) return;
        const data = (await response.json()) as { modes?: unknown };
        const parsed = normalizeAiModeAvailability(data?.modes);
        if (!cancelled && parsed) setModes(parsed);
      } catch {
        // Keep the optimistic default; the server refusal still protects a turn.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return { modes, loading };
}
