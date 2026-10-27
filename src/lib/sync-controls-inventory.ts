/**
 * Issue #1115 — the checked inventory of every refresh / update / sync /
 * retry / reconcile control that touches the Cloud ↔ Desktop boundary.
 *
 * Why it exists: five different kinds of "refresh" look alike on screen and do
 * completely different things — a UI reload, an integration push to a third
 * party, a signed software update, an activation refresh and a real
 * Cloud ↔ site data exchange. Treating one as another is how a toast ends up
 * claiming "synced" for something that only re-read a status endpoint. This
 * module is the one place that says, for each control, *which* of them it is,
 * what it really does, who may press it and how the result is reported.
 *
 * It is data, not behaviour: nothing imports it at runtime. Three things keep
 * it honest (`sync-controls-inventory.test.ts`):
 *
 *  - every source file, API route and visible label named here must still exist;
 *  - every UI / Electron file that calls a Cloud ↔ site, activation, pairing or
 *    update endpoint must be listed under at least one control — a new control
 *    cannot ship unclassified;
 *  - `docs/architecture/sync-controls-inventory.md` is rendered from this file
 *    (`renderSyncControlsMarkdown`) and must equal it byte for byte.
 *
 * It deliberately does NOT repurpose or change any control. Where a control does
 * less than its label suggests, that is recorded as a finding, with the
 * workstream of the epic that owns the fix.
 *
 * Framework-free and client-safe: no imports.
 */

/** The five behaviours the epic names, plus the two that sit beside them. */
export const SYNC_CONTROL_CATEGORIES = [
  "cloud_site_data_sync",
  "activation_refresh",
  "software_update",
  "integration_sync",
  "ui_reload",
  "pairing_enrollment",
  "client_offline_queue",
] as const;
export type SyncControlCategory = (typeof SYNC_CONTROL_CATEGORIES)[number];

export const SYNC_CONTROL_CATEGORY_LABELS: Readonly<Record<SyncControlCategory, string>> = {
  cloud_site_data_sync: "Cloud ↔ site data sync (identity, operational events, master data)",
  activation_refresh: "Activation / licence refresh (Full Offline)",
  software_update: "Software update (signed installer, never data)",
  integration_sync: "Third-party integration sync (WooCommerce, CMS, Holoo)",
  ui_reload: "UI reload (re-reads data already on this side)",
  pairing_enrollment: "Pairing / enrolment (binds or unbinds an install)",
  client_offline_queue: "Client offline queue (browser → this site's own server)",
};

/** How the control is reached. */
export type SyncControlKind = "button" | "automatic" | "ipc" | "status_feed";

/** Where the control runs. `pre_pairing` is the welcome flow before any mode exists. */
export type SyncControlMode = "cloud" | "hybrid" | "local" | "pre_pairing" | "platform" | "android";

/** Who moves data: the direction as seen from the Windows site. */
export type SyncControlDirection =
  | "cloud_to_site"
  | "site_to_cloud"
  | "both"
  | "browser_to_site"
  | "site_to_third_party"
  | "third_party_to_site"
  | "local_reapply"
  | "none";

/**
 * What the user is told afterwards.
 *  - `verified`: the response is checked against the state it claims to fix.
 *  - `reported`: the real result (counts / error / status) is shown.
 *  - `optimistic`: a fixed success text is shown without reading the result.
 *  - `none`: nothing is reported (the control only nudges something else).
 */
export type SyncControlOutcome = "verified" | "reported" | "optimistic" | "none";

export interface SyncControl {
  /** Stable id: `<surface>.<action>`. Never reused. */
  id: string;
  kind: SyncControlKind;
  category: SyncControlCategory;
  /** The exact visible text, or null when there is no static label. */
  label: string | null;
  /** The file that contains the label and the handler. Must exist. */
  source: string;
  /** Further files that implement or call the same control. Must exist. */
  alsoIn?: readonly string[];
  /** `METHOD /api/path` (a route file must exist), an Electron channel, or null. */
  api: string | null;
  /** Permission key, role, platform capability, or `none (session-less)`. */
  actor: string;
  modes: readonly SyncControlMode[];
  /** The data domain it touches, in the replication contract's vocabulary where one exists. */
  domain: string;
  direction: SyncControlDirection;
  /** What it really does, in one sentence. */
  effect: string;
  outcome: SyncControlOutcome;
  /** Ids from `SYNC_CONTROL_FINDINGS`. */
  findings?: readonly string[];
}

export type SyncFindingSeverity = "gap" | "misleading" | "note";

export interface SyncControlFinding {
  id: string;
  severity: SyncFindingSeverity;
  summary: string;
  /** The epic #1115 workstream that owns the fix. */
  workstream: string;
}

export const SYNC_CONTROL_FINDINGS: readonly SyncControlFinding[] = [
  {
    id: "F1",
    severity: "misleading",
    summary:
      "Settings → Cloud & Sync «به‌روزرسانی» only dispatches the browser `online` event. That re-probes /api/connection/status and flushes the browser's own offline queue; it does not start a server-sync push or pull. Its label reads like a Cloud ↔ site refresh.",
    workstream: "P1 — Force Send / Receive / Both",
  },
  {
    id: "F2",
    severity: "misleading",
    summary:
      "Server-sync «retry deferred / retry dead letter / discard» shows «عملیات آشتی‌سازی انجام شد» whenever the request returns 2xx. The response carries the reconciliation counts, but the panel never reads them, so a run that re-applied nothing reports the same success as one that cleared the backlog.",
    workstream: "P0 — Controls inventory + owner UX contract",
  },
  {
    id: "F3",
    severity: "gap",
    summary:
      "No user-requested Cloud → site, site → Cloud or both-ways control exists. `runServerSyncTick` is reached only by the 30 s timer, the Postgres NOTIFY wake and the central long-poll in server.ts; no route, button or Electron channel starts it. The identity «sync now» buttons run the identity/credential plane only.",
    workstream: "P1 — Force Send / Receive / Both",
  },
  {
    id: "F4",
    severity: "gap",
    summary:
      "No control reports `queued → running → verified` for entity data. Identity repair is the one verified control (it returns 503 unless identities and PIN credentials converge); everything else reports a timestamp, a count of its own queue or nothing.",
    workstream: "P0 — Durable measured job/progress",
  },
  {
    id: "F5",
    severity: "gap",
    summary:
      "Superadmin has no scoped sync/status command for a Hybrid site. The only remote device commands are software-update `recheck` / `download_now` and consented Full Offline support sessions. Neither moves data, and both correctly stay queued until the device next calls in.",
    workstream: "P1 — Fleet, update and support integration",
  },
  {
    id: "F6",
    severity: "note",
    summary:
      "The IAM card's «همگام‌سازی اکنون» and «تلاش دوباره» post `sync` and `retry`, which /api/team/iam-status treats identically (only `repair` differs). Two labels, one behaviour.",
    workstream: "P0 — Controls inventory + owner UX contract",
  },
  {
    id: "F7",
    severity: "gap",
    summary:
      "Local → Hybrid conversion is operator-assisted only: scripts/convert-local-to-hybrid.ts, reached from the support page link («درخواست تبدیل امن»). There is no in-product preview, backup or explicit opt-in flow.",
    workstream: "P1 — Simplify Full Offline URL/token wizard (future opt-in conversion)",
  },
  {
    id: "F8",
    severity: "note",
    summary:
      "No Electron IPC channel moves business data. The `desktop:update-*` channels are the signed software updater only, and must stay separate from any future data-sync command.",
    workstream: "P1 — Force Send / Receive / Both",
  },
] as const;

const SETTINGS = "src/app/(app)/settings";

export const SYNC_CONTROLS: readonly SyncControl[] = [
  // ---- Cloud ↔ site data sync: identity plane ------------------------------
  {
    id: "settings.cloud-sync.iam-repair",
    kind: "button",
    category: "cloud_site_data_sync",
    label: "همگام‌سازی دوباره",
    source: `${SETTINGS}/cloud-sync-settings.tsx`,
    api: "POST /api/team/iam-status",
    actor: "team.manage",
    modes: ["hybrid"],
    domain: "identity + login credentials",
    direction: "cloud_to_site",
    effect:
      "Marks the IAM snapshot as required, replays the security plane, lifts a recorded operational block when it converges, then re-runs the login-credential stage.",
    outcome: "verified",
    findings: ["F3", "F4"],
  },
  {
    id: "team.iam-card.sync",
    kind: "button",
    category: "cloud_site_data_sync",
    label: "همگام‌سازی اکنون",
    source: "src/components/team/iam-sync-card.tsx",
    api: "POST /api/team/iam-status",
    actor: "team.manage",
    modes: ["hybrid"],
    domain: "identity + login credentials",
    direction: "cloud_to_site",
    effect: "Runs the IAM and login-credential sync once (same path as «تلاش دوباره»).",
    outcome: "reported",
    findings: ["F3", "F6"],
  },
  {
    id: "team.iam-card.retry",
    kind: "button",
    category: "cloud_site_data_sync",
    label: "تلاش دوباره",
    source: "src/components/team/iam-sync-card.tsx",
    api: "POST /api/team/iam-status",
    actor: "team.manage",
    modes: ["hybrid"],
    domain: "identity + login credentials",
    direction: "cloud_to_site",
    effect: "Identical to «همگام‌سازی اکنون»: the route does not distinguish `retry` from `sync`.",
    outcome: "reported",
    findings: ["F6"],
  },
  {
    id: "team.iam-card.repair",
    kind: "button",
    category: "cloud_site_data_sync",
    label: "ترمیم از نسخهٔ ابری",
    source: "src/components/team/iam-sync-card.tsx",
    api: "POST /api/team/iam-status",
    actor: "team.manage (behind a confirmation dialog)",
    modes: ["hybrid"],
    domain: "identity + login credentials",
    direction: "cloud_to_site",
    effect: "Forces a canonical snapshot re-download before the event replay, then verifies credentials.",
    outcome: "reported",
  },
  {
    id: "login.roster-resync",
    kind: "button",
    category: "cloud_site_data_sync",
    label: "همگام‌سازی دوباره",
    source: "src/app/login/login-form.tsx",
    api: "POST /api/auth/pin-login/roster/sync",
    actor: "none (session-less; host-resolved business, per-IP rate limit)",
    modes: ["hybrid"],
    domain: "login credentials (PIN roster)",
    direction: "cloud_to_site",
    effect:
      "Only when the roster omits cloud PIN staff: runs the IAM and credential stages, then the screen re-reads the roster. A no-op when already healthy.",
    outcome: "reported",
  },
  // ---- Cloud ↔ site data sync: operational plane ---------------------------
  {
    id: "connections.server-sync.retry-deferred",
    kind: "button",
    category: "cloud_site_data_sync",
    label: "تلاش دوباره برای رویدادهای معوق",
    source: `${SETTINGS}/connections/server-sync-panel.tsx`,
    api: "POST /api/server-sync/reconcile",
    actor: "owner",
    modes: ["hybrid", "cloud"],
    domain: "operational events (deferred inbox)",
    direction: "local_reapply",
    effect: "Re-applies up to 200 already-received events that were deferred for a missing prerequisite. Contacts no remote.",
    outcome: "optimistic",
    findings: ["F2", "F3"],
  },
  {
    id: "connections.server-sync.retry-dead-letter",
    kind: "button",
    category: "cloud_site_data_sync",
    label: "تلاش دوباره",
    source: `${SETTINGS}/connections/server-sync-panel.tsx`,
    api: "POST /api/server-sync/reconcile",
    actor: "owner",
    modes: ["hybrid", "cloud"],
    domain: "operational events (dead letters)",
    direction: "local_reapply",
    effect: "Re-opens one dead letter, then re-applies the deferred inbox once.",
    outcome: "optimistic",
    findings: ["F2"],
  },
  {
    id: "connections.server-sync.discard-dead-letter",
    kind: "button",
    category: "cloud_site_data_sync",
    label: "بایگانی",
    source: `${SETTINGS}/connections/server-sync-panel.tsx`,
    api: "POST /api/server-sync/reconcile",
    actor: "owner",
    modes: ["hybrid", "cloud"],
    domain: "operational events (dead letters)",
    direction: "none",
    effect: "Archives one dead letter with the actor recorded; the event is not re-applied.",
    outcome: "optimistic",
    findings: ["F2"],
  },
  {
    id: "auto.server-sync-tick",
    kind: "automatic",
    category: "cloud_site_data_sync",
    label: null,
    source: "server.ts",
    alsoIn: ["src/lib/server-sync.ts", "src/lib/sync-wake-service.ts", "src/lib/iam/sync.ts"],
    api: null,
    actor: "system (site process)",
    modes: ["hybrid"],
    domain: "master data, push, pull, IAM",
    direction: "both",
    effect:
      "Every 30 s (single-flight; woken early by local NOTIFY and the central long-poll): IAM first, then master data, push and pull. A failing security plane holds the rest back and is recorded as an operational block.",
    outcome: "reported",
    findings: ["F3"],
  },
  {
    id: "auto.central-maintenance",
    kind: "automatic",
    category: "cloud_site_data_sync",
    label: null,
    source: "server.ts",
    api: null,
    actor: "system (central process)",
    modes: ["cloud"],
    domain: "operational events (deferred inbox, pairing sessions)",
    direction: "local_reapply",
    effect: "Retries site events the central deferred and expires abandoned pairing sessions.",
    outcome: "none",
  },
  {
    id: "auto.runtime-status-report",
    kind: "automatic",
    category: "cloud_site_data_sync",
    label: null,
    source: "src/lib/app-update.ts",
    api: "POST /api/server-sync/runtime-status",
    actor: "system (site credential)",
    modes: ["hybrid"],
    domain: "device telemetry (version, schema, update state)",
    direction: "site_to_cloud",
    effect: "Reports the installed build and updater state to the central so the fleet view is real; carries no business data.",
    outcome: "none",
  },
  // ---- Client offline queue / status feeds ---------------------------------
  {
    id: "settings.cloud-sync.refresh",
    kind: "button",
    category: "ui_reload",
    label: "به‌روزرسانی",
    source: `${SETTINGS}/cloud-sync-settings.tsx`,
    api: null,
    actor: "any signed-in member who can open the tab",
    modes: ["hybrid"],
    domain: "connection indicators",
    direction: "none",
    effect:
      "Dispatches the browser `online` event, so the connectivity probe and the browser queue flush run now. It does not start a server-sync push or pull.",
    outcome: "none",
    findings: ["F1", "F3"],
  },
  {
    id: "settings.sync-queue.retry",
    kind: "button",
    category: "client_offline_queue",
    label: "تلاش دوباره",
    source: `${SETTINGS}/sync-queue-panel.tsx`,
    alsoIn: ["src/app/dashboard/offline-queue.tsx"],
    api: null,
    actor: "any signed-in member",
    modes: ["hybrid", "local", "cloud"],
    domain: "browser-queued POS actions",
    direction: "browser_to_site",
    effect: "Marks one failed/conflicting IndexedDB entry pending again; the next flush posts it to this origin's /api/sync/events.",
    outcome: "none",
  },
  {
    id: "settings.sync-queue.discard",
    kind: "button",
    category: "client_offline_queue",
    label: "حذف از صف",
    source: `${SETTINGS}/sync-queue-panel.tsx`,
    alsoIn: ["src/app/dashboard/offline-queue.tsx"],
    api: null,
    actor: "any signed-in member",
    modes: ["hybrid", "local", "cloud"],
    domain: "browser-queued POS actions",
    direction: "none",
    effect: "Permanently deletes one failed/conflicting queued entry from this browser.",
    outcome: "none",
  },
  {
    id: "auto.client-queue-flush",
    kind: "automatic",
    category: "client_offline_queue",
    label: null,
    source: "src/app/dashboard/offline-queue.tsx",
    api: "POST /api/sync/events",
    actor: "signed-in session",
    modes: ["hybrid", "local", "cloud"],
    domain: "browser-queued POS actions",
    direction: "browser_to_site",
    effect:
      "Every 15 s and on every browser online/offline event: probe the origin, flush the IndexedDB queue to it, then read /api/connection/status for the banner.",
    outcome: "reported",
  },
  {
    id: "native.reconcile-request",
    kind: "automatic",
    category: "client_offline_queue",
    label: null,
    source: "src/components/native/native-device-registrar.tsx",
    api: "POST /api/sync/events",
    actor: "signed-in session (Android shell)",
    modes: ["android"],
    domain: "browser-queued POS actions",
    direction: "browser_to_site",
    effect: "Android's `sync.reconcileRequested` flushes the IndexedDB queue and acknowledges the real outcome to the native store.",
    outcome: "verified",
  },
  {
    id: "status.connection-feed",
    kind: "status_feed",
    category: "ui_reload",
    label: null,
    source: "src/app/dashboard/offline-queue.tsx",
    api: "GET /api/connection/status",
    actor: "signed-in session",
    modes: ["hybrid", "local", "cloud"],
    domain: "connection indicators",
    direction: "none",
    effect: "Read-only: local server / internet / cloud-sync / fault state behind the global banner and connectivity toasts.",
    outcome: "reported",
  },
  // ---- Activation refresh (Full Offline) -----------------------------------
  {
    id: "settings.cloud-sync.local-revalidate",
    kind: "button",
    category: "activation_refresh",
    label: "بررسی و به‌روزرسانی با ابر",
    source: `${SETTINGS}/cloud-sync-settings.tsx`,
    api: "POST /api/local-activation/status",
    actor: "settings.manage",
    modes: ["local"],
    domain: "activation record + business profile",
    direction: "cloud_to_site",
    effect: "Asks the Cloud to re-validate this install and refresh its business record. Moves no orders, payments, stock, customers or ledger (issue #974).",
    outcome: "verified",
  },
  {
    id: "settings.cloud-sync.local-enroll-existing",
    kind: "button",
    category: "activation_refresh",
    label: "فعال‌سازی امن نصب موجود (با حفظ کامل داده‌ها)",
    source: `${SETTINGS}/cloud-sync-settings.tsx`,
    api: "POST /api/local-activation/status",
    actor: "settings.manage",
    modes: ["local"],
    domain: "activation record",
    direction: "cloud_to_site",
    effect: "Enrols an already-initialised local install with a Full Offline token without touching local data.",
    outcome: "verified",
  },
  {
    id: "settings.cloud-sync.local-replace-token",
    kind: "button",
    category: "activation_refresh",
    label: "جایگزینی توکن فعال‌سازی",
    source: `${SETTINGS}/cloud-sync-settings.tsx`,
    api: "POST /api/local-activation/status",
    actor: "settings.manage",
    modes: ["local"],
    domain: "activation record",
    direction: "cloud_to_site",
    effect: "Replaces the activation token (and optionally the Cloud URL) after the Cloud validates it.",
    outcome: "verified",
  },
  {
    id: "auto.local-activation-validation",
    kind: "automatic",
    category: "activation_refresh",
    label: null,
    source: "server.ts",
    alsoIn: ["src/lib/local-activation-site-service.ts"],
    api: null,
    actor: "system (site process)",
    modes: ["local"],
    domain: "activation record + business profile",
    direction: "cloud_to_site",
    effect: "Every 60 s: Cloud validation and business refresh. Strictly separate from runServerSyncTick; a network outage never locks the install.",
    outcome: "reported",
  },
  {
    id: "local.status-readers",
    kind: "status_feed",
    category: "activation_refresh",
    label: null,
    source: "src/app/dashboard/local-offline-shell-guard.tsx",
    alsoIn: ["src/app/(app)/support/page.tsx", "src/components/bug-report/bug-report-dialog.tsx"],
    api: "GET /api/local-activation/status",
    actor: "signed-in session",
    modes: ["local"],
    domain: "activation record",
    direction: "none",
    effect:
      "Read (and, for remote-support consent and unsent-draft discard, act on) the activation record; the bug report dialog asks `?probe=1` whether the Cloud is reachable.",
    outcome: "reported",
  },
  {
    id: "settings.cloud-sync.local-convert",
    kind: "button",
    category: "pairing_enrollment",
    label: "درخواست تبدیل امن",
    source: `${SETTINGS}/cloud-sync-settings.tsx`,
    api: null,
    actor: "any member who can open the tab",
    modes: ["local"],
    domain: "deployment profile",
    direction: "none",
    effect: "A link to the support page; the conversion itself is the operator script. No preview or backup runs in product.",
    outcome: "none",
    findings: ["F7"],
  },
  // ---- Pairing / enrolment --------------------------------------------------
  {
    id: "welcome.hybrid.test-connection",
    kind: "button",
    category: "pairing_enrollment",
    label: "آزمایش اتصال",
    source: "src/app/welcome/pair-form.tsx",
    api: "POST /api/setup/pair/test",
    actor: "none (first launch)",
    modes: ["pre_pairing"],
    domain: "Cloud reachability",
    direction: "none",
    effect: "Probes the typed Cloud address; claims no pairing code.",
    outcome: "reported",
  },
  {
    id: "welcome.hybrid.pair",
    kind: "button",
    category: "pairing_enrollment",
    label: "اتصال و دریافت تنظیمات",
    source: "src/app/welcome/pair-form.tsx",
    api: "POST /api/setup/pair",
    actor: "none (first launch; the pairing code is the credential)",
    modes: ["pre_pairing"],
    domain: "pairing snapshot, IAM credentials",
    direction: "cloud_to_site",
    effect: "Redeems a pairing code, applies the snapshot, acknowledges, syncs IAM credentials and then asks for a local owner PIN.",
    outcome: "reported",
  },
  {
    id: "welcome.local.verify",
    kind: "button",
    category: "activation_refresh",
    label: "بررسی و تأیید",
    source: "src/app/welcome/page.tsx",
    api: "POST /api/setup/bootstrap",
    actor: "none (first launch; the Full Offline token is the credential)",
    modes: ["pre_pairing"],
    domain: "activation record",
    direction: "cloud_to_site",
    effect: "`verifyOnly`: checks the Cloud URL and Full Offline token and shows the business it names. Writes nothing.",
    outcome: "verified",
  },
  {
    id: "welcome.local.bootstrap",
    kind: "button",
    category: "pairing_enrollment",
    label: "ساخت و شروع راه‌اندازی",
    source: "src/app/welcome/page.tsx",
    api: "POST /api/setup/bootstrap",
    actor: "none (first launch)",
    modes: ["pre_pairing"],
    domain: "local business bootstrap",
    direction: "cloud_to_site",
    effect: "Activates the install and creates the local business, owner and industry from the typed fields.",
    outcome: "reported",
  },
  {
    id: "connections.desktop.generate-code",
    kind: "button",
    category: "pairing_enrollment",
    label: "ساخت کد اتصال",
    source: `${SETTINGS}/connections/desktop-panel.tsx`,
    api: "POST /api/connections/desktop",
    actor: "owner",
    modes: ["cloud"],
    domain: "pairing code",
    direction: "none",
    effect: "Issues a single-use Hybrid pairing code bound to a branch.",
    outcome: "reported",
  },
  {
    id: "connections.desktop.generate-local-token",
    kind: "button",
    category: "pairing_enrollment",
    label: "ساخت توکن تمام‌آفلاین (OFL1)",
    source: `${SETTINGS}/connections/desktop-panel.tsx`,
    api: "POST /api/connections/desktop",
    actor: "owner",
    modes: ["cloud"],
    domain: "Full Offline enrolment token",
    direction: "none",
    effect: "Issues a single-use Full Offline token; never interchangeable with a Hybrid pairing code.",
    outcome: "reported",
  },
  {
    id: "connections.desktop.repair",
    kind: "button",
    category: "pairing_enrollment",
    label: "اتصال دوباره",
    source: `${SETTINGS}/connections/desktop-panel.tsx`,
    api: "POST /api/setup/reconnect",
    actor: "owner",
    modes: ["hybrid"],
    domain: "pairing record",
    direction: "cloud_to_site",
    effect: "Rebinds an initialised desktop with a fresh pairing code without deleting local business data, queued events or users.",
    outcome: "reported",
  },
  {
    id: "connections.desktop.rotate",
    kind: "button",
    category: "pairing_enrollment",
    label: "چرخش اعتبارنامه",
    source: `${SETTINGS}/connections/desktop-panel.tsx`,
    api: "PATCH /api/connections/desktop",
    actor: "owner (behind a confirmation dialog)",
    modes: ["cloud"],
    domain: "site device credential",
    direction: "none",
    effect: "Rotates the paired device's sync credential; the site picks the new one up through the credential-rotation handshake.",
    outcome: "reported",
  },
  {
    id: "connections.desktop.revoke",
    kind: "button",
    category: "pairing_enrollment",
    label: "لغو دستگاه",
    source: `${SETTINGS}/connections/desktop-panel.tsx`,
    api: "PATCH /api/connections/desktop",
    actor: "owner (behind a confirmation dialog)",
    modes: ["cloud"],
    domain: "site device credential",
    direction: "none",
    effect: "Revokes the paired device; its next sync call is refused.",
    outcome: "reported",
  },
  {
    id: "team.iam-card.detach",
    kind: "button",
    category: "pairing_enrollment",
    label: "تبدیل به مدیریت محلی",
    source: "src/components/team/iam-sync-card.tsx",
    api: "POST /api/team/detach-site",
    actor: "owner (behind a confirmation dialog)",
    modes: ["hybrid"],
    domain: "identity ownership",
    direction: "none",
    effect: "Detaches the site from Cloud-managed identity so team and PINs are managed locally. Not a sync.",
    outcome: "reported",
  },
  // ---- Software update ------------------------------------------------------
  {
    id: "settings.desktop-update.check",
    kind: "button",
    category: "software_update",
    label: "بررسی دوباره",
    source: `${SETTINGS}/desktop-update-settings.tsx`,
    api: "POST /api/desktop-update/check",
    actor: "owner",
    modes: ["hybrid", "local"],
    domain: "signed release manifest",
    direction: "cloud_to_site",
    effect: "Forces a real release check (PR #1015). Says nothing about whether business data is synchronized.",
    outcome: "reported",
  },
  {
    id: "settings.desktop-update.download",
    kind: "ipc",
    category: "software_update",
    label: "دانلود",
    source: `${SETTINGS}/desktop-update-settings.tsx`,
    alsoIn: ["electron/preload.js", "electron/main.js", "electron/update-policy.js"],
    api: "desktop:update-download",
    actor: "owner at the till (trusted-sender IPC)",
    modes: ["hybrid", "local"],
    domain: "signed installer",
    direction: "cloud_to_site",
    effect: "Downloads and verifies the signed installer; pause, cancel and resume use the sibling `desktop:update-*` channels.",
    outcome: "reported",
    findings: ["F8"],
  },
  {
    id: "settings.desktop-update.install-now",
    kind: "ipc",
    category: "software_update",
    label: "پشتیبان، راه‌اندازی دوباره و نصب",
    source: `${SETTINGS}/desktop-update-settings.tsx`,
    alsoIn: ["electron/preload.js", "electron/main.js"],
    api: "desktop:update-install-now",
    actor: "owner at the till (trusted-sender IPC)",
    modes: ["hybrid", "local"],
    domain: "signed installer",
    direction: "none",
    effect: "Backs up, restarts and installs the already-downloaded, verified installer.",
    outcome: "reported",
  },
  {
    id: "settings.desktop-update.offline-package",
    kind: "ipc",
    category: "software_update",
    label: "بستهٔ آفلاین",
    source: `${SETTINGS}/desktop-update-settings.tsx`,
    alsoIn: ["electron/preload.js", "electron/main.js"],
    api: "desktop:update-offline",
    actor: "owner at the till (trusted-sender IPC)",
    modes: ["hybrid", "local"],
    domain: "signed installer",
    direction: "none",
    effect: "Verifies a signed installer chosen from disk instead of downloading one.",
    outcome: "reported",
  },
  {
    id: "platform.updates.recheck",
    kind: "button",
    category: "software_update",
    label: "بررسی دوباره",
    source: "src/app/platform/updates/page.tsx",
    api: "POST /api/platform/updates/commands",
    actor: "platform capability updates.manage (reason required, audited)",
    modes: ["platform"],
    domain: "signed release manifest",
    direction: "cloud_to_site",
    effect: "Queues a `recheck` for one device; delivery is not execution and the status changes on the device's next call.",
    outcome: "reported",
    findings: ["F5"],
  },
  {
    id: "platform.updates.download-now",
    kind: "button",
    category: "software_update",
    label: "دانلود اکنون",
    source: "src/app/platform/updates/page.tsx",
    api: "POST /api/platform/updates/commands",
    actor: "platform capability updates.manage (reason required, audited)",
    modes: ["platform"],
    domain: "signed installer",
    direction: "cloud_to_site",
    effect: "Queues a `download_now` for one device; same delivery semantics as `recheck`.",
    outcome: "reported",
    findings: ["F5"],
  },
  // ---- Third-party integration sync -----------------------------------------
  {
    id: "wp.woo.sync-products",
    kind: "button",
    category: "integration_sync",
    label: "همگام‌سازی محصولات",
    source: "src/app/(app)/websites/wp/catalogue-section.tsx",
    api: "POST /api/integrations/connections/[id]/sync/products",
    actor: "integrations (WordPress manager)",
    modes: ["cloud", "hybrid"],
    domain: "WooCommerce products",
    direction: "third_party_to_site",
    effect: "Pulls the store's catalogue in REST mode, or queues the plugin's pull in plugin mode.",
    outcome: "reported",
  },
  {
    id: "wp.woo.sync-orders",
    kind: "button",
    category: "integration_sync",
    label: "همگام‌سازی سفارش‌ها",
    source: "src/app/(app)/websites/wp/orders-section.tsx",
    api: "POST /api/integrations/connections/[id]/sync/orders",
    actor: "integrations (WordPress manager)",
    modes: ["cloud", "hybrid"],
    domain: "WooCommerce orders",
    direction: "third_party_to_site",
    effect: "Pulls the store's orders in REST mode, or queues the plugin's pull in plugin mode.",
    outcome: "reported",
  },
  {
    id: "wp.woo.sync-orders-settings",
    kind: "button",
    category: "integration_sync",
    label: "همگام‌سازی سفارش‌ها",
    source: "src/app/(app)/websites/wp/woo-store-sections.tsx",
    api: "POST /api/integrations/connections/[id]/sync/orders",
    actor: "integrations (WordPress manager)",
    modes: ["cloud", "hybrid"],
    domain: "WooCommerce orders",
    direction: "third_party_to_site",
    effect: "Pulls the store's orders for the lookback window chosen on the sync-settings screen.",
    outcome: "reported",
  },
  {
    id: "wp.woo.retry-product",
    kind: "button",
    category: "integration_sync",
    label: "تلاش دوبارهٔ ارسال",
    source: "src/app/(app)/websites/wp/catalogue-section.tsx",
    api: "POST /api/integrations/connections/[id]/store/products/retry",
    actor: "integrations (WordPress manager)",
    modes: ["cloud", "hybrid"],
    domain: "WooCommerce product outbox",
    direction: "site_to_third_party",
    effect: "Re-arms one failed product in the outbox; the queue page shows what was re-armed.",
    outcome: "reported",
  },
  {
    id: "wp.woo.reload",
    kind: "button",
    category: "ui_reload",
    label: "تازه‌سازی",
    source: "src/app/(app)/websites/wp/catalogue-section.tsx",
    api: null,
    actor: "integrations (WordPress manager)",
    modes: ["cloud", "hybrid"],
    domain: "WooCommerce product mirror",
    direction: "none",
    effect: "Re-reads the local mirror of the store; contacts the store only through the sync buttons beside it.",
    outcome: "none",
  },
  {
    id: "wp.woo.sync-customers",
    kind: "button",
    category: "integration_sync",
    label: "همگام‌سازی مشتریان",
    source: "src/app/(app)/websites/wp/woocommerce-connection-panel.tsx",
    alsoIn: ["src/app/(app)/websites/wp/customers-section.tsx", "src/app/(app)/websites/wp/overview-section.tsx"],
    api: "POST /api/integrations/connections/[id]/sync/customers",
    actor: "integrations (WordPress manager)",
    modes: ["cloud", "hybrid"],
    domain: "WooCommerce customers",
    direction: "third_party_to_site",
    effect: "Pulls customers from the store; the overview and customers screens poll a queued plugin-mode sync for its real outcome.",
    outcome: "reported",
  },
  {
    id: "wp.woo.push-inventory",
    kind: "button",
    category: "integration_sync",
    label: "ارسال موجودی و قیمت",
    source: "src/app/(app)/websites/wp/woocommerce-connection-panel.tsx",
    api: "POST /api/integrations/connections/[id]/sync/inventory",
    actor: "integrations (WordPress manager)",
    modes: ["cloud", "hybrid"],
    domain: "WooCommerce stock and price",
    direction: "site_to_third_party",
    effect: "Pushes stock and price to the store; the store never writes them back.",
    outcome: "reported",
  },
  {
    id: "wp.queue.retry",
    kind: "button",
    category: "integration_sync",
    label: "تلاش مجدد",
    source: "src/app/(app)/websites/wp/queue-section.tsx",
    api: "POST /api/integrations/wp-manager/queue",
    actor: "integrations (WordPress manager)",
    modes: ["cloud", "hybrid"],
    domain: "WooCommerce outbox / inbox queue",
    direction: "site_to_third_party",
    effect: "Re-queues one failed row (`action: retry`); a row that has already moved on is refused with its current status.",
    outcome: "reported",
  },
  {
    id: "cms.sync-now",
    kind: "button",
    category: "integration_sync",
    label: "همگام‌سازی اکنون",
    source: "src/app/(app)/websites/cms/cms-sync-settings.tsx",
    api: "POST /api/connections/website/sync",
    actor: "cms.configure",
    modes: ["cloud", "hybrid"],
    domain: "Eshobe CMS products (one-way, shop window)",
    direction: "site_to_third_party",
    effect: "Drains the website outbox now; values are read from the database at send time and the site never writes back.",
    outcome: "reported",
  },
  {
    id: "cms.queue.retry",
    kind: "button",
    category: "integration_sync",
    label: "تلاش مجدد",
    source: "src/app/(app)/websites/cms/cms-sync-settings.tsx",
    api: "POST /api/connections/website/queue/[id]/retry",
    actor: "cms.configure",
    modes: ["cloud", "hybrid"],
    domain: "Eshobe CMS outbox",
    direction: "site_to_third_party",
    effect: "Re-arms one failed or dead website outbox row.",
    outcome: "reported",
  },
] as const;

/** Looks a control up by id. */
export function syncControlById(id: string): SyncControl | undefined {
  return SYNC_CONTROLS.find((control) => control.id === id);
}

/**
 * Controls that may truthfully be described to a user as moving data between
 * the Cloud and this site. Anything else must not borrow the words «همگام»,
 * «sync», «send» or «receive» in a way that implies it.
 */
export function controlsThatMoveCloudSiteData(): SyncControl[] {
  return SYNC_CONTROLS.filter(
    (control) =>
      control.category === "cloud_site_data_sync" &&
      control.direction !== "none" &&
      control.direction !== "local_reapply",
  );
}

/** The API route file for an `METHOD /api/...` string, or null for non-HTTP/none. */
export function routeFileForApi(api: string | null): string | null {
  if (!api) return null;
  const match = /^(?:GET|POST|PUT|PATCH|DELETE) (\/api\/\S+)$/.exec(api);
  if (!match) return null;
  return `src/app/api${match[1].slice("/api".length)}/route.ts`;
}

function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/**
 * The matrix as Markdown. `docs/architecture/sync-controls-inventory.md` is
 * this output verbatim, so the reviewable document cannot drift from the data
 * the test checks.
 */
export function renderSyncControlsMarkdown(): string {
  const lines: string[] = [];
  lines.push("<!-- Generated by `npx tsx scripts/render-sync-controls-inventory.ts` from src/lib/sync-controls-inventory.ts. Do not edit by hand. -->");
  lines.push("");
  lines.push("# Cloud ↔ Desktop sync, refresh and update controls");
  lines.push("");
  lines.push(
    "Issue #1115, workstream **P0 — Controls inventory + owner UX contract**. Every control below that touches the Cloud ↔ Windows boundary is classified by what it really does. `src/lib/sync-controls-inventory.ts` is the source; `src/lib/sync-controls-inventory.test.ts` fails when a listed file, route or label disappears, when a UI or Electron file that calls a sync, activation, pairing or update endpoint is not listed, or when this page is stale.",
  );
  lines.push("");
  lines.push("## Scope and limits");
  lines.push("");
  lines.push("- Covered: every `src/app` / `src/components` file and Electron file that calls a Cloud ↔ site, activation, pairing, update, browser-queue or integration-sync endpoint, plus the scheduled jobs in `server.ts` that move data.");
  lines.push("- Not enumerated one by one: module-level «reload this list» buttons (`load()` / «تازه‌سازی» on a screen that only re-reads its own API). They are `ui_reload`, call no endpoint above, and are not part of the replication contract. One WooCommerce example is listed.");
  lines.push("- A static audit, not a runtime interaction matrix. Packaged-app click-through of each control belongs to the epic's E2E workstream.");
  lines.push("- Nothing here is changed by this inventory. Where a control does less than its label suggests it is recorded as a finding.");
  lines.push("");
  lines.push("## Categories");
  lines.push("");
  for (const category of SYNC_CONTROL_CATEGORIES) {
    const count = SYNC_CONTROLS.filter((control) => control.category === category).length;
    lines.push(`- \`${category}\` (${count}) — ${SYNC_CONTROL_CATEGORY_LABELS[category]}`);
  }
  lines.push("");
  lines.push("## Findings");
  lines.push("");
  lines.push("| Id | Severity | Finding | Owning workstream |");
  lines.push("|---|---|---|---|");
  for (const finding of SYNC_CONTROL_FINDINGS) {
    lines.push(`| ${finding.id} | ${finding.severity} | ${cell(finding.summary)} | ${cell(finding.workstream)} |`);
  }
  lines.push("");
  for (const category of SYNC_CONTROL_CATEGORIES) {
    const rows = SYNC_CONTROLS.filter((control) => control.category === category);
    if (rows.length === 0) continue;
    lines.push(`## ${SYNC_CONTROL_CATEGORY_LABELS[category]}`);
    lines.push("");
    lines.push("| Id | Kind | Label | API / channel | Actor | Modes | Domain | Direction | Effect | Result | Findings | Source |");
    lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (const control of rows) {
      const sources = [control.source, ...(control.alsoIn ?? [])].map((file) => `\`${file}\``).join("<br>");
      lines.push(
        `| \`${control.id}\` | ${control.kind} | ${control.label ? `«${cell(control.label)}»` : "—"} | ${control.api ? `\`${cell(control.api)}\`` : "—"} | ${cell(control.actor)} | ${control.modes.join(", ")} | ${cell(control.domain)} | ${control.direction} | ${cell(control.effect)} | ${control.outcome} | ${control.findings?.join(", ") ?? "—"} | ${sources} |`,
      );
    }
    lines.push("");
  }
  return `${lines.join("\n")}`;
}
