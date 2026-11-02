/**
 * The network half of AI product descriptions: one metered, non-streaming,
 * tool-less text turn through the shared `runAiVisionExtraction` shell (the
 * image is simply absent). Returns the draft and the usage figures the route
 * settles against; it writes nothing.
 */
import type { AiConfig } from "./ai";
import type { AiTokenUsage } from "./ai-billing";
import { runAiVisionExtraction } from "./ai-vision-extraction";
import {
  buildProductDescriptionUserPrompt,
  parseProductDescriptionReply,
  PRODUCT_DESCRIPTION_SYSTEM_PROMPT,
  type ProductDescriptionDraft,
  type ProductDescriptionFacts,
} from "./product-description-ai";

const REQUEST_TIMEOUT_MS = 60_000;
const MIN_OUTPUT_TOKENS = 1500;

export class ProductDescriptionError extends Error {
  constructor(
    public code: string,
    message: string,
    public detail?: string,
  ) {
    super(message);
    this.name = "ProductDescriptionError";
  }
}

export interface ProductDescriptionResult extends ProductDescriptionDraft {
  usage: AiTokenUsage;
  costUsd: number | null;
}

export async function runProductDescriptionDraft(input: {
  config: AiConfig;
  facts: ProductDescriptionFacts;
}): Promise<ProductDescriptionResult> {
  const reply = await runAiVisionExtraction({
    config: input.config,
    systemPrompt: PRODUCT_DESCRIPTION_SYSTEM_PROMPT,
    userPrompt: buildProductDescriptionUserPrompt(input.facts),
    timeoutMs: REQUEST_TIMEOUT_MS,
    minOutputTokens: MIN_OUTPUT_TOKENS,
    createError: (code, message, detail) => new ProductDescriptionError(code, message, detail),
  });
  const draft = parseProductDescriptionReply(reply.text);
  if (!draft) {
    throw new ProductDescriptionError("ai_unreadable", "پاسخ هوش مصنوعی قابل استفاده نبود؛ دوباره تلاش کنید.");
  }
  return { ...draft, usage: reply.usage, costUsd: reply.costUsd };
}
