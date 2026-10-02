"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { api, ErrorBox, InfoBox } from "../../ui";
import { CompanyWorkspace } from "../_components/company-workspace";

type Credential = { id: string; site_key: string; provider: "eshobe" | "wordpress"; is_active: boolean; requests_per_minute: number; last_used_at: string | null };

export default function Page() {
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [siteKey, setSiteKey] = useState("");
  const [provider, setProvider] = useState<"eshobe" | "wordpress">("eshobe");
  const [shownToken, setShownToken] = useState("");
  const [error, setError] = useState("");
  const load = async () => {
    const result = await api<{ credentials?: Credential[]; error?: string }>("/api/platform/company/websites/credentials");
    if (result.ok) setCredentials(result.data.credentials ?? []);
    else setError(result.data.error ?? "خواندن اعتبارهای سایت ناموفق بود.");
  };
  useEffect(() => { void load(); }, []);
  async function create() {
    setError(""); setShownToken("");
    const result = await api<{ token?: string; error?: string }>("/api/platform/company/websites/credentials", {
      method: "POST", body: JSON.stringify({ siteKey, provider, requestsPerMinute: 30 }),
    });
    if (!result.ok) setError(result.data.error ?? "ساخت اعتبار ناموفق بود.");
    else { setShownToken(result.data.token ?? ""); setSiteKey(""); await load(); }
  }
  async function revoke(id: string) {
    const result = await api<{ error?: string }>("/api/platform/company/websites/credentials", { method: "DELETE", body: JSON.stringify({ id }) });
    if (!result.ok) setError(result.data.error ?? "لغو اعتبار ناموفق بود."); else await load();
  }
  return <CompanyWorkspace active="websites">
    <div className="space-y-4">
      <section className="rounded-2xl border border-border bg-card p-5">
        <h2 className="text-lg font-bold">مدیریت وب‌سایت</h2>
        <p className="mt-2 text-sm text-muted-foreground">Eshobe و WordPress/Woo همتای مستقل‌اند. مدیریت محتوا و اتصال‌ها در موتور مشترک انجام می‌شود.</p>
        <Button asChild className="mt-4"><a href="/api/platform/company/open?app=websites">ورود به مدیریت وب‌سایت</a></Button>
      </section>
      <section className="rounded-2xl border border-border bg-card p-5">
        <h2 className="font-bold">اعتبار فرم لید سایت</h2>
        <p className="mt-1 text-sm text-muted-foreground">هر کلید فقط برای یک سایت است، تنها امکان ثبت فرم دارد و پس از ساخت فقط یک‌بار نمایش داده می‌شود.</p>
        {error ? <div className="mt-3"><ErrorBox>{error}</ErrorBox></div> : null}
        {shownToken ? <div className="mt-3"><InfoBox>کلید را اکنون در محل امن ذخیره کنید: <code dir="ltr" className="select-all break-all">{shownToken}</code></InfoBox></div> : null}
        <div className="mt-4 flex flex-wrap gap-2">
          <input aria-label="شناسه سایت" value={siteKey} onChange={(event) => setSiteKey(event.target.value)} placeholder="مثلاً وب‌سایت اصلی" className="h-10 rounded-md border bg-background px-3 text-sm" />
          <select aria-label="ارائه‌دهنده سایت" value={provider} onChange={(event) => setProvider(event.target.value as typeof provider)} className="h-10 rounded-md border bg-background px-3 text-sm"><option value="eshobe">Eshobe</option><option value="wordpress">WordPress</option></select>
          <Button onClick={create} disabled={!siteKey.trim()}>ساخت یا چرخش کلید</Button>
        </div>
        <div className="mt-4 space-y-2">{credentials.map((credential) => <div key={credential.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-muted/60 p-3 text-sm"><span><strong>{credential.site_key}</strong> · {credential.provider} · سقف {credential.requests_per_minute} درخواست در دقیقه</span><Button size="sm" variant="destructive" disabled={!credential.is_active} onClick={() => void revoke(credential.id)}>{credential.is_active ? "لغو" : "لغوشده"}</Button></div>)}</div>
      </section>
    </div>
  </CompanyWorkspace>;
}
