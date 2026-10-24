# Desktop First-Run Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a fresh Electron desktop install a first-run choice between setting up a brand-new local-only business and pairing with an existing business on the online platform via a one-time code.

**Architecture:** `/welcome` becomes a three-state client shell (`choosing` → `local` | `connecting`). The local path reuses today's `POST /api/setup/bootstrap` unchanged apart from a new `deploymentMode` field that stamps `settings['deployment.mode']` and seeds `business_features` "off" overrides. The connected path adds a new `install_pairing_codes` table on the **online** server (issued from the super-admin console), a public `POST /api/platform/pairing/redeem` that trades a code for a full `PairingSnapshot`, and a public `POST /api/setup/pair` on the **local** install that fetches that snapshot and replays it into the empty local database with every ID preserved verbatim. The same codebase runs on both sides — which half executes depends only on which install you are.

**Tech Stack:** Next.js 15 App Router (TypeScript), PostgreSQL 16 with row-level security, vitest (unit + integration), Electron 3x with `embedded-postgres`, bcryptjs, node:crypto.

## Global Constraints

- **Persian-first UI.** Every user-visible string is Persian (RTL). Digits shown to a user go through `toPersianDigits` from `@/lib/digits` where the surrounding code already does; the pairing code itself stays Latin/ASCII and `dir="ltr"`.
- **Money in integer Rial, dates ISO/Gregorian in storage.** Nothing in this plan touches money, but don't introduce float or Jalali storage anywhere.
- **A new tenant-scoped table needs an RLS policy in the same migration that creates it.** `integration/tenant-isolation.integration.test.ts` fails otherwise, and that failure is a real bug.
- **Migrations are forward-only.** Add `migrations/0048_install_pairing_codes.sql`; never edit an applied migration.
- **`withoutTenantScope()` calls are holes in the isolation boundary.** This plan adds exactly two, both fitting existing justified categories: `redeemPairingCode` (resolve a bearer-style credential to its business before a tenant is chosen — the `server-sync-auth` shape) and `applyPairingSnapshot` (creates the tenant that scoping would otherwise require — the `platform` shape, same as `provisionBusiness`).
- **Anything under `src/lib/` that is pure gets a `*.test.ts` alongside it.** DB-touching files (`query()`/`getPool()`) are the documented exception and are covered by integration tests instead.
- **Platform capability names are dot-separated.** The capability for issuing/revoking pairing codes is `business.provision` (owner-only). There is no `businesses:write`.
- **Platform route handlers guard with `requirePlatformCapability(...)` and wrap in `withPlatformScope(...)`**, never `requireRole`/`requirePermission`.
- **Pairing code plaintext is shown exactly once** and only its sha-256 is stored, following `invitations.token_hash`.
- **Before every commit:** `npx tsc --noEmit`, `npm test`, `npm run test:db`, `npm run build` must all pass. They mirror the CI `test` job exactly.

**Full pre-commit sequence (run from repo root):**

```bash
npx tsc --noEmit
npm test
npm run test:db      # needs Postgres: docker compose up -d
npm run build        # JWT_SECRET only needs to be set to *something*
```

---

## File Structure

**New files (online / issuing side):**

| File | Responsibility |
|---|---|
| `migrations/0048_install_pairing_codes.sql` | `install_pairing_codes` table, partial unique index, RLS policy |
| `src/lib/pairing-codes.ts` | **Pure.** Code generation, normalisation, hashing, redeemability check |
| `src/lib/pairing-codes.test.ts` | Unit tests for the above |
| `src/lib/pairing-service.ts` | **DB.** Issue / revoke / list codes, build snapshot, redeem code |
| `src/app/api/platform/pairing/route.ts` | `GET` list, `POST` issue, `DELETE` revoke — `business.provision` |
| `src/app/api/platform/pairing/redeem/route.ts` | `POST` public — the code is the credential |
| `src/app/platform/businesses/[id]/pairing-panel.tsx` | Console UI: issue, show-once, revoke, status |

**New files (local / redeeming side):**

| File | Responsibility |
|---|---|
| `src/lib/pairing-snapshot.ts` | **Pure.** `PairingSnapshot` type + `validateSnapshot()` shape check |
| `src/lib/pairing-snapshot.test.ts` | Unit tests for the above |
| `src/lib/pairing-apply.ts` | **DB.** `applyPairingSnapshot()` — one bypassed transaction, snapshot IDs preserved |
| `src/app/api/setup/pair/route.ts` | Public — `{ remoteUrl, code }` → redeem → validate → apply → sign in |
| `src/app/welcome/mode-choice.tsx` | Two-card mode screen |
| `src/app/welcome/pair-form.tsx` | Pairing-code entry with per-error Persian messages |
| `src/app/setup/backup/page.tsx` | New optional wizard step: local backup destination |

**New files (shared):**

| File | Responsibility |
|---|---|
| `src/lib/deployment-mode.ts` | **Pure + one DB read.** `DeploymentMode` type, `LOCAL_DISABLED_FEATURES`, `resolveDeploymentMode()`, `readDeploymentMode()`, `isLocalOnly()` |
| `src/lib/deployment-mode.test.ts` | Unit tests for the pure half |
| `integration/pairing.integration.test.ts` | End-to-end: issue → redeem → apply, plus RLS and re-redeem refusal |

**Modified files:**

| File | Change |
|---|---|
| `src/lib/settings.ts` | `+ deploymentMode: "deployment.mode"` in `SETTING_KEYS` |
| `src/lib/business-provisioning.ts` | `+ deploymentMode?: DeploymentModeName` on input; stamps the setting and seeds disabled flags |
| `src/app/api/setup/bootstrap/route.ts` | Passes `body.deploymentMode` through to `provisionBusiness` |
| `src/app/welcome/page.tsx` | Three-state shell |
| `src/middleware.ts` | `+ "/api/setup/pair"` to `PUBLIC_PATHS`; `+ "/api/platform/pairing/redeem"` to `PLATFORM_PUBLIC_PATHS` |
| `src/lib/setup-state.ts` | `+ "backup"` to `WIZARD_STEPS` and `OPTIONAL_STEPS` |
| `src/app/setup/steps.ts` | `+` the backup step entry |
| `src/app/api/backup/config/route.ts` | Refuse `cloud.enabled === true` in local mode |
| `src/app/dashboard/backup/backup-manager.tsx` | Hide the cloud section in local mode |
| `src/app/api/backup/config/route.ts` (GET) | Return `localOnly` so the client can hide the cloud section |
| `src/app/platform/ui.tsx` | `+` pairing error codes to `errorMessage` |
| `src/app/platform/businesses/[id]/page.tsx` | Mount `<PairingPanel />` |
| `electron/preload.js` | Expose `window.desktop.pickFolder()` |
| `electron/main.js` | `ipcMain.handle("pick-folder", …)` |
| `src/lib/db.ts` | Extend the `withoutTenantScope` doc comment with the pairing reason |

---

## Task ordering

Tasks 1–4 are the shared foundation and the online issuing side. Tasks 5–7 are the local redeeming side. Tasks 8–10 are UI. Tasks 11–12 are the local-mode backup story and the Electron bridge. Each task ends green and committable.

---

### Task 1: Deployment mode — pure logic and the settings key

**Files:**
- Create: `src/lib/deployment-mode.ts`
- Create: `src/lib/deployment-mode.test.ts`
- Modify: `src/lib/settings.ts` (the `SETTING_KEYS` object, around line 31)

**Interfaces:**
- Consumes: `getSetting`, `SETTING_KEYS` from `./settings`.
- Produces:
  - `type DeploymentModeName = "local" | "connected"`
  - `interface DeploymentMode { mode: DeploymentModeName; pairedAt: string | null }`
  - `const LOCAL_DISABLED_FEATURES: readonly string[]`
  - `function resolveDeploymentMode(stored: unknown): DeploymentMode` (pure)
  - `async function readDeploymentMode(businessId: string): Promise<DeploymentMode>`
  - `async function isLocalOnly(businessId: string): Promise<boolean>`

---

- [ ] **Step 1: Add the settings key**

In `src/lib/settings.ts`, inside the `SETTING_KEYS` object, after the `appUpdateStatus` line:

```ts
  /** DeploymentMode (src/lib/deployment-mode.ts) — { mode: 'local'|'connected', pairedAt } */
  deploymentMode: "deployment.mode",
```

- [ ] **Step 2: Write the failing test**

Create `src/lib/deployment-mode.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { LOCAL_DISABLED_FEATURES, resolveDeploymentMode } from "./deployment-mode";

describe("resolveDeploymentMode", () => {
  it("treats an absent setting as connected, so installs predating this feature are unaffected", () => {
    expect(resolveDeploymentMode(null)).toEqual({ mode: "connected", pairedAt: null });
    expect(resolveDeploymentMode(undefined)).toEqual({ mode: "connected", pairedAt: null });
  });

  it("reads a stored local mode", () => {
    expect(resolveDeploymentMode({ mode: "local", pairedAt: null })).toEqual({
      mode: "local",
      pairedAt: null,
    });
  });

  it("keeps the paired timestamp on a connected install", () => {
    expect(resolveDeploymentMode({ mode: "connected", pairedAt: "2026-08-03T10:00:00.000Z" })).toEqual(
      { mode: "connected", pairedAt: "2026-08-03T10:00:00.000Z" },
    );
  });

  it("falls back to connected for a malformed value rather than locking features off", () => {
    expect(resolveDeploymentMode({ mode: "banana" })).toEqual({ mode: "connected", pairedAt: null });
    expect(resolveDeploymentMode("local")).toEqual({ mode: "connected", pairedAt: null });
    expect(resolveDeploymentMode(42)).toEqual({ mode: "connected", pairedAt: null });
  });

  it("drops a non-string pairedAt", () => {
    expect(resolveDeploymentMode({ mode: "local", pairedAt: 12345 })).toEqual({
      mode: "local",
      pairedAt: null,
    });
  });
});

describe("LOCAL_DISABLED_FEATURES", () => {
  it("disables exactly the three platform-dependent features", () => {
    expect([...LOCAL_DISABLED_FEATURES].sort()).toEqual([
      "ai_assistant",
      "multi_location",
      "offline_mode",
    ]);
  });

  it("leaves the fully-local features alone", () => {
    for (const key of ["backup", "inventory", "ledger", "reservations", "delivery", "reporting"]) {
      expect(LOCAL_DISABLED_FEATURES).not.toContain(key);
    }
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/lib/deployment-mode.test.ts`
Expected: FAIL — `Failed to resolve import "./deployment-mode"`.

- [ ] **Step 4: Write the implementation**

Create `src/lib/deployment-mode.ts`:

```ts
/**
 * How this install relates to the online platform.
 *
 * Written once, at first run: the local path of the /welcome wizard stamps
 * 'local', the pairing path stamps 'connected'. It is deliberately not
 * changeable from the UI afterwards — upgrading a local install to a connected
 * one means merging two datasets, which is out of scope.
 *
 * An install that predates this setting reads as 'connected', so every
 * existing VPS deployment and every already-paired laptop keeps exactly the
 * behaviour it has today with no backfill migration.
 */
import { getSetting, SETTING_KEYS } from "./settings";

export type DeploymentModeName = "local" | "connected";

export interface DeploymentMode {
  mode: DeploymentModeName;
  /** ISO time the pairing completed; null for a local install. */
  pairedAt: string | null;
}

/**
 * Features a local-only install cannot deliver, seeded as `business_features`
 * "off" overrides at local bootstrap. Each is off because it depends on the
 * platform, not because it is unfinished:
 *
 *   - ai_assistant  — credits and billing live on the platform (Phase 18)
 *   - multi_location — rollup across branches is a platform function
 *   - offline_mode   — gates server-sync and rollup, meaningless standalone
 *
 * They stay individually flippable from the platform console afterwards.
 */
export const LOCAL_DISABLED_FEATURES: readonly string[] = [
  "ai_assistant",
  "multi_location",
  "offline_mode",
] as const;

/** Pure: turn whatever is stored (possibly nothing, possibly junk) into a usable mode. */
export function resolveDeploymentMode(stored: unknown): DeploymentMode {
  const fallback: DeploymentMode = { mode: "connected", pairedAt: null };
  if (typeof stored !== "object" || stored === null) return fallback;
  const raw = stored as { mode?: unknown; pairedAt?: unknown };
  if (raw.mode !== "local" && raw.mode !== "connected") return fallback;
  return {
    mode: raw.mode,
    pairedAt: typeof raw.pairedAt === "string" ? raw.pairedAt : null,
  };
}

export async function readDeploymentMode(businessId: string): Promise<DeploymentMode> {
  return resolveDeploymentMode(await getSetting<unknown>(businessId, SETTING_KEYS.deploymentMode));
}

export async function isLocalOnly(businessId: string): Promise<boolean> {
  return (await readDeploymentMode(businessId)).mode === "local";
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/lib/deployment-mode.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 6: Type check and commit**

```bash
npx tsc --noEmit
npm test
git add src/lib/deployment-mode.ts src/lib/deployment-mode.test.ts src/lib/settings.ts
git commit -m "feat: deployment mode setting (local vs connected) with local feature list"
```

---

### Task 2: Local mode at bootstrap

**Files:**
- Modify: `src/lib/business-provisioning.ts` (`ProvisionBusinessInput`, `provisionBusiness`)
- Modify: `src/app/api/setup/bootstrap/route.ts`
- Test: covered by `integration/pairing.integration.test.ts` in Task 7 (this file is DB-touching, so per repo convention it has no direct unit test)

**Interfaces:**
- Consumes: `DeploymentModeName`, `LOCAL_DISABLED_FEATURES` from `./deployment-mode`; `SETTING_KEYS` from `./settings`.
- Produces: `ProvisionBusinessInput.deploymentMode?: DeploymentModeName`, defaulting to `"connected"` when absent.

---

- [ ] **Step 1: Extend the provisioning input type**

In `src/lib/business-provisioning.ts`, add the import at the top (after the existing `./slug` import):

```ts
import { LOCAL_DISABLED_FEATURES, type DeploymentModeName } from "./deployment-mode";
import { SETTING_KEYS } from "./settings";
```

Then add to `ProvisionBusinessInput`, after `seedChartOfAccounts`:

```ts
  /**
   * How this install relates to the online platform. 'local' stamps the
   * deployment-mode setting and seeds `business_features` overrides turning
   * off everything that needs the platform to work (see
   * LOCAL_DISABLED_FEATURES). Absent means 'connected', which writes nothing
   * — so every existing caller (the online console, public signup) is
   * unchanged.
   */
  deploymentMode?: DeploymentModeName;
```

- [ ] **Step 2: Write the local-mode seeding inside the provisioning transaction**

In `src/lib/business-provisioning.ts`, in `provisionBusiness`, immediately after the `if (input.seedChartOfAccounts) { … }` block and before `await client.query("COMMIT")`:

```ts
      // Local-only installs record the mode and turn off the platform-dependent
      // features in the same transaction that creates the business, so there is
      // never a window where a local install looks like a connected one.
      if (input.deploymentMode === "local") {
        await client.query(
          `INSERT INTO settings (business_id, location_id, key, value)
           VALUES ($1, NULL, $2, $3)`,
          [businessId, SETTING_KEYS.deploymentMode, JSON.stringify({ mode: "local", pairedAt: null })],
        );
        for (const flagKey of LOCAL_DISABLED_FEATURES) {
          await client.query(
            `INSERT INTO business_features (business_id, flag_key, enabled)
             SELECT $1, $2, false
              WHERE EXISTS (SELECT 1 FROM feature_flags WHERE key = $2)
             ON CONFLICT (business_id, flag_key) DO UPDATE SET enabled = false, updated_at = now()`,
            [businessId, flagKey],
          );
        }
      }
```

- [ ] **Step 3: Accept the field in the bootstrap route**

In `src/app/api/setup/bootstrap/route.ts`, replace:

```ts
  let created;
  try {
    created = await provisionBusiness(input);
```

with:

```ts
  // The first-run wizard's mode choice. Anything other than the literal
  // 'local' is treated as connected, which is what every non-desktop caller
  // (public signup, the platform console) already sends by omission.
  const deploymentMode =
    (body as { deploymentMode?: unknown }).deploymentMode === "local" ? "local" : "connected";

  let created;
  try {
    created = await provisionBusiness({ ...input, deploymentMode });
```

- [ ] **Step 4: Type check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Run the existing test suites to prove nothing regressed**

```bash
npm test
npm run test:db
```
Expected: PASS. `provisionBusiness` without `deploymentMode` behaves exactly as before, so every existing caller and test is untouched.

- [ ] **Step 6: Commit**

```bash
git add src/lib/business-provisioning.ts src/app/api/setup/bootstrap/route.ts
git commit -m "feat: bootstrap can provision a local-only business with platform features off"
```

---

### Task 3: Pairing codes — table and pure logic

**Files:**
- Create: `migrations/0048_install_pairing_codes.sql`
- Create: `src/lib/pairing-codes.ts`
- Create: `src/lib/pairing-codes.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `const PAIRING_CODE_ALPHABET: string`
  - `const PAIRING_CODE_TTL_HOURS = 72`
  - `function generatePairingCode(): string` — formatted `XXXX-XXXX-XXXX`
  - `function normalizePairingCode(raw: string): string` — 12 chars, no dashes
  - `function hashPairingCode(code: string): string` — sha-256 hex of the normalised code
  - `type PairingCodeState = "valid" | "code_expired" | "code_already_redeemed" | "code_revoked"`
  - `interface PairingCodeRow { expiresAt: Date; redeemedAt: Date | null; revokedAt: Date | null }`
  - `function pairingCodeState(row: PairingCodeRow, now: Date): PairingCodeState`

---

- [ ] **Step 1: Write the migration**

Create `migrations/0048_install_pairing_codes.sql`:

```sql
-- ============================================================================
-- 0048_install_pairing_codes.sql — desktop first-run pairing
--
-- A pairing code is how a desktop install claims an existing business that was
-- provisioned on the online platform. An operator issues one from the
-- super-admin console and hands it to the owner out-of-band; redeeming it
-- returns a one-time snapshot of the business configuration, which the local
-- install replays into its empty database.
--
-- Only the code's sha-256 is stored, following the same rule as the Phase 13
-- invitations and the Phase 9 rollup tokens: the plaintext is shown once at
-- creation and is unrecoverable afterwards, so a database read can never yield
-- a usable code.
-- ============================================================================

CREATE TABLE install_pairing_codes (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id  uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    code_hash    text NOT NULL UNIQUE,
    expires_at   timestamptz NOT NULL,
    issued_by    uuid REFERENCES platform_users(id) ON DELETE SET NULL,
    redeemed_at  timestamptz,
    redeemed_ip  inet,
    revoked_at   timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_pairing_codes_business ON install_pairing_codes (business_id, created_at DESC);

-- At most one live code per business: re-issuing should replace the pending
-- code, not accumulate several that all still work.
CREATE UNIQUE INDEX idx_pairing_codes_live_business
    ON install_pairing_codes (business_id)
    WHERE redeemed_at IS NULL AND revoked_at IS NULL;

-- Phase 12 rule: a new tenant-scoped table needs its policy in the same
-- migration that creates it (see CLAUDE.md). install_pairing_codes carries
-- business_id, so it takes the standard shape.
ALTER TABLE install_pairing_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE install_pairing_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON install_pairing_codes FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
```

- [ ] **Step 2: Apply the migration twice to prove reruns are a no-op**

```bash
docker compose up -d
npm run db:migrate
npm run db:migrate
```
Expected: the first run applies `0048_install_pairing_codes`, the second reports nothing to do.

- [ ] **Step 3: Write the failing test**

Create `src/lib/pairing-codes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  generatePairingCode,
  hashPairingCode,
  normalizePairingCode,
  pairingCodeState,
  PAIRING_CODE_ALPHABET,
} from "./pairing-codes";

describe("generatePairingCode", () => {
  it("produces a dashed XXXX-XXXX-XXXX code", () => {
    for (let i = 0; i < 50; i += 1) {
      expect(generatePairingCode()).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    }
  });

  it("only uses characters from the unambiguous alphabet", () => {
    for (let i = 0; i < 50; i += 1) {
      for (const ch of generatePairingCode().replaceAll("-", "")) {
        expect(PAIRING_CODE_ALPHABET).toContain(ch);
      }
    }
  });

  it("excludes the characters people confuse when reading a code aloud", () => {
    for (const ch of ["0", "1", "O", "I"]) {
      expect(PAIRING_CODE_ALPHABET).not.toContain(ch);
    }
  });

  it("does not repeat within a reasonable sample", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) seen.add(generatePairingCode());
    expect(seen.size).toBe(500);
  });
});

describe("normalizePairingCode", () => {
  it("strips dashes, spaces and case", () => {
    expect(normalizePairingCode("abcd-efgh-jkmn")).toBe("ABCDEFGHJKMN");
    expect(normalizePairingCode("  ABCD EFGH JKMN ")).toBe("ABCDEFGHJKMN");
    expect(normalizePairingCode("ABCDEFGHJKMN")).toBe("ABCDEFGHJKMN");
  });

  it("folds the ambiguous characters onto their alphabet members", () => {
    // 0 reads as O and 1 reads as I when a code is dictated over the phone;
    // the alphabet excludes O/I/0/1 entirely, so both fold to the letters.
    expect(normalizePairingCode("0000-1111-ABCD")).toBe("OOOOIIIIABCD");
  });

  it("folds Persian digits, since a Persian keyboard is the likely input", () => {
    expect(normalizePairingCode("۰۰۰۰-۱۱۱۱-ABCD")).toBe("OOOOIIIIABCD");
  });
});

describe("hashPairingCode", () => {
  it("is a 64-character hex sha-256", () => {
    expect(hashPairingCode("ABCD-EFGH-JKMN")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes the normalised form, so formatting never changes the result", () => {
    expect(hashPairingCode("abcd-efgh-jkmn")).toBe(hashPairingCode("ABCDEFGHJKMN"));
    expect(hashPairingCode(" ABCD EFGH JKMN ")).toBe(hashPairingCode("ABCDEFGHJKMN"));
  });

  it("differs for different codes", () => {
    expect(hashPairingCode("ABCD-EFGH-JKMN")).not.toBe(hashPairingCode("ABCD-EFGH-JKMP"));
  });
});

describe("pairingCodeState", () => {
  const now = new Date("2026-08-03T12:00:00.000Z");
  const future = new Date("2026-08-05T12:00:00.000Z");
  const past = new Date("2026-08-01T12:00:00.000Z");

  it("accepts a live, unredeemed, unrevoked code", () => {
    expect(pairingCodeState({ expiresAt: future, redeemedAt: null, revokedAt: null }, now)).toBe(
      "valid",
    );
  });

  it("rejects an expired code", () => {
    expect(pairingCodeState({ expiresAt: past, redeemedAt: null, revokedAt: null }, now)).toBe(
      "code_expired",
    );
  });

  it("rejects an already-redeemed code", () => {
    expect(pairingCodeState({ expiresAt: future, redeemedAt: past, revokedAt: null }, now)).toBe(
      "code_already_redeemed",
    );
  });

  it("rejects a revoked code", () => {
    expect(pairingCodeState({ expiresAt: future, redeemedAt: null, revokedAt: past }, now)).toBe(
      "code_revoked",
    );
  });

  it("reports revocation ahead of expiry when both apply, so the message names the deliberate act", () => {
    expect(pairingCodeState({ expiresAt: past, redeemedAt: null, revokedAt: past }, now)).toBe(
      "code_revoked",
    );
  });

  it("reports redemption ahead of revocation, since a used code is the more useful fact", () => {
    expect(pairingCodeState({ expiresAt: future, redeemedAt: past, revokedAt: past }, now)).toBe(
      "code_already_redeemed",
    );
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run src/lib/pairing-codes.test.ts`
Expected: FAIL — `Failed to resolve import "./pairing-codes"`.

- [ ] **Step 5: Write the implementation**

Create `src/lib/pairing-codes.ts`:

```ts
/**
 * One-time pairing codes — the credential a desktop install presents to claim
 * an existing online business.
 *
 * Pure by design (only node:crypto), so it is unit-tested directly; the
 * database side lives in pairing-service.ts.
 *
 * The alphabet excludes O/0 and I/1 because a code's whole job is to survive
 * being read aloud over the phone and typed by someone who is not a
 * developer. normalizePairingCode folds the excluded characters back onto
 * their look-alikes rather than rejecting them, so a code typed as "0" still
 * matches the "O" that was issued.
 */
import { createHash, randomInt } from "node:crypto";

export const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** How long an issued code stays redeemable. Long enough to post it, short enough to matter. */
export const PAIRING_CODE_TTL_HOURS = 72;

const GROUPS = 3;
const GROUP_LENGTH = 4;

/** A fresh code in display form: XXXX-XXXX-XXXX. */
export function generatePairingCode(): string {
  const groups: string[] = [];
  for (let g = 0; g < GROUPS; g += 1) {
    let group = "";
    for (let i = 0; i < GROUP_LENGTH; i += 1) {
      group += PAIRING_CODE_ALPHABET[randomInt(PAIRING_CODE_ALPHABET.length)];
    }
    groups.push(group);
  }
  return groups.join("-");
}

/** Persian and Arabic-Indic digits, folded to ASCII before the look-alike pass. */
const DIGIT_FOLD: Record<string, string> = {
  "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4",
  "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9",
  "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
  "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
};

/** Display form (or anything close to it) -> the 12 characters that get hashed. */
export function normalizePairingCode(raw: string): string {
  return [...raw]
    .map((ch) => DIGIT_FOLD[ch] ?? ch)
    .join("")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replaceAll("0", "O")
    .replaceAll("1", "I");
}

export function hashPairingCode(code: string): string {
  return createHash("sha256").update(normalizePairingCode(code)).digest("hex");
}

export type PairingCodeState =
  | "valid"
  | "code_expired"
  | "code_already_redeemed"
  | "code_revoked";

export interface PairingCodeRow {
  expiresAt: Date;
  redeemedAt: Date | null;
  revokedAt: Date | null;
}

/**
 * Why a code can't be used, or "valid".
 *
 * Redemption is reported ahead of revocation and both ahead of expiry: when
 * more than one applies, the most specific fact is the most useful thing to
 * put in front of a café owner who is stuck at the pairing screen.
 */
export function pairingCodeState(row: PairingCodeRow, now: Date): PairingCodeState {
  if (row.redeemedAt) return "code_already_redeemed";
  if (row.revokedAt) return "code_revoked";
  if (row.expiresAt.getTime() <= now.getTime()) return "code_expired";
  return "valid";
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run src/lib/pairing-codes.test.ts`
Expected: PASS — 15 tests.

- [ ] **Step 7: Run the migrations integration test**

Run: `npm run test:db -- integration/migrations.integration.test.ts integration/tenant-isolation.integration.test.ts`
Expected: PASS. `tenant-isolation` proves the new table has a working RLS policy.

- [ ] **Step 8: Commit**

```bash
npx tsc --noEmit
git add migrations/0048_install_pairing_codes.sql src/lib/pairing-codes.ts src/lib/pairing-codes.test.ts
git commit -m "feat: install_pairing_codes table and pure pairing-code logic"
```

---

### Task 4: Snapshot shape and validation

**Files:**
- Create: `src/lib/pairing-snapshot.ts`
- Create: `src/lib/pairing-snapshot.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `const PAIRING_SNAPSHOT_VERSION = 1`
  - `interface SnapshotUser`, `SnapshotAccount`, `SnapshotMenuCategory`, `SnapshotMenuItem`, `SnapshotSetting`, `PairingSnapshot`
  - `type SnapshotValidation = { ok: true; snapshot: PairingSnapshot } | { ok: false; error: "snapshot_invalid" }`
  - `function validateSnapshot(raw: unknown): SnapshotValidation`

---

- [ ] **Step 1: Write the failing test**

Create `src/lib/pairing-snapshot.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { PAIRING_SNAPSHOT_VERSION, validateSnapshot, type PairingSnapshot } from "./pairing-snapshot";

function validSnapshot(): PairingSnapshot {
  return {
    version: PAIRING_SNAPSHOT_VERSION,
    business: {
      id: "11111111-1111-1111-1111-111111111111",
      name: "کافه بهار",
      slug: "cafe-bahar",
      timezone: "Asia/Tehran",
    },
    location: {
      id: "22222222-2222-2222-2222-222222222222",
      name: "شعبه مرکزی",
      address: null,
      phone: null,
      timezone: "Asia/Tehran",
    },
    users: [
      {
        id: "33333333-3333-3333-3333-333333333333",
        role: "owner",
        fullName: "حمید",
        email: "owner@example.com",
        permissions: {},
        pinHash: null,
        passwordHash: "$2a$10$abcdefghijklmnopqrstuv",
        platformUserEmail: "owner@example.com",
        platformUserFullName: "حمید",
        platformUserPasswordHash: "$2a$10$abcdefghijklmnopqrstuv",
        locationIds: ["22222222-2222-2222-2222-222222222222"],
      },
    ],
    accounts: [
      { id: "44444444-4444-4444-4444-444444444444", parentCode: null, code: "1000", name: "دارایی", type: "asset" },
    ],
    menu: {
      categories: [
        { id: "55555555-5555-5555-5555-555555555555", name: "نوشیدنی گرم", sortOrder: 0, isActive: true },
      ],
      items: [
        {
          id: "66666666-6666-6666-6666-666666666666",
          categoryId: "55555555-5555-5555-5555-555555555555",
          name: "اسپرسو",
          description: null,
          sku: null,
          price: 850000,
          imageUrl: null,
          isActive: true,
          sortOrder: 0,
        },
      ],
    },
    settings: [{ key: "business.prefs", value: { currencyDisplay: "toman" } }],
    features: { inventory: true, ai_assistant: false },
    syncToken: "a".repeat(64),
  };
}

describe("validateSnapshot", () => {
  it("accepts a complete snapshot", () => {
    const result = validateSnapshot(validSnapshot());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.snapshot.business.slug).toBe("cafe-bahar");
  });

  it("rejects a non-object", () => {
    expect(validateSnapshot(null)).toEqual({ ok: false, error: "snapshot_invalid" });
    expect(validateSnapshot("nope")).toEqual({ ok: false, error: "snapshot_invalid" });
    expect(validateSnapshot([])).toEqual({ ok: false, error: "snapshot_invalid" });
  });

  it("rejects an unknown version rather than guessing at the shape", () => {
    expect(validateSnapshot({ ...validSnapshot(), version: 2 })).toEqual({
      ok: false,
      error: "snapshot_invalid",
    });
    expect(validateSnapshot({ ...validSnapshot(), version: undefined })).toEqual({
      ok: false,
      error: "snapshot_invalid",
    });
  });

  it("rejects a missing business", () => {
    const s = validSnapshot() as Record<string, unknown>;
    delete s.business;
    expect(validateSnapshot(s)).toEqual({ ok: false, error: "snapshot_invalid" });
  });

  it("rejects a business whose id is not a uuid", () => {
    const s = validSnapshot();
    s.business.id = "not-a-uuid";
    expect(validateSnapshot(s)).toEqual({ ok: false, error: "snapshot_invalid" });
  });

  it("rejects a location belonging to no business slug/timezone shape", () => {
    const s = validSnapshot() as unknown as Record<string, unknown>;
    s.location = { id: "22222222-2222-2222-2222-222222222222" };
    expect(validateSnapshot(s)).toEqual({ ok: false, error: "snapshot_invalid" });
  });

  it("rejects a snapshot with no users, since there would be nobody to sign in as", () => {
    const s = validSnapshot();
    s.users = [];
    expect(validateSnapshot(s)).toEqual({ ok: false, error: "snapshot_invalid" });
  });

  it("rejects a snapshot with no owner among its users", () => {
    const s = validSnapshot();
    s.users[0].role = "cashier";
    expect(validateSnapshot(s)).toEqual({ ok: false, error: "snapshot_invalid" });
  });

  it("rejects a menu item priced as a float, since money is integer Rial", () => {
    const s = validSnapshot();
    s.menu.items[0].price = 12.5;
    expect(validateSnapshot(s)).toEqual({ ok: false, error: "snapshot_invalid" });
  });

  it("rejects a negative price", () => {
    const s = validSnapshot();
    s.menu.items[0].price = -1;
    expect(validateSnapshot(s)).toEqual({ ok: false, error: "snapshot_invalid" });
  });

  it("rejects a sync token that is too short to be a real secret", () => {
    const s = validSnapshot();
    s.syncToken = "short";
    expect(validateSnapshot(s)).toEqual({ ok: false, error: "snapshot_invalid" });
  });

  it("accepts empty accounts, menu and settings — a business may be freshly provisioned", () => {
    const s = validSnapshot();
    s.accounts = [];
    s.menu = { categories: [], items: [] };
    s.settings = [];
    expect(validateSnapshot(s).ok).toBe(true);
  });

  it("rejects a menu item pointing at a category that is not in the snapshot", () => {
    const s = validSnapshot();
    s.menu.items[0].categoryId = "99999999-9999-9999-9999-999999999999";
    expect(validateSnapshot(s)).toEqual({ ok: false, error: "snapshot_invalid" });
  });

  it("accepts a menu item with no category", () => {
    const s = validSnapshot();
    s.menu.items[0].categoryId = null;
    expect(validateSnapshot(s).ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/pairing-snapshot.test.ts`
Expected: FAIL — `Failed to resolve import "./pairing-snapshot"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/pairing-snapshot.ts`:

```ts
/**
 * The payload a desktop install receives when it redeems a pairing code, and
 * the validation it runs before touching its database.
 *
 * Pure — no imports beyond types — so it is unit-tested directly and can be
 * used on both sides: the online server builds a value of this shape
 * (pairing-service.ts) and the local install validates one (pairing-apply.ts).
 *
 * IDs are carried verbatim rather than regenerated. The local install ends up
 * holding the same business_id, location_id and user ids as the online
 * business, which is what makes Phase 11's sync_events replay correctly in
 * both directions afterwards.
 *
 * Credential hashes cross as-is (bcrypt output, never plaintext), so staff sign
 * in on the laptop with the PIN they already know.
 */

export const PAIRING_SNAPSHOT_VERSION = 1;

export interface SnapshotUser {
  id: string;
  role: string;
  fullName: string;
  email: string | null;
  permissions: Record<string, unknown>;
  pinHash: string | null;
  passwordHash: string | null;
  /**
   * The global identity behind this membership, recreated on the local side so
   * an owner can sign in with the same email and password they use online.
   * Null for a PIN-only member, who has no platform identity.
   */
  platformUserEmail: string | null;
  platformUserFullName: string | null;
  platformUserPasswordHash: string | null;
  locationIds: string[];
}

export interface SnapshotAccount {
  id: string;
  parentCode: string | null;
  code: string;
  name: string;
  type: string;
}

export interface SnapshotMenuCategory {
  id: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
}

export interface SnapshotMenuItem {
  id: string;
  categoryId: string | null;
  name: string;
  description: string | null;
  sku: string | null;
  /** Integer Rial, as everywhere else in this system. */
  price: number;
  imageUrl: string | null;
  isActive: boolean;
  sortOrder: number;
}

export interface SnapshotSetting {
  key: string;
  value: unknown;
}

export interface PairingSnapshot {
  version: number;
  business: { id: string; name: string; slug: string; timezone: string };
  location: {
    id: string;
    name: string;
    address: string | null;
    phone: string | null;
    timezone: string;
  };
  users: SnapshotUser[];
  accounts: SnapshotAccount[];
  menu: { categories: SnapshotMenuCategory[]; items: SnapshotMenuItem[] };
  settings: SnapshotSetting[];
  features: Record<string, boolean>;
  /** Plaintext, delivered once — the local install stores only its hash via setServerSyncConfig. */
  syncToken: string;
}

export type SnapshotValidation =
  | { ok: true; snapshot: PairingSnapshot }
  | { ok: false; error: "snapshot_invalid" };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIN_SYNC_TOKEN_LENGTH = 16;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

function isNullableString(v: unknown): v is string | null {
  return v === null || typeof v === "string";
}

function isIntegerAtLeastZero(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

/**
 * A shape check, deliberately not a trust check: the code already
 * authenticated the caller, so this only guards against a truncated
 * response, a version skew, or a bug on the issuing side writing garbage into
 * an empty local database.
 */
export function validateSnapshot(raw: unknown): SnapshotValidation {
  const fail = { ok: false, error: "snapshot_invalid" } as const;
  if (!isObject(raw)) return fail;
  if (raw.version !== PAIRING_SNAPSHOT_VERSION) return fail;

  const business = raw.business;
  if (!isObject(business)) return fail;
  if (!isUuid(business.id)) return fail;
  if (typeof business.name !== "string" || !business.name) return fail;
  if (typeof business.slug !== "string" || !business.slug) return fail;
  if (typeof business.timezone !== "string" || !business.timezone) return fail;

  const location = raw.location;
  if (!isObject(location)) return fail;
  if (!isUuid(location.id)) return fail;
  if (typeof location.name !== "string" || !location.name) return fail;
  if (!isNullableString(location.address)) return fail;
  if (!isNullableString(location.phone)) return fail;
  if (typeof location.timezone !== "string" || !location.timezone) return fail;

  if (!Array.isArray(raw.users) || raw.users.length === 0) return fail;
  for (const user of raw.users) {
    if (!isObject(user)) return fail;
    if (!isUuid(user.id)) return fail;
    if (typeof user.role !== "string" || !user.role) return fail;
    if (typeof user.fullName !== "string" || !user.fullName) return fail;
    if (!isNullableString(user.email)) return fail;
    if (!isObject(user.permissions)) return fail;
    if (!isNullableString(user.pinHash)) return fail;
    if (!isNullableString(user.passwordHash)) return fail;
    if (!isNullableString(user.platformUserEmail)) return fail;
    if (!isNullableString(user.platformUserFullName)) return fail;
    if (!isNullableString(user.platformUserPasswordHash)) return fail;
    if (!Array.isArray(user.locationIds) || !user.locationIds.every(isUuid)) return fail;
  }
  // Without an owner the local install would have nobody to sign in as, which
  // is a dead end the wizard cannot recover from.
  if (!raw.users.some((u) => isObject(u) && u.role === "owner")) return fail;

  if (!Array.isArray(raw.accounts)) return fail;
  for (const account of raw.accounts) {
    if (!isObject(account)) return fail;
    if (!isUuid(account.id)) return fail;
    if (!isNullableString(account.parentCode)) return fail;
    if (typeof account.code !== "string" || !account.code) return fail;
    if (typeof account.name !== "string" || !account.name) return fail;
    if (typeof account.type !== "string" || !account.type) return fail;
  }

  const menu = raw.menu;
  if (!isObject(menu)) return fail;
  if (!Array.isArray(menu.categories) || !Array.isArray(menu.items)) return fail;
  const categoryIds = new Set<string>();
  for (const category of menu.categories) {
    if (!isObject(category)) return fail;
    if (!isUuid(category.id)) return fail;
    if (typeof category.name !== "string" || !category.name) return fail;
    if (!Number.isInteger(category.sortOrder)) return fail;
    if (typeof category.isActive !== "boolean") return fail;
    categoryIds.add(category.id);
  }
  for (const item of menu.items) {
    if (!isObject(item)) return fail;
    if (!isUuid(item.id)) return fail;
    if (item.categoryId !== null && !isUuid(item.categoryId)) return fail;
    // A dangling category reference would violate the FK on insert, so catch
    // it here where the error is still a clean "snapshot_invalid".
    if (typeof item.categoryId === "string" && !categoryIds.has(item.categoryId)) return fail;
    if (typeof item.name !== "string" || !item.name) return fail;
    if (!isNullableString(item.description)) return fail;
    if (!isNullableString(item.sku)) return fail;
    if (!isIntegerAtLeastZero(item.price)) return fail;
    if (!isNullableString(item.imageUrl)) return fail;
    if (typeof item.isActive !== "boolean") return fail;
    if (!Number.isInteger(item.sortOrder)) return fail;
  }

  if (!Array.isArray(raw.settings)) return fail;
  for (const setting of raw.settings) {
    if (!isObject(setting)) return fail;
    if (typeof setting.key !== "string" || !setting.key) return fail;
  }

  if (!isObject(raw.features)) return fail;
  if (!Object.values(raw.features).every((v) => typeof v === "boolean")) return fail;

  if (typeof raw.syncToken !== "string" || raw.syncToken.length < MIN_SYNC_TOKEN_LENGTH) return fail;

  return { ok: true, snapshot: raw as unknown as PairingSnapshot };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/pairing-snapshot.test.ts`
Expected: PASS — 14 tests.

- [ ] **Step 5: Commit**

```bash
npx tsc --noEmit
npm test
git add src/lib/pairing-snapshot.ts src/lib/pairing-snapshot.test.ts
git commit -m "feat: PairingSnapshot type and shape validation"
```

---

### Task 5: Pairing service — issue, list, revoke, redeem, build snapshot

**Files:**
- Create: `src/lib/pairing-service.ts`
- Modify: `src/lib/db.ts` (the `withoutTenantScope` doc comment, around lines 118–148)
- Test: `integration/pairing.integration.test.ts` in Task 7

**Interfaces:**
- Consumes: `generatePairingCode`, `hashPairingCode`, `pairingCodeState`, `PAIRING_CODE_TTL_HOURS` from `./pairing-codes`; `PairingSnapshot`, `PAIRING_SNAPSHOT_VERSION` from `./pairing-snapshot`; `query`, `getPool`, `withoutTenantScope` from `./db`; `effectiveFeatures` from `./features`; `setServerSyncConfig` from `./server-sync`; `SETTING_KEYS` from `./settings`.
- Produces:
  - `interface PairingCodeSummary { id: string; businessId: string; locationId: string; expiresAt: string; redeemedAt: string | null; revokedAt: string | null; createdAt: string; state: PairingCodeState }`
  - `async function issuePairingCode(businessId: string, issuedBy: string): Promise<{ code: string; summary: PairingCodeSummary } | { error: "no_location" }>`
  - `async function listPairingCodes(businessId: string): Promise<PairingCodeSummary[]>`
  - `async function revokePairingCode(businessId: string, codeId: string): Promise<boolean>`
  - `type RedeemResult = { ok: true; snapshot: PairingSnapshot } | { ok: false; error: "code_not_found" | "code_expired" | "code_already_redeemed" | "code_revoked" }`
  - `async function redeemPairingCode(rawCode: string, clientIp: string | null): Promise<RedeemResult>`

---

- [ ] **Step 1: Extend the `withoutTenantScope` doc comment**

In `src/lib/db.ts`, in the doc comment above `withoutTenantScope`, add a bullet after the `employee-session-auth` one:

```
 *   - **pairing-redeem** — resolving a one-time desktop pairing code to the
 *     business it was issued for (and reading that business's configuration to
 *     build the snapshot) happens before any tenant has been chosen, the same
 *     identify-the-tenant-first shape as server-sync-auth. Its counterpart on
 *     the local install, `applyPairingSnapshot`, runs under **platform** for
 *     the same reason `provisionBusiness` does: it creates the tenant that
 *     scoping would otherwise require to already exist.
```

- [ ] **Step 2: Write the service**

Create `src/lib/pairing-service.ts`:

```ts
/**
 * The online server's half of desktop pairing: issuing codes from the
 * super-admin console, and trading a redeemed code for a snapshot of the
 * business configuration.
 *
 * DB-touching, so per repo convention it has no direct unit test — the pure
 * logic it leans on is covered by pairing-codes.test.ts and
 * pairing-snapshot.test.ts, and the transactional behaviour by
 * integration/pairing.integration.test.ts.
 */
import { randomBytes } from "node:crypto";
import { getPool, query, withoutTenantScope } from "./db";
import { effectiveFeatures } from "./features";
import {
  generatePairingCode,
  hashPairingCode,
  pairingCodeState,
  PAIRING_CODE_TTL_HOURS,
  type PairingCodeState,
} from "./pairing-codes";
import { PAIRING_SNAPSHOT_VERSION, type PairingSnapshot } from "./pairing-snapshot";
import { setServerSyncConfig } from "./server-sync";
import { SETTING_KEYS } from "./settings";

export interface PairingCodeSummary {
  id: string;
  businessId: string;
  locationId: string;
  expiresAt: string;
  redeemedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  state: PairingCodeState;
}

interface CodeRow {
  id: string;
  business_id: string;
  location_id: string;
  expires_at: Date;
  redeemed_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
}

function toSummary(row: CodeRow, now: Date): PairingCodeSummary {
  return {
    id: row.id,
    businessId: row.business_id,
    locationId: row.location_id,
    expiresAt: row.expires_at.toISOString(),
    redeemedAt: row.redeemed_at?.toISOString() ?? null,
    revokedAt: row.revoked_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    state: pairingCodeState(
      { expiresAt: row.expires_at, redeemedAt: row.redeemed_at, revokedAt: row.revoked_at },
      now,
    ),
  };
}

/**
 * Issue a fresh code for a business, revoking whatever live code it already
 * had. The partial unique index enforces one-live-per-business, so revoking
 * first is not a nicety — it is what makes re-issuing possible at all.
 *
 * Runs under the caller's platform scope (the route wraps it in
 * `withPlatformScope`), so no extra bypass is taken here.
 */
export async function issuePairingCode(
  businessId: string,
  issuedBy: string,
): Promise<{ code: string; summary: PairingCodeSummary } | { error: "no_location" }> {
  const { rows: locationRows } = await query<{ id: string }>(
    `SELECT id FROM locations WHERE business_id = $1 AND is_active ORDER BY created_at LIMIT 1`,
    [businessId],
  );
  const locationId = locationRows[0]?.id;
  if (!locationId) return { error: "no_location" };

  const code = generatePairingCode();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE install_pairing_codes SET revoked_at = now()
        WHERE business_id = $1 AND redeemed_at IS NULL AND revoked_at IS NULL`,
      [businessId],
    );
    const { rows } = await client.query<CodeRow>(
      `INSERT INTO install_pairing_codes
         (business_id, location_id, code_hash, expires_at, issued_by)
       VALUES ($1, $2, $3, now() + ($4 || ' hours')::interval, $5)
       RETURNING id, business_id, location_id, expires_at, redeemed_at, revoked_at, created_at`,
      [businessId, locationId, hashPairingCode(code), String(PAIRING_CODE_TTL_HOURS), issuedBy],
    );
    await client.query("COMMIT");
    return { code, summary: toSummary(rows[0], new Date()) };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function listPairingCodes(businessId: string): Promise<PairingCodeSummary[]> {
  const { rows } = await query<CodeRow>(
    `SELECT id, business_id, location_id, expires_at, redeemed_at, revoked_at, created_at
       FROM install_pairing_codes
      WHERE business_id = $1
      ORDER BY created_at DESC
      LIMIT 20`,
    [businessId],
  );
  const now = new Date();
  return rows.map((row) => toSummary(row, now));
}

/** Revoke a still-live code. Returns false if there was nothing live to revoke. */
export async function revokePairingCode(businessId: string, codeId: string): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE install_pairing_codes SET revoked_at = now()
      WHERE id = $1 AND business_id = $2 AND redeemed_at IS NULL AND revoked_at IS NULL`,
    [codeId, businessId],
  );
  return (rowCount ?? 0) > 0;
}

export type RedeemResult =
  | { ok: true; snapshot: PairingSnapshot }
  | {
      ok: false;
      error: "code_not_found" | "code_expired" | "code_already_redeemed" | "code_revoked";
    };

/**
 * Trade a pairing code for a snapshot of its business.
 *
 * Bypassed (`pairing-redeem`): the code is a bearer-style credential and
 * resolving it to a business is exactly the "identify the tenant first"
 * problem login and server-sync-auth already have. The bypass covers the
 * lookup, the mark-as-redeemed, and the reads that build the snapshot — all
 * for the one business the code names.
 *
 * The code is marked redeemed in the same transaction as the lookup, under a
 * row lock, so two desktops racing the same code can never both get a
 * snapshot.
 */
export async function redeemPairingCode(
  rawCode: string,
  clientIp: string | null,
): Promise<RedeemResult> {
  return withoutTenantScope("pairing-redeem", async () => {
    const client = await getPool().connect();
    let businessId: string;
    let locationId: string;
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<CodeRow>(
        `SELECT id, business_id, location_id, expires_at, redeemed_at, revoked_at, created_at
           FROM install_pairing_codes WHERE code_hash = $1 FOR UPDATE`,
        [hashPairingCode(rawCode)],
      );
      const row = rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return { ok: false, error: "code_not_found" };
      }

      const state = pairingCodeState(
        { expiresAt: row.expires_at, redeemedAt: row.redeemed_at, revokedAt: row.revoked_at },
        new Date(),
      );
      if (state !== "valid") {
        await client.query("ROLLBACK");
        return { ok: false, error: state };
      }

      await client.query(
        `UPDATE install_pairing_codes SET redeemed_at = now(), redeemed_ip = $2 WHERE id = $1`,
        [row.id, clientIp],
      );
      await client.query("COMMIT");
      businessId = row.business_id;
      locationId = row.location_id;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    return { ok: true, snapshot: await buildPairingSnapshot(businessId, locationId) };
  });
}

/**
 * Read the business's configuration into a transportable snapshot.
 *
 * Deliberately excludes everything transactional (orders, ledger entries,
 * stock movements) and everything machine-specific (backup destinations,
 * rollup config, sync state). What is left is the configuration a till needs
 * to start selling.
 *
 * Must be called from inside a bypassed scope — `redeemPairingCode` provides
 * one; it is exported only so the integration test can exercise it directly.
 */
export async function buildPairingSnapshot(
  businessId: string,
  locationId: string,
): Promise<PairingSnapshot> {
  const [bizRes, locRes, userRes, assignRes, accountRes, catRes, itemRes, settingRes, features] =
    await Promise.all([
      query<{ id: string; name: string; slug: string; timezone: string }>(
        `SELECT id, name, slug::text AS slug, timezone FROM businesses WHERE id = $1`,
        [businessId],
      ),
      query<{
        id: string;
        name: string;
        address: string | null;
        phone: string | null;
        timezone: string;
      }>(`SELECT id, name, address, phone, timezone FROM locations WHERE id = $1`, [locationId]),
      query<{
        id: string;
        role: string;
        full_name: string;
        email: string | null;
        permissions: Record<string, unknown>;
        pin_hash: string | null;
        password_hash: string | null;
        pu_email: string | null;
        pu_full_name: string | null;
        pu_password_hash: string | null;
      }>(
        `SELECT u.id, u.role::text AS role, u.full_name, u.email::text AS email, u.permissions,
                u.pin_hash, u.password_hash,
                pu.email::text AS pu_email, pu.full_name AS pu_full_name,
                pu.password_hash AS pu_password_hash
           FROM users u
           LEFT JOIN platform_users pu ON pu.id = u.platform_user_id
          WHERE u.business_id = $1 AND u.is_active`,
        [businessId],
      ),
      query<{ user_id: string; location_id: string }>(
        `SELECT ul.user_id, ul.location_id
           FROM user_locations ul
           JOIN users u ON u.id = ul.user_id
          WHERE u.business_id = $1`,
        [businessId],
      ),
      query<{ id: string; parent_code: string | null; code: string; name: string; type: string }>(
        `SELECT a.id, p.code AS parent_code, a.code, a.name, a.type::text AS type
           FROM accounts a
           LEFT JOIN accounts p ON p.id = a.parent_id
          WHERE a.business_id = $1 AND a.is_active
          ORDER BY a.code`,
        [businessId],
      ),
      query<{ id: string; name: string; sort_order: number; is_active: boolean }>(
        `SELECT id, name, sort_order, is_active FROM menu_categories
          WHERE location_id = $1 ORDER BY sort_order, name`,
        [locationId],
      ),
      query<{
        id: string;
        category_id: string | null;
        name: string;
        description: string | null;
        sku: string | null;
        price: string;
        image_url: string | null;
        is_active: boolean;
        sort_order: number;
      }>(
        `SELECT id, category_id, name, description, sku, price, image_url, is_active, sort_order
           FROM menu_items WHERE location_id = $1 ORDER BY sort_order, name`,
        [locationId],
      ),
      query<{ key: string; value: unknown }>(
        `SELECT key, value FROM settings
          WHERE business_id = $1 AND location_id IS NULL AND key = ANY($2::text[])`,
        [businessId, SNAPSHOT_SETTING_KEYS],
      ),
      effectiveFeatures(businessId),
    ]);

  const locationsByUser = new Map<string, string[]>();
  for (const row of assignRes.rows) {
    const list = locationsByUser.get(row.user_id) ?? [];
    list.push(row.location_id);
    locationsByUser.set(row.user_id, list);
  }

  // Minted here rather than reused: the local install needs a token it can
  // present to this server, and the plaintext of any existing one is
  // unrecoverable (only the hash is stored). Writing it through
  // setServerSyncConfig replaces the business's server_sync_tokens row, which
  // is correct — one paired laptop per business is the model.
  const syncToken = randomBytes(32).toString("hex");
  const existingSync = await query<{ value: { remoteUrl?: string; batchSize?: number } }>(
    `SELECT value FROM settings
      WHERE business_id = $1 AND location_id IS NULL AND key = $2`,
    [businessId, SETTING_KEYS.serverSyncConfig],
  );
  await setServerSyncConfig(businessId, {
    remoteUrl: existingSync.rows[0]?.value?.remoteUrl ?? "",
    token: syncToken,
    enabled: false,
    batchSize: existingSync.rows[0]?.value?.batchSize ?? 100,
  });

  return {
    version: PAIRING_SNAPSHOT_VERSION,
    business: bizRes.rows[0],
    location: locRes.rows[0],
    users: userRes.rows.map((u) => ({
      id: u.id,
      role: u.role,
      fullName: u.full_name,
      email: u.email,
      permissions: u.permissions ?? {},
      pinHash: u.pin_hash,
      passwordHash: u.password_hash,
      platformUserEmail: u.pu_email,
      platformUserFullName: u.pu_full_name,
      platformUserPasswordHash: u.pu_password_hash,
      locationIds: locationsByUser.get(u.id) ?? [],
    })),
    accounts: accountRes.rows.map((a) => ({
      id: a.id,
      parentCode: a.parent_code,
      code: a.code,
      name: a.name,
      type: a.type,
    })),
    menu: {
      categories: catRes.rows.map((c) => ({
        id: c.id,
        name: c.name,
        sortOrder: c.sort_order,
        isActive: c.is_active,
      })),
      items: itemRes.rows.map((i) => ({
        id: i.id,
        categoryId: i.category_id,
        name: i.name,
        description: i.description,
        sku: i.sku,
        // bigint comes back as a string from node-postgres; money is integer
        // Rial and always well within Number.MAX_SAFE_INTEGER.
        price: Number(i.price),
        imageUrl: i.image_url,
        isActive: i.is_active,
        sortOrder: i.sort_order,
      })),
    },
    settings: settingRes.rows.map((s) => ({ key: s.key, value: s.value })),
    features,
    syncToken,
  };
}

/**
 * The settings a till needs to operate, and nothing else. Backup destinations
 * and rollup/sync targets are machine-specific, and wizard progress is
 * recomputed on the local side (see applyPairingSnapshot), so none of them
 * travel.
 */
const SNAPSHOT_SETTING_KEYS = [
  SETTING_KEYS.businessPrefs,
  SETTING_KEYS.businessProfile,
  SETTING_KEYS.costing,
  SETTING_KEYS.tax,
  SETTING_KEYS.pricing,
];
```

- [ ] **Step 3: Type check**

Run: `npx tsc --noEmit`
Expected: no errors. (`SNAPSHOT_SETTING_KEYS` is a `const` declared after use inside a function body — that is fine at runtime because `buildPairingSnapshot` is only ever called after module evaluation.)

- [ ] **Step 4: Commit**

```bash
npm test
git add src/lib/pairing-service.ts src/lib/db.ts
git commit -m "feat: pairing service — issue, list, revoke, redeem, build snapshot"
```

---

### Task 6: Applying a snapshot on the local install

**Files:**
- Create: `src/lib/pairing-apply.ts`
- Test: `integration/pairing.integration.test.ts` in Task 7

**Interfaces:**
- Consumes: `PairingSnapshot` from `./pairing-snapshot`; `getPool`, `withoutTenantScope` from `./db`; `SETTING_KEYS` from `./settings`.
- Produces:
  - `interface AppliedSnapshot { businessId: string; businessSlug: string; locationId: string; ownerUserId: string; ownerName: string; ownerPlatformUserId: string | null }`
  - `async function applyPairingSnapshot(snapshot: PairingSnapshot, remoteUrl: string): Promise<AppliedSnapshot>`

---

- [ ] **Step 1: Write the implementation**

Create `src/lib/pairing-apply.ts`:

```ts
/**
 * The local install's half of desktop pairing: replay a PairingSnapshot into
 * an empty database.
 *
 * Bypassed (`platform`) throughout for the same reason `provisionBusiness` is:
 * it creates the tenant that scoping would otherwise require to already
 * exist. One transaction, so a partial pairing is impossible — either the
 * whole business lands or the database stays empty and the owner can retry
 * with a fresh code.
 *
 * Every id is inserted verbatim from the snapshot. That is the point: the
 * laptop and the server share a business_id, location_id and user ids, which
 * is what makes Phase 11's sync_events replay in both directions afterwards.
 *
 * DB-touching, so per repo convention no direct unit test — see
 * integration/pairing.integration.test.ts.
 */
import type { PoolClient } from "pg";
import { getPool, withoutTenantScope } from "./db";
import type { PairingSnapshot } from "./pairing-snapshot";
import { SETTING_KEYS } from "./settings";

export interface AppliedSnapshot {
  businessId: string;
  businessSlug: string;
  locationId: string;
  ownerUserId: string;
  ownerName: string;
  ownerPlatformUserId: string | null;
}

export async function applyPairingSnapshot(
  snapshot: PairingSnapshot,
  remoteUrl: string,
): Promise<AppliedSnapshot> {
  return withoutTenantScope("platform", async () => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");

      await client.query(
        `INSERT INTO businesses (id, name, slug, timezone) VALUES ($1, $2, $3, $4)`,
        [snapshot.business.id, snapshot.business.name, snapshot.business.slug, snapshot.business.timezone],
      );

      await client.query(
        `INSERT INTO locations (id, business_id, name, address, phone, timezone)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          snapshot.location.id,
          snapshot.business.id,
          snapshot.location.name,
          snapshot.location.address,
          snapshot.location.phone,
          snapshot.location.timezone,
        ],
      );

      const ownerIds = await insertUsers(client, snapshot);
      await insertAccounts(client, snapshot);
      await insertMenu(client, snapshot);
      await insertSettings(client, snapshot, remoteUrl);
      await insertFeatures(client, snapshot);

      await client.query("COMMIT");
      return {
        businessId: snapshot.business.id,
        businessSlug: snapshot.business.slug,
        locationId: snapshot.location.id,
        ...ownerIds,
      };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });
}

/**
 * Recreate memberships and, where one existed online, the global identity
 * behind them — so the owner signs in on the laptop with the same email and
 * password they use on the platform. Credential hashes are inserted as-is;
 * no plaintext ever crossed the wire.
 */
async function insertUsers(
  client: PoolClient,
  snapshot: PairingSnapshot,
): Promise<{ ownerUserId: string; ownerName: string; ownerPlatformUserId: string | null }> {
  let ownerUserId = "";
  let ownerName = "";
  let ownerPlatformUserId: string | null = null;

  for (const user of snapshot.users) {
    let platformUserId: string | null = null;
    if (user.platformUserEmail && user.platformUserPasswordHash) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO platform_users (email, password_hash, full_name)
         VALUES ($1, $2, $3)
         ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name
         RETURNING id`,
        [user.platformUserEmail, user.platformUserPasswordHash, user.platformUserFullName ?? user.fullName],
      );
      platformUserId = rows[0].id;
    }

    await client.query(
      `INSERT INTO users
         (id, business_id, platform_user_id, location_id, role, full_name, email,
          password_hash, pin_hash, permissions)
       VALUES ($1, $2, $3, NULL, $4::user_role, $5, $6, $7, $8, $9)`,
      [
        user.id,
        snapshot.business.id,
        platformUserId,
        user.role,
        user.fullName,
        user.email,
        user.passwordHash,
        user.pinHash,
        JSON.stringify(user.permissions ?? {}),
      ],
    );

    // Only assignments naming the branch this install actually holds; a
    // multi-branch business pairs one laptop per branch.
    for (const locationId of user.locationIds) {
      if (locationId !== snapshot.location.id) continue;
      await client.query(
        `INSERT INTO user_locations (user_id, location_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [user.id, locationId],
      );
    }

    if (user.role === "owner" && !ownerUserId) {
      ownerUserId = user.id;
      ownerName = user.fullName;
      ownerPlatformUserId = platformUserId;
    }
  }

  return { ownerUserId, ownerName, ownerPlatformUserId };
}

/** Parents before children, resolving parent_id from a code→id map built as we go. */
async function insertAccounts(client: PoolClient, snapshot: PairingSnapshot): Promise<void> {
  const idByCode = new Map<string, string>();
  const pending = [...snapshot.accounts];
  let guard = pending.length + 1;
  while (pending.length > 0 && guard > 0) {
    guard -= 1;
    const ready = pending.filter((a) => !a.parentCode || idByCode.has(a.parentCode));
    // A snapshot whose parent chain can't be resolved (a cycle, or a parent
    // that was inactive and so never travelled) would loop forever; treat the
    // remaining rows as roots rather than hanging the pairing.
    const batch = ready.length > 0 ? ready : [...pending];
    for (const account of batch) {
      await client.query(
        `INSERT INTO accounts (id, business_id, parent_id, code, name, type)
         VALUES ($1, $2, $3, $4, $5, $6::account_type)`,
        [
          account.id,
          snapshot.business.id,
          account.parentCode ? (idByCode.get(account.parentCode) ?? null) : null,
          account.code,
          account.name,
          account.type,
        ],
      );
      idByCode.set(account.code, account.id);
      pending.splice(pending.indexOf(account), 1);
    }
  }
}

async function insertMenu(client: PoolClient, snapshot: PairingSnapshot): Promise<void> {
  for (const category of snapshot.menu.categories) {
    await client.query(
      `INSERT INTO menu_categories (id, location_id, name, sort_order, is_active)
       VALUES ($1, $2, $3, $4, $5)`,
      [category.id, snapshot.location.id, category.name, category.sortOrder, category.isActive],
    );
  }
  for (const item of snapshot.menu.items) {
    await client.query(
      `INSERT INTO menu_items
         (id, location_id, category_id, name, description, sku, price, image_url, is_active, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        item.id,
        snapshot.location.id,
        item.categoryId,
        item.name,
        item.description,
        item.sku,
        item.price,
        item.imageUrl,
        item.isActive,
        item.sortOrder,
      ],
    );
  }
}

/**
 * The snapshot's own settings, plus three this side owns:
 *
 *   - deployment.mode      — 'connected', stamped with the pairing time
 *   - server_sync.config   — the token the snapshot delivered, pointed at the
 *                            server that issued it, left disabled so the owner
 *                            turns sync on deliberately
 *   - setup.progress       — marked complete, because the configuration this
 *                            wizard would have collected is exactly what just
 *                            arrived
 */
async function insertSettings(
  client: PoolClient,
  snapshot: PairingSnapshot,
  remoteUrl: string,
): Promise<void> {
  const pairedAt = new Date().toISOString();

  for (const setting of snapshot.settings) {
    await client.query(
      `INSERT INTO settings (business_id, location_id, key, value) VALUES ($1, NULL, $2, $3)
       ON CONFLICT (business_id, location_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [snapshot.business.id, setting.key, JSON.stringify(setting.value)],
    );
  }

  const owned: Array<[string, unknown]> = [
    [SETTING_KEYS.deploymentMode, { mode: "connected", pairedAt }],
    [
      SETTING_KEYS.serverSyncConfig,
      { remoteUrl, token: snapshot.syncToken, enabled: false, batchSize: 100 },
    ],
    [SETTING_KEYS.wizardProgress, { steps: { paired: pairedAt }, completedAt: pairedAt }],
  ];
  for (const [key, value] of owned) {
    await client.query(
      `INSERT INTO settings (business_id, location_id, key, value) VALUES ($1, NULL, $2, $3)
       ON CONFLICT (business_id, location_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [snapshot.business.id, key, JSON.stringify(value)],
    );
  }

  // The bearer token this install will present to the server. Stored hashed,
  // exactly as setServerSyncConfig would — inlined here because that helper
  // runs its own query() outside this transaction, and a half-applied pairing
  // must be impossible.
  const { createHash } = await import("node:crypto");
  await client.query(
    `INSERT INTO server_sync_tokens (business_id, token_hash, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (business_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, updated_at = now()`,
    [snapshot.business.id, createHash("sha256").update(snapshot.syncToken).digest("hex")],
  );
}

/**
 * Pin every flag the snapshot reported, so the laptop shows exactly what the
 * online business shows. Written as overrides rather than trusting local
 * defaults, because the two sides' catalogue defaults could diverge across
 * versions.
 */
async function insertFeatures(client: PoolClient, snapshot: PairingSnapshot): Promise<void> {
  for (const [flagKey, enabled] of Object.entries(snapshot.features)) {
    await client.query(
      `INSERT INTO business_features (business_id, flag_key, enabled)
       SELECT $1, $2, $3
        WHERE EXISTS (SELECT 1 FROM feature_flags WHERE key = $2)
       ON CONFLICT (business_id, flag_key) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
      [snapshot.business.id, flagKey, enabled],
    );
  }
}
```

- [ ] **Step 2: Confirm the sync-token hash matches what the server computes**

`src/lib/server-sync.ts`'s private `hashSyncToken` is `createHash("sha256").update(token).digest("hex")`. Read it and confirm the inline hash above is byte-identical:

Run: `grep -n "function hashSyncToken" -A 3 src/lib/server-sync.ts`
Expected: the same sha-256 hex of the raw token, no salt or prefix.

- [ ] **Step 3: Type check and commit**

```bash
npx tsc --noEmit
npm test
git add src/lib/pairing-apply.ts
git commit -m "feat: apply a pairing snapshot into an empty local database"
```

---

### Task 7: Integration test for the whole pairing round trip

**Files:**
- Create: `integration/pairing.integration.test.ts`

**Interfaces:**
- Consumes: `issuePairingCode`, `listPairingCodes`, `revokePairingCode`, `redeemPairingCode` from `../src/lib/pairing-service`; `applyPairingSnapshot` from `../src/lib/pairing-apply`; `validateSnapshot` from `../src/lib/pairing-snapshot`; `provisionBusiness` from `../src/lib/business-provisioning`; `withTenant`, `withoutTenantScope`, `getPool` from `../src/lib/db`.
- Produces: nothing consumed by later tasks.

---

- [ ] **Step 1: Write the test**

Create `integration/pairing.integration.test.ts`:

```ts
/**
 * Desktop first-run pairing, end to end against a real database.
 *
 * The online and local halves both run here — the "online" business is
 * provisioned and issues a code; redeeming it produces a snapshot; applying
 * that snapshot into a *second* database is the laptop. Two databases is what
 * makes the id-preservation claim testable: the same uuids must land on both
 * sides.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let serverDb: string;
let localDb: string;

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

function maintenanceUrl(): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = "/postgres";
  return url.toString();
}

async function createDatabase(name: string): Promise<void> {
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${name}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(name), quiet: true });
}

async function dropDatabase(name: string): Promise<void> {
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
}

/**
 * Each half needs its own module registry, because src/lib/db.ts caches a
 * single pool keyed off DATABASE_URL at import time. vi.resetModules between
 * the two imports gives us two independent pools.
 */
async function loadLibs(databaseUrl: string) {
  const { default: vitest } = await import("vitest");
  void vitest;
  process.env.DATABASE_URL = databaseUrl;
  const { resetModules } = await import("vitest");
  void resetModules;
  return {
    db: await import(`../src/lib/db?${encodeURIComponent(databaseUrl)}`),
  };
}

beforeAll(async () => {
  serverDb = `pos_pair_srv_${randomUUID().replaceAll("-", "")}`;
  localDb = `pos_pair_loc_${randomUUID().replaceAll("-", "")}`;
  await createDatabase(serverDb);
  await createDatabase(localDb);
}, 180_000);

afterAll(async () => {
  process.env.DATABASE_URL = rootDatabaseUrl;
  await dropDatabase(serverDb);
  await dropDatabase(localDb);
});

describe("pairing round trip", () => {
  it("issues a code, redeems it once, and replays the business onto a second database", async () => {
    // ---- online side -------------------------------------------------------
    process.env.DATABASE_URL = urlFor(serverDb);
    const serverDbLib = await import("../src/lib/db");
    const { provisionBusiness } = await import("../src/lib/business-provisioning");
    const { issuePairingCode, redeemPairingCode, listPairingCodes } = await import(
      "../src/lib/pairing-service"
    );

    const created = await provisionBusiness({
      businessName: "کافه بهار",
      ownerName: "حمید",
      email: `owner-${randomUUID()}@example.com`,
      password: "correct-horse",
      seedChartOfAccounts: true,
    });

    // A menu item, so the snapshot carries something beyond the skeleton.
    await serverDbLib.withTenant(created.businessId, async () => {
      const { rows } = await serverDbLib.query<{ id: string }>(
        `INSERT INTO menu_categories (location_id, name, sort_order) VALUES ($1, $2, 0) RETURNING id`,
        [created.locationId, "نوشیدنی گرم"],
      );
      await serverDbLib.query(
        `INSERT INTO menu_items (location_id, category_id, name, price) VALUES ($1, $2, $3, $4)`,
        [created.locationId, rows[0].id, "اسپرسو", 850_000],
      );
    });

    const platformAdminId = await serverDbLib.withoutTenantScope("platform", async () => {
      const { rows } = await serverDbLib.query<{ id: string }>(
        `INSERT INTO platform_users (email, password_hash, full_name)
         VALUES ($1, 'x', 'operator') RETURNING id`,
        [`admin-${randomUUID()}@example.com`],
      );
      return rows[0].id;
    });

    const issued = await serverDbLib.withoutTenantScope("platform", () =>
      issuePairingCode(created.businessId, platformAdminId),
    );
    expect("code" in issued).toBe(true);
    if (!("code" in issued)) return;
    expect(issued.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    const redeemed = await redeemPairingCode(issued.code, "127.0.0.1");
    expect(redeemed.ok).toBe(true);
    if (!redeemed.ok) return;

    const { validateSnapshot } = await import("../src/lib/pairing-snapshot");
    const validation = validateSnapshot(JSON.parse(JSON.stringify(redeemed.snapshot)));
    expect(validation).toMatchObject({ ok: true });

    // The same code cannot be redeemed twice.
    const second = await redeemPairingCode(issued.code, "127.0.0.1");
    expect(second).toEqual({ ok: false, error: "code_already_redeemed" });

    const summaries = await serverDbLib.withoutTenantScope("platform", () =>
      listPairingCodes(created.businessId),
    );
    expect(summaries[0].state).toBe("code_already_redeemed");

    const snapshot = redeemed.snapshot;
    await serverDbLib.getPool().end();

    // ---- local side --------------------------------------------------------
    process.env.DATABASE_URL = urlFor(localDb);
    const localDbLib = await import(`../src/lib/db?local`);
    const { applyPairingSnapshot } = await import(`../src/lib/pairing-apply?local`);

    const applied = await applyPairingSnapshot(snapshot, "https://pos.example.com");
    expect(applied.businessId).toBe(created.businessId);
    expect(applied.locationId).toBe(created.locationId);
    expect(applied.ownerUserId).toBe(created.userId);

    await localDbLib.withTenant(applied.businessId, async () => {
      const items = await localDbLib.query<{ name: string; price: string }>(
        `SELECT name, price FROM menu_items`,
      );
      expect(items.rows).toHaveLength(1);
      expect(items.rows[0].name).toBe("اسپرسو");
      expect(Number(items.rows[0].price)).toBe(850_000);

      const accounts = await localDbLib.query<{ n: string }>(
        `SELECT count(*) AS n FROM accounts WHERE business_id = $1`,
        [applied.businessId],
      );
      expect(Number(accounts.rows[0].n)).toBeGreaterThan(0);

      const mode = await localDbLib.query<{ value: { mode: string; pairedAt: string } }>(
        `SELECT value FROM settings WHERE business_id = $1 AND key = 'deployment.mode'`,
        [applied.businessId],
      );
      expect(mode.rows[0].value.mode).toBe("connected");
      expect(typeof mode.rows[0].value.pairedAt).toBe("string");

      const progress = await localDbLib.query<{ value: { completedAt: string | null } }>(
        `SELECT value FROM settings WHERE business_id = $1 AND key = 'setup.progress'`,
        [applied.businessId],
      );
      expect(progress.rows[0].value.completedAt).toBeTruthy();

      const syncTokens = await localDbLib.query<{ n: string }>(
        `SELECT count(*) AS n FROM server_sync_tokens WHERE business_id = $1`,
        [applied.businessId],
      );
      expect(Number(syncTokens.rows[0].n)).toBe(1);
    });

    await localDbLib.getPool().end();
  }, 120_000);
});

describe("pairing code lifecycle", () => {
  it("refuses an unknown code and a revoked code", async () => {
    process.env.DATABASE_URL = urlFor(serverDb);
    const dbLib = await import(`../src/lib/db?lifecycle`);
    const { provisionBusiness } = await import(`../src/lib/business-provisioning?lifecycle`);
    const { issuePairingCode, revokePairingCode, redeemPairingCode } = await import(
      `../src/lib/pairing-service?lifecycle`
    );

    const created = await provisionBusiness({
      businessName: "کافه دوم",
      ownerName: "سارا",
      email: `owner2-${randomUUID()}@example.com`,
      password: "correct-horse",
    });

    expect(await redeemPairingCode("ZZZZ-ZZZZ-ZZZZ", null)).toEqual({
      ok: false,
      error: "code_not_found",
    });

    const adminId = await dbLib.withoutTenantScope("platform", async () => {
      const { rows } = await dbLib.query<{ id: string }>(
        `INSERT INTO platform_users (email, password_hash, full_name)
         VALUES ($1, 'x', 'operator') RETURNING id`,
        [`admin2-${randomUUID()}@example.com`],
      );
      return rows[0].id;
    });

    const issued = await dbLib.withoutTenantScope("platform", () =>
      issuePairingCode(created.businessId, adminId),
    );
    if (!("code" in issued)) throw new Error("expected a code");

    const revoked = await dbLib.withoutTenantScope("platform", () =>
      revokePairingCode(created.businessId, issued.summary.id),
    );
    expect(revoked).toBe(true);
    expect(await redeemPairingCode(issued.code, null)).toEqual({ ok: false, error: "code_revoked" });

    // Re-issuing replaces rather than accumulates: the partial unique index
    // allows only one live code, so this must succeed.
    const reissued = await dbLib.withoutTenantScope("platform", () =>
      issuePairingCode(created.businessId, adminId),
    );
    expect("code" in reissued).toBe(true);

    await dbLib.getPool().end();
  }, 120_000);
});
```

- [ ] **Step 2: Simplify the module-loading helper**

Delete the unused `loadLibs` function from the test file — the per-`describe` dynamic imports with query-string cache busters are what actually give each half its own pool. The file should have no reference to `loadLibs` after this step.

- [ ] **Step 3: Run the test**

Run: `npm run test:db -- integration/pairing.integration.test.ts`
Expected: PASS — 2 tests.

If the query-string import trick (`../src/lib/db?local`) does not produce a fresh module instance under the repo's vitest version, replace it with `vi.resetModules()` before each dynamic import block and drop the query strings:

```ts
import { vi } from "vitest";
// ...
vi.resetModules();
process.env.DATABASE_URL = urlFor(localDb);
const localDbLib = await import("../src/lib/db");
```

- [ ] **Step 4: Run the whole integration suite to prove nothing regressed**

Run: `npm run test:db`
Expected: PASS, including `tenant-isolation.integration.test.ts` (which sees the new table).

- [ ] **Step 5: Commit**

```bash
git add integration/pairing.integration.test.ts
git commit -m "test: end-to-end pairing round trip across two databases"
```

---

### Task 8: Platform API routes for pairing

**Files:**
- Create: `src/app/api/platform/pairing/route.ts`
- Create: `src/app/api/platform/pairing/redeem/route.ts`
- Modify: `src/middleware.ts` (`PLATFORM_PUBLIC_PATHS`, around line 57)

**Interfaces:**
- Consumes: `issuePairingCode`, `listPairingCodes`, `revokePairingCode`, `redeemPairingCode`, `type PairingCodeSummary` from `@/lib/pairing-service`; `requirePlatformCapability`, `withPlatformScope`, `platformAudit` from `@/lib/platform-auth`; `getBusiness` from `@/lib/platform-service`.
- Produces:
  - `GET /api/platform/pairing?businessId=<uuid>` → `{ codes: PairingCodeSummary[] }`
  - `POST /api/platform/pairing` body `{ businessId }` → `{ code: string; summary: PairingCodeSummary }`
  - `DELETE /api/platform/pairing` body `{ businessId, codeId }` → `{ ok: true }`
  - `POST /api/platform/pairing/redeem` body `{ code }` → `{ snapshot: PairingSnapshot }` or `{ error }` with 404/410/409

---

- [ ] **Step 0: Confirm the business-lookup helper's name**

Run: `grep -n "^export async function\|^export function" src/lib/platform-service.ts`

Expected: a function that fetches one business by id. The routes below call it `getBusiness(id)` and treat a falsy return as "not found". If the real name differs (e.g. `getBusinessDetail`, `businessById`), use the real one and keep the same falsy-means-404 handling. If no such helper exists, replace the two `getBusiness(...)` guards with an inline check:

```ts
const { rows } = await query<{ id: string }>(`SELECT id FROM businesses WHERE id = $1`, [businessId]);
if (rows.length === 0) return NextResponse.json({ error: "not_found" }, { status: 404 });
```

(importing `query` from `@/lib/db` — this runs inside `withPlatformScope`, so it is already bypassed).

- [ ] **Step 1: Write the console route**

Create `src/app/api/platform/pairing/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import {
  platformAudit,
  requirePlatformCapability,
  withPlatformScope,
} from "@/lib/platform-auth";
import { getBusiness } from "@/lib/platform-service";
import { issuePairingCode, listPairingCodes, revokePairingCode } from "@/lib/pairing-service";

/**
 * Desktop pairing codes for one business.
 *
 * Guarded on `business.provision` (owner-only) rather than a read capability
 * even for the list: a code's existence and expiry are operational secrets,
 * and the only reason to look at the list is to decide whether to issue or
 * revoke one.
 */
export const GET = withPlatformScope(async (request: NextRequest) => {
  const { error } = await requirePlatformCapability("business.provision");
  if (error) return error;

  const businessId = request.nextUrl.searchParams.get("businessId");
  if (!businessId) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  if (!(await getBusiness(businessId))) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  return NextResponse.json({ codes: await listPairingCodes(businessId) });
});

/** Issue a code. The plaintext is in this response and nowhere else, ever again. */
export const POST = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("business.provision");
  if (error) return error;

  let body: { businessId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const businessId = body.businessId?.trim();
  if (!businessId) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  if (!(await getBusiness(businessId))) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const issued = await issuePairingCode(businessId, session.padmin);
  if ("error" in issued) {
    return NextResponse.json({ error: issued.error }, { status: 409 });
  }

  await platformAudit({
    adminId: session.padmin,
    businessId,
    action: "pairing.issue",
    entity: "install_pairing_code",
    entityId: issued.summary.id,
    // Deliberately no code, not even a prefix: the audit log is readable by
    // every admin, and the plaintext is a credential.
    payload: { expiresAt: issued.summary.expiresAt },
  });

  return NextResponse.json({ code: issued.code, summary: issued.summary });
});

export const DELETE = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("business.provision");
  if (error) return error;

  let body: { businessId?: string; codeId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const businessId = body.businessId?.trim();
  const codeId = body.codeId?.trim();
  if (!businessId || !codeId) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  const revoked = await revokePairingCode(businessId, codeId);
  if (!revoked) return NextResponse.json({ error: "not_found" }, { status: 404 });

  await platformAudit({
    adminId: session.padmin,
    businessId,
    action: "pairing.revoke",
    entity: "install_pairing_code",
    entityId: codeId,
  });

  return NextResponse.json({ ok: true });
});
```

- [ ] **Step 2: Write the redeem route**

Create `src/app/api/platform/pairing/redeem/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { redeemPairingCode } from "@/lib/pairing-service";

/**
 * Trade a pairing code for a business snapshot.
 *
 * Public by necessity: the caller is a freshly-installed desktop app with no
 * session in either realm, and the code *is* the credential — the same shape
 * as /api/auth/accept-invite and the server-sync bearer routes. It lives under
 * /api/platform because the issuing side is the platform console, not because
 * it needs a platform session.
 *
 * The response carries the business's whole configuration including credential
 * hashes, so it must never be cached or logged.
 */
export async function POST(request: NextRequest) {
  let body: { code?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const code = body.code?.trim();
  if (!code) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  const forwarded = request.headers.get("x-forwarded-for");
  const clientIp = forwarded ? forwarded.split(",")[0].trim() : request.headers.get("x-real-ip");

  const result = await redeemPairingCode(code, clientIp);
  if (!result.ok) {
    const status = {
      code_not_found: 404,
      code_expired: 410,
      code_already_redeemed: 409,
      code_revoked: 410,
    }[result.error];
    return NextResponse.json({ error: result.error }, { status });
  }

  const response = NextResponse.json({ snapshot: result.snapshot });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
```

- [ ] **Step 3: Make the redeem route reachable**

In `src/middleware.ts`, extend `PLATFORM_PUBLIC_PATHS`:

```ts
const PLATFORM_PUBLIC_PATHS = [
  "/platform/login",
  "/api/platform/auth/login",
  "/api/platform/auth/logout",
  "/api/platform/auth/me",
  // Desktop pairing: the caller is a freshly-installed app with no session in
  // either realm, and the one-time code in the body is the credential — the
  // same shape as accept-invite. The handler resolves it or refuses.
  "/api/platform/pairing/redeem",
];
```

Note: this entry is redundant with the `pathname.startsWith("/api/platform")` pass-through immediately below it, which already lets every platform API route self-guard. It is listed anyway so the file states the intent explicitly rather than relying on that branch's continued existence.

- [ ] **Step 4: Rate-limit the redeem route against code guessing**

Also in `src/middleware.ts`, **append** two entries to `AUTH_RATE_LIMITED_PATHS` — insert after the existing `"/api/platform/auth/login",` line, leaving every existing entry and its comments intact:

```ts
  // A pairing code is a 12-character credential submitted without a session,
  // and /api/setup/pair forwards one; both belong in the same per-IP bucket as
  // every other credential exchange rather than going unlimited.
  "/api/platform/pairing/redeem",
  "/api/setup/pair",
```

Note `AUTH_RATE_LIMITED_PATHS` is matched with `.includes(pathname)` — exact equality — so both entries must be the full paths above, not prefixes.

- [ ] **Step 5: Type check and build**

```bash
npx tsc --noEmit
npm run build
```
Expected: both clean. The build proves the new route files are valid App Router modules.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/platform/pairing src/middleware.ts
git commit -m "feat: platform API for issuing, revoking and redeeming pairing codes"
```

---

### Task 9: The local pairing route

**Files:**
- Create: `src/app/api/setup/pair/route.ts`
- Modify: `src/middleware.ts` (`PUBLIC_PATHS`, around line 23)

**Interfaces:**
- Consumes: `validateSnapshot` from `@/lib/pairing-snapshot`; `applyPairingSnapshot` from `@/lib/pairing-apply`; `hasAnyUser` from `@/lib/setup-state`; `signSession`, `SESSION_COOKIE`, `sessionCookieOptions` from `@/lib/auth`.
- Produces: `POST /api/setup/pair` body `{ remoteUrl, code }` → `{ ok: true; slug: string }`, or `{ error }` with one of `already_initialized` (409), `missing_fields` (400), `invalid_url` (400), `remote_unreachable` (502), `snapshot_invalid` (502), or the four `code_*` codes passed through from the remote with their status.

---

- [ ] **Step 1: Write the route**

Create `src/app/api/setup/pair/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, sessionCookieOptions, signSession } from "@/lib/auth";
import { applyPairingSnapshot } from "@/lib/pairing-apply";
import { validateSnapshot } from "@/lib/pairing-snapshot";
import { hasAnyUser } from "@/lib/setup-state";

/** How long to wait on the online server before calling it unreachable. */
const REDEEM_TIMEOUT_MS = 30_000;

const PASSTHROUGH_ERRORS = new Set([
  "code_not_found",
  "code_expired",
  "code_already_redeemed",
  "code_revoked",
]);

/**
 * First-run pairing: claim an existing online business on this install.
 *
 * Public for the same reason /api/setup/bootstrap is — the database is empty,
 * so there is no session to require and no tenant to scope to. It refuses the
 * moment any user exists, which is what stops it being a way to overwrite a
 * working install.
 *
 * Everything happens server-side rather than in the browser: the snapshot
 * carries credential hashes, and routing it through the browser would put them
 * in a place they have no business being.
 */
export async function POST(request: NextRequest) {
  if (await hasAnyUser()) {
    return NextResponse.json({ error: "already_initialized" }, { status: 409 });
  }

  let body: { remoteUrl?: string; code?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const remoteUrl = body.remoteUrl?.trim().replace(/\/+$/, "") ?? "";
  const code = body.code?.trim() ?? "";
  if (!remoteUrl || !code) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  if (!/^https?:\/\/.+/.test(remoteUrl)) {
    return NextResponse.json({ error: "invalid_url" }, { status: 400 });
  }

  let remoteResponse: Response;
  try {
    remoteResponse = await fetch(`${remoteUrl}/api/platform/pairing/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
      signal: AbortSignal.timeout(REDEEM_TIMEOUT_MS),
    });
  } catch {
    return NextResponse.json({ error: "remote_unreachable" }, { status: 502 });
  }

  const payload = (await remoteResponse.json().catch(() => ({}))) as {
    snapshot?: unknown;
    error?: string;
  };

  if (!remoteResponse.ok) {
    if (payload.error && PASSTHROUGH_ERRORS.has(payload.error)) {
      return NextResponse.json({ error: payload.error }, { status: remoteResponse.status });
    }
    return NextResponse.json({ error: "remote_unreachable" }, { status: 502 });
  }

  const validation = validateSnapshot(payload.snapshot);
  if (!validation.ok) {
    return NextResponse.json({ error: "snapshot_invalid" }, { status: 502 });
  }

  // Re-checked immediately before the write: the hasAnyUser() at the top is a
  // fast rejection, but the redeem round trip above takes seconds, and
  // applying into a non-empty database would violate the primary keys the
  // snapshot carries.
  if (await hasAnyUser()) {
    return NextResponse.json({ error: "already_initialized" }, { status: 409 });
  }

  const applied = await applyPairingSnapshot(validation.snapshot, remoteUrl);

  const token = await signSession({
    sub: applied.ownerUserId,
    role: "owner",
    businessId: applied.businessId,
    businessSlug: applied.businessSlug,
    locationId: null,
    fullName: applied.ownerName,
    platformUserId: applied.ownerPlatformUserId,
  });
  const response = NextResponse.json({ ok: true, slug: applied.businessSlug });
  response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
  return response;
}
```

- [ ] **Step 2: Confirm the `signSession` payload shape matches**

Run: `grep -n "export async function signSession" -A 14 src/lib/auth.ts`
Expected: a payload accepting `sub`, `role`, `businessId`, `businessSlug`, `locationId`, `fullName`, `platformUserId` — the same fields `src/app/api/setup/bootstrap/route.ts:48-56` passes. If `platformUserId` is typed as `string` rather than `string | null`, pass `applied.ownerPlatformUserId ?? undefined`.

- [ ] **Step 3: Make the route reachable**

In `src/middleware.ts`, extend `PUBLIC_PATHS` right after `"/api/setup/state",`:

```ts
  // Desktop first-run pairing: like bootstrap, it runs against an empty
  // database, so there is no session to require. The one-time code in the body
  // is the credential, and the route refuses once any user exists.
  "/api/setup/pair",
```

- [ ] **Step 4: Type check and build**

```bash
npx tsc --noEmit
npm run build
```
Expected: both clean.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/setup/pair src/middleware.ts
git commit -m "feat: local first-run pairing route redeems a code and seeds the install"
```

---

### Task 10: The three-state welcome wizard

**Files:**
- Create: `src/app/welcome/mode-choice.tsx`
- Create: `src/app/welcome/pair-form.tsx`
- Modify: `src/app/welcome/page.tsx` (whole file)

**Interfaces:**
- Consumes: `POST /api/setup/bootstrap` with `{ businessName, locationName, ownerName, email, password, deploymentMode: "local" }`; `POST /api/setup/pair` with `{ remoteUrl, code }`.
- Produces: nothing consumed by later tasks.

---

- [ ] **Step 1: Write the mode-choice screen**

Create `src/app/welcome/mode-choice.tsx`:

```tsx
"use client";

/**
 * First screen of the desktop first-run wizard: local-only, or claim an
 * existing online business.
 *
 * Two cards rather than a dropdown, because this is a decision the owner makes
 * once and cannot change afterwards — it deserves the space to say what each
 * option costs.
 */
export function ModeChoice({ onChoose }: { onChoose: (mode: "local" | "connect") => void }) {
  return (
    <div className="w-full max-w-3xl">
      <h1 className="mb-1 text-2xl font-bold">به سیستم فروش خوش آمدید</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        این نصب را چگونه راه‌اندازی می‌کنید؟
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => onChoose("local")}
          className="rounded-2xl border border-input bg-card p-6 text-start shadow-sm transition hover:border-primary hover:shadow-md"
        >
          <p className="mb-2 text-lg font-bold">راه‌اندازی محلی</p>
          <p className="mb-4 text-sm text-muted-foreground">
            کسب‌وکار جدیدی روی همین دستگاه بسازید. همه‌چیز محلی می‌ماند و به اینترنت نیازی نیست.
          </p>
          <ul className="space-y-1 text-xs text-muted-foreground">
            <li>• فروش، منو، انبار، حسابداری و گزارش‌ها فعال</li>
            <li>• پشتیبان‌گیری روی درایو محلی</li>
            <li>• دستیار هوش مصنوعی و همگام‌سازی چندشعبه‌ای غیرفعال</li>
          </ul>
        </button>

        <button
          type="button"
          onClick={() => onChoose("connect")}
          className="rounded-2xl border border-input bg-card p-6 text-start shadow-sm transition hover:border-primary hover:shadow-md"
        >
          <p className="mb-2 text-lg font-bold">اتصال به پلتفرم آنلاین</p>
          <p className="mb-4 text-sm text-muted-foreground">
            اگر کسب‌وکار شما از قبل روی پلتفرم آنلاین ساخته شده است، با کد اتصال، همان تنظیمات را
            روی این دستگاه بیاورید.
          </p>
          <ul className="space-y-1 text-xs text-muted-foreground">
            <li>• منو، کاربران، حساب‌ها و تنظیمات از سرور می‌آید</li>
            <li>• کارکنان با همان پین همیشگی وارد می‌شوند</li>
            <li>• به کد اتصال از پشتیبانی نیاز دارید</li>
          </ul>
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Write the pairing form**

Create `src/app/welcome/pair-form.tsx`:

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const DEFAULT_REMOTE_URL = "https://pos.eshobe.com";

/** Every failure this flow can produce, in the owner's language. */
const ERROR_MESSAGES: Record<string, string> = {
  code_not_found: "کد اتصال معتبر نیست.",
  code_expired: "این کد منقضی شده است. از پشتیبانی کد جدید بخواهید.",
  code_already_redeemed: "این کد قبلاً استفاده شده است.",
  code_revoked: "این کد لغو شده است. از پشتیبانی کد جدید بخواهید.",
  remote_unreachable: "سرور آنلاین در دسترس نیست. اتصال اینترنت را بررسی کنید.",
  snapshot_invalid: "داده‌های دریافتی معتبر نیستند. با پشتیبانی تماس بگیرید.",
  missing_fields: "آدرس سرور و کد اتصال را وارد کنید.",
  invalid_url: "آدرس سرور معتبر نیست.",
};

export function PairForm({ onBack }: { onBack: () => void }) {
  const router = useRouter();
  const [remoteUrl, setRemoteUrl] = useState(DEFAULT_REMOTE_URL);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");

    const res = await fetch("/api/setup/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ remoteUrl, code }),
    });

    if (res.ok) {
      const data = (await res.json()) as { slug: string };
      // The snapshot already carries a completed wizard, so this goes straight
      // to the dashboard rather than /setup/business.
      router.replace(`/${data.slug}/dashboard`);
      return;
    }

    const data = (await res.json().catch(() => ({}))) as { error?: string };
    setBusy(false);
    if (data.error === "already_initialized") {
      router.replace("/login");
      return;
    }
    setError(ERROR_MESSAGES[data.error ?? ""] ?? "اتصال انجام نشد. دوباره تلاش کنید.");
  }

  return (
    <div className="w-full max-w-md rounded-2xl bg-card p-8 shadow-sm">
      <button
        type="button"
        onClick={onBack}
        className="mb-4 text-sm text-muted-foreground hover:text-foreground"
      >
        ← بازگشت
      </button>
      <h1 className="mb-1 text-2xl font-bold">اتصال به پلتفرم آنلاین</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        کد اتصال یک‌بارمصرفی است که پشتیبانی برای کسب‌وکار شما صادر می‌کند.
      </p>

      {error ? (
        <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <form onSubmit={submit} className="space-y-4">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-foreground">آدرس سرور *</span>
          <input
            className="w-full rounded-lg border border-input px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-ring/30"
            dir="ltr"
            value={remoteUrl}
            onChange={(e) => setRemoteUrl(e.target.value)}
            required
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-foreground">کد اتصال *</span>
          <input
            className="w-full rounded-lg border border-input px-3 py-2 text-center font-mono text-lg tracking-widest outline-none focus:border-primary focus:ring-2 focus:ring-ring/30"
            dir="ltr"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="XXXX-XXXX-XXXX"
            autoComplete="off"
            required
          />
        </label>
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/85 disabled:opacity-50"
        >
          {busy ? "در حال دریافت تنظیمات…" : "اتصال و دریافت تنظیمات"}
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 3: Rewrite the welcome page as a three-state shell**

Replace the whole of `src/app/welcome/page.tsx`:

```tsx
"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ModeChoice } from "./mode-choice";
import { PairForm } from "./pair-form";

type Stage = "choosing" | "local" | "connecting";

/**
 * First-run page. On a completely empty database it asks how this install
 * should be set up — a brand-new local-only business, or an existing online
 * business claimed with a pairing code — then runs the chosen path. If the
 * install already has users, it redirects to the normal login.
 */
export default function WelcomePage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [stage, setStage] = useState<Stage>("choosing");

  useEffect(() => {
    fetch("/api/setup/state")
      .then((r) => r.json())
      .then((s: { needsBootstrap?: boolean }) => {
        if (!s.needsBootstrap) {
          router.replace("/login");
        } else {
          setChecking(false);
        }
      })
      .catch(() => setChecking(false));
  }, [router]);

  if (checking) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
        در حال بررسی…
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      {stage === "choosing" ? (
        <ModeChoice onChoose={(mode) => setStage(mode === "local" ? "local" : "connecting")} />
      ) : null}
      {stage === "local" ? <LocalBootstrapForm onBack={() => setStage("choosing")} /> : null}
      {stage === "connecting" ? <PairForm onBack={() => setStage("choosing")} /> : null}
    </div>
  );
}

/** Today's bootstrap form, unchanged apart from the back link and the mode it sends. */
function LocalBootstrapForm({ onBack }: { onBack: () => void }) {
  const router = useRouter();
  const [businessName, setBusinessName] = useState("");
  const [locationName, setLocationName] = useState("شعبه مرکزی");
  const [ownerName, setOwnerName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/setup/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        businessName,
        locationName,
        ownerName,
        email,
        password,
        deploymentMode: "local",
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setBusy(false);
      if (data.error === "already_initialized") {
        router.replace("/login");
        return;
      }
      const map: Record<string, string> = {
        missing_fields: "همهٔ فیلدهای الزامی را پر کنید.",
        invalid_email: "ایمیل معتبر نیست.",
        weak_password: "گذرواژه باید حداقل ۸ کاراکتر باشد.",
        email_password_mismatch: "این ایمیل قبلاً ثبت شده و گذرواژه با آن هم‌خوانی ندارد.",
      };
      setError(map[data.error] ?? "خطا در راه‌اندازی اولیه. دوباره تلاش کنید.");
      return;
    }
    // Bootstrap signs the Owner in; go straight to the wizard.
    router.replace("/setup/business");
  }

  return (
    <div className="w-full max-w-md rounded-2xl bg-card p-8 shadow-sm">
      <button
        type="button"
        onClick={onBack}
        className="mb-4 text-sm text-muted-foreground hover:text-foreground"
      >
        ← بازگشت
      </button>
      <h1 className="mb-1 text-2xl font-bold">راه‌اندازی محلی</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        کسب‌وکار و حساب مالک را بسازید. بعد از آن، جادوگر راه‌اندازی شما را قدم‌به‌قدم تا
        آماده‌شدن برای فروش همراهی می‌کند.
      </p>

      {error ? (
        <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <form onSubmit={submit} className="space-y-4">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-foreground">نام کسب‌وکار *</span>
          <input
            className="w-full rounded-lg border border-input px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-ring/30"
            value={businessName}
            onChange={(e) => setBusinessName(e.target.value)}
            placeholder="مثلاً کافه بهار"
            required
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-foreground">نام شعبهٔ اول *</span>
          <input
            className="w-full rounded-lg border border-input px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-ring/30"
            value={locationName}
            onChange={(e) => setLocationName(e.target.value)}
            required
          />
        </label>
        <hr className="border-border" />
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-foreground">نام مالک *</span>
          <input
            className="w-full rounded-lg border border-input px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-ring/30"
            value={ownerName}
            onChange={(e) => setOwnerName(e.target.value)}
            required
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-foreground">ایمیل مالک *</span>
          <input
            className="w-full rounded-lg border border-input px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-ring/30"
            dir="ltr"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-foreground">گذرواژه *</span>
          <input
            className="w-full rounded-lg border border-input px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-ring/30"
            dir="ltr"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="حداقل ۸ کاراکتر"
            required
          />
        </label>
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/85 disabled:opacity-50"
        >
          {busy ? "در حال ساخت…" : "ساخت و شروع راه‌اندازی"}
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 4: Type check and build**

```bash
npx tsc --noEmit
npm run build
```
Expected: both clean.

- [ ] **Step 5: Manual smoke test**

```bash
docker compose up -d
npm run db:migrate
npm run dev
```

Open `http://localhost:3000/welcome` against an **empty** database (drop and re-migrate if needed). Verify:
1. Two cards appear.
2. «راه‌اندازی محلی» shows the bootstrap form; the back arrow returns to the cards.
3. Submitting it lands on `/setup/business`.
4. On a fresh empty database, «اتصال به پلتفرم آنلاین» with a bogus code shows «کد اتصال معتبر نیست.» (pointing `remoteUrl` at a server that has a business and a real code is exercised by the integration test).

- [ ] **Step 6: Commit**

```bash
git add src/app/welcome
git commit -m "feat: three-state first-run wizard — choose local setup or online pairing"
```

---

### Task 11: Platform console pairing panel

**Files:**
- Create: `src/app/platform/businesses/[id]/pairing-panel.tsx`
- Modify: `src/app/platform/businesses/[id]/page.tsx` (import + mount after `<FeaturesPanel />`)
- Modify: `src/app/platform/ui.tsx` (`errorMessage` map)

**Interfaces:**
- Consumes: `api`, `errorMessage`, `Button`, `Card`, `ErrorBox`, `InfoBox`, `useCan` from `../../ui`; the routes from Task 8.
- Produces: nothing consumed by later tasks.

---

- [ ] **Step 1: Add the new error codes to the console vocabulary**

In `src/app/platform/ui.tsx`, inside `errorMessage`'s `map`, after the `delete_failed` line:

```ts
    no_location: "این کسب‌وکار هنوز شعبه‌ای ندارد؛ ابتدا یک شعبه بسازید.",
    code_not_found: "کد اتصال پیدا نشد.",
    code_expired: "این کد منقضی شده است.",
    code_already_redeemed: "این کد قبلاً استفاده شده است.",
    code_revoked: "این کد لغو شده است.",
```

- [ ] **Step 2: Write the panel**

Create `src/app/platform/businesses/[id]/pairing-panel.tsx`:

```tsx
"use client";

/**
 * Desktop pairing codes for one business.
 *
 * The plaintext code exists only in the response to the issue request — this
 * component holds it in state so the operator can copy it, and it is gone on
 * the next render pass. Re-issuing revokes whatever was live, so the list
 * never shows two usable codes.
 */
import { useCallback, useEffect, useState } from "react";
import { api, errorMessage, Button, Card, ErrorBox, InfoBox, useCan } from "../../ui";

interface PairingCodeSummary {
  id: string;
  businessId: string;
  locationId: string;
  expiresAt: string;
  redeemedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  state: "valid" | "code_expired" | "code_already_redeemed" | "code_revoked";
}

const STATE_LABELS: Record<PairingCodeSummary["state"], { label: string; cls: string }> = {
  valid: { label: "فعال", cls: "text-emerald-300" },
  code_expired: { label: "منقضی", cls: "text-white/40" },
  code_already_redeemed: { label: "استفاده‌شده", cls: "text-sky-300" },
  code_revoked: { label: "لغوشده", cls: "text-white/40" },
};

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("fa-IR", { dateStyle: "short", timeStyle: "short" });
}

export function PairingPanel({ id }: { id: string }) {
  const can = useCan();
  const allowed = can("business.provision");

  const [codes, setCodes] = useState<PairingCodeSummary[]>([]);
  const [issuedCode, setIssuedCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!allowed) return;
    const { ok, data } = await api<{ codes?: PairingCodeSummary[]; error?: string }>(
      `/api/platform/pairing?businessId=${encodeURIComponent(id)}`,
    );
    if (ok) setCodes(data.codes ?? []);
    else setError(errorMessage(data.error));
  }, [id, allowed]);

  useEffect(() => {
    void load();
  }, [load]);

  async function issue() {
    setBusy(true);
    setError(null);
    setNotice(null);
    const { ok, data } = await api<{ code?: string; error?: string }>("/api/platform/pairing", {
      method: "POST",
      body: JSON.stringify({ businessId: id }),
    });
    setBusy(false);
    if (ok && data.code) {
      setIssuedCode(data.code);
      setNotice("کد ساخته شد. همین حالا آن را کپی کنید — دیگر نمایش داده نمی‌شود.");
      void load();
    } else {
      setError(errorMessage(data.error));
    }
  }

  async function revoke(codeId: string) {
    if (!confirm("این کد اتصال لغو شود؟")) return;
    setError(null);
    setNotice(null);
    const { ok, data } = await api<{ error?: string }>("/api/platform/pairing", {
      method: "DELETE",
      body: JSON.stringify({ businessId: id, codeId }),
    });
    if (ok) {
      setIssuedCode(null);
      setNotice("کد لغو شد.");
      void load();
    } else {
      setError(errorMessage(data.error));
    }
  }

  if (!allowed) return null;

  return (
    <Card title="کد اتصال نصب دسکتاپ">
      <ErrorBox>{error}</ErrorBox>
      <InfoBox>{notice}</InfoBox>

      <p className="mb-4 text-sm text-white/60">
        یک کد یک‌بارمصرف بسازید و آن را به مالک بدهید تا نصب دسکتاپ، تنظیمات این کسب‌وکار را
        دریافت کند. ساختن کد جدید، کد فعال قبلی را لغو می‌کند.
      </p>

      {issuedCode ? (
        <div className="mb-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4">
          <p className="mb-2 text-xs text-emerald-200/70">این کد فقط همین یک بار نمایش داده می‌شود:</p>
          <div className="flex flex-wrap items-center gap-3">
            <code className="select-all font-mono text-xl tracking-widest text-emerald-100" dir="ltr">
              {issuedCode}
            </code>
            <Button
              variant="ghost"
              onClick={() => {
                void navigator.clipboard.writeText(issuedCode);
                setNotice("کد کپی شد.");
              }}
            >
              کپی
            </Button>
          </div>
        </div>
      ) : null}

      <Button onClick={issue} disabled={busy}>
        {busy ? "در حال ساخت…" : "ساخت کد اتصال"}
      </Button>

      {codes.length === 0 ? (
        <p className="mt-4 text-sm text-white/40">هنوز کدی صادر نشده است.</p>
      ) : (
        <div className="mt-4 space-y-2">
          {codes.map((code) => {
            const state = STATE_LABELS[code.state];
            return (
              <div
                key={code.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/10 bg-white/2 p-3 text-sm"
              >
                <div>
                  <span className={`font-medium ${state.cls}`}>{state.label}</span>
                  <p className="mt-0.5 text-xs text-white/30">
                    صدور {fmtDate(code.createdAt)} ← انقضا {fmtDate(code.expiresAt)}
                  </p>
                  {code.redeemedAt ? (
                    <p className="mt-0.5 text-xs text-white/30">
                      استفاده در {fmtDate(code.redeemedAt)}
                    </p>
                  ) : null}
                </div>
                {code.state === "valid" ? (
                  <button
                    type="button"
                    onClick={() => revoke(code.id)}
                    className="rounded-md border border-red-500/30 px-2 py-1 text-xs text-red-300 hover:bg-red-500/10"
                  >
                    لغو
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
```

- [ ] **Step 3: Mount it in the business detail page**

In `src/app/platform/businesses/[id]/page.tsx`, add the import after the `../../ui` import block:

```ts
import { PairingPanel } from "./pairing-panel";
```

and mount it between `<FeaturesPanel />` and `<ImpersonationPanel />`:

```tsx
      <FeaturesPanel key={`features-${resetKey}`} id={id} />
      <PairingPanel key={`pairing-${resetKey}`} id={id} />
      <ImpersonationPanel key={`impersonation-${resetKey}`} id={id} businessName={business.name} />
```

- [ ] **Step 4: Type check and build**

```bash
npx tsc --noEmit
npm run build
```
Expected: both clean.

- [ ] **Step 5: Commit**

```bash
git add "src/app/platform/businesses/[id]" src/app/platform/ui.tsx
git commit -m "feat: platform console panel for issuing and revoking pairing codes"
```

---

### Task 12: Local-mode backup — wizard step, cloud lockout, Electron folder picker

**Files:**
- Create: `src/app/setup/backup/page.tsx`
- Modify: `src/lib/setup-state.ts` (`WIZARD_STEPS`, `OPTIONAL_STEPS`, `SetupState`, `computeSetupState`)
- Modify: `src/app/setup/steps.ts`
- Modify: `src/app/api/backup/config/route.ts`
- Modify: `src/app/dashboard/backup/backup-manager.tsx`
- Modify: `electron/preload.js`
- Modify: `electron/main.js`

**Interfaces:**
- Consumes: `isLocalOnly` from `@/lib/deployment-mode`; `getBackupConfigMasked`, `setBackupConfig`, `getBackupConfig` from `@/lib/backup-service`; `validateBackupConfig`, `DEFAULT_BACKUP_CONFIG` from `@/lib/backup`; `markStepDone` from `@/lib/settings`.
- Produces:
  - `window.desktop?.pickFolder(): Promise<string | null>` (declared as a global in `src/app/setup/backup/page.tsx`)
  - `GET /api/backup/config` response gains `localOnly: boolean`
  - `WIZARD_STEPS` gains `"backup"`; `OPTIONAL_STEPS` gains `"backup"`
  - `SetupState` gains `localOnly: boolean`

---

- [ ] **Step 1: Add the wizard step to the shared step lists**

In `src/lib/setup-state.ts`:

```ts
export const WIZARD_STEPS = [
  "business",
  "accounts",
  "costing",
  "tax",
  "users",
  "menu",
  "hardware",
  "backup",
  "opening",
] as const;
```

```ts
/** Steps that may be skipped and still allow finishing the wizard. */
export const OPTIONAL_STEPS: WizardStep[] = ["users", "hardware", "backup", "opening"];
```

Add the import at the top of the file:

```ts
import { isLocalOnly } from "./deployment-mode";
```

Add `localOnly` to `SetupState`, right after `needsBootstrap`:

```ts
  needsBootstrap: boolean;
  /** True on a standalone desktop install: no online platform, local-drive backup only. */
  localOnly: boolean;
```

and populate it in `computeSetupState`. Change the destructured `Promise.all` block:

```ts
  const [prefs, costing, tax, progress, localOnly] = await Promise.all([
    getSetting<BusinessPrefs>(businessId, SETTING_KEYS.businessPrefs),
    getSetting<CostingSetting>(businessId, SETTING_KEYS.costing),
    getSetting<TaxSetting>(businessId, SETTING_KEYS.tax),
    getWizardProgress(businessId),
    isLocalOnly(businessId),
  ]);
```

and the returned object:

```ts
  return {
    needsBootstrap: false,
    localOnly,
    business,
```

- [ ] **Step 2: Add the step to the wizard's step metadata**

In `src/app/setup/steps.ts`, insert between `hardware` and `opening`:

```ts
  {
    id: "backup",
    path: "/setup/backup",
    title: "مقصد پشتیبان‌گیری",
    short: "پشتیبان",
    optional: true,
  },
```

- [ ] **Step 3: Return `localOnly` from the backup config route and refuse cloud in local mode**

The `GET` replacement below assumes the handler currently returns `{ config: await getBackupConfigMasked(session.businessId) }`. Open the file first and keep whatever it actually calls and whatever other keys it already returns — the only change is adding `localOnly` alongside them.

In `src/app/api/backup/config/route.ts`, replace the `GET` handler:

```ts
export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner");
  if (error) return error;

  return NextResponse.json({
    config: await getBackupConfigMasked(session.businessId),
    // A local-only install has no cloud story: the client hides the whole
    // S3 section, and the PUT below refuses to enable it.
    localOnly: await isLocalOnly(session.businessId),
  });
});
```

and add, inside `PUT`, immediately after the `validated` check:

```ts
  // A standalone install cannot use cloud backup: there is no platform to hold
  // the credentials, and the whole point of local mode is that nothing leaves
  // the machine. The local half of the schedule stays fully available.
  if (validated.config.cloud.enabled && (await isLocalOnly(session.businessId))) {
    return NextResponse.json({ error: "cloud_backup_unavailable_local" }, { status: 400 });
  }
```

Add the import:

```ts
import { isLocalOnly } from "@/lib/deployment-mode";
```

- [ ] **Step 4: Hide the cloud section in the dashboard backup manager**

Open `src/app/dashboard/backup/backup-manager.tsx`. Find where it fetches `/api/backup/config` and stores the response, and:

1. Add `const [localOnly, setLocalOnly] = useState(false);` alongside the existing state.
2. In the fetch's `.then`, add `setLocalOnly(Boolean(data.localOnly));`.
3. Wrap the JSX block containing the S3/cloud fields (endpoint, region, bucket, prefix, access key, secret, passphrase, cloud retention, and the cloud `enabled` toggle) in `{!localOnly ? ( … ) : null}`.
4. Immediately after that block, add the explanatory note:

```tsx
{localOnly ? (
  <p className="rounded-lg border border-input bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
    این نصب محلی است؛ پشتیبان‌گیری ابری در دسترس نیست. نسخه‌های پشتیبان روی همین دستگاه
    ساخته و نگهداری می‌شوند.
  </p>
) : null}
```

Also add the error code to whatever error map the file uses (search for `missing_fields` in it):

```ts
cloud_backup_unavailable_local: "در نصب محلی، پشتیبان‌گیری ابری در دسترس نیست.",
```

- [ ] **Step 5: Write the wizard step page**

Create `src/app/setup/backup/page.tsx`:

```tsx
"use client";

/**
 * Optional wizard step, shown only on a local-only install: where the nightly
 * backup is written.
 *
 * On the desktop app the folder picker is a real OS dialog, exposed by the
 * Electron preload bridge; anywhere else (a browser hitting a local server)
 * it degrades to typing the path, which is the only thing a browser can do.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { nextPath, prevPath } from "../steps";

declare global {
  interface Window {
    desktop?: { pickFolder: () => Promise<string | null> };
  }
}

interface BackupConfigResponse {
  config: {
    enabled: boolean;
    intervalHours: number;
    anchorTime: string;
    localRetention: number;
  };
  localOnly: boolean;
}

export default function BackupStepPage() {
  const router = useRouter();
  const [loaded, setLoaded] = useState(false);
  const [localOnly, setLocalOnly] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [anchorTime, setAnchorTime] = useState("03:30");
  const [localRetention, setLocalRetention] = useState(14);
  const [directory, setDirectory] = useState("");
  const [canPick, setCanPick] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setCanPick(typeof window !== "undefined" && Boolean(window.desktop?.pickFolder));
    fetch("/api/backup/config")
      .then((r) => r.json())
      .then((data: BackupConfigResponse) => {
        setLocalOnly(Boolean(data.localOnly));
        if (data.config) {
          setEnabled(data.config.enabled);
          setAnchorTime(data.config.anchorTime);
          setLocalRetention(data.config.localRetention);
        }
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  // A connected install has nothing to configure here — the platform's backup
  // page covers both halves — so this step just steps aside.
  useEffect(() => {
    if (loaded && !localOnly) router.replace(nextPath("backup"));
  }, [loaded, localOnly, router]);

  async function pick() {
    const chosen = await window.desktop?.pickFolder();
    if (chosen) setDirectory(chosen);
  }

  async function save(skip: boolean) {
    setBusy(true);
    setError("");
    if (!skip) {
      const res = await fetch("/api/backup/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled,
          intervalHours: 24,
          anchorTime,
          localRetention,
          directory: directory || undefined,
          cloud: { enabled: false },
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setBusy(false);
        setError(
          data.error === "cloud_backup_unavailable_local"
            ? "در نصب محلی، پشتیبان‌گیری ابری در دسترس نیست."
            : "ذخیرهٔ تنظیمات پشتیبان‌گیری ممکن نشد.",
        );
        return;
      }
    }
    await fetch("/api/setup/progress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step: "backup" }),
    }).catch(() => {});
    router.push(nextPath("backup"));
  }

  if (!loaded || !localOnly) {
    return <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>;
  }

  return (
    <div>
      <h1 className="mb-1 text-xl font-bold">مقصد پشتیبان‌گیری</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        این نصب محلی است، بنابراین نسخه‌های پشتیبان روی همین دستگاه ساخته می‌شوند. یک پوشه —
        ترجیحاً روی یک درایو دیگر یا حافظهٔ خارجی — انتخاب کنید.
      </p>

      {error ? (
        <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <div className="space-y-4">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          پشتیبان‌گیری خودکار شبانه فعال باشد
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium">پوشهٔ مقصد</span>
          <div className="flex gap-2">
            <input
              className="w-full rounded-lg border border-input px-3 py-2 text-sm outline-none focus:border-primary"
              dir="ltr"
              value={directory}
              onChange={(e) => setDirectory(e.target.value)}
              placeholder="D:\\pos-backups"
            />
            {canPick ? (
              <button
                type="button"
                onClick={pick}
                className="shrink-0 rounded-lg border border-input px-4 text-sm hover:bg-muted"
              >
                انتخاب پوشه…
              </button>
            ) : null}
          </div>
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium">ساعت اجرا</span>
          <input
            className="rounded-lg border border-input px-3 py-2 text-sm outline-none focus:border-primary"
            dir="ltr"
            type="time"
            value={anchorTime}
            onChange={(e) => setAnchorTime(e.target.value)}
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium">تعداد نسخه‌های نگهداری‌شده</span>
          <input
            className="w-32 rounded-lg border border-input px-3 py-2 text-sm outline-none focus:border-primary"
            dir="ltr"
            type="number"
            min={1}
            value={localRetention}
            onChange={(e) => setLocalRetention(Number(e.target.value))}
          />
        </label>
      </div>

      <div className="mt-8 flex items-center justify-between">
        <button
          type="button"
          onClick={() => {
            const previous = prevPath("backup");
            if (previous) router.push(previous);
          }}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← مرحلهٔ قبل
        </button>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void save(true)}
            disabled={busy}
            className="rounded-lg border border-input px-4 py-2 text-sm hover:bg-muted disabled:opacity-50"
          >
            فعلاً رد شو
          </button>
          <button
            type="button"
            onClick={() => void save(false)}
            disabled={busy}
            className="rounded-lg bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/85 disabled:opacity-50"
          >
            {busy ? "در حال ذخیره…" : "ذخیره و ادامه"}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4a: Confirm the progress endpoint's contract**

Run: `cat src/app/api/setup/progress/route.ts`
Expected: a `POST` accepting `{ step }` and calling `markStepDone`. If the field is named differently (e.g. `stepId`), change the body in Step 5's `save()` to match. If the route does not exist, look at how another optional step (e.g. `src/app/setup/hardware/page.tsx`) records completion and copy that call verbatim.

- [ ] **Step 4b: Confirm `BackupConfig` carries a directory**

Run: `grep -n "directory\|BACKUP_DIR" src/lib/backup.ts src/lib/backup-service.ts | head -20`

If `BackupConfig` has no `directory` field (the spec's `BackupConfig` listing shows `enabled`, `intervalHours`, `anchorTime`, `localRetention`, `cloud`), then the backup destination is currently an environment variable, not a setting. In that case:

1. Add `directory: string` to `BackupConfig` in `src/lib/backup.ts` with `""` in `DEFAULT_BACKUP_CONFIG` (empty = use today's default location, so nothing changes for existing installs).
2. Accept and validate it in `validateBackupConfig`: reject a non-string; trim; no other constraint (the OS reports a bad path at write time, and pre-validating a Windows path in TypeScript is worse than useless).
3. Add a case to `src/lib/backup.test.ts` proving an absent `directory` defaults to `""` and a supplied one round-trips.
4. In whichever function resolves the output path for a backup artifact, prefer `config.directory` when non-empty over the existing default.

Run: `npx vitest run src/lib/backup.test.ts`
Expected: PASS.

- [ ] **Step 6: Add the Electron folder picker**

Replace the contents of `electron/preload.js`:

```js
// Bridge between the Electron shell and the web app.
//
// Deliberately minimal and explicitly enumerated: contextIsolation stays on,
// and the renderer gets exactly the native capabilities it needs and nothing
// more. Today that is one thing — a real folder picker for the backup
// destination, which a browser cannot provide.
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  /** Opens the OS folder dialog. Resolves to the chosen absolute path, or null if cancelled. */
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
});
```

In `electron/main.js`, change the top-level require:

```js
const { app, BrowserWindow, dialog, ipcMain } = require("electron");
```

and register the handler inside `app.whenReady().then(...)`, before `await startBackend()`:

```js
app.whenReady().then(async () => {
  // The backup-destination wizard step calls this through the preload bridge;
  // a browser has no way to return a real filesystem path, so the desktop
  // shell is the only place it can come from.
  ipcMain.handle("pick-folder", async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
      title: "پوشهٔ پشتیبان‌گیری",
    });
    return canceled ? null : filePaths[0];
  });

  await startBackend();
  await createWindow();
  // ... existing 'activate' handler unchanged
```

- [ ] **Step 7: Full pre-commit verification**

```bash
npx tsc --noEmit
npm test
npm run test:db
npm run build
```
Expected: all four clean. In particular `npm run test:db` re-runs any test asserting on `computeSetupState`'s shape, which just gained `localOnly`.

- [ ] **Step 8: Commit**

```bash
git add src/app/setup/backup src/lib/setup-state.ts src/app/setup/steps.ts \
        src/app/api/backup/config/route.ts src/app/dashboard/backup/backup-manager.tsx \
        src/lib/backup.ts src/lib/backup.test.ts \
        electron/preload.js electron/main.js
git commit -m "feat: local-mode backup destination step, cloud lockout, Electron folder picker"
```

---

### Task 13: Documentation

**Files:**
- Modify: `docs/deployment/standalone-desktop-app.md`
- Modify: `README.md` (the "Multi-business tenancy" section, or wherever deployment modes would naturally be described)

**Interfaces:**
- Consumes: everything built above.
- Produces: nothing.

---

- [ ] **Step 1: Document the first-run flow in the desktop doc**

Add a section to `docs/deployment/standalone-desktop-app.md`:

```markdown
## First run — local setup or pairing

The first time the desktop app opens against an empty database it shows a choice
rather than a form:

**راه‌اندازی محلی** — a brand-new business that lives only on this machine. It
runs the same bootstrap the web app has always used, then stamps
`settings['deployment.mode'] = { mode: 'local', pairedAt: null }` and writes
`business_features` "off" overrides for `ai_assistant`, `multi_location` and
`offline_mode` (see `src/lib/deployment-mode.ts`). Everything else — sales,
menu, inventory, ledger, reporting, local-drive backup — works unchanged. The
setup wizard then gains one extra optional step, «مقصد پشتیبان‌گیری», where the
owner picks a backup folder through a real OS dialog (`window.desktop.pickFolder`,
exposed by `electron/preload.js`).

**اتصال به پلتفرم آنلاین** — claim a business that already exists on the online
platform. An operator issues a one-time pairing code from the super-admin
console (`/platform` → the business → «کد اتصال نصب دسکتاپ»), hands it to the
owner out-of-band, and the owner types it here along with the server URL. The
local server calls `POST <remoteUrl>/api/platform/pairing/redeem`, which marks
the code redeemed and returns a `PairingSnapshot`: the business, its branch, its
members (with their bcrypt PIN/password hashes, so staff sign in with the
credentials they already have), the chart of accounts, the menu, the
configuration settings, the effective feature flags, and a freshly-minted
server-sync token. `applyPairingSnapshot` replays it into the empty local
database in one transaction, **preserving every id verbatim** — the laptop and
the server share a `business_id`, `location_id` and user ids, which is what
makes Phase 11's `sync_events` replay correctly in both directions.

A pairing code is valid for 72 hours, is single-use, and only its sha-256 is
stored — the plaintext appears once in the console and is unrecoverable
afterwards. Re-issuing revokes whatever code was live; the partial unique index
`idx_pairing_codes_live_business` enforces at most one.

The mode is chosen once and is not changeable from the UI. Upgrading a local
install to a connected one means merging two datasets, which is deliberately out
of scope.
```

- [ ] **Step 2: Note the backward-compatibility rule in the README**

Add near the tenancy section of `README.md`:

```markdown
### Deployment mode

`settings['deployment.mode']` records whether an install is `local` (standalone
desktop, no online platform) or `connected`. **An absent setting reads as
`connected`**, so every deployment that predates this feature — every VPS, every
already-paired laptop — behaves exactly as it did, with no backfill migration.
`isLocalOnly(businessId)` in `src/lib/deployment-mode.ts` is the one place to
ask.
```

- [ ] **Step 3: Commit**

```bash
git add docs/deployment/standalone-desktop-app.md README.md
git commit -m "docs: desktop first-run wizard — local setup and online pairing"
```

---

### Task 14: Open the pull request and watch it

**Files:** none.

---

- [ ] **Step 1: Push the branch**

```bash
git push -u origin HEAD
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create --title "Desktop first-run wizard: local setup or online pairing" --body "$(cat <<'EOF'
## Summary

A fresh Electron desktop install now asks how it should be set up instead of
dropping straight into a bootstrap form:

- **راه‌اندازی محلی** — a new standalone business. Records `deployment.mode = local`
  and turns off the three platform-dependent features (`ai_assistant`,
  `multi_location`, `offline_mode`). Gains one optional wizard step for the
  local backup destination, with a real OS folder picker on the desktop.
- **اتصال به پلتفرم آنلاین** — claim an existing online business with a one-time
  pairing code issued from the super-admin console. The local server redeems the
  code, receives a full configuration snapshot, and replays it into its empty
  database preserving every id, so server-sync works afterwards.

## Notes

- New table `install_pairing_codes` with its RLS policy in the same migration
  (0048), following the `invitations` pattern: only the sha-256 is stored, the
  plaintext is shown once.
- Two new `withoutTenantScope` calls, both fitting existing justified reasons —
  `redeemPairingCode` (resolve a bearer credential to its business, the
  server-sync-auth shape) and `applyPairingSnapshot` (creates the tenant, the
  provisionBusiness shape). Documented in `src/lib/db.ts`.
- An absent `deployment.mode` reads as `connected`, so every existing install is
  unaffected with no backfill.

## Testing

- `src/lib/pairing-codes.test.ts`, `src/lib/pairing-snapshot.test.ts`,
  `src/lib/deployment-mode.test.ts` — pure logic.
- `integration/pairing.integration.test.ts` — issue → redeem → apply across two
  real databases, proving id preservation and single-use enforcement.
- `npx tsc --noEmit`, `npm test`, `npm run test:db`, `npm run build` all pass.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Watch the PR through to a terminal state**

Per CLAUDE.md: subscribe to the PR's activity right after opening it, act on CI failures and review comments, and schedule a roughly-hourly check-in on status, mergeability and CI until it is actually merged or closed — not just until CI is green.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Three-state `/welcome` shell | 10 |
| Local path — bootstrap + mode stamp + disabled flags | 2, 10 |
| Connected path — normalise, redeem, validate, apply, sign in | 3, 4, 5, 6, 9 |
| `install_pairing_codes` table + RLS + partial unique index | 3 |
| `deployment.mode` SETTING_KEYS entry, absent = connected | 1 |
| `PairingSnapshot` shape, ids verbatim, hashes as-is, exclusions | 4, 5, 6 |
| Online code surface (6 files) | 3, 5, 8, 11 |
| Local code surface (6 files) | 4, 6, 9, 10 |
| Shared changes (4 files) | 1, 2, 8, 9 |
| `withoutTenantScope` justification | 5 (doc comment), 5 + 6 (the two calls) |
| `LOCAL_DISABLED_FEATURES` list | 1 |
| Backup: hide cloud, reject `cloud.enabled`, new optional step | 12 |
| Electron bridge (preload + main IPC) | 12 |
| Persian error messages for all 7 codes | 9 (route codes), 10 (`ERROR_MESSAGES` map) |
| Out of scope (no upgrade path, no bidirectional config sync) | Not built; documented in Task 13 |

**Deviations from the spec, deliberate:**

1. The spec named `requirePlatformCapability("businesses:write")`. That capability does not exist — `PlatformCapability` in `src/lib/platform-admin.ts` uses dot-separated names. The plan uses `business.provision` (owner-only), which matches the risk of handing out a credential that yields a whole business's configuration.
2. The spec's snapshot `users` entry had no platform-identity fields. Without them the owner could not sign in on the laptop with their platform email and password (`users.password_hash` may legitimately be null when the credential lives on `platform_users`). The plan carries `platformUserEmail`, `platformUserFullName` and `platformUserPasswordHash`.
3. The spec's snapshot had no `version`. `validateSnapshot` is described as a "shape/version check", so `PAIRING_SNAPSHOT_VERSION` is part of the payload and a mismatch fails closed.
4. The plan adds `POST /api/setup/pair` and `POST /api/platform/pairing/redeem` to the middleware's per-IP auth rate-limit bucket. A 12-character code with no session is a credential exchange and belongs there; the spec did not say so, but omitting it would leave the only brute-forceable surface in this feature unprotected.
5. Task 12 Step 4b makes the `BackupConfig.directory` field conditional on what is already there. The spec asserted `BackupConfig` "already has the right shape"; the field list it quotes has no directory, so the step verifies and, if needed, adds it — rather than a wizard step that silently saves nothing.
6. The spec named the pure helpers `generateCode()`, `normalizeCode()`, `hashCode()` and `validateRedeemable()`. The plan uses `generatePairingCode()`, `normalizePairingCode()`, `hashPairingCode()` and `pairingCodeState()` — prefixed because these are imported across module boundaries where a bare `hashCode` would read ambiguously next to `hashSyncToken` and `hashKey`, and `pairingCodeState` because it returns *which* failure applies rather than a boolean.

**Verification steps deliberately included:** Task 6 Step 2, Task 8 Step 0, Task 9 Step 2, Task 12 Steps 4a and 4b each confirm a name or shape in existing code before depending on it. These are not placeholders — each states exactly what to run, what to expect, and what to do if the expectation does not hold. They exist because the plan reaches into five subsystems (`server-sync`, `platform-service`, `auth`, `setup/progress`, `backup`) whose exact signatures were not all read at planning time; guessing and being wrong would surface as a type error mid-task rather than a clean decision point.
