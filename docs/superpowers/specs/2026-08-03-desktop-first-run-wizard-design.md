# Desktop First-Run Wizard — Design Spec

**Date:** 2026-08-03
**Status:** Approved for implementation
**Phase:** Post-Phase-20 (standalone desktop gap)

> **Wizard shape today (updated after #808):** the wizard is industry-shaped, not a fixed
> 8-step list. Food service walks all nine steps (the eighth being Backup, added by this spec,
> which is optional and local-only); retail and service industries drop the costing/menu steps.
> When this document says "step N" or "as today" it means the flow as of 2026-08-03.

---

## Problem

The Electron desktop app starts a local Postgres + Next.js server and opens `/welcome`, which
collects a business name and owner account, then drops into the setup wizard. This works
for a brand-new business, but there is no path for:

1. A business that already exists on the online platform and wants to pair a local desktop install.
2. A business that wants to run fully standalone (no online platform, no cloud features).

The result is that every desktop install today is implicitly "local-only" but with no explicit
mode, no feature gating, and no way to connect to an existing online business.

---

## Solution overview

Replace the single-screen `/welcome` with a three-state wizard shell:

```
state: 'choosing'  →  two cards: «راه‌اندازی محلی» / «اتصال به پلتفرم آنلاین»
  → «محلی»         →  state: 'local'       (today's bootstrap form, unchanged)
  → «آنلاین»       →  state: 'connecting'  (remoteUrl + pairing-code fields)
```

The mode is chosen once and written to `settings` as `deployment.mode`. It is never changed
through the UI after first run (upgrading local→connected requires a data-merge that is out of
scope for this phase; Settings shows an explanatory note instead of a button).

---

## Flow

### Local path

1. User picks «راه‌اندازی محلی».
2. Existing bootstrap form (unchanged): business name, branch name, owner name, email, password.
3. `POST /api/setup/bootstrap` — `provisionBusiness()` runs as today, plus:
   - writes `deployment.mode = { mode: 'local', pairedAt: null }` to settings
   - seeds `business_features` overrides for `LOCAL_DISABLED_FEATURES`
4. Redirect → `/setup/business` (the setup wizard, as today).

### Connected path

1. User picks «اتصال به پلتفرم آنلاین».
2. Two fields: remote URL (default `https://pos.eshobe.com`, editable) + pairing code (`XXXX-XXXX-XXXX`).
3. `POST /api/setup/pair` (new, public path):
   - normalises the code (strip dashes, uppercase, `0→O`, `1→I` folding)
   - calls `POST <remoteUrl>/api/platform/pairing/redeem` with `{ code }`
   - validates the returned `PairingSnapshot`
   - calls `applyPairingSnapshot()` — one bypassed transaction, preserving all IDs from the snapshot
   - writes `deployment.mode = { mode: 'connected', pairedAt: <ISO> }` to settings
   - signs the owner in (same cookie path as bootstrap)
4. Redirect → `/{slug}/dashboard` (wizard already complete — snapshot contains everything).

---

## Data model

### New table: `install_pairing_codes` (online server only)

Migration `00NN_install_pairing_codes.sql`:

```sql
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

-- At most one live code per business (re-issuing replaces, not accumulates)
CREATE UNIQUE INDEX idx_pairing_codes_live_business
    ON install_pairing_codes (business_id)
    WHERE redeemed_at IS NULL AND revoked_at IS NULL;

-- RLS (CLAUDE.md rule: same migration as CREATE TABLE)
ALTER TABLE install_pairing_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE install_pairing_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON install_pairing_codes FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
```

Only the sha-256 of the code is stored. The plaintext is shown once in the platform console
and is unrecoverable afterwards (same pattern as `invitations.token_hash`).

### New `SETTING_KEYS` entry (both sides)

```ts
/** { mode: 'local' | 'connected', pairedAt: string | null } */
deploymentMode: "deployment.mode",
```

Absent on installs that predate this work. `null` reads as `'connected'` — existing VPS
deployments and already-paired laptops are unaffected with no migration backfill.

### Snapshot payload (shared type, no new table)

```ts
export interface PairingSnapshot {
  business:  { id: string; name: string; slug: string; timezone: string };
  location:  { id: string; name: string; address: string|null; phone: string|null; timezone: string };
  users:     Array<{
    id: string; role: string; fullName: string; email: string;
    permissions: object; pinHash: string|null; passwordHash: string|null;
    locationIds: string[];
  }>;
  accounts:  Array<{ id: string; parentCode: string|null; code: string; name: string; type: string }>;
  menu:      { categories: object[]; items: object[] };
  settings:  Array<{ key: string; value: unknown }>;  // prefs, tax, costing, profile, pricing
  features:  Record<string, boolean>;                 // effectiveFeatures() for this business
  syncToken: string;                                  // plaintext, once — auto-configures server-sync
}
```

**IDs are preserved verbatim** — the local install carries the same `business_id`, `location_id`,
and `user_id`s as the online business, so `sync_events` replay correctly.

**Credential hashes come across as-is** — staff sign in on the laptop with their existing PINs;
no plaintext credential crosses the wire.

**Excluded from snapshot:** orders, ledger entries, stock movements, sync state, backup config
(local drive paths are machine-specific), rollup config.

---

## New code surface

### Online server (issuing side)

| File | Purpose |
|---|---|
| `migrations/00NN_install_pairing_codes.sql` | table + RLS + partial unique index |
| `src/lib/pairing-codes.ts` | **pure**: `generateCode()`, `normalizeCode()`, `hashCode()`, `validateRedeemable()`. Unit-tested. |
| `src/lib/pairing-service.ts` | DB: `issuePairingCode()`, `revokePairingCode()`, `listPairingCodes()`, `buildPairingSnapshot()`, `redeemPairingCode()` |
| `src/app/api/platform/pairing/route.ts` | `GET` list / `POST` issue / `DELETE` revoke — `requirePlatformCapability("businesses:write")` |
| `src/app/api/platform/pairing/redeem/route.ts` | `POST` — public path; the code is the credential |
| `src/app/platform/businesses/pairing-panel.tsx` | console UI: issue, show-once copy, revoke, status |

### Local install (redeeming side)

| File | Purpose |
|---|---|
| `src/lib/pairing-snapshot.ts` | **pure**: `validateSnapshot()` — shape/version check before any DB write. Unit-tested. |
| `src/lib/pairing-apply.ts` | DB: `applyPairingSnapshot()` — one bypassed transaction, inserts with snapshot IDs |
| `src/app/api/setup/pair/route.ts` | public path — `{ remoteUrl, code }` → redeem → apply → sign in |
| `src/app/welcome/mode-choice.tsx` | two-card mode screen |
| `src/app/welcome/pair-form.tsx` | pairing-code entry with per-error Persian messages |
| `src/app/welcome/page.tsx` | three-state shell: `'choosing' \| 'local' \| 'connecting'` |

### Shared

| File | Change |
|---|---|
| `src/lib/deployment-mode.ts` | **pure-ish**: `LOCAL_DISABLED_FEATURES`, `readDeploymentMode()`, `isLocalOnly()`. Unit test covers flag list. |
| `src/lib/settings.ts` | `+ deploymentMode` key |
| `src/lib/business-provisioning.ts` | `+ deploymentMode?: 'local' \| 'connected'` on input; seeds disabled flags when local |
| `src/middleware.ts` | `+ /api/setup/pair` to `PUBLIC_PATHS`; `+ /api/platform/pairing/redeem` to `PLATFORM_PUBLIC_PATHS` |

### `withoutTenantScope` justification (CLAUDE.md rule)

Two new bypassed calls, both fitting existing justified reasons:

- `redeemPairingCode` — resolves a bearer-style credential to its business before any tenant is
  chosen (same shape as the server-sync token case already on the list).
- `applyPairingSnapshot` — creates the tenant that scoping would otherwise require (same shape
  as `provisionBusiness`).

---

## Local-only mode — feature flags

Seeded as `business_features` override rows at local bootstrap. Individually flippable later
via the platform console.

| Flag | Local | Reason |
|---|---|---|
| `ai_assistant` | **off** | Needs platform credits/billing (Phase 18) |
| `multi_location` | **off** | Rollup is a platform function |
| `offline_mode` | **off** | Gates server-sync and rollup — meaningless standalone |
| `backup` | **on** | Local-drive backup only (see below) |
| `inventory`, `ledger`, `reservations`, `delivery`, `reporting` | **on** | Fully local |

### Backup in local mode

`BackupConfig` already has the right shape: local schedule + a separately-switchable `cloud`
block that defaults to `enabled: false`. Changes needed:

- Backup settings page hides the S3/cloud section when `isLocalOnly()`.
- `PUT /api/backup/config` rejects `cloud.enabled = true` in local mode.
- The wizard gains **one new optional step** for local installs: «مقصد پشتیبان‌گیری» —
  pick a backup folder, set the schedule. Joins `OPTIONAL_STEPS`. Only shown in local mode.

### Electron bridge addition

`electron/preload.js` (currently empty):

```js
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("desktop", {
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
});
```

`electron/main.js` — one new IPC handler:

```js
const { dialog, ipcMain } = require("electron");
ipcMain.handle("pick-folder", async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ["openDirectory", "createDirectory"],
  });
  return canceled ? null : filePaths[0];
});
```

The backup-destination wizard step calls `window.desktop?.pickFolder()` when available, falls
back to a plain text input otherwise.

---

## Error handling

### Pairing code errors (Persian messages)

| `error` from server | Message shown |
|---|---|
| `code_not_found` | «کد اتصال معتبر نیست.» |
| `code_expired` | «این کد منقضی شده است. از پشتیبانی کد جدید بخواهید.» |
| `code_already_redeemed` | «این کد قبلاً استفاده شده است.» |
| `code_revoked` | «این کد لغو شده است. از پشتیبانی کد جدید بخواهید.» |
| `remote_unreachable` | «سرور آنلاین در دسترس نیست. اتصال اینترنت را بررسی کنید.» |
| `snapshot_invalid` | «داده‌های دریافتی معتبر نیستند. با پشتیبانی تماس بگیرید.» |
| `already_initialized` | redirect to `/login` |

---

## Out of scope (this phase)

- Local → connected upgrade path (data merge; contact support note shown in Settings).
- Bidirectional menu/user sync (server-sync covers orders only today).
- Code delivery mechanism (operator hands code to owner out-of-band).
