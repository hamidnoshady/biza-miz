"use client";

/**
 * Offline queue glue (Phase 5, extended by the Section 5 offline-first audit
 * into a proper Sync Queue System): wraps a mutation's fetch so a LAN drop
 * mid-order queues the action locally (src/lib/offline-db.ts) instead of
 * losing it, then flushes the queue to POST /api/sync/events on reconnect.
 * See docs/phases/Phase-5-Offline-Queue-Hardware.md for the original
 * conflict-handling decision (offline-sync.ts) and src/lib/sync-queue.ts for
 * the pure Pending/Syncing/Completed/Failed/Conflict state machine this
 * module drives.
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { getOfflineDb, type PendingAction, type PendingActionType } from "@/lib/offline-db";
import { safeRandomId } from "@/lib/client-id";
import type { ConnectionStatus } from "@/lib/connection-state";
import {
  classifyFlushOutcome,
  isQueueEntryDueForRetry,
  resolveQueueRecordRef,
  type SyncQueueStatus,
} from "@/lib/sync-queue";

type Listener = () => void;
const listeners = new Set<Listener>();
function notifyListeners(): void {
  listeners.forEach((l) => l());
}

export async function enqueueAction(action: {
  type: PendingActionType;
  payload: Record<string, unknown>;
  occurredAt: string;
  description: string;
}): Promise<void> {
  const { table, recordId } = resolveQueueRecordRef(action.type, action.payload);
  await getOfflineDb().pendingActions.add({
    ...action,
    id: safeRandomId(),
    table,
    recordId,
    createdAt: Date.now(),
    status: "pending",
    retryCount: 0,
    lastAttemptAt: null,
    lastError: null,
  });
  notifyListeners();
}

/**
 * POSTs or PATCHes `url` with `body`; on an actual network failure (LAN
 * drop, not a server-side rejection) queues `queue` for later replay instead
 * of throwing. Server-side rejections (validation errors, 409s, …) still
 * come back as `{ ok: false }` — only "the request never reached the
 * server" gets queued.
 */
export async function apiOrQueue<T = Record<string, unknown>>(
  url: string,
  init: { method: "POST" | "PATCH"; body: unknown },
  queue: { type: PendingActionType; payload: Record<string, unknown>; description: string },
): Promise<{ ok: boolean; queued: boolean; data: T }> {
  try {
    const res = await fetch(url, {
      method: init.method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(init.body),
    });
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      data = {};
    }
    return { ok: res.ok, queued: false, data: data as T };
  } catch {
    // fetch() itself threw: no LAN / server unreachable, not a server-side rejection.
    await enqueueAction({ type: queue.type, payload: queue.payload, occurredAt: new Date().toISOString(), description: queue.description });
    return { ok: true, queued: true, data: {} as T };
  }
}

let flushing = false;

/**
 * Whether the server on this origin is actually answering.
 *
 * `navigator.onLine` only says the device has a network interface up — it is
 * true on a captive Wi-Fi portal, true when the hosting edge is returning 502,
 * and true when the container was replaced mid-session. Deployments behind a
 * managed platform therefore showed "اتصال به سرور قطع است" (or the inverse:
 * a green dot with every write failing) with nothing able to correct it,
 * because no code ever asked the server. This does, against /api/health, which
 * needs no session and touches no database.
 *
 * `onLine === false` is still trusted immediately in the negative direction:
 * the browser is authoritative that there is no network at all, and skipping
 * the probe there avoids a guaranteed-failing request every few seconds.
 */
export async function probeServer(): Promise<boolean> {
  // Never short-circuit on navigator.onLine: a phone can have no Internet and
  // still have a perfectly healthy route to the Business Suite PC over Wi-Fi.
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch("/api/health", {
        method: "GET",
        cache: "no-store",
        signal: controller.signal,
      });
      return res.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

/**
 * Sends every queue entry due for retry (sync-queue.ts's
 * isQueueEntryDueForRetry — excludes `conflict`/`completed`, and backs off a
 * repeatedly-`failed` entry) to the server in FIFO order.
 *
 * Each entry's `status`/`retryCount`/`lastError` is updated per
 * classifyFlushOutcome instead of the old all-or-nothing "delete on
 * ok-or-conflict, otherwise leave untouched forever" behaviour: a server-side
 * rejection now visibly becomes `failed` after repeated attempts (surfaced by
 * OfflineBanner/the queue detail list) rather than silently retrying forever
 * with no sign anything is wrong, and a real two-device conflict is kept
 * (status `conflict`) for a human to resolve via `discardQueueEntry`/
 * `retryQueueEntry` instead of being deleted the instant the server flags it.
 */
export async function flushQueue(): Promise<void> {
  if (flushing) return;
  // The queue targets this origin (usually the LAN PC), not the Internet.
  // navigator.onLine=false must not suppress a flush while local Wi-Fi works.
  const db = getOfflineDb();
  const all = await db.pendingActions.orderBy("createdAt").toArray();
  const now = Date.now();
  const pending = all.filter((p) => isQueueEntryDueForRetry(p, now));
  if (pending.length === 0) return;

  flushing = true;
  try {
    await db.pendingActions.bulkUpdate(pending.map((p) => ({ key: p.id, changes: { status: "syncing" as SyncQueueStatus, lastAttemptAt: now } })));
    notifyListeners();

    const res = await fetch("/api/sync/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        events: pending.map((p) => ({ clientEventId: p.id, type: p.type, occurredAt: p.occurredAt, payload: p.payload })),
      }),
    });
    if (!res.ok) {
      // Whole-batch failure (server 5xx, etc.): every entry we just marked
      // "syncing" goes back to "pending" untouched — no retry penalty for a
      // failure that wasn't about any individual action.
      await db.pendingActions.bulkUpdate(pending.map((p) => ({ key: p.id, changes: { status: "pending" as SyncQueueStatus } })));
      return;
    }
    const { results } = (await res.json()) as {
      results: { clientEventId: string; ok: boolean; conflict?: boolean; error?: string }[];
    };
    const byId = new Map(results.map((r) => [r.clientEventId, r]));
    const toDelete: string[] = [];
    const updates: { key: string; changes: Partial<PendingAction> }[] = [];
    for (const p of pending) {
      const outcome = classifyFlushOutcome(byId.get(p.id), p.retryCount);
      if (outcome.status === "completed") {
        toDelete.push(p.id);
        continue;
      }
      updates.push({
        key: p.id,
        changes: { status: outcome.status, retryCount: outcome.retryCount, lastError: byId.get(p.id)?.error ?? null },
      });
    }
    if (updates.length > 0) await db.pendingActions.bulkUpdate(updates);
    if (toDelete.length > 0) await db.pendingActions.bulkDelete(toDelete);
  } catch {
    // still offline, or the server just went down mid-flush — put the
    // in-flight entries back to pending; leave everything else untouched.
    await db.pendingActions.bulkUpdate(pending.map((p) => ({ key: p.id, changes: { status: "pending" as SyncQueueStatus } })));
  } finally {
    flushing = false;
    notifyListeners();
  }
}

/**
 * A human decision on a `failed` or `conflict` entry: re-arm it for another
 * flush attempt (retryCount reset to 0, so it isn't immediately re-failed by
 * a stale backoff) after the user has resolved whatever was wrong — e.g.
 * fixed the underlying data, or confirmed the server's current state is fine
 * to overwrite.
 */
export async function retryQueueEntry(id: string): Promise<void> {
  await getOfflineDb().pendingActions.update(id, { status: "pending", retryCount: 0, lastError: null });
  notifyListeners();
}

/** Permanently discards a `failed` or `conflict` entry the user has decided not to replay. */
export async function discardQueueEntry(id: string): Promise<void> {
  await getOfflineDb().pendingActions.delete(id);
  notifyListeners();
}

export type LocalServerState = "local_server_connected" | "local_server_unreachable";
export type InternetState = "internet_available" | "internet_unavailable" | "internet_unknown";
export type CloudSyncState =
  | "cloud_sync_connected"
  | "cloud_sync_connecting"
  | "cloud_sync_paused"
  | "cloud_sync_not_configured";

export interface ConnectionState {
  localServer: LocalServerState;
  internet: InternetState;
  cloudSync: CloudSyncState;
  pendingActions: number;
  syncError: boolean;
  /** Entries stuck in `failed` or `conflict` — need a human decision, not just time. */
  attentionNeeded: number;
}

export interface ConnectionStatusSnapshot {
  profile?: "cloud" | "hybrid" | "local";
  localServer?: ConnectionStatus;
  cloud?: ConnectionStatus;
  sync?: ConnectionStatus;
  cloudSync?: string;
  outboundPending?: number;
  inboundPending?: number;
  conflicts?: number;
  deadLetters?: number;
  lastSuccessfulSyncAt?: string | null;
  error?: string | null;
  /**
   * Hybrid identity planes, reported separately from operational sync:
   * memberships (`identitySync`) and the login-credential/PIN stage
   * (`credentialSync`), plus the combined verdict. A membership snapshot can
   * be healthy while a cloud-made staff PIN never arrived — the state this
   * interface exists to keep visible.
   */
  identitySync?: {
    state: string;
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    lastError: string | null;
  } | null;
  credentialSync?: {
    state: string;
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    lastError: string | null;
    membershipsExpected: number;
    identitiesExpected: number;
    identitiesLinked: number;
    credentialsReceived: number;
    pinsReceived: number;
    pinsApplied: number;
    identitiesApplied: number;
    pinMembersExpected: number;
    pinMembersUsable: number;
    pinMembersMissing: number;
    missingIdentityBindings: number;
    convergedAt: string | null;
  } | null;
  overallIdentity?: string;
  identityError?: string | null;
}

export interface OfflineQueueState {
  pendingCount: number;
  isOnline: boolean;
  connectionState: ConnectionState;
  entries: PendingAction[];
  serverStatus: ConnectionStatusSnapshot | null;
}

function useOfflineQueueState(): OfflineQueueState {
  const [serverStatus, setServerStatus] = useState<ConnectionStatusSnapshot | null>(null);
  const [entries, setEntries] = useState<PendingAction[]>([]);
  const [isOnline, setIsOnline] = useState(true);
  const [internet, setInternet] = useState<InternetState>("internet_unknown");
  const [cloudSync, setCloudSync] = useState<CloudSyncState>("cloud_sync_not_configured");
  const [syncError, setSyncError] = useState(false);

  const refreshEntries = useCallback(() => {
    void getOfflineDb().pendingActions.orderBy("createdAt").toArray().then(setEntries);
  }, []);

  useEffect(() => {
    let cancelled = false;
    refreshEntries();
    listeners.add(refreshEntries);

    async function refreshOnlineState() {
      const reachable = await probeServer();
      if (cancelled) return;
      setIsOnline(reachable);
      if (!reachable) {
        // navigator.onLine only contributes to Internet state. It never decides
        // whether the same-origin local server can be reached.
        setInternet(navigator.onLine ? "internet_unknown" : "internet_unavailable");
        return;
      }
      await flushQueue();
      try {
        const response = await fetch("/api/connection/status", { cache: "no-store" });
        if (!response.ok) return;
        const body = (await response.json()) as ConnectionStatusSnapshot;
        setServerStatus(body);
        if (body.cloudSync === "connected") {
          setCloudSync("cloud_sync_connected");
          setInternet("internet_available");
          setSyncError(false);
        } else if (body.cloudSync === "connecting") {
          setCloudSync("cloud_sync_connecting");
          setInternet(navigator.onLine ? "internet_unknown" : "internet_unavailable");
          setSyncError(false);
        } else if (body.cloudSync === "paused") {
          setCloudSync("cloud_sync_paused");
          setInternet(navigator.onLine ? "internet_unknown" : "internet_unavailable");
          setSyncError(Boolean(body.error));
        } else {
          setCloudSync("cloud_sync_not_configured");
          setInternet(navigator.onLine ? "internet_unknown" : "internet_unavailable");
          setSyncError(false);
        }
      } catch {
        // The health request succeeded, so this is not a local-server outage.
        // Keep cloud state conservative until the next probe.
      }
    }

    function onNetworkChange() {
      void refreshOnlineState();
    }
    window.addEventListener("online", onNetworkChange);
    window.addEventListener("offline", onNetworkChange);

    void refreshOnlineState();
    const interval = setInterval(() => void refreshOnlineState(), 15_000);

    return () => {
      cancelled = true;
      listeners.delete(refreshEntries);
      window.removeEventListener("online", onNetworkChange);
      window.removeEventListener("offline", onNetworkChange);
      clearInterval(interval);
    };
  }, [refreshEntries]);

  const attentionNeeded = entries.filter((e) => e.status === "failed" || e.status === "conflict").length;

  return {
    pendingCount: entries.length,
    isOnline,
    entries,
    serverStatus,
    connectionState: {
      localServer: isOnline ? "local_server_connected" : "local_server_unreachable",
      internet,
      cloudSync,
      pendingActions: entries.length,
      syncError,
      attentionNeeded,
    },
  };
}

const OfflineQueueContext = createContext<OfflineQueueState | null>(null);

/** One queue/probe owner for the whole authenticated shell. */
export function OfflineQueueProvider({ children }: { children: ReactNode }) {
  const state = useOfflineQueueState();
  return <OfflineQueueContext.Provider value={state}>{children}</OfflineQueueContext.Provider>;
}

export function useOfflineQueue(): OfflineQueueState {
  const state = useContext(OfflineQueueContext);
  if (!state) throw new Error("useOfflineQueue must be used inside OfflineQueueProvider");
  return state;
}

export type { PendingAction };
