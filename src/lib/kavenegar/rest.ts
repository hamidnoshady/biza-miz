/**
 * Issue #902 — Kavenegar customer-management, the *network* half.
 *
 * `client.ts` builds the requests and classifies the replies; this file owns
 * the only `fetch`, the timeouts and the error object that a service layer is
 * allowed to see. The split exists so every adapter variant can be exercised
 * against recorded fixtures with no live provider and no network.
 *
 * Two semantics matter more than the method list:
 *
 *   * **A POST that never got an answer is `ambiguous`, not failed.** The
 *     provider may have created the child (or moved the credit) and lost the
 *     response. Callers reconcile with a GET before they retry a POST — that
 *     is what stops a timed-out `client/add` from becoming a duplicate account
 *     and a timed-out `chargecredit` from moving money twice.
 *   * **Nothing in an error carries the credential.** The key lives in the URL
 *     path, so every URL is redacted before it reaches `operatorUrl`.
 */
import {
  type AddChildAccountInput,
  type AddTemplateInput,
  buildAddChildAccountRequest,
  buildAddTemplateRequest,
  buildChargeChildCreditRequest,
  buildCloneTemplateRequest,
  buildDeleteTemplateRequest,
  buildFetchChildByLocalIdRequest,
  buildFetchChildRequest,
  buildGetTemplateRequest,
  buildListChildrenRequest,
  buildListTemplatesRequest,
  buildLookupSendRequest,
  buildRenewChildKeyRequest,
  buildSetChildStatusRequest,
  buildUpdateChildAccountRequest,
  buildUpdateTemplateRequest,
  classifyKavenegarStatus,
  type KavenegarChildAccount,
  type KavenegarClassification,
  type KavenegarEnvelope,
  type KavenegarErrorCode,
  type KavenegarRequest,
  type KavenegarTemplate,
  mapChildAccount,
  mapLookupEntry,
  mapTemplate,
  type LookupSendInput,
  type LookupSendResult,
  parseKavenegarEnvelope,
  redactKavenegarUrl,
  type UpdateChildAccountInput,
  type UpdateTemplateInput,
} from "./client";

export interface KavenegarTransportRequest {
  url: string;
  method: "GET" | "POST";
  params: Record<string, string>;
  timeoutMs: number;
}

export interface KavenegarTransportResponse {
  status: number;
  body: string;
}

export type KavenegarTransport = (
  request: KavenegarTransportRequest,
) => Promise<KavenegarTransportResponse>;

export interface KavenegarClientOptions {
  transport?: KavenegarTransport;
  timeoutMs?: number;
  /** Automatic retries for idempotent GETs. POSTs are never retried here. */
  getRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class KavenegarTransportError extends Error {
  /** True when the request may have been applied by the provider. */
  readonly ambiguous: boolean;
  readonly timeout: boolean;

  constructor(message: string, options: { ambiguous: boolean; timeout: boolean }) {
    super(message);
    this.name = "KavenegarTransportError";
    this.ambiguous = options.ambiguous;
    this.timeout = options.timeout;
  }
}

export class KavenegarManagementError extends Error {
  readonly classification: KavenegarClassification;
  /**
   * The provider's numeric status (`return.status`), when the failure came from
   * a parsed envelope. Kept for the privileged adapter's own decisions — e.g.
   * `602` means "template name exists", which the template sync adopts. It is
   * never rendered to a tenant and never stored unclassified.
   */
  readonly providerStatus: number | null;
  /** Redacted request URL — never the credential. */
  readonly operatorUrl: string;
  /** The provider's own message, kept for the operator log only. */
  readonly providerMessage: string;

  constructor(input: {
    classification: KavenegarClassification;
    operatorUrl: string;
    providerMessage: string;
    providerStatus?: number | null;
  }) {
    super(input.classification.operatorMessage);
    this.name = "KavenegarManagementError";
    this.classification = input.classification;
    this.providerStatus = input.providerStatus ?? null;
    this.operatorUrl = input.operatorUrl;
    this.providerMessage = input.providerMessage;
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;

const defaultTransport: KavenegarTransport = async (request) => {
  const url = new URL(request.url);
  let body: string | undefined;
  if (request.method === "GET") {
    for (const [key, value] of Object.entries(request.params)) url.searchParams.set(key, value);
  } else {
    body = new URLSearchParams(request.params).toString();
  }
  const response = await fetch(url, {
    method: request.method,
    headers: body ? { "content-type": "application/x-www-form-urlencoded" } : undefined,
    body,
    signal: AbortSignal.timeout(request.timeoutMs),
  });
  const text = await response.text();
  return { status: response.status, body: text };
};

/**
 * The privileged adapter for the customer-management API. One instance holds
 * the master key; it is never serialised, logged or returned.
 */
export class KavenegarManagementClient {
  private readonly transport: KavenegarTransport;
  private readonly timeoutMs: number;
  private readonly getRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly masterApiKey: string,
    options: KavenegarClientOptions = {},
  ) {
    this.transport = options.transport ?? defaultTransport;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.getRetries = options.getRetries ?? 2;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  addChild(input: Omit<AddChildAccountInput, "masterApiKey">): Promise<KavenegarChildAccount> {
    return this.call(buildAddChildAccountRequest({ ...input, masterApiKey: this.masterApiKey }), mapChildAccount, {
      retries: 0,
    }).then(first);
  }

  updateChild(input: Omit<UpdateChildAccountInput, "masterApiKey">): Promise<KavenegarChildAccount> {
    return this.call(
      buildUpdateChildAccountRequest({ ...input, masterApiKey: this.masterApiKey }),
      mapChildAccount,
      { retries: 0 },
    ).then(first);
  }

  fetchChild(childApiKey: string): Promise<KavenegarChildAccount> {
    return this.call(buildFetchChildRequest({ masterApiKey: this.masterApiKey, childApiKey }), mapChildAccount).then(
      first,
    );
  }

  fetchChildByLocalId(localId: string): Promise<KavenegarChildAccount> {
    return this.call(
      buildFetchChildByLocalIdRequest({ masterApiKey: this.masterApiKey, localId }),
      mapChildAccount,
    ).then(first);
  }

  listChildren(): Promise<KavenegarChildAccount[]> {
    return this.call(buildListChildrenRequest({ masterApiKey: this.masterApiKey }), mapChildAccount).then(
      (envelope) => envelope.entries,
    );
  }

  setChildStatus(childApiKey: string, status: string): Promise<KavenegarChildAccount> {
    return this.call(
      buildSetChildStatusRequest({ masterApiKey: this.masterApiKey, childApiKey, status }),
      mapChildAccount,
      { retries: 0 },
    ).then(first);
  }

  renewChildKey(input: { childApiKey?: string; localId?: string }): Promise<KavenegarChildAccount> {
    return this.call(
      buildRenewChildKeyRequest({ ...input, masterApiKey: this.masterApiKey }),
      mapChildAccount,
      { retries: 0 },
    ).then(first);
  }

  chargeChildCredit(input: {
    childApiKey: string;
    creditRial: number;
    description?: string;
    vat?: boolean;
  }): Promise<KavenegarChildAccount> {
    return this.call(
      buildChargeChildCreditRequest({ ...input, masterApiKey: this.masterApiKey }),
      mapChildAccount,
      { retries: 0 },
    ).then(first);
  }

  listTemplates(input: { childApiKey?: string; childLocalId?: string; page?: number } = {}): Promise<{
    templates: KavenegarTemplate[];
    totalCount: number | null;
    totalPages: number | null;
  }> {
    return this.call(
      buildListTemplatesRequest({ ...input, masterApiKey: this.masterApiKey }),
      mapTemplate,
    ).then((envelope) => ({
      templates: envelope.entries,
      totalCount: numeric(envelope.metadata.TotalCount),
      totalPages: numeric(envelope.metadata.TotalPages),
    }));
  }

  /**
   * Revise a template the provider already holds.
   *
   * A POST, so a transport failure is AMBIGUOUS and never retried here: the
   * caller records `outcome_unknown` and the next sync resolves it from the
   * provider's own copy (same rule as `addtemplate`).
   */
  updateTemplate(input: Omit<UpdateTemplateInput, "masterApiKey">): Promise<KavenegarTemplate> {
    return this.call(
      buildUpdateTemplateRequest({ ...input, masterApiKey: this.masterApiKey }),
      mapTemplate,
      { retries: 0 },
    ).then(first);
  }

  addTemplate(input: Omit<AddTemplateInput, "masterApiKey">): Promise<KavenegarTemplate> {
    return this.call(
      buildAddTemplateRequest({ ...input, masterApiKey: this.masterApiKey }),
      mapTemplate,
      { retries: 0 },
    ).then(first);
  }

  getTemplate(input: {
    templateId: number;
    childApiKey?: string;
    childLocalId?: string;
  }): Promise<KavenegarTemplate> {
    return this.call(
      buildGetTemplateRequest({ ...input, masterApiKey: this.masterApiKey }),
      mapTemplate,
    ).then(first);
  }

  cloneTemplate(input: {
    newTemplateName: string;
    sourceTemplateId?: number;
    sourceTemplateName?: string;
    childApiKey?: string;
    childLocalId?: string;
  }): Promise<KavenegarTemplate> {
    return this.call(
      buildCloneTemplateRequest({ ...input, masterApiKey: this.masterApiKey }),
      mapTemplate,
      { retries: 0 },
    ).then(first);
  }

  async deleteTemplate(input: { templateId: number; childApiKey?: string; childLocalId?: string }): Promise<void> {
    await this.call(
      buildDeleteTemplateRequest({ ...input, masterApiKey: this.masterApiKey }),
      (raw) => raw,
      { retries: 0 },
    );
  }

  /**
   * Issue #902 §5 — send one approved lookup message from a child account.
   *
   * Authenticated by the child's key in the URL, so this is the one call in this
   * class that does not involve the master account at all: the message leaves the
   * business's own account and is paid for out of its provider credit.
   *
   * A POST, so a transport failure is AMBIGUOUS and never retried here. The
   * caller must treat `KavenegarTransportError.ambiguous` as "unknown outcome":
   * the platform's money is reserved rather than refunded, because the provider
   * may well have sent the message.
   */
  sendLookup(input: LookupSendInput): Promise<LookupSendResult> {
    return this.call(buildLookupSendRequest(input), mapLookupEntry, { retries: 0 }).then(first);
  }

  private async call<T>(
    request: KavenegarRequest,
    mapEntry: (raw: Record<string, unknown>) => T,
    options: { retries?: number } = {},
  ): Promise<KavenegarEnvelope<T>> {
    const retries = options.retries ?? (request.method === "GET" ? this.getRetries : 0);
    const operatorUrl = redactKavenegarUrl(request.url);
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (attempt > 0) await this.sleep(Math.min(500 * 2 ** (attempt - 1), 4_000));
      try {
        const response = await this.transport({
          url: request.url,
          method: request.method,
          params: request.params,
          timeoutMs: this.timeoutMs,
        });

        const envelope = parseKavenegarEnvelope(response.body, mapEntry);
        const classification = classifyKavenegarStatus(envelope.status);
        if (!classification.ok) {
          throw new KavenegarManagementError({
            classification,
            operatorUrl,
            providerMessage: envelope.message,
            providerStatus: envelope.status,
          });
        }
        return envelope;
      } catch (error) {
        if (error instanceof KavenegarManagementError) {
          // A retryable provider status on an idempotent GET may be retried;
          // anything else is the caller's decision.
          if (classificationRetryable(error) && request.method === "GET" && attempt < retries) {
            lastError = error;
            continue;
          }
          throw error;
        }
        const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        const transportError = new KavenegarTransportError(
          timeout ? "provider request timed out" : "provider request failed",
          // GETs are read-only; a POST may have been applied before the
          // connection broke, so its outcome is unknown.
          { ambiguous: request.method === "POST", timeout },
        );
        if (request.method === "GET" && attempt < retries) {
          lastError = transportError;
          continue;
        }
        throw transportError;
      }
    }

    throw lastError instanceof Error ? lastError : new KavenegarTransportError("provider request failed", {
      ambiguous: request.method === "POST",
      timeout: false,
    });
  }
}

/**
 * Issue #902 §5 — the child-side sending seam.
 *
 * `sendLookup` is the only provider call that must run on a business's own key,
 * and the send service is the one that knows which child an account maps to.
 * Rather than have that service construct a privileged adapter it has no
 * business holding, sending goes through this function: a default that posts to
 * the provider, or an injected executor in tests.
 */
export type LookupSendExecutor = (input: LookupSendInput) => Promise<LookupSendResult>;

export type LookupSendExecutorOptions = {
  transport?: KavenegarTransport;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

export async function executeLookupSend(
  input: LookupSendInput,
  options: LookupSendExecutorOptions = {},
): Promise<LookupSendResult> {
  const client = new KavenegarManagementClient(input.apiKey, options);
  return client.sendLookup(input);
}

function classificationRetryable(error: KavenegarManagementError): boolean {
  return error.classification.retryable;
}

function first<T>(envelope: KavenegarEnvelope<T>): T {
  const entry = envelope.entries[0];
  if (!entry) throw new KavenegarManagementError({
    classification: {
      ok: false,
      retryable: false,
      code: "unknown" as KavenegarErrorCode,
      fault: "unknown",
      operatorMessage: "provider: succeeded without an entry",
    },
    operatorUrl: "redacted",
    providerMessage: envelope.message,
  });
  return entry;
}

function numeric(value: string | undefined): number | null {
  if (value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
