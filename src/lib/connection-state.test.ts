import { describe, expect, it } from "vitest";
import {
  classifyConnectionFault,
  cloudStatusForFault,
  faultErrorCode,
} from "./connection-state";

describe("classifyConnectionFault (issue #948)", () => {
  it("has no fault without an error", () => {
    expect(classifyConnectionFault(null)).toBe("none");
    expect(classifyConnectionFault("")).toBe("none");
    expect(classifyConnectionFault(undefined)).toBe("none");
  });

  it("classifies transport failures as the only 'unreachable' evidence", () => {
    expect(classifyConnectionFault("fetch failed")).toBe("transport_unreachable");
    expect(classifyConnectionFault("request to https://cloud failed, reason: connect ECONNREFUSED 1.2.3.4:443")).toBe("transport_unreachable");
    expect(classifyConnectionFault("spent_recovery_codes_unreachable: getaddrinfo ENOTFOUND cloud.example")).toBe("transport_unreachable");
    expect(classifyConnectionFault("socket hang up")).toBe("transport_unreachable");
  });

  it("classifies timeouts separately from refusals", () => {
    expect(classifyConnectionFault("login_credentials_unreachable: The operation was aborted due to timeout")).toBe("timeout");
    expect(classifyConnectionFault("ETIMEDOUT")).toBe("timeout");
  });

  it("never calls an IAM/identity failure an internet problem", () => {
    expect(classifyConnectionFault("iam_sync_blocked: iam_sync_http_500")).toBe("identity_blocked");
    expect(classifyConnectionFault("identity_sync_degraded: identity_bindings_missing:1")).toBe("identity_blocked");
    expect(classifyConnectionFault("pin_credentials_missing:2")).toBe("identity_blocked");
  });

  it("separates cloud auth faults from transport", () => {
    expect(classifyConnectionFault("login_credentials_http_401")).toBe("auth_expired");
    expect(classifyConnectionFault("push failed: unauthorized")).toBe("auth_expired");
    expect(classifyConnectionFault("pull failed: 403 forbidden")).toBe("forbidden");
    expect(classifyConnectionFault("login_credentials_http_429")).toBe("rate_limited");
    expect(classifyConnectionFault("push failed: http_502")).toBe("server_error");
  });

  it("maps classes to codes that do not all claim remote_unreachable", () => {
    expect(faultErrorCode("none")).toBeNull();
    expect(faultErrorCode("transport_unreachable")).toBe("remote_unreachable");
    expect(faultErrorCode("timeout")).toBe("remote_timeout");
    expect(faultErrorCode("auth_expired")).toBe("cloud_auth_expired");
    expect(faultErrorCode("identity_blocked")).toBe("identity_sync_degraded");
  });

  it("reads the cloud connection as unreachable only for transport faults", () => {
    expect(cloudStatusForFault("none")).toBe("connected");
    expect(cloudStatusForFault("transport_unreachable")).toBe("unreachable");
    expect(cloudStatusForFault("timeout")).toBe("unreachable");
    // The cloud *answered* — it just refused, errored, or the identity plane
    // is broken. That is an attention state, never a dead line.
    expect(cloudStatusForFault("auth_expired")).toBe("attention_required");
    expect(cloudStatusForFault("identity_blocked")).toBe("attention_required");
    expect(cloudStatusForFault("server_error")).toBe("attention_required");
  });
});
