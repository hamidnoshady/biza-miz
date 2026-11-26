"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useAiChat } from "./use-ai-chat";

type ChatState = ReturnType<typeof useAiChat>;
type ContextValue = {
  chat: ChatState;
  account: string | null;
  activate: (account: string | null) => void;
};
const Context = createContext<ContextValue | null>(null);

/**
 * The chat hook belongs above Next.js' separate /dashboard and /(app) layouts.
 * Its stream and conversation state therefore outlive either route subtree.
 * Nothing is sent without the tenant shell's identity/permission gate.
 */
export function PersistentTenantAiProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  // Issue #1546 Phase 2 — the docked assistant's current page is a tool-routing
  // hint. It never grants access; the chat route validates it on the server.
  const chat = useAiChat({ mode: "dashboard", routePath: pathname });
  const [account, setAccount] = useState<string | null>(null);
  const accountRef = useRef<string | null>(null);
  const startNewConversationRef = useRef(chat.resetAccount);
  startNewConversationRef.current = chat.resetAccount;

  const activate = useCallback((identity: string | null) => {
    if (accountRef.current && accountRef.current !== identity) {
      startNewConversationRef.current();
    }
    accountRef.current = identity;
    setAccount(identity);
  }, []);

  // Never leave a previous tenant's chat visible on login or Superadmin routes.
  useEffect(() => {
    if (pathname === "/login" || pathname === "/setup/login" || pathname.startsWith("/platform")) {
      if (accountRef.current) startNewConversationRef.current();
      accountRef.current = null;
      setAccount(null);
    }
  }, [pathname]);

  return <Context.Provider value={{ chat, account, activate }}>{children}</Context.Provider>;
}

export function usePersistentTenantAiChat(): ChatState | null {
  const value = useContext(Context);
  return value?.account ? value.chat : null;
}

export function useTenantAiIdentityReady(account: string): boolean {
  const value = useContext(Context);
  return !value || value.account === account;
}

export function TenantAiIdentity({ account, enabled = true }: { account: string; enabled?: boolean }) {
  const value = useContext(Context);
  const activate = value?.activate;
  useEffect(() => { activate?.(enabled ? account : null); }, [activate, account, enabled]);
  return null;
}
