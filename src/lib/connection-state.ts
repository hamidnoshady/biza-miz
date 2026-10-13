/** Shared vocabulary for runtime connectivity. Never call all of it "offline". */
export type ConnectionStatus =
  | "connected"
  | "unreachable"
  | "unknown"
  | "connecting"
  | "paused"
  | "not_configured"
  | "attention_required"
  | "not_applicable";

export interface PlatformConnectionState {
  localServer: ConnectionStatus;
  lanGateway: ConnectionStatus;
  internet: ConnectionStatus;
  cloud: ConnectionStatus;
  sync: ConnectionStatus;
  externalServices: ConnectionStatus;
  outboundPending: number;
  inboundPending: number;
  /** Dependency-delayed events; this is not a user-visible conflict. */
  deferred: number;
  /** Explicit replay conflicts only. */
  conflicts: number;
  deadLetters: number;
  lastSuccessfulPushAt: string | null;
  lastSuccessfulPullAt: string | null;
  /** Latest point at which both directions have completed at least once. */
  lastConvergedAt: string | null;
  /** Compatibility summary; use direction-specific timestamps for diagnostics. */
  lastSuccessfulSyncAt: string | null;
}

export type SyncFailureClass =
  "temporary" | "needs_attention" | "configuration_fatal";

export function classifySyncFailure(
  code: string | null | undefined,
): SyncFailureClass {
  if (
    !code ||
    [
      "remote_unreachable",
      "timeout",
      "internet_unavailable",
      "rate_limited",
    ].includes(code)
  )
    return "temporary";
  if (
    ["dependency_conflict", "merge_conflict", "invalid_relationship"].includes(
      code,
    )
  )
    return "needs_attention";
  return "configuration_fatal";
}

/**
 * Issue #948 P0/P1-5 — what a persisted sync/IAM error actually is.
 *
 * The old behaviour folded every error into one bucket: any of
 * `lastPushError`/`lastPullError`/IAM failure became `cloud: "unreachable"` +
 * `error: "remote_unreachable"`, and the dashboard then told the operator
 * «اتصال به اینترنت و نسخهٔ ابری قطع است» — even when the Internet was fine
 * and only the IAM stage had failed. This separates the classes so a UI can
 * say *which* of internet / cloud reachability / cloud auth / operational
 * sync / IAM is broken, and never infer "no Internet" from a stale sync
 * error.
 */
export type ConnectionFault =
  | "none"
  | "transport_unreachable"
  | "timeout"
  | "auth_expired"
  | "forbidden"
  | "server_error"
  | "rate_limited"
  | "identity_blocked"
  | "conflict"
  | "configuration"
  | "unknown";

export function classifyConnectionFault(error: string | null | undefined): ConnectionFault {
  if (!error) return "none";
  const text = error.toLowerCase();
  // IAM/identity-plane failures are their own class: the operational pipes
  // and the Internet can be perfectly healthy while these persist.
  if (text.includes("iam_sync_blocked") || text.includes("identity_sync_degraded") || text.includes("identity_")
    || text.includes("pin_credentials_missing")) {
    return "identity_blocked";
  }
  if (text.includes("401") || text.includes("unauthorized") || text.includes("unauthenticated")
    || text.includes("token_expired") || text.includes("auth_expired") || text.includes("invalid_token")) {
    return "auth_expired";
  }
  if (text.includes("403") || text.includes("forbidden")) return "forbidden";
  if (text.includes("429") || text.includes("rate_limited")) return "rate_limited";
  if (text.includes("timeout") || text.includes("timed out") || text.includes("etimedout") || text.includes("abort")) {
    return "timeout";
  }
  if (text.includes("conflict")) return "conflict";
  if (
    text.includes("fetch failed") || text.includes("network") || text.includes("unreachable")
    || text.includes("econnrefused") || text.includes("econnreset") || text.includes("enotfound")
    || text.includes("ehostunreach") || text.includes("enetunreach") || text.includes("enetdown")
    || text.includes("socket hang up") || text.includes("dns") || text.includes("offline")
  ) {
    return "transport_unreachable";
  }
  if (text.includes("http_5") || text.includes("5xx") || text.includes("bad gateway") || text.includes("service unavailable")) {
    return "server_error";
  }
  if (text.includes("not_configured") || text.includes("unconfigured") || text.includes("config")) return "configuration";
  return "unknown";
}

/**
 * The stable machine-readable code the status API reports for a fault class.
 * Deliberately *not* always `remote_unreachable`: only an actual transport
 * failure may claim the remote is unreachable.
 */
export function faultErrorCode(fault: ConnectionFault): string | null {
  switch (fault) {
    case "none": return null;
    case "transport_unreachable": return "remote_unreachable";
    case "timeout": return "remote_timeout";
    case "auth_expired": return "cloud_auth_expired";
    case "forbidden": return "cloud_auth_forbidden";
    case "server_error": return "cloud_server_error";
    case "rate_limited": return "rate_limited";
    case "identity_blocked": return "identity_sync_degraded";
    case "conflict": return "sync_conflict";
    case "configuration": return "sync_configuration";
    case "unknown": return "remote_error";
  }
}

/**
 * What the *cloud connection* reads as, given the fault. Transport problems
 * are the only ones that mean "unreachable"; an auth or IAM failure means the
 * cloud answered — it just refused — which is `attention_required`, never a
 * claim that the line is down.
 */
export function cloudStatusForFault(fault: ConnectionFault): ConnectionStatus {
  switch (fault) {
    case "none": return "connected";
    case "transport_unreachable":
    case "timeout":
      return "unreachable";
    default:
      return "attention_required";
  }
}
