import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  REALTIME_HEARTBEAT_MS,
  REALTIME_MAX_PAYLOAD_BYTES,
  authorizeRealtimeUpgrade,
  createRealtimeHeartbeat,
  readCookieValue,
  rejectUpgrade,
  type HeartbeatSocket,
  type RealtimeScopeLike,
} from "./realtime-upgrade";

/**
 * Issue #1003 item 4 — the `/ws` upgrade decisions server.ts makes. The bug
 * was a handler that could *reject* (malformed cookie, failed lookup) before
 * it destroyed the socket; here every outcome must be a status, and the
 * cheapest refusal must come first.
 */

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("readCookieValue", () => {
  it("reads and decodes the named cookie", () => {
    expect(readCookieValue("a=1; pos_session=abc%2Edef; b=2", "pos_session")).toBe("abc.def");
    expect(readCookieValue("pos_session=x", "pos_session")).toBe("x");
  });

  it("treats a value that does not percent-decode as absent instead of throwing", () => {
    expect(() => readCookieValue("pos_session=%", "pos_session")).not.toThrow();
    expect(readCookieValue("pos_session=%", "pos_session")).toBeNull();
    expect(readCookieValue("pos_session=abc%E0%A4%A", "pos_session")).toBeNull();
  });

  it("returns null for a missing header or cookie", () => {
    expect(readCookieValue(undefined, "pos_session")).toBeNull();
    expect(readCookieValue("", "pos_session")).toBeNull();
    expect(readCookieValue("other=1; novalue", "pos_session")).toBeNull();
  });
});

describe("authorizeRealtimeUpgrade", () => {
  type Session = { sub: string };
  const session: Session = { sub: "user-1" };
  const granted: RealtimeScopeLike<Session> = { ok: true, session, locationIds: new Set(["loc-1"]) };

  function deps(overrides: Partial<Parameters<typeof authorizeRealtimeUpgrade<Session>>[1]> = {}) {
    return {
      cookieName: "pos_session",
      resolveSession: vi.fn(async () => session as Session | null),
      resolveScope: vi.fn(async () => granted),
      log: vi.fn(),
      ...overrides,
    };
  }

  it("refuses a foreign Origin before any lookup, cookie or not", async () => {
    const d = deps();
    expect(await authorizeRealtimeUpgrade({ originAllowed: false, cookieHeader: "pos_session=t" }, d)).toEqual({
      ok: false,
      status: 403,
    });
    expect(d.resolveSession).not.toHaveBeenCalled();
    expect(d.resolveScope).not.toHaveBeenCalled();
  });

  it("answers 401 for a missing or malformed cookie without a lookup", async () => {
    for (const cookieHeader of [undefined, "", "other=1", "pos_session=", "pos_session=%"]) {
      const d = deps();
      expect(await authorizeRealtimeUpgrade({ originAllowed: true, cookieHeader }, d), String(cookieHeader)).toEqual({
        ok: false,
        status: 401,
      });
      expect(d.resolveSession).not.toHaveBeenCalled();
    }
  });

  it("answers 401 for a session that does not resolve, and 503 when the lookup throws", async () => {
    expect(
      await authorizeRealtimeUpgrade(
        { originAllowed: true, cookieHeader: "pos_session=t" },
        deps({ resolveSession: vi.fn(async () => null) }),
      ),
    ).toEqual({ ok: false, status: 401 });

    const d = deps({ resolveSession: vi.fn(async () => Promise.reject(new Error("connection terminated"))) });
    expect(await authorizeRealtimeUpgrade({ originAllowed: true, cookieHeader: "pos_session=t" }, d)).toEqual({
      ok: false,
      status: 503,
    });
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining("connection terminated"));
    expect(d.resolveScope).not.toHaveBeenCalled();
  });

  it("passes the scope's own refusal through, and 503 when the scope read throws", async () => {
    for (const status of [401, 403] as const) {
      expect(
        await authorizeRealtimeUpgrade(
          { originAllowed: true, cookieHeader: "pos_session=t" },
          deps({ resolveScope: vi.fn(async () => ({ ok: false as const, status })) }),
        ),
      ).toEqual({ ok: false, status });
    }
    expect(
      await authorizeRealtimeUpgrade(
        { originAllowed: true, cookieHeader: "pos_session=t" },
        deps({ resolveScope: vi.fn(async () => Promise.reject(new Error("db down"))) }),
      ),
    ).toEqual({ ok: false, status: 503 });
  });

  it("grants the scope's session and branches, with the token the socket re-checks", async () => {
    const d = deps();
    const result = await authorizeRealtimeUpgrade({ originAllowed: true, cookieHeader: "pos_session=tok%2B1" }, d);
    expect(d.resolveSession).toHaveBeenCalledWith("tok+1");
    expect(result).toEqual({ ok: true, token: "tok+1", session, locationIds: new Set(["loc-1"]) });
  });
});

class FakeSocket extends EventEmitter {
  destroyed = false;
  writable = true;
  written: string[] = [];
  end(chunk: string) {
    this.written.push(chunk);
    this.writable = false;
    queueMicrotask(() => this.emit("finish"));
  }
  destroy() {
    this.destroyed = true;
  }
}

describe("rejectUpgrade", () => {
  it("writes the status line and destroys the socket once it is flushed", async () => {
    const socket = new FakeSocket();
    rejectUpgrade(socket, 401);
    expect(socket.written).toEqual(["HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"]);
    await Promise.resolve();
    expect(socket.destroyed).toBe(true);
  });

  it("destroys a socket that never drains after the grace period", () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    socket.end = (chunk: string) => {
      socket.written.push(chunk);
    };
    rejectUpgrade(socket, 503, 1_000);
    expect(socket.destroyed).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(socket.destroyed).toBe(true);
  });

  it("destroys without writing when the peer is already gone, and tolerates a destroyed socket", () => {
    const halfClosed = new FakeSocket();
    halfClosed.writable = false;
    rejectUpgrade(halfClosed, 403);
    expect(halfClosed.written).toEqual([]);
    expect(halfClosed.destroyed).toBe(true);

    const gone = new FakeSocket();
    gone.destroyed = true;
    expect(() => rejectUpgrade(gone, 500)).not.toThrow();
  });

  it("still destroys the socket when writing throws", () => {
    const socket = new FakeSocket();
    socket.end = () => {
      throw new Error("write after end");
    };
    rejectUpgrade(socket, 500);
    expect(socket.destroyed).toBe(true);
  });
});

class FakeClient extends EventEmitter implements HeartbeatSocket {
  pings = 0;
  terminated = false;
  ping() {
    this.pings += 1;
  }
  terminate() {
    this.terminated = true;
  }
  pong() {
    this.emit("pong");
  }
}

describe("createRealtimeHeartbeat", () => {
  it("pings live clients and terminates the ones that stopped answering", () => {
    vi.useFakeTimers();
    const clients = new Set<FakeClient>();
    const heartbeat = createRealtimeHeartbeat(clients, 1_000);
    const answering = new FakeClient();
    const silent = new FakeClient();
    for (const client of [answering, silent]) {
      clients.add(client);
      heartbeat.track(client);
    }

    vi.advanceTimersByTime(1_000);
    expect(answering.pings).toBe(1);
    expect(silent.pings).toBe(1);
    answering.pong();

    vi.advanceTimersByTime(1_000);
    expect(answering.terminated).toBe(false);
    expect(answering.pings).toBe(2);
    expect(silent.terminated).toBe(true);
    heartbeat.stop();
  });

  it("terminates a client whose ping throws, and stops when asked", () => {
    vi.useFakeTimers();
    const clients = new Set<FakeClient>();
    const heartbeat = createRealtimeHeartbeat(clients, 1_000);
    const broken = new FakeClient();
    broken.ping = () => {
      throw new Error("not open");
    };
    clients.add(broken);
    heartbeat.track(broken);
    vi.advanceTimersByTime(1_000);
    expect(broken.terminated).toBe(true);

    const late = new FakeClient();
    clients.add(late);
    heartbeat.track(late);
    heartbeat.stop();
    vi.advanceTimersByTime(5_000);
    expect(late.pings).toBe(0);
  });

  it("uses a bounded message size and a 30 s heartbeat by default", () => {
    expect(REALTIME_MAX_PAYLOAD_BYTES).toBe(64 * 1024);
    expect(REALTIME_HEARTBEAT_MS).toBe(30_000);
  });
});
