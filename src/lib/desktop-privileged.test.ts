import { afterEach, describe, expect, it, vi } from "vitest";
import { desktopPrivilegedConfigured, tryDesktopPrivilegedOperation } from "./desktop-privileged";

afterEach(() => vi.unstubAllGlobals());

describe("Desktop privileged client", () => {
  it("falls back only when neither bridge coordinate exists", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(desktopPrivilegedConfigured({})).toBe(false);
    await expect(tryDesktopPrivilegedOperation("dump", { outFile: "/tmp/a" }, {})).resolves.toEqual({ handled: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(desktopPrivilegedConfigured({ DESKTOP_PRIVILEGED_URL: "http://127.0.0.1:1" })).toBe(true);
    await expect(tryDesktopPrivilegedOperation("dump", { outFile: "/tmp/a" }, { DESKTOP_PRIVILEGED_URL: "http://127.0.0.1:1" }))
      .rejects.toThrow("desktop_privileged_channel_misconfigured");
  });

  it("authenticates a fixed operation without accepting a database credential", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, result: { migrations: 4 } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const env = { DESKTOP_PRIVILEGED_URL: "http://127.0.0.1:4567/", DESKTOP_PRIVILEGED_TOKEN: "boot-token" };
    await expect(tryDesktopPrivilegedOperation("restore", { dumpPath: "/backup/a.dump", apply: false }, env))
      .resolves.toEqual({ handled: true, result: { migrations: 4 } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:4567/operations");
    expect(init.headers.Authorization).toBe("Bearer boot-token");
    expect(JSON.parse(init.body)).toEqual({ operation: "restore", dumpPath: "/backup/a.dump", apply: false });
    expect(init.body).not.toContain("DATABASE_URL");
  });

  it("surfaces broker errors and malformed success responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, error: "restore_failed" }), { status: 500 })));
    const env = { DESKTOP_PRIVILEGED_URL: "http://127.0.0.1:4567", DESKTOP_PRIVILEGED_TOKEN: "boot-token" };
    await expect(tryDesktopPrivilegedOperation("dump", { outFile: "/tmp/a" }, env)).rejects.toThrow("restore_failed");
  });
});
