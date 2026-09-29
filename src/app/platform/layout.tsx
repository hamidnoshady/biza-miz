"use client";

/**
 * The console shell entry point.
 *
 * A client layout that bootstraps from `/api/platform/auth/me`: no session
 * bounces to `/platform/login`; a session renders the dark-first chrome and
 * provides every child page the admin's capability list via `CapabilityContext`
 * so pages hide controls the operator could not use. The server still re-checks
 * every write; this only keeps the UI honest.
 *
 * The login route is exempt: it has no session by definition, so this shell
 * renders its children bare (the login page paints its own full-screen card).
 *
 * Navigation, responsive behaviour and the business-workspace context menu are
 * delegated to `ConsoleShell` / `ConsoleNav`; this file owns auth + data only.
 */
import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { usePathname, useRouter } from "next/navigation";
import type { PlatformCapability } from "@/lib/platform-admin";
import type { PlatformAdminRole } from "@/lib/platform-admin";
import { ThemeToggle } from "@/components/theme-toggle";
import { api, PlatformPageSkeleton } from "./ui";
import { CapabilityContext } from "./_lib/capability-context";
import { ConsoleShell } from "./_components/console-shell";
import { businessSections } from "./businesses/[id]/sections";

interface Me {
  admin: { id: string; fullName: string; email: string; role: PlatformAdminRole } | null;
  capabilities?: PlatformCapability[];
}

/** The business a `/platform/businesses/{id}/…` URL points at, for the sidebar. */
function businessIdFromPath(path: string): string | null {
  const m = path.match(/^\/platform\/businesses\/([^/]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

export default function PlatformLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { setTheme } = useTheme();
  const isLogin = pathname === "/platform/login";

  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const openBusinessId = isLogin ? null : businessIdFromPath(pathname);
  const [openBusiness, setOpenBusiness] = useState<{ id: string; name: string } | null>(null);

  // The console keeps its dark-first identity until an operator picks a theme.
  useEffect(() => {
    if (!window.localStorage.getItem("theme")) setTheme("dark");
  }, [setTheme]);

  useEffect(() => {
    if (isLogin) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data } = await api<Me>("/api/platform/auth/me");
      if (cancelled) return;
      if (!data.admin) {
        router.replace("/platform/login");
        return;
      }
      setMe(data);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [isLogin, pathname, router]);

  // The sidebar's workspace title reads the lightweight identity endpoint, not
  // the full business summary: the summary computes counts, aliases and
  // industry data, and the workspace's own provider already reads it for the
  // page. Reading it here too meant two heavy reads per workspace navigation
  // just to draw one string (issue #755 §11).
  useEffect(() => {
    if (!openBusinessId) {
      setOpenBusiness(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const { ok, data } = await api<{ business?: { name?: string } }>(
        `/api/platform/businesses/${openBusinessId}/identity`,
      );
      if (cancelled) return;
      setOpenBusiness(
        ok && data.business?.name ? { id: openBusinessId, name: data.business.name } : null,
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [openBusinessId]);

  // The login page renders inside this layout but outside its chrome.
  if (isLogin) {
    return (
      <div className="relative min-h-screen bg-background" dir="rtl">
        <div className="absolute start-4 top-4 z-10">
          <ThemeToggle />
        </div>
        {children}
      </div>
    );
  }

  if (loading || !me?.admin) {
    return <PlatformPageSkeleton fullScreen />;
  }

  const caps = me.capabilities ?? [];

  async function logout() {
    await api("/api/platform/auth/logout", { method: "POST" });
    router.replace("/platform/login");
    router.refresh();
  }

  const workspace =
    openBusinessId && openBusiness?.id === openBusinessId
      ? { name: openBusiness.name, sections: businessSections(openBusinessId, caps) }
      : null;

  return (
    <CapabilityContext.Provider value={caps}>
      <ConsoleShell admin={me.admin} caps={caps} workspace={workspace} onLogout={logout}>
        {children}
      </ConsoleShell>
    </CapabilityContext.Provider>
  );
}
