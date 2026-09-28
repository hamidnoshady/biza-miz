/**
 * electron/backend-manager.js's desktopServerEnvironment() — the pure
 * mapping from the desktop app's local config to the environment variables
 * the spawned Next.js server process actually receives.
 *
 * Bug fix (this cycle, found during the "any remaining jobs?" follow-up
 * pass): `start()` has always called this function with a 5th options
 * argument (`{ pgToolsDir, emergencyBackupDir }`), but the function's own
 * signature accepted only 4 parameters and silently dropped it. Since
 * NODE_ENV is forced to "production" here, pg-tools.ts's pgToolBin()
 * *requires* PG_TOOLS_DIR in production (throws
 * "{pg_dump,pg_restore}_packaged_tools_not_configured" otherwise) — so every
 * packaged desktop install's backup/restore path was silently broken: the
 * spawned server never received the packaged pg_dump/pg_restore location at
 * all. This file pins the fix: both values must reach the child process's
 * environment, and their absence must not throw or fabricate a value (an
 * unpackaged/dev run has no `pgToolsDir` to pass).
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const backendManager = require("../../electron/backend-manager.js") as {
  desktopServerEnvironment: (
    config: { jwtSecret: string; masterKey: string; appPort: number; instanceId: string },
    runtimeUrl: string,
    superuserUrl: string,
    appVersion?: string,
    options?: { pgToolsDir?: string; emergencyBackupDir?: string; updateStatePath?: string; updateTargetPath?: string },
  ) => Record<string, string>;
};

const CONFIG = { jwtSecret: "jwt-secret", masterKey: "master-key", appPort: 3000, instanceId: "instance-1" };

describe("desktopServerEnvironment", () => {
  it("passes PG_TOOLS_DIR and RESTORE_EMERGENCY_DIR through to the spawned server (regression: these used to be silently dropped)", () => {
    const env = backendManager.desktopServerEnvironment(
      CONFIG,
      "postgres://runtime",
      "postgres://superuser",
      "1.2.3",
      {
        pgToolsDir: "/resources/postgresql-tools",
        emergencyBackupDir: "/userData/emergency-backups",
        updateStatePath: "/userData/Configuration/update-state.json",
        updateTargetPath: "/userData/Configuration/update-target.json",
      },
    );
    expect(env.PG_TOOLS_DIR).toBe("/resources/postgresql-tools");
    expect(env.RESTORE_EMERGENCY_DIR).toBe("/userData/emergency-backups");
    expect(env.DESKTOP_UPDATE_STATE_PATH).toBe("/userData/Configuration/update-state.json");
    expect(env.DESKTOP_UPDATE_TARGET_PATH).toBe("/userData/Configuration/update-target.json");
  });

  it("still sets the core env (unchanged by the fix) and forces production/loopback posture", () => {
    const env = backendManager.desktopServerEnvironment(CONFIG, "postgres://runtime", "postgres://superuser", "1.2.3");
    expect(env.DATABASE_URL).toBe("postgres://runtime");
    expect(env.BACKUP_DATABASE_URL).toBe("postgres://superuser");
    expect(env.JWT_SECRET).toBe(CONFIG.jwtSecret);
    expect(env.POS_MASTER_KEY).toBe(CONFIG.masterKey);
    expect(env.PORT).toBe("3000");
    expect(env.BIND_ADDR).toBe("127.0.0.1");
    expect(env.NODE_ENV).toBe("production");
    expect(env.DEPLOYMENT_ROLE).toBe("site");
    expect(env.DESKTOP_INSTANCE_ID).toBe(CONFIG.instanceId);
    expect(env.APP_RELEASE_VERSION).toBe("1.2.3");
    // SemVer and provenance are deliberately separate; a package whose build
    // metadata is still unknown must not put SemVer into the SHA field.
    expect(env.APP_IMAGE_SHA).toBe("unknown");
    expect(env.APP_BUILD_COMMIT).toBe("unknown");
    expect(env.APP_BUILD_ID).toBe("development");
    expect(env.DESKTOP_RELEASE_CHANNEL).toBe("stable");
  });

  it("omits PG_TOOLS_DIR/RESTORE_EMERGENCY_DIR rather than fabricating a value when the caller has none (dev/unpackaged run)", () => {
    const env = backendManager.desktopServerEnvironment(CONFIG, "postgres://runtime", "postgres://superuser");
    expect(env.PG_TOOLS_DIR).toBeUndefined();
    expect(env.RESTORE_EMERGENCY_DIR).toBeUndefined();
    expect(env.DESKTOP_UPDATE_STATE_PATH).toBeUndefined();
    expect(env.DESKTOP_UPDATE_TARGET_PATH).toBeUndefined();
    expect(env.APP_RELEASE_VERSION).toBe("unknown");
  });

  it("omits a key when only one of the two options is provided, rather than emitting an empty string", () => {
    const env = backendManager.desktopServerEnvironment(CONFIG, "postgres://runtime", "postgres://superuser", "1.0.0", {
      pgToolsDir: "/resources/postgresql-tools",
    });
    expect(env.PG_TOOLS_DIR).toBe("/resources/postgresql-tools");
    expect(env.RESTORE_EMERGENCY_DIR).toBeUndefined();
  });
});
