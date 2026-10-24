import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TelegramApiError,
  telegramSendMessage,
  telegramSetCommands,
  telegramSetWebhook,
} from "./telegram-bot-api";
import type { TelegramBotConfig } from "./telegram-contract";

const config: TelegramBotConfig = {
  botToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi_123",
  botUsername: "BizaMizOfficialBot",
  webhookSecret: "A".repeat(40),
  webhookUrl: "https://example.com/api/telegram/webhook",
  publicOrigin: "https://example.com",
  rootDomain: "example.com",
};

afterEach(() => vi.unstubAllGlobals());

describe("Telegram Bot API adapter", () => {
  it("registers one central webhook with a secret header, bounded connections and only required updates", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await expect(telegramSetWebhook(config)).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.telegram.org/bot${config.botToken}/setWebhook`);
    expect(JSON.parse(String(init.body))).toEqual({
      url: config.webhookUrl,
      secret_token: config.webhookSecret,
      allowed_updates: ["message", "callback_query"],
      max_connections: 20,
      drop_pending_updates: false,
    });
    expect(init.cache).toBe("no-store");
  });

  it("registers only the first-party start, business and help commands", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await expect(telegramSetCommands(config)).resolves.toBe(true);
    const payload = JSON.parse(String((fetch.mock.calls[0][1] as RequestInit).body));
    expect(payload.commands.map((command: { command: string }) => command.command)).toEqual([
      "start",
      "businesses",
      "help",
    ]);
  });

  it("sends plain-text messages and web-app buttons without a parse mode", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await expect(
      telegramSendMessage(config, "123456789", "Choose your business", [[{
        text: "Biza",
        style: "primary",
        web_app: { url: "https://tenant.example.com/telegram" },
      }]]),
    ).resolves.toEqual({ message_id: 9 });
    const body = JSON.parse(String((fetch.mock.calls[0][1] as RequestInit).body));
    expect(body.parse_mode).toBeUndefined();
    expect(body.reply_markup.inline_keyboard[0][0].web_app.url).toBe("https://tenant.example.com/telegram");
    expect(body.reply_markup.inline_keyboard[0][0].style).toBe("primary");
  });

  it("reduces Telegram and transport failures to safe codes", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, error_code: 429, description: "secret-bearing upstream body" }), { status: 429 }));
    vi.stubGlobal("fetch", fetch);
    await expect(telegramSetCommands(config)).rejects.toMatchObject({
      name: "TelegramApiError",
      code: "telegram_api_429",
    });

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network detail")));
    await expect(telegramSetCommands(config)).rejects.toBeInstanceOf(TelegramApiError);
    await expect(telegramSetCommands(config)).rejects.toMatchObject({ code: "telegram_transport_error" });
  });
});
