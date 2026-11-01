"use client";

/**
 * Issue #903 §2 item 4 / §6 — «بازگردانی از فایل پشتیبان».
 *
 * The recovery case that has no row in the inventory: the Owner has a backup
 * file (and the manifest saved beside it), the platform may not even know the
 * backup exists any more. The file is uploaded in pieces, the server decides
 * whether it is genuinely this business's backup (`POST
 * /api/backup/restores/import`), and on success the ordinary preview card takes
 * over — importing registers a restore source, it does not restore anything.
 *
 * It is deliberately *not* a backup-management control: nothing here creates,
 * schedules, uploads-as-inventory or deletes a backup. The two file pickers are
 * the recovery pair the download endpoint hands out, and the copy says so.
 */
import { useState } from "react";
import { uploadRestoreFile } from "@/lib/restore-upload-client";
import { toPersianDigits } from "@/lib/digits";
import { Button } from "@/components/ui/button";
import { ErrorBox, Field, InfoBox, api, inputClass } from "../ui";

/** Every refusal the import route can answer with, in the Owner's words. */
export const RECOVERY_IMPORT_ERRORS: Record<string, string> = {
  recovery_file_missing: "فایل پشتیبان پیدا نشد؛ دوباره انتخاب و بارگذاری کنید.",
  recovery_manifest_unreadable: "فایل شناسنامهٔ پشتیبان خوانده نشد؛ همان فایلی را انتخاب کنید که همراه نسخه دانلود شد.",
  recovery_manifest_signature_invalid:
    "امضای شناسنامهٔ این فایل معتبر نیست؛ این فایل به‌عنوان پشتیبان این کسب‌وکار پذیرفته نمی‌شود.",
  recovery_file_not_owned_by_business: "این فایل به کسب‌وکار شما تعلق ندارد.",
  recovery_file_not_importable:
    "این نوع فایل برای بازگردانی ابری پشتیبانی نمی‌شود؛ فقط نسخه‌های منطقی همین سامانه قابل وارد‌کردن هستند.",
  recovery_file_schema_too_new: "این نسخه با نسخهٔ جدیدتری از سامانه ساخته شده است؛ ابتدا سامانه را به‌روز کنید.",
  recovery_checksum_mismatch: "محتوای فایل با چیزی که شناسنامهٔ آن تأیید می‌کند هم‌خوان نیست؛ فایل ناقص یا تغییر‌یافته است.",
  backup_encryption_unconfigured: "کلید رمزنگاری سکو در این نصب تنظیم نشده است؛ وارد‌کردن فایل ممکن نیست.",
  recovery_passphrase_required: "این فایل با عبارت عبور ساخته شده است؛ همان عبارت عبور را وارد کنید.",
  recovery_file_unreadable: "فایل باز نشد (کلید نادرست، فایل ناقص یا محتوای ناشناخته).",
  recovery_import_failed: "وارد‌کردن فایل ناموفق بود؛ هیچ تغییری در داده‌ها اعمال نشد.",
  recovery_import_unavailable: "بازگردانی از فایل روی این نصب (محلی) از مسیر بازگردانی پایگاه‌داده انجام می‌شود.",
  upload_network: "ارتباط هنگام بارگذاری قطع شد؛ دوباره تلاش کنید.",
  upload_offset: "بارگذاری نیمه‌کاره ماند؛ دوباره از ابتدا تلاش کنید.",
  upload_failed: "بارگذاری فایل ناموفق بود.",
  empty_chunk: "فایل خالی است.",
};

export function recoveryImportError(code: string): string {
  return RECOVERY_IMPORT_ERRORS[code] ?? "وارد‌کردن فایل ناموفق بود؛ هیچ تغییری در داده‌ها اعمال نشد.";
}

export function RecoveryFilePanel({
  onImported,
}: {
  /** Called with the new artifact reference, so the card can open its preview. */
  onImported: (ref: string) => Promise<void> | void;
}) {
  const [payload, setPayload] = useState<File | null>(null);
  const [manifest, setManifest] = useState<File | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imported, setImported] = useState<{ ref: string; capturedAt: string } | null>(null);

  async function run() {
    if (!payload || !manifest) return;
    setBusy(true);
    setError(null);
    setImported(null);
    try {
      const text = await manifest.text();
      if (text.length > 256 * 1024) {
        setError(RECOVERY_IMPORT_ERRORS.recovery_manifest_unreadable);
        return;
      }
      const uploaded = await uploadRestoreFile("/api/backup/restores/import/upload", payload, setProgress);
      if (!uploaded.ok) {
        setError(recoveryImportError(uploaded.error));
        return;
      }
      const res = await api<{ ref?: string; capturedAt?: string; error?: string }>("/api/backup/restores/import", {
        method: "POST",
        body: JSON.stringify({ uploadId: uploaded.uploadId, manifest: text, passphrase }),
      });
      if (!res.ok || !res.data.ref) {
        setError(recoveryImportError(res.data.error ?? ""));
        return;
      }
      setImported({ ref: res.data.ref, capturedAt: res.data.capturedAt ?? new Date().toISOString() });
      setPayload(null);
      setManifest(null);
      setPassphrase("");
      // The list now carries the uploaded copy; the preview is the next step,
      // exactly as it is for a cloud artifact. The card reloads its own rows.
      await onImported(res.data.ref);
    } catch {
      setError(RECOVERY_IMPORT_ERRORS.recovery_file_unreadable);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-2xl border border-border/80 bg-muted/30 p-4">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">بازگردانی از فایل پشتیبان</h3>
        <p className="text-sm leading-6 text-muted-foreground">
          اگر نسخه‌ای را پیش‌تر دانلود کرده‌اید، دو فایل آن را اینجا انتخاب کنید: فایل رمزنگاری‌شدهٔ نسخه و
          فایل شناسنامهٔ آن (که همراه دانلود ذخیره می‌شود). فایل ابتدا بررسی می‌شود و تنها اگر واقعاً
          پشتیبان همین کسب‌وکار باشد، به‌عنوان منبع بازگردانی ثبت می‌شود؛ این کار به‌تنهایی چیزی را بازنمی‌گرداند.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="فایل نسخهٔ پشتیبان">
          <input
            type="file"
            className={inputClass}
            disabled={busy}
            onChange={(event) => {
              setPayload(event.target.files?.[0] ?? null);
              setImported(null);
            }}
          />
        </Field>
        <Field label="فایل شناسنامه (.manifest.json)">
          <input
            type="file"
            accept=".json,application/json"
            className={inputClass}
            disabled={busy}
            onChange={(event) => {
              setManifest(event.target.files?.[0] ?? null);
              setImported(null);
            }}
          />
        </Field>
      </div>
      <Field label="عبارت عبور فایل (فقط برای نسخه‌های قدیمیِ دارای عبارت عبور)">
        <input
          type="password"
          dir="ltr"
          autoComplete="off"
          className={inputClass}
          value={passphrase}
          disabled={busy}
          onChange={(event) => setPassphrase(event.target.value)}
        />
      </Field>
      {busy && progress !== null ? (
        <p className="text-xs text-muted-foreground">
          در حال بارگذاری… {toPersianDigits(String(Math.round(progress * 100)))}٪
        </p>
      ) : null}
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {imported ? (
        <InfoBox>
          فایل پذیرفته و بررسی شد. از این پس به‌عنوان یک نسخهٔ بازگردانی در فهرست بالا دیده می‌شود؛
          پیش‌نمایش زیر می‌گوید بازگردانی چه چیزی را جایگزین می‌کند.
        </InfoBox>
      ) : null}
      <Button type="button" variant="outline" size="sm" disabled={busy || !payload || !manifest} onClick={() => void run()}>
        {busy ? "در حال بررسی…" : "بارگذاری و بررسی فایل"}
      </Button>
    </div>
  );
}
