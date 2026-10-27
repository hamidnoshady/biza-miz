/**
 * Issue #902 — the network half, driven by a fake transport.
 *
 * No test in this repository may call the provider, so the things worth
 * proving here are the decisions around the call: which verbs are retried,
 * which failures are *ambiguous* (a POST whose answer was lost), and that the
 * error a caller receives can never contain the key.
 */
import { describe, expect, it } from "vitest";
import {
  KavenegarManagementClient,
  KavenegarManagementError,
  KavenegarTransportError,
  type KavenegarTransport,
  type KavenegarTransportRequest,
  type KavenegarTransportResponse,
} from "./rest";

const CHILD = {
  apikey: "CHILDKEY12345678901234567890",
  localid: "0d5f4c7e-2e63-4e1f-9c8e-6e0f6f4a9b11",
  username: "bm0d5f4c7e2e634e1f",
  fullname: "Business",
  status: "Approved",
  remaincredit: 0,
  smsfarsicost: "150",
  smsenglishcost: "360",
  pricingname: "Price",
  mininumallowedcredit: 100000,
  assignedlines: "",
  expiredate: 0,
  lastlogindate: 0,
};

function ok(entries: unknown, metadata?: Record<string, string>): KavenegarTransportResponse {
  return {
    status: 200,
    body: JSON.stringify({
      return: { status: 200, message: "تایید شد" },
      ...(entries === undefined ? {} : { entries }),
      ...(metadata ? { metadata } : {}),
    }),
  };
}

function providerStatus(status: number): KavenegarTransportResponse {
  return {
    status: 200,
    body: JSON.stringify({ return: { status, message: "provider said no" } }),
  };
}

function scripted(responses: (KavenegarTransportResponse | Error)[]) {
  const calls: KavenegarTransportRequest[] = [];
  const transport: KavenegarTransport = async (request) => {
    calls.push(request);
    const next = responses.shift();
    if (!next) throw new Error("unexpected transport call");
    if (next instanceof Error) throw next;
    return next;
  };
  return { transport, calls };
}

const options = { sleep: async () => {} };

describe("KavenegarManagementClient", () => {
  it("creates a child over one POST and parses the documented envelope", async () => {
    const { transport, calls } = scripted([ok(CHILD)]);
    const client = new KavenegarManagementClient("MASTER", { transport, ...options });

    const child = await client.addChild({
      localId: CHILD.localid,
      username: CHILD.username,
      password: "Aa1secret",
      fullName: "Business",
      minAllowedCreditRial: 100000,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/client/add.json");
    expect(calls[0]?.params).toMatchObject({ localid: CHILD.localid, Status: "2" });
    expect(child).toMatchObject({ apiKey: CHILD.apikey, localId: CHILD.localid, status: "approved" });
  });

  it("never auto-retries a create: a lost response is ambiguous, not safe to repeat", async () => {
    const { transport, calls } = scripted([new Error("socket hang up")]);
    const client = new KavenegarManagementClient("MASTER", { transport, ...options });

    const error = await client
      .addChild({
        localId: CHILD.localid,
        username: CHILD.username,
        password: "Aa1secret",
        fullName: "Business",
        minAllowedCreditRial: 0,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(KavenegarTransportError);
    expect((error as KavenegarTransportError).ambiguous).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("retries an idempotent GET after a transient failure", async () => {
    const { transport, calls } = scripted([new Error("socket hang up"), ok(CHILD)]);
    const client = new KavenegarManagementClient("MASTER", { transport, ...options });

    const child = await client.fetchChildByLocalId(CHILD.localid);
    expect(child.apiKey).toBe(CHILD.apikey);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.method).toBe("GET");
  });

  it("retries a retryable provider status on a GET, then succeeds", async () => {
    const { transport, calls } = scripted([providerStatus(409), ok(CHILD)]);
    const client = new KavenegarManagementClient("MASTER", { transport, ...options });
    expect((await client.fetchChild(CHILD.apikey)).username).toBe(CHILD.username);
    expect(calls).toHaveLength(2);
  });

  it("surfaces a provider rejection with a redacted URL and no credential", async () => {
    const { transport } = scripted([providerStatus(449)]);
    const client = new KavenegarManagementClient("SUPERSECRETMASTER", { transport, ...options });

    const error = await client.fetchChildByLocalId("local").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(KavenegarManagementError);
    const management = error as KavenegarManagementError;
    expect(management.classification.code).toBe("not_found");
    expect(management.operatorUrl).toContain("/v1/REDACTED/");
    expect(management.operatorUrl).not.toContain("SUPERSECRETMASTER");
    expect(management.message).not.toContain("SUPERSECRETMASTER");
  });

  it("does not retry a rate-limited POST either — the queue backs off instead", async () => {
    const { transport, calls } = scripted([providerStatus(451)]);
    const client = new KavenegarManagementClient("MASTER", { transport, ...options });

    const error = await client
      .chargeChildCredit({ childApiKey: CHILD.apikey, creditRial: 25000 })
      .catch((caught: unknown) => caught);
    expect((error as KavenegarManagementError).classification).toMatchObject({
      code: "rate_limited",
      retryable: true,
    });
    expect(calls).toHaveLength(1);
  });

  it("marks a timeout on a POST as ambiguous", async () => {
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    const { transport } = scripted([timeout]);
    const client = new KavenegarManagementClient("MASTER", { transport, ...options });

    const error = await client
      .chargeChildCredit({ childApiKey: CHILD.apikey, creditRial: 25000 })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(KavenegarTransportError);
    expect((error as KavenegarTransportError).ambiguous).toBe(true);
    expect((error as KavenegarTransportError).timeout).toBe(true);
  });

  it("lists templates with the provider's pagination metadata", async () => {
    const { transport } = scripted([
      ok(
        [{ id: 1, name: "LoginOtp", textmessage: "کد %token", approvalStatus: "Approved" }],
        { TotalCount: "1", TotalPages: "1", CurrentPage: "1" },
      ),
    ]);
    const client = new KavenegarManagementClient("MASTER", { transport, ...options });
    const listed = await client.listTemplates({ childLocalId: "L" });
    expect(listed).toMatchObject({ totalCount: 1, totalPages: 1 });
    expect(listed.templates[0]).toMatchObject({ templateId: "1", approvalStatus: "approved" });
  });

  it("revises a template through updatetemplate and never retries a POST", async () => {
    const seen: KavenegarTransportRequest[] = [];
    const client = new KavenegarManagementClient("MASTER", {
      transport: async (request) => {
        seen.push(request);
        return {
          status: 200,
          body: JSON.stringify({
            return: { status: 200, message: "تایید شد" },
            entries: { templateid: "12345", name: "bmv0011", textmessage: "کد %token" },
          }),
        };
      },
      sleep: async () => {},
    });

    const updated = await client.updateTemplate({
      templateId: 12345,
      childApiKey: "CHILD",
      name: "bmv0011",
      textMessage: "کد %token",
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].url).toContain("/verify/updatetemplate.json");
    expect(seen[0].method).toBe("POST");
    expect(seen[0].params).toMatchObject({ templateId: "12345", apiKey: "CHILD", name: "bmv0011" });
    expect(updated.templateId).toBe("12345");
  });

  it("reports an edit whose answer was lost as ambiguous, not as failed", async () => {
    // The provider may have applied the edit and dropped the response; the
    // caller records `outcome_unknown` and resolves it on the next sync.
    const client = new KavenegarManagementClient("MASTER", {
      transport: async () => {
        throw Object.assign(new Error("socket hang up"), { name: "AbortError" });
      },
      sleep: async () => {},
    });

    await expect(
      client.updateTemplate({ templateId: 1, name: "bmv0011", childApiKey: "C", textMessage: "x %token" }),
    ).rejects.toMatchObject({ ambiguous: true });
  });

  it("funds a child and reports the resulting balance", async () => {
    const { transport, calls } = scripted([ok({ ...CHILD, remaincredit: 25000 })]);
    const client = new KavenegarManagementClient("MASTER", { transport, ...options });
    const child = await client.chargeChildCredit({ childApiKey: CHILD.apikey, creditRial: 25000 });
    expect(child.remainCreditRial).toBe(25000);
    expect(calls[0]?.params).toMatchObject({ apikey: CHILD.apikey, Credit: "25000" });
  });

  it("treats a success with no entry as an error rather than a fabricated child", async () => {
    const { transport } = scripted([ok(undefined)]);
    const client = new KavenegarManagementClient("MASTER", { transport, ...options });
    await expect(client.fetchChild(CHILD.apikey)).rejects.toBeInstanceOf(KavenegarManagementError);
  });
});
