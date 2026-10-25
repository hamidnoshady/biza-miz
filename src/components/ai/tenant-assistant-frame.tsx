"use client";

import { useEffect, useState, useRef, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { PanelLeftCloseIcon, PanelLeftOpenIcon, SparklesIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { AiChatHub, type AiChatHubProps } from "@/app/dashboard/ai/ai-chat-hub";

interface Props {
  children: ReactNode;
  account: string;
  enabled: boolean;
  aiProps: AiChatHubProps;
}

/** One chat workspace, two presentations: full home / persistent physical-left sidebar. */
export function TenantAssistantFrame({ children, account, enabled, aiProps }: Props) {
  const pathname = usePathname();
  const home = pathname === "/dashboard";
  const [open, setOpen] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [wide, setWide] = useState(true);
  const [panelWidth, setPanelWidth] = useState(408);
  const dragStart = useRef<{ x: number; width: number } | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const media = window.matchMedia("(min-width: 1024px)");
    const sync = () => setWide(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    try { setOpen(window.localStorage.getItem(`biza:ai:sidebar:${account}`) !== "closed"); }
    catch { setOpen(true); }
  }, [account]);

  useEffect(() => {
    try {
      const value = Number(window.localStorage.getItem(`biza:ai:panel-width:${account}`));
      setPanelWidth(Number.isFinite(value) && value >= 300 ? Math.min(720, value) : 408);
    } catch { setPanelWidth(408); }
  }, [account]);

  const persistPanelWidth = (width: number) => {
    const bounded = Math.round(Math.max(300, Math.min(720, Math.min(window.innerWidth - 420, width))));
    setPanelWidth(bounded);
    try { window.localStorage.setItem(`biza:ai:panel-width:${account}`, String(bounded)); }
    catch { /* Device persistence is optional. */ }
  };

  function startResize(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !panelRef.current) return;
    event.preventDefault();
    dragStart.current = { x: event.clientX, width: panelRef.current.getBoundingClientRect().width };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function updateResize(event: React.PointerEvent<HTMLDivElement>) {
    if (!dragStart.current) return;
    // The chat sits at the PHYSICAL LEFT, so its right edge is the handle.
    persistPanelWidth(dragStart.current.width + event.clientX - dragStart.current.x);
  }

  function finishResize(event: React.PointerEvent<HTMLDivElement>) {
    dragStart.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function setSidebar(openNext: boolean) {
    setOpen(openNext);
    try { window.localStorage.setItem(`biza:ai:sidebar:${account}`, openNext ? "open" : "closed"); }
    catch { /* Privacy-mode browsers can refuse storage. */ }
  }

  return (
    <>
      {/* The existing route content stays mounted; only the dashboard's empty
          placeholder is hidden while the shared full-page assistant is shown. */}
      <div className={home && enabled ? "hidden" : "contents"}>{children}</div>
      {enabled ? (
        home ? (
          <div className="flex min-h-0 min-w-0 flex-1">
            <AiChatHub {...aiProps} />
          </div>
        ) : wide ? (
          open ? (
            <aside ref={panelRef} aria-label="دستیار هوشمند" style={{ width: panelWidth }} className="relative flex h-full min-w-[300px] max-w-[min(720px,calc(100vw-420px))] shrink-0 flex-col border-r border-border bg-card">
              <button type="button" onClick={() => setSidebar(false)} title="جمع کردن دستیار" aria-label="جمع کردن دستیار"
                className="absolute left-2 top-14 z-20 rounded-lg border border-border bg-background p-1.5 text-muted-foreground hover:text-foreground">
                <PanelLeftCloseIcon className="size-4" />
              </button>
              <AiChatHub {...aiProps} compact />
              <div role="separator" aria-label="تغییر عرض دستیار" aria-orientation="vertical"
                tabIndex={0} aria-valuemin={300} aria-valuemax={720} aria-valuenow={panelWidth}
                onPointerDown={startResize} onPointerMove={updateResize}
                onPointerUp={finishResize} onPointerCancel={finishResize}
                onKeyDown={(event) => {
                  if (event.key === "ArrowRight") { event.preventDefault(); persistPanelWidth(panelWidth + 20); }
                  else if (event.key === "ArrowLeft") { event.preventDefault(); persistPanelWidth(panelWidth - 20); }
                  else if (event.key === "Home") { event.preventDefault(); persistPanelWidth(300); }
                  else if (event.key === "End") { event.preventDefault(); persistPanelWidth(720); }
                }}
                className="absolute inset-y-0 right-0 z-20 w-2 translate-x-1/2 cursor-col-resize touch-none hover:bg-primary/20 focus-visible:bg-primary/30 focus-visible:outline-none"
              />
            </aside>
          ) : (
            <button type="button" onClick={() => setSidebar(true)} title="باز کردن دستیار" aria-label="باز کردن دستیار"
              className="flex h-full w-12 shrink-0 items-start justify-center border-r border-border bg-card pt-4 text-primary">
              <PanelLeftOpenIcon className="size-5" />
            </button>
          )
        ) : (
          <>
            <Button type="button" size="icon" className="fixed bottom-20 left-4 z-40 rounded-full"
              title="باز کردن دستیار هوشمند" aria-label="باز کردن دستیار هوشمند"
              onClick={() => setMobileOpen(true)}>
              <SparklesIcon className="size-5" />
            </Button>
            <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
              <SheetContent side="left" className="flex h-full w-[min(95vw,420px)] max-w-none flex-col gap-0 p-0">
                <SheetHeader className="sr-only">
                  <SheetTitle>دستیار هوشمند</SheetTitle>
                  <SheetDescription>ادامه گفتگوی همان دستیار بدون خروج از صفحه</SheetDescription>
                </SheetHeader>
                <AiChatHub {...aiProps} compact />
              </SheetContent>
            </Sheet>
          </>
        )
      ) : null}
    </>
  );
}
