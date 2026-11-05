import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { formatJalali } from "@/lib/jalali";
import { verifyFinalContractPdfToken } from "@/lib/contracts/final-pdf-verification";
import { toPersianDigits } from "@/lib/digits";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "بررسی اصالت قرارداد",
  description: "بررسی اثر انگشت فایل PDF و نسخهٔ امضاشدهٔ قرارداد",
  robots: { index: false, follow: false },
};

export default async function ContractVerificationPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const verified = await verifyFinalContractPdfToken(token);
  if (!verified) notFound();

  return (
    <main dir="rtl" className="min-h-dvh bg-background px-4 py-10 text-foreground">
      <article className="mx-auto w-full max-w-2xl rounded-2xl border border-border bg-card p-6 sm:p-10">
        <p className="text-xs font-semibold text-emerald-700 dark:text-emerald-300">اصالت نسخه تأیید شد</p>
        <h1 className="mt-2 text-xl font-semibold">بررسی نسخهٔ نهایی قرارداد</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          این گواهی به یک نسخهٔ ثابت و تکمیل‌شدهٔ پاکت امضا اشاره می‌کند. هیچ نام یا اطلاعات تماس امضاکننده‌ای در این صفحه نمایش داده نمی‌شود.
        </p>
        <dl className="mt-6 grid gap-4 text-sm">
          <div>
            <dt className="text-muted-foreground">شمارهٔ نسخه</dt>
            <dd className="font-medium">{toPersianDigits(verified.version)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">امضاهای ثبت‌شده</dt>
            <dd className="font-medium">{toPersianDigits(verified.signatureCount)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">زمان تکمیل پاکت</dt>
            <dd className="font-medium">{formatJalali(verified.completedAt, { withTime: true })}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">SHA-256 محتوای امضاشده</dt>
            <dd dir="ltr" className="mt-1 break-all rounded-lg bg-muted p-3 font-mono text-xs">{verified.contentHash}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">SHA-256 فایل PDF بایگانی‌شده</dt>
            <dd dir="ltr" className="mt-1 break-all rounded-lg bg-muted p-3 font-mono text-xs">{verified.pdfSha256}</dd>
          </div>
        </dl>
        <p className="mt-6 text-xs text-muted-foreground">
          برای تطبیق فایل در اختیار خود، اثر انگشت فایل PDF را با مقدار بالا مقایسه کنید.
          زمان ایجاد فایل بایگانی‌شده: {formatJalali(verified.generatedAt, { withTime: true })}.
        </p>
      </article>
    </main>
  );
}
