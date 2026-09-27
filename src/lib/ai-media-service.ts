/**
 * DB-free provider half of the media library's AI abilities — structured
 * after `ai-inventory-vision-service.ts` (same provider contract, same
 * timeout, same usage/cost accounting):
 *
 *   • `runMediaLabelDetection` — one vision chat turn that proposes a
 *     category + tags for an uploaded image. The image never leaves this
 *     request; the proposal is stored as pending review, never applied.
 *
 *   • `runMediaImageEdit` — one call to the provider's OpenAI-compatible
 *     `/images/edits` endpoint with a given prompt, producing one edited
 *     image. `runMediaEnhance`, `runMediaBackgroundRemoval`, and
 *     `runMediaUpscale` are thin wrappers over it, one prompt each
 *     (`ai-media.ts`) — same request shape, same error handling, only the
 *     instruction differs. Providers that do not expose an image-edit model
 *     answer 404/400, which surfaces to the operator as a clear Persian
 *     message rather than a hang.
 *
 *   • `runMediaVariations` — the one operation with a genuinely different
 *     provider endpoint (`/images/variations`, no prompt) and a genuinely
 *     different result shape (several images from one call, not one).
 */
import { chatCompletionsUrl, type AiConfig } from "./ai";
import { estimateTokens, type AiTokenUsage } from "./ai-billing";
import { parseResponseCostHeader } from "./ai-gateway";
import { assertPublicHttpsUrl } from "./ssrf";
import {
  imageEditsUrl,
  imageVariationsUrl,
  MEDIA_BG_REMOVE_PROMPT,
  MEDIA_ENHANCE_PROMPT,
  MEDIA_LABEL_SYSTEM_PROMPT,
  MEDIA_UPSCALE_PROMPT,
  mediaLabelUserPrompt,
  parseImageEditReplies,
  parseMediaLabelReply,
  type MediaLabelReply,
} from "./ai-media";

const LABEL_TIMEOUT_MS = 60_000;
const ENHANCE_TIMEOUT_MS = 120_000;
/** An edited product shot larger than this is a provider bug, not an image. */
const MAX_ENHANCED_BYTES = 12 * 1024 * 1024;

export class MediaAiError extends Error {
  constructor(
    public code: string,
    message: string,
    public detail?: string,
  ) {
    super(message);
    this.name = "MediaAiError";
  }
}

type ProviderContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

interface ProviderMessage {
  role: "system" | "user" | "assistant";
  content: string | ProviderContentPart[];
}

function providerHeaders(config: AiConfig): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.gateway?.authKey || config.apiKey}`,
  };
}

export interface MediaLabelResult extends MediaLabelReply {
  usage: AiTokenUsage;
  costUsd: number | null;
}

/** One metered vision turn proposing category/tags for an image. */
export async function runMediaLabelDetection(input: {
  config: AiConfig;
  dataUrl: string;
  fileName: string;
}): Promise<MediaLabelResult> {
  const messages: ProviderMessage[] = [
    { role: "system", content: MEDIA_LABEL_SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        { type: "text", text: mediaLabelUserPrompt(input.fileName) },
        { type: "image_url", image_url: { url: input.dataUrl } },
      ],
    },
  ];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LABEL_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(chatCompletionsUrl(input.config.baseUrl), {
      method: "POST",
      headers: providerHeaders(input.config),
      body: JSON.stringify({
        model: input.config.model,
        messages,
        temperature: Math.min(input.config.temperature, 0.2),
        max_tokens: Math.max(input.config.maxOutputTokens ?? 1000, 512),
        ...(input.config.gateway?.body ?? {}),
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      throw new MediaAiError("ai_timeout", "پاسخ سرویس هوش مصنوعی به‌موقع نرسید.");
    }
    throw new MediaAiError("ai_network", "اتصال به سرویس هوش مصنوعی برقرار نشد.");
  }
  clearTimeout(timer);

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) {
      throw new MediaAiError("ai_auth", "کلید سرویس هوش مصنوعی نامعتبر است.", body);
    }
    throw new MediaAiError("ai_provider", `سرویس هوش مصنوعی خطا داد (${res.status}).`, body);
  }

  const payload = (await res.json().catch(() => null)) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  } | null;
  const content = payload?.choices?.[0]?.message?.content ?? "";
  const reply = parseMediaLabelReply(content);
  if (!reply) {
    throw new MediaAiError("ai_reply_invalid", "پاسخ مدل قابل استفاده نبود؛ برچسبی پیشنهاد نشد.");
  }

  const usage: AiTokenUsage = payload?.usage
    ? {
        inputTokens: Math.max(0, Math.floor(payload.usage.prompt_tokens ?? 0)),
        outputTokens: Math.max(0, Math.floor(payload.usage.completion_tokens ?? 0)),
      }
    : { inputTokens: estimateTokens(JSON.stringify(messages)), outputTokens: estimateTokens(content) };

  return { ...reply, usage, costUsd: parseResponseCostHeader(res.headers.get("x-litellm-response-cost")) };
}

export interface MediaEnhanceResult {
  /** PNG bytes of the edited image. */
  bytes: Buffer;
  costUsd: number | null;
}

/** Downloads a provider-hosted result URL rather than trusting it blindly — same SSRF guard as the label call's image input. */
async function downloadEditedImage(url: string, timeoutMs: number): Promise<Buffer> {
  const target = await assertPublicHttpsUrl(url);
  if (!target.ok) {
    throw new MediaAiError("ai_reply_invalid", "آدرس تصویر ویرایش‌شده معتبر نیست.");
  }
  const dl = await fetch(target.url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!dl.ok) throw new MediaAiError("ai_provider", "دریافت تصویر ویرایش‌شده ناموفق بود.");
  return Buffer.from(await dl.arrayBuffer());
}

/**
 * One call to the provider's OpenAI-compatible `/images/edits` endpoint with
 * a given `prompt` — the shared machinery behind `runMediaEnhance`,
 * `runMediaBackgroundRemoval`, and `runMediaUpscale`. `model` comes from the
 * console config (platform_media_config.enhance_model — the one edit model
 * configured platform-wide, reused for all three operations).
 */
export async function runMediaImageEdit(input: {
  config: AiConfig;
  model: string;
  prompt: string;
  imageBytes: Buffer;
  mimeType: string;
  fileName: string;
}): Promise<MediaEnhanceResult> {
  const form = new FormData();
  form.set("model", input.model);
  form.set("prompt", input.prompt);
  form.set(
    "image",
    new Blob([new Uint8Array(input.imageBytes)], { type: input.mimeType }),
    input.fileName,
  );

  const headers = providerHeaders(input.config);
  delete headers["Content-Type"]; // multipart boundary is fetch's to set

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ENHANCE_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(imageEditsUrl(input.config.baseUrl), {
      method: "POST",
      headers,
      body: form,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      throw new MediaAiError("ai_timeout", "پاسخ سرویس ویرایش تصویر به‌موقع نرسید.");
    }
    throw new MediaAiError("ai_network", "اتصال به سرویس هوش مصنوعی برقرار نشد.");
  }
  clearTimeout(timer);

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) {
      throw new MediaAiError("ai_auth", "کلید سرویس هوش مصنوعی نامعتبر است.", body);
    }
    if (res.status === 404 || res.status === 400) {
      throw new MediaAiError(
        "enhance_unsupported",
        "سرویس هوش مصنوعی فعلی از ویرایش تصویر پشتیبانی نمی‌کند.",
        body,
      );
    }
    throw new MediaAiError("ai_provider", `سرویس ویرایش تصویر خطا داد (${res.status}).`, body);
  }

  const costUsd = parseResponseCostHeader(res.headers.get("x-litellm-response-cost"));
  const payload = await res.json().catch(() => null);
  const [parsed] = parseImageEditReplies(payload);
  if (!parsed) {
    throw new MediaAiError("ai_reply_invalid", "پاسخ سرویس ویرایش تصویر قابل استفاده نبود.");
  }

  const bytes = "b64" in parsed ? Buffer.from(parsed.b64, "base64") : await downloadEditedImage(parsed.url, ENHANCE_TIMEOUT_MS);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ENHANCED_BYTES) {
    throw new MediaAiError("ai_reply_invalid", "تصویر ویرایش‌شده معتبر نبود.");
  }
  return { bytes, costUsd };
}

/** Photo in, standard white-background e-commerce product shot out. */
export function runMediaEnhance(input: {
  config: AiConfig;
  model: string;
  imageBytes: Buffer;
  mimeType: string;
  fileName: string;
}): Promise<MediaEnhanceResult> {
  return runMediaImageEdit({ ...input, prompt: MEDIA_ENHANCE_PROMPT });
}

/** Photo in, subject-only PNG with a transparent background out. */
export function runMediaBackgroundRemoval(input: {
  config: AiConfig;
  model: string;
  imageBytes: Buffer;
  mimeType: string;
  fileName: string;
}): Promise<MediaEnhanceResult> {
  return runMediaImageEdit({ ...input, prompt: MEDIA_BG_REMOVE_PROMPT });
}

/**
 * Photo in, a sharpened/de-noised higher-resolution rendition out — a
 * prompted edit-model operation, not a dedicated super-resolution model (see
 * `MEDIA_UPSCALE_PROMPT`'s own comment for why this distinction matters).
 */
export function runMediaUpscale(input: {
  config: AiConfig;
  model: string;
  imageBytes: Buffer;
  mimeType: string;
  fileName: string;
}): Promise<MediaEnhanceResult> {
  return runMediaImageEdit({ ...input, prompt: MEDIA_UPSCALE_PROMPT });
}

export interface MediaVariationsResult {
  /** PNG bytes of each alternate, in the order the provider returned them. */
  images: Buffer[];
  costUsd: number | null;
}

/**
 * One call to the provider's OpenAI-compatible `/images/variations`
 * endpoint: no prompt, `count` different renditions of the same subject back
 * from a single request — genuinely distinct from `runMediaImageEdit`, which
 * always returns exactly one image shaped by an instruction.
 */
export async function runMediaVariations(input: {
  config: AiConfig;
  model: string;
  imageBytes: Buffer;
  mimeType: string;
  fileName: string;
  count: number;
}): Promise<MediaVariationsResult> {
  const form = new FormData();
  form.set("model", input.model);
  form.set("n", String(Math.max(1, Math.floor(input.count))));
  form.set(
    "image",
    new Blob([new Uint8Array(input.imageBytes)], { type: input.mimeType }),
    input.fileName,
  );

  const headers = providerHeaders(input.config);
  delete headers["Content-Type"];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ENHANCE_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(imageVariationsUrl(input.config.baseUrl), {
      method: "POST",
      headers,
      body: form,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      throw new MediaAiError("ai_timeout", "پاسخ سرویس تنوع‌سازی تصویر به‌موقع نرسید.");
    }
    throw new MediaAiError("ai_network", "اتصال به سرویس هوش مصنوعی برقرار نشد.");
  }
  clearTimeout(timer);

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) {
      throw new MediaAiError("ai_auth", "کلید سرویس هوش مصنوعی نامعتبر است.", body);
    }
    if (res.status === 404 || res.status === 400) {
      throw new MediaAiError(
        "enhance_unsupported",
        "سرویس هوش مصنوعی فعلی از تنوع‌سازی تصویر پشتیبانی نمی‌کند.",
        body,
      );
    }
    throw new MediaAiError("ai_provider", `سرویس تنوع‌سازی تصویر خطا داد (${res.status}).`, body);
  }

  const costUsd = parseResponseCostHeader(res.headers.get("x-litellm-response-cost"));
  const payload = await res.json().catch(() => null);
  const parsedList = parseImageEditReplies(payload);
  if (parsedList.length === 0) {
    throw new MediaAiError("ai_reply_invalid", "پاسخ سرویس تنوع‌سازی تصویر قابل استفاده نبود.");
  }

  const images: Buffer[] = [];
  for (const parsed of parsedList) {
    const bytes = "b64" in parsed ? Buffer.from(parsed.b64, "base64") : await downloadEditedImage(parsed.url, ENHANCE_TIMEOUT_MS);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_ENHANCED_BYTES) {
      throw new MediaAiError("ai_reply_invalid", "یکی از تصاویر تنوع‌سازی‌شده معتبر نبود.");
    }
    images.push(bytes);
  }
  return { images, costUsd };
}
