/**
 * Issue #984 — client-side DTOs for the ticket workspace tabs.
 *
 * These mirror the server shapes the companion services return; the panels
 * render them with Persian labels (from `@/lib/support-companion/types`,
 * which stays framework-free exactly so the browser can import it).
 */

export interface WorkspaceInstallation {
  id: string;
  locationId: string | null;
  locationName: string | null;
  displayName: string;
  generation: number;
  osBuild: string | null;
  mainVersion: string | null;
  companionVersion: string | null;
  schemaCompat: string | null;
  enrollmentState: string;
  lastContactAt: string | null;
}

export interface TicketSupportContext {
  ticketId: string;
  businessId: string;
  businessName: string;
  locationName: string | null;
  userName: string | null;
  status: string;
  priority: string;
  category: string;
  deploymentProfile: string | null;
  businessStatus: string | null;
  supportAccessPolicy: string | null;
  installations: WorkspaceInstallation[];
  latestHealth: {
    runId: string;
    state: string;
    severity: string;
    observedAt: string | null;
    receivedAt: string;
    uploadState: string;
    findingCount: number;
  } | null;
  consent: {
    id: string;
    installationId: string;
    subject: string;
    decision: string;
    grantedBy: string;
    expiresAt: string | null;
    createdAt: string;
  }[];
}

export interface DiagnosticRequestDto {
  id: string;
  businessId: string;
  ticketId: string;
  installationId: string;
  installationGeneration: number;
  initiatedBy: string;
  modules: string[];
  reason: string;
  allowedOperations: string[];
  expiresAt: string;
  state: string;
  createdAt: string;
}

export interface DiagnosticRunDto {
  id: string;
  requestId: string;
  ticketId: string;
  installationId: string;
  state: string;
  coverage: Record<string, unknown>;
  findings: unknown[];
  severityOverall: string;
  observedAt: string | null;
  receivedAt: string;
  uploadState: string;
  createdAt: string;
}

export interface RepairRecipeDto {
  recipeId: string;
  version: number;
  title: string;
  description: string;
  risk: string;
  backupPolicy: string;
  active: boolean;
}

export interface RepairRunDto {
  id: string;
  ticketId: string;
  installationId: string;
  recipeId: string;
  recipeVersion: number;
  actor: string;
  state: string;
  verification: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AssistanceSessionDto {
  id: string;
  ticketId: string;
  installationId: string;
  requestedCaps: string[];
  approvedCaps: string[];
  state: string;
  reason: string;
  leaseEpoch: number;
  leaseExpiresAt: string | null;
  endReason: string | null;
  createdAt: string;
}

export interface AccessTokenDto {
  id: string;
  ticketId: string;
  installationId: string;
  installationGeneration: number;
  fingerprint: string;
  purpose: string;
  scope: string[];
  reason: string;
  expiresAt: string;
  useCount: number;
  state: string;
  createdAt: string;
}

export interface SupportAiConversationDto {
  id: string;
  ticketId: string;
  installationId: string | null;
  modelProfile: string;
  mode: string;
  state: string;
  spendLimitRial: number;
  spendRial: number;
  createdAt: string;
}

export interface SupportAiMessageDto {
  id: string;
  role: string;
  content: string;
  createdAt: string;
}
