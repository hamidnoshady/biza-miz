"use client";

/**
 * Desktop pairing codes for one business.
 *
 * The plaintext code exists only in the response to the issue request — this
 * component holds it in state so the operator can copy it, and it is gone on
 * the next render pass. Re-issuing revokes whatever was live *for that branch*,
 * so the list never shows two usable codes for one location.
 *
 * It renders on the Devices & installations section (§15), next to the installs
 * the codes create — not among the feature flags, where a credential's lifetime
 * read as an entitlement.
 */
import { useCallback, useEffect, useState } from "react";
import { formatJalali } from "@/lib/jalali";
import { api, errorMessage, Button, Card, ErrorBox, InfoBox, useCan, SkeletonRows } from "../../ui";
import { useBusiness } from "./context";

interface PairingCodeSummary {
  id: string;
  businessId: string;
  locationId: string;
  expiresAt: string;
  redeemedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  state: "valid" | "code_expired" | "code_already_redeemed" | "code_revoked";
}

const STATE_LABELS: Record<PairingCodeSummary["state"], { label: string; cls: string }> = {
  valid: { label: "فعال", cls: "text-emerald-700 dark:text-emerald-300" },
  code_expired: { label: "منقضی", cls: "text-muted-foreground" },
  code_already_redeemed: { label: "استفاده‌شده", cls: "text-sky-700 dark:text-sky-300" },
  code_revoked: { label: "لغوشده", cls: "text-muted-foreground" },
};

/** Shamsi, like every other date the console shows. */
function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return formatJalali(iso, { withMonthName: true, withTime: true });
}

export function PairingPanel() {
  const { id, version } = useBusiness();
  const can = useCan();
  const allowed = can("business.provision");

  const [codes, setCodes] = useState<PairingCodeSummary[] | null>(null);
  const [locations, setLocations] = useState<Array<{ id: string; name: string }>>([]);
  const [locationId, setLocationId] = useState("");
  const [issuedCode, setIssuedCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!allowed) return;
    const { ok, data } = await api<{
      codes?: PairingCodeSummary[];
      locations?: Array<{ id: string; name: string }>;
      error?: string;
    }>(`/api/platform/pairing?businessId=${encodeURIComponent(id)}`);
    if (ok) {
      setCodes(data.codes ?? []);
      setLocations(data.locations ?? []);
      setLocationId((current) => current || data.locations?.[0]?.id || "");
    }
    else setError(errorMessage(data.error));
  }, [id, allowed]);

  useEffect(() => {
    void load();
  }, [load, version]);

  async function issue() {
    setBusy(true);
    setError(null);
    setNotice(null);
    const { ok, data } = await api<{ code?: string; error?: string }>("/api/platform/pairing", {
      method: "POST",
      body: JSON.stringify({ businessId: id, locationId }),
    });
    setBusy(false);
    if (ok && data.code) {
      setIssuedCode(data.code);
      setNotice("کد ساخته شد. همین حالا آن را کپی کنید — دیگر نمایش داده نمی‌شود.");
      void load();
    } else {
      setError(errorMessage(data.error));
    }
  }

  async function revoke(codeId: string) {
    if (!confirm("این کد اتصال لغو شود؟")) return;
    setError(null);
    setNotice(null);
    const { ok, data } = await api<{ error?: string }>("/api/platform/pairing", {
      method: "DELETE",
      body: JSON.stringify({ businessId: id, codeId }),
    });
    if (ok) {
      setIssuedCode(null);
      setNotice("کد لغو شد.");
      void load();
    } else {
      setError(errorMessage(data.error));
    }
  }

  if (!allowed) return null;

  return (
    <Card title="کد اتصال نصب دسکتاپ">
      <ErrorBox>{error}</ErrorBox>
      <InfoBox>{notice}</InfoBox>

      <p className="mb-4 text-sm text-muted-foreground">
        یک کد یک‌بارمصرف بسازید و آن را به مالک بدهید تا نصب دسکتاپ، تنظیمات این کسب‌وکار را
        دریافت کند. ساختن کد جدید، کد فعال قبلی را لغو می‌کند.
      </p>

      {issuedCode ? (
        <div className="mb-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4">
          <p className="mb-2 text-xs text-emerald-800/70 dark:text-emerald-200/70">این کد فقط همین یک بار نمایش داده می‌شود:</p>
          <div className="flex flex-wrap items-center gap-3">
            <code className="select-all font-mono text-xl tracking-widest text-emerald-900 dark:text-emerald-100" dir="ltr">
              {issuedCode}
            </code>
            <Button
              variant="ghost"
              onClick={() => {
                void navigator.clipboard.writeText(issuedCode);
                setNotice("کد کپی شد.");
              }}
            >
              کپی
            </Button>
          </div>
        </div>
      ) : null}

      <label className="mb-1 block text-xs font-medium" htmlFor="platform-pair-location">شعبهٔ سرور ویندوز</label>
      <select
        id="platform-pair-location"
        value={locationId}
        onChange={(event) => setLocationId(event.target.value)}
        disabled={busy || Boolean(issuedCode)}
        className="mb-3 h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
      >
        {locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
      </select>
      <Button onClick={issue} disabled={busy || !locationId}>
        {busy ? "در حال ساخت…" : "ساخت کد اتصال"}
      </Button>

      {codes === null ? (
        <SkeletonRows rows={3} className="mt-4" />
      ) : codes.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">هنوز کدی صادر نشده است.</p>
      ) : (
        <div className="mt-4 space-y-2">
          {codes.map((code) => {
            const state = STATE_LABELS[code.state];
            return (
              <div
                key={code.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card p-3 text-sm"
              >
                <div>
                  <span className={`font-medium ${state.cls}`}>{state.label}</span>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    صدور {fmtDate(code.createdAt)} ← انقضا {fmtDate(code.expiresAt)}
                  </p>
                  {code.redeemedAt ? (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      استفاده در {fmtDate(code.redeemedAt)}
                    </p>
                  ) : null}
                </div>
                {code.state === "valid" ? (
                  <button
                    type="button"
                    onClick={() => revoke(code.id)}
                    className="rounded-lg border border-red-500/30 px-2 py-1 text-xs text-red-700 dark:text-red-300 hover:bg-red-500/10"
                  >
                    لغو
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
