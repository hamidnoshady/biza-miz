"use client";

import * as React from "react";
import { Slot } from "radix-ui";
import { MenuIcon, PanelRightCloseIcon, PanelRightOpenIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

type SidebarState = "expanded" | "collapsed";

type SidebarContextValue = {
  state: SidebarState;
  isMobile: boolean;
  openMobile: boolean;
  setOpenMobile: (open: boolean) => void;
  toggleSidebar: () => void;
  /**
   * Opens the desktop rail without toggling it. A collapsed rail hides every
   * label, so a control that only makes sense next to its text (a disclosure
   * group, the width handle) asks for the width it needs instead of leaving
   * the member with a click that appears to do nothing.
   */
  expandSidebar: () => void;
  /**
   * The control that opened the phone drawer. Escape closes the drawer and
   * puts focus back here, so a keyboard user is not dropped on `body`
   * (issue #1553). Radix only restores focus to a `DialogTrigger` it owns;
   * this drawer is opened by an ordinary button calling `toggleSidebar`.
   */
  mobileTriggerRef: React.RefObject<HTMLButtonElement | null>;
};

const SidebarContext = React.createContext<SidebarContextValue | null>(null);

/** The element id the mobile trigger points `aria-controls` at. */
const SIDEBAR_ID = "dashboard-sidebar";

function useSidebar() {
  const context = React.useContext(SidebarContext);
  if (!context) throw new Error("useSidebar must be used within a SidebarProvider");
  return context;
}

function SidebarProvider({
  defaultOpen = true,
  open: openProp,
  onOpenChange,
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [internalOpen, setInternalOpen] = React.useState(defaultOpen);
  const [isMobile, setIsMobile] = React.useState(false);
  const [openMobile, setOpenMobile] = React.useState(false);
  const mobileTriggerRef = React.useRef<HTMLButtonElement | null>(null);
  const open = openProp ?? internalOpen;

  React.useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const update = () => setIsMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  const setOpen = React.useCallback(
    (nextOpen: boolean) => {
      if (openProp === undefined) setInternalOpen(nextOpen);
      onOpenChange?.(nextOpen);
    },
    [onOpenChange, openProp],
  );

  const toggleSidebar = React.useCallback(() => {
    if (isMobile) {
      setOpenMobile((value) => !value);
      return;
    }
    setOpen(!open);
  }, [isMobile, open, setOpen]);

  const expandSidebar = React.useCallback(() => {
    // The drawer is already full width on a phone: nothing to widen there.
    if (isMobile || open) return;
    setOpen(true);
  }, [isMobile, open, setOpen]);

  const value = React.useMemo<SidebarContextValue>(
    () => ({
      state: open ? "expanded" : "collapsed",
      isMobile,
      openMobile,
      setOpenMobile,
      toggleSidebar,
      expandSidebar,
      mobileTriggerRef,
    }),
    [expandSidebar, isMobile, open, openMobile, toggleSidebar],
  );

  return (
    <TooltipProvider>
      <SidebarContext.Provider value={value}>
        <div className={cn("contents", className)} {...props}>
          {children}
        </div>
      </SidebarContext.Provider>
    </TooltipProvider>
  );
}

function Sidebar({
  side = "right",
  className,
  children,
  ...props
}: React.ComponentProps<"aside"> & { side?: "left" | "right" }) {
  const { state, isMobile, openMobile, setOpenMobile, mobileTriggerRef } = useSidebar();
  // Escape is the one dismissal the keyboard user asked for by hand, so it is
  // the one that must hand focus back to the hamburger. A close caused by a
  // navigation must not: the destination heading takes focus instead.
  const escapeReturnsFocusRef = React.useRef(false);

  if (isMobile) {
    return (
      <Sheet open={openMobile} onOpenChange={setOpenMobile}>
        {/*
          The drawer is a dialog: Radix needs a title and a description or it
          warns and screen readers announce an unnamed dialog. They are spoken
          only — the visible name is the brand block the sidebar already draws.
        */}
        <SheetContent
          side={side}
          showCloseButton
          className="w-[86vw] max-w-80 gap-0 p-0"
          onEscapeKeyDown={() => {
            escapeReturnsFocusRef.current = true;
          }}
          onCloseAutoFocus={(event) => {
            if (!escapeReturnsFocusRef.current) return;
            escapeReturnsFocusRef.current = false;
            const trigger = mobileTriggerRef.current;
            if (!trigger?.isConnected) return;
            event.preventDefault();
            trigger.focus();
          }}
        >
          <SheetTitle className="sr-only">منوی داشبورد</SheetTitle>
          <SheetDescription className="sr-only">
            دسترسی به بخش‌های داشبورد و تنظیمات حساب
          </SheetDescription>
          <aside
            id={SIDEBAR_ID}
            data-slot="sidebar"
            data-state="expanded"
            className={cn(
              "group/sidebar flex h-full min-h-0 flex-col overflow-hidden bg-sidebar text-sidebar-foreground",
              className,
            )}
            {...props}
          >
            {children}
          </aside>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <aside
      id={SIDEBAR_ID}
      data-slot="sidebar"
      data-state={state}
      className={cn(
        "group/sidebar relative hidden h-screen shrink-0 flex-col overflow-hidden border-e border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-200 ease-out md:flex",
        state === "expanded" ? "w-64" : "w-16",
        className,
      )}
      {...props}
    >
      {children}
    </aside>
  );
}

function SidebarTrigger({ className, ...props }: React.ComponentProps<typeof Button>) {
  const { state, isMobile, openMobile, toggleSidebar, mobileTriggerRef } = useSidebar();
  const expanded = isMobile ? openMobile : state === "expanded";
  const label = isMobile
    ? expanded
      ? "بستن منو"
      : "باز کردن منو"
    : expanded
      ? "جمع کردن نوار کناری"
      : "باز کردن نوار کناری";

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      aria-expanded={expanded}
      aria-controls={SIDEBAR_ID}
      className={cn("size-11 shrink-0", className)}
      onClick={(event) => {
        // Remember the opener at the moment the drawer opens: by the time it
        // closes, Radix has already moved focus into the sheet.
        if (isMobile) mobileTriggerRef.current = event.currentTarget;
        toggleSidebar();
      }}
      {...props}
    >
      {isMobile ? <MenuIcon /> : state === "expanded" ? <PanelRightCloseIcon /> : <PanelRightOpenIcon />}
    </Button>
  );
}

function SidebarHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-header"
      className={cn("shrink-0 border-b border-sidebar-border p-4", className)}
      {...props}
    />
  );
}

function SidebarContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-content"
      className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain p-3", className)}
      {...props}
    />
  );
}

function SidebarFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-footer"
      /*
        The footer never eats the menu: on a short screen (a phone in landscape,
        a small POS panel) it scrolls inside its own half rather than squeezing
        the nav above it to nothing.
      */
      className={cn(
        "max-h-[50%] shrink-0 overflow-y-auto overscroll-contain border-t border-sidebar-border p-4",
        className,
      )}
      {...props}
    />
  );
}

function SidebarMenu({ className, ...props }: React.ComponentProps<"ul">) {
  return <ul data-slot="sidebar-menu" className={cn("space-y-1", className)} {...props} />;
}

function SidebarMenuItem({ className, ...props }: React.ComponentProps<"li">) {
  return <li data-slot="sidebar-menu-item" className={className} {...props} />;
}

function SidebarMenuButton({
  asChild = false,
  isActive = false,
  tooltip,
  className,
  children,
  ...props
}: React.ComponentProps<"button"> & {
  asChild?: boolean;
  isActive?: boolean;
  tooltip?: string;
}) {
  const { state, isMobile } = useSidebar();
  const Comp = asChild ? Slot.Root : "button";
  const button = (
    <Comp
      data-slot="sidebar-menu-button"
      data-active={isActive || undefined}
      className={cn(
        "flex min-h-11 w-full items-center gap-3 overflow-hidden rounded-lg px-3 text-sm text-sidebar-foreground transition-colors outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45 data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground group-data-[state=collapsed]/sidebar:justify-center group-data-[state=collapsed]/sidebar:gap-0 group-data-[state=collapsed]/sidebar:px-0",
        className,
      )}
      {...props}
    >
      {children}
    </Comp>
  );

  if (!tooltip || isMobile || state === "expanded") return button;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="left" sideOffset={8}>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
};
