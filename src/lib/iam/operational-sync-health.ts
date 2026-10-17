/**
 * The vocabulary of Hybrid *operational* gating, kept pure so the sync tick,
 * the status APIs, the connection panel and the device fleet all agree on what
 * a blocked install means.
 *
 * `runIamSync()` is the security control plane, and it deliberately holds
 * everything else back: while it fails, `runServerSyncTick()` skips master
 * data, the site profile, push and pull, so sales taken on the till queue up
 * locally and nothing reaches the cloud. That gate stays exactly where it is —
 * the defect issue #988 is about was that the *only* trace of a blocked tick
 * was one `console.error` line, which is why a real install ran like that for
 * nine days (1 092 log lines) with every health surface saying healthy.
 *
 * So this module answers the one question a log line cannot: is operational
 * traffic being gated *now*, for how long, and is it worth waking somebody?
 * Its sibling `credential-health.ts` does the same for the identity plane;
 * "identity converged" and "operational sync flowing" are separate facts and
 * are never merged into one badge.
 *
 * Nothing here touches the database — the durable half is
 * `operational-sync-block.ts`, and the two rules that decide what an operator
 * sees (how a failure is classified, and when a block is loud enough to alert)
 * live here so they can be tested without a Postgres.
 */

/** Row state of `iam_operational_sync_block_state`. */
export const OPERATIONAL_SYNC_BLOCK_STATUSES = ["clear", "blocked"] as const;
export type OperationalSyncBlockStatus = (typeof OPERATIONAL_SYNC_BLOCK_STATUSES)[number];

export function isOperationalSyncBlockStatus(value: unknown): value is OperationalSyncBlockStatus {
  return typeof value === "string" && (OPERATIONAL_SYNC_BLOCK_STATUSES as readonly string[]).includes(value);
}

/**
 * How many blocked ticks in a row make the block worth a notification.
 *
 * The tick runs every 30 s, so ten of them is five minutes of a till quietly
 * taking sales that cannot reach the cloud — long enough that a brief cloud
 * blip (a restart, one refused request that the next tick recovers from) never
 * buzzes an owner, short enough that nobody has to notice a nine-day outage by
 * accident. The count is consecutive, not total, so an install that converges
 * between two blocked ticks starts over and never alerts.
 */
export const OPERATIONAL_SYNC_ALERT_AFTER_TICKS = 10;

/**
 * Why the security plane refused to let operational traffic start.
 *
 * A blocked tick is actionable in three different ways — fix the network,
 * re-pair the install, or call support about a suspension — and a raw
 * `TypeError: fetch failed` vs `events_http_403` is the difference between them.
 * The code is what a surface displays; the message stays in `last_error` for
 * support, never on screen.
 */
export const IAM_FAILURE_CODES = [
  "not_configured",
  /**
   * Not an IAM answer at all: the site credential the cloud is mid-way through
   * rotating has not been handed over, and `refreshStagedSiteCredential()`
   * closes the gate for that reason. It belongs in this vocabulary because the
   * tick cannot tell the two apart from the outside — both mean "operational
   * traffic is being held back" — and a fleet that reads `sync_error` for a
   * staged rotation would send the owner to the wrong fix.
   */
  "credential_rotation_pending",
  "unauthorized",
  "forbidden",
  "unsupported_cloud",
  "cloud_error",
  "transport",
  "timeout",
  "sequence_gap",
  "contract_mismatch",
  "sync_error",
] as const;
export type IamFailureCode = (typeof IAM_FAILURE_CODES)[number];

export function isIamFailureCode(value: unknown): value is IamFailureCode {
  return typeof value === "string" && (IAM_FAILURE_CODES as readonly string[]).includes(value);
}

/**
 * Classify the caught error of a failed IAM reconciliation.
 *
 * `runIamSync()` throws `snapshot_http_<status>` / `events_http_<status>` /
 * `drift_snapshot_http_<status>` for an HTTP answer it did not accept,
 * `sequence_gap:<expected>:<received>` for a hole in the event stream,
 * the sync tick itself reports `site_credential_rotation_pending` when the
 * staged site credential has not been handed over,
 * `<something>_checksum_mismatch` / `snapshot_identity_mismatch` for a payload
 * that does not describe this site, and anything else the network or the
 * apply-step produced. The order below matters: a gap and a mismatch are
 * contract facts that a retry cannot fix, so they are read before the generic
 * HTTP/transport buckets — while a *drift-check fetch* (`drift_snapshot_http_404`)
 * is still an HTTP answer about the cloud's endpoint, so the drift rule matches
 * the code `mark()` records instead of the word anywhere.
 */
export function classifyIamFailure(message: string | null | undefined): IamFailureCode {
  const text = (message ?? "").trim();
  if (!text) return "sync_error";
  const lower = text.toLowerCase();
  if (lower === "not_configured" || lower === "sync_not_configured" || lower === "iam_not_configured") {
    return "not_configured";
  }
  if (lower.startsWith("sequence_gap")) return "sequence_gap";
  if (lower.includes("credential_checksum") || lower.includes("checksum_mismatch") || lower.includes("identity_mismatch") || lower.includes("iam_drift_detected")) {
    return "contract_mismatch";
  }
  // The gate's own words for "a rotation is still open", matched exactly: the
  // HTTP refusals this step can also report (`credential_rotation_http_500`)
  // are a cloud answer, not a waiting hand-off, and must classify as one.
  if (lower === "site_credential_rotation_pending" || lower === "credential_unsettled") {
    return "credential_rotation_pending";
  }
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("etimedout") || lower.includes("aborterror")) {
    return "timeout";
  }
  const httpStatus = /http_(\d{3})/.exec(lower)?.[1];
  if (httpStatus) {
    const status = Number(httpStatus);
    if (status === 401) return "unauthorized";
    if (status === 403) return "forbidden";
    if (status === 404 || status === 405) return "unsupported_cloud";
    if (status >= 500) return "cloud_error";
    return "sync_error";
  }
  if (
    lower.includes("fetch failed") || lower.includes("econnrefused") || lower.includes("econnreset")
    || lower.includes("enotfound") || lower.includes("eai_again") || lower.includes("ehostunreach")
    || lower.includes("enetunreach") || lower.includes("socket hang up") || lower.includes("network")
  ) {
    return "transport";
  }
  return "sync_error";
}

/** What an operator is told, per code. Never a raw error string. */
export const IAM_FAILURE_LABELS: Record<IamFailureCode, string> = {
  not_configured: "همگام‌سازی ابری این دستگاه تنظیم نشده است.",
  credential_rotation_pending: "اعتبارنامهٔ اتصال این دستگاه در حال چرخش است و سرور ابری هنوز آن را تأیید نکرده؛ تا تأیید، داده‌ای فرستاده نمی‌شود.",
  unauthorized: "اعتبارنامهٔ اتصال این دستگاه توسط سرور ابری پذیرفته نشد؛ باید دوباره وصل یا اعتبارنامه چرخانده شود.",
  forbidden: "دسترسی این دستگاه روی سرور ابری محدود شده است (تعلیق یا لغو اشتراک).",
  unsupported_cloud: "سرور ابری از همگام‌سازی امنیتی پشتیبانی نمی‌کند؛ نسخهٔ سرور باید به‌روزرسانی شود.",
  cloud_error: "سرور ابری در دریافت وضعیت امنیتی خطا داد.",
  transport: "سرور ابری در دسترس نیست؛ اتصال اینترنت و آدرس سرور را بررسی کنید.",
  timeout: "پاسخ سرور ابری به موقع نرسید.",
  sequence_gap: "ترتیب رویدادهای امنیتی روی این دستگاه با سرور ابری هم‌خوان نیست و همگام‌سازی کامل لازم دارد.",
  contract_mismatch: "دادهٔ امنیتی دریافتی با این دستگاه هم‌خوان نیست؛ همگام‌سازی کامل لازم است.",
  sync_error: "همگام‌سازی امنیتی ناموفق بود.",
};

/** The stored episode, as the row holds it before this tick. */
export interface OperationalBlockBefore {
  /** Null when this `(business_id, site_device_id)` has no row at all yet. */
  readonly status: OperationalSyncBlockStatus | null;
  readonly consecutiveBlockedTicks: number;
  readonly totalBlockedTicks: number;
  readonly episodesBlocked: number;
  /** True once the alert for the current episode has been raised. */
  readonly alerted: boolean;
}

/** The row to write for one blocked tick — the counting rules, decided in one place. */
export interface OperationalBlockWrite {
  consecutiveBlockedTicks: number;
  totalBlockedTicks: number;
  episodesBlocked: number;
  /** True when this tick *opens* an episode, so `first_blocked_at` is re-stamped. */
  startsEpisode: boolean;
  /** True when this tick is the one that raises the alert — at most once per episode. */
  alertDue: boolean;
}

const NO_EPISODE: OperationalBlockBefore = {
  status: null,
  consecutiveBlockedTicks: 0,
  totalBlockedTicks: 0,
  episodesBlocked: 0,
  alerted: false,
};

/**
 * One blocked tick, as the state machine that owns it.
 *
 * Kept pure and exported so the two rules people get wrong are the ones under
 * test: the consecutive count must reset when the episode ended (a `clear` row
 * is a new episode, not "+1"), and the alert must fire once per episode rather
 * than once per tick for nine days — which is how the log line this replaces
 * behaved.
 */
export function nextBlockedWrite(
  before: Partial<OperationalBlockBefore> | null | undefined,
  alertAfterTicks: number = OPERATIONAL_SYNC_ALERT_AFTER_TICKS,
): OperationalBlockWrite {
  const prior = { ...NO_EPISODE, ...(before ?? {}) };
  const inEpisode = prior.status === "blocked";
  const consecutiveBlockedTicks = inEpisode ? Math.max(1, prior.consecutiveBlockedTicks + 1) : 1;
  return {
    consecutiveBlockedTicks,
    totalBlockedTicks: prior.totalBlockedTicks + 1,
    episodesBlocked: inEpisode ? prior.episodesBlocked : prior.episodesBlocked + 1,
    startsEpisode: !inEpisode,
    alertDue: consecutiveBlockedTicks >= alertAfterTicks && !(inEpisode && prior.alerted),
  };
}

export type OperationalSyncHealth = "healthy" | "blocked" | "not_configured";

export interface OperationalSyncHealthInput {
  /** This install is a paired Hybrid site with a usable sync credential. */
  configured: boolean;
  block: {
    status: OperationalSyncBlockStatus;
    consecutiveBlockedTicks?: number;
    lastCode?: string | null;
  } | null;
}

/**
 * The shape the status APIs hand a screen for the operational gate.
 *
 * Typed here because three surfaces render it (the connection badge, the
 * cloud-and-sync card and the desktop fleet) and a field only any one of them
 * needs is how a plane ends up visible on one screen and invisible on the
 * others — the failure mode this issue is about.
 */
export interface OperationalSyncBlockView {
  state: OperationalSyncHealth;
  blocked: boolean;
  /** Past `OPERATIONAL_SYNC_ALERT_AFTER_TICKS` — worth a support ticket. */
  alertDue: boolean;
  consecutiveBlockedTicks: number;
  blockedSince: string | null;
  lastBlockedAt: string | null;
  lastRecoveredAt: string | null;
  code: IamFailureCode | null;
  /** Raw caught message, for support tooling only; screens render `code`. */
  lastError: string | null;
  pendingOutbox: number;
  episodesBlocked: number;
}

export interface OperationalSyncHealthResult {
  state: OperationalSyncHealth;
  /** The block has run long enough to warrant an alert / support escalation. */
  alertDue: boolean;
  /** How many ticks in a row were gated; 0 unless blocked. */
  consecutiveBlockedTicks: number;
  code: IamFailureCode | null;
  /** Machine-readable, e.g. `operational_sync_blocked:forbidden`. */
  reason: string | null;
}

/**
 * Is operational sync flowing?
 *
 * Absence of a row means "never gated", not "unknown": the block record is
 * written by the tick itself, so a paired site that has always converged simply
 * has nothing to show. A local install is `not_configured` for the same reason
 * the identity resolver gives it — it never joined a cloud it could be blocked
 * by.
 */
export function operationalSyncHealth(input: OperationalSyncHealthInput): OperationalSyncHealthResult {
  if (!input.configured) {
    return { state: "not_configured", alertDue: false, consecutiveBlockedTicks: 0, code: null, reason: null };
  }
  const block = input.block;
  if (!block || block.status !== "blocked") {
    return { state: "healthy", alertDue: false, consecutiveBlockedTicks: 0, code: null, reason: null };
  }
  const ticks = Math.max(0, block.consecutiveBlockedTicks ?? 0);
  const code: IamFailureCode = isIamFailureCode(block.lastCode) ? block.lastCode : "sync_error";
  return {
    state: "blocked",
    alertDue: ticks >= OPERATIONAL_SYNC_ALERT_AFTER_TICKS,
    consecutiveBlockedTicks: ticks,
    code,
    reason: `operational_sync_blocked:${code}`,
  };
}

/**
 * The sentence every fleet surface shows for a blocked install.
 *
 * Built here rather than at each call site so the owner's desktop panel, the
 * super-admin fleet and the cloud-and-sync card cannot drift into describing the
 * same condition three different ways. `since` arrives already Shamsi-formatted:
 * localising a timestamp is the caller's job (and it must never be skipped —
 * an ISO date in this sentence is the bug the repo's date rule exists to
 * prevent), while the wording is this module's.
 */
export function operationalSyncBlockedSummary(input: {
  /** Localised "blocked since" text, or null when the episode has no start yet. */
  since: string | null;
  pendingOutbox: number;
  code?: IamFailureCode | null;
}): string {
  const parts = [
    "همگام‌سازی عملیاتی این دستگاه مسدود است؛ فروش ثبت‌شده روی صندوق تا برقراری همگام‌سازی امنیتی به ابر فرستاده نمی‌شود.",
  ];
  if (input.since) parts.push(`از ${input.since}.`);
  const pending = Math.max(0, input.pendingOutbox);
  if (pending > 0) parts.push(`${pending.toLocaleString("fa-IR")} رویداد در انتظار ارسال.`);
  if (input.code && IAM_FAILURE_LABELS[input.code]) parts.push(IAM_FAILURE_LABELS[input.code]);
  return parts.join(" ");
}

/** One-line operator text for a connection/fleet row. */
export function operationalSyncBlockLabel(state: OperationalSyncHealth): string {
  switch (state) {
    case "healthy": return "جاری";
    case "blocked": return "مسدود";
    case "not_configured": return "تنظیم نشده";
  }
}
