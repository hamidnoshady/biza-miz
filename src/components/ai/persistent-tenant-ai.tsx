"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useAiChat } from "./use-ai-chat";

type ChatState = ReturnType<typeof useAiChat>;
type ContextValue = {
  chat: ChatState;
  account: string | null;
  activate: (account: string) => void;
};
const Context = createContext<ContextValue | null>(null);

/**
 * The chat hook belongs above Next.js' separate /dashboard and /(app) layouts.
 * Its stream and conversation state therefore outlive either route subtree.
 * Nothing is sent without the tenant shell's identity/permission gate.
 */
export function PersistentTenantAiProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const chat = useAiChat({ mode: "dashboard" });
  const [account, setAccount] = useState<string | null>(null);
  const accountRef = useRef<string | null>(null);
  const startNewConversationRef = useRef(chat.startNewConversation);
  startNewConversationRef.current = chat.startNewConversation;

  const activate = useCallback((identity: string) => {
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

export function TenantAiIdentity({ account }: { account: string }) {
  const value = useContext(Context);
  const activate = value?.activate;
  useEffect(() => { activate?.(account); }, [activate, account]);
  return null;
}
