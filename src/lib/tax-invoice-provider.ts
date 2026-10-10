/**
 * Issue #866 — the provider boundary of taxpayer e-invoicing.
 *
 * An adapter does two things: deliver a stored packet, and ask what became of
 * one. Both return the outcomes the pure core understands (`SendFailure`,
 * `InquiryOutcome`), so nothing above this file knows how a given authority
 * spells its errors.
 *
 * Two adapters exist:
 *
 *   - `sandboxProvider` is a deterministic simulator. It honours the uid
 *     deduplication the real protocol relies on, so a retry of a packet the
 *     authority already holds finds that packet and does not create a second
 *     one. It is for development and tests, and every record it touches says so
 *     («آزمایشی»). It never talks to the network.
 *
 *   - `liveProvider` fails closed by default. The opt-in transport requires a reviewed codec. The
 *     Moodian protocol signs each request and encrypts the packet with keys issued
 *     to the taxpayer's own certificate. Until that is implemented and checked
 *     against the authority's sandbox, a production record fails permanently with
 *     `live_provider_unavailable` rather than sending something half-correct.
 */
import { randomUUID } from "node:crypto";
import { MoodianTaxProvider, type MoodianCodec } from "./tax-invoice-moodian";
import type { TaxEnvironment } from "./tax-invoice";
import type { InquiryOutcome, ProviderIssue, SendFailure, TaxPayloadV1 } from "./tax-invoice-core";

/** The taxpayer's secrets, decrypted in memory for one call and never stored in clear. */
export interface TaxCredentials {
  /** The private material for signing, or the token the intermediary issues. */
  secret?: string;
  /** A certificate chain the authority can verify the signature against. */
  certificatePem?: string;
  /** Platform/TSP callback contract only; never reused as a signing private key. */
  webhookSecret?: string;
  /** GET_TOKEN username for a trusted service provider, not the taxpayer id. */
  tspUsername?: string;
}

export interface TaxSubmitRequest {
  uid: string;
  reference: string;
  environment: TaxEnvironment;
  /** The stored snapshot, sent exactly as it was prepared. Never rebuilt. */
  payload: TaxPayloadV1;
  credentials: TaxCredentials | null;
  retry?: boolean;
}

export interface TaxInquiryRequest {
  uid: string;
  reference: string;
  receiptId: string | null;
  environment: TaxEnvironment;
  credentials: TaxCredentials | null;
  /** From the stored submission snapshot, never current settings. */
  memoryId?: string;
  submissionMode?: "direct" | "tsp";
}

/** Thrown by an adapter with the classified failure; the service applies the policy. */
export class TaxProviderFailure extends Error {
  constructor(readonly failure: SendFailure) {
    super(failure.kind === "rejected" ? "provider_rejected" : failure.code);
    this.name = "TaxProviderFailure";
  }
}

export interface TaxProviderAdapter {
  readonly provider: "sandbox" | "moodian";
  submit(request: TaxSubmitRequest): Promise<{ receiptId: string }>;
  inquire(request: TaxInquiryRequest): Promise<InquiryOutcome>;
}

// ---------------------------------------------------------------------------
// The sandbox simulator
// ---------------------------------------------------------------------------

export interface SandboxScript {
  /** Failures to return from the next submits, in order. Tests use this to force timeouts and refusals. */
  submitFailures?: SendFailure[];
  /** Outcomes to return from the next inquiries, in order, before the simulator's own answer. */
  inquiryOutcomes?: InquiryOutcome[];
  /** How many inquiries a received packet stays `processing` before its outcome is known. */
  processingPolls?: number;
}

interface SandboxPacket {
  uid: string;
  receiptId: string;
  inquiries: number;
  issues: ProviderIssue[];
}

/** Checks the authority applies that a payload can fail. Mirrors the rules the core already enforces, plus the link rule. */
function sandboxValidate(payload: TaxPayloadV1): ProviderIssue[] {
  const issues: ProviderIssue[] = [];
  if (payload.kind !== "sale" && !payload.parent) {
    issues.push({ code: "parent_missing", message: "اصلاح یا ابطال باید به صورتحساب پذیرفته‌شده اشاره کند.", field: "parent" });
  }
  if (payload.kind === "sale" && payload.parent) {
    issues.push({ code: "parent_unexpected", message: "صدور اصلی نباید به صورتحساب دیگری اشاره کند.", field: "parent" });
  }
  for (const line of payload.lines) {
    if (!/^[0-9]{13}$/.test(line.taxCode)) {
      issues.push({ code: "item_code_invalid", message: `شناسه کالای «${line.name}» معتبر نیست.`, field: `lines[${line.no}].taxCode` });
    }
  }
  return issues;
}

/**
 * The simulator. Packets are keyed by uid, exactly as the authority keys them:
 * a second submit under a known uid returns the first receipt and records
 * nothing new. A submit that fails before delivery records nothing; one that
 * fails as `unknown_delivery` is recorded as received, because that is the case
 * the protocol must survive: the sender cannot tell the two apart.
 */
export class SandboxTaxProvider implements TaxProviderAdapter {
  readonly provider = "sandbox" as const;
  private readonly packets = new Map<string, SandboxPacket>();
  private readonly receipts = new Map<string, string>();
  private readonly script: Required<Omit<SandboxScript, "submitFailures" | "inquiryOutcomes">> & SandboxScript;

  constructor(script: SandboxScript = {}) {
    this.script = { processingPolls: 1, ...script, submitFailures: [...(script.submitFailures ?? [])], inquiryOutcomes: [...(script.inquiryOutcomes ?? [])] };
  }

  /** Test helper: the number of distinct packets the simulated authority holds. */
  get packetCount(): number {
    return this.packets.size;
  }

  async submit(request: TaxSubmitRequest): Promise<{ receiptId: string }> {
    const known = this.packets.get(request.uid);
    if (known) return { receiptId: known.receiptId };

    const scripted = this.script.submitFailures?.shift();
    if (scripted) {
      if (scripted.kind === "unknown_delivery") this.receive(request.uid, request.payload);
      throw new TaxProviderFailure(scripted);
    }

    return { receiptId: this.receive(request.uid, request.payload) };
  }

  async inquire(request: TaxInquiryRequest): Promise<InquiryOutcome> {
    const scripted = this.script.inquiryOutcomes?.shift();
    if (scripted) return scripted;

    const packet = this.packets.get(request.uid);
    if (!packet) return { state: "not_found" };
    packet.inquiries += 1;
    if (packet.inquiries <= this.script.processingPolls) {
      return { state: "processing", receiptId: packet.receiptId };
    }
    if (packet.issues.length > 0) return { state: "rejected", issues: packet.issues };
    return { state: "accepted", receiptId: packet.receiptId };
  }

  private receive(uid: string, payload: TaxPayloadV1): string {
    const receiptId = randomUUID();
    this.packets.set(uid, { uid, receiptId, inquiries: 0, issues: sandboxValidate(payload) });
    this.receipts.set(receiptId, uid);
    return receiptId;
  }
}

// ---------------------------------------------------------------------------
// The production adapter, until it is built
// ---------------------------------------------------------------------------

class UnavailableTaxProvider implements TaxProviderAdapter {
  readonly provider = "moodian" as const;

  async submit(): Promise<{ receiptId: string }> {
    throw new TaxProviderFailure({
      kind: "permanent",
      code: "live_provider_unavailable",
      message: "ارسال زنده به سامانه مودیان هنوز فعال نشده است. از محیط آزمایشی استفاده کنید.",
    });
  }

  async inquire(): Promise<InquiryOutcome> {
    return {
      state: "unreachable",
      code: "live_provider_unavailable",
      message: "استعلام زنده از سامانه مودیان هنوز فعال نشده است.",
    };
  }
}

/** One simulator per process: the simulated authority outlives a single tick, as the real one does. */
let sandboxSingleton: SandboxTaxProvider | null = null;

export function sandboxProvider(): SandboxTaxProvider {
  sandboxSingleton ??= new SandboxTaxProvider();
  return sandboxSingleton;
}

let liveProviderSingleton: TaxProviderAdapter = new UnavailableTaxProvider();

/** Server bootstrap only. An env flag alone cannot activate an unverified signer. */
export function installVerifiedMoodianCodec(codec: MoodianCodec): void {
  if (process.env.TAX_MOODIAN_TRANSPORT_ENABLED !== "true" || !codec.verificationReference.trim()) {
    throw new Error("moodian_transport_not_approved");
  }
  liveProviderSingleton = new MoodianTaxProvider({ enabled: true, codec });
}

/** The adapter a profile's environment selects. Production never falls back to the simulator. */
export function providerFor(environment: TaxEnvironment): TaxProviderAdapter {
  return environment === "sandbox" ? sandboxProvider() : liveProviderSingleton;
}
