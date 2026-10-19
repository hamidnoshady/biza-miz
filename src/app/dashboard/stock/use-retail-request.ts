"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../ui";

type Pending<T> = { idempotencyKey: string; payload: T };

/** Keep the exact submitted snapshot, not just a key, until success is known.
 * No automatic offline posting: retries are explicit and use the same snapshot.
 * Storage is member/business/branch scoped by the server page. */
export function useRetailRequest<T>(scope: string | undefined, operation: "purchase" | "supplier_return") {
  const storageKey = scope ? `retail-request:${scope}:${operation}` : null;
  const [pending, setPending] = useState<Pending<T> | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const pendingRef = useRef<Pending<T> | null>(null);
  useEffect(() => {
    if (!storageKey) return;
    try {
      const saved = localStorage.getItem(storageKey);
      const value = saved ? JSON.parse(saved) as Pending<T> : null;
      pendingRef.current = value;
      setPending(value);
    } catch { /* A new submit reports unavailable storage before moving money. */ }
  }, [storageKey]);

  const submit = useCallback(async (payload: T): Promise<{ ok: boolean; message?: string }> => {
    if (inFlight.current) return { ok: false };
    inFlight.current = true;
    setBusy(true);
    try {
      let request = pendingRef.current;
      if (storageKey) {
        const saved = localStorage.getItem(storageKey);
        if (saved) request = JSON.parse(saved) as Pending<T>;
      }
      request ??= { idempotencyKey: crypto.randomUUID(), payload };
      if (storageKey) localStorage.setItem(storageKey, JSON.stringify(request));
      pendingRef.current = request;
      setPending(request);
      const { ok, status, data } = await api<{ ok?: boolean; message?: string; error?: string }>(
        operation === "purchase" ? "/api/stock/purchases" : "/api/stock/returns",
        { method: "POST", body: JSON.stringify({ ...request.payload, idempotencyKey: request.idempotencyKey, locationId: scope?.split(":").at(-1) }) },
      );
      if (!ok && status === 400 && data.error) {
        // The route guarantees rollback on 400. This is a resolved rejection,
        // not an uncertain outcome; allow correction with a fresh identity.
        if (storageKey) localStorage.removeItem(storageKey);
        pendingRef.current = null;
        setPending(null);
      }
      if (!ok || data.ok !== true) return { ok: false, message: data.message ?? (data.error === "idempotency_conflict"
        ? "شناسهٔ این درخواست با اطلاعات دیگری ثبت شده است؛ پیش از ثبت مجدد، سند را بررسی کنید."
        : "ثبت ناموفق بود؛ برای پیگیری همان درخواست دوباره تلاش کنید.") };
      if (storageKey) localStorage.removeItem(storageKey);
      pendingRef.current = null;
      setPending(null);
      return { ok: true };
    } catch {
      return { ok: false, message: "ارتباط یا ذخیرهٔ درخواست ناموفق بود. تلاش دوباره همان درخواست را پیگیری می‌کند." };
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [storageKey, operation, scope]);
  return { busy, pending, submit };
}
