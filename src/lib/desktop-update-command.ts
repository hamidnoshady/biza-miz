import { isUuid } from "./uuid";

export const DESKTOP_UPDATE_COMMANDS = ["recheck", "download_now"] as const;
export type DesktopUpdateCommandType = (typeof DESKTOP_UPDATE_COMMANDS)[number];
export const DESKTOP_UPDATE_COMMAND_RESULTS = ["acknowledged", "executed", "verified", "failed"] as const;
export type DesktopUpdateCommandResultStatus = (typeof DESKTOP_UPDATE_COMMAND_RESULTS)[number];

export interface DesktopUpdateCommandDocument {
  schemaVersion: 1;
  id: string;
  sequence: number;
  command: DesktopUpdateCommandType;
  businessId: string;
  deviceId: string;
  issuedAt: string;
  expiresAt: string;
}

export interface DesktopUpdateCommandResult {
  id: string;
  sequence: number;
  status: DesktopUpdateCommandResultStatus;
  occurredAt: string;
  code: string | null;
}

export function validateDesktopUpdateCommandResult(value: unknown): DesktopUpdateCommandResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!isUuid(row.id) || !Number.isSafeInteger(row.sequence) || Number(row.sequence) < 1) return null;
  if (!(DESKTOP_UPDATE_COMMAND_RESULTS as readonly unknown[]).includes(row.status)) return null;
  if (typeof row.occurredAt !== "string" || !Number.isFinite(Date.parse(row.occurredAt))) return null;
  if (row.code !== null && row.code !== undefined && (typeof row.code !== "string" || row.code.length > 120)) return null;
  return {
    id: row.id,
    sequence: Number(row.sequence),
    status: row.status as DesktopUpdateCommandResultStatus,
    occurredAt: new Date(row.occurredAt).toISOString(),
    code: typeof row.code === "string" ? row.code : null,
  };
}
