import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deploymentRole: vi.fn(),
  hostRoutingEnabled: vi.fn(),
  config: vi.fn(),
  getMe: vi.fn(),
  setWebhook: vi.fn(),
  setCommands: vi.fn(),
}));

vi.mock("./deployment-role", () => ({ deploymentRole: mocks.deploymentRole }));
vi.mock("./host", () => ({ hostRoutingEnabled: mocks.hostRoutingEnabled }));
vi.mock("./telegram-contract", () => ({ telegramConfig: mocks.config }));
vi.mock("./telegram-bot-api", () => ({
  TelegramApiError: class TelegramApiError extends Error {
    constructor(readonly code: string) { super(code); this.name = "TelegramApiError"; }
  },
  telegramGetMe: mocks.getMe,
  telegramSetWebhook: mocks.setWebhook,
  telegramSetCommands: mocks.setCommands,
}));

import { configureTelegramBot } from "../../scripts/configure-telegram";

const config = {
  botToken: "never-print-this-token",
  botUsername: "BizaMizOfficialBot",
  webhookSecret: "never-print-this-secret",
  webhookUrl: "https://example.com/api/telegram/webhook",
  publicOrigin: "https://example.com",
  rootDomain: "example.com",
};

beforeEach(() => {
  mocks.deploymentRole.mockReset().mockReturnValue("central");
  mocks.hostRoutingEnabled.mockReset().mockReturnValue(true);
  mocks.config.mockReset().mockReturnValue({ enabled: true, config });
  mocks.getMe.mockReset().mockResolvedValue({ id: 123, is_bot: true, username: "BizaMizOfficialBot" });
  mocks.setWebhook.mockReset().mockResolvedValue(true);
  mocks.setCommands.mockReset().mockResolvedValue(true);
});

describe("configureTelegramBot", () => {
  it("only registers the centrally-owned bot that exactly matches the configured username", async () => {
    await expect(configureTelegramBot()).resolves.toEqual({
      botUsername: "BizaMizOfficialBot",
      webhookUrl: config.webhookUrl,
    });
    expect(mocks.getMe).toHaveBeenCalledWith(config);
    expect(mocks.setWebhook).toHaveBeenCalledWith(config);
    expect(mocks.setCommands).toHaveBeenCalledWith(config);
  });

  it("refuses site/local runtimes before contacting Telegram", async () => {
    mocks.deploymentRole.mockReturnValue("site");
    await expect(configureTelegramBot()).rejects.toThrow("deployment_unsupported");
    expect(mocks.getMe).not.toHaveBeenCalled();
  });

  it("refuses an unexpected BotFather identity and does not install its webhook", async () => {
    mocks.getMe.mockResolvedValue({ id: 123, is_bot: true, username: "DifferentBot" });
    await expect(configureTelegramBot()).rejects.toThrow("telegram_bot_identity_mismatch");
    expect(mocks.setWebhook).not.toHaveBeenCalled();
    expect(mocks.setCommands).not.toHaveBeenCalled();
  });
});
