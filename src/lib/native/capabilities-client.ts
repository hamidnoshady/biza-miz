/**
 * High-level native capability helpers with browser/PWA fallbacks (issue #884).
 *
 * Every helper here talks to the Android wrapper through the allowlisted v3
 * `NativeRequest` bridge when available, and degrades cleanly to standard web
 * APIs when running in a browser or an older Android build.
 *
 * Security invariants:
 * - Client-side biometric unlock NEVER mints a session on its own; the server
 *   session and `native_app_devices` revocation state remain authoritative.
 * - Deep links are restricted to single-slash relative in-app paths and verify
 *   tenant context (`businessId`) before navigating.
 * - Media files picked natively are validated for MIME type and size (<= 20 MB)
 *   and converted to `File` objects for the canonical `/api/media` uploader.
 * - Caller ID cache entries and background sync state are strictly partitioned
 *   by `businessId` and wiped on sign-out or tenant switch.
 */
import { NativeBridgeError } from "./bridge";
import type {
  NativeBarcodeFormat,
  NativeBiometricAuthResult,
  NativeBiometricStatus,
  NativeCallerIdStatus,
  NativeCallerIdSyncResult,
  NativeMediaPickResult,
  NativeNotificationChannel,
  NativeNotificationRegistration,
  NativePickedMediaFile,
  NativeScannerResult,
  NativeShareResult,
  NativeSyncStatus,
  NativeSyncTriggerResult,
} from "./bridge-contract";
import { NATIVE_NOTIFICATION_CHANNELS } from "./bridge-contract";
import type { NativeRequest } from "@/components/native/native-provider";

export const MAX_NATIVE_MEDIA_BYTES = 20 * 1024 * 1024;

export const ALLOWED_NATIVE_MEDIA_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "application/pdf",
  "text/csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

/**
 * Normalizes Iranian and international phone numbers to a canonical E.164-like
 * form so Android `CallScreeningService` and the web CRM lookup always agree.
 * Converts Persian/Arabic-Indic digits before stripping formatting.
 */
export function normalizeCallerPhone(raw: string): string {
  const digitsMapped = raw
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .trim();

  const hasLeadingPlus = digitsMapped.startsWith("+");
  const digitsOnly = digitsMapped.replace(/\D/g, "");
  if (!digitsOnly) return "";

  if (digitsOnly.startsWith("0098") && digitsOnly.length >= 12) {
    return `+98${digitsOnly.slice(4)}`;
  }
  if (digitsOnly.startsWith("98") && digitsOnly.length === 12) {
    return `+${digitsOnly}`;
  }
  if (digitsOnly.startsWith("09") && digitsOnly.length === 11) {
    return `+98${digitsOnly.slice(1)}`;
  }
  if (digitsOnly.startsWith("0") && digitsOnly.length === 11) {
    return `+98${digitsOnly.slice(1)}`;
  }
  if ( digitsOnly.length === 10 && digitsOnly.startsWith("9")) {
    return `+98${digitsOnly}`;
  }
  if (hasLeadingPlus && digitsOnly.length >= 7 && digitsOnly.length <= 15) {
    return `+${digitsOnly}`;
  }
  return digitsOnly.length >= 4 ? digitsOnly : "";
}

/**
 * Validates and normalizes an incoming App Link or push notification deep link.
 * Rejects external origins, protocol-relative URLs, control characters, and
 * cross-tenant navigation attempts.
 */
export function validateTenantDeepLink(input: {
  path: string;
  activeBusinessId: string | null;
  targetBusinessId?: string | null;
}): { allowed: boolean; path: string | null; reason?: "invalid_path" | "tenant_mismatch" } {
  const trimmed = input.path.trim();
  if (
    !trimmed.startsWith("/") ||
    trimmed.startsWith("//") ||
    trimmed.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(trimmed)
  ) {
    return { allowed: false, path: null, reason: "invalid_path" };
  }

  if (
    input.targetBusinessId &&
    input.activeBusinessId &&
    input.targetBusinessId !== input.activeBusinessId
  ) {
    return { allowed: false, path: null, reason: "tenant_mismatch" };
  }

  return { allowed: true, path: trimmed };
}

export async function getNativeBiometricStatus(
  request: NativeRequest,
): Promise<NativeBiometricStatus> {
  try {
    return await request("biometric.status");
  } catch {
    const webAuthnAvailable =
      typeof globalThis !== "undefined" &&
      typeof (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential === "function";
    return {
      available: webAuthnAvailable,
      enrolled: webAuthnAvailable,
      strength: webAuthnAvailable ? "strong" : "none",
      credentialManagerAvailable: webAuthnAvailable,
    };
  }
}

export async function authenticateWithNativeBiometric(
  request: NativeRequest,
  options: {
    title?: string;
    subtitle?: string;
    allowDeviceCredential?: boolean;
    challengeId?: string;
  } = {},
): Promise<NativeBiometricAuthResult> {
  return request("biometric.authenticate", {
    title: options.title ?? "تأیید هویت بیزا میز",
    subtitle: options.subtitle ?? "برای ادامه، هویت خود را تأیید کنید",
    allowDeviceCredential: options.allowDeviceCredential ?? true,
    ...(options.challengeId ? { challengeId: options.challengeId } : {}),
  });
}

export async function registerNativePushNotifications(
  request: NativeRequest,
  channels: readonly NativeNotificationChannel[] = NATIVE_NOTIFICATION_CHANNELS,
): Promise<NativeNotificationRegistration> {
  try {
    return await request("notifications.register", {
      promptIfNeeded: true,
      channels: [...channels],
    });
  } catch (err) {
    if (err instanceof NativeBridgeError && err.code === "bridge_version_too_old") {
      const status = await request("notifications.status");
      return {
        permission: status.permission,
        fcmToken: null,
        channels: [],
        pushProvider: "none",
      };
    }
    throw err;
  }
}

export async function scanWithNativeScanner(
  request: NativeRequest,
  options: {
    formats?: readonly NativeBarcodeFormat[];
    prompt?: string;
  } = {},
): Promise<NativeScannerResult> {
  return request("scanner.scan", {
    ...(options.formats ? { formats: [...options.formats] } : {}),
    ...(options.prompt ? { prompt: options.prompt } : {}),
  });
}

export function validatePickedMediaFile(
  file: NativePickedMediaFile,
): { valid: true } | { valid: false; reason: "invalid_mime" | "file_too_large" | "empty_file" } {
  if (!ALLOWED_NATIVE_MEDIA_MIMES.has(file.mimeType.toLowerCase())) {
    return { valid: false, reason: "invalid_mime" };
  }
  if (file.sizeBytes <= 0 || file.base64Data.length === 0) {
    return { valid: false, reason: "empty_file" };
  }
  if (file.sizeBytes > MAX_NATIVE_MEDIA_BYTES) {
    return { valid: false, reason: "file_too_large" };
  }
  return { valid: true };
}

export function pickedMediaFileToBrowserFile(picked: NativePickedMediaFile): File {
  const binary = atob(picked.base64Data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new File([bytes], picked.name, { type: picked.mimeType });
}

export async function pickNativeMediaFiles(
  request: NativeRequest,
  options: {
    mode: "camera" | "document" | "gallery";
    multiple?: boolean;
    acceptMimeTypes?: string[];
  },
): Promise<NativeMediaPickResult> {
  return request("media.pick", {
    mode: options.mode,
    multiple: options.multiple ?? false,
    acceptMimeTypes: options.acceptMimeTypes ?? ["image/jpeg", "image/png", "image/webp", "application/pdf"],
  });
}

export async function shareViaNativeOrWeb(
  request: NativeRequest,
  payload: {
    title: string;
    text?: string;
    url?: string;
    fileBase64?: string;
    fileName?: string;
    mimeType?: string;
  },
): Promise<NativeShareResult> {
  try {
    return await request("share.open", {
      title: payload.title,
      ...(payload.text ? { text: payload.text } : {}),
      ...(payload.url ? { url: payload.url } : {}),
      ...(payload.fileBase64 ? { fileBase64: payload.fileBase64 } : {}),
      ...(payload.fileName ? { fileName: payload.fileName } : {}),
      ...(payload.mimeType ? { mimeType: payload.mimeType } : {}),
    });
  } catch {
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      try {
        await navigator.share({
          title: payload.title,
          text: payload.text,
          url: payload.url,
        });
        return { shared: true, target: "web_share" };
      } catch {
        return { shared: false, target: null };
      }
    }
    if (
      typeof navigator !== "undefined" &&
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === "function"
    ) {
      const copyText = [payload.title, payload.text, payload.url].filter(Boolean).join("\n");
      if (copyText) {
        await navigator.clipboard.writeText(copyText);
        return { shared: true, target: "clipboard" };
      }
    }
    return { shared: false, target: null };
  }
}

export interface CallerIdLookupEntry {
  customerId: string;
  displayName: string;
  phoneNormalized: string;
  organizationName: string | null;
  tags: string[];
}

export async function getNativeCallerIdStatus(
  request: NativeRequest,
  businessId: string,
): Promise<NativeCallerIdStatus> {
  try {
    return await request("crm.callerId.status", { businessId });
  } catch {
    return {
      roleHeld: false,
      supported: false,
      cachedCustomerCount: 0,
      businessId,
      lastSyncedAt: null,
    };
  }
}

export async function syncNativeCallerIdCache(
  request: NativeRequest,
  options: {
    businessId: string;
    requestRole?: boolean;
    lookupPhone?: string;
    customers: Array<{
      id: string;
      name: string;
      phone: string;
      organizationName?: string | null;
      tags?: string[];
    }>;
  },
): Promise<NativeCallerIdSyncResult> {
  const entries: CallerIdLookupEntry[] = [];
  for (const customer of options.customers) {
    const phoneNormalized = normalizeCallerPhone(customer.phone);
    if (!phoneNormalized) continue;
    entries.push({
      customerId: customer.id,
      displayName: customer.name.slice(0, 160),
      phoneNormalized,
      organizationName: customer.organizationName ? customer.organizationName.slice(0, 160) : null,
      tags: (customer.tags ?? []).slice(0, 8).map((t) => t.slice(0, 64)),
    });
  }
  return request("crm.callerId.sync", {
    businessId: options.businessId,
    requestRole: options.requestRole ?? false,
    ...(options.lookupPhone ? { lookupPhone: normalizeCallerPhone(options.lookupPhone) } : {}),
    entries,
  });
}

export type PostCallOutcome =
  | "answered"
  | "no_answer"
  | "busy"
  | "follow_up_needed"
  | "order_placed"
  | "support_resolved";

export const POST_CALL_OUTCOME_LABELS: Readonly<Record<PostCallOutcome, string>> = Object.freeze({
  answered: "پاسخ داده شد",
  no_answer: "بی‌پاسخ",
  busy: "اشغال / رد تماس",
  follow_up_needed: "نیازمند پیگیری",
  order_placed: "ثبت سفارش",
  support_resolved: "حل موضوع پشتیبانی",
});

export function buildPostCallActivityPayload(input: {
  customerId: string | null;
  customerName?: string | null;
  phoneNormalized: string;
  direction: "incoming" | "outgoing";
  durationSeconds: number;
  outcome: PostCallOutcome;
  note?: string;
  followUpAt?: string | null;
}) {
  const directionLabel = input.direction === "incoming" ? "تماس ورودی" : "تماس خروجی";
  const outcomeLabel = POST_CALL_OUTCOME_LABELS[input.outcome];
  const targetLabel = input.customerName?.trim() || input.phoneNormalized;
  const durationMinutes = Math.floor(input.durationSeconds / 60);
  const durationRemSeconds = input.durationSeconds % 60;
  const durationText =
    input.durationSeconds > 0
      ? `${durationMinutes > 0 ? `${durationMinutes} دقیقه و ` : ""}${durationRemSeconds} ثانیه`
      : "بدون مکالمه";

  const lines = [
    `نتیجه تماس: ${outcomeLabel}`,
    `شماره: ${input.phoneNormalized}`,
    `مدت مکالمه: ${durationText}`,
  ];
  if (input.note?.trim()) {
    lines.push(`یادداشت: ${input.note.trim()}`);
  }

  return {
    kind: "call" as const,
    title: `${directionLabel} — ${targetLabel} (${outcomeLabel})`.slice(0, 200),
    description: lines.join("\n").slice(0, 2000),
    customerId: input.customerId,
    completed: input.outcome !== "follow_up_needed",
    ...(input.followUpAt ? { dueAt: input.followUpAt } : {}),
  };
}

export async function getNativeSyncStatus(
  request: NativeRequest,
  businessId: string | null,
): Promise<NativeSyncStatus> {
  try {
    return await request("sync.status", { businessId });
  } catch {
    return {
      scheduled: false,
      networkAvailable: typeof navigator !== "undefined" ? navigator.onLine : true,
      businessId,
      pendingCount: 0,
      lastSyncedAt: null,
      revoked: false,
    };
  }
}

export async function triggerNativeBackgroundSync(
  request: NativeRequest,
  options: {
    action: "enqueue" | "immediate" | "clear_tenant" | "clear_all";
    businessId: string | null;
    pendingCount?: number;
  },
): Promise<NativeSyncTriggerResult> {
  try {
    return await request("sync.trigger", {
      action: options.action,
      businessId: options.businessId,
      pendingCount: options.pendingCount ?? 0,
    });
  } catch {
    return {
      scheduled: false,
      action: options.action,
      businessId: options.businessId,
      clearedEntries: 0,
    };
  }
}
