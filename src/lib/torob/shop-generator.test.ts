import { describe, expect, it, vi } from "vitest";
import {
  TOROB_PARTNER_FAILURE_COPY,
  TOROB_SHOP_GENERATOR_URL,
  TorobPartnerError,
  confirmTorobConnection,
  disconnectTorobConnection,
  getTorobConnection,
  isAcceptableReturnUrl,
  requestTorobConnection,
  torobGeneratorBaseUrl,
  torobPartnerToken,
  type TorobPartnerFailure,
} from "./shop-generator";

/**
 * Issue #894 Wave 3 — the Shop Generator client, against the document.
 *
 * The cases below are the ones whose failures are expensive: a flow that reads
 * "connected" while Torob still says `pending`, a 404 for an unknown domain that
 * looks like a network fault, and a replay of the one-time code that gets retried
 * instead of reported.
 */

const ENV = { TOROB_PARTNER_TOKEN: "partner-token" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function capture() {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return jsonResponse({
      connection_id: "75a60226-4997-4ae3-bd10-68f7014e0779",
      shop_domain: "example.ir",
      status: "pending",
      approve_url: "https://api.torob.com/shop-panel/shop-connections/75/approve/",
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("a connection request", () => {
  it("posts the documented body to the documented path with the partner token", async () => {
    const { calls, fetchImpl } = capture();
    const connection = await requestTorobConnection({
      shopDomain: "Example.IR",
      returnUrl: "https://app.example/api/growth/torob/authorize/callback",
      env: ENV,
      fetchImpl,
    });

    expect(calls[0].url).toBe(`${TOROB_SHOP_GENERATOR_URL}connections/`);
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      // Case is ignored by Torob, but sending one spelling keeps our logs clean.
      shop_domain: "example.ir",
      return_url: "https://app.example/api/growth/torob/authorize/callback",
    });
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer partner-token");
    expect(connection).toEqual({
      connectionId: "75a60226-4997-4ae3-bd10-68f7014e0779",
      shopDomain: "example.ir",
      status: "pending",
      approveUrl: "https://api.torob.com/shop-panel/shop-connections/75/approve/",
    });
  });

  it("keeps `pending` and `active` distinct", async () => {
    // An already-connected shop answers `active` with no approve URL. Reading that
    // as "pending" is how a merchant is sent to approve a shop that already is.
    const fetchImpl = (async () =>
      jsonResponse({
        connection_id: "c-1",
        shop_domain: "example.ir",
        status: "active",
        approve_url: null,
      })) as unknown as typeof fetch;
    const connection = await requestTorobConnection({
      shopDomain: "example.ir",
      returnUrl: "https://app.example/cb",
      env: ENV,
      fetchImpl,
    });
    expect(connection).toMatchObject({ status: "active", approveUrl: null });
  });

  it("refuses a return_url Torob would reject, before the network", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(
      requestTorobConnection({ shopDomain: "example.ir", returnUrl: "http://app.example/cb", env: ENV, fetchImpl }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("when the platform is not configured", () => {
  it("says so instead of sending an unauthenticated request", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(
      requestTorobConnection({ shopDomain: "example.ir", returnUrl: "https://app.example/cb", env: {}, fetchImpl }),
    ).rejects.toMatchObject({ code: "not_configured" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(torobPartnerToken({})).toBeNull();
    expect(torobPartnerToken({ TOROB_PARTNER_TOKEN: "  " })).toBeNull();
  });
});

describe("the provider's failures", () => {
  async function failure(status: number, body: unknown): Promise<TorobPartnerFailure> {
    const fetchImpl = (async () => jsonResponse(body, status)) as unknown as typeof fetch;
    try {
      await getTorobConnection({ connectionId: "c-1", env: ENV, fetchImpl });
    } catch (error) {
      expect(error).toBeInstanceOf(TorobPartnerError);
      return (error as TorobPartnerError).code;
    }
    throw new Error("expected a failure");
  }

  it("maps each documented status to one reason", async () => {
    expect(await failure(401, { detail: "Unauthorized" })).toBe("unauthorized");
    expect(await failure(403, { detail: "Only shop generator tokens can manage shop connections." })).toBe(
      "not_a_generator",
    );
    expect(await failure(404, { error: "No shop has this domain." })).toBe("no_such_shop");
    expect(await failure(404, { error: "Connection not found." })).toBe("connection_not_found");
    expect(await failure(400, { error: "invalid request body" })).toBe("invalid_request");
    expect(await failure(400, { error: "The code is invalid, used or expired." })).toBe("code_invalid");
    expect(await failure(500, {})).toBe("provider_error");
  });

  it("does not invent success for an unparseable body", async () => {
    const fetchImpl = (async () => new Response("<html>busy</html>", { status: 200 })) as unknown as typeof fetch;
    await expect(getTorobConnection({ connectionId: "c-1", env: ENV, fetchImpl })).rejects.toMatchObject({
      code: "provider_error",
    });
  });

  it("gives every reason a merchant-facing sentence", () => {
    const reasons: TorobPartnerFailure[] = [
      "not_configured",
      "unauthorized",
      "not_a_generator",
      "no_such_shop",
      "connection_not_found",
      "code_invalid",
      "invalid_request",
      "provider_error",
      "timeout",
    ];
    for (const reason of reasons) expect(TOROB_PARTNER_FAILURE_COPY[reason].length).toBeGreaterThan(10);
  });
});

describe("confirming an approval", () => {
  it("posts the one-time code to the confirm path", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      return jsonResponse({
        connection_id: "75a60226-4997-4ae3-bd10-68f7014e0779",
        shop_domain: "example.ir",
        status: "active",
        approve_url: null,
      });
    }) as unknown as typeof fetch;

    const connection = await confirmTorobConnection({
      connectionId: "75a60226-4997-4ae3-bd10-68f7014e0779",
      code: "hgx8duhEXiUmcMnxiULEzt-ZccOYFD3pfs-NEXXNeP0",
      env: ENV,
      fetchImpl,
    });
    expect(calls[0].url).toBe(`${TOROB_SHOP_GENERATOR_URL}connections/75a60226-4997-4ae3-bd10-68f7014e0779/confirm/`);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      code: "hgx8duhEXiUmcMnxiULEzt-ZccOYFD3pfs-NEXXNeP0",
    });
    expect(connection.status).toBe("active");
  });

  it("refuses an empty code without asking Torob", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(confirmTorobConnection({ connectionId: "c-1", code: "  ", env: ENV, fetchImpl })).rejects.toMatchObject(
      { code: "invalid_request" },
    );
  });
});

describe("disconnecting", () => {
  it("sends DELETE and accepts Torob's 204", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    await expect(disconnectTorobConnection({ connectionId: "c-1", env: ENV, fetchImpl })).resolves.toBeUndefined();
    expect(calls[0].init.method).toBe("DELETE");
    expect(calls[0].url).toBe(`${TOROB_SHOP_GENERATOR_URL}connections/c-1/`);
  });
});

describe("the URL rules", () => {
  it("accepts https anywhere and http only on loopback", () => {
    expect(isAcceptableReturnUrl("https://app.example/cb?merchant=42")).toBe(true);
    expect(isAcceptableReturnUrl("http://localhost:3000/cb")).toBe(true);
    expect(isAcceptableReturnUrl("http://127.0.0.1:3000/cb")).toBe(true);
    expect(isAcceptableReturnUrl("http://app.example/cb")).toBe(false);
    expect(isAcceptableReturnUrl("ftp://app.example/cb")).toBe(false);
    expect(isAcceptableReturnUrl("not a url")).toBe(false);
  });

  it("normalises a configured base URL to one trailing slash", () => {
    expect(torobGeneratorBaseUrl({})).toBe(TOROB_SHOP_GENERATOR_URL);
    expect(torobGeneratorBaseUrl({ TOROB_SHOP_GENERATOR_BASE_URL: "https://sandbox.example/shop-generator/v1" })).toBe(
      "https://sandbox.example/shop-generator/v1/",
    );
  });
});
