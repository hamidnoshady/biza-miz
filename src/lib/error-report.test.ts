import { describe, expect, it, vi } from "vitest";
import {
  buildTechnicalReport,
  exportClientErrorLog,
  generateErrorId,
  isNotableApiFailure,
  recordApiFailure,
  recordClientError,
  redactSecrets,
} from "./error-report";

describe("generateErrorId", () => {
  it("has the ERR-XXXX-XXXX shape in the confusion-free base32 alphabet", () => {
    const id = generateErrorId("boom", 1700000000000);
    expect(id).toMatch(/^ERR-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  });

  it("is deterministic for the same seed and timestamp", () => {
    expect(generateErrorId("boom", 42)).toBe(generateErrorId("boom", 42));
  });

  it("differs for a different seed or timestamp", () => {
    expect(generateErrorId("boom", 42)).not.toBe(generateErrorId("bang", 42));
    expect(generateErrorId("boom", 42)).not.toBe(generateErrorId("boom", 43));
  });
});

describe("redactSecrets", () => {
  it("redacts a Postgres connection string's password", () => {
    expect(redactSecrets("failed: postgres://app:hunter2@db:5432/pos")).toBe(
      "failed: postgres://app:[REDACTED]@db:5432/pos",
    );
  });

  it("redacts a bearer token", () => {
    expect(redactSecrets("Authorization: Bearer abc.def.ghi")).toBe("Authorization: Bearer [REDACTED]");
  });

  it("redacts a labelled secret/token/password/passphrase", () => {
    expect(redactSecrets("jwt_secret=super-secret-value end")).toBe("jwt_secret=[REDACTED] end");
    expect(redactSecrets("password: hunter2, more")).toBe("password: [REDACTED], more");
  });

  it("leaves ordinary text untouched", () => {
    expect(redactSecrets("order 42 failed to save")).toBe("order 42 failed to save");
  });
});

describe("buildTechnicalReport", () => {
  it("includes the error id, message and stack, omitting absent optional fields", () => {
    const report = buildTechnicalReport({
      errorId: "ERR-AAAA-BBBB",
      message: "boom",
      stack: "at foo (bar.ts:1:1)",
      occurredAt: "2026-01-01T00:00:00.000Z",
    });
    expect(report).toContain("Error ID: ERR-AAAA-BBBB");
    expect(report).toContain("Occurred at: 2026-01-01T00:00:00.000Z");
    expect(report).toContain("Message: boom");
    expect(report).toContain("Stack:");
    expect(report).toContain("at foo (bar.ts:1:1)");
    expect(report).not.toContain("Server digest");
    expect(report).not.toContain("App version");
  });

  it("redacts secrets in both message and stack", () => {
    const report = buildTechnicalReport({
      errorId: "ERR-AAAA-BBBB",
      message: "connect failed: postgres://app:hunter2@db/pos",
      stack: "password=hunter2\nat connect",
    });
    expect(report).not.toContain("hunter2");
  });

  it("includes digest/appVersion/url/userAgent when present", () => {
    const report = buildTechnicalReport({
      errorId: "ERR-AAAA-BBBB",
      message: "boom",
      digest: "abc123",
      appVersion: "1.0.5",
      url: "https://pos.example.com/dashboard",
      userAgent: "TestAgent/1.0",
    });
    expect(report).toContain("Server digest: abc123");
    expect(report).toContain("App version: 1.0.5");
    expect(report).toContain("URL: https://pos.example.com/dashboard");
    expect(report).toContain("User agent: TestAgent/1.0");
  });
});

function fakeStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size;
    },
  } as Storage;
}

describe("recordClientError / exportClientErrorLog", () => {
  it("round-trips a single entry", () => {
    const storage = fakeStorage();
    recordClientError({ errorId: "ERR-0001-AAAA", occurredAt: "2026-01-01T00:00:00.000Z", report: "report one" }, storage);
    expect(exportClientErrorLog(storage)).toBe("report one");
  });

  it("joins multiple entries with a separator, oldest first", () => {
    const storage = fakeStorage();
    recordClientError({ errorId: "ERR-0001-AAAA", occurredAt: "t1", report: "first" }, storage);
    recordClientError({ errorId: "ERR-0002-BBBB", occurredAt: "t2", report: "second" }, storage);
    const exported = exportClientErrorLog(storage);
    expect(exported.indexOf("first")).toBeLessThan(exported.indexOf("second"));
    expect(exported).toContain("====");
  });

  it("caps the ring buffer instead of growing unbounded", () => {
    const storage = fakeStorage();
    for (let i = 0; i < 60; i += 1) {
      recordClientError({ errorId: `ERR-${i}`, occurredAt: String(i), report: `report ${i}` }, storage);
    }
    const exported = exportClientErrorLog(storage);
    expect(exported).not.toContain("report 0\n");
    expect(exported).toContain("report 59");
    // 50-cap: entries 10..59 survive.
    expect(exported).not.toContain("report 9\n");
    expect(exported).toContain("report 10");
  });

  it("returns an empty string and never throws when storage is unavailable", () => {
    expect(exportClientErrorLog(undefined)).toBe("");
    expect(() => recordClientError({ errorId: "x", occurredAt: "t", report: "r" }, undefined)).not.toThrow();
  });

  it("tolerates a storage whose setItem throws (quota exceeded)", () => {
    const storage = fakeStorage();
    const spy = vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() =>
      recordClientError({ errorId: "x", occurredAt: "t", report: "r" }, storage),
    ).not.toThrow();
    spy.mockRestore();
  });

  it("tolerates corrupted JSON already in storage", () => {
    const storage = fakeStorage();
    storage.setItem("pos:clientErrorLog", "{not json");
    expect(exportClientErrorLog(storage)).toBe("");
    expect(() =>
      recordClientError({ errorId: "x", occurredAt: "t", report: "r" }, storage),
    ).not.toThrow();
  });
});

describe("isNotableApiFailure", () => {
  it("flags a transport failure (status 0)", () => {
    expect(isNotableApiFailure(0)).toBe(true);
  });

  it("flags a server error (5xx)", () => {
    expect(isNotableApiFailure(500)).toBe(true);
    expect(isNotableApiFailure(503)).toBe(true);
  });

  it("does not flag an ordinary client rejection (4xx)", () => {
    expect(isNotableApiFailure(400)).toBe(false);
    expect(isNotableApiFailure(401)).toBe(false);
    expect(isNotableApiFailure(404)).toBe(false);
    expect(isNotableApiFailure(422)).toBe(false);
  });

  it("does not flag success", () => {
    expect(isNotableApiFailure(200)).toBe(false);
    expect(isNotableApiFailure(204)).toBe(false);
  });
});

describe("recordApiFailure", () => {
  it("logs a 5xx failure and returns an error id", () => {
    const storage = fakeStorage();
    const id = recordApiFailure({ method: "POST", url: "/api/orders", status: 500, code: "server_error" }, storage);
    expect(id).toMatch(/^ERR-/);
    const exported = exportClientErrorLog(storage);
    expect(exported).toContain("POST /api/orders");
    expect(exported).toContain("HTTP 500");
    expect(exported).toContain("server_error");
  });

  it("logs a transport failure (status 0) as 'no response'", () => {
    const storage = fakeStorage();
    recordApiFailure({ method: "GET", url: "/api/menu", status: 0, code: "network_error" }, storage);
    expect(exportClientErrorLog(storage)).toContain("(no response)");
  });

  it("does not log an ordinary 4xx validation rejection", () => {
    const storage = fakeStorage();
    const id = recordApiFailure({ method: "POST", url: "/api/orders", status: 400, code: "missing_fields" }, storage);
    expect(id).toBeNull();
    expect(exportClientErrorLog(storage)).toBe("");
  });

  it("does not log an ordinary 2xx by default, even with a code attached", () => {
    const storage = fakeStorage();
    const id = recordApiFailure({ method: "GET", url: "/api/menu", status: 200, code: "malformed_response" }, storage);
    expect(id).toBeNull();
    expect(exportClientErrorLog(storage)).toBe("");
  });

  it("logs a 2xx when the caller forces it (issue #909 — a masked malformed-200 response)", () => {
    const storage = fakeStorage();
    const id = recordApiFailure(
      { method: "GET", url: "/api/menu", status: 200, code: "malformed_response", force: true },
      storage,
    );
    expect(id).toMatch(/^ERR-/);
    const exported = exportClientErrorLog(storage);
    expect(exported).toContain("GET /api/menu");
    expect(exported).toContain("HTTP 200");
    expect(exported).toContain("malformed_response");
  });

  it("still honours force:false/absent for an ordinary 4xx (no change in existing behaviour)", () => {
    const storage = fakeStorage();
    const id = recordApiFailure({ method: "POST", url: "/api/orders", status: 400, code: "missing_fields", force: false }, storage);
    expect(id).toBeNull();
  });

  it("redacts a secret that leaked into the server-reported code", () => {
    const storage = fakeStorage();
    recordApiFailure(
      { method: "POST", url: "/api/setup/pair", status: 500, code: "jwt_secret=super-secret-value" },
      storage,
    );
    const exported = exportClientErrorLog(storage);
    expect(exported).toContain("[REDACTED]");
    expect(exported).not.toContain("super-secret-value");
  });
});
