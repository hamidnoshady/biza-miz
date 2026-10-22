# Issue #985 — every clean quit logs `TypeError: done is not a function`

Source: <https://github.com/hamidnoshady/biza-miz/issues/985> (label `bug`).
Working branch: `arena/483d58e6-biza-miz`.

## Root cause

`embedded-postgres@16.14.0-beta.17` (pinned in both `package.json` and `electron/package.json`)
ends `dist/index.js` with:

```js
function gracefulShutdown(done) {
    return __awaiter(this, void 0, void 0, function* () {
        yield Promise.all([...instances].map((instance) => instance.stop()));
        // Let NodeJS know we're done
        done();
    });
}
AsyncExitHook(gracefulShutdown);
```

`async-exit-hook@2.0.1` registers its process listeners from `add()`:

```js
add.hookEvent('exit');           // no code -> exit === false
add.hookEvent('beforeExit', 0);  // code     -> async branch, done defined
add.hookEvent('SIGINT', ...);    // code     -> async branch, done defined
```

and `runHook` only passes the finish callback when `exit === true`:

```js
if (exit && hook.length > syncArgCount) { waitingFor++; return hook(stepTowardExit); }
return hook(); // <-- "Cannot perform async hooks in `exit` event"
```

So on the one event every clean quit fires, the hook is called with no arguments:
`done` is `undefined`, `done()` throws inside an async function, and the rejection reaches
`process.on("unhandledRejection")` in `electron/main.js` — exactly the stack in the issue.

## Why the existing mitigation was not enough

Commit `68840333` (issue #869) added `electron/embedded-postgres-exit.js`
(`releaseEmbeddedPostgresExitHook`) and calls it from `backend-manager.js` right after the
library is imported. That commit is an ancestor of **desktop-v1.0.60**, the build named in
this issue, so the rejection was observed from a build that already contained the release
call. The release depends on resolving the *same* `async-exit-hook` module instance the
library registered with; where that identity does not hold — a packaged/asar resolution
difference is one possibility — it returns `false` with no trace and the hook stays
registered. The packaged layout could not be reproduced in this sandbox, so the fix does not
rely on which explanation is right.

That makes the runtime release necessary but not sufficient, and it is what the issue means
by "the app's error channel is permanently red". The fix below therefore removes the crash
from the dependency itself (issue suggestion 1), keeps the release (suggestion 2), and adds a
deterministic stop for the postmaster (suggestion 3).

## Changes

### 1. The packaged dependency tolerates a missing callback

`electron/scripts/patch-embedded-postgres-exit-hook.js` (new) rewrites the single compiled
line `done();` to:

```js
if (typeof done === "function") done();
```

- Idempotent; `--check` reports without writing.
- Only touches the one bare `done();` statement, and only when `gracefulShutdown` +
  `AsyncExitHook(gracefulShutdown)` are present. The instances are still stopped, the
  callback-bearing (`beforeExit`/signal/PM2) hooks are untouched.
- **Fails loudly** if a dependency bump changes that shape, so the build cannot silently ship
  an unpatched library.
- Wired into `electron/package.json` `postinstall` and `predist`, so both `npm ci` and
  `npm run dist` apply it; `electron/scripts/verify-runtime.js` now fails packaging when
  `electron/node_modules/embedded-postgres/dist/index.js` is unpatched.
- The root `devDependency` copy is intentionally **not** patched, so
  `scripts/repro-embedded-postgres-exit.mjs` keeps proving the library defect is real.

### 2. The runtime release is defensive and observable

`electron/backend-manager.js` catches a failing release (instead of failing startup) and logs
when `releaseEmbeddedPostgresExitHook` reports no removable hook, so a field install now shows
why the second line of defence is doing the work. With the patch in place, a hook that runs
anyway can no longer reject.

### 3. A postmaster cannot outlive the app

`electron/embedded-postgres-exit.js` adds `installPostmasterExitGuard` /
`stopPostmasterSync`: a `process.on("exit")` listener that runs `spawnSync(pg_ctl, ["stop",
"-D", <dataDir>, "-m", "fast", "-w", "-t", 10])` **only** when `postmaster.pid` says this data
directory still has a cluster.

- `exit` listeners can only run synchronous work, which is precisely why the library's async
  hook cannot stop PostgreSQL there and why this one can.
- Installed before PostgreSQL is allowed to start (`BackendManager.installExitGuard`), so it
  also covers a quit during first-run `initdb`.
- A clean `pg_ctl stop` removes `postmaster.pid`, so it is a no-op on every normal quit and
  cannot delay one.
- `pg_ctl stop -D` acts only on the postmaster owning that data directory, so a stale pid
  file from a crash fails fast instead of touching another cluster.

### 4. Quitting during startup/migration is a cancellation, not a failure

`BackendManager.start()` now:

- sets `stopRequested` in `stop()` before its first `await`, and checks it at every await
  point (leftover cleanup, port probing, `initialise`, `pg.start`/`pg_ctl start`, database
  creation, migrations, restricted-role preparation, and in the same tick as the server
  `spawn`);
- keeps a local reference to the `EmbeddedPostgres` instance it created, so a concurrent
  `stop()` cannot null it mid-start;
- stops a postmaster it already started before throwing `BackendStoppedError`;
- never spawns the application server after a stop, and reports a readiness failure caused by
  a stop as `BackendStoppedError`.

`electron/main.js` treats `BackendStoppedError` as a normal quit: `exit 0` instead of the
startup-failure dialog. A quit during a migration therefore exits cleanly and leaves no
postmaster.

### 5. Acceptance is asserted by the packaged smoke test

`electron/scripts/smoke-packaged.js` now fails a launch when the desktop log added by that
launch contains `done is not a function`, and checks `postmaster.pid` in both the current
`Data/pgdata` layout and the legacy `pgdata` one. This is the issue's acceptance clause
performed against the installed app, not a unit simulation.

## Verification

Run in this checkout (Node 22 sandbox; the product targets Node 24):

| Check | Result |
| --- | --- |
| `npx vitest run src/lib/desktop-embedded-postgres-exit.test.ts src/electron-embedded-postgres-shutdown.test.ts src/lib/desktop-backend-quit.test.ts` | **16 passed** |
| `npx vitest run` (full fast suite) | **920 files / 12,182 tests passed** |
| `node scripts/repro-embedded-postgres-exit.mjs` | baseline reproduces the rejection; released-hook path clean; **patched-dependency path clean with the hook still registered** |
| `node electron/scripts/patch-embedded-postgres-exit-hook.js --check` on an unpatched copy | exits 1 with the issue reference |
| `npm run lint` (whole repository) | **clean** (`--max-warnings=0`) |
| `tsc --noEmit` (whole repository) | **clean** |

New regression coverage:

- `src/lib/desktop-embedded-postgres-exit.test.ts` — hook removal (unchanged), the patch's
  idempotence and refusal of an unrecognised dependency, `stopPostmasterSync`'s decision
  (including the exact `pg_ctl` argv and failure reporting), and the exit guard's install /
  disarm / error-swallowing behaviour.
- `src/electron-embedded-postgres-shutdown.test.ts` — adds the "patched dependency, hook still
  registered" child, the case a shipped build actually hit.
- `src/lib/desktop-backend-quit.test.ts` — quit while `pg.start()` is in flight (stops the
  instance, throws `BackendStoppedError`), quit before PostgreSQL starts (no instance, no
  server), and idempotent concurrent `stop()`.

## CI evidence

`build-desktop-installer` (the "packaged Windows end-to-end" job) ran on this branch at
`21602e1` (16m58s) and at `dbec0ce` (12m33s), **both passed**, including:

- step 14, `npm ci` in `electron/`, which ran the new `postinstall` patch;
- step 16, `npm run verify:runtime`, which refuses an unpatched dependency;
- step 26, "Install and run actual packaged desktop twice as a standard user", which now also
  asserts the desktop log gained no `done is not a function` line and that `postmaster.pid` is
  gone after each clean quit.

`test.yml` passed at `dbec0ce` — unit tests, type check, ESLint, production build, media E2E,
visual regression, design checks, API guard, data-transfer and both real-database jobs
(integration and data transfer). `verify-shippables` also passed at `dbec0ce`, including the
desktop-shell job.

One gate failure was found and fixed by this work rather than worked around: the
`verify-shippables` "desktop shell" job installs Electron dependencies with
`npm ci --ignore-scripts`, so the postinstall patch could not run and the new
`verify:runtime` check failed. That is the gate doing its job — the job now applies the same
reviewed patch explicitly before verifying, instead of the check being weakened.

## Not verified here

The Windows installer cannot be built in this sandbox; the packaged evidence above comes from
GitHub Actions, not from this environment.

## Re-verification on `main` (2026-10-22)

The fix above (PR #991) was re-checked against `main` at `92d1f2f` without changing any code:

- Installed the exact `embedded-postgres@16.14.0-beta.17` in a scratch directory with
  `--ignore-scripts` and ran `node electron/scripts/patch-embedded-postgres-exit-hook.js --module <index.js>`.
  The patch applied to the bare `done();` at `dist/index.js:393`, and `--check` then reported the
  file as patched.
- Loaded the patched library under a `process.on("unhandledRejection")` listener and exited
  normally: no rejection was reported.

Not re-verified: the vitest suites (repository dependencies were not installed in that
environment) and the packaged Windows build, which is covered by the `build-desktop-installer`
CI job described above.
