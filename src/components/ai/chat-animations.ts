/**
 * GSAP motion vocabulary for the chat surfaces (Phase 36c redesign).
 *
 * Everything funnels through `reducedMotion()` so the whole assistant
 * degrades to instant, still UI for users who asked for it. All helpers are
 * imperative — components call them from useGSAP effects with a scope — and
 * every tween cleans up after itself (`clearProps`) so re-renders never
 * fight a stale transform.
 */
import gsap from "gsap";

export function reducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return true;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const EASE_OUT = "power3.out";
const EASE_BACK = "back.out(1.5)";

/** A chat bubble arriving: drift up, fade in, tiny settle-back scale. */
export function animateBubbleIn(el: HTMLElement): void {
  if (reducedMotion()) return;
  gsap.fromTo(
    el,
    { y: 18, opacity: 0, scale: 0.97, transformOrigin: "center bottom" },
    { y: 0, opacity: 1, scale: 1, duration: 0.45, ease: EASE_BACK, clearProps: "all" },
  );
}

/** Welcome hero: cards stagger up one after another. */
export function animateStaggerIn(parent: HTMLElement, selector: string): void {
  if (reducedMotion()) return;
  gsap.fromTo(
    parent.querySelectorAll<HTMLElement>(selector),
    { y: 16, opacity: 0 },
    {
      y: 0,
      opacity: 1,
      duration: 0.5,
      ease: EASE_OUT,
      stagger: 0.07,
      clearProps: "all",
    },
  );
}

/** The three typing dots, breathing forever until the reply arrives. */
export function animateTypingDots(parent: HTMLElement): gsap.core.Tween | null {
  if (reducedMotion()) return null;
  return gsap.to(parent.querySelectorAll<HTMLElement>("[data-typing-dot]"), {
    y: -4,
    duration: 0.32,
    ease: "sine.inOut",
    stagger: { each: 0.16, repeat: -1, yoyo: true },
  });
}

/** The send button popping when a message becomes sendable. */
export function animateSendPulse(el: HTMLElement): void {
  if (reducedMotion()) return;
  gsap.fromTo(
    el,
    { scale: 0.85 },
    { scale: 1, duration: 0.35, ease: EASE_BACK, clearProps: "all" },
  );
}
