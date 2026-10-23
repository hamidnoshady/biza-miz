/**
 * The upload failure taxonomy (issue #1080).
 *
 * These tests pin the *decision*, not the wording: which stage and which HTTP
 * status each class of exception produces, whether a retry is offered, and that
 * nothing secret can reach a log line or a tenant screen. The point of the table
 * is that a bucket that rejects the key (403), a bucket that is briefly down
 * (503), a full `/tmp` (ENOSPC) and a dropped database connection must not all
 * arrive as "storage_error, check the connection settings".
 */
import { describe, expect, it } from "vitest";
import {
  classifyMediaFailure,
  logMediaFailure,
  maskObjectKey,
  mediaFailureBody,
  mediaFailureMessage,
  mediaRequestId,
  MediaStorageBusyError,
  MediaStorageFailure,
  redactMediaDetail,
} from "./media-errors";
import { S3RequestError } from "./s3-lite";

function s3Error(over: Partial<ConstructorParameters<typeof S3RequestError>[0]> = {}) {
  return new S3RequestError({
    message: "upload media/x.png: HTTP 403 SignatureDoesNotMatch",
    operation: "put",
    status: 403,
    providerCode: "SignatureDoesNotMatch",
    key: "media/x.png",
    retryable: false,
    ...over,
  });
}

describe("classifyMediaFailure — stage attribution", () => {
  it("attributes a provider rejection to the cloud write and never offers a retry", () => {
    const failure = classifyMediaFailure(s3Error());
    expect(failure).toMatchObject({
      stage: "s3_upload",
      code: "storage_credentials_rejected",
      retryable: false,
      status: 502,
      providerStatus: 403,
      providerCode: "SignatureDoesNotMatch",
    });
  });

  it("attributes a 5xx/429 provider outage to the cloud write and offers a retry", () => {
    const failure = classifyMediaFailure(s3Error({ status: 503, providerCode: "SlowDown", retryable: true }));
    expect(failure).toMatchObject({ stage: "s3_upload", code: "storage_unavailable", retryable: true, status: 503 });
  });

  it("distinguishes a timeout from a rejection", () => {
    const failure = classifyMediaFailure(
      s3Error({ status: null, providerCode: "TimeoutError", retryable: true, message: "upload k: timeout" }),
    );
    expect(failure).toMatchObject({ code: "storage_timeout", retryable: true, status: 503, providerStatus: null });
  });

  it("treats a read failure as a read, not as an upload", () => {
    const failure = classifyMediaFailure(s3Error({ operation: "get", status: 500, providerCode: "InternalError", retryable: true }));
    expect(failure.stage).toBe("s3_read");
  });

  it("attributes an unreadable spool file to the temp-file stage, not to the bucket", () => {
    const failure = classifyMediaFailure(
      s3Error({
        status: null,
        retryable: false,
        providerCode: "LocalFileSizeMismatch",
        message: "upload k: LocalFileSizeMismatch (10 != 20)",
      }),
    );
    expect(failure).toMatchObject({ stage: "temp_file", code: "temp_file_mismatch", status: 507, retryable: false });
  });

  it("attributes filesystem errors from the spool to the temp-file stage", () => {
    const failure = classifyMediaFailure(Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }));
    expect(failure).toMatchObject({ stage: "temp_file", code: "temp_file_unwritable", status: 507, retryable: false });
  });

  it("attributes a pg connection failure to the database and offers a retry", () => {
    const error = Object.assign(new Error("terminating connection due to administrator command"), {
      code: "57P01",
      severity: "FATAL",
    });
    const failure = classifyMediaFailure(error);
    expect(failure).toMatchObject({
      stage: "database",
      code: "database_unavailable",
      retryable: true,
      status: 503,
      providerCode: "57P01",
    });
  });

  it("attributes a constraint violation to the database and does not offer a retry", () => {
    const failure = classifyMediaFailure(Object.assign(new Error("duplicate key value"), { code: "23505" }));
    expect(failure).toMatchObject({ stage: "database", code: "database_error", retryable: false, status: 503 });
  });

  it("reports a client abort as an abort, not as a storage failure", () => {
    const failure = classifyMediaFailure(Object.assign(new Error("aborted"), { name: "AbortError" }));
    expect(failure).toMatchObject({ stage: "aborted", code: "request_aborted", retryable: false });
  });

  it("passes an explicitly staged failure straight through", () => {
    const failure = classifyMediaFailure(
      new MediaStorageFailure({ stage: "database", code: "database_error", status: 500, retryable: false }),
    );
    expect(failure).toMatchObject({ stage: "database", code: "database_error", status: 500 });
  });

  it("keeps the migration-busy failure retryable so the tenant is told to come back", () => {
    const failure = classifyMediaFailure(new MediaStorageBusyError());
    expect(failure).toMatchObject({ code: "media_storage_migrating", retryable: true, status: 503 });
  });

  it("falls back to a generic internal error rather than guessing a stage", () => {
    const failure = classifyMediaFailure(new Error("something odd"));
    expect(failure).toMatchObject({ stage: "unknown", code: "internal_error", status: 500, retryable: false });
  });
});

describe("localized, actionable messages", () => {
  it("never tells the tenant to check a platform-wide connection setting for a database or disk failure", () => {
    const disk = mediaFailureMessage(classifyMediaFailure(Object.assign(new Error("EACCES"), { code: "EACCES" })).code);
    const database = mediaFailureMessage("database_error");
    const credentials = mediaFailureMessage("storage_credentials_rejected");
    for (const message of [disk, database]) {
      expect(message).not.toContain("تنظیمات اتصال");
    }
    // The one case that IS an operator credential problem says so explicitly.
    expect(credentials).toContain("مدیر پلتفرم");
    expect(mediaRequestId("edge-ref-abcdef")).toBe("edge-ref-abcdef");
  });

  it("has a message for every code the classifier can emit", () => {
    const codes = [
      "storage_not_configured",
      "temp_file_unwritable",
      "temp_file_unreadable",
      "temp_file_mismatch",
      "storage_credentials_rejected",
      "storage_object_missing",
      "storage_unavailable",
      "storage_timeout",
      "storage_conflict",
      "storage_rejected",
      "database_unavailable",
      "database_error",
      "media_storage_migrating",
      "request_aborted",
      "incomplete_config",
      "storage_disabled",
      "cleanup_failed",
      "probe_content_mismatch",
      "stream_probe_content_mismatch",
      "probe_head_mismatch",
    ];
    for (const code of codes) {
      // Every code has its own sentence: none silently falls back to the generic one.
      expect(mediaFailureMessage(code), code).not.toBe(mediaFailureMessage("__not_a_code__"));
    }
    // `internal_error` IS the generic sentence, and an unknown code still yields
    // a real sentence rather than echoing the raw code.
    expect(mediaFailureMessage("internal_error")).toContain("خطای غیرمنتظره");
    expect(mediaFailureMessage("__not_a_code__")).toContain("خطای غیرمنتظره");
    expect(mediaFailureMessage("__not_a_code__")).not.toContain("__not_a_code__");
  });
});

describe("references and redaction", () => {
  it("mints a reference when the edge sent none and honours a safe inbound one", () => {
    expect(mediaRequestId(null, 1_700_000_000_000)).toMatch(/^media-/);
    expect(mediaRequestId("edge-req-123456")).toBe("edge-req-123456");
    // Unsafe or too-short values are replaced, never echoed.
    expect(mediaRequestId("a")).toMatch(/^media-/);
    expect(mediaRequestId("bad value with spaces")).toMatch(/^media-/);
  });

  it("strips signing material and secret-looking values from a diagnostic string", () => {
    const dirty =
      "AWS4-HMAC-SHA256 Credential=AKIAABCDEFGHIJKLMNOP/20260721/ir-thr-at1/s3/aws4_request, Signature=deadbeefdeadbeef " +
      "X-Amz-Signature=abcdef1234567890 secretAccessKey=SuperSecretValue AKIAABCDEFGHIJKLMNOP";
    const clean = redactMediaDetail(dirty);
    expect(clean).not.toContain("deadbeefdeadbeef");
    expect(clean).not.toContain("abcdef1234567890");
    expect(clean).not.toContain("SuperSecretValue");
    expect(clean).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(clean).toContain("[redacted]");
  });

  it("masks the user's file name in a logged object key but keeps it greppable", () => {
    const masked = maskObjectKey("media/business/asset/قرارداد-محرمانه.png");
    expect(masked).toBe("media/business/asset/«file».png");
    expect(masked).not.toContain("قرارمانه");
  });

  it("logs one JSON line with the stage, code, reference and no secrets", () => {
    const lines: string[] = [];
    const original = console.error;
    console.error = (message: string) => lines.push(String(message));
    try {
      logMediaFailure(s3Error({ message: "upload k: HTTP 403 Signature=deadbeefdeadbeef" }), {
        operation: "tenant.media.upload",
        scope: "tenant",
        requestId: "media-ref-1",
        businessId: "b1",
        objectKey: "media/b1/a/secret-name.png",
        byteSize: 2048,
        streamed: true,
        durationMs: 12,
      });
    } finally {
      console.error = original;
    }
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0].replace(/^\[media\] /, ""));
    expect(record).toMatchObject({
      event: "media.failure",
      operation: "tenant.media.upload",
      requestId: "media-ref-1",
      businessId: "b1",
      stage: "s3_upload",
      code: "storage_credentials_rejected",
      providerStatus: 403,
      byteSize: 2048,
      streamed: true,
    });
    expect(record.objectKey).toBe("media/b1/a/«file».png");
    expect(lines[0]).not.toContain("deadbeef");
    expect(lines[0]).not.toContain("secret-name");
  });
});

describe("the tenant-facing body", () => {
  it("carries the reference and the retry verdict without leaking provider detail", () => {
    const failure = classifyMediaFailure(s3Error({ message: "upload k: HTTP 403 <Code>SignatureDoesNotMatch</Code>" }));
    const body = mediaFailureBody(failure, "media-ref-9");
    expect(body).toEqual({
      error: "storage_credentials_rejected",
      message: mediaFailureMessage("storage_credentials_rejected"),
      reference: "media-ref-9",
      retryable: false,
      stage: "s3_upload",
    });
    expect(JSON.stringify(body)).not.toContain("SignatureDoesNotMatch");
  });
});
