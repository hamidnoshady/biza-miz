"use client";

/**
 * The guided-tour overlay (issue #972): a dimmed page with a cut-out around
 * the step's anchor and a popover that explains it.
 *
 * Mounted by `TourProvider` only while a tour runs — it is lazy-loaded and
 * inactive by default, one overlay for the whole workspace shell rather than
 * one engine per page. It never clicks, types into or reads the page: the
 * only thing it does to the host UI is scroll an anchor into view. Anchors
 * are found by `data-tour-id` (see `TOUR_ANCHORS`), never by class or label.
 *
 * Nothing here can trap a member:
 *  - Escape and the close button pause the tour at the current step;
 *  - an anchor that is missing, hidden or unmounted for a few seconds turns
 *    the step into a plain explanation with a note, and Next/Skip still work;
 *  - the page behind is blocked from clicks while a step is showing (a tour
 *    must not trigger a real action by accident), but that blocker is
 *    removed with the overlay.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeftIcon, ArrowRightIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toPersianDigits } from "@/lib/digits";
import {
  isPointable,
  placePopover,
  spotlightBox,
  type Box,
  type Size,
} from "@/lib/tour-geometry";
import {
  TOUR_ANCHOR_ATTRIBUTE,
  type TourPlayback,
  type TourProgressEvent,
} from "@/lib/tours";

/** How long a missing anchor is waited for before the step degrades to an explanation. */
const ANCHOR_WAIT_MS = 3000;

export type TourExit = "completed" | "incomplete" | "paused";

export interface TourOverlayProps {
  tour: TourPlayback;
  startIndex: number;
  /** Queues a progress event; resolves to whether the server accepted it. */
  onEvent: (event: TourProgressEvent) => Promise<boolean>;
  onExit: (reason: TourExit) => void;
  /** Where focus goes when the tour ends — the button that started it. */
  returnFocus?: HTMLElement | null;
}

function readBox(el: Element): Box {
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function TourOverlay({ tour, startIndex, onEvent, onExit, returnFocus }: TourOverlayProps) {
  const titleId = useId();
  const bodyId = useId();
  const popoverRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const targetRef = useRef<HTMLElement | null>(null);

  const [index, setIndex] = useState(() =>
    Math.min(Math.max(0, startIndex), tour.steps.length - 1),
  );
  const [box, setBox] = useState<Box | null>(null);
  const [missing, setMissing] = useState(false);
  const [lostNonce, setLostNonce] = useState(0);
  const [popoverSize, setPopoverSize] = useState<Size>({ width: 352, height: 200 });
  const [viewport, setViewport] = useState<Size>({ width: 1024, height: 768 });

  const step = tour.steps[index];
  const isLast = index === tour.steps.length - 1;
  const isSpotlight = step.kind === "spotlight" && Boolean(step.anchor);

  // Remember where focus was so closing the tour hands it back.
  useEffect(() => {
    const active = document.activeElement;
    returnFocusRef.current =
      returnFocus ?? (active instanceof HTMLElement && active !== document.body ? active : null);
    return () => {
      const el = returnFocusRef.current;
      if (el && el.isConnected) el.focus({ preventScroll: true });
    };
    // Only the start-time button matters; later prop changes must not re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Viewport size.
  useEffect(() => {
    const update = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  // Find the step's anchor; wait for it if it is not mounted yet.
  useEffect(() => {
    targetRef.current = null;
    setBox(null);
    setMissing(false);
    if (!isSpotlight || !step.anchor) return;
    const selector = `[${TOUR_ANCHOR_ATTRIBUTE}="${step.anchor}"]`;

    let settled = false;
    const tryLocate = () => {
      if (settled) return;
      const el = document.querySelector<HTMLElement>(selector);
      if (!el || !isPointable(readBox(el))) return;
      settled = true;
      observer.disconnect();
      window.clearTimeout(timeout);
      targetRef.current = el;
      el.scrollIntoView({
        block: "center",
        inline: "nearest",
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
      setBox(readBox(el));
    };
    const observer = new MutationObserver(tryLocate);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      setMissing(true);
    }, ANCHOR_WAIT_MS);
    tryLocate();

    return () => {
      settled = true;
      observer.disconnect();
      window.clearTimeout(timeout);
    };
  }, [index, isSpotlight, step.anchor, lostNonce]);

  // Follow the anchor while the page scrolls, resizes or re-renders.
  useEffect(() => {
    if (!isSpotlight || !step.anchor) return;
    const selector = `[${TOUR_ANCHOR_ATTRIBUTE}="${step.anchor}"]`;
    let frame = 0;
    const update = () => {
      frame = 0;
      let el = targetRef.current;
      if (!el) return;
      if (!el.isConnected) {
        el = document.querySelector<HTMLElement>(selector);
        if (!el) {
          // Unmounted by a re-render: go back to waiting for it.
          targetRef.current = null;
          setBox(null);
          setLostNonce((n) => n + 1);
          return;
        }
        targetRef.current = el;
      }
      const next = readBox(el);
      setBox(isPointable(next) ? next : null);
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    window.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule);
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    if (targetRef.current) resizeObserver?.observe(targetRef.current);
    return () => {
      window.removeEventListener("scroll", schedule, { capture: true });
      window.removeEventListener("resize", schedule);
      resizeObserver?.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [index, isSpotlight, step.anchor, lostNonce, box !== null]);

  // The popover's own size drives its placement.
  useLayoutEffect(() => {
    const el = popoverRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPopoverSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
  }, [index, missing, box, viewport]);

  // Each step announces itself by taking focus.
  // The «آموزش» dialog may still be animating closed (and holding a focus
  // trap) on the first step, so the first attempt is retried once.
  useEffect(() => {
    const focus = () => {
      const el = popoverRef.current;
      if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
    };
    const frame = window.requestAnimationFrame(focus);
    const retry = window.setTimeout(focus, 300);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(retry);
    };
  }, [index]);

  const pauseAndExit = useCallback(() => {
    void onEvent({ type: "pause", stepId: step.id });
    onExit("paused");
  }, [onEvent, onExit, step.id]);

  const goNext = useCallback(async () => {
    const seen = await onEvent({ type: "step_seen", stepId: step.id });
    if (!isLast) {
      setIndex((i) => Math.min(i + 1, tour.steps.length - 1));
      return;
    }
    // A step that failed to save must not be reported as a finished tour.
    const completed = seen && (await onEvent({ type: "complete" }));
    onExit(completed ? "completed" : "incomplete");
  }, [isLast, onEvent, onExit, step.id, tour.steps.length]);

  const goBack = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);

  // Skipping is not completing: nothing is recorded for the step.
  const skip = useCallback(() => {
    if (isLast) {
      pauseAndExit();
      return;
    }
    setIndex((i) => i + 1);
  }, [isLast, pauseAndExit]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        pauseAndExit();
        return;
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        const rtl = document.documentElement.dir === "rtl";
        const forward = rtl ? event.key === "ArrowLeft" : event.key === "ArrowRight";
        event.preventDefault();
        if (forward) void goNext();
        else if (index > 0) goBack();
        return;
      }
      if (event.key === "Tab" && popoverRef.current) {
        const focusable = Array.from(
          popoverRef.current.querySelectorAll<HTMLElement>("button:not([disabled])"),
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;
        if (event.shiftKey && (active === first || active === popoverRef.current)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && active === last) {
          event.preventDefault();
          first.focus();
        } else if (!popoverRef.current.contains(active)) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [goBack, goNext, index, pauseAndExit]);

  const pointing = isSpotlight && !missing && box !== null;
  const cutout = pointing ? spotlightBox(box, viewport) : null;
  const position = placePopover(cutout, popoverSize, viewport);
  const total = tour.steps.length;
  const motion = "transition-[top,left,width,height] duration-200 motion-reduce:transition-none";

  return (
    <div data-tour-overlay="" className="contents">
      {/* Blocks clicks on the page behind: a tour explains, it never operates. */}
      <div aria-hidden="true" className="fixed inset-0 z-[70]" />
      {cutout ? (
        <div
          aria-hidden="true"
          className={`pointer-events-none fixed z-[70] rounded-xl ring-2 ring-primary ${motion}`}
          style={{
            top: cutout.top,
            left: cutout.left,
            width: cutout.width,
            height: cutout.height,
            boxShadow: "0 0 0 9999px rgb(0 0 0 / 0.6)",
          }}
        />
      ) : (
        <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-[70] bg-black/60" />
      )}
      <div
        ref={popoverRef}
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        tabIndex={-1}
        dir="rtl"
        className={`fixed z-[71] max-h-[calc(100dvh-1rem)] w-[min(22rem,calc(100vw-1rem))] overflow-y-auto rounded-xl border border-border bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 outline-none ${motion}`}
        style={{ top: position.top, left: position.left }}
      >
        <div className="flex items-start justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {tour.title} · مرحلهٔ {toPersianDigits(index + 1)} از {toPersianDigits(total)}
          </p>
          <button
            type="button"
            onClick={pauseAndExit}
            aria-label="بستن تور"
            className="-m-2 inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <XIcon className="size-4" aria-hidden="true" />
          </button>
        </div>
        <h2 id={titleId} className="mt-1 text-base font-bold text-foreground">
          {step.title}
        </h2>
        <p id={bodyId} className="mt-1.5 leading-6 text-foreground/80">
          {step.body}
        </p>
        {isSpotlight && missing ? (
          <p role="status" className="mt-2 rounded-lg bg-muted px-3 py-2 text-xs leading-5 text-muted-foreground">
            این بخش اکنون روی صفحه نیست (شاید برای نقش یا وضعیت فعلی شما نمایش داده نمی‌شود). می‌توانید از این مرحله بگذرید.
          </p>
        ) : null}
        <div
          className="mt-3 h-1 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-label="پیشرفت تور"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={index + 1}
        >
          <div
            className="h-full bg-primary transition-[width] motion-reduce:transition-none"
            style={{ width: `${((index + 1) / total) * 100}%` }}
          />
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={skip} className="min-h-9">
            {isLast ? "بعداً ادامه می‌دهم" : "رد شدن"}
          </Button>
          <div className="flex items-center gap-2">
            {index > 0 ? (
              <Button type="button" variant="outline" size="sm" onClick={goBack} className="min-h-9">
                <ArrowRightIcon className="size-3.5" aria-hidden="true" />
                قبلی
              </Button>
            ) : null}
            <Button type="button" size="sm" onClick={() => void goNext()} className="min-h-9 font-semibold">
              {isLast ? "پایان" : "بعدی"}
              {isLast ? null : <ArrowLeftIcon className="size-3.5" aria-hidden="true" />}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
