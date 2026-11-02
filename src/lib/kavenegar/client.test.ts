/**
 * Issue #902 — the customer-management adapter against RECORDED fixtures.
 *
 * Every body below is copied from the provider's documented example at
 * kavenegar.com/customers.html (not from a live call): the point of this file
 * is that a provider shape cannot drift without a failing test, and that the
 * envelope bug the spike found (`entries` is top-level, not inside `return`) is
 * fixed and stays fixed.
 */
import { describe, expect, it } from "vitest";
import {
  buildAccountInfoRequest,
  buildAddChildAccountRequest,
  buildChargeChildCreditRequest,
  buildFetchChildByLocalIdRequest,
  buildListTemplatesRequest,
  buildRenewChildKeyRequest,
  buildUpdateChildAccountRequest,
  buildUpdateTemplateRequest,
  classifyKavenegarStatus,
  isLocalIdCollision,
  isUsernameCollision,
  mapAccountInfo,
  mapChildAccount,
  normalizeChildStatus,
  parseKavenegarEnvelope,
  redactKavenegarUrl,
} from "./client";

const CHILD_ENTRY = {
  remaincredit: 25000,
  expiredate: 0,
  apikey: "SSDG65644KF64HFFD87584KFYT985987545",
  fullname: "Reza Mohammadi",
  username: "Customer",
  pricingname: "Price",
  smsfarsicost: "150",
  smsenglishcost: "360",
  calllocalcost: "37",
  lastlogindate: 1559137140,
  mininumallowedcredit: 100000,
  status: "Approved",
  pwdhashed: "8765ASFSD8758LKH645634",
  mobile: "09125258596",
  localid: "0d5f4c7e-2e63-4e1f-9c8e-6e0f6f4a9b11",
};

/** Documented `client/add` reply — the payload is a SIBLING of `return`. */
const ADD_RESPONSE = JSON.stringify({
  return: { status: 200, message: "تایید شد" },
  entries: { ...CHILD_ENTRY, remaincredit: 0, localid: "" },
});

const LIST_RESPONSE = JSON.stringify({
  return: { status: 200, message: "تایید شد" },
  entries: [CHILD_ENTRY, { ...CHILD_ENTRY, username: "Customer1", status: "Removed", localid: "10050" }],
});

const TEMPLATE_LIST_RESPONSE = JSON.stringify({
  return: { status: 200, message: "تایید شد" },
  entries: [
    {
      id: 12345,
      name: "LoginOtp",
      textmessage: "کد ورود شما %token است",
      approvalStatus: "Approved",
    },
    { id: 12346, name: "OrderReady", smsmessage: "سفارش %token آماده است", approvalStatus: "PendingReview" },
  ],
  metadata: { TotalCount: "2", CurrentPage: "1", TotalPages: "1", PageSize: "200" },
});

describe("parseKavenegarEnvelope", () => {
  it("reads the documented TOP-LEVEL entries object", () => {
    const envelope = parseKavenegarEnvelope(ADD_RESPONSE, mapChildAccount);
    expect(envelope.entriesShape).toBe("object");
    expect(envelope.status).toBe(200);
    expect(envelope.entries).toHaveLength(1);
    expect(envelope.entries[0]?.apiKey).toBe("SSDG65644KF64HFFD87584KFYT985987545");
    expect(envelope.entries[0]?.remainCreditRial).toBe(0);
  });

  it("reads a top-level entries ARRAY (client/list)", () => {
    const envelope = parseKavenegarEnvelope(LIST_RESPONSE, mapChildAccount);
    expect(envelope.entriesShape).toBe("array");
    expect(envelope.entries.map((entry) => entry.username)).toEqual(["Customer", "Customer1"]);
    expect(envelope.entries[1]?.status).toBe("removed");
  });

  it("still accepts the legacy nested shape so an old fixture replays", () => {
    const legacy = JSON.stringify({
      return: { status: 200, message: "ok", entries: [{ ...CHILD_ENTRY, apikey: "OLD" }] },
    });
    const envelope = parseKavenegarEnvelope(legacy, mapChildAccount);
    expect(envelope.entriesShape).toBe("return_nested");
    expect(envelope.entries[0]?.apiKey).toBe("OLD");
  });

  it("handles a reply with no payload (a delete or a validation failure)", () => {
    const envelope = parseKavenegarEnvelope(
      JSON.stringify({ return: { status: 200, message: "ok" } }),
      mapChildAccount,
    );
    expect(envelope.entries).toEqual([]);
    expect(envelope.entriesShape).toBe("none");
  });

  it("carries template pagination metadata", () => {
    const envelope = parseKavenegarEnvelope(TEMPLATE_LIST_RESPONSE, (raw) => raw);
    expect(envelope.metadata.TotalCount).toBe("2");
    expect(envelope.metadata.TotalPages).toBe("1");
  });

  it("throws a typed error rather than guessing at malformed JSON", () => {
    expect(() => parseKavenegarEnvelope("<html>", mapChildAccount)).toThrowError(/invalid_json/);
    expect(() => parseKavenegarEnvelope(JSON.stringify({ entries: [] }), mapChildAccount)).toThrowError(
      /invalid_envelope/,
    );
  });
});

describe("mapChildAccount", () => {
  it("normalises the fields the platform stores and drops credential-adjacent ones", () => {
    const child = mapChildAccount(CHILD_ENTRY);
    expect(child).toEqual({
      apiKey: CHILD_ENTRY.apikey,
      localId: CHILD_ENTRY.localid,
      username: "Customer",
      fullName: "Reza Mohammadi",
      status: "approved",
      remainCreditRial: 25000,
      smsFarsiCostRial: 150,
      smsEnglishCostRial: 360,
      pricingName: "Price",
      minAllowedCreditRial: 100000,
      assignedLines: [],
      expireAtUnix: 0,
      lastLoginAtUnix: 1559137140,
    });
    // `pwdhashed`/`mobile` must not survive normalisation at all.
    expect(JSON.stringify(child)).not.toContain("pwdhashed");
    expect(JSON.stringify(child)).not.toContain("09125258596");
  });

  it("splits assigned lines and tolerates the provider's key casing", () => {
    const child = mapChildAccount({ ...CHILD_ENTRY, AssignedLines: "10004346, 1000596446" });
    expect(child.assignedLines).toEqual(["10004346", "1000596446"]);
  });

  it("normalises every status spelling the provider documents", () => {
    expect(normalizeChildStatus("Approved")).toBe("approved");
    expect(normalizeChildStatus("PendingReview")).toBe("pending");
    expect(normalizeChildStatus("Removed")).toBe("removed");
    expect(normalizeChildStatus("")).toBe("unknown");
    expect(normalizeChildStatus("2")).toBe("approved");
    expect(normalizeChildStatus("0")).toBe("removed");
  });
});

describe("classifyKavenegarStatus", () => {
  it("accepts exactly 200 as success", () => {
    expect(classifyKavenegarStatus(200)).toMatchObject({ ok: true, code: "ok" });
  });

  it("separates a recoverable local-id collision from a username collision", () => {
    const localid = classifyKavenegarStatus(503);
    expect(isLocalIdCollision(localid)).toBe(true);
    expect(isUsernameCollision(localid)).toBe(false);
    expect(localid.retryable).toBe(false);

    const username = classifyKavenegarStatus(502);
    expect(isUsernameCollision(username)).toBe(true);
    expect(isLocalIdCollision(username)).toBe(false);
  });

  it("treats an unknown child as not-found instead of guessing", () => {
    expect(classifyKavenegarStatus(449)).toMatchObject({ code: "not_found", retryable: false });
  });

  it("maps insufficient credit and an expired master to first-party faults", () => {
    expect(classifyKavenegarStatus(418)).toMatchObject({
      code: "insufficient_credit",
      fault: "platform_credit_exhausted",
    });
    expect(classifyKavenegarStatus(505)).toMatchObject({
      code: "parent_expired",
      fault: "service_suspended",
    });
  });

  it("retries only the genuinely transient codes", () => {
    expect(classifyKavenegarStatus(409).retryable).toBe(true);
    expect(classifyKavenegarStatus(451).retryable).toBe(true);
    expect(classifyKavenegarStatus(403).retryable).toBe(false);
  });

  it("treats a code it has never seen as transient, bounded by the queue's attempts", () => {
    expect(classifyKavenegarStatus(999)).toMatchObject({ retryable: true, code: "unknown" });
  });
});

describe("the master account's own balance (issue #902 §3, plan §9 item 4)", () => {
  // Recorded from kavenegar.com/rest.html — `account/info` answers with the
  // same envelope and puts the payload in the top-level `entries`.
  const INFO_ENTRY = {
    remaincredit: 12_450_000,
    expiredate: 1_767_225_600,
    type: "Master",
    apikey: "MASTERKEY",
  };

  it("reads the credit and expiry of whichever account the key belongs to", () => {
    const info = mapAccountInfo(INFO_ENTRY);
    expect(info).toEqual({
      remainCreditRial: 12_450_000,
      expireAtUnix: 1_767_225_600,
      type: "Master",
    });
  });

  it("keeps an unparseable or missing credit unknown rather than calling it zero", () => {
    // "The provider said zero" and "the provider said nothing I could read" are
    // opposite facts to a funding floor; collapsing the second into the first
    // would let a funded master look empty (or an empty one look funded).
    expect(mapAccountInfo({}).remainCreditRial).toBeNull();
    expect(mapAccountInfo({ remaincredit: "n/a" }).remainCreditRial).toBeNull();
    expect(mapAccountInfo({ remaincredit: "" }).remainCreditRial).toBeNull();
    // A real zero is still a zero.
    expect(mapAccountInfo({ remaincredit: 0 }).remainCreditRial).toBe(0);
    expect(mapAccountInfo({ remaincredit: "0" }).remainCreditRial).toBe(0);
  });

  it("drops the key the payload happens to echo back", () => {
    const info = mapAccountInfo(INFO_ENTRY) as unknown as Record<string, unknown>;
    expect(JSON.stringify(info)).not.toContain(INFO_ENTRY.apikey);
  });

  it("addresses account/info under the master key, never a child's", () => {
    const request = buildAccountInfoRequest({ masterApiKey: "MASTER" });
    expect(request.url).toBe("https://api.kavenegar.com/v1/MASTER/account/info.json");
    expect(request.method).toBe("GET");
    expect(request.params).toEqual({});
    // The key is in the path, so the logged form must not carry it.
    expect(redactKavenegarUrl(request.url)).not.toContain("MASTER");
  });
});

describe("request builders", () => {
  it("creates a panel-disabled child with zero credit and no parent-line access", () => {
    const request = buildAddChildAccountRequest({
      masterApiKey: "MASTER",
      localId: "business-uuid",
      username: "bm123",
      password: "Aa1secret",
      fullName: "کافه نمونه",
      planId: 1484,
      minAllowedCreditRial: 100000,
      lines: ["10004346"],
    });
    expect(request.url).toBe("https://api.kavenegar.com/v1/MASTER/client/add.json");
    expect(request.method).toBe("POST");
    expect(request.params).toMatchObject({
      localid: "business-uuid",
      Username: "bm123",
      // The provider's own (misspelled) parameter name, sent verbatim.
      Mininumallowedcredit: "100000",
      Status: "2",
      CanUseParentLines: "false",
      Planid: "1484",
      Lines: "10004346",
    });
    expect(request.params.Credit).toBeUndefined();
  });

  it("omits the plan when the master default should apply", () => {
    const request = buildAddChildAccountRequest({
      masterApiKey: "M",
      localId: "b",
      username: "u",
      password: "p",
      fullName: "n",
      minAllowedCreditRial: 0,
    });
    expect(request.params.Planid).toBeUndefined();
  });

  it("sends only the fields an identity sync names", () => {
    const request = buildUpdateChildAccountRequest({
      masterApiKey: "M",
      childApiKey: "CHILD",
      fullName: "نام تازه",
    });
    expect(request.params).toEqual({ Apikey: "CHILD", Fullname: "نام تازه" });
  });

  it("looks a child up by our stable local id", () => {
    const request = buildFetchChildByLocalIdRequest({ masterApiKey: "M", localId: "business-uuid" });
    expect(request.url).toContain("/client/fetchbylocalid.json");
    expect(request.params.Localid).toBe("business-uuid");
  });

  it("funds a child in signed Rial and can claw credit back", () => {
    const fund = buildChargeChildCreditRequest({ masterApiKey: "M", childApiKey: "C", creditRial: 25000 });
    expect(fund.params).toMatchObject({ apikey: "C", Credit: "25000" });
    const clawback = buildChargeChildCreditRequest({ masterApiKey: "M", childApiKey: "C", creditRial: -25000 });
    expect(clawback.params.Credit).toBe("-25000");
  });

  it("targets a child when rotating a key by either identifier", () => {
    expect(buildRenewChildKeyRequest({ masterApiKey: "M", childApiKey: "C" }).params).toEqual({ apikey: "C" });
    expect(buildRenewChildKeyRequest({ masterApiKey: "M", localId: "L" }).params).toEqual({ localid: "L" });
  });

  it("revises a template with the provider's required fields and the child scope", () => {
    // The documented contract for ۴. ویرایش الگو: templateId, sourceType,
    // sendMethod and name are all required; the text is what actually changes.
    const request = buildUpdateTemplateRequest({
      masterApiKey: "M",
      templateId: 12345,
      name: "bmv0d5f4c7e2e",
      childApiKey: "C",
      textMessage: "کد ورود شما %token است",
    });
    expect(request.url).toBe("https://api.kavenegar.com/v1/M/verify/updatetemplate.json");
    expect(request.method).toBe("POST");
    expect(request.params).toMatchObject({
      templateId: "12345",
      name: "bmv0d5f4c7e2e",
      sourceType: "0",
      sendMethod: "1",
      textMessage: "کد ورود شما %token است",
      apiKey: "C",
    });
    // Absent optional fields must not be sent as empty strings: the provider
    // treats a present-but-empty fallback/line as a value, not as "unchanged".
    expect(request.params.fallBackMethod).toBeUndefined();
    expect(request.params.switchTTL).toBeUndefined();
    expect(request.params.primaryLineNumber).toBeUndefined();
  });

  it("targets a child by local id on an update without leaking a key", () => {
    const request = buildUpdateTemplateRequest({
      masterApiKey: "MASTERKEY",
      templateId: 7,
      name: "bmt0011223344",
      childLocalId: "business-uuid",
      fallBackMethod: 3,
      switchTtl: 2,
    });
    expect(request.params).toMatchObject({ localId: "business-uuid", fallBackMethod: "3", switchTTL: "2" });
    expect(JSON.stringify(request.params)).not.toContain("MASTERKEY");
  });

  it("creates and lists templates for a named child", () => {
    const list = buildListTemplatesRequest({ masterApiKey: "M", childLocalId: "L", page: 2 });
    expect(list.url).toBe("https://api.kavenegar.com/v1/M/verify/templatelist.json");
    expect(list.params).toEqual({ localId: "L", page: "2" });
  });
});

describe("redactKavenegarUrl", () => {
  it("removes every secret from a provider URL", () => {
    const url =
      "https://api.kavenegar.com/v1/MASTERKEY/client/chargecredit.json?apikey=CHILDKEY&Credit=25000&localid=0d5f";
    const redacted = redactKavenegarUrl(url);
    expect(redacted).toBe(
      "https://api.kavenegar.com/v1/REDACTED/client/chargecredit.json?apikey=REDACTED&Credit=25000&localid=REDACTED",
    );
    expect(redacted).not.toContain("MASTERKEY");
    expect(redacted).not.toContain("CHILDKEY");
  });
});
