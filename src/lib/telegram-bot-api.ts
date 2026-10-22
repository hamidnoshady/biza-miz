import type { TelegramBotConfig } from "./telegram-contract";

const TELEGRAM_API_BASE = "https://api.telegram.org";

export class TelegramApiError extends Error {
  readonly code: string;

  constructor(code: string) {
    // Telegram response descriptions can contain user-controlled text. Never
    // propagate them into logs or database diagnostics.
    super(code);
    this.name = "TelegramApiError";
    this.code = code;
  }
}

async function callTelegramApi<T>(
  config: TelegramBotConfig,
  method: string,
  payload?: Record<string, unknown>,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${TELEGRAM_API_BASE}/bot${config.botToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload ?? {}),
      signal: AbortSignal.timeout(8_000),
      cache: "no-store",
    });
  } catch {
    throw new TelegramApiError("telegram_transport_error");
  }

  type TelegramApiEnvelope = { ok?: boolean; result?: T; error_code?: number } | null;
  let result: TelegramApiEnvelope;
  try {
    result = (await response.json()) as TelegramApiEnvelope;
  } catch {
    throw new TelegramApiError("telegram_invalid_response");
  }
  if (!response.ok || result?.ok !== true) {
    const code = Number.isSafeInteger(result?.error_code) ? result?.error_code : response.status;
    throw new TelegramApiError(`telegram_api_${code}`);
  }
  return result.result as T;
}

export interface TelegramBotIdentity {
  id: number;
  is_bot: boolean;
  username?: string;
}

export interface TelegramInlineKeyboardButton {
  text: string;
  /** Bot API 9.4+ supported native palette; omit for client-default fallback. */
  style?: "primary" | "success" | "danger";
  url?: string;
  web_app?: { url: string };
  callback_data?: string;
}

export async function telegramGetMe(config: TelegramBotConfig): Promise<TelegramBotIdentity> {
  return callTelegramApi<TelegramBotIdentity>(config, "getMe");
}

export async function telegramSetWebhook(config: TelegramBotConfig): Promise<boolean> {
  return callTelegramApi<boolean>(config, "setWebhook", {
    url: config.webhookUrl,
    secret_token: config.webhookSecret,
    allowed_updates: ["message", "callback_query"],
    max_connections: 20,
    drop_pending_updates: false,
  });
}

export async function telegramSetCommands(config: TelegramBotConfig): Promise<boolean> {
  return callTelegramApi<boolean>(config, "setMyCommands", {
    commands: [
      { command: "start", description: "شروع و ورود امن به Biza Miz" },
      { command: "businesses", description: "انتخاب کسب‌وکار" },
      { command: "help", description: "راهنمای ربات" },
    ],
  });
}

export async function telegramAnswerCallbackQuery(
  config: TelegramBotConfig,
  callbackQueryId: string,
  text?: string,
): Promise<boolean> {
  return callTelegramApi<boolean>(config, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text } : {}),
    show_alert: false,
  });
}

export async function telegramSendMessage(
  config: TelegramBotConfig,
  chatId: string,
  text: string,
  inlineKeyboard?: TelegramInlineKeyboardButton[][],
): Promise<{ message_id: number }> {
  return callTelegramApi<{ message_id: number }>(config, "sendMessage", {
    chat_id: chatId,
    text,
    ...(inlineKeyboard ? { reply_markup: { inline_keyboard: inlineKeyboard } } : {}),
    disable_web_page_preview: true,
  });
}
