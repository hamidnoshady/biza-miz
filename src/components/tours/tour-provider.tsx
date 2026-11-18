"use client";

/**
 * The one guided-tour runtime of the workspace shell (issue #972).
 *
 * Mounted once by `DashboardMain`, so every app route shares it — there is no
 * per-page engine and no second help button: the page's existing «آموزش»
 * button calls `startTour`, which loads the tour's steps from the server
 * (eligibility is decided there) and mounts the lazily-loaded overlay.
 *
 * What the provider owns:
 *  - the active tour, and fetching it (`GET /api/knowledge/tours/[id]`);
 *  - progress events, sent in order through one queue so a `complete` can
 *    never overtake the `step_seen` before it;
 *  - ending the tour (paused) when the member leaves the tour's route, so a
 *    spotlight never hangs over a page it was not written for — and, when the
 *    step they were on was a verified action, asking the server to confirm it
 *    first, because the action itself (saving a product, submitting an order)
 *    is what navigates away;
 *  - the verify call an `action` step needs (`POST …/verify`), which the server
 *    answers from the domain evidence it recorded when the action succeeded.
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
import { usePathname, useRouter } from "next/navigation";
import { toast } from "sonner";
import { api } from "@/app/dashboard/ui";
import {
  firstTourStepOnRoute,
  tourRoutes,
  tourStepRoute,
  type TourPlayback,
  type TourProgressEvent,
  type TourProgressView,
} from "@/lib/tours";
import {
  browserQueueStorage,
  enqueueTourEvent,
  flushTourQueue,
  type DeliveryResult,
} from "@/lib/tour-progress-queue";
import type { TourActionCheck, TourExit } from "./tour-overlay";

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
  /** Bumped when a route hand-off reopens the overlay at a different step. */
  sequence: number;
}

const SESSION_KEY = "bizamiz.guided-tour.session";
const VIEWER_KEY = "bizamiz.tour-progress-viewer";

interface StoredSession {
  tourId: string;
  stepId: string;
}

/** The tab's active tour, so a refresh or a cross-page hand-off does not lose it. */
function readSession(): StoredSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    return typeof parsed.tourId === "string" && typeof parsed.stepId === "string"
      ? { tourId: parsed.tourId, stepId: parsed.stepId }
      : null;
  } catch {
    return null;
  }
}

function writeSession(session: StoredSession | null): void {
  if (typeof window === "undefined") return;
  try {
    if (session) window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else window.sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Storage can be disabled; progress still lives on the server.
  }
}

function normalizeRoute(pathname: string | null): string {
  return (pathname ?? "").replace(/\/+$/, "") || "/";
}

/** The opaque member key the server attaches to a playback, remembered per tab. */
function writeViewerKey(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(VIEWER_KEY, key);
  } catch {
    // Storage disabled: the queue cannot survive a reload, progress still can.
  }
}

/**
 * Where a resumed tour should open. If the saved step belongs to another page,
 * the member starts from the nearest earlier step on the page they are on, so
 * the first card is never about a screen that is not mounted.
 */
function startIndexFor(
  tour: TourPlayback,
  progress: TourProgressView,
  fromStart: boolean,
  here: string,
): number {
  if (fromStart || progress.status === "completed" || !progress.resumeStepId) return 0;
  const saved = tour.steps.findIndex((step) => step.id === progress.resumeStepId);
  if (saved < 0) return 0;
  if (tourStepRoute(tour, saved) === here) return saved;
  for (let i = saved - 1; i >= 0; i -= 1) {
    if (tourStepRoute(tour, i) === here) return i;
  }
  const firstHere = firstTourStepOnRoute(tour, here);
  return firstHere >= 0 ? firstHere : 0;
}

export function TourProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [active, setActive] = useState<ActiveTour | null>(null);
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());
  const stepRef = useRef<string | null>(null);
  const activeRef = useRef<ActiveTour | null>(null);
  const sequenceRef = useRef(0);
  const handoffRef = useRef<{ route: string; targetIndex: number } | null>(null);
  const restoredRef = useRef(false);
  const sessionKeyRef = useRef<string | null>(null);
  activeRef.current = active;

  /**
   * Delivers anything the tab queued while offline. Progress events are
   * monotone, so a replay is safe; an auth failure clears the queue rather than
   * risking delivery into a different member's account.
   */
  const flushProgress = useCallback(async () => {
    const key = sessionKeyRef.current;
    const storage = browserQueueStorage();
    if (!key || !storage) return;
    await flushTourQueue(storage, key, async (entry): Promise<DeliveryResult> => {
      try {
        const { ok, status } = await api(
          `/api/knowledge/tours/${encodeURIComponent(entry.tourId)}/progress`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              event: entry.event,
              ...(entry.stepId ? { stepId: entry.stepId } : {}),
            }),
          },
        );
        if (ok) return "ok";
        if (status === 401 || status === 403) return "auth";
        if (status >= 500 || status === 429) return "retry";
        return "permanent";
      } catch {
        return "retry";
      }
    }).catch(() => undefined);
  }, []);

  const sendEvent = useCallback((tourId: string, event: TourProgressEvent): Promise<boolean> => {
    // `verified` is server-raised only; a client path must never send it.
    if (event.type === "verified") return Promise.resolve(false);
    const type = event.type;
    const run = queueRef.current.then(async () => {
      const storage = browserQueueStorage();
      const viewerKey = sessionKeyRef.current;
      const queue = (): boolean => {
        if (storage && viewerKey) {
          enqueueTourEvent(
            storage,
            viewerKey,
            tourId,
            type,
            type === "step_seen" || type === "pause" ? event.stepId : undefined,
          );
        }
        // A queued explanation may continue offline; a queued `complete` may
        // not be reported as a finished tour until the server accepted it.
        return type !== "complete";
      };
      try {
        const { ok, status } = await api(`/api/knowledge/tours/${encodeURIComponent(tourId)}/progress`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // The route names the discriminator `event`; the runtime's own is `type`.
          body: JSON.stringify({ ...event, event: type }),
        });
        if (ok) return true;
        if (status === 401 || status === 403) return false;
        if (status >= 500 || status === 429) return queue();
        return false;
      } catch {
        return queue();
      }
    });
    queueRef.current = run;
    return run;
  }, []);

  /**
   * Asks the server whether the member has done an `action` step's work yet.
   * The body is the step id alone: the answer is the server's (it looks up
   * `tour_action_evidence`), not the page's, and a 409 simply means "not yet".
   */
  const verifyStep = useCallback(
    (stepId: string): Promise<TourActionCheck> => {
      const current = activeRef.current;
      if (!current) return Promise.resolve({ status: "error" });
      const run = queueRef.current.then(async (): Promise<TourActionCheck> => {
        try {
          const { ok, status, data } = await api<{
            evidenceAt?: string;
            evidenceBeforeTour?: boolean;
          }>(`/api/knowledge/tours/${encodeURIComponent(current.tour.id)}/verify`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ stepId }),
          });
          if (ok) {
            return {
              status: "verified",
              evidenceAt: data.evidenceAt ?? null,
              beforeTour: data.evidenceBeforeTour === true,
            };
          }
          return { status: status === 409 ? "pending" : "error" };
        } catch {
          return { status: "error" };
        }
      });
      queueRef.current = run;
      return run;
    },
    [],
  );

  const openTour = useCallback(
    async (
      tourId: string,
      options: StartTourOptions & { stepId?: string } = {},
    ): Promise<boolean> => {
      try {
        const { ok, data } = await api<{
          tour?: TourPlayback;
          progress?: TourProgressView;
          sessionKey?: string;
        }>(`/api/knowledge/tours/${encodeURIComponent(tourId)}`);
        if (!ok || !data.tour || !data.progress || data.tour.steps.length === 0) return false;
        if (data.sessionKey) {
          sessionKeyRef.current = data.sessionKey;
          writeViewerKey(data.sessionKey);
          void flushProgress();
        }
        const tour = data.tour;
        const here = normalizeRoute(window.location.pathname);
        let startIndex = startIndexFor(tour, data.progress, options.fromStart === true, here);
        // A refresh restores the exact step, but only when that step's page is
        // the one being shown; otherwise the page-based rule above wins.
        if (options.stepId) {
          const saved = tour.steps.findIndex((step) => step.id === options.stepId);
          if (saved >= 0 && tourStepRoute(tour, saved) === here) startIndex = saved;
        }
        sequenceRef.current += 1;
        const next: ActiveTour = {
          tour,
          startIndex,
          returnFocus: options.returnFocus ?? null,
          sequence: sequenceRef.current,
        };
        setActive(next);
        stepRef.current = tour.steps[startIndex]?.id ?? null;
        if (stepRef.current) writeSession({ tourId: tour.id, stepId: stepRef.current });
        void sendEvent(tour.id, { type: "start" });
        return true;
      } catch {
        return false;
      }
    },
    [flushProgress, sendEvent],
  );

  const startTour = useCallback(
    (tourId: string, options: StartTourOptions = {}): Promise<boolean> => openTour(tourId, options),
    [openTour],
  );

  const handleEvent = useCallback(
    (event: TourProgressEvent) => {
      const current = activeRef.current;
      return current ? sendEvent(current.tour.id, event) : Promise.resolve(false);
    },
    [sendEvent],
  );

  const handleExit = useCallback((reason: TourExit) => {
    writeSession(null);
    stepRef.current = null;
    setActive(null);
    if (reason === "completed") toast.success("تور کامل شد.");
    else if (reason === "incomplete") {
      toast.info("بعضی مرحله‌ها دیده نشدند؛ هر وقت خواستید از دکمهٔ آموزش دوباره شروع کنید.");
    }
  }, []);

  /**
   * A navigate step has already saved its `step_seen` in the overlay. The
   * provider owns the router: it remembers which step waits on the destination
   * so the route-change effect can reopen the same tour there instead of
   * treating the hand-off as the member leaving.
   */
  const handleNavigate = useCallback(
    async (route: string, targetIndex: number) => {
      const current = activeRef.current;
      if (!current) return;
      handoffRef.current = { route: normalizeRoute(route), targetIndex };
      router.push(route);
    },
    [router],
  );

  // Deliver anything a previous offline session queued — but only for the
  // member signed in NOW. The key comes from the server, so a logout/login on
  // a shared device cannot replay one person's events into another's account.
  useEffect(() => {
    let cancelled = false;
    void api<{ sessionKey?: string }>("/api/knowledge/tours/session")
      .then(({ ok, data }) => {
        if (cancelled || !ok || !data.sessionKey) return;
        sessionKeyRef.current = data.sessionKey;
        writeViewerKey(data.sessionKey);
        void flushProgress();
      })
      .catch(() => {
        // Offline on first load: the queue stays until a later mount/online.
      });
    const onOnline = () => void flushProgress();
    window.addEventListener("online", onOnline);
    return () => {
      cancelled = true;
      window.removeEventListener("online", onOnline);
    };
  }, [flushProgress]);

  // A refresh, a desktop reload or a Hybrid reconnect restores the tab's active
  // tour at the step it was on. The server re-checks eligibility, so a stored
  // id can never reveal a tour the member may not use.
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    const session = readSession();
    if (!session) return;
    void openTour(session.tourId, { stepId: session.stepId }).then((started) => {
      if (!started) writeSession(null);
    });
  }, [openTour]);

  // Leaving every route of the tour pauses it; moving between the tour's own
  // pages keeps the workflow alive. A hand-off the runtime started is honoured
  // at its exact destination step.
  useEffect(() => {
    const current = activeRef.current;
    if (!current) return;
    const here = normalizeRoute(pathname);

    const handoff = handoffRef.current;
    if (handoff && handoff.route === here) {
      handoffRef.current = null;
      sequenceRef.current += 1;
      setActive({
        ...current,
        startIndex: Math.min(handoff.targetIndex, current.tour.steps.length - 1),
        sequence: sequenceRef.current,
      });
      return;
    }

    if (tourRoutes(current.tour).includes(here)) {
      const currentStepId = stepRef.current;
      const currentIndex = currentStepId
        ? current.tour.steps.findIndex((step) => step.id === currentStepId)
        : -1;
      if (currentIndex >= 0 && tourStepRoute(current.tour, currentIndex) === here) return;
      const from = Math.max(0, currentIndex);
      let target = firstTourStepOnRoute(current.tour, here, from);
      if (target < 0) target = firstTourStepOnRoute(current.tour, here);
      if (target >= 0) {
        sequenceRef.current += 1;
        setActive({ ...current, startIndex: target, sequence: sequenceRef.current });
        return;
      }
    }

    // The action the member was asked for is often what navigates away (saving
    // a product closes the form). Claim nothing: send the verify and let the
    // server decide — a step the member did not do simply stays unseen.
    const stepId = stepRef.current;
    const step = stepId ? current.tour.steps.find((entry) => entry.id === stepId) : undefined;
    if (stepId && step?.kind === "action") {
      void verifyStep(stepId).then((result) => {
        if (result.status === "verified") toast.success("مرحلهٔ انجام‌شده ثبت شد.");
      });
    }
    stepRef.current = null;
    writeSession(null);
    setActive(null);
    toast.info("تور متوقف شد؛ از دکمهٔ آموزش همان صفحه می‌توانید ادامه دهید.");
  }, [pathname, verifyStep]);

  const runtime = useMemo<TourRuntime>(() => ({ startTour }), [startTour]);

  return (
    <TourContext.Provider value={runtime}>
      {children}
      {active ? (
        <TourOverlay
          key={`${active.tour.id}:${active.sequence}`}
          tour={active.tour}
          startIndex={active.startIndex}
          onEvent={handleEvent}
          onVerify={verifyStep}
          onNavigate={handleNavigate}
          onStepChange={(stepId) => {
            stepRef.current = stepId;
            const current = activeRef.current;
            if (current) writeSession({ tourId: current.tour.id, stepId });
          }}
          onExit={handleExit}
          returnFocus={active.returnFocus}
        />
      ) : null}
    </TourContext.Provider>
  );
}
