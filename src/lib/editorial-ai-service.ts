/**
 * The network half of the editorial assistant: one metered, non-streaming,
 * tool-less text turn through the shared `runAiVisionExtraction` shell (the
 * image is simply absent). Returns the draft and the usage figures the route
 * settles against; it writes nothing (issue #1215, P2‑5).
 */
import type { AiConfig } from "./ai";
import type { AiTokenUsage } from "./ai-billing";
import { runAiVisionExtraction } from "./ai-vision-extraction";
import {
  buildEditorialUserPrompt,
  EDITORIAL_SYSTEM_PROMPT,
  parseEditorialReply,
  type EditorialDraft,
  type EditorialRequest,
} from "./editorial-ai";

const REQUEST_TIMEOUT_MS = 60_000;
const MIN_OUTPUT_TOKENS = 1200;

export class EditorialError extends Error {
  constructor(
    public code: string,
    message: string,
    public detail?: string,
  ) {
    super(message);
    this.name = "EditorialError";
  }
}

export interface EditorialResult extends EditorialDraft {
  usage: AiTokenUsage;
  costUsd: number | null;
}

export async function runEditorialDraft(input: {
  config: AiConfig;
  request: EditorialRequest;
}): Promise<EditorialResult> {
  const reply = await runAiVisionExtraction({
    config: input.config,
    systemPrompt: EDITORIAL_SYSTEM_PROMPT,
    userPrompt: buildEditorialUserPrompt(input.request),
    timeoutMs: REQUEST_TIMEOUT_MS,
    minOutputTokens: MIN_OUTPUT_TOKENS,
    createError: (code, message, detail) => new EditorialError(code, message, detail),
  });
  const draft = parseEditorialReply(reply.text);
  if (!draft) {
    throw new EditorialError("ai_unreadable", "پاسخ هوش مصنوعی قابل استفاده نبود؛ دوباره تلاش کنید.");
  }
  return { ...draft, usage: reply.usage, costUsd: reply.costUsd };
}
