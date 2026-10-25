import { createHmac, timingSafeEqual } from "node:crypto";
import type { TelegramBotConfig } from "./telegram-contract";
import { isSafeTelegramId } from "./telegram-contract";
import {
  telegramAnswerCallbackQuery,
  telegramSendMessage,
  type TelegramInlineKeyboardButton,
} from "./telegram-bot-api";
import {
  activeTelegramAccountForTelegramUser,
  listTelegramBusinessLaunches,
  redeemTelegramLinkChallenge,
} from "./telegram-service";

const BUSINESS_PAGE_SIZE = 48;
const MAX_BUTTON_TEXT = 64;

interface TelegramChat {
  id: number;
  type: string;
}

interface TelegramUser {
  id: number;
  language_code?: string;
}

interface TelegramMessage {
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
}

interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  data?: string;
  message?: { chat: TelegramChat };
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keep only the supported, bounded fields from Telegram's update envelope. */
export function parseTelegramUpdate(value: unknown): TelegramUpdate | null {
  if (!isPlainObject(value) || !isSafeTelegramId(value.update_id)) return null;
  const update: TelegramUpdate = { update_id: value.update_id };

  if (isPlainObject(value.message)) {
    const message = value.message;
    const chat = isPlainObject(message.chat) ? message.chat : null;
    const from = isPlainObject(message.from) ? message.from : null;
    const text = message.text;
    if (
      chat && isSafeTelegramId(chat.id) && typeof chat.type === "string" && chat.type.length <= 32 &&
      (from === null || isSafeTelegramId(from.id)) &&
      (text === undefined || (typeof text === "string" && text.length <= 4096))
    ) {
      update.message = {
        chat: { id: chat.id, type: chat.type },
        ...(from ? {
          from: {
            id: from.id as number,
            ...(typeof from.language_code === "string" ? { language_code: from.language_code.slice(0, 16) } : {}),
          },
        } : {}),
        ...(typeof text === "string" ? { text } : {}),
      };
    }
  }

  if (isPlainObject(value.callback_query)) {
    const callback = value.callback_query;
    const from = isPlainObject(callback.from) ? callback.from : null;
    const message = isPlainObject(callback.message) ? callback.message : null;
    const chat = message && isPlainObject(message.chat) ? message.chat : null;
    if (
      typeof callback.id === "string" && callback.id.length > 0 && callback.id.length <= 128 &&
      from && isSafeTelegramId(from.id) &&
      typeof callback.data === "string" && callback.data.length <= 64 &&
      chat && isSafeTelegramId(chat.id) && typeof chat.type === "string"
    ) {
      update.callback_query = {
        id: callback.id,
        from: {
          id: from.id,
          ...(typeof from.language_code === "string" ? { language_code: from.language_code.slice(0, 16) } : {}),
        },
        data: callback.data,
        message: { chat: { id: chat.id, type: chat.type } },
      };
    }
  }

  return update;
}

function isEnglish(languageCode: string | undefined): boolean {
  return languageCode?.toLowerCase().startsWith("en") === true;
}

function commandFrom(text: string, botUsername: string): { command: string; argument?: string } | null {
  const match = /^\/(start|businesses|help)(?:@([A-Za-z0-9_]+))?(?:\s+([^\s]+))?$/i.exec(text.trim());
  if (!match) return null;
  if (match[2] && match[2].toLowerCase() !== botUsername.toLowerCase()) return null;
  return { command: match[1].toLowerCase(), argument: match[3] };
}

function callbackMac(config: TelegramBotConfig, telegramUserId: number, page: number): string {
  return createHmac("sha256", config.botToken)
    .update(`businesses:${telegramUserId}:${page}`)
    .digest("base64url")
    .slice(0, 16);
}

function businessPageCallback(config: TelegramBotConfig, telegramUserId: number, page: number): string {
  return `biz:${page}:${callbackMac(config, telegramUserId, page)}`;
}

function validBusinessPageCallback(
  config: TelegramBotConfig,
  telegramUserId: number,
  value: string,
): number | null {
  const match = /^biz:(\d{1,6}):([A-Za-z0-9_-]{16})$/.exec(value);
  if (!match) return null;
  const page = Number(match[1]);
  const expected = Buffer.from(callbackMac(config, telegramUserId, page));
  const actual = Buffer.from(match[2]);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  return page;
}

function boundedButtonText(name: string): string {
  const trimmed = name.trim();
  return trimmed.length <= MAX_BUTTON_TEXT ? trimmed : `${trimmed.slice(0, MAX_BUTTON_TEXT - 1)}…`;
}

async function sendBusinessPage(
  config: TelegramBotConfig,
  telegramUserId: number,
  platformUserId: string,
  requestedPage: number,
  english: boolean,
): Promise<void> {
  const { businesses } = await listTelegramBusinessLaunches(platformUserId);
  if (businesses.length === 0) {
    const text = english
      ? "No active Cloud business is available for this linked account. Contact your Bizamiz administrator if you think this is a mistake."
      : "برای این حساب، کسب‌وکار ابریِ فعال و دارای دسترسی تلگرام پیدا نشد. اگر این درست نیست با مدیر بیزامیز تماس بگیرید.";
    await telegramSendMessage(config, String(telegramUserId), text);
    return;
  }

  const pageCount = Math.ceil(businesses.length / BUSINESS_PAGE_SIZE);
  const page = Math.min(Math.max(requestedPage, 0), pageCount - 1);
  const selected = businesses.slice(page * BUSINESS_PAGE_SIZE, (page + 1) * BUSINESS_PAGE_SIZE);
  const keyboard: TelegramInlineKeyboardButton[][] = selected.map((business) => [{
    text: boundedButtonText(business.name),
    style: "primary",
    web_app: { url: business.url },
  }]);
  const navigation: TelegramInlineKeyboardButton[] = [];
  if (page > 0) {
    navigation.push({
      text: english ? "Previous" : "پیشین",
      style: "primary",
      callback_data: businessPageCallback(config, telegramUserId, page - 1),
    });
  }
  if (page + 1 < pageCount) {
    navigation.push({
      text: english ? "Next" : "بعدی",
      style: "primary",
      callback_data: businessPageCallback(config, telegramUserId, page + 1),
    });
  }
  if (navigation.length > 0) keyboard.push(navigation);

  const pageLabel = pageCount > 1 ? ` (${page + 1}/${pageCount})` : "";
  const text = english
    ? `Choose a Cloud business to open the official Bizamiz Mini App${pageLabel}. Access is checked again on that business's own secure origin.`
    : `برای بازکردن مینی‌اپ رسمی بیزامیز، کسب‌وکار ابری را انتخاب کنید${pageLabel}. دسترسی دوباره روی دامنهٔ امن همان کسب‌وکار بررسی می‌شود.`;
  await telegramSendMessage(config, String(telegramUserId), text, keyboard);
}

async function sendConnectInstructions(
  config: TelegramBotConfig,
  telegramUserId: number,
  english: boolean,
): Promise<void> {
  const text = english
    ? "Link Telegram to your existing Bizamiz account from a browser: sign in, open Settings → Connections → Telegram, and choose Connect. This bot never creates a second account."
    : "برای پیوند تلگرام، در مرورگر با حساب فعلی بیزامیز وارد شوید و از «تنظیمات ← اتصال‌های فنی ← تلگرام» گزینهٔ پیوند را بزنید. این ربات حساب جداگانه نمی‌سازد.";
  await telegramSendMessage(config, String(telegramUserId), text, [[{
    text: english ? "Open Bizamiz" : "بازکردن بیزامیز",
    style: "primary",
    url: config.publicOrigin,
  }]]);
}

async function handleMessage(config: TelegramBotConfig, message: TelegramMessage): Promise<void> {
  if (message.chat.type !== "private" || !message.from || message.chat.id !== message.from.id) return;
  const command = message.text ? commandFrom(message.text, config.botUsername) : null;
  if (!command) return;
  const telegramUserId = String(message.from.id);
  const english = isEnglish(message.from.language_code);

  if (command.command === "help") {
    const help = english
      ? "Use /start to link your existing Bizamiz identity or open your available Cloud workspaces. Use /businesses to choose a workspace again."
      : "برای پیوند هویت فعلی یا بازکردن فضای کاری ابری از /start و برای انتخاب دوبارهٔ کسب‌وکار از /businesses استفاده کنید.";
    await telegramSendMessage(config, telegramUserId, help);
    return;
  }

  if (command.command === "start" && command.argument) {
    const result = await redeemTelegramLinkChallenge(command.argument, telegramUserId);
    if (!result.ok) {
      const text = english
        ? "This link is invalid, expired, or already belongs to another account. Create a fresh link from your signed-in Bizamiz browser."
        : "این پیوند نامعتبر یا منقضی شده است، یا به حساب دیگری تعلق دارد. از مرورگر واردشدهٔ بیزامیز پیوند تازه بسازید.";
      await telegramSendMessage(config, telegramUserId, text);
      return;
    }
    const text = english
      ? (result.alreadyLinked ? "This Telegram account is already linked." : "Telegram is now linked to your existing Bizamiz identity.")
      : (result.alreadyLinked ? "این حساب تلگرام از قبل پیوند دارد." : "حساب تلگرام به هویت فعلی بیزامیز پیوند خورد.");
    await telegramSendMessage(config, telegramUserId, text);
    await sendBusinessPage(config, message.from.id, result.platformUserId, 0, english);
    return;
  }

  const account = await activeTelegramAccountForTelegramUser(telegramUserId);
  if (!account) {
    await sendConnectInstructions(config, message.from.id, english);
    return;
  }
  await sendBusinessPage(config, message.from.id, account.platformUserId, 0, english);
}

async function handleCallback(config: TelegramBotConfig, callback: TelegramCallbackQuery): Promise<void> {
  const chat = callback.message?.chat;
  if (!chat || chat.type !== "private" || chat.id !== callback.from.id || !callback.data) return;
  const english = isEnglish(callback.from.language_code);
  const page = validBusinessPageCallback(config, callback.from.id, callback.data);
  if (page === null) {
    await telegramAnswerCallbackQuery(
      config,
      callback.id,
      english ? "This menu is no longer valid. Send /businesses." : "این فهرست معتبر نیست؛ /businesses را بفرستید.",
    );
    return;
  }

  const account = await activeTelegramAccountForTelegramUser(String(callback.from.id));
  if (!account) {
    await telegramAnswerCallbackQuery(
      config,
      callback.id,
      english ? "Link your account again from Bizamiz." : "از بیزامیز حساب خود را دوباره پیوند دهید.",
    );
    return;
  }
  await telegramAnswerCallbackQuery(config, callback.id);
  await sendBusinessPage(config, callback.from.id, account.platformUserId, page, english);
}

/** Process only private-DM commands; groups/channels never become tenant scope. */
export async function processTelegramUpdate(
  config: TelegramBotConfig,
  update: TelegramUpdate,
): Promise<void> {
  if (update.message) {
    await handleMessage(config, update.message);
    return;
  }
  if (update.callback_query) await handleCallback(config, update.callback_query);
}
