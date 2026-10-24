import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TelegramBotConfig } from "./telegram-contract";

const mocks = vi.hoisted(() => ({
  answerCallback: vi.fn(),
  sendMessage: vi.fn(),
  activeAccount: vi.fn(),
  listBusinesses: vi.fn(),
  redeemChallenge: vi.fn(),
}));

vi.mock("./telegram-bot-api", () => ({
  telegramAnswerCallbackQuery: mocks.answerCallback,
  telegramSendMessage: mocks.sendMessage,
}));
vi.mock("./telegram-service", () => ({
  activeTelegramAccountForTelegramUser: mocks.activeAccount,
  listTelegramBusinessLaunches: mocks.listBusinesses,
  redeemTelegramLinkChallenge: mocks.redeemChallenge,
}));

import { parseTelegramUpdate, processTelegramUpdate } from "./telegram-webhook";

const config: TelegramBotConfig = {
  botToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi_123",
  botUsername: "BizaMizOfficialBot",
  webhookSecret: "A".repeat(40),
  webhookUrl: "https://example.com/api/telegram/webhook",
  publicOrigin: "https://example.com",
  rootDomain: "example.com",
};

beforeEach(() => {
  mocks.answerCallback.mockReset().mockResolvedValue(true);
  mocks.sendMessage.mockReset().mockResolvedValue({ message_id: 1 });
  mocks.activeAccount.mockReset().mockResolvedValue(null);
  mocks.listBusinesses.mockReset().mockResolvedValue({ businesses: [], publicOrigin: config.publicOrigin });
  mocks.redeemChallenge.mockReset();
});

describe("parseTelegramUpdate", () => {
  it("keeps only bounded update fields needed by private DMs and button callbacks", () => {
    expect(parseTelegramUpdate({
      update_id: 5,
      message: {
        message_id: 100,
        date: 123,
        chat: { id: 123, type: "private", title: "ignored" },
        from: { id: 123, language_code: "fa", username: "ignored" },
        text: "/start AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      },
      extra: "ignored",
    })).toEqual({
      update_id: 5,
      message: {
        chat: { id: 123, type: "private" },
        from: { id: 123, language_code: "fa" },
        text: "/start AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      },
    });
  });

  it("rejects unsafe update ids and does not treat group chat ids as private identities", () => {
    expect(parseTelegramUpdate({ update_id: -1 })).toBeNull();
    expect(parseTelegramUpdate({ update_id: Number.MAX_SAFE_INTEGER + 1 })).toBeNull();
    const update = parseTelegramUpdate({
      update_id: 9,
      message: { chat: { id: -100123, type: "supergroup" }, from: { id: 123 }, text: "/start" },
    });
    expect(update).toEqual({ update_id: 9 });
  });
});

describe("private Telegram bot commands", () => {
  it("does not respond to or read any data from a group", async () => {
    await processTelegramUpdate(config, {
      update_id: 1,
      message: {
        chat: { id: 123, type: "group" },
        from: { id: 456 },
        text: "/businesses",
      },
    });
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(mocks.activeAccount).not.toHaveBeenCalled();
  });

  it("explains browser account linking without creating an account", async () => {
    await processTelegramUpdate(config, {
      update_id: 2,
      message: { chat: { id: 123, type: "private" }, from: { id: 123, language_code: "en" }, text: "/start" },
    });
    expect(mocks.activeAccount).toHaveBeenCalledWith("123");
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      config,
      "123",
      expect.stringContaining("existing Biza Miz account"),
      [[{ text: "Open Biza Miz", style: "primary", url: "https://example.com" }]],
    );
  });

  it("redeems the browser challenge and offers only eligible tenant-hosted Mini Apps", async () => {
    mocks.redeemChallenge.mockResolvedValue({ ok: true, linkId: "link-1", platformUserId: "platform-1", alreadyLinked: false });
    mocks.listBusinesses.mockResolvedValue({
      businesses: [{ name: "Biza Store", url: "https://store.example.com/telegram" }],
      publicOrigin: config.publicOrigin,
    });
    await processTelegramUpdate(config, {
      update_id: 3,
      message: {
        chat: { id: 123, type: "private" },
        from: { id: 123, language_code: "fa" },
        text: `/start ${"A".repeat(43)}`,
      },
    });
    expect(mocks.redeemChallenge).toHaveBeenCalledWith("A".repeat(43), "123");
    expect(mocks.sendMessage).toHaveBeenNthCalledWith(1, config, "123", expect.stringContaining("پیوند خورد"));
    expect(mocks.sendMessage).toHaveBeenNthCalledWith(2, config, "123", expect.stringContaining("کسب‌وکار ابری"), [[{
      text: "Biza Store",
      style: "primary",
      web_app: { url: "https://store.example.com/telegram" },
    }]]);
  });

  it("paginates large workspaces with a user-bound opaque callback", async () => {
    mocks.activeAccount.mockResolvedValue({ platformUserId: "platform-1" });
    mocks.listBusinesses.mockResolvedValue({
      businesses: Array.from({ length: 49 }, (_, index) => ({
        name: `Business ${index + 1}`,
        url: `https://biz-${index + 1}.example.com/telegram`,
      })),
      publicOrigin: config.publicOrigin,
    });
    await processTelegramUpdate(config, {
      update_id: 4,
      message: { chat: { id: 123, type: "private" }, from: { id: 123 }, text: "/businesses" },
    });
    const keyboard = mocks.sendMessage.mock.calls[0][3] as { text: string; callback_data?: string }[][];
    const next = keyboard.at(-1)?.[0]?.callback_data;
    expect(next).toMatch(/^biz:1:[A-Za-z0-9_-]{16}$/);

    await processTelegramUpdate(config, {
      update_id: 5,
      callback_query: {
        id: "callback-1",
        from: { id: 123 },
        data: next,
        message: { chat: { id: 123, type: "private" } },
      },
    });
    expect(mocks.answerCallback).toHaveBeenCalledWith(config, "callback-1");
    expect(mocks.sendMessage.mock.calls.at(-1)?.[3]).toEqual([
      [{ text: "Business 49", style: "primary", web_app: { url: "https://biz-49.example.com/telegram" } }],
      [{ text: "پیشین", style: "primary", callback_data: expect.stringMatching(/^biz:0:[A-Za-z0-9_-]{16}$/) }],
    ]);
  });

  it("refuses a forged business-page callback before enumerating memberships", async () => {
    await processTelegramUpdate(config, {
      update_id: 6,
      callback_query: {
        id: "callback-forged",
        from: { id: 123 },
        data: "biz:1:AAAAAAAAAAAAAAAA",
        message: { chat: { id: 123, type: "private" } },
      },
    });
    expect(mocks.answerCallback).toHaveBeenCalledWith(config, "callback-forged", expect.stringContaining("/businesses"));
    expect(mocks.activeAccount).not.toHaveBeenCalled();
    expect(mocks.listBusinesses).not.toHaveBeenCalled();
  });
});
