/**
 * What wakes the desktop's sync tick early (migration 0190). Site only.
 *
 *  - **A local change.** The outbox and the master-data trigger raise a
 *    Postgres NOTIFY on `sync_outbox` when their transaction commits; a
 *    dedicated LISTEN connection turns that into a debounced run, so a sale
 *    reaches the central server in a couple of seconds.
 *  - **A central change.** A long-poll against the central server's pull
 *    endpoint (`peek=1&wait=15`) returns as soon as something for this branch
 *    commits there; the watcher then wakes the tick, which fetches it after
 *    settling permissions first, exactly as a timed tick would.
 *
 * Both are optimisations over the 30-second timer, never replacements for it:
 * any failure here just leaves the timer doing the work, and each loop backs
 * off before retrying. Because they are optimisations, a hold that an edge,
 * proxy or NAT ends is an expected outcome rather than an error — see
 * `sync-watch.ts`, which owns that classification and the retry delays
 * (issue #989). Only a failure that needs an operator's attention is reported
 * at warn/error, and only once per streak.
 */
import { Client } from "pg";
import { query, withTenant, withoutTenantScope } from "./db";
import { getSetting, SETTING_KEYS } from "./settings";
import type { ServerSyncConfig } from "./server-sync-config";
import { SYNC_OUTBOX_CHANNEL } from "./sync-outbox";
import {
  attemptCentralWatch,
  describeWatchFailure,
  jitteredWatchDelay,
  SyncWatchError,
  WATCH_RETRY_MS,
  watchFailureLogLevel,
  watchRetryDelayMs,
  type WatchFailure,
} from "./sync-watch";

const LISTEN_RETRY_MS = 30_000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

async function listenLoop(onWake: (delayMs?: number) => void, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    try {
      await client.connect();
      await client.query(`LISTEN ${SYNC_OUTBOX_CHANNEL}`);
      client.on("notification", () => onWake());
      await new Promise<void>((resolve) => {
        client.on("error", () => resolve());
        client.on("end", () => resolve());
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    } catch (error) {
      if (!signal.aborted) console.error("sync wake: LISTEN failed:", error instanceof Error ? error.message : error);
    } finally {
      await client.end().catch(() => {});
    }
    await sleep(LISTEN_RETRY_MS, signal);
  }
}

async function hybridBusinesses(): Promise<string[]> {
  return withoutTenantScope("platform", async () => {
    const { rows } = await query<{ business_id: string }>(
      `SELECT c.business_id FROM settings c
         JOIN settings p ON p.business_id=c.business_id AND p.location_id IS NULL
                        AND p.key=$2 AND p.value->>'profile'='hybrid'
        WHERE c.key=$1 AND c.location_id IS NULL`,
      [SETTING_KEYS.serverSyncConfig, SETTING_KEYS.deploymentProfile],
    );
    return rows.map((row) => row.business_id);
  });
}

function reportWatchFailure(
  failure: WatchFailure,
  consecutiveFailures: number,
  alreadyReportedInStreak: boolean,
): "debug" | "warn" | "error" {
  const line = describeWatchFailure(failure, consecutiveFailures);
  const level = watchFailureLogLevel(failure.kind, consecutiveFailures, alreadyReportedInStreak);
  if (level === "debug") console.debug(line);
  else if (level === "warn") console.warn(line);
  else console.error(line);
  return level;
}

/** A non-`SyncWatchError` can only come from the surrounding read (settings). */
function asWatchFailure(error: unknown, started: number): WatchFailure {
  return {
    kind: "server-error",
    heldMs: Date.now() - started,
    detail: error instanceof Error ? error.message : String(error),
    answeredBy: "network",
    edge: null,
  };
}

async function watchLoop(onWake: (delayMs?: number) => void, signal: AbortSignal): Promise<void> {
  const failureStreak: {
    current: { count: number; totalCount: number; kind: WatchFailure["kind"]; reported: boolean } | null;
  } = { current: null };

  while (!signal.aborted) {
    const started = Date.now();
    let polled = false;
    let woke = false;
    try {
      for (const businessId of await hybridBusinesses()) {
        if (signal.aborted) return;
        const pending = await withTenant(businessId, async () => {
          const config = await getSetting<ServerSyncConfig>(businessId, SETTING_KEYS.serverSyncConfig);
          if (!config?.enabled || !config.remoteUrl?.trim() || !config.token?.trim() || !config.siteDeviceId) return false;
          const state =
            (await getSetting<{ lastPulledEventId?: number | null; lastPulledTxid?: string | null }>(
              businessId,
              SETTING_KEYS.serverSyncState,
            )) ?? {};
          polled = true;
          const answer = await attemptCentralWatch({
            remoteUrl: config.remoteUrl,
            token: config.token,
            afterEventId: state.lastPulledEventId ?? 0,
            afterTxid: state.lastPulledTxid ?? "0",
            signal,
          });
          return answer.pending;
        });
        if (pending) {
          woke = true;
          onWake(500);
        }
      }
      // A completed pass means the hold worked. Announce the recovery only
      // when the streak was one an operator should care about: an edge ending
      // holds repeatedly is expected and must not produce a line per cycle.
      const recoveredFrom = failureStreak.current;
      if (recoveredFrom?.reported) {
        console.info(
          `sync wake: central watch recovered after ${recoveredFrom.totalCount} failed attempt${recoveredFrom.totalCount === 1 ? "" : "s"}`,
        );
      }
    } catch (error) {
      if (signal.aborted) return;
      const failure = error instanceof SyncWatchError ? error.failure : asWatchFailure(error, started);
      const previous = failureStreak.current;
      const count: number = previous?.kind === failure.kind ? previous.count + 1 : 1;
      const totalCount: number = (previous?.totalCount ?? 0) + 1;
      const reportedBefore: boolean = previous?.reported ?? false;
      const level = reportWatchFailure(failure, count, reportedBefore);
      failureStreak.current = {
        count,
        totalCount,
        kind: failure.kind,
        reported: reportedBefore || level !== "debug",
      };
      // A failed hold that was open long enough already served as the idle
      // wait, so retry shortly (jittered); a fast failure waits the base.
      await sleep(watchRetryDelayMs(failure), signal);
      continue;
    }
    failureStreak.current = null;
    if (woke) {
      // Give the woken tick time to pull before asking again; the cursor this
      // loop sends only moves once it has.
      await sleep(5_000, signal);
    } else if (!polled || Date.now() - started < 5_000) {
      // Nothing paired yet, or a central server too old to hold the request
      // (it answered at once): leave it to the 30-second timer, don't spin.
      await sleep(jitteredWatchDelay(WATCH_RETRY_MS), signal);
    }
  }
}

export function startSyncWakeListeners(options: { onWake: (delayMs?: number) => void; signal: AbortSignal }): void {
  void listenLoop(options.onWake, options.signal);
  void watchLoop(options.onWake, options.signal);
}
