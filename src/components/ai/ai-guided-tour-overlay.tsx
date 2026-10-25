"use client";

import { useEffect, useRef, useState } from "react";
import { XIcon, ArrowLeftIcon, ArrowRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AI_GUIDED_TOUR_EVENT, type AiGuidedTourEventDetail } from "@/lib/ai-guided-tour-events";
import { isAiGuideTarget, type AiGuideStep } from "@/lib/ai-guided-tours";

type ActiveGuide = { id: string; label: string; steps: readonly AiGuideStep[] };
type Rect = { left: number; top: number; width: number; height: number };

/**
 * Accessible walkthrough over *registered* app targets. This intentionally
 * does not accept model-authored CSS, arbitrary DOM mutations or page clicks.
 */
export function AiGuidedTourOverlay() {
  const [guide, setGuide] = useState<ActiveGuide | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const requestRef = useRef<AbortController | null>(null);

  useEffect(() => {
    function onStart(event: Event) {
      const detail = (event as CustomEvent<AiGuidedTourEventDetail>).detail;
      if (!detail || typeof detail.guideId !== "string" || detail.guideId.length > 80) return;
      requestRef.current?.abort();
      const controller = new AbortController();
      requestRef.current = controller;
      // Verify against the user's current tenant/session *at tour start*.
      void fetch("/api/ai/guided-tour", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({ guideId: detail.guideId }),
        signal: controller.signal,
      }).then(async (response) => response.ok ? response.json() : null)
        .then((payload: { guide?: ActiveGuide } | null) => {
          if (controller.signal.aborted) return;
          const candidate = payload?.guide;
          if (!candidate || candidate.id !== detail.guideId ||
              !Array.isArray(candidate.steps) || candidate.steps.length === 0 ||
              candidate.steps.length > 8 || !candidate.steps.every((step) =>
                isAiGuideTarget(step.target) &&
                typeof step.title === "string" && step.title.length < 150 &&
                typeof step.explanation === "string" && step.explanation.length < 1000)) return;
          setGuide(candidate);
          setStepIndex(0);
        }).catch(() => {/* An unavailable tour never reveals unauthorized targets. */});
    }
    window.addEventListener(AI_GUIDED_TOUR_EVENT, onStart);
    return () => {
      requestRef.current?.abort();
      window.removeEventListener(AI_GUIDED_TOUR_EVENT, onStart);
    };
  }, []);

  const step = guide?.steps[stepIndex] ?? null;

  useEffect(() => {
    if (!step) { setRect(null); return; }
    // Data attribute key comes only from the static registry, never the LLM.
    const element = document.querySelector<HTMLElement>(`[data-ai-guide="${step.target}"]`);
    if (!element) { setRect(null); return; }
    element.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
    const update = () => {
      const box = element.getBoundingClientRect();
      setRect(box.width > 0 && box.height > 0
        ? { left: box.left, top: box.top, width: box.width, height: box.height }
        : null);
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [step]);

  useEffect(() => {
    if (!guide) return;
    const prior = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    buttonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setGuide(null); }
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        event.preventDefault();
        setStepIndex((index) => Math.max(0, Math.min(guide.steps.length - 1, index + (event.key === "ArrowRight" ? 1 : -1))));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("keydown", onKeyDown); prior?.focus(); };
  }, [guide]);

  if (!guide || !step) return null;
  const last = stepIndex === guide.steps.length - 1;

  return (
    <div className="fixed inset-0 z-[100] isolate" role="dialog" aria-modal="true"
      aria-label={guide.label} dir="rtl">
      <div aria-hidden="true" className="absolute inset-0 bg-black/35" />
      {rect ? (
        <div aria-hidden="true" className="pointer-events-none fixed z-[101] rounded-md border-[3px] border-primary bg-primary/10 ring-2 ring-background"
          style={{ left: rect.left - 5, top: rect.top - 5, width: rect.width + 10, height: rect.height + 10 }} />
      ) : null}
      <section className="fixed bottom-4 left-4 right-4 z-[102] mx-auto max-w-md space-y-3 rounded-2xl border border-border bg-card p-4 text-card-foreground shadow-2xl sm:bottom-8"
        aria-live="polite">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-semibold text-muted-foreground">{guide.label} · {stepIndex + 1} از {guide.steps.length}</p>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="خروج از راهنما" onClick={() => setGuide(null)}><XIcon className="size-4" /></Button>
        </div>
        <h2 className="text-base font-semibold">{step.title}</h2>
        <p className="text-sm leading-6">{step.explanation}</p>
        {!rect ? <p className="text-xs text-amber-700 dark:text-amber-300">این قسمت در نمای فعلی دیده نمی‌شود؛ در صورت نیاز منو را باز کنید یا به صفحه اصلی بروید.</p> : null}
        <div className="flex items-center justify-between gap-2">
          <Button type="button" variant="outline" disabled={stepIndex === 0}
            onClick={() => setStepIndex((n) => Math.max(0, n - 1))}>
            <ArrowRightIcon className="size-4" /> قبلی
          </Button>
          <Button type="button" ref={buttonRef}
            onClick={() => last ? setGuide(null) : setStepIndex((n) => n + 1)}>
            {last ? "پایان راهنما" : "بعدی"} <ArrowLeftIcon className="size-4" />
          </Button>
        </div>
      </section>
    </div>
  );
}
