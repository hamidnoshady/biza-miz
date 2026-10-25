"use client";

import { useEffect, useState, type ReactNode } from "react";
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
            <aside aria-label="دستیار هوشمند" className="relative flex h-full w-[clamp(330px,30vw,480px)] shrink-0 flex-col border-r border-border bg-card">
              <button type="button" onClick={() => setSidebar(false)} title="جمع کردن دستیار" aria-label="جمع کردن دستیار"
                className="absolute left-2 top-14 z-20 rounded-lg border border-border bg-background p-1.5 text-muted-foreground hover:text-foreground">
                <PanelLeftCloseIcon className="size-4" />
              </button>
              <AiChatHub {...aiProps} compact />
            </aside>
          ) : (
            <button type="button" onClick={() => setSidebar(true)} title="باز کردن دستیار" aria-label="باز کردن دستیار"
              className="flex h-full w-12 shrink-0 items-start justify-center border-r border-border bg-card pt-4 text-primary">
              <PanelLeftOpenIcon className="size-5" />
            </button>
          )
        ) : (
          <>
            <Button type="button" size="icon" className="fixed bottom-20 left-4 z-40 rounded-full shadow-lg"
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
