/**
 * Offline delivery for guided-tour progress (issue #972, Phase G).
 *
 * Progress events are a monotone union on the server (`applyTourEvent`), so
 * replaying one — or delivering two devices' events in either order — is
 * already safe. This module only has to *hold* events while the network is
 * gone and hand them over once, in order, when it returns.
 *
 * Why a dedicated queue rather than the business `sync_events` outbox:
 * learning progress is member-scoped (business + member + tour), not a
 * location-scoped operational event, and the outbox is deliberately limited to
 * order/inventory writes that a till can replay. A tour event carries no
 * business payload at all — a tour id, an event name and a step id — so this
 * small queue cannot leak customer or money data.
 *
 * `viewerKey` is an opaque server-issued hash of (business, member). Entries
 * for another viewer are discarded on read: a shared device or a logout never
 * replays one member's learning into another member's account. Authentication
 * failures clear the queue for the same reason.
 */

export const TOUR_QUEUE_KEY = "bizamiz.tour-progress-queue.v1";
const MAX_ENTRIES = 200;

export type QueuedTourEventType = "start" | "step_seen" | "pause" | "complete" | "reset";

export interface QueuedTourEvent {
  key: string;
  tourId: string;
  event: QueuedTourEventType;
  stepId?: string;
  at: number;
  viewerKey: string;
}

export interface QueueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export type DeliveryResult = "ok" | "auth" | "permanent" | "retry";

function eventKey(tourId: string, event: QueuedTourEventType, stepId?: string): string {
  return `${tourId}|${event}|${stepId ?? ""}`;
}

export function readTourQueue(storage: QueueStorage): QueuedTourEvent[] {
  try {
    const raw = storage.getItem(TOUR_QUEUE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is QueuedTourEvent => {
      if (!entry || typeof entry !== "object") return false;
      const value = entry as Partial<QueuedTourEvent>;
      return (
        typeof value.key === "string" &&
        typeof value.tourId === "string" &&
        typeof value.event === "string" &&
        typeof value.at === "number" &&
        typeof value.viewerKey === "string" &&
        (value.stepId === undefined || typeof value.stepId === "string")
      );
    });
  } catch {
    return [];
  }
}

function write(storage: QueueStorage, entries: QueuedTourEvent[]): void {
  try {
    if (entries.length === 0 && storage.removeItem) storage.removeItem(TOUR_QUEUE_KEY);
    else storage.setItem(TOUR_QUEUE_KEY, JSON.stringify(entries));
  } catch {
    // Quota or disabled storage: progress still reaches the server when online.
  }
}

/**
 * Adds one event. The same (tour, event, step) is stored once — a retry, a
 * double click or two tabs converge instead of growing the queue. `reset`
 * clears the queue for that tour: events before a deliberate reset must not be
 * replayed after it.
 */
export function enqueueTourEvent(
  storage: QueueStorage,
  viewerKey: string,
  tourId: string,
  event: QueuedTourEventType,
  stepId?: string,
): QueuedTourEvent[] {
  const existing = readTourQueue(storage);
  if (event === "reset") {
    const next = existing.filter((entry) => entry.tourId !== tourId);
    write(storage, next);
    return next;
  }
  const key = eventKey(tourId, event, stepId);
  if (existing.some((entry) => entry.tourId === tourId && entry.key === key)) return existing;
  const next = [...existing, { key, tourId, event, ...(stepId ? { stepId } : {}), at: Date.now(), viewerKey }];
  write(storage, next.slice(-MAX_ENTRIES));
  return readTourQueue(storage);
}

/**
 * Delivers queued events in order. A network/server failure stops the walk and
 * keeps the rest; a 4xx that can never succeed drops that one entry; an auth
 * failure clears the whole queue (a different member must not receive it).
 */
export async function flushTourQueue(
  storage: QueueStorage,
  viewerKey: string,
  send: (entry: QueuedTourEvent) => Promise<DeliveryResult>,
): Promise<{ delivered: number; dropped: number; remaining: number; stopped: boolean }> {
  const all = readTourQueue(storage);
  const mine = all.filter((entry) => entry.viewerKey === viewerKey);
  // Another viewer's entries are not ours to deliver and not ours to keep.
  if (mine.length !== all.length) write(storage, mine);

  let delivered = 0;
  let dropped = 0;
  let stopped = false;
  for (const entry of mine) {
    let result: DeliveryResult;
    try {
      result = await send(entry);
    } catch {
      // A transport that throws is the same as a network failure: keep the
      // event and stop this pass.
      result = "retry";
    }
    if (result === "retry") {
      stopped = true;
      break;
    }
    if (result === "auth") {
      write(storage, []);
      stopped = true;
      dropped += mine.length;
      break;
    }
    const current = readTourQueue(storage).filter((item) => item.key !== entry.key);
    write(storage, current);
    if (result === "ok") delivered += 1;
    else dropped += 1;
  }
  return {
    delivered,
    dropped,
    remaining: readTourQueue(storage).length,
    stopped,
  };
}

/** Browser storage, when available. */
export function browserQueueStorage(): QueueStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Forgets every queued event (a different member's session, or a sign-out). */
export function clearTourQueue(storage: QueueStorage): void {
  write(storage, []);
}
