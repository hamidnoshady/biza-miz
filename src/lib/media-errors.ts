/**
 * Failure taxonomy for the Media Library's upload path (issue #1080).
 *
 * Before this module the tenant upload route wrapped *every* exception — an
 * unreachable bucket, a read-only `/tmp`, a `pg` connection reset, a
 * constraint violation, a client abort — into one `502 storage_error` whose
 * Persian text told the user to "check the connection settings". An operator
 * therefore could not tell from the UI, and the log could not tell from the
 * line, which of five very different things had actually happened; the same
 * message also invited tenants to go and edit a platform-wide secret they do
 * not own.
 *
 * The rules here are deliberately pure and dependency-light so they can be
 * unit-tested to the exact stage, and so both the route (to choose a status
 * code and a safe localized message) and the log line (to record a
 * machine-greppable `stage`/`code`) derive from one decision.
 */
import { S3RequestError, redactS3Detail } from "./s3-lite";

export type MediaFailureStage = "config" | "temp_file" | "s3_upload" | "s3_read" | "database" | "aborted" | "unknown";

export interface MediaFailure {
  /** Which link of the chain broke: spool, cloud write, cloud read, database, … */
  stage: MediaFailureStage;
  /** Stable machine code, e.g. `storage_credentials_rejected`, `temp_file_unwritable`. */
  code: string;
  /** True only when an unchanged retry could plausibly succeed. */
  retryable: boolean;
  /** HTTP status this failure should be answered with. */
  status: number;
  /** Provider HTTP status (S3 errors only) — never a secret. */
  providerStatus: number | null;
  /** Provider error `<Code>` (S3 errors only), e.g. `SignatureDoesNotMatch`. */
  providerCode: string | null;
  /** Redacted technical detail, safe to log (never returned raw to a tenant). */
  detail: string;
}

/**
 * A failure that already knows its stage — used where the caller performs the
 * step itself (committing a transaction, starting a migration) and therefore
 * does not need to infer it from the exception shape.
 */
export class MediaStorageFailure extends Error {
  readonly stage: MediaFailureStage;
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number;
  readonly providerStatus: number | null;
  readonly providerCode: string | null;

  constructor(input: {
    stage: MediaFailureStage;
    code: string;
    message?: string;
    retryable?: boolean;
    status?: number;
    providerStatus?: number | null;
    providerCode?: string | null;
    cause?: unknown;
  }) {
    super(input.message ?? input.code, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = "MediaStorageFailure";
    this.stage = input.stage;
    this.code = input.code;
    this.retryable = input.retryable ?? false;
    this.status = input.status ?? 500;
    this.providerStatus = input.providerStatus ?? null;
    this.providerCode = input.providerCode ?? null;
  }
}

/** Raised while a verified storage migration holds the write lock. */
export class MediaStorageBusyError extends MediaStorageFailure {
  constructor(message = "media_storage_migrating") {
    super({ stage: "database", code: "media_storage_migrating", message, retryable: true, status: 503 });
    this.name = "MediaStorageBusyError";
  }
}

const TEMP_FILE_CODES = new Set(["EACCES", "EPERM", "EROFS", "ENOSPC", "EDQUOT", "EMFILE", "ENFILE", "EIO", "ENOENT"]);

/** Filesystem codes that mean "this deployment cannot spool uploads". */
export function isTempFileFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && TEMP_FILE_CODES.has(code);
}

const TRANSIENT_PG_CODES = new Set(["40001", "40P01", "57P01", "57P02", "57P03", "53300", "53400"]);
const TRANSIENT_PG_CODE_PREFIXES = ["08"]; // connection exceptions
const TRANSIENT_NET_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN"]);

function pgErrorOf(error: unknown): { code: string; severity?: string; message: string } | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as { code?: unknown; severity?: unknown; message?: unknown };
  // pg surfaces the SQLSTATE in `code`; a five-character alphanumeric value is
  // the reliable signature (node's own network errors use long symbolic codes).
  if (typeof candidate.code !== "string" || !/^[0-9A-Z]{5}$/.test(candidate.code)) return null;
  return {
    code: candidate.code,
    severity: typeof candidate.severity === "string" ? candidate.severity : undefined,
    message: typeof candidate.message === "string" ? candidate.message : candidate.code,
  };
}

/** Strip signing material and secret-looking values from a diagnostic string. */
export function redactMediaDetail(text: string): string {
  return redactS3Detail(text)
    .replace(/(secret[_-]?access[_-]?key|secretAccessKey|secretKey|password)\s*[=:]\s*[^\s,;"']+/gi, "$1=[redacted]")
    .replace(/\bAKIA[0-9A-Z]{12,}\b/g, "[redacted-access-key]")
    .slice(0, 400);
}

function detailOf(error: unknown): string {
  if (error instanceof Error) return redactMediaDetail(error.message);
  if (typeof error === "string") return redactMediaDetail(error);
  return "";
}

const LOCAL_FILE_CODES = new Set(["LocalFileUnreadable", "LocalFileSizeMismatch"]);

/**
 * Turn any thrown value from the upload path into a `MediaFailure`.
 *
 * Ordering matters: an `S3RequestError` is produced only by `s3-lite`, so it is
 * checked first and attributed exactly; then filesystem codes (the spool), then
 * PostgreSQL (SQLSTATE), then transport errors that can only have come from the
 * database connection at this point, then aborts.
 */
export function classifyMediaFailure(error: unknown): MediaFailure {
  if (error instanceof MediaStorageFailure) {
    return {
      stage: error.stage,
      code: error.code,
      retryable: error.retryable,
      status: error.status,
      providerStatus: error.providerStatus,
      providerCode: error.providerCode,
      detail: detailOf(error),
    };
  }

  if (error instanceof S3RequestError) {
    const stage: MediaFailureStage = error.operation === "put" ? "s3_upload" : "s3_read";
    const detail = redactMediaDetail(error.message);

    // The spooled file itself was unreadable/truncated: a local failure that
    // would otherwise look like a provider rejection.
    if (error.providerCode && LOCAL_FILE_CODES.has(error.providerCode)) {
      const code = error.providerCode === "LocalFileSizeMismatch" ? "temp_file_mismatch" : "temp_file_unreadable";
      return {
        stage: "temp_file",
        code,
        retryable: false,
        status: 507,
        providerStatus: null,
        providerCode: error.providerCode,
        detail,
      };
    }

    if (error.status === 401 || error.status === 403) {
      return {
        stage,
        code: "storage_credentials_rejected",
        retryable: false,
        status: 502,
        providerStatus: error.status,
        providerCode: error.providerCode,
        detail,
      };
    }
    if (error.status === 404) {
      return {
        stage,
        code: "storage_object_missing",
        retryable: false,
        status: 502,
        providerStatus: error.status,
        providerCode: error.providerCode,
        detail,
      };
    }
    if (error.status === 409 || error.status === 412) {
      return {
        stage,
        code: "storage_conflict",
        retryable: true,
        status: 503,
        providerStatus: error.status,
        providerCode: error.providerCode,
        detail,
      };
    }
    if (error.retryable) {
      const code = error.providerCode === "TimeoutError" ? "storage_timeout" : "storage_unavailable";
      return {
        stage,
        code,
        retryable: true,
        status: 503,
        providerStatus: error.status,
        providerCode: error.providerCode,
        detail,
      };
    }
    return {
      stage,
      code: "storage_rejected",
      retryable: false,
      status: 502,
      providerStatus: error.status,
      providerCode: error.providerCode,
      detail,
    };
  }

  if (isTempFileFailure(error)) {
    return {
      stage: "temp_file",
      code: "temp_file_unwritable",
      retryable: false,
      status: 507,
      providerStatus: null,
      providerCode: (error as { code?: string }).code ?? null,
      detail: detailOf(error),
    };
  }

  const pg = pgErrorOf(error);
  if (pg) {
    const transient =
      TRANSIENT_PG_CODES.has(pg.code) || TRANSIENT_PG_CODE_PREFIXES.some((prefix) => pg.code.startsWith(prefix));
    return {
      stage: "database",
      code: transient ? "database_unavailable" : "database_error",
      retryable: transient,
      status: 503,
      providerStatus: null,
      providerCode: pg.code,
      detail: detailOf(error),
    };
  }

  if (error && typeof error === "object") {
    const candidate = error as { code?: unknown; name?: unknown };
    if (candidate.name === "AbortError") {
      return {
        stage: "aborted",
        code: "request_aborted",
        retryable: false,
        status: 499,
        providerStatus: null,
        providerCode: null,
        detail: detailOf(error),
      };
    }
    if (typeof candidate.code === "string" && TRANSIENT_NET_CODES.has(candidate.code)) {
      return {
        stage: "database",
        code: "database_unavailable",
        retryable: true,
        status: 503,
        providerStatus: null,
        providerCode: candidate.code,
        detail: detailOf(error),
      };
    }
  }

  return {
    stage: "unknown",
    code: "internal_error",
    retryable: false,
    status: 500,
    providerStatus: null,
    providerCode: null,
    detail: detailOf(error),
  };
}

/**
 * The one place a media failure becomes tenant-facing Persian text. Each entry
 * says what *the tenant* can do; anything that needs a platform operator says so
 * explicitly and points at the support reference instead of telling a cashier to
 * "check the connection settings" they cannot see.
 */
export const MEDIA_FAILURE_MESSAGES: Record<string, string> = {
  storage_not_configured: "فضای ذخیره‌سازی رسانه هنوز توسط مدیر پلتفرم پیکربندی نشده است.",
  temp_file_unwritable:
    "فایل موقت بارگذاری روی سرور ساخته نشد (فضای دیسک یا دسترسی پوشهٔ موقت). این مورد باید توسط مدیر پلتفرم بررسی شود.",
  temp_file_unreadable: "خواندن فایل موقت بارگذاری ناموفق بود. دوباره تلاش کنید؛ اگر تکرار شد کد پیگیری را به پشتیبانی اعلام کنید.",
  temp_file_mismatch: "فایل موقت بارگذاری کامل نشد. دوباره تلاش کنید.",
  storage_credentials_rejected:
    "سرویس ذخیره‌سازی ابری کلید دسترسی را نپذیرفت. این مورد باید توسط مدیر پلتفرم اصلاح شود؛ فایل شما ثبت نشد.",
  storage_object_missing: "فایل در فضای ذخیره‌سازی ابری پیدا نشد. با پشتیبانی تماس بگیرید و کد پیگیری را اعلام کنید.",
  storage_unavailable: "سرویس ذخیره‌سازی ابری موقتاً در دسترس نیست؛ چند لحظه بعد دوباره تلاش کنید.",
  storage_timeout: "ارتباط با فضای ذخیره‌سازی ابری زمان‌بر شد و ناتمام ماند؛ دوباره تلاش کنید.",
  storage_conflict: "ذخیره‌سازی با تضاد موقت مواجه شد؛ دوباره تلاش کنید.",
  storage_rejected: "سرویس ذخیره‌سازی ابری این درخواست را رد کرد. با پشتیبانی تماس بگیرید و کد پیگیری را اعلام کنید.",
  database_unavailable: "پایگاه‌داده موقتاً در دسترس نیست؛ چند لحظه بعد دوباره تلاش کنید. فایلی ثبت نشد.",
  database_error:
    "ثبت اطلاعات فایل در پایگاه‌داده ناموفق بود و فایل نیمه‌کاره پاک شد. دوباره تلاش کنید؛ اگر تکرار شد کد پیگیری را به پشتیبانی اعلام کنید.",
  incomplete_config:
    "پیکربندی ذخیره‌سازی کامل نیست: آدرس سرویس، باکت، کلید دسترسی و کلید محرمانه هر چهار مورد لازم‌اند.",
  storage_disabled:
    "پیکربندی ذخیره شده است اما کتابخانهٔ رسانه برای کسب‌وکارها غیرفعال است؛ تا فعال نشدن، بارگذاری‌ها رد می‌شوند.",
  cleanup_failed:
    "فایل‌های آزمایشی از باکت حذف نشدند؛ دسترسی حذف شیء (DeleteObject) در این باکت برقرار نیست. تا رفع این مورد، حذف فایل‌ها و پاک‌سازی فایل‌های نیمه‌کاره قابل اعتماد نیست.",
  probe_content_mismatch: "محتوای خوانده‌شده از باکت با محتوای نوشته‌شده یکسان نبود (راستی‌آزمایی SHA-256 ناموفق).",
  stream_probe_content_mismatch:
    "فایل جریانی خوانده‌شده از باکت با فایل نوشته‌شده یکسان نبود؛ مسیر بارگذاری فایل‌های بزرگ سالم نیست.",
  probe_head_mismatch: "اندازهٔ گزارش‌شده با HEAD با فایل نوشته‌شده یکسان نبود.",
  media_storage_migrating:
    "مهاجرت فضای ذخیره‌سازی در جریان است؛ برای جلوگیری از ناسازگاری، بارگذاری چند دقیقه بعد دوباره انجام شود.",
  request_aborted: "بارگذاری لغو شد.",
  internal_error: "خطای غیرمنتظره در ذخیرهٔ فایل. دوباره تلاش کنید؛ اگر تکرار شد کد پیگیری را به پشتیبانی اعلام کنید.",
};

export function mediaFailureMessage(code: string): string {
  return MEDIA_FAILURE_MESSAGES[code] ?? MEDIA_FAILURE_MESSAGES.internal_error;
}

/** The `{ error, message, reference, retryable }` body every media route returns. */
export function mediaFailureBody(failure: MediaFailure, reference: string): {
  error: string;
  message: string;
  reference: string;
  retryable: boolean;
  stage: MediaFailureStage;
} {
  return {
    error: failure.code,
    message: mediaFailureMessage(failure.code),
    reference,
    retryable: failure.retryable,
    stage: failure.stage,
  };
}

/**
 * Request identifier used to correlate the tenant's one-line error with this
 * server's structured log entry. Honours an inbound `x-request-id` from the
 * platform edge when it is short and safe, otherwise mints one.
 */
export function mediaRequestId(inbound?: string | null, now: number = Date.now()): string {
  const normalized = (inbound ?? "").trim();
  if (/^[A-Za-z0-9._-]{6,64}$/.test(normalized)) return normalized;
  const random = Math.random().toString(36).slice(2, 8);
  return `media-${now.toString(36)}-${random}`;
}

/** A key with the user's file name masked: still greppable, still not the file name. */
export function maskObjectKey(key: string): string {
  const parts = key.split("/");
  const name = parts[parts.length - 1] ?? "";
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot) : "";
  parts[parts.length - 1] = `«file»${extension}`;
  return parts.join("/");
}

export interface MediaFailureLogContext {
  operation: string;
  requestId: string;
  businessId?: string | null;
  scope: "tenant" | "platform";
  objectKey?: string | null;
  byteSize?: number | null;
  streamed?: boolean | null;
  durationMs?: number | null;
  extra?: Record<string, unknown>;
}

export interface MediaFailureRecord {
  stage: MediaFailureStage;
  code: string;
  status?: number;
  retryable?: boolean;
  providerStatus?: number | null;
  providerCode?: string | null;
  detail?: string;
}

/**
 * Emit exactly one structured, secret-free line per failure. JSON rather than a
 * sentence because this is what a collector (or `grep`) can actually filter by
 * stage, and because a support engineer asked for the reference on a ticket
 * needs to find the matching entry in one step.
 */
export function logMediaFailureRecord(record: MediaFailureRecord, context: MediaFailureLogContext): void {
  const status = record.status ?? 500;
  const line = {
    event: "media.failure",
    level: status >= 500 ? "error" : "warn",
    operation: context.operation,
    scope: context.scope,
    requestId: context.requestId,
    businessId: context.businessId ?? null,
    stage: record.stage,
    code: record.code,
    httpStatus: status,
    retryable: record.retryable ?? false,
    providerStatus: record.providerStatus ?? null,
    providerCode: record.providerCode ?? null,
    objectKey: context.objectKey ? maskObjectKey(context.objectKey) : null,
    byteSize: context.byteSize ?? null,
    streamed: context.streamed ?? null,
    durationMs: context.durationMs ?? null,
    detail: redactMediaDetail(record.detail ?? ""),
    ...(context.extra ?? {}),
  };
  console.error(`[media] ${JSON.stringify(line)}`);
}

/** Classify, log and return — the one call an upload path needs. */
export function logMediaFailure(error: unknown, context: MediaFailureLogContext): MediaFailure {
  const failure = classifyMediaFailure(error);
  logMediaFailureRecord(failure, context);
  return failure;
}
