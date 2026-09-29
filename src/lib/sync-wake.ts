/**
 * Single-flight runner for the desktop's sync tick, with a debounced wake-up.
 *
 * The tick runs on a 30-second timer, and is now also woken early — by a local
 * sale committing (Postgres NOTIFY from the outbox) and by the central server
 * reporting new events on a long-poll. Without this wrapper a slow tick and
 * the next timer could overlap and push the same rows twice. Here a run that
 * is asked for while one is in flight sets a flag and runs exactly once more
 * after it; a burst of wake-ups collapses into one run.
 */
export interface SyncRunner {
  /** Run now, or once more after the run in flight. */
  run(): Promise<void>;
  /** Run soon: debounced, so a burst of sales becomes one push. */
  kick(delayMs?: number): void;
  /** Stop any pending wake-up (shutdown). */
  cancel(): void;
}

export function createSyncRunner(tick: () => Promise<void>, onError: (error: unknown) => void = () => {}): SyncRunner {
  let running: Promise<void> | null = null;
  let again = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const run = (): Promise<void> => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          try {
            await tick();
          } catch (error) {
            onError(error);
          }
        } while (again);
      } finally {
        running = null;
      }
    })();
    return running;
  };

  return {
    run,
    kick(delayMs = 1_500) {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void run();
      }, delayMs);
      (timer as { unref?: () => void }).unref?.();
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
