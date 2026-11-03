/**
 * Issue #894 Wave 5b — the one call to Torob's webhook, against a scripted provider.
 *
 * What is worth asserting here is the mapping: which status becomes which failure,
 * and the fact that nothing short of the documented acceptance counts. A wrong map
 * dead-letters a batch that a retry would have delivered, or retries one that never
 * can be.
 */
import { describe, expect, it, vi } from "vitest";
import { TorobWebhookClientError, sendTorobWebhook, torobWebhookUrl } from "./webhook-client";
import { webhookBody, type WebhookItem } from "./webhook";

const env = { TOROB_WEBHOOK_URL: "https://torob.test/update/webhook/v1/" } as Record<string, string | undefined>;

const items: WebhookItem[] = [
  {
    pageUnique: "p1",
    pageUrl: "https://shop.alpha.example/product/p1",
    reason: "updated",
    pageUpdatedAt: null,
  },
];

function scripted(response: Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("the endpoint", () => {
  it("defaults to Torob's documented URL", () => {
    expect(torobWebhookUrl({})).toBe("https://api.torob.com/update/webhook/v1/");
  });
});

describe("sendTorobWebhook", () => {
  it("sends the batch with the bearer token in the header and nothing in the URL", async () => {
    const { fetchImpl, calls } = scripted(json({ message: "success" }));
    await sendTorobWebhook({ token: "shop-token", body: webhookBody(items), env, fetchImpl });

    expect(calls[0].url).toBe("https://torob.test/update/webhook/v1/");
    expect(calls[0].init.method).toBe("POST");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer shop-token");
    expect(headers["content-type"]).toBe("application/json");
    expect(String(calls[0].init.body)).toContain('"page_unique":"p1"');
    expect(calls[0].url).not.toContain("shop-token");
  });

  it("refuses before the network without a token", async () => {
    const { fetchImpl, calls } = scripted(json({ message: "success" }));
    await expect(sendTorobWebhook({ token: " ", body: webhookBody(items), env, fetchImpl })).rejects.toMatchObject({
      code: "not_configured",
    });
    expect(calls).toHaveLength(0);
  });

  it("refuses an empty batch rather than asking Torob to accept nothing", async () => {
    const { fetchImpl, calls } = scripted(json({ message: "success" }));
    await expect(sendTorobWebhook({ token: "t", body: { items: [] }, env, fetchImpl })).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(calls).toHaveLength(0);
  });

  it("treats a 200 with an unexpected body as a provider failure, not an acceptance", async () => {
    const { fetchImpl } = scripted(json({ message: "queued maybe" }));
    await expect(
      sendTorobWebhook({ token: "t", body: webhookBody(items), env, fetchImpl }),
    ).rejects.toMatchObject({ code: "provider_error" });
  });

  it("maps a mixed-host refusal to domain_mismatch", async () => {
    const { fetchImpl } = scripted(json({ error: "All page_urls must have the same host" }, 400));
    await expect(
      sendTorobWebhook({ token: "t", body: webhookBody(items), env, fetchImpl }),
    ).rejects.toMatchObject({ code: "domain_mismatch" });
  });

  it("maps a credential failure to unauthorized", async () => {
    const { fetchImpl } = scripted(new Response("", { status: 401 }));
    await expect(
      sendTorobWebhook({ token: "t", body: webhookBody(items), env, fetchImpl }),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("separates the two 403s Torob documents", async () => {
    // Domain mismatch and "shop is not active" are both 403 and need different
    // sentences, because only one of them is fixable by the merchant.
    await expect(
      sendTorobWebhook({
        token: "t",
        body: webhookBody(items),
        env,
        fetchImpl: scripted(json({ error: "Shop domain does not match the credentials given" }, 403)).fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "domain_mismatch" });

    await expect(
      sendTorobWebhook({
        token: "t",
        body: webhookBody(items),
        env,
        fetchImpl: scripted(json({ error: "Shop is not active" }, 403)).fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "shop_not_active" });
  });

  it("maps 429 and 5xx to the two failures a retry can fix", async () => {
    await expect(
      sendTorobWebhook({ token: "t", body: webhookBody(items), env, fetchImpl: scripted(new Response("", { status: 429 })).fetchImpl }),
    ).rejects.toMatchObject({ code: "rate_limited" });
    await expect(
      sendTorobWebhook({ token: "t", body: webhookBody(items), env, fetchImpl: scripted(new Response("", { status: 503 })).fetchImpl }),
    ).rejects.toMatchObject({ code: "provider_error" });
  });

  it("distinguishes a timeout from a generic network failure", async () => {
    const timeout = vi.fn(async () => {
      const error = new Error("aborted");
      error.name = "TimeoutError";
      throw error;
    }) as unknown as typeof fetch;
    const caught = await sendTorobWebhook({ token: "t", body: webhookBody(items), env, fetchImpl: timeout }).catch(
      (error) => error,
    );
    expect(caught).toBeInstanceOf(TorobWebhookClientError);
    expect(caught.code).toBe("timeout");
  });
});
