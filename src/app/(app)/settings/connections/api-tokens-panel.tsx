"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
/**
 * «کلیدهای API» — issuing and revoking the keys that authenticate `/api/v1/*`.
 *
 * Phase 19 built the whole realm: the key format, the SHA-256 storage, the
 * scope guard on every route, the per-key rate-limit bucket. What it never
 * built was a way to *obtain* one, so the public API has been complete and
 * unreachable. This is the missing screen.
 *
 * Two properties are non-negotiable and shape the whole component: the secret
 * is shown exactly once (only its hash is stored, so there is no "show again"
 * to build), and scopes are chosen at issue time rather than derived from the
 * owner's role — a key is a machine credential, not a person.
 */
import { useCallback, useEffect, useState } from "react";
import { useFeatureLocked } from "@/components/feature-lock";
import { Button } from "@/components/ui/button";
import { SectionCard, StatusBadge } from "@/app/dashboard/page-chrome";
import { api, ErrorBox, errorMessage, InfoBox, inputClass } from "@/app/dashboard/ui";

interface ApiKeySummary {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  status: "active" | "revoked";
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

/**
 * What each scope actually lets a key do, in the owner's language.
 *
 * Worth spelling out rather than showing the raw slug: the person granting
 * these is not the person writing the integration, and "inventory.read" tells
 * them nothing about whether their stock levels are about to leave the
 * building.
 */
const SCOPE_LABELS: Record<string, string> = {
  "orders.read": "خواندن سفارش‌ها",
  "orders.write": "ثبت و تغییر سفارش",
  "menu.read": "خواندن منو و کالاها",
  "menu.write": "تغییر منو و کالاها",
  "inventory.read": "خواندن موجودی انبار",
  "reports.read": "خواندن گزارش‌ها",
  "webhooks.manage": "مدیریت وب‌هوک‌ها",
  "accounting.read": "بازبینی حساب‌ها (فقط خواندن)",
  "coworker.read": "خواندن کارهای همکار هوشمند",
  "coworker.write": "تعریف کار و تأیید اجرای همکار هوشمند",
};

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("fa-IR", { dateStyle: "short", timeStyle: "short" });
}

export function ApiTokensPanel() {
  const [keys, setKeys] = useState<ApiKeySummary[]>([]);
  const [scopes, setScopes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const locked = useFeatureLocked();

  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string[]>(["orders.read", "menu.read"]);
  const [expiresInDays, setExpiresInDays] = useState("90");
  // The example's base URL is the browser's own origin. Reading it while
  // rendering answers "" on the server and the real origin on the client — a
  // hydration text mismatch — so it is filled in after mount instead.
  const [origin, setOrigin] = useState("");
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const load = useCallback(async () => {
    if (locked) {
      setKeys([]);
      setScopes(Object.keys(SCOPE_LABELS));
      setLoading(false);
      return;
    }
    setLoading(true);
    const { ok, data } = await api<{ keys?: ApiKeySummary[]; scopes?: string[] }>("/api/connections/api-keys");
    if (ok) {
      setKeys(data.keys ?? []);
      setScopes(data.scopes ?? Object.keys(SCOPE_LABELS));
    } else {
      setMessage({ kind: "error", text: "بارگذاری کلیدها ممکن نشد." });
    }
    setLoading(false);
  }, [locked]);

  useEffect(() => {
    void load();
  }, [load]);

  function toggleScope(scope: string) {
    setSelected((current) =>
      current.includes(scope) ? current.filter((s) => s !== scope) : [...current, scope],
    );
  }

  async function create() {
    setBusy(true);
    setMessage(null);
    const { ok, data } = await api<{ secret?: string; error?: string }>("/api/connections/api-keys", {
      method: "POST",
      body: JSON.stringify({
        name,
        scopes: selected,
        // Blank means "no expiry", which is a legitimate choice for a
        // long-lived back-office integration — so it is not silently
        // substituted with a default.
        expiresInDays: expiresInDays.trim() ? Number(expiresInDays) : null,
      }),
    });
    setBusy(false);
    if (!ok || !data.secret) {
      const map: Record<string, string> = {
        invalid_name: "برای کلید یک نام وارد کنید.",
        invalid_scopes: "حداقل یک دسترسی را انتخاب کنید.",
        invalid_expiry: "مدت اعتبار معتبر نیست.",
        feature_disabled: "«کلیدهای API» برای کسب‌وکار شما فعال نیست.",
      };
      setMessage({ kind: "error", text: map[data.error ?? ""] ?? errorMessage(data.error) });
      return;
    }
    setSecret(data.secret);
    setName("");
    setExpiresInDays("");
    await load();
  }

  async function revoke(id: string) {
    if (!confirm("این کلید باطل شود؟ برنامه‌هایی که از آن استفاده می‌کنند بلافاصله قطع می‌شوند.")) return;
    setBusy(true);
    const { ok, data } = await api<{ error?: string }>(`/api/connections/api-keys/${id}`, { method: "DELETE" });
    setBusy(false);
    if (!ok) {
      setMessage({ kind: "error", text: errorMessage(data.error) || "باطل‌کردن کلید ممکن نشد." });
      return;
    }
    setMessage({ kind: "ok", text: "کلید باطل شد." });
    await load();
  }

  return (
    <div className="space-y-6">
      {message?.kind === "ok" ? <InfoBox>{message.text}</InfoBox> : null}
      {message?.kind === "error" ? <ErrorBox>{message.text}</ErrorBox> : null}

      {secret ? (
        <div className="rounded-xl border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/15 p-4 text-sm">
          <p className="font-semibold text-amber-900 dark:text-amber-200">این کلید فقط همین یک بار نمایش داده می‌شود.</p>
          <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">
            آن را در جای امنی ذخیره کنید. اگر گم شود قابل بازیابی نیست و باید کلید تازه‌ای بسازید.
          </p>
          <code dir="ltr" className="mt-2 block select-all break-all rounded-lg bg-white/70 p-2 font-mono text-amber-900 dark:text-amber-200">
            {secret}
          </code>
          <Button
            type="button"
            size="sm"
            className="mt-2 bg-amber-500 dark:bg-amber-400 text-amber-950 hover:bg-amber-600 dark:hover:bg-amber-300"
            onClick={async () => {
              try { await navigator.clipboard.writeText(secret); setSecret(null); }
              catch { setMessage({ kind: "error", text: "کپی انجام نشد؛ کلید را دستی کپی کنید." }); }
            }}
          >
            کپی و بستن
          </Button>
        </div>
      ) : null}

      <SectionCard title="ساخت کلید جدید">
        <p className="mb-3 text-xs leading-5 text-muted-foreground">
          هر کلید فقط همان دسترسی‌هایی را دارد که اینجا انتخاب می‌کنید و به شعبهٔ فعال شما محدود است. برای هر
          برنامه یک کلید جدا بسازید تا در صورت نیاز بتوانید فقط همان را باطل کنید.
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          <input
            className={inputClass}
            placeholder="نام کلید (مثلاً اپلیکیشن باشگاه مشتریان)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <PersianNumberInput
            className={inputClass}
            dir="ltr"
            placeholder="مدت اعتبار به روز (خالی = بدون انقضا)"
            value={expiresInDays}
            onChange={(e) => setExpiresInDays(e.target.value)}
          />
        </div>

        <fieldset className="mt-3">
          <legend className="mb-2 text-sm font-medium">دسترسی‌ها</legend>
          <div className="flex flex-wrap gap-2">
            {scopes.map((scope) => (
              <button
                key={scope}
                type="button"
                onClick={() => toggleScope(scope)}
                aria-pressed={selected.includes(scope)}
                className={`min-h-9 rounded-lg border px-3 text-xs font-medium transition-colors ${
                  selected.includes(scope)
                    ? "border-amber-200 dark:border-amber-500/30 bg-amber-100 dark:bg-amber-500/20 text-amber-950 dark:text-amber-200"
                    : "border-border text-muted-foreground hover:bg-muted"
                }`}
              >
                {SCOPE_LABELS[scope] ?? scope}
              </button>
            ))}
          </div>
        </fieldset>

        <Button
          type="button"
          className="mt-4"
          onClick={create}
          disabled={busy || !name.trim() || selected.length === 0}
        >
          {busy ? "در حال ساخت…" : "ساخت کلید"}
        </Button>
      </SectionCard>

      <SectionCard title="کلیدهای موجود">
        {loading ? (
          <LoadingSkeleton rows={3} />
        ) : keys.length === 0 ? (
          <p className="text-sm text-muted-foreground">هنوز کلیدی ساخته نشده است.</p>
        ) : (
          <ul className="space-y-2">
            {keys.map((key) => (
              <li key={key.id} className="rounded-xl border border-border/80 p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{key.name}</span>
                  <code dir="ltr" className="rounded bg-muted px-2 py-0.5 font-mono text-xs">
                    {key.keyPrefix}…
                  </code>
                  <StatusBadge tone={key.status === "active" ? "positive" : "neutral"}>
                    {key.status === "active" ? "فعال" : "باطل‌شده"}
                  </StatusBadge>
                  {key.status === "active" ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => revoke(key.id)}
                      disabled={busy}
                    >
                      باطل‌کردن
                    </Button>
                  ) : null}
                </div>
                <div className="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
                  {key.scopes.map((scope) => (
                    <span key={scope} className="rounded bg-muted px-2 py-0.5">
                      {SCOPE_LABELS[scope] ?? scope}
                    </span>
                  ))}
                </div>
                <div className="mt-1 flex flex-wrap gap-3 text-xs text-muted-foreground">
                  <span>ساخت: {formatDateTime(key.createdAt)}</span>
                  <span>آخرین استفاده: {formatDateTime(key.lastUsedAt)}</span>
                  <span>انقضا: {key.expiresAt ? formatDateTime(key.expiresAt) : "ندارد"}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard title="راهنمای استفاده">
        <p className="mb-2 text-xs leading-6 text-muted-foreground">
          کلید را در سرآیند <code dir="ltr">Authorization</code> بفرستید. آدرس پایه، همین دامنه است.
        </p>
        <pre dir="ltr" className="overflow-x-auto rounded-lg bg-primary p-3 text-xs text-primary-foreground/90">
{`curl -H "Authorization: Bearer posk_live_..." \\
     ${origin || "https://your-domain"}/api/v1/orders`}
        </pre>
      </SectionCard>
    </div>
  );
}
