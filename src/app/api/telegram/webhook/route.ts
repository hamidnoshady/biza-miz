import { NextRequest, NextResponse } from "next/server";
import { deploymentRole } from "@/lib/deployment-role";
import { constantTimeSecretEquals, TELEGRAM_MAX_WEBHOOK_BYTES, telegramConfig } from "@/lib/telegram-contract";
import {
  finishTelegramWebhookUpdate,
  reserveTelegramWebhookUpdate,
} from "@/lib/telegram-service";
import { TelegramApiError } from "@/lib/telegram-bot-api";
import { parseTelegramUpdate, processTelegramUpdate } from "@/lib/telegram-webhook";

async function boundedBody(request: NextRequest): Promise<string | null> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0) return null;
    if (length > TELEGRAM_MAX_WEBHOOK_BYTES) return null;
  }
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > TELEGRAM_MAX_WEBHOOK_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  if (deploymentRole() !== "central") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const configured = telegramConfig();
  if (!configured.enabled) {
    return NextResponse.json(
      { error: configured.reason === "disabled" ? "not_found" : "telegram_not_configured" },
      { status: configured.reason === "disabled" ? 404 : 503 },
    );
  }
  if (!constantTimeSecretEquals(
    request.headers.get("x-telegram-bot-api-secret-token"),
    configured.config.webhookSecret,
  )) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const raw = await boundedBody(request);
  if (raw === null) return NextResponse.json({ error: "payload_too_large_or_invalid" }, { status: 413 });
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const update = parseTelegramUpdate(parsedBody);
  if (!update) return NextResponse.json({ error: "invalid_update" }, { status: 400 });

  const reservation = await reserveTelegramWebhookUpdate(update.update_id);
  if (reservation.status === "processed") {
    return NextResponse.json({ ok: true, duplicate: true });
  }
  if (reservation.status === "in_progress") {
    return NextResponse.json(
      { error: "telegram_update_in_progress" },
      { status: 503, headers: { "Retry-After": "5" } },
    );
  }
  const attemptCount = reservation.attemptCount;

  try {
    await processTelegramUpdate(configured.config, update);
    await finishTelegramWebhookUpdate(update.update_id, attemptCount, { ok: true });
    return NextResponse.json({ ok: true });
  } catch (error) {
    const errorCode = error instanceof TelegramApiError ? error.code : "processing_failed";
    console.error("Telegram webhook processing failed", errorCode);
    await finishTelegramWebhookUpdate(update.update_id, attemptCount, { ok: false, errorCode });
    return NextResponse.json(
      { error: "telegram_temporarily_unavailable" },
      { status: 503, headers: { "Retry-After": "5" } },
    );
  }
}
