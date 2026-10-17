import { describe, expect, it } from "vitest";
import {
  attemptCentralWatch,
  centralWatchUrl,
  classifyHttpFailure,
  classifyThrownFailure,
  describeEdge,
  describeWatchFailure,
  jitteredWatchDelay,
  MAX_PULL_WAIT_SECONDS,
  SYNC_PULL_MARKER_HEADER,
  SyncWatchError,
  WATCH_HELD_ENOUGH_MS,
  WATCH_QUICK_RETRY_MS,
  WATCH_RETRY_MS,
  WATCH_TIMEOUT_MS,
  WATCH_WAIT_SECONDS,
  watchFailureLogLevel,
  watchRetryDelayMs,
  type WatchFetch,
} from "./sync-watch";

const NO_JITTER = () => 0.5;

function marked(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", [SYNC_PULL_MARKER_HEADER]: "1", ...(init.headers ?? {}) },
  });
}

function edgeResponse(status: number, headers: Record<string, string> = {}) {
  return new Response("<html>edge</html>", { status, headers });
}

function watch(fetchImpl: WatchFetch, overrides: Partial<Parameters<typeof attemptCentralWatch>[0]> = {}) {
  return attemptCentralWatch({
    remoteUrl: "https://central.example/",
    token: " secret-token\n",
    afterEventId: 41,
    afterTxid: "900",
    signal: new AbortController().signal,
    fetchImpl,
    ...overrides,
  });
}

async function failureOf(promise: Promise<unknown>): Promise<SyncWatchError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SyncWatchError);
    return error as SyncWatchError;
  }
  throw new Error("expected the watch to fail");
}

describe("the watch request", () => {
  it("peeks one event, from a cursor, on a hold short enough for an edge", () => {
    const url = centralWatchUrl({ remoteUrl: " https://central.example// ", afterEventId: 7, afterTxid: "99" });
    expect(url.pathname).toBe("/api/server-sync/pull");
    expect(url.searchParams.get("after")).toBe("7");
    expect(url.searchParams.get("afterTx")).toBe("99");
    expect(url.searchParams.get("limit")).toBe("1");
    expect(url.searchParams.get("peek")).toBe("1");
    expect(url.searchParams.get("wait")).toBe(String(WATCH_WAIT_SECONDS));
    expect(centralWatchUrl({ remoteUrl: "https://central.example" }).searchParams.get("afterTx")).toBe("0");
  });

  it("keeps the client's hold and deadline inside the server's own ceiling", () => {
    // The edge-knife window (issue #989) is ~30 s of an idle connection.
    expect(WATCH_WAIT_SECONDS).toBeLessThan(MAX_PULL_WAIT_SECONDS);
    expect(MAX_PULL_WAIT_SECONDS).toBeLessThan(30);
    // A client must never abort a hold before the server itself would answer.
    expect(WATCH_TIMEOUT_MS).toBeGreaterThan(MAX_PULL_WAIT_SECONDS * 1000);
  });

  it("sends the token and returns what the central said is pending", async () => {
    const seen: { url?: URL; init?: RequestInit } = {};
    const answer = await watch(async (url, init) => {
      seen.url = url;
      seen.init = init;
      return marked({ pending: true });
    });
    expect(answer.pending).toBe(true);
    expect(seen.url?.hostname).toBe("central.example");
    expect((seen.init?.headers as Record<string, string>).Authorization).toBe("Bearer secret-token");
  });

  it("treats a marked answer that is not JSON as a protocol failure", async () => {
    const error = await failureOf(
      watch(async () => new Response("not-json", { headers: { [SYNC_PULL_MARKER_HEADER]: "1" } })),
    );
    expect(error.failure.kind).toBe("protocol");
    expect(error.failure.answeredBy).toBe("app");
  });

  it("treats a body cut off after a long hold as the edge ending the hold", async () => {
    let clock = 0;
    const error = await failureOf(
      attemptCentralWatch({
        remoteUrl: "https://central.example",
        token: "t",
        signal: new AbortController().signal,
        now: () => clock,
        fetchImpl: async () => {
          clock += 15_000;
          return new Response('{"pending": tr', {
            headers: { "content-type": "application/json", [SYNC_PULL_MARKER_HEADER]: "1" },
          });
        },
      }),
    );
    expect(error.failure.kind).toBe("hold-ended");
    expect(error.failure.detail).toContain("cut off");
  });
});

describe("classifying a failed watch", () => {
  it("reads a bare 502/503/504 as the edge ending the hold, not the app", () => {
    for (const status of [502, 503, 504]) {
      expect(classifyHttpFailure(status, false)).toBe("hold-ended");
    }
    // The app never writes these itself; if it somehow does, it is our bug.
    expect(classifyHttpFailure(502, true)).toBe("server-error");
  });

  it("keeps a refused credential and other app errors in the alarming class", () => {
    expect(classifyHttpFailure(401, true)).toBe("unauthorized");
    expect(classifyHttpFailure(403, false)).toBe("unauthorized");
    expect(classifyHttpFailure(400, true)).toBe("server-error");
    expect(classifyHttpFailure(500, true)).toBe("server-error");
  });

  it("classifies a timeout or a cut socket as an ended hold", () => {
    expect(classifyThrownFailure({ name: "TimeoutError", heldMs: 25_000 })).toBe("hold-ended");
    expect(classifyThrownFailure({ name: "AbortError", heldMs: 10 })).toBe("hold-ended");
    expect(classifyThrownFailure({ name: "TypeError", code: "UND_ERR_SOCKET", heldMs: 100 })).toBe("hold-ended");
    expect(classifyThrownFailure({ name: "TypeError", code: "ECONNRESET", heldMs: 100 })).toBe("hold-ended");
  });

  it("calls a quick connection failure unreachable, but a long-open one an ended hold", () => {
    expect(classifyThrownFailure({ name: "TypeError", code: "ECONNREFUSED", heldMs: 80 })).toBe("unreachable");
    expect(classifyThrownFailure({ name: "TypeError", code: "ENOTFOUND", heldMs: 10 })).toBe("unreachable");
    // It was held: whatever ended it, it was the connection, not the site.
    expect(classifyThrownFailure({ name: "TypeError", code: "ECONNREFUSED", heldMs: WATCH_HELD_ENOUGH_MS })).toBe(
      "hold-ended",
    );
  });

  it("reports an edged 502 with the upstream headers and no app marker", async () => {
    const error = await failureOf(
      watch(async () => edgeResponse(502, { server: "nginx", via: "1.1 cdn", "x-request-id": "abc" })),
    );
    expect(error.failure.kind).toBe("hold-ended");
    expect(error.failure.answeredBy).toBe("edge");
    expect(error.failure.edge).toContain("server=nginx");
    expect(error.failure.edge).toContain("x-request-id=abc");
    const line = describeWatchFailure(error.failure, 1);
    expect(line).toContain("HTTP 502");
    expect(line).toContain("did not come from the app");
    expect(line).toContain("sync wake:");
    expect(line).not.toContain("secret-token");
  });

  it("classifies a fetch failure quickly versus mid-hold", async () => {
    const quick = await failureOf(
      watch(async () => {
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      }),
    );
    expect(quick.failure.kind).toBe("unreachable");

    let clock = 1_000;
    const slow = await failureOf(
      attemptCentralWatch({
        remoteUrl: "https://central.example",
        token: "t",
        signal: new AbortController().signal,
        now: () => clock,
        fetchImpl: async () => {
          clock += 15_000;
          throw Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } });
        },
      }),
    );
    expect(slow.failure.kind).toBe("hold-ended");
    expect(slow.failure.heldMs).toBe(15_000);
  });

  it("describes the upstream even when it only supplies one header", () => {
    expect(describeEdge(new Headers({ server: "nginx" }))).toBe("server=nginx");
    expect(describeEdge(new Headers())).toBeNull();
  });
});

describe("quiet logging", () => {
  it("never raises an ended hold above debug", () => {
    expect(watchFailureLogLevel("hold-ended", 1)).toBe("debug");
    expect(watchFailureLogLevel("hold-ended", 40)).toBe("debug");
  });

  it("announces a real failure once per streak, then stays at debug", () => {
    expect(watchFailureLogLevel("unreachable", 1)).toBe("warn");
    expect(watchFailureLogLevel("unreachable", 2)).toBe("debug");
    expect(watchFailureLogLevel("unauthorized", 1)).toBe("error");
    expect(watchFailureLogLevel("unauthorized", 5)).toBe("debug");
    expect(watchFailureLogLevel("server-error", 1)).toBe("error");
    expect(watchFailureLogLevel("protocol", 1)).toBe("error");
  });

  it("says something useful but files an ended hold under debug", () => {
    const failure = {
      kind: "hold-ended" as const,
      heldMs: 15_200,
      detail: "HTTP 502",
      answeredBy: "edge" as const,
      edge: "server=nginx",
    };
    expect(describeWatchFailure(failure, 3)).toBe(
      "sync wake: central watch ended early: HTTP 502 after 15.2s; answered before the app, so it did not come from the app; edge: server=nginx; attempt 3",
    );
  });
});

describe("retry timing (issue #989, ask 3)", () => {
  it("jitters a full retry by ±20% so a fleet cannot retry in lockstep", () => {
    expect(watchRetryDelayMs(0, () => 0)).toBe(WATCH_RETRY_MS * 0.8);
    expect(watchRetryDelayMs(0, NO_JITTER)).toBe(WATCH_RETRY_MS);
    expect(watchRetryDelayMs(0, () => 1)).toBe(WATCH_RETRY_MS * 1.2);
    expect(jitteredWatchDelay(1_000, () => 0)).toBe(800);
  });

  it("does not charge a second idle wait for a hold that already served as one", () => {
    // An edge that caps holds at ~15 s must not cost another 30 s before the
    // next attempt — the hold itself was the waiting.
    expect(watchRetryDelayMs(WATCH_WAIT_SECONDS * 1000, NO_JITTER)).toBe(WATCH_QUICK_RETRY_MS);
    expect(watchRetryDelayMs(WATCH_HELD_ENOUGH_MS, NO_JITTER)).toBe(WATCH_QUICK_RETRY_MS);
    expect(watchRetryDelayMs(WATCH_HELD_ENOUGH_MS - 1, NO_JITTER)).toBe(WATCH_RETRY_MS);
    // Jittered even there.
    expect(watchRetryDelayMs(WATCH_HELD_ENOUGH_MS, () => 0)).toBe(WATCH_QUICK_RETRY_MS * 0.8);
  });
});
