"use strict";

/**
 * Issue #1001 — the application server is supervised while the app runs.
 *
 * `backend-manager.js` watched the server child only until it passed its
 * identity-aware health check. After that nothing did: `server.ts` deliberately
 * `process.exit(1)`s on any non-network uncaught exception ("a broken process
 * must not keep serving"), so one bad request handler left the window pointing
 * at a dead port — the window stayed open with no data and no way back short of
 * relaunching the app by hand.
 *
 * This is the restart policy, kept free of Electron and of the backend so both
 * sides stay testable:
 *
 *   - an unexpected exit starts a restart attempt loop;
 *   - each attempt waits an exponential backoff (1 s, 2 s, 4 s … capped at
 *     30 s) before relaunching, so a crash loop cannot spin the CPU or thrash
 *     the database;
 *   - a successful restart resets the consecutive-failure count and calls
 *     `onRecovered`, which reloads the window;
 *   - after `maxAttempts` consecutive failures it stops trying and calls
 *     `onExhausted`, which surfaces the recovery dialog — the app never loops
 *     forever behind a dialog nobody sees.
 *
 * An exit that happens while the app is quitting, or during an update install,
 * is not reported at all by `backend-manager.js`; this class also ignores
 * anything that arrives after `cancel()`.
 */

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_LOG_LABEL = "application server";

/** Backoff before attempt `attempt` (1-based): 1 s, 2 s, 4 s … capped. */
function restartDelayMs(attempt, { baseMs = BASE_DELAY_MS, maxMs = MAX_DELAY_MS } = {}) {
  if (!Number.isFinite(attempt) || attempt < 1) return 0;
  const exponential = baseMs * 2 ** (Math.floor(attempt) - 1);
  return Math.min(exponential, maxMs);
}

class ServerSupervisor {
  /**
   * @param {object} options
   * @param {() => Promise<void>} options.restart relaunch and health-check the server
   * @param {() => void} [options.onRecovered] called after a successful restart
   * @param {(info: { attempts: number, lastError: Error | null }) => unknown} [options.onExhausted]
   * @param {{warn: Function, error: Function, info: Function}} [options.logger]
   * @param {number} [options.maxAttempts]
   * @param {(ms: number) => Promise<void>} [options.wait]
   * @param {(attempt: number) => number} [options.delayFor]
   * @param {string} [options.label]
   */
  constructor({
    restart,
    onRecovered = () => {},
    onExhausted = () => {},
    logger = console,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    delayFor = (attempt) => restartDelayMs(attempt),
    label = DEFAULT_LOG_LABEL,
  }) {
    if (typeof restart !== "function") throw new TypeError("ServerSupervisor needs a restart function");
    this.restart = restart;
    this.onRecovered = onRecovered;
    this.onExhausted = onExhausted;
    this.logger = logger;
    this.maxAttempts = Math.max(1, Number(maxAttempts) || DEFAULT_MAX_ATTEMPTS);
    this.wait = wait;
    this.delayFor = delayFor;
    this.label = label;
    this.consecutiveFailures = 0;
    this.cancelled = false;
    this.running = false;
    this.lastError = null;
  }

  cancel() {
    this.cancelled = true;
  }

  /** After the recovery dialog asked to try again. */
  reset() {
    this.consecutiveFailures = 0;
    this.cancelled = false;
  }

  /**
   * Run restart attempts until one succeeds or the budget is spent.
   * Resolves `true` when the server is back, `false` when it is not. It never
   * calls `onExhausted`, so the owner-facing dialog can retry in a loop without
   * re-entering this method's own callback.
   */
  async attemptRestart(info = {}) {
    if (this.cancelled) return false;
    // A second exit signal while an attempt loop is already running (the
    // restarted child crashing again) must not start a parallel loop.
    if (this.running) return false;
    this.running = true;
    this.lastError = null;
    try {
      this.logger.warn?.(`The ${this.label} exited unexpectedly; restarting`, {
        code: info.code ?? null,
        signal: info.signal ?? null,
        consecutiveFailures: this.consecutiveFailures,
      });
      while (this.consecutiveFailures < this.maxAttempts) {
        this.consecutiveFailures += 1;
        const attempt = this.consecutiveFailures;
        await this.wait(this.delayFor(attempt));
        if (this.cancelled) return false;
        try {
          await this.restart();
          this.consecutiveFailures = 0;
          this.logger.info?.(`The ${this.label} restarted`, { attempt });
          this.onRecovered({ attempt });
          return true;
        } catch (error) {
          this.lastError = error;
          this.logger.error?.(`Restarting the ${this.label} failed`, { attempt, error });
        }
      }
      this.logger.error?.(`The ${this.label} could not be restarted; asking the owner`, {
        attempts: this.consecutiveFailures,
      });
      return false;
    } finally {
      this.running = false;
    }
  }

  /**
   * Report an unexpected exit. Resolves with what happened so a caller (and a
   * test) can await the whole episode: "ignored" | "recovered" | "exhausted".
   */
  async notifyExit(info = {}) {
    if (this.cancelled) return "ignored";
    if (this.running) return "ignored";
    if (await this.attemptRestart(info)) return "recovered";
    if (this.cancelled) return "ignored";
    await this.onExhausted({ attempts: this.consecutiveFailures, lastError: this.lastError ?? null });
    return "exhausted";
  }
}

module.exports = {
  ServerSupervisor,
  restartDelayMs,
  BASE_DELAY_MS,
  MAX_DELAY_MS,
  DEFAULT_MAX_ATTEMPTS,
};
