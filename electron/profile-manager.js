"use strict";

/**
 * Desktop business-profile lifecycle (issue #1571 / ESH-222).
 *
 * `profile-registry.js` decides *which* businesses exist and where each one's
 * data lives. This module decides *which one is running* — and it guarantees the
 * issue's central constraint: **one installed app, many saved businesses, only
 * one local backend active at a time.**
 *
 * ## Why there is no in-process switching here
 *
 * Two embedded PostgreSQL clusters and two Next.js servers at once would double
 * the machine's memory, fight over the saved port pair, and — worse — leave a
 * background sync tick alive for business A while the window shows business B.
 * That last failure is how a pending sale gets pushed under the wrong tenant's
 * device credential, which the issue calls out as non-negotiable. So "change
 * business" is a full relaunch into the picker (`main.js`), not a handover: it is
 * the only teardown that is certain every local writer, gateway and background
 * tick of the old business is gone. This module therefore only ever starts the
 * one business a process was launched for, and stops it on quit or update.
 *
 * Stopping is a *drain*, never a delete: the outbox/inbox, open shifts and open
 * orders live in that profile's own database and are still there when the
 * profile starts again. They simply cannot be pushed while it is not the active
 * business.
 *
 * ## Serialized
 *
 * Every operation goes through one promise chain, so a quit racing the startup
 * boot can never start two backends, or stop one twice.
 *
 * Unit-tested with a fake backend factory in
 * src/lib/desktop-profile-manager.test.ts — the real start path needs an
 * embedded cluster and is covered by the packaged smoke test.
 */

const { BackendManager, BackendStoppedError } = require("./backend-manager");
const { profileDataDir } = require("./profile-registry");

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
    this.queue = Promise.resolve();
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

  /** Facts for the header and the window: which business is live right now. */
  status() {
    return {
      activeProfileId: this.activeProfile?.id ?? null,
      activeDisplayName: this.activeProfile?.displayName ?? null,
      running: this.isRunning,
      appUrl: this.backend?.serverAppUrl ?? null,
    };
  }

  /**
   * Stop whatever is running. A `BackendStoppedError` is a normal cancellation,
   * so it is reported as a clean stop rather than as a failure.
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
      if (this.isRunning) {
        const error = new Error(
          "A desktop business backend is already running; the app must relaunch to open another business.",
        );
        error.code = "profile_already_running";
        throw error;
      }
      const directory = profileDataDir(this.installRoot, profile.id);
      const backend = this.backendFactory(profile, directory);
      try {
        const state = await backend.start();
        this.backend = backend;
        this.activeProfile = profile;
        return { ...state, appUrl: backend.serverAppUrl, profile };
      } catch (error) {
        this.backend = null;
        this.activeProfile = null;
        await backend.stop().catch(() => {});
        throw error;
      }
    });
  }

  /** Stop the active backend (quit or update install). */
  stop() {
    return this.enqueue(() => this.stopActiveBackend());
  }
}

module.exports = { ProfileManager };
