"use client";

/**
 * Inline manual party entry for the first-run import step (GitHub #1580).
 *
 * The issue requires an owner to be able to enter initial business data
 * manually without leaving the wizard. Customers and suppliers are the one
 * manual record that matters to every industry (the F&B menu already has its
 * own inline editor), and they have exactly one canonical write door:
 * `POST /api/parties` → `parties-service.createParty` with its tenant/branch,
 * permission, accounting-code and consent rules. This form adds no second
 * writer and no second validation — it only composes the fields the endpoint
 * accepts (`displayName`, `roles`, `personType`, `contact_info.mobile`) and
 * shows the server's answer.
 *
 * Accounting fields (code, tax, bank) are deliberately not collected here:
 * they are gated by `ledger.view` and belong to the party directory, not to a
 * three-field onboarding form.
 */
import { useState, type FormEvent } from "react";
import { UserPlusIcon } from "lucide-react";
import { toPersianDigits } from "@/lib/digits";
import {
  ErrorBox,
  Field,
  PrimaryButton,
  SecondaryButton,
  api,
  errorMessage,
  inputClass,
} from "../ui";

type PartyRole = "Customer" | "Supplier";

export function SetupPartyManualForm() {
  const [role, setRole] = useState<PartyRole>("Customer");
  const [name, setName] = useState("");
  const [mobile, setMobile] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(0);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setStatus("");
    const result = await api<{
      error?: string;
      fieldErrors?: Record<string, string>;
      party?: { displayName?: string };
    }>("/api/parties", {
      method: "POST",
      body: JSON.stringify({
        displayName: name.trim(),
        role,
        roles: [role],
        personType: "Real",
        contact_info: mobile.trim() ? { mobile: mobile.trim() } : undefined,
      }),
    });
    setBusy(false);
    if (!result.ok) {
      const fieldMessage = result.data.fieldErrors
        ? Object.values(result.data.fieldErrors)[0]
        : undefined;
      setError(
        fieldMessage
          ? errorMessage(fieldMessage, undefined, result.status)
          : errorMessage(result.data.error, undefined, result.status),
      );
      return;
    }
    setStatus(
      `${role === "Customer" ? "مشتری" : "تأمین‌کننده"} «${name.trim()}» ثبت شد.`,
    );
    setCreated((count) => count + 1);
    setName("");
    setMobile("");
  }

  return (
    <section className="mt-4 rounded-xl border border-border p-4" aria-label="ثبت دستی مشتری یا تأمین‌کننده">
      <h4 className="font-medium text-foreground">افزودن مشتری یا تأمین‌کننده</h4>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">
        یک پروندهٔ واقعی در دفتر طرف‌حساب‌ها می‌سازد و همان قواعد سرویس اصلی را
        دارد؛ پروندهٔ بدون نام ثبت نمی‌شود. برای تعداد زیاد، از «بارگذاری فایل» با
        نوع «مشتریان» استفاده کنید.
      </p>
      <form onSubmit={submit} className="mt-3 grid gap-3 sm:grid-cols-4">
        <Field label="نوع">
          <select
            className={inputClass}
            value={role}
            onChange={(event) =>
              setRole(event.target.value === "Supplier" ? "Supplier" : "Customer")
            }
            aria-label="نوع طرف‌حساب"
          >
            <option value="Customer">مشتری</option>
            <option value="Supplier">تأمین‌کننده</option>
          </select>
        </Field>
        <Field label="نام">
          <input
            className={inputClass}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="نام کامل یا نام کسب‌وکار"
            required
          />
        </Field>
        <Field label="موبایل (اختیاری)">
          <input
            className={inputClass}
            dir="ltr"
            inputMode="tel"
            value={mobile}
            onChange={(event) => setMobile(event.target.value)}
            placeholder="0912…"
          />
        </Field>
        <div className="flex items-end">
          <PrimaryButton type="submit" disabled={busy || !name.trim()}>
            <UserPlusIcon className="me-1 size-4" aria-hidden="true" />
            {busy ? "در حال ثبت…" : "افزودن"}
          </PrimaryButton>
        </div>
      </form>
      <ErrorBox>{error}</ErrorBox>
      <p className="sr-only" role="status" aria-live="polite">
        {status}
      </p>
      {status ? (
        <p className="mt-2 text-xs leading-5 text-emerald-700 dark:text-emerald-300">
          {status}
        </p>
      ) : null}
      {created > 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {toPersianDigits(created)} پرونده در این نشست ثبت شد.
        </p>
      ) : null}
      <div className="mt-2">
        <SecondaryButton
          onClick={() => {
            setName("");
            setMobile("");
            setStatus("");
            setError("");
          }}
          disabled={busy || (!name && !mobile)}
        >
          پاک‌کردن فرم
        </SecondaryButton>
      </div>
    </section>
  );
}
