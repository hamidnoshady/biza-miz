/**
 * The one client-side upload engine for `POST /api/media` — Section J of
 * `MEDIA_LIBRARY_REPORT.md` named "no bounded-concurrency/retry/cancel upload
 * manager" as the largest concretely-scoped gap in the Media program; this
 * closes it.
 *
 * Both the library manager (many files at once) and the universal picker
 * (one file, picked immediately) used to run their own bare
 * `fetch("/api/media", {method:"POST", body:form})` loop with no retry, no
 * cap on how many requests fired at once, and no way to stop a batch that
 * was still running. This module is that one implementation instead — a
 * small worker-pool that
 *
 *  - runs at most `concurrency` uploads at a time (default 3) rather than
 *    either one-at-a-time (slow for a folder of photos) or unbounded (a
 *    hundred simultaneous multipart POSTs against one tenant's storage);
 *  - retries a transient failure (network error, or a 5xx/408/429 the server
 *    itself signals as "try again") with exponential backoff, but never a
 *    validation rejection (400/401/403/404/409/413/415/422) — a rejected
 *    file will still be rejected the second time, so retrying it only
 *    delays the operator's toast;
 *  - can cancel the whole in-flight batch (`cancel()`) or, per-file, is
 *    identified stably enough for a caller to show one row of progress per
 *    file and let the operator watch it move from «در صف» → «در حال
 *    بارگذاری» → «موفق»/«ناموفق»/«لغو شد».
 *
 * `fetchImpl` exists solely so this can be unit-tested in Node without a
 * DOM or a real network — the default is the ambient `fetch`, which is what
 * every real caller (browser) gets.
 */

export interface UploadedAssetSummary {
  id: string;
  fileName: string;
  duplicate?: boolean;
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
  // Name+size+lastModified is stable for the same File object across
  // re-renders without needing crypto.randomUUID (unavailable in some
  // embedded/older WebViews this app also targets) — index breaks a tie
  // between two identically-named files picked in the same batch.
  return `${index}:${file.name}:${file.size}:${file.lastModified}`;
}

async function uploadOnce(
  file: File,
  folderId: string | null | undefined,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<{ ok: true; asset: UploadedAssetSummary } | { ok: false; retryable: boolean; message: string }> {
  const form = new FormData();
  form.set("file", file);
  if (folderId) form.set("folderId", folderId);
  let res: Response;
  try {
    res = await fetchImpl("/api/media", { method: "POST", body: form, signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw err; // let the caller's cancellation path handle it, not a retry
    }
    return { ok: false, retryable: true, message: "ارتباط با سرور برقرار نشد." };
  }
  let body: { message?: string; asset?: UploadedAssetSummary; duplicate?: boolean };
  try {
    body = await res.json();
  } catch {
    body = {};
  }
  if (res.ok && body.asset) {
    return { ok: true, asset: { ...body.asset, duplicate: body.duplicate } };
  }
  return {
    ok: false,
    retryable: RETRYABLE_STATUS.has(res.status),
    message: body.message ?? "بارگذاری فایل ناموفق بود.",
  };
}

/**
 * Uploads every file in `files` to `POST /api/media` under bounded
 * concurrency, with retry-on-transient-failure and a single cancel switch
 * for the whole batch. Never throws — every file resolves to exactly one
 * terminal `UploadProgressEvent` in the array `done` settles with, same
 * spirit as `api()` in `dashboard/ui.tsx` never rejecting: a caller driving
 * a progress list from `onProgress` must not also need a try/catch around
 * this call.
 */
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
        outcome = await uploadOnce(file, options.folderId, fetchImpl, controller.signal);
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
      // A canceled batch still claims every remaining task rather than
      // stopping the pool short — runOne resolves each one instantly as
      // "canceled" (no network call), so every file the caller is showing a
      // progress row for reaches a terminal status, not just the ones a
      // worker happened to reach before the cancel flag flipped.
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

/** Small summary a caller (the manager's toast, the picker's single-file case) folds a finished batch into — the same three counts every upload flow in this app has always reported. */
export function summarizeUploadResults(events: UploadProgressEvent[]): { stored: number; reused: number; failed: number; canceled: number } {
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
  return { stored, reused, failed, canceled: canceledCount };
}
