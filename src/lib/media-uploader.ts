/**
 * The one client-side upload engine for `POST /api/media` — Section J of
 * `MEDIA_LIBRARY_REPORT.md` named "no bounded-concurrency/retry/cancel upload
 * manager" as the largest concretely-scoped gap in the Media program; this
 * closes it.
 *
 * Both the library manager (many files at once) and the universal picker
 * (one file, picked immediately) run through this single worker pool:
 *
 *  - runs at most `concurrency` uploads at a time (default 3) rather than
 *    either one-at-a-time (slow for a folder of photos) or unbounded (a
 *    hundred simultaneous multipart POSTs against one tenant's storage);
 *  - retries a transient failure (network error, or a 5xx/408/429 the server
 *    itself signals as "try again") with exponential backoff, but never a
 *    validation rejection (400/401/403/404/409/413/415/422);
 *  - forwards explicit duplicate policy (`onDuplicate`: `"reuse" | "duplicate" | "move"`
 *    or `allowDuplicate`) and surfaces `folderMismatch` metadata returned by
 *    atomic server-side SHA-256 deduplication;
 *  - can cancel the whole in-flight batch (`cancel()`) cleanly.
 */

export type UploadDuplicateMode = "reuse" | "duplicate" | "move";

export interface UploadedAssetSummary {
  id: string;
  fileName: string;
  duplicate?: boolean;
  reused?: boolean;
  action?: "stored" | "reused" | "moved_and_reused";
  requestedFolderId?: string | null;
  folderMismatch?: boolean;
}

export type UploadProgressStatus = "queued" | "uploading" | "retrying" | "success" | "error" | "canceled";

export interface UploadProgressEvent {
  /** Stable per-file identity for the lifetime of one `uploadFiles()` call — a caller renders one progress row per id. */
  id: string;
  file: File;
  status: UploadProgressStatus;
  /** 1 on the first attempt, 2+ on a retry. */
  attempt: number;
  message?: string;
  asset?: UploadedAssetSummary;
}

export interface UploadFilesOptions {
  folderId?: string | null;
  /** Explicit server-side duplicate handling policy (`reuse` default, `move` existing to `folderId`, or `duplicate`). */
  onDuplicate?: UploadDuplicateMode;
  allowDuplicate?: boolean;
  /** How many uploads run at once. Default 3 — enough to feel parallel without hammering one tenant's storage. */
  concurrency?: number;
  /** Extra attempts after the first, only for a retryable failure. Default 2 (so up to 3 attempts total). */
  maxRetries?: number;
  /** Base backoff before the first retry; doubles each subsequent retry. Default 400ms. */
  retryDelayMs?: number;
  onProgress?: (event: UploadProgressEvent) => void;
  fetchImpl?: typeof fetch;
  /** Overrides the real timer for tests; defaults to `setTimeout`. */
  sleepImpl?: (ms: number) => Promise<void>;
}

export interface UploadBatchHandle {
  /** Stops any not-yet-started file from starting and aborts every in-flight request. Already-finished files are untouched. */
  cancel: () => void;
  /** Resolves once every file has reached a terminal status (success/error/canceled), one event each, in no particular order. */
  done: Promise<UploadProgressEvent[]>;
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fileIdentity(file: File, index: number): string {
  return `${index}:${file.name}:${file.size}:${file.lastModified}`;
}

async function uploadOnce(
  file: File,
  options: Pick<UploadFilesOptions, "folderId" | "onDuplicate" | "allowDuplicate">,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<{ ok: true; asset: UploadedAssetSummary } | { ok: false; retryable: boolean; message: string }> {
  const form = new FormData();
  form.set("file", file);
  if (options.folderId) form.set("folderId", options.folderId);
  if (options.allowDuplicate) {
    form.set("allowDuplicate", "1");
  } else if (options.onDuplicate && options.onDuplicate !== "reuse") {
    form.set("onDuplicate", options.onDuplicate);
  }
  let res: Response;
  try {
    res = await fetchImpl("/api/media", { method: "POST", body: form, signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw err; // let the caller's cancellation path handle it, not a retry
    }
    return { ok: false, retryable: true, message: "ارتباط با سرور برقرار نشد." };
  }
  let body: {
    message?: string;
    asset?: UploadedAssetSummary;
    duplicate?: boolean;
    reused?: boolean;
    action?: "stored" | "reused" | "moved_and_reused";
    requestedFolderId?: string | null;
    folderMismatch?: boolean;
  };
  try {
    body = await res.json();
  } catch {
    body = {};
  }
  if (res.ok && body.asset) {
    return {
      ok: true,
      asset: {
        ...body.asset,
        duplicate: body.duplicate,
        reused: body.reused ?? body.duplicate,
        action: body.action,
        requestedFolderId: body.requestedFolderId,
        folderMismatch: body.folderMismatch ?? false,
      },
    };
  }
  return {
    ok: false,
    retryable: RETRYABLE_STATUS.has(res.status),
    message: body.message ?? "بارگذاری فایل ناموفق بود.",
  };
}

export function uploadFiles(files: File[], options: UploadFilesOptions = {}): UploadBatchHandle {
  const concurrency = Math.max(1, options.concurrency ?? 3);
  const maxRetries = Math.max(0, options.maxRetries ?? 2);
  const retryDelayMs = options.retryDelayMs ?? 400;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleepImpl ?? defaultSleep;
  const onProgress = options.onProgress ?? (() => {});

  const controller = new AbortController();
  let canceled = false;

  const tasks = files.map((file, index) => ({ file, id: fileIdentity(file, index) }));
  const results: UploadProgressEvent[] = [];
  let cursor = 0;

  function emit(event: UploadProgressEvent) {
    onProgress(event);
  }

  async function runOne(task: { file: File; id: string }): Promise<void> {
    const { file, id } = task;
    if (canceled) {
      const event: UploadProgressEvent = { id, file, status: "canceled", attempt: 0 };
      results.push(event);
      emit(event);
      return;
    }
    let attempt = 1;
    emit({ id, file, status: "uploading", attempt });
    for (;;) {
      let outcome: Awaited<ReturnType<typeof uploadOnce>>;
      try {
        outcome = await uploadOnce(
          file,
          {
            folderId: options.folderId,
            onDuplicate: options.onDuplicate,
            allowDuplicate: options.allowDuplicate,
          },
          fetchImpl,
          controller.signal,
        );
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          const event: UploadProgressEvent = { id, file, status: "canceled", attempt };
          results.push(event);
          emit(event);
          return;
        }
        outcome = { ok: false, retryable: true, message: "ارتباط با سرور برقرار نشد." };
      }
      if (outcome.ok) {
        const event: UploadProgressEvent = { id, file, status: "success", attempt, asset: outcome.asset };
        results.push(event);
        emit(event);
        return;
      }
      if (!outcome.retryable || attempt > maxRetries || canceled) {
        const event: UploadProgressEvent = { id, file, status: "error", attempt, message: outcome.message };
        results.push(event);
        emit(event);
        return;
      }
      emit({ id, file, status: "retrying", attempt, message: outcome.message });
      await sleep(retryDelayMs * 2 ** (attempt - 1));
      if (canceled) {
        const event: UploadProgressEvent = { id, file, status: "canceled", attempt };
        results.push(event);
        emit(event);
        return;
      }
      attempt += 1;
    }
  }

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= tasks.length) return;
      await runOne(tasks[index]);
    }
  }

  for (const task of tasks) {
    emit({ id: task.id, file: task.file, status: "queued", attempt: 0 });
  }

  const workerCount = Math.min(concurrency, tasks.length);
  const done = Promise.all(Array.from({ length: workerCount }, () => worker())).then(() => results);

  return {
    cancel: () => {
      if (canceled) return;
      canceled = true;
      controller.abort();
    },
    done,
  };
}

export function summarizeUploadResults(events: UploadProgressEvent[]): {
  stored: number;
  reused: number;
  failed: number;
  canceled: number;
} {
  let stored = 0;
  let reused = 0;
  let failed = 0;
  let canceledCount = 0;
  for (const event of events) {
    if (event.status === "success") {
      if (event.asset?.duplicate) reused += 1;
      else stored += 1;
    } else if (event.status === "error") {
      failed += 1;
    } else if (event.status === "canceled") {
      canceledCount += 1;
    }
  }
  return { stored, reused, failed: failed, canceled: canceledCount };
}

export function summarizeDuplicateDetails(events: UploadProgressEvent[]): {
  movedAndReused: number;
  folderMismatches: number;
} {
  let movedAndReused = 0;
  let folderMismatches = 0;
  for (const event of events) {
    if (event.status === "success" && event.asset?.duplicate) {
      if (event.asset.action === "moved_and_reused") movedAndReused += 1;
      if (event.asset.folderMismatch) folderMismatches += 1;
    }
  }
  return { movedAndReused, folderMismatches };
}
