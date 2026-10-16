"use client";

import { useSyncExternalStore } from "react";
import type { ConversationSummary } from "./ai-conversations-sidebar";

export interface AssistantSidebarBridgeState {
  activeConversationId: string | null;
  refreshToken: number;
  onSelectConversation: ((id: string) => void) | null;
  onNewConversation: (() => void) | null;
  onDeleteConversation: ((id: string) => void) | null;
  onRenameConversation: ((conversation: ConversationSummary) => void) | null;
}

let state: AssistantSidebarBridgeState = {
  activeConversationId: null,
  refreshToken: 0,
  onSelectConversation: null,
  onNewConversation: null,
  onDeleteConversation: null,
  onRenameConversation: null,
};

const listeners = new Set<() => void>();

function emitChange() {
  for (const listener of listeners) {
    listener();
  }
}

export function setAssistantSidebarBridge(
  next: Partial<AssistantSidebarBridgeState>,
): void {
  state = { ...state, ...next };
  emitChange();
}

export function resetAssistantSidebarBridge(): void {
  state = {
    activeConversationId: null,
    refreshToken: 0,
    onSelectConversation: null,
    onNewConversation: null,
    onDeleteConversation: null,
    onRenameConversation: null,
  };
  emitChange();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): AssistantSidebarBridgeState {
  return state;
}

export function useAssistantSidebarBridge(): AssistantSidebarBridgeState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
