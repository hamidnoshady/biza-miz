/**
 * Issue #839 §19 / Wave 6 — what a **paired** desktop may do with a car, and
 * what it may only *ask* the cloud to do.
 *
 * ## The decision this file records
 *
 * A hybrid site (a paired dealership laptop) holds a **read-only mirror** of its
 * branch's vehicle stock and may queue exactly two kinds of *request* — hold a
 * car for a customer, and release a hold this branch already placed. Everything
 * else that names a physical car stays with the cloud, because these are the
 * two operations whose correctness a site can actually preserve:
 *
 *   * **Nothing financial is decided locally.** A reservation's deposit and a
 *     sale's revenue/COGS/tax are ledger effects; a ledger effect written by a
 *     disconnected site cannot be checked against period locks, tax
 *     configuration, invoice numbering or a second branch's conflicting claim.
 *     A queued *request* carries no posting: the cloud applies it through the
 *     canonical service (`reserveVehicle`, `releaseVehicleReservation`) in one
 *     transaction, and only then is a deposit a liability and a hold a hold.
 *   * **The site never decides who gets the car.** Two sites can ask for the
 *     same VIN while both are offline. The cloud's `FOR UPDATE` on the unit
 *     plus `serial_reservations`'s one-active-hold-per-serial partial unique
 *     index pick the winner; the loser's request is recorded as a **conflict**
 *     with a reason an operator can act on — never overwritten, never merged.
 *   * **Sales are not offline-finalizable.** `offlineSaleFinalization` is
 *     `false` by type, not by convention: a sale moves a car out of stock and
 *     posts revenue, COGS and tax, and there is no version of that which is
 *     safe to invent on a laptop and reconcile later. A site without a cloud
 *     link shows the car as sold-or-not-sold truthfully (the mirror) and says
 *     so, rather than printing a document it cannot honour.
 *
 * This module is the framework-free half (like `automotive.ts` is for the
 * domain): the capability decision, the request shape, the replay/conflict
 * classification and the mirror's freshness rules. The DB-touching halves live
 * in `automotive-stock-service.ts`; the transport is the shipped site-profile
 * pattern (`GET /api/server-sync/automotive-stock`) so no second synchronisation
 * engine exists.
 *
 * **No last-write-wins anywhere on this path.** The mirror is replaced whole
 * from a cloud snapshot; a request is applied once, by the cloud, or refused
 * with a reason; a conflict is a row an operator resolves, not a silent merge.
 */
import type { VehicleState } from "./automotive";
import type { DeploymentProfile } from "./deployment-mode";
import type { DeploymentRole } from "./deployment-role";

/**
 * How far behind a mirror may fall before the counter is told it is stale.
 * The desktop sync tick runs every 30 s (`SERVER_SYNC_INTERVAL_MS`) and the
 * mirror's own tick is the same cadence, so two missed ticks is already worth
 * a warning: a car sold two minutes ago must not look available.
 */
export const AUTOMOTIVE_MIRROR_STALE_AFTER_MS = 120_000;

export type AutomotiveOfflineMode =
  /** This install is the system of record (Local profile): the whole module works here. */
  | "local_authority"
  /** A paired site: read the mirror, queue requests, never decide a hold itself. */
  | "read_only_mirror"
  /** The cloud/central role: it IS the authority, nothing is queued. */
  | "cloud_authority";

export interface AutomotiveOfflineCapability {
  mode: AutomotiveOfflineMode;
  /** Read the branch's vehicle stock from local storage (the mirror, or the real tables). */
  localStockReads: boolean;
  /** Create a reservation *request* the cloud must confirm before it is a hold. */
  reservationRequests: boolean;
  /** Release a hold this branch placed, as a request the cloud confirms. */
  releaseRequests: boolean;
  /** Always false: a sale's revenue/COGS/tax are never invented offline. */
  offlineSaleFinalization: false;
  /** Always false: acquisition and landed cost post to inventory/ledger. */
  offlineAcquisition: false;
  /**
   * Always false (issue #963): a trade-in is a sale *and* an acquisition in
   * one concurrency-sensitive act, decided by A's sold-once lock and B's
   * identity uniqueness, both cloud facts. It is not a third queueable
   * request type — a paired site shows it as cloud-only.
   */
  offlineTradeIn: false;
  /** The one-line answer the UI shows next to the vehicle board. */
  label: string;
  reason: string;
}

/**
 * Pure capability resolution. Same three inputs the rest of the platform uses:
 * the business's deployment profile, this *process*'s runtime role, and
 * nothing else — connectivity is a runtime state (`connection-state.ts`) and is
 * deliberately not consulted, because a decision about *authority* must not
 * change when the Wi-Fi drops.
 */
export function resolveAutomotiveOfflineCapability(input: {
  profile: DeploymentProfile;
  runtimeRole: DeploymentRole;
}): AutomotiveOfflineCapability {
  if (input.profile === "local") {
    return {
      mode: "local_authority",
      localStockReads: true,
      reservationRequests: false,
      releaseRequests: false,
      offlineSaleFinalization: false,
      offlineAcquisition: false,
      offlineTradeIn: false,
      label: "میزبانی محلی — این نسخهٔ سیستم مرجع خودروهاست",
      reason:
        "این نصب در حالت محلی کار می‌کند: خودروها، رزروها و اسناد همین‌جا ثبت و نگهداری می‌شوند و چیزی برای همگام‌سازی وجود ندارد.",
    };
  }
  if (input.runtimeRole === "central") {
    return {
      mode: "cloud_authority",
      localStockReads: true,
      reservationRequests: false,
      releaseRequests: false,
      offlineSaleFinalization: false,
      offlineAcquisition: false,
      offlineTradeIn: false,
      label: "ابری — مرجع خودروها همین سرور است",
      reason:
        "این سرور مرکزی، مرجع خودروها، رزروها و اسناد مالی است؛ درخواستی برای تأیید وجود ندارد.",
    };
  }
  return {
    mode: "read_only_mirror",
    localStockReads: true,
    reservationRequests: true,
    releaseRequests: true,
    offlineSaleFinalization: false,
    offlineAcquisition: false,
    offlineTradeIn: false,
    label: "همگام‌شده (خواندنی) — رزرو فقط با تأیید سرور",
    reason:
      "موجودی خودرو از سرور مرکزی همگام می‌شود و فقط خواندنی است. رزرو و آزادسازی به‌صورت درخواست ذخیره و پس از تأیید سرور قطعی می‌شوند؛ فروش، خرید، معاوضه و انتقال خودرو نیازمند اتصال به سرور است و در صف درخواست آفلاین قرار نمی‌گیرد.",
  };
}

/** The two operations a site may queue. Everything else — a trade-in included (issue #963) — is cloud-only. */
export const AUTOMOTIVE_OFFLINE_REQUEST_TYPES = ["reserve", "release"] as const;
export type AutomotiveOfflineRequestType =
  (typeof AUTOMOTIVE_OFFLINE_REQUEST_TYPES)[number];

export const AUTOMOTIVE_OFFLINE_REQUEST_TYPE_LABELS: Record<
  AutomotiveOfflineRequestType,
  string
> = {
  reserve: "رزرو خودرو",
  release: "آزادسازی رزرو",
};

export const AUTOMOTIVE_OFFLINE_REQUEST_STATUSES = [
  /** Queued, not yet confirmed by the cloud. Never shown as a hold. */
  "pending",
  /**
   * The site withdrew it *after* a delivery attempt, so the cloud may already
   * hold it. The withdrawal travels as a command of its own and this state lasts
   * until the cloud answers — never presented as «لغوشده», because nothing local
   * can prove it.
   */
  "cancelling",
  /** The cloud applied it: the hold exists (or was released) as of `resolvedAt`. */
  "confirmed",
  /** The cloud refused it; `conflictCode` says why and the UI offers the fix. */
  "conflict",
  /**
   * Withdrawn with nothing left to apply: either retracted locally before any
   * delivery attempt (`retracted_at` on its event proves it), or withdrawn by the
   * cloud — which, when it had already applied the hold, released it through the
   * canonical reservation service and recorded that in the request's outcome.
   */
  "cancelled",
] as const;
export type AutomotiveOfflineRequestStatus =
  (typeof AUTOMOTIVE_OFFLINE_REQUEST_STATUSES)[number];

export const AUTOMOTIVE_OFFLINE_REQUEST_STATUS_LABELS: Record<
  AutomotiveOfflineRequestStatus,
  string
> = {
  pending: "در انتظار تأیید سرور",
  cancelling: "در حال لغو — در انتظار سرور",
  confirmed: "تأییدشده توسط سرور",
  conflict: "تعارض — نیازمند تصمیم",
  cancelled: "لغوشده",
};

/**
 * Status transitions, in one place so the API, the projection applier and the
 * UI cannot disagree. Monotonic on purpose: a terminal answer never goes back
 * to `pending`, and a `confirmed` request never becomes a conflict later — the
 * cloud's answer is the answer.
 *
 * `cancelled` is terminal *because it is provable*: the only two ways to reach it
 * are a local retraction of an event no delivery attempt was ever made for, and
 * the cloud's own answer to a withdrawal. A row cannot be `cancelled` while a
 * command that would reserve the car is still on its way — that was the old
 * defect, and `planOfflineRequestCancel` below is what replaced it.
 */
export function validateOfflineRequestTransition(
  from: AutomotiveOfflineRequestStatus,
  to: AutomotiveOfflineRequestStatus,
): string | null {
  if (from === to) return null;
  const allowed: Record<
    AutomotiveOfflineRequestStatus,
    readonly AutomotiveOfflineRequestStatus[]
  > = {
    pending: ["cancelling", "confirmed", "conflict", "cancelled"],
    // A withdrawal in flight is answered by the cloud: withdrawn (cancelled), or
    // a refusal it had already recorded (conflict). `confirmed` is not expected
    // — a confirmed hold is released by the withdrawal — but an older cloud that
    // does not know the withdrawal command would answer exactly that, and the
    // board must be able to tell the operator to release the hold.
    cancelling: ["cancelled", "confirmed", "conflict"],
    confirmed: [],
    conflict: [],
    cancelled: [],
  };
  return allowed[from].includes(to)
    ? null
    : `invalid_request_transition:${from}->${to}`;
}

/** A request is still awaiting the cloud: queued, or being withdrawn. */
export function offlineRequestIsOpen(
  status: AutomotiveOfflineRequestStatus,
): boolean {
  return status === "pending" || status === "cancelling";
}

/**
 * What an operator's «لغو» can actually do, decided in one place and proved by
 * the site's own delivery record.
 *
 * The rule the whole offline module turns on: **a cancellation may only be
 * reported as done when the cloud cannot apply the command.** There are exactly
 * two such situations, and they are told apart by one monotonic fact —
 * `dispatch_attempted_at`, stamped the moment a delivery attempt leaves the
 * machine:
 *
 *   * `retract` — no attempt was ever made, so the event is withdrawn locally in
 *     the same transaction as the request row. The cancellation is complete
 *     without a round trip, which is what makes cancelling a queue entry work
 *     while the branch is offline;
 *   * `withdraw` — an attempt was made (or the row is already in `cancelling`),
 *     so the cloud may hold or be about to hold the car. The withdrawal travels
 *     as its own idempotent command; the cloud cancels an unapplied request, or
 *     releases an applied hold through the canonical reservation service, and
 *     answers with what it actually did;
 *   * `already_decided` — the cloud has answered a *reserve/release* already
 *     (`confirmed`, `conflict`, `cancelled`); there is nothing to withdraw and
 *     the honest answer is the row's real status, which the caller returns
 *     instead of a cheerful `cancelled`.
 */
export type AutomotiveCancelAction = "retract" | "withdraw" | "already_decided";

export function planOfflineRequestCancel(input: {
  status: AutomotiveOfflineRequestStatus;
  /** An event for this request exists and has not been retracted. */
  eventPending: boolean;
  /** …and a delivery attempt has left this machine (monotonic). */
  dispatchAttempted: boolean;
  /** …and the cloud acknowledged receiving it. */
  pushed: boolean;
}): AutomotiveCancelAction {
  // A decision the cloud made is not up for local revision: a confirmed hold is
  // released through the reservation flow, a refusal is acknowledged, and a
  // proof-carrying cancellation is already done.
  if (input.status !== "pending" && input.status !== "cancelling")
    return "already_decided";
  // An event with no attempt behind it can be proven never to have reached the
  // cloud. A *missing* event is not proof of that — it may have been delivered
  // and pruned — so the conservative branch is taken for it.
  if (input.eventPending && !input.dispatchAttempted && !input.pushed)
    return "retract";
  return "withdraw";
}

/**
 * Why the cloud refused a request. Every code has a message a counter clerk
 * understands and an action they can take — a conflict with no resolution path
 * would be a dead end dressed up as safety.
 */
export const AUTOMOTIVE_OFFLINE_CONFLICT_CODES = [
  "vehicle_unavailable",
  "vehicle_reserved_by_other",
  "vehicle_not_found",
  "wrong_location",
  "customer_not_found",
  "reservation_not_found",
  "reservation_closed",
  "invalid_request",
] as const;
export type AutomotiveOfflineConflictCode =
  (typeof AUTOMOTIVE_OFFLINE_CONFLICT_CODES)[number];

export const AUTOMOTIVE_OFFLINE_CONFLICT_MESSAGES: Record<
  AutomotiveOfflineConflictCode,
  string
> = {
  vehicle_unavailable:
    "این خودرو دیگر در وضعیت قابل رزرو نیست (فروخته، بایگانی یا در حال انتقال است).",
  vehicle_reserved_by_other:
    "این خودرو پیش از ارسال درخواست شما برای مشتری دیگری رزرو شده است.",
  vehicle_not_found:
    "این خودرو در سرور مرکزی یافت نشد؛ ممکن است شناسهٔ محلی قدیمی باشد.",
  wrong_location: "این خودرو در شعبهٔ این نصب نیست.",
  customer_not_found: "مشتری انتخاب‌شده در سرور مرکزی ثبت نشده است.",
  reservation_not_found: "رزرو موردنظر در سرور مرکزی یافت نشد.",
  reservation_closed: "این رزرو پیش از رسیدن درخواست آزادسازی بسته شده بود.",
  invalid_request: "اطلاعات درخواست کامل یا معتبر نبود.",
};

export type AutomotiveConflictResolutionAction =
  "retry" | "cancel" | "open_vehicle";

export interface AutomotiveConflictResolution {
  code: AutomotiveOfflineConflictCode;
  message: string;
  actions: readonly AutomotiveConflictResolutionAction[];
}

export const AUTOMOTIVE_CONFLICT_ACTION_LABELS: Record<
  AutomotiveConflictResolutionAction,
  string
> = {
  retry: "ارسال دوباره با وضعیت تازه",
  cancel: "لغو درخواست",
  open_vehicle: "مشاهدهٔ خودرو",
};

export function automotiveConflictResolution(
  code: AutomotiveOfflineConflictCode,
): AutomotiveConflictResolution {
  const actions: AutomotiveConflictResolutionAction[] =
    code === "vehicle_unavailable" ||
    code === "vehicle_reserved_by_other" ||
    code === "wrong_location"
      ? ["open_vehicle", "cancel"]
      : code === "reservation_not_found" || code === "reservation_closed"
        ? ["open_vehicle", "cancel"]
        : code === "vehicle_not_found"
          ? ["cancel"]
          : ["retry", "cancel"];
  return { code, message: AUTOMOTIVE_OFFLINE_CONFLICT_MESSAGES[code], actions };
}

/**
 * Map a canonical service refusal (`VehicleError.code`) onto the conflict
 * vocabulary. The mapping is total: an unexpected code becomes
 * `invalid_request` rather than being dropped, because a request that failed
 * for a reason nobody recorded is worse than a blunt one.
 */
export function conflictCodeForVehicleError(
  code: string,
): AutomotiveOfflineConflictCode {
  switch (code) {
    case "vehicle_not_found":
      return "vehicle_not_found";
    case "wrong_location":
      return "wrong_location";
    case "customer_not_found":
      return "customer_not_found";
    case "reservation_not_found":
      return "reservation_not_found";
    case "reservation_closed":
    case "deposit_already_refunded":
      return "reservation_closed";
    case "vehicle_not_available":
    case "vehicle_reserved":
    case "vehicle_sold":
    case "vehicle_archived":
    case "already_in_transit":
      return "vehicle_unavailable";
    case "vehicle_reserved_by_other":
      return "vehicle_reserved_by_other";
    default:
      return "invalid_request";
  }
}

/** The draft a counter clerk fills in while the cloud is unreachable. */
export interface VehicleReservationRequestDraft {
  serialId: string;
  customerId: string;
  customerName: string;
  /** Business-local ISO date the hold lapses. */
  expiresAt: string | null;
  expiresAtTime: string | null;
  depositRial: number;
  depositMethod: "cash" | "card" | "card_to_card" | "online" | null;
  depositRefundable: boolean;
  depositNote: string | null;
  note: string | null;
  /** The `sourceVersion` of the mirrored row the operator was looking at. */
  expectedVersion: number;
  expectedState: VehicleState;
}

export type VehicleRequestDraftValidation =
  | { ok: true; draft: VehicleReservationRequestDraft }
  | { ok: false; error: string; message: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Validate a draft with the *same* rules `reserveVehicle` enforces server-side.
 * Doing it here means the operator is told before the request is queued — a
 * request that could only ever conflict is not worth queueing — while the
 * cloud still re-checks everything, because a queue is not a trust boundary.
 */
export function validateVehicleReservationDraft(
  raw: unknown,
  options: { reservableStates: readonly VehicleState[]; today?: string },
): VehicleRequestDraftValidation {
  const fail = (
    error: string,
    message: string,
  ): VehicleRequestDraftValidation => ({ ok: false, error, message });
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return fail("invalid_vehicle", "درخواست نامعتبر است.");
  const input = raw as Record<string, unknown>;

  const text = (value: unknown): string | null =>
    value === null || value === undefined || value === ""
      ? null
      : typeof value === "string"
        ? value.trim()
        : null;

  const serialId = text(input.serialId);
  if (!serialId) return fail("invalid_vehicle", "خودرو انتخاب نشده است.");
  const customerId = text(input.customerId);
  if (!customerId)
    return fail(
      "customer_required",
      "رزرو بدون مشتری معنا ندارد؛ مشتری را انتخاب کنید.",
    );

  const depositRial =
    input.depositRial === undefined || input.depositRial === null
      ? 0
      : input.depositRial;
  if (
    typeof depositRial !== "number" ||
    !Number.isSafeInteger(depositRial) ||
    depositRial < 0
  ) {
    return fail("invalid_amount", "مبلغ ودیعه باید عددی صحیح و نامنفی باشد.");
  }
  const depositMethod =
    input.depositMethod === null ||
    input.depositMethod === undefined ||
    input.depositMethod === ""
      ? null
      : typeof input.depositMethod === "string"
        ? input.depositMethod
        : null;
  if (
    depositMethod &&
    !["cash", "card", "card_to_card", "online"].includes(depositMethod)
  ) {
    return fail("invalid_deposit_method", "روش دریافت ودیعه نامعتبر است.");
  }
  if (depositRial > 0 && !depositMethod)
    return fail("invalid_deposit_method", "روش دریافت ودیعه الزامی است.");

  const expiresAt = text(input.expiresAt);
  if (expiresAt !== null) {
    if (!ISO_DATE.test(expiresAt))
      return fail("invalid_date", "تاریخ انقضای رزرو نامعتبر است.");
    const parsed = new Date(`${expiresAt}T00:00:00.000Z`);
    if (
      !Number.isFinite(parsed.valueOf()) ||
      parsed.toISOString().slice(0, 10) !== expiresAt
    ) {
      return fail("invalid_date", "تاریخ انقضای رزرو نامعتبر است.");
    }
    // A hold whose expiry already passed would be born expired and would only
    // ever conflict; the counter should pick a real date.
    if (options.today && expiresAt < options.today)
      return fail("invalid_date", "تاریخ انقضای رزرو گذشته است.");
  }
  const expiresAtTime = text(input.expiresAtTime);
  if (expiresAtTime !== null) {
    if (!expiresAt)
      return fail("invalid_date", "ساعت انقضای رزرو باید همراه تاریخ باشد.");
    if (!CLOCK.test(expiresAtTime))
      return fail("invalid_date", "ساعت انقضا باید به‌شکل ساعت:دقیقه باشد.");
  }

  const expectedVersion = input.expectedVersion;
  if (
    typeof expectedVersion !== "number" ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 1
  ) {
    return fail("invalid_vehicle", "نسخهٔ خودرو در نمایش محلی نامعتبر است.");
  }
  const expectedState = input.expectedState;
  if (
    typeof expectedState !== "string" ||
    !options.reservableStates.includes(expectedState as VehicleState)
  ) {
    return fail("vehicle_not_available", "این خودرو در وضعیت قابل رزرو نیست.");
  }

  return {
    ok: true,
    draft: {
      serialId,
      customerId,
      customerName: text(input.customerName) ?? "",
      expiresAt,
      expiresAtTime,
      depositRial,
      depositMethod:
        depositMethod as VehicleReservationRequestDraft["depositMethod"],
      depositRefundable:
        input.depositRefundable === undefined
          ? true
          : input.depositRefundable === true,
      depositNote: text(input.depositNote),
      note: text(input.note),
      expectedVersion,
      expectedState: expectedState as VehicleState,
    },
  };
}

/** What the cloud reports about the car the request names. */
export interface VehicleReplayRemoteFacts {
  found: boolean;
  state: VehicleState | null;
  locationId: string | null;
  sourceVersion: number | null;
  /** An *active* hold that this request did not create, if any. */
  blockingHoldId: string | null;
  /** The hold this request created, once the cloud has applied it. */
  ownReservationId: string | null;
}

export type VehicleReplayOutcome =
  | { outcome: "apply"; versionMoved: boolean }
  | { outcome: "duplicate"; reservationId: string }
  | { outcome: "conflict"; code: AutomotiveOfflineConflictCode };

/**
 * The conflict decision, pure and testable — the counterpart of
 * `offline-sync.ts`'s `classifyStatusReplay` for the order status machine.
 *
 * It is a **re-validation against the car's current state**, not a replay of
 * the operator's intent: the hold is granted only if the car is still in this
 * branch and still reservable, and refused with a named reason otherwise. The
 * operator's `expectedVersion` is compared — a moved version is reported so the
 * counter knows the price/state they saw has changed — but a moved version is
 * *not* by itself a refusal: a price change between viewing and requesting
 * must not cost a customer their car when the car itself is still free.
 */
export function classifyVehicleRequestReplay(input: {
  request: {
    serialId: string;
    locationId: string;
    expectedVersion: number;
    expectedState: VehicleState;
  };
  remote: VehicleReplayRemoteFacts;
  reservableStates: readonly VehicleState[];
}): VehicleReplayOutcome {
  const { request, remote } = input;
  if (!remote.found) return { outcome: "conflict", code: "vehicle_not_found" };
  if (remote.locationId !== request.locationId)
    return { outcome: "conflict", code: "wrong_location" };
  if (remote.ownReservationId)
    return { outcome: "duplicate", reservationId: remote.ownReservationId };
  if (remote.blockingHoldId)
    return { outcome: "conflict", code: "vehicle_reserved_by_other" };
  if (!remote.state || !input.reservableStates.includes(remote.state)) {
    return { outcome: "conflict", code: "vehicle_unavailable" };
  }
  return {
    outcome: "apply",
    versionMoved:
      remote.sourceVersion !== null &&
      remote.sourceVersion !== request.expectedVersion,
  };
}

/**
 * How stale the local mirror is. `fresh` means the last successful sync is
 * inside the window; `stale` means the counter must be told the board may be
 * out of date; `never` means this install has never received a snapshot (so it
 * shows nothing rather than pretending the branch has no cars).
 */
export type AutomotiveMirrorFreshness = "fresh" | "stale" | "never";

export function mirrorFreshness(
  syncedAt: string | null,
  now: Date,
  staleAfterMs: number = AUTOMOTIVE_MIRROR_STALE_AFTER_MS,
): AutomotiveMirrorFreshness {
  if (!syncedAt) return "never";
  const then = Date.parse(syncedAt);
  if (!Number.isFinite(then)) return "never";
  const elapsed = now.getTime() - then;
  // A clock that jumped backwards must not read as "very fresh" for a week.
  if (elapsed < 0) return Math.abs(elapsed) > staleAfterMs ? "stale" : "fresh";
  return elapsed > staleAfterMs ? "stale" : "fresh";
}

export const AUTOMOTIVE_MIRROR_FRESHNESS_LABELS: Record<
  AutomotiveMirrorFreshness,
  string
> = {
  fresh: "همگام",
  stale: "قدیمی — آخرین همگام‌سازی دیرتر از حد انتظار",
  never: "هنوز همگام نشده",
};

/**
 * What a full-snapshot reconcile does with one row. The projection is
 * authoritative for the branch, so the plan is "replace with what the cloud
 * says", never "merge fields": `update` carries the whole row, `skip` means the
 * stored row already equals it (idempotent re-apply), and `remove` deletes a
 * row the cloud no longer lists for this branch (sold, transferred away,
 * archived).
 */
export type MirrorReconcileAction = "insert" | "update" | "skip" | "remove";

export function planMirrorReconcile(input: {
  local: {
    serialId: string;
    sourceVersion: number;
    contentHash: string;
  } | null;
  remote: {
    serialId: string;
    sourceVersion: number;
    contentHash: string;
  } | null;
}): MirrorReconcileAction {
  const { local, remote } = input;
  if (local && remote && local.serialId !== remote.serialId) return "insert";
  if (!local && remote) return "insert";
  if (local && !remote) return "remove";
  if (!local && !remote) return "skip";
  if (local!.contentHash === remote!.contentHash) return "skip";
  // Later snapshot wins, and the snapshot is the cloud's whole word. A row that
  // somehow reports an older version than the mirror holds is still replaced:
  // refusing it would leave the site on stale data forever with no way out.
  return "update";
}

/** Counts an operator can see on the sync panel. */
/**
 * The one-line status above the board.
 *
 * `openRequests` is deliberately one number for two states — queued (`pending`) and
 * being withdrawn (`cancelling`). Both mean "this branch has handed the cloud
 * something and has not been answered", which is what the counter needs to know;
 * splitting them here would let a withdrawal in flight read as if nothing were
 * outstanding.
 */
export function automotiveSyncSummary(input: {
  vehicles: number;
  reserved: number;
  openRequests: number;
  conflicts: number;
  freshness: AutomotiveMirrorFreshness;
}): string {
  const parts = [`${input.vehicles} خودرو در موجودی محلی`];
  if (input.reserved > 0) parts.push(`${input.reserved} رزرو فعال`);
  if (input.openRequests > 0)
    parts.push(`${input.openRequests} درخواست در انتظار پاسخ سرور`);
  if (input.conflicts > 0) parts.push(`${input.conflicts} تعارض نیازمند تصمیم`);
  parts.push(AUTOMOTIVE_MIRROR_FRESHNESS_LABELS[input.freshness]);
  return parts.join(" · ");
}
