/**
 * The desktop's half of master-data sync: push this install's customer and
 * menu edits to the central server, then pull the central server's back and
 * merge them in. Runs inside the site sync tick, before operational events,
 * so an order that names a new menu item or customer finds it already here
 * (and the central server finds the desktop's before the order arrives).
 */
import { getSetting, setSetting, SETTING_KEYS } from "./settings";
import type { ServerSyncConfig } from "./server-sync-config";
import {
  applyMasterChanges,
  cursorAfterApply,
  decodeMasterCursor,
  encodeMasterCursor,
  localSyncNode,
  MASTER_CURSOR_START,
  readMasterFeed,
  resolveAppliedMasterConflicts,
  type MasterApplyOutcome,
  type MasterFeedChange,
} from "./master-sync-service";
import { attemptDue, nextAttemptAt } from "./sync-backoff";

export interface MasterSyncState {
  pushCursor: string | null;
  pullCursor: string | null;
  /** The central server's clock node, so its own edits are not pushed back to it. */
  centralNode: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  failures: number;
  nextAttemptAt: string | null;
  lastPushed: number;
  lastPulled: number;
}

const EMPTY: MasterSyncState = {
  pushCursor: null,
  pullCursor: null,
  centralNode: null,
  lastSuccessAt: null,
  lastError: null,
  failures: 0,
  nextAttemptAt: null,
  lastPushed: 0,
  lastPulled: 0,
};

/** Pages per direction per tick — enough to drain a first pairing's backlog quickly without monopolising the tick. */
const MAX_PAGES = 10;

export async function getMasterSyncState(businessId: string): Promise<MasterSyncState> {
  const stored = await getSetting<Partial<MasterSyncState>>(businessId, SETTING_KEYS.masterSyncState);
  return { ...EMPTY, ...(stored ?? {}) };
}

async function saveState(businessId: string, patch: Partial<MasterSyncState>): Promise<void> {
  const current = await getMasterSyncState(businessId);
  await setSetting(businessId, SETTING_KEYS.masterSyncState, { ...current, ...patch } satisfies MasterSyncState);
}

export type MasterSyncResult =
  | { status: "disabled" }
  | { status: "backoff"; until: string }
  | { status: "ok"; pushed: number; pulled: number }
  | { status: "error"; error: string };

function baseUrl(config: ServerSyncConfig): string {
  return config.remoteUrl.trim().replace(/\/+$/, "");
}

/**
 * One round of master sync for a business: push, then pull. Only a *site*
 * runs this (the central server merely answers), and only when this business
 * is paired and sync is enabled.
 */
export async function runMasterSync(businessId: string, now: Date = new Date()): Promise<MasterSyncResult> {
  const config = await getSetting<ServerSyncConfig>(businessId, SETTING_KEYS.serverSyncConfig);
  if (!config?.enabled || !config.remoteUrl?.trim() || !config.token?.trim() || !config.siteDeviceId) {
    return { status: "disabled" };
  }
  const state = await getMasterSyncState(businessId);
  if (!attemptDue(state.nextAttemptAt, now)) return { status: "backoff", until: state.nextAttemptAt! };

  try {
    const pushed = await pushMaster(businessId, config, state);
    const pulled = await pullMaster(businessId, config);
    await saveState(businessId, {
      lastSuccessAt: now.toISOString(),
      lastError: null,
      failures: 0,
      nextAttemptAt: null,
      lastPushed: pushed,
      lastPulled: pulled,
    });
    return { status: "ok", pushed, pulled };
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    const failures = state.failures + 1;
    await saveState(businessId, { lastError: message, failures, nextAttemptAt: nextAttemptAt(failures, now) });
    return { status: "error", error: message };
  }
}

async function pushMaster(businessId: string, config: ServerSyncConfig, initial: MasterSyncState): Promise<number> {
  let cursor = decodeMasterCursor(initial.pushCursor) ?? MASTER_CURSOR_START;
  let total = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const state = await getMasterSyncState(businessId);
    const feed = await readMasterFeed(businessId, {
      cursor,
      limit: 200,
      locationId: null,
      // What arrived from the central server is already there.
      excludeNode: state.centralNode,
    });
    if (feed.changes.length === 0) {
      if (encodeMasterCursor(feed.cursor) !== encodeMasterCursor(cursor)) {
        cursor = feed.cursor;
        await saveState(businessId, { pushCursor: encodeMasterCursor(cursor) });
      }
      if (!feed.hasMore) break;
      continue;
    }
    const response = await fetch(`${baseUrl(config)}/api/server-sync/master`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.token.trim()}` },
      body: JSON.stringify({ changes: feed.changes }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`master_push_rejected: HTTP ${response.status}`);
    const body = (await response.json()) as { outcomes?: MasterApplyOutcome[]; firstDeferred?: number };
    if (!Array.isArray(body.outcomes) || body.outcomes.length !== feed.changes.length) {
      throw new Error("master_push_rejected: invalid result set");
    }
    const firstDeferred = typeof body.firstDeferred === "number" ? body.firstDeferred : -1;
    cursor = cursorAfterApply(cursor, feed.cursor, feed.changes, firstDeferred);
    await saveState(businessId, { pushCursor: encodeMasterCursor(cursor) });
    total += feed.changes.length;
    // The central server is waiting on a parent it has not received yet;
    // resume from here next tick rather than skipping past it.
    if (firstDeferred >= 0 || !feed.hasMore) break;
  }
  return total;
}

async function pullMaster(businessId: string, config: ServerSyncConfig): Promise<number> {
  const node = await localSyncNode();
  let total = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const state = await getMasterSyncState(businessId);
    const start = decodeMasterCursor(state.pullCursor) ?? MASTER_CURSOR_START;
    const url = new URL(`${baseUrl(config)}/api/server-sync/master`);
    url.searchParams.set("cursor", encodeMasterCursor(start));
    url.searchParams.set("node", node);
    url.searchParams.set("limit", "200");
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${config.token.trim()}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`master_pull_rejected: HTTP ${response.status}`);
    const body = (await response.json()) as {
      changes?: MasterFeedChange[];
      cursor?: string;
      hasMore?: boolean;
      node?: string;
    };
    const pageEnd = decodeMasterCursor(body.cursor);
    if (!Array.isArray(body.changes) || !pageEnd) throw new Error("master_pull_rejected: invalid page");
    if (body.node && body.node !== state.centralNode) await saveState(businessId, { centralNode: body.node });

    let next = pageEnd;
    if (body.changes.length > 0) {
      const result = await applyMasterChanges(businessId, body.changes, {
        receiverLocationId: config.locationId ?? null,
      });
      await resolveAppliedMasterConflicts(businessId, body.changes, result.outcomes);
      next = cursorAfterApply(start, pageEnd, body.changes, result.firstDeferred);
      total += body.changes.length;
      await saveState(businessId, { pullCursor: encodeMasterCursor(next) });
      if (result.firstDeferred >= 0) break;
    } else if (encodeMasterCursor(pageEnd) !== encodeMasterCursor(start)) {
      await saveState(businessId, { pullCursor: encodeMasterCursor(next) });
    }
    if (!body.hasMore) break;
  }
  return total;
}
