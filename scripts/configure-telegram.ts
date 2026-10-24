import "dotenv/config";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deploymentRole } from "../src/lib/deployment-role";
import { hostRoutingEnabled } from "../src/lib/host";
import {
  TelegramApiError,
  telegramGetMe,
  telegramSetCommands,
  telegramSetWebhook,
} from "../src/lib/telegram-bot-api";
import { telegramConfig } from "../src/lib/telegram-contract";

export async function configureTelegramBot(): Promise<{ botUsername: string; webhookUrl: string }> {
  if (deploymentRole() !== "central" || !hostRoutingEnabled()) {
    throw new Error("deployment_unsupported");
  }
  const configured = telegramConfig();
  if (!configured.enabled) throw new Error(configured.reason);

  const bot = await telegramGetMe(configured.config);
  if (!bot.is_bot || bot.username?.toLowerCase() !== configured.config.botUsername.toLowerCase()) {
    throw new Error("telegram_bot_identity_mismatch");
  }
  if (!(await telegramSetWebhook(configured.config))) throw new Error("telegram_webhook_registration_failed");
  if (!(await telegramSetCommands(configured.config))) throw new Error("telegram_command_registration_failed");

  return { botUsername: configured.config.botUsername, webhookUrl: configured.config.webhookUrl };
}

export async function main(): Promise<void> {
  try {
    const result = await configureTelegramBot();
    console.info(`Telegram bot @${result.botUsername} is verified and its webhook is registered at ${result.webhookUrl}.`);
    console.info("The bot token and webhook secret were not printed.");
  } catch (error) {
    const code = error instanceof TelegramApiError
      ? error.code
      : error instanceof Error && /^[a-z0-9_]{1,64}$/.test(error.message)
        ? error.message
        : "telegram_configuration_failed";
    console.error(`Telegram configuration failed (${code}). No token or secret was printed.`);
    process.exitCode = 1;
  }
}

const entryPoint = process.argv[1] ? resolve(process.argv[1]) : null;
if (entryPoint === fileURLToPath(import.meta.url)) void main();
