"use client";

/**
 * The one guided-tour runtime of the workspace shell (issue #972).
 *
 * Mounted once by `WorkspaceShell`, so every app route shares it — there is no
 * per-page engine and no second help button: the page's existing «آموزش»
 * button calls `startTour`, which loads the tour's steps from the server
 * (eligibility is decided there) and mounts the lazily-loaded overlay.
 *
 * What the provider owns:
 *  - the active tour, and fetching it (`GET /api/knowledge/tours/[id]`);
 *  - progress events, sent in order through one queue so a `complete` can
 *    never overtake the `step_seen` before it;
 *  - ending the tour (paused) when the member leaves the tour's route, so a
 *    spotlight never hangs over a page it was not written for.
 *
 * Progress writes are best-effort: a failed save never blocks the walk-through
 * and a tour is only reported finished when the server accepted `complete`.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { toast } from "sonner";
import { api } from "@/app/dashboard/ui";
import type { TourPlayback, TourProgressEvent, TourProgressView } from "@/lib/tours";
import type { TourExit } from "./tour-overlay";

const TourOverlay = dynamic(() => import("./tour-overlay").then((m) => m.TourOverlay), {
  ssr: false,
});

export interface StartTourOptions {
  /** Start from the first step even when there is a resume point. Never erases progress. */
  fromStart?: boolean;
  /** Focus returns here when the tour ends. */
  returnFocus?: HTMLElement | null;
}

export interface TourRuntime {
  /** Resolves to false when the tour could not be started (not eligible, offline, …). */
  startTour: (tourId: string, options?: StartTourOptions) => Promise<boolean>;
}

const TourContext = createContext<TourRuntime | null>(null);

/** The runtime, or null outside the workspace shell (the button then offers no tour). */
export function useTourRuntime(): TourRuntime | null {
  return useContext(TourContext);
}

interface ActiveTour {
  tour: TourPlayback;
  startIndex: number;
  returnFocus: HTMLElement | null;
}

function startIndexFor(
  tour: TourPlayback,
  progress: TourProgressView,
  fromStart: boolean,
): number {
  if (fromStart || progress.status === "completed" || !progress.resumeStepId) return 0;
  return Math.max(0, tour.steps.findIndex((step) => step.id === progress.resumeStepId));
}

export function TourProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [active, setActive] = useState<ActiveTour | null>(null);
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());
  const activeRef = useRef<ActiveTour | null>(null);
  activeRef.current = active;

  const sendEvent = useCallback((tourId: string, event: TourProgressEvent): Promise<boolean> => {
    const run = queueRef.current.then(async () => {
      try {
        const { ok } = await api(`/api/knowledge/tours/${encodeURIComponent(tourId)}/progress`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(event),
        });
        return ok;
      } catch {
        return false;
      }
    });
    queueRef.current = run;
    return run;
  }, []);

  const startTour = useCallback(
    async (tourId: string, options: StartTourOptions = {}): Promise<boolean> => {
      try {
        const { ok, data } = await api<{ tour?: TourPlayback; progress?: TourProgressView }>(
          `/api/knowledge/tours/${encodeURIComponent(tourId)}`,
        );
        if (!ok || !data.tour || !data.progress || data.tour.steps.length === 0) return false;
        const tour = data.tour;
        setActive({
          tour,
          startIndex: startIndexFor(tour, data.progress, options.fromStart === true),
          returnFocus: options.returnFocus ?? null,
        });
        void sendEvent(tour.id, { type: "start" });
        return true;
      } catch {
        return false;
      }
    },
    [sendEvent],
  );

  const handleEvent = useCallback(
    (event: TourProgressEvent) => {
      const current = activeRef.current;
      return current ? sendEvent(current.tour.id, event) : Promise.resolve(false);
    },
    [sendEvent],
  );

  const handleExit = useCallback((reason: TourExit) => {
    setActive(null);
    if (reason === "completed") toast.success("تور کامل شد.");
    else if (reason === "incomplete") {
      toast.info("بعضی مرحله‌ها دیده نشدند؛ هر وقت خواستید از دکمهٔ آموزش دوباره شروع کنید.");
    }
  }, []);

  // Leaving the tour's page pauses it where it stood.
  useEffect(() => {
    const current = activeRef.current;
    if (!current) return;
    const route = current.tour.route;
    const here = (pathname ?? "").replace(/\/+$/, "") || "/";
    if (here === route) return;
    setActive(null);
    toast.info("تور متوقف شد؛ از دکمهٔ آموزش همان صفحه می‌توانید ادامه دهید.");
  }, [pathname]);

  const runtime = useMemo<TourRuntime>(() => ({ startTour }), [startTour]);

  return (
    <TourContext.Provider value={runtime}>
      {children}
      {active ? (
        <TourOverlay
          key={active.tour.id}
          tour={active.tour}
          startIndex={active.startIndex}
          onEvent={handleEvent}
          onExit={handleExit}
          returnFocus={active.returnFocus}
        />
      ) : null}
    </TourContext.Provider>
  );
}
