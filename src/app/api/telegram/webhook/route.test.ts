import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  deploymentRole: vi.fn(),
  config: vi.fn(),
  secretMatches: vi.fn(),
  reserve: vi.fn(),
  finish: vi.fn(),
  parse: vi.fn(),
  process: vi.fn(),
  log: vi.fn(),
}));

vi.mock("@/lib/deployment-role", () => ({ deploymentRole: mocks.deploymentRole }));
vi.mock("@/lib/telegram-contract", () => ({
  TELEGRAM_MAX_WEBHOOK_BYTES: 64 * 1024,
  constantTimeSecretEquals: mocks.secretMatches,
  telegramConfig: mocks.config,
}));
vi.mock("@/lib/telegram-service", () => ({
  finishTelegramWebhookUpdate: mocks.finish,
  reserveTelegramWebhookUpdate: mocks.reserve,
}));
vi.mock("@/lib/telegram-webhook", () => ({
  parseTelegramUpdate: mocks.parse,
  processTelegramUpdate: mocks.process,
}));
vi.mock("@/lib/telegram-bot-api", () => ({
  TelegramApiError: class TelegramApiError extends Error {
    constructor(readonly code: string) { super(code); this.name = "TelegramApiError"; }
  },
}));

import { TelegramApiError } from "@/lib/telegram-bot-api";
import { POST } from "./route";

const update = { update_id: 91 };
const config = {
  botToken: "token",
  botUsername: "BizaMizOfficialBot",
  webhookSecret: "A".repeat(40),
  webhookUrl: "https://example.com/api/telegram/webhook",
  publicOrigin: "https://example.com",
  rootDomain: "example.com",
};

function request(body = JSON.stringify(update), secret = "A".repeat(40)) {
  return new NextRequest("https://example.com/api/telegram/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": secret,
    },
    body,
  });
}

afterEach(() => vi.restoreAllMocks());

beforeEach(() => {
  mocks.deploymentRole.mockReset().mockReturnValue("central");
  mocks.config.mockReset().mockReturnValue({ enabled: true, config });
  mocks.secretMatches.mockReset().mockImplementation((actual: string, expected: string) => actual === expected);
  mocks.reserve.mockReset().mockResolvedValue({ status: "reserved", attemptCount: 1 });
  mocks.finish.mockReset().mockResolvedValue(undefined);
  mocks.parse.mockReset().mockReturnValue(update);
  mocks.process.mockReset().mockResolvedValue(undefined);
  mocks.log.mockReset();
  vi.spyOn(console, "error").mockImplementation(mocks.log);
});

describe("POST /api/telegram/webhook", () => {
  it("refuses a non-central runtime before reading Telegram credentials", async () => {
    mocks.deploymentRole.mockReturnValue("site");
    const response = await POST(request());
    expect(response.status).toBe(404);
    expect(mocks.config).not.toHaveBeenCalled();
  });

  it("authenticates the Telegram secret header before parsing or reserving an update", async () => {
    const response = await POST(request(JSON.stringify(update), "wrong-secret"));
    expect(response.status).toBe(401);
    expect(mocks.parse).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it("deduplicates a previously processed update id durably", async () => {
    mocks.reserve.mockResolvedValue({ status: "processed" });
    const response = await POST(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, duplicate: true });
    expect(mocks.reserve).toHaveBeenCalledWith(91);
    expect(mocks.process).not.toHaveBeenCalled();
  });

  it("returns a retryable response for an update that another worker is processing", async () => {
    mocks.reserve.mockResolvedValue({ status: "in_progress" });
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    await expect(response.json()).resolves.toEqual({ error: "telegram_update_in_progress" });
    expect(mocks.process).not.toHaveBeenCalled();
  });

  it("marks a successful private update processed", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mocks.process).toHaveBeenCalledWith(config, update);
    expect(mocks.finish).toHaveBeenCalledWith(91, 1, { ok: true });
  });

  it("marks failures with a safe Telegram code and returns a retryable response", async () => {
    mocks.process.mockRejectedValue(new TelegramApiError("telegram_api_429"));
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    await expect(response.json()).resolves.toEqual({ error: "telegram_temporarily_unavailable" });
    expect(mocks.finish).toHaveBeenCalledWith(91, 1, { ok: false, errorCode: "telegram_api_429" });
    expect(mocks.log).toHaveBeenCalledWith("Telegram webhook processing failed", "telegram_api_429");
  });

  it("bounds the request body before parsing or writing the inbox", async () => {
    const oversized = JSON.stringify({ update_id: 91, pad: "x".repeat(64 * 1024) });
    const response = await POST(request(oversized));
    expect(response.status).toBe(413);
    expect(mocks.parse).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled();
  });
});
