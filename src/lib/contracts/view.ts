/**
 * Issue #908 — the wire shapes of the contract surface.
 *
 * These are declared apart from `service.ts` and `signing.ts` because a client
 * component imports them with `import type`: that erases the import at build
 * time, so the editor and the public signing page never pull the database pool,
 * `node:crypto` or the SMS provider into the browser bundle. The two service
 * modules re-export these names, so a server caller reads one shape per concept.
 */
import type {
  ContractDocumentContent,
  ContractIssue,
  ContractSignatureSlot,
} from "./blocks";

/* ===========================================================================
 * Documents
 * ======================================================================== */

export interface ContractDocumentRecord {
  id: string;
  contractId: string;
  templateId: string | null;
  content: ContractDocumentContent;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ContractDocumentVersionSummary {
  id: string;
  version: number;
  title: string;
  contentHash: string;
  frozenBy: string;
  frozenAt: string;
  /** The round that froze it, when one exists. */
  envelopeId: string | null;
}

export interface ContractTemplateChoice {
  /** `builtin:<key>` for the shipped starters, the row id for a tenant template. */
  id: string;
  name: string;
  description: string;
  contractType: string;
  builtin: boolean;
  editable: boolean;
  revision: number;
  updatedAt: string | null;
}

export interface FrozenContractVersion {
  id: string;
  version: number;
  title: string;
  content: ContractDocumentContent & { values: Record<string, string> };
  contentHash: string;
  frozenAt: string;
  frozenBy: string;
}

/**
 * One variable as the sender sees it: its value, where that value came from,
 * and — when the sender typed over a bound value — what the record still says.
 * This is the epic's "visible source lineage".
 */
export interface ResolvedFieldView {
  key: string;
  label: string;
  value: string;
  provenance: "binding" | "override" | "literal" | "empty";
  /** «طرف حساب · نام طرف حساب» when bound, `null` for a typed literal. */
  sourceLabel: string | null;
  /** The record's own value, when the sender overrode it. */
  boundValue: string | null;
  /** True when the source record no longer resolves to the value shown. */
  stale: boolean;
}

export interface ContractDocumentView {
  contract: {
    id: string;
    projectId: string | null;
    projectName: string | null;
    partyId: string | null;
    partyName: string | null;
    title: string;
    contractType: string;
    valueRial: number | null;
    startDate: string | null;
    endDate: string | null;
    status: string;
  };
  document: ContractDocumentRecord;
  template: { id: string; name: string } | null;
  /** Resolved `{{key}} → display string` for the CURRENT draft. */
  values: Record<string, string>;
  resolved: ResolvedFieldView[];
  issues: ContractIssue[];
  /** Structural findings only — what the editor can show while typing. */
  structuralIssues: ContractIssue[];
  slots: ContractSignatureSlot[];
  versions: ContractDocumentVersionSummary[];
  capabilities: {
    canEdit: boolean;
    canFreeze: boolean;
    /** False once the draft has moved past the version that was sent. */
    draftMatchesSentVersion: boolean;
    liveEnvelopeStatus: string | null;
  };
}

/* ===========================================================================
 * Signing (sender side)
 * ======================================================================== */

export const ENVELOPE_STATUSES = [
  "draft",
  "sent",
  "partially_signed",
  "completed",
  "declined",
  "cancelled",
  "expired",
] as const;
export type ContractEnvelopeStatus = (typeof ENVELOPE_STATUSES)[number];

export const SIGNER_STATUSES = [
  "pending",
  "invited",
  "opened",
  "acknowledged",
  "signed",
  "declined",
  /** Set when the sender cancels a round: the person never acted. */
  "expired",
] as const;
export type ContractSignerStatus = (typeof SIGNER_STATUSES)[number];

export const SIGNING_MODES = ["parallel", "sequential"] as const;
export type ContractSigningMode = (typeof SIGNING_MODES)[number];

export interface ContractEnvelope {
  id: string;
  contractId: string;
  documentVersionId: string;
  documentVersion: number | null;
  status: ContractEnvelopeStatus;
  signingMode: ContractSigningMode;
  expiresAt: string | null;
  sentAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string;
  createdAt: string;
}

export interface ContractSigner {
  id: string;
  fullName: string;
  roleLabel: string;
  /** «۰۹۱۲•••۴۵۶۷» — recognisable, not reusable. */
  maskedPhone: string;
  /**
   * The full number, for the sender's own screen (they typed it and may need to
   * correct it while the envelope is a draft). The public page never sees it.
   */
  phoneE164: string;
  signOrder: number;
  required: boolean;
  slotId: string;
  status: ContractSignerStatus;
  deadline: string | null;
  invitedAt: string | null;
  openedAt: string | null;
  acknowledgedAt: string | null;
  signedAt: string | null;
  declinedAt: string | null;
  declineReason: string;
  partyId: string | null;
}

export interface ContractSigningEvent {
  id: number;
  kind: string;
  label: string;
  signerId: string | null;
  signerName: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface ContractSigningOverview {
  envelope: ContractEnvelope | null;
  signers: ContractSigner[];
  events: ContractSigningEvent[];
  progress: { required: number; signed: number; complete: boolean };
  /** True when the draft text has moved on from the version that was sent. */
  draftAheadOfFrozen: boolean;
  /** The newest frozen version number, or null when nothing is frozen. */
  latestFrozenVersion: number | null;
  capabilities: { canSend: boolean; canCancel: boolean; canResend: boolean };
}

export type MessageDeliveryReason =
  | "sms_not_configured"
  | "sms_unavailable"
  | "sms_failed"
  | null;

/**
 * What actually happened to one message.
 *
 * `delivered: false` with a reason is a first-class outcome, not an error: the
 * link is valid and the sender is offered it to pass on another way. The UI must
 * never print «فرستاده شد» for one of these.
 */
export interface MessageDelivery {
  signerId: string;
  delivered: boolean;
  reason: MessageDeliveryReason;
  /** The link. Present because the sender is allowed to deliver it themselves. */
  url: string;
}

export interface SendEnvelopeResult {
  envelope: ContractEnvelope;
  version: { id: string; version: number; contentHash: string };
  deliveries: MessageDelivery[];
}

export interface SubmitSignatureResult {
  signedAt: string;
  contentHash: string;
  version: number;
  envelopeStatus: ContractEnvelopeStatus;
  completed: boolean;
}

/* ===========================================================================
 * The public signing session
 * ======================================================================== */

export type SigningSessionFailure =
  | "envelope_cancelled"
  | "envelope_declined"
  | "envelope_expired"
  | "not_live"
  | "already_signed"
  | "declined"
  | "turn_pending";

export interface SigningSessionView {
  /** What the page is showing: the flow, the receipt, or a closed-door notice. */
  state: "active" | "receipt" | "closed";
  failure: SigningSessionFailure | null;
  business: { name: string };
  contract: { title: string; signedVersion: number };
  document: {
    title: string;
    content: ContractDocumentContent;
    contentHash: string;
    version: number;
    frozenAt: string;
  };
  signer: {
    fullName: string;
    roleLabel: string;
    maskedPhone: string;
    status: ContractSignerStatus;
    acknowledged: boolean;
    signedAt: string | null;
  };
  envelope: {
    status: ContractEnvelopeStatus;
    signingMode: ContractSigningMode;
    expiresAt: string | null;
  };
  progress: { required: number; signed: number; complete: boolean };
  step: "review" | "verify" | "receipt" | "turn_pending" | "closed";
  signedAt: string | null;
  signatureHash: string | null;
}

/** The receipt a signer keeps after their own signature is recorded. */
export interface SigningReceipt {
  fullName: string;
  signedAt: string;
  contentHash: string;
  version: number;
  slots: number;
}
