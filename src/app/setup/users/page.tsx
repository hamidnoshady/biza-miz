"use client";

import { SetupDataSkeleton } from "../ui";

import { useCallback, useEffect, useState } from "react";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { toLatinDigits, toPersianDigits } from "@/lib/digits";
import { PIN_MAX_LENGTH, isValidPin } from "@/lib/pin-policy";
import { roleLabel } from "@/lib/role-labels";
import { SETUP_CREATABLE_ROLES, isPasswordRole } from "@/lib/roles";
import type { Role } from "@/lib/auth-edge";
import { api, ErrorBox, errorMessage, Field, inputClass, PrimaryButton, StepShell } from "../ui";

interface UserRow {
  id: string;
  role: string;
  full_name: string;
  email: string | null;
  has_pin: boolean;
}

export default function UsersStep() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [role, setRole] = useState<Role>("cashier");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pin, setPin] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(() => {
    api<{ users: UserRow[] }>("/api/setup/users").then(({ data }) => {
      if (data.users) setUsers(data.users);
    }).finally(() => setLoaded(true));
  }, []);
  useEffect(load, [load]);

  /*
   * Which credential the form asks for. This must be the same question the API
   * asks in `POST /api/setup/users`, which branches on `isPasswordRole`. The
   * hand-written `role === "manager" || role === "accountant"` this replaces
   * had already fallen behind: picking `admin` or `viewer` showed the PIN field
   * and then failed server-side with `invalid_pin`, because the API correctly
   * classified both as password roles and went looking for an email.
   */
  const needsEmail = isPasswordRole(role);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { ok, data, status } = await api<{ error?: string }>("/api/setup/users", {
        method: "POST",
        body: JSON.stringify({
          role,
          fullName,
          // Phase 42 — optional login phone for both shapes: managers get it
          // next to email+password, PIN roles next to the PIN. Stored unverified.
          phone: phone.trim() || undefined,
          ...(needsEmail ? { email, password } : { pin }),
        }),
      });
      if (!ok) {
        setError(errorMessage(data.error, undefined, status));
        return;
      }
      setFullName("");
      setEmail("");
      setPassword("");
      setPin("");
      setPhone("");
      load();
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return <SetupDataSkeleton rows={4} />;

  return (
    <StepShell
      step="users"
      description="حساب مالک ساخته شده است. این‌جا مدیر (ایمیل و گذرواژه) و صندوق‌دار/گارسون/آشپزخانه (رمز عددی برای ورود سریع) اضافه کنید."
      showSkip
      showNext
    >
      <div className="grid gap-8 lg:grid-cols-2">
        <form onSubmit={submit}>
          <ErrorBox>{error}</ErrorBox>
          <Field label="نقش">
            <SearchableSelect
              className={inputClass}
              value={role}
              onChange={(value) => setRole(value as Role)}
              options={SETUP_CREATABLE_ROLES.map((value) => ({ value, label: roleLabel(value) }))}
            />
          </Field>
          <Field label="نام و نام خانوادگی *">
            <input
              className={inputClass}
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              required
            />
          </Field>
          {needsEmail ? (
            <>
              <Field label="ایمیل *">
                <input
                  className={inputClass}
                  dir="ltr"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </Field>
              <Field label="گذرواژه *" hint="حداقل ۸ کاراکتر">
                <input
                  className={inputClass}
                  dir="ltr"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </Field>
            </>
          ) : (
            <Field label="پین (۴ تا ۱۲ رقم) *" hint="برای ورود سریع در صفحهٔ ورود؛ در هر شعبه باید یکتا باشد.">
              <input
                className={`${inputClass} w-48 text-center tracking-[0.25em]`}
                dir="ltr"
                inputMode="numeric"
                maxLength={12}
                value={pin}
                onChange={(e) => setPin(toLatinDigits(e.target.value).replace(/[^0-9]/g, ""))}
                required
              />
            </Field>
          )}
          <Field
            label="شمارهٔ موبایل"
            hint="اختیاری؛ برای ورود با پیامک. بار اول با کد تأیید فعال می‌شود."
          >
            <input
              className={inputClass}
              dir="ltr"
              inputMode="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="09121234567"
            />
          </Field>
          <div className="mt-4">
            {/* The PIN's shape is checked here too (pin-policy.ts, the same
                rule the route applies after folding Persian digits), so the
                button refuses before a request can answer 400. */}
            <PrimaryButton disabled={busy || !fullName.trim() || (needsEmail ? false : !isValidPin(pin))}>
              افزودن کاربر
            </PrimaryButton>
          </div>
        </form>

        <div>
          <p className="mb-2 text-sm font-medium text-foreground">
            کاربران فعلی ({toPersianDigits(users.length)})
          </p>
          <ul className="divide-y divide-border rounded-lg border border-border">
            {users.map((u) => (
              <li key={u.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
                <span>
                  <span className="font-medium">{u.full_name}</span>
                  <span className="ms-2 rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                    {roleLabel(u.role)}
                  </span>
                </span>
                <span className="text-xs text-muted-foreground" dir="ltr">
                  {u.email ?? (u.has_pin ? "PIN ****" : "")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </StepShell>
  );
}
