"use client";

/**
 * The console chrome: a collapsible desktop sidebar and a mobile navigation
 * drawer (Sheet), replacing the old flat 16-button strip (task section 2). The
 * layout owns auth/data; this owns the responsive frame around the page.
 */
import { useState } from "react";
import { MenuIcon, LogOutIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { ThemeToggle } from "@/components/theme-toggle";
import type { PlatformCapability } from "@/lib/platform-admin";
import { PLATFORM_ROLE_LABELS, type PlatformAdminRole } from "@/lib/platform-admin";
import { ConsoleNav } from "./console-nav";
import type { BusinessSection } from "../businesses/[id]/sections";

export function ConsoleShell({
  admin,
  caps,
  workspace,
  aiDock,
  onLogout,
  children,
}: {
  admin: { fullName: string; role: PlatformAdminRole };
  caps: PlatformCapability[];
  workspace?: { name: string; sections: BusinessSection[] } | null;
  /** Authenticated platform AI panel, rendered as a layout sibling (not an overlay). */
  aiDock?: React.ReactNode;
  onLogout: () => void;
  children: React.ReactNode;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  const brand = (
    <div className="flex flex-col">
      <span className="text-xs font-medium uppercase tracking-widest text-primary/80">Platform</span>
      <span className="mt-0.5 font-bold text-foreground">کنسول مدیریت سکو</span>
    </div>
  );

  const footer = (
    <div className="border-t border-border p-4 text-sm">
      <p className="truncate font-semibold text-foreground">{admin.fullName}</p>
      <p className="mb-3 truncate text-xs text-muted-foreground">
        {PLATFORM_ROLE_LABELS[admin.role] ?? admin.role}
      </p>
      <div className="flex items-center justify-between gap-2">
        <Button variant="outline" size="sm" onClick={onLogout}>
          <LogOutIcon aria-hidden="true" />
          خروج
        </Button>
        <ThemeToggle />
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen bg-background text-foreground" dir="rtl">
      {/* Desktop sidebar */}
      <aside className="hidden w-64 shrink-0 flex-col border-e border-border bg-card md:flex">
        <div className="border-b border-border p-4">{brand}</div>
        <div className="flex-1 overflow-y-auto p-3">
          <ConsoleNav caps={caps} workspace={workspace} />
        </div>
        {footer}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar with drawer trigger */}
        <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5 md:hidden">
          <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
            <SheetTrigger asChild>
              <Button variant="outline" size="icon-sm" aria-label="باز کردن منو">
                <MenuIcon aria-hidden="true" />
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="flex w-72 flex-col gap-0 p-0">
              <SheetHeader className="border-b border-border text-start">
                <SheetTitle>{brand}</SheetTitle>
              </SheetHeader>
              <div className="flex-1 overflow-y-auto p-3">
                <ConsoleNav caps={caps} workspace={workspace} onNavigate={() => setDrawerOpen(false)} />
              </div>
              {footer}
            </SheetContent>
          </Sheet>
          <p className="min-w-0 truncate font-bold">کنسول سکو</p>
          <div className="flex shrink-0 items-center gap-1">
            <ThemeToggle />
          </div>
        </header>

        <main className={cn("flex-1 overflow-y-auto p-3 sm:p-4 md:p-8")}>{children}</main>
      </div>
      {aiDock}
    </div>
  );
}
