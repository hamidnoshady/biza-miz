/**
 * Phase 37 Wave 3 — Kavenegar SMS, the *network* half. Pure request-building
 * and response parsing live in kavenegar.ts so they are fixture-testable; this
 * file owns the only `fetch` and maps its outcome (HTTP reachability, Kavenegar
 * API status) onto the provider seam.
 */
import { smsSegmentCount } from "../../messaging-billing-pure";
import type {
  MessageProvider,
  OutboundMessage,
  SendResult,
} from "../provider";
import {
  buildKavenegarSendRequest,
  kavenegarApiStatusToResult,
  parseKavenegarResponse,
} from "./kavenegar";

export class KavenegarMessageProvider implements MessageProvider {
  readonly key = "kavenegar";
  readonly channel = "sms" as const;

  constructor(
    private readonly apiKey: string,
    private readonly sender: string,
  ) {}

  async send(msg: OutboundMessage): Promise<SendResult> {
    if (!this.apiKey) {
      return { ok: false, retryable: false, code: "provider_config", message: "" };
    }
    const request = buildKavenegarSendRequest({
      apiKey: this.apiKey,
      sender: this.sender,
      receptor: msg.to,
      message: msg.body,
    });

    let response: Response;
    try {
      response = await fetch(request.url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(request.params).toString(),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      const isTimeout = error instanceof Error && error.name === "TimeoutError";
      return {
        ok: false,
        retryable: true,
        code: isTimeout ? "timeout" : "network",
        message: error instanceof Error ? error.message : "network",
      };
    }

    let text = "";
    try {
      text = await response.text();
    } catch {
      return { ok: false, retryable: true, code: "network", message: "empty response" };
    }

    let parsed;
    try {
      parsed = parseKavenegarResponse(text);
    } catch {
      return {
        ok: false,
        retryable: response.status >= 500,
        code: "provider_rejected",
        message: text.slice(0, 200),
      };
    }

    if (parsed === null) {
      return {
        ok: false,
        retryable: response.status >= 500,
        code: "provider_rejected",
        message: text.slice(0, 200),
      };
    }

    const classification = kavenegarApiStatusToResult(parsed);
    if (!classification.ok) {
      return { ok: false, retryable: classification.retryable, code: classification.code, message: parsed.message };
    }
    const providerCostRial = parsed.entries.reduce(
      (total, entry) => total + (entry.costRial ?? 0),
      0,
    );
    return {
      ok: true,
      providerMessageId: classification.providerMessageId ?? `kvn:${Date.now()}`,
      segments: smsSegmentCount(msg.body),
      // Zero is a legitimate absence here: a panel with a zero-tariff line.
      providerCostRial,
    };
  }
}
