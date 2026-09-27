/**
 * The upload engine behind `POST /api/media` — bounded concurrency, retry on
 * a transient failure only, and a working cancel switch. A pure-Node suite:
 * `fetchImpl`/`sleepImpl` are injected so no real network or timer is ever
 * touched, matching the "framework-free unit test" convention this repo uses
 * for anything that does not need a rendered component (see vitest.config.ts).
 */
import { describe, expect, it, vi } from "vitest";
import { summarizeUploadResults, uploadFiles, type UploadProgressEvent } from "./media-uploader";

function file(name: string, bytes = "x"): File {
  return new File([bytes], name, { type: "image/png" });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function immediateSleep(): (ms: number) => Promise<void> {
  return () => Promise.resolve();
}

describe("uploadFiles", () => {
  it("uploads every file and reports one success event each", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const form = init!.body as FormData;
      const uploaded = form.get("file") as File;
      return jsonResponse(200, { asset: { id: `id-${uploaded.name}`, fileName: uploaded.name } });
    });
    const events: UploadProgressEvent[] = [];
    const { done } = uploadFiles([file("a.png"), file("b.png"), file("c.png")], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onProgress: (e) => events.push(e),
      sleepImpl: immediateSleep(),
    });
    const results = await done;
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.status === "success")).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    // queued -> uploading -> success per file, at minimum.
    const forA = events.filter((e) => e.file.name === "a.png").map((e) => e.status);
    expect(forA).toEqual(["queued", "uploading", "success"]);
  });

  it("never runs more than `concurrency` uploads at once", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchImpl = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return jsonResponse(200, { asset: { id: "x", fileName: "x" } });
    });
    const files = Array.from({ length: 8 }, (_, i) => file(`f${i}.png`));
    const { done } = uploadFiles(files, {
      concurrency: 2,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl: immediateSleep(),
    });
    await done;
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(fetchImpl).toHaveBeenCalledTimes(8);
  });

  it("retries a 503 with backoff and eventually succeeds", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls < 3) return jsonResponse(503, { message: "busy" });
      return jsonResponse(200, { asset: { id: "ok", fileName: "a.png" } });
    });
    const sleeps: number[] = [];
    const { done } = uploadFiles([file("a.png")], {
      maxRetries: 3,
      retryDelayMs: 100,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    const [result] = await done;
    expect(result.status).toBe("success");
    expect(result.attempt).toBe(3);
    expect(calls).toBe(3);
    // Exponential backoff: 100ms, then 200ms before the two retries.
    expect(sleeps).toEqual([100, 200]);
  });

  it("does not retry a validation rejection (422) — one attempt, reported as error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(422, { message: "نوع فایل مجاز نیست." }));
    const { done } = uploadFiles([file("virus.exe")], {
      maxRetries: 5,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl: immediateSleep(),
    });
    const [result] = await done;
    expect(result.status).toBe("error");
    expect(result.attempt).toBe(1);
    expect(result.message).toBe("نوع فایل مجاز نیست.");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxRetries and reports error, not an infinite loop", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, { message: "down" }));
    const { done } = uploadFiles([file("a.png")], {
      maxRetries: 2,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl: immediateSleep(),
    });
    const [result] = await done;
    expect(result.status).toBe("error");
    expect(result.attempt).toBe(3); // 1 initial + 2 retries
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("cancel() settles every file, marking the ones that never got a worker as canceled without a network call", async () => {
    let started = 0;
    const fetchImpl = vi.fn(async () => {
      started += 1;
      await new Promise((r) => setTimeout(r, 10));
      return jsonResponse(200, { asset: { id: "x", fileName: "x" } });
    });
    const files = Array.from({ length: 6 }, (_, i) => file(`f${i}.png`));
    const { done, cancel } = uploadFiles(files, {
      concurrency: 2,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl: immediateSleep(),
    });
    // A promise pool runs synchronously up to its first `await` — with
    // concurrency 2, the first 2 files' requests are already in flight by
    // the time this line runs (same as any worker-pool implementation), so
    // cancel() here can only stop the 4 files a worker had not reached yet.
    cancel();
    const results = await done;
    expect(results).toHaveLength(6);
    expect(results.every((r) => r.status === "canceled" || r.status === "success")).toBe(true);
    expect(started).toBeLessThanOrEqual(2);
    expect(results.filter((r) => r.status === "canceled").length).toBeGreaterThanOrEqual(4);
  });

  it("cancel() mid-flight aborts requests already in progress via the shared AbortSignal", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((resolve, reject) => {
        const signal = init?.signal;
        const timer = setTimeout(() => resolve(jsonResponse(200, { asset: { id: "x", fileName: "x" } })), 50);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    });
    const { done, cancel } = uploadFiles([file("a.png"), file("b.png")], {
      concurrency: 2,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl: immediateSleep(),
    });
    setTimeout(() => cancel(), 5);
    const results = await done;
    expect(results.every((r) => r.status === "canceled")).toBe(true);
  });
});

describe("summarizeUploadResults", () => {
  it("splits success into stored vs. reused (duplicate) and counts error/canceled separately", () => {
    const events: UploadProgressEvent[] = [
      { id: "1", file: file("a"), status: "success", attempt: 1, asset: { id: "1", fileName: "a" } },
      { id: "2", file: file("b"), status: "success", attempt: 1, asset: { id: "2", fileName: "b", duplicate: true } },
      { id: "3", file: file("c"), status: "error", attempt: 3, message: "failed" },
      { id: "4", file: file("d"), status: "canceled", attempt: 0 },
    ];
    expect(summarizeUploadResults(events)).toEqual({ stored: 1, reused: 1, failed: 1, canceled: 1 });
  });
});
