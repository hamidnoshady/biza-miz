"use strict";

/**
 * Desktop business-profile lifecycle (issue #1571 / ESH-222).
 *
 * `profile-registry.js` decides *which* businesses exist and where each one's
 * data lives. This module decides *which one is running* — and it guarantees the
 * issue's central constraint: **one installed app, many saved businesses, only
 * one local backend active at a time.**
 *
 * ## Why a switch is stop-then-start, not a handover
 *
 * Two embedded PostgreSQL clusters and two Next.js servers at once would double
 * the machine's memory, fight over the saved port pair, and — worse — leave a
 * background sync tick alive for business A while the window shows business B.
 * That last failure is how a pending sale gets pushed under the wrong tenant's
 * device credential, which the issue calls out as non-negotiable. So a switch is
 * an ordered teardown: stop the gateway, stop the app server, stop PostgreSQL
 * (the existing `BackendManager.stop()`, which already drains gracefully and
 * force-kills only after a timeout), then start the target profile.
 *
 * Stopping is a *drain*, never a delete: the outbox/inbox, open shifts and open
 * orders live in that profile's own database and are still there when the
 * profile starts again. They simply cannot be pushed while the profile is not
 * the active one.
 *
 * ## Serialized, and rollback-safe
 *
 * Every operation goes through one promise chain, so two clicks (or a click
 * racing the startup boot) can never start two backends. A failed switch
 * *always* re-creates a fresh backend for the previous profile — a
 * `BackendManager` whose `stop()` ran has a sticky `stopRequested` and cannot be
 * restarted, so rollback constructs a new one rather than reusing the old. If
 * even the rollback fails, the error says so explicitly instead of pretending
 * the app is in a working state.
 *
 * `generation` increments on every successful start. A long-running caller (the
 * server supervisor, an async tick) can capture it and refuse to act once it
 * has changed, so work queued against business A can never be applied to
 * business B.
 *
 * Unit-tested with a fake backend factory in
 * src/lib/desktop-profile-manager.test.ts — the real start path needs an
 * embedded cluster and is covered by the packaged smoke test.
 */

const { BackendManager, BackendStoppedError } = require("./backend-manager");
const { profileDataDir } = require("./profile-registry");

/**
 * A switch that failed. `rollback.ok === true` means the previous business is
 * running again and the app is usable; `rollback.ok === false` means the caller
 * must show a failure state rather than an empty window.
 */
class ProfileSwitchError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "ProfileSwitchError";
    this.code = code;
    this.profileId = options.profileId ?? null;
    this.previousProfileId = options.previousProfileId ?? null;
    this.rollback = options.rollback ?? { attempted: false, ok: false };
  }
}

class ProfileManager {
  /**
   * @param {object} options
   * @param {object} options.app        Electron `app` (passed through to BackendManager).
   * @param {object} options.logger     Structured logger.
   * @param {object} options.safeStorage
   * @param {string} options.installRoot The installation-level data root.
   * @param {(profile: object) => object} [options.backendFactory] Test seam; defaults to a real `BackendManager`.
   */
  constructor({ app, logger, safeStorage, installRoot, backendFactory }) {
    this.app = app;
    this.logger = logger;
    this.safeStorage = safeStorage;
    this.installRoot = installRoot;
    this.backendFactory =
      backendFactory ||
      ((profile) =>
        new BackendManager({
          app,
          logger,
          safeStorage,
          profileDataDir: profileDataDir(installRoot, profile.id),
        }));
    /** The running backend, or null. Only ever one. */
    this.backend = null;
    /** The profile whose data root `backend` is serving. */
    this.activeProfile = null;
    /** Incremented per successful start; see the header. */
    this.generation = 0;
    this.queue = Promise.resolve();
    this.stopRequested = false;
  }

  /** Serialize every lifecycle operation. A rejected operation does not poison the chain. */
  enqueue(operation) {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  get isRunning() {
    return this.backend !== null && this.activeProfile !== null;
  }

  /** Facts for the header and the picker: which business is live right now. */
  status() {
    return {
      activeProfileId: this.activeProfile?.id ?? null,
      activeDisplayName: this.activeProfile?.displayName ?? null,
      running: this.isRunning,
      appUrl: this.backend?.serverAppUrl ?? null,
      generation: this.generation,
    };
  }

  /**
   * Stop whatever is running. A `BackendStoppedError` is a normal cancellation
   * (the owner quit mid-boot), so it is reported as a clean stop.
   */
  async stopActiveBackend() {
    const backend = this.backend;
    if (!backend) return { stopped: false };
    // Clear our references first: a throw during stop must not leave the manager
    // believing a half-stopped backend is still serving a profile.
    this.backend = null;
    const profile = this.activeProfile;
    this.activeProfile = null;
    try {
      await backend.stop();
      return { stopped: true, profileId: profile?.id ?? null };
    } catch (error) {
      if (error instanceof BackendStoppedError) return { stopped: true, profileId: profile?.id ?? null };
      this.logger?.warn?.("Desktop profile backend failed to stop cleanly", {
        profileId: profile?.id ?? null,
        detail: error?.message || String(error),
      });
      return { stopped: false, profileId: profile?.id ?? null, error };
    }
  }

  /** Start `profile` from cold. Refuses to start a second backend. */
  start(profile) {
    return this.enqueue(async () => {
      this.stopRequested = false;
      if (this.isRunning) {
        throw new ProfileSwitchError(
          "profile_already_running",
          "A desktop business backend is already running; switch to another business instead of starting a second one.",
          { previousProfileId: this.activeProfile.id, profileId: profile.id },
        );
      }
      return this.startUnlocked(profile);
    });
  }

  /**
   * Switch to `profile`, draining the current business first and rolling back to
   * it if the target cannot start.
   */
  switchTo(profile) {
    return this.enqueue(async () => {
      if (this.activeProfile?.id === profile.id && this.backend) {
        return { ...this.describe(), switched: false, backend: this.backend };
      }
      const previous = this.activeProfile;
      this.stopRequested = false;
      await this.stopActiveBackend();
      if (this.stopRequested) throw new BackendStoppedError();

      try {
        const result = await this.startUnlocked(profile);
        this.logger?.info?.("Desktop business profile switched", {
          from: previous?.id ?? null,
          to: profile.id,
          generation: this.generation,
        });
        return { ...result, switched: true };
      } catch (error) {
        if (error instanceof BackendStoppedError) throw error;
        const rollback = await this.rollbackTo(previous);
        throw new ProfileSwitchError(
          "profile_switch_failed",
          rollback.ok
            ? "The selected business could not start. The previous business was restored."
            : "The selected business could not start, and the previous business could not be restored either.",
          {
            cause: error,
            profileId: profile.id,
            previousProfileId: previous?.id ?? null,
            rollback,
          },
        );
      }
    });
  }

  /**
   * Roll back to `previous`. A stopped `BackendManager` cannot be restarted
   * (`stopRequested` is sticky), so this builds a new one for the same data root.
   */
  async rollbackTo(previous) {
    if (!previous) return { attempted: false, ok: false };
    // Best-effort cleanup of the half-started target.
    await this.stopActiveBackend();
    try {
      const backend = this.backendFactory(previous);
      const state = await backend.start();
      this.backend = backend;
      this.activeProfile = previous;
      this.generation += 1;
      this.logger?.warn?.("Restored the previous desktop business profile after a failed switch", {
        profileId: previous.id,
        generation: this.generation,
      });
      return { attempted: true, ok: true, state };
    } catch (error) {
      this.backend = null;
      this.activeProfile = null;
      this.logger?.error?.("Failed to restore the previous desktop business profile", error);
      return { attempted: true, ok: false, error };
    }
  }

  async startUnlocked(profile) {
    const directory = profileDataDir(this.installRoot, profile.id);
    const backend = this.backendFactory(profile, directory);
    try {
      const state = await backend.start();
      if (this.stopRequested) {
        await backend.stop().catch(() => {});
        throw new BackendStoppedError();
      }
      this.backend = backend;
      this.activeProfile = profile;
      this.generation += 1;
      return { ...this.describe(), ...state, backend };
    } catch (error) {
      this.backend = null;
      this.activeProfile = null;
      await backend.stop().catch(() => {});
      throw error;
    }
  }

  describe() {
    return {
      appUrl: this.backend?.serverAppUrl ?? null,
      profile: this.activeProfile,
      generation: this.generation,
    };
  }

  /** Stop the active backend (quit, update install, or "change business"). */
  stop() {
    return this.enqueue(async () => {
      this.stopRequested = true;
      return this.stopActiveBackend();
    });
  }
}

module.exports = { ProfileManager, ProfileSwitchError };
