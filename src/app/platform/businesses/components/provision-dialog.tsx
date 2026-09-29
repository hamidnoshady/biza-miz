"use client";

/**
 * The business provisioning wizard, lifted out of the directory list body into
 * its own dialog with logical steps: identity → owner → review → handover.
 *
 * Two things changed for issue #755 and both are visible here:
 *
 * **§14 — activation, not handover.** The operator no longer types the owner's
 * password. There is no field for one. Creating the business mints a single-use
 * activation link, and this dialog's job ends at handing that link over: the
 * owner sets their own password, and the second factor and recovery codes are
 * shown to the owner at that link and never to this operator.
 *
 * **§16 — the smaller cleanups.** Review shows the industry's Persian label
 * rather than the raw `food_service` key; a missing root domain is handled by
 * falling back to this origin instead of rendering `undefined` in a URL; email
 * and mobile are validated (and their errors surfaced) before Review, not after
 * Create; and every field whose content is Latin-script data carries an explicit
 * `dir="ltr"` so the browser stops reordering addresses inside the RTL page.
 */
import { useState } from "react";
import { toast } from "sonner";
import { INDUSTRY_LABELS, Industry } from "@/lib/industries";
import { validateSubdomain } from "@/lib/slug";
import { isMobilePhone, normalizePhone } from "@/lib/phone";
import { formatJalali } from "@/lib/jalali";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { PlatformField, PlatformFormSection } from "@/components/platform/form";
import { PlatformInlineError } from "@/components/platform/states";
import { usePlatformMutation } from "../../_lib/use-platform-data";
import { platformErrorText } from "@/lib/platform-errors";
import { IndustryPicker } from "../../industry-picker";

interface ProvisionedOwner {
  email: string;
  existingLogin: boolean;
  activationRequired: boolean;
  activationToken: string | null;
  activationExpiresAt: string | null;
}

type Step = "identity" | "owner" | "review" | "handover";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Where the owner opens their activation link.
 *
 * On a routed deployment that is the business's own origin — the address the
 * operator just chose, which is also the address printed on the owner's
 * receipts, so it is the one they will recognise. On a single-origin install
 * there is no root domain to build a subdomain from, and the current origin is
 * the honest answer rather than a literal `undefined`.
 */
function activationUrl(rootDomain: string, subdomain: string, token: string): string {
  const origin =
    rootDomain && subdomain ? `https://${subdomain}.${rootDomain}` : window.location.origin;
  return `${origin}/activate/${token}`;
}

export function ProvisionDialog({
  open,
  onOpenChange,
  rootDomain,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rootDomain: string;
  onCreated: () => void;
}) {
  const [step, setStep] = useState<Step>("identity");
  const [businessName, setBusinessName] = useState("");
  const [subdomain, setSubdomain] = useState("");
  const [industry, setIndustry] = useState<Industry>("food_service");
  const [locationName, setLocationName] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [email, setEmail] = useState("");
  const [ownerPhone, setOwnerPhone] = useState("");
  const [owner, setOwner] = useState<ProvisionedOwner | null>(null);
  /**
   * Set when the address already belongs to a platform user. Creating the
   * business attaches it to that person's account, which is the normal
   * group-owner case but still an action on somebody else's identity — so the
   * first attempt is refused and the operator has to mean it.
   */
  const [confirmExistingOwner, setConfirmExistingOwner] = useState(false);

  const subdomainError = subdomain ? validateSubdomain(subdomain) : null;
  const emailError = email.trim() && !EMAIL_PATTERN.test(email.trim()) ? "invalid_email" : null;
  const phoneError =
    ownerPhone.trim() && !isMobilePhone(ownerPhone) ? "invalid_owner_phone" : null;

  const create = usePlatformMutation<
    void,
    { business?: unknown; owner?: ProvisionedOwner; error?: string }
  >("/api/platform/businesses", {
    method: "POST",
    request: () => ({
      options: {
        body: {
          businessName: businessName.trim(),
          ownerName: ownerName.trim(),
          email: email.trim().toLowerCase(),
          ownerPhone: ownerPhone.trim(),
          locationName: locationName.trim() || undefined,
          subdomain,
          industry,
          ...(confirmExistingOwner ? { confirmExistingOwner: true } : {}),
        },
      },
    }),
    errorToast: false,
    onSuccess: (data) => {
      if (data.owner) {
        setOwner(data.owner);
        setStep("handover");
        return;
      }
      // Defensive: a response without an owner block would otherwise leave the
      // dialog open on Review with no explanation.
      toast.success("کسب‌وکار ایجاد شد.");
      reset();
      onCreated();
    },
  });

  // The one refusal the wizard can resolve itself: the operator confirms the
  // address and resubmits, rather than being sent back to retype everything.
  const needsExistingOwnerConfirmation =
    create.errorText === platformErrorText("email_already_registered");

  function reset() {
    setStep("identity");
    setBusinessName("");
    setSubdomain("");
    setIndustry("food_service");
    setLocationName("");
    setOwnerName("");
    setEmail("");
    setOwnerPhone("");
    setOwner(null);
    setConfirmExistingOwner(false);
    create.reset();
  }

  function close() {
    if (create.busy) return;
    reset();
    onOpenChange(false);
  }

  const identityValid = Boolean(businessName.trim() && subdomain && !subdomainError);
  const ownerValid = Boolean(
    ownerName.trim() && email.trim() && !emailError && ownerPhone.trim() && !phoneError,
  );

  const warningLabel = ownerPhone.trim() ? normalizePhone(ownerPhone).e164 : null;

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? onOpenChange(v) : close())}>
      <DialogContent className="max-h-[92vh] w-[calc(100vw-1.5rem)] overflow-y-auto p-4 sm:max-w-lg sm:p-6">
        {step === "handover" && owner ? (
          <OwnerHandover
            owner={owner}
            businessName={businessName}
            subdomain={subdomain}
            rootDomain={rootDomain}
            onDone={() => {
              reset();
              onCreated();
            }}
          />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>ایجاد کسب‌وکار جدید</DialogTitle>
              <DialogDescription>
                {step === "identity"
                  ? "گام ۱ از ۳ — هویت و نشانی کسب‌وکار"
                  : step === "owner"
                    ? "گام ۲ از ۳ — اطلاعات مالک"
                    : "گام ۳ از ۳ — بازبینی و ایجاد"}
              </DialogDescription>
            </DialogHeader>

            {create.errorText ? (
              needsExistingOwnerConfirmation ? (
                <div className="space-y-3">
                  <PlatformInlineError>{create.errorText}</PlatformInlineError>
                  <label className="flex items-start gap-2 text-sm text-foreground">
                    <Checkbox
                      checked={confirmExistingOwner}
                      onCheckedChange={(v) => setConfirmExistingOwner(v === true)}
                      className="mt-0.5"
                    />
                    <span>
                      تأیید می‌کنم که این ایمیل به همین شخص تعلق دارد و افزودن این کسب‌وکار به حساب او
                      مورد نظر است. رمز عبور او تغییر نمی‌کند.
                    </span>
                  </label>
                </div>
              ) : (
                <PlatformInlineError>{create.errorText}</PlatformInlineError>
              )
            ) : null}

            {step === "identity" ? (
              <PlatformFormSection>
                <PlatformField label="نام کسب‌وکار" htmlFor="pv-name" required>
                  <Input id="pv-name" value={businessName} onChange={(e) => setBusinessName(e.target.value)} />
                </PlatformField>
                <PlatformField
                  label="نشانی اینترنتی (زیردامنه)"
                  htmlFor="pv-sub"
                  required
                  error={subdomainError ? platformErrorText(subdomainError) : undefined}
                  description={
                    subdomain && rootDomain && !subdomainError
                      ? `کسب‌وکار از این نشانی سرو می‌شود: https://${subdomain}.${rootDomain}`
                      : rootDomain
                        ? `نام انگلیسی کسب‌وکار؛ نشانی زیر ${rootDomain} ساخته می‌شود.`
                        : "این نصب روی دامنهٔ اختصاصی راه‌اندازی نشده است؛ کسب‌وکار با همین نشانی فعلی سرو می‌شود و بعداً می‌توان دامنه را تنظیم کرد."
                  }
                >
                  <Input
                    id="pv-sub"
                    dir="ltr"
                    value={subdomain}
                    onChange={(e) => setSubdomain(e.target.value.trim().toLowerCase())}
                    placeholder="acme"
                  />
                </PlatformField>
                <PlatformField
                  label="نوع کسب‌وکار"
                  description="سرفصل حساب‌ها، مراحل راه‌اندازی و ماژول‌ها بر اساس این انتخاب ساخته می‌شوند."
                >
                  <IndustryPicker value={industry} onChange={setIndustry} disabled={create.busy} />
                </PlatformField>
                <PlatformField label="نام شعبه" htmlFor="pv-loc" description="خالی بماند، «شعبه مرکزی» ساخته می‌شود.">
                  <Input id="pv-loc" value={locationName} onChange={(e) => setLocationName(e.target.value)} />
                </PlatformField>
              </PlatformFormSection>
            ) : null}

            {step === "owner" ? (
              <PlatformFormSection>
                <PlatformField label="نام مالک" htmlFor="pv-owner" required>
                  <Input id="pv-owner" value={ownerName} onChange={(e) => setOwnerName(e.target.value)} />
                </PlatformField>
                <PlatformField
                  label="ایمیل مالک"
                  htmlFor="pv-email"
                  required
                  error={emailError ? platformErrorText(emailError) : undefined}
                  description="این ایمیل نام کاربری مالک است. اگر از قبل حساب داشته باشد، همان حساب به این کسب‌وکار وصل می‌شود."
                >
                  <Input
                    id="pv-email"
                    type="email"
                    dir="ltr"
                    inputMode="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </PlatformField>
                <PlatformField
                  label="موبایل مالک"
                  htmlFor="pv-phone"
                  required
                  error={phoneError ? platformErrorText(phoneError) : undefined}
                  description={
                    warningLabel
                      ? `کد فعال‌سازی و کد ورود دومرحله‌ای به این شماره پیامک می‌شود: ${warningLabel}`
                      : "کد فعال‌سازی و کد ورود دومرحله‌ای به این شماره پیامک می‌شود؛ شماره‌ای را وارد کنید که فقط مالک در دست دارد."
                  }
                >
                  <Input
                    id="pv-phone"
                    type="tel"
                    dir="ltr"
                    inputMode="tel"
                    autoComplete="tel"
                    placeholder="09121234567"
                    value={ownerPhone}
                    onChange={(e) => setOwnerPhone(e.target.value)}
                  />
                </PlatformField>
                <p className="text-xs text-muted-foreground">
                  رمز عبور را شما تعیین نمی‌کنید. پس از ایجاد، یک لینک فعال‌سازی یک‌بارمصرف به مالک
                  تحویل می‌دهید تا خودش رمز عبور، ورود دومرحله‌ای و کدهای بازیابی‌اش را بسازد. او برای
                  تکمیل فعال‌سازی به کد پیامک‌شده به همین شماره هم نیاز دارد؛ آن کد را فقط مالک
                  می‌بیند، نه شما.
                </p>
              </PlatformFormSection>
            ) : null}

            {step === "review" ? (
              <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3 text-sm">
                <ReviewRow label="نام کسب‌وکار" value={businessName} />
                <ReviewRow
                  label="نشانی"
                  value={rootDomain ? `${subdomain}.${rootDomain}` : "همین نشانی فعلی"}
                  dir="ltr"
                />
                {/* The label, not the key: an operator reading `food_service` in
                    a confirmation step is being asked to approve something they
                    cannot read. */}
                <ReviewRow label="نوع" value={INDUSTRY_LABELS[industry]} />
                <ReviewRow label="شعبه" value={locationName.trim() || "شعبه مرکزی"} />
                <ReviewRow label="مالک" value={ownerName} />
                <ReviewRow label="ایمیل مالک" value={email.trim().toLowerCase()} dir="ltr" />
                <ReviewRow label="موبایل مالک" value={ownerPhone.trim()} dir="ltr" />
                <p className="pt-2 text-xs text-muted-foreground">
                  با ایجاد، سرفصل حساب‌ها ساخته می‌شود و یک لینک فعال‌سازی یک‌بارمصرف برای مالک صادر
                  می‌شود. رمز عبور مالک را نه شما و نه هیچ اپراتور دیگری تعیین یا مشاهده نمی‌کند، و
                  تکمیل فعال‌سازی به کد پیامک‌شده به موبایل مالک نیاز دارد که تنها در اختیار اوست.
                </p>
              </div>
            ) : null}

            <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="outline" onClick={close} disabled={create.busy} className="w-full sm:w-auto">
                انصراف
              </Button>
              {step === "identity" ? (
                <Button onClick={() => setStep("owner")} disabled={!identityValid} className="w-full sm:w-auto">
                  بعدی
                </Button>
              ) : step === "owner" ? (
                <>
                  <Button variant="outline" onClick={() => setStep("identity")} className="w-full sm:w-auto">
                    قبلی
                  </Button>
                  <Button onClick={() => setStep("review")} disabled={!ownerValid} className="w-full sm:w-auto">
                    بعدی
                  </Button>
                </>
              ) : (
                <>
                  <Button variant="outline" onClick={() => setStep("owner")} disabled={create.busy} className="w-full sm:w-auto">
                    قبلی
                  </Button>
                  <Button onClick={() => create.mutate()} disabled={create.busy} className="w-full sm:w-auto">
                    {create.busy ? "در حال ایجاد…" : "ایجاد و راه‌اندازی"}
                  </Button>
                </>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ReviewRow({ label, value, dir }: { label: string; value: string; dir?: "ltr" | "rtl" }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 break-all text-end text-foreground" dir={dir}>
        {value}
      </span>
    </div>
  );
}

/**
 * The end of the operator's involvement (issue #755 §14).
 *
 * What they get is a link, not a password and not a recovery code. The only
 * reason the token is shown here at all is that there is no mail transport in
 * this system, so somebody has to carry it — and a single-use, expiring link is
 * safe to carry, unlike a credential.
 *
 * Carrying it is not the same as holding the account: redemption also needs a
 * six-digit code texted to the owner's own mobile, which this dialog never sees
 * and never shows. The copy says so, because an operator who believes the link
 * is sufficient will be surprised when the owner asks what code.
 */
function OwnerHandover({
  owner,
  businessName,
  subdomain,
  rootDomain,
  onDone,
}: {
  owner: ProvisionedOwner;
  businessName: string;
  subdomain: string;
  rootDomain: string;
  onDone: () => void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [copied, setCopied] = useState(false);
  const url = owner.activationToken
    ? activationUrl(rootDomain, subdomain, owner.activationToken)
    : null;

  return (
    <>
      <DialogHeader>
        <DialogTitle>کسب‌وکار ساخته شد</DialogTitle>
        <DialogDescription>
          {owner.existingLogin
            ? `«${businessName}» ساخته شد و به حساب موجود ${owner.email} اضافه شد.`
            : `«${businessName}» ساخته شد. لینک فعال‌سازی را به مالک تحویل دهید.`}
        </DialogDescription>
      </DialogHeader>

      {owner.existingLogin ? (
        // The multi-business case: this person already has a platform login, so
        // there is nothing to activate and nothing for the operator to know.
        // Asking them to "activate" an account they have used for years would be
        // a lie, and resetting their password would be a takeover.
        <p className="text-sm text-muted-foreground">
          این ایمیل از قبل حساب کاربری داشت، پس همین‌جا تمام شد: مالک با رمز عبور فعلی خودش وارد
          می‌شود و این کسب‌وکار کنار کسب‌وکارهای دیگرش نمایش داده می‌شود. رمز عبور او تغییر نکرده و
          ما آن را نمی‌دانیم.
        </p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            این لینک <strong>یک‌بارمصرف</strong> است و تا{" "}
            {owner.activationExpiresAt ? formatJalali(owner.activationExpiresAt) : "یک هفته"} اعتبار
            دارد. مالک با باز کردن آن، با زدن دکمهٔ «ارسال کد» یک کد پیامکی به شمارهٔ خودش می‌گیرد، و
            با آن کد رمز عبور خودش را تعیین می‌کند و ورود دومرحله‌ای و کدهای بازیابی‌اش را خودش
            دریافت می‌کند — نه شما.
          </p>

          {url ? (
            <div>
              <p className="mb-1 text-sm text-muted-foreground">لینک فعال‌سازی مالک:</p>
              <p
                dir="ltr"
                className="break-all rounded-lg border border-border bg-muted px-3 py-2 font-mono text-xs"
              >
                {url}
              </p>
              <Button
                variant="ghost"
                className="mt-2"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(url);
                    setCopied(true);
                  } catch {
                    setCopied(false);
                  }
                }}
              >
                {copied ? "کپی شد" : "کپی لینک"}
              </Button>
            </div>
          ) : null}
        </>
      )}

      <label className="flex items-start gap-2 text-sm text-foreground">
        <Checkbox checked={confirmed} onCheckedChange={(v) => setConfirmed(v === true)} className="mt-0.5" />
        <span>{owner.existingLogin ? "متوجه شدم." : "این لینک را به مالک تحویل دادم."}</span>
      </label>

      <DialogFooter>
        <Button disabled={!confirmed} onClick={onDone}>
          بستن
        </Button>
      </DialogFooter>
    </>
  );
}
