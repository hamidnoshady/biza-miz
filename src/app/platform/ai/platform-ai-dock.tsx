"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { SparklesIcon, PanelLeftCloseIcon, PanelLeftOpenIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { PlatformAiChatPanel } from "./platform-ai-chat-session";

/**
 * Persistently mounted in the authenticated platform layout (never in tenant
 * routes). Shares the same test session with /platform/ai/playground.
 * No tenant action tools or credentials enter this UI.
 */
export function PlatformAiDock() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [isWide, setWide] = useState(true);
  const [width, setWidth] = useState(420);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const panel = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 900px)");
    const update = () => setWide(mq.matches);
    update(); mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    try {
      setOpen(window.localStorage.getItem("biza:platform:ai-open") === "yes");
      const value = Number(window.localStorage.getItem("biza:platform:ai-width"));
      if (Number.isFinite(value) && value >= 320 && value <= 720) setWidth(value);
    } catch { /* private browsers may disable storage */ }
  }, []);

  function toggle(value: boolean) {
    setOpen(value);
    try { window.localStorage.setItem("biza:platform:ai-open", value ? "yes" : "no"); } catch { /* optional */ }
  }
  function setBoundedWidth(value: number) {
    const next = Math.max(320, Math.min(720, Math.min(window.innerWidth - 400, Math.round(value))));
    setWidth(next);
    try { window.localStorage.setItem("biza:platform:ai-width", String(next)); } catch { /* optional */ }
  }
  // Full playground shares this session and renders it at page width.
  if (pathname === "/platform/ai/playground") return null;

  return <>
    {isWide && open ? <aside ref={panel} aria-label="دستیار مدیر پلتفرم"
      style={{ width }} className="sticky top-0 z-30 flex h-screen min-w-[320px] max-w-[calc(100vw-400px)] shrink-0 flex-col border-r border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-semibold"><SparklesIcon className="size-4" /> دستیار مدیر پلتفرم</span>
        <Button size="icon-sm" variant="ghost" aria-label="جمع کردن دستیار" onClick={() => toggle(false)}>
          <PanelLeftCloseIcon className="size-4" />
        </Button>
      </div>
      <PlatformAiChatPanel compact />
      <div role="separator" aria-label="تغییر عرض دستیار مدیر پلتفرم" tabIndex={0} aria-orientation="vertical"
        aria-valuemin={320} aria-valuemax={720} aria-valuenow={width}
        className="absolute inset-y-0 right-0 w-2 translate-x-1/2 cursor-col-resize touch-none hover:bg-primary/15 focus-visible:bg-primary/20 focus-visible:outline"
        onPointerDown={(e) => { if (!panel.current || e.button !== 0) return; e.preventDefault(); drag.current = { x: e.clientX, width: panel.current.getBoundingClientRect().width }; e.currentTarget.setPointerCapture(e.pointerId); }}
        onPointerMove={(e) => { if (drag.current) setBoundedWidth(drag.current.width + e.clientX - drag.current.x); }}
        onPointerUp={(e) => { drag.current = null; if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }}
        onPointerCancel={() => { drag.current = null; }}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); setBoundedWidth(width + (e.key === "ArrowRight" ? 20 : -20)); }
        }}
      />
    </aside> : null}
    {isWide && !open ? <Button type="button" size="icon-sm"
      className="fixed bottom-5 left-5 z-30 rounded-full" title="باز کردن دستیار پلتفرم"
      aria-label="باز کردن دستیار پلتفرم" onClick={() => toggle(true)}>
      <PanelLeftOpenIcon className="size-4" />
    </Button> : null}
    {!isWide ? <>
      <Button size="icon-sm" type="button" className="fixed bottom-5 left-5 z-40 rounded-full"
        aria-label="باز کردن دستیار پلتفرم" onClick={() => setMobile(true)}><SparklesIcon className="size-4" /></Button>
      <Sheet open={mobile} onOpenChange={setMobile}>
        <SheetContent side="left" className="flex h-full w-[min(95vw,440px)] max-w-none flex-col p-3" dir="rtl">
          <SheetHeader>
            <SheetTitle>دستیار مدیر پلتفرم</SheetTitle>
            <SheetDescription>فقط آزمایش مدل و پرامپت؛ بدون دسترسی به داده‌های تنانت</SheetDescription>
          </SheetHeader>
          <PlatformAiChatPanel compact />
        </SheetContent>
      </Sheet>
    </> : null}
  </>;
}
