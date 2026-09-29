/**
 * What wakes the desktop's sync tick early (migration 0190). Site only.
 *
 *  - **A local change.** The outbox and the master-data trigger raise a
 *    Postgres NOTIFY on `sync_outbox` when their transaction commits; a
 *    dedicated LISTEN connection turns that into a debounced run, so a sale
 *    reaches the central server in a couple of seconds.
 *  - **A central change.** A long-poll against the central server's pull
 *    endpoint (`peek=1&wait=25`) returns as soon as something for this branch
 *    commits there; the watcher then wakes the tick, which fetches it after
 *    settling permissions first, exactly as a timed tick would.
 *
 * Both are optimisations over the 30-second timer, never replacements for it:
 * any failure here just leaves the timer doing the work, and each loop backs
 * off before retrying.
 */
import { Client } from "pg";
import { query, withTenant, withoutTenantScope } from "./db";
import { getSetting, SETTING_KEYS } from "./settings";
import type { ServerSyncConfig } from "./server-sync-config";
import { SYNC_OUTBOX_CHANNEL } from "./sync-outbox";

const RETRY_MS = 30_000;

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
    await sleep(RETRY_MS, signal);
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

async function watchLoop(onWake: (delayMs?: number) => void, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    let polled = false;
    let woke = false;
    const started = Date.now();
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
          const url = new URL(`${config.remoteUrl.trim().replace(/\/+$/, "")}/api/server-sync/pull`);
          url.searchParams.set("after", String(state.lastPulledEventId ?? 0));
          url.searchParams.set("afterTx", state.lastPulledTxid ?? "0");
          url.searchParams.set("limit", "1");
          url.searchParams.set("wait", "25");
          url.searchParams.set("peek", "1");
          polled = true;
          const response = await fetch(url, {
            headers: { Authorization: `Bearer ${config.token.trim()}` },
            signal: AbortSignal.any([signal, AbortSignal.timeout(40_000)]),
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const body = (await response.json()) as { pending?: boolean };
          return body.pending === true;
        });
        if (pending) {
          woke = true;
          onWake(500);
        }
      }
    } catch (error) {
      if (!signal.aborted) {
        console.error("sync wake: central watch failed:", error instanceof Error ? error.message : error);
        await sleep(RETRY_MS, signal);
        continue;
      }
    }
    if (woke) {
      // Give the woken tick time to pull before asking again; the cursor this
      // loop sends only moves once it has.
      await sleep(5_000, signal);
    } else if (!polled || Date.now() - started < 5_000) {
      // Nothing paired yet, or a central server too old to hold the request
      // (it answered at once): leave it to the 30-second timer, don't spin.
      await sleep(RETRY_MS, signal);
    }
  }
}

export function startSyncWakeListeners(options: { onWake: (delayMs?: number) => void; signal: AbortSignal }): void {
  void listenLoop(options.onWake, options.signal);
  void watchLoop(options.onWake, options.signal);
}
