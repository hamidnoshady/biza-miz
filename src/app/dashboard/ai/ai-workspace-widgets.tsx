"use client";

import { useCallback, useEffect, useState } from "react";
import { PlusIcon, RefreshCwIcon, SparklesIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { AiMarkdown } from "@/components/ai/ai-markdown";
import { useFeatureLocked } from "@/components/feature-lock";
import { SectionCardSkeleton, cardClass } from "../page-chrome";

interface Widget {
  id: string;
  name: string;
  description: string;
  sourceApp: string;
  prompt: string;
  outputFormat: "summary" | "bullets" | "metric";
  width: number;
  height: number;
  lastRunAt: string | null;
}
interface Recommendation {
  id: string;
  name: string;
  description: string;
  sourceApp: string;
  prompt: string;
  outputFormat: Widget["outputFormat"];
  requiredPermissions: string[];
  defaultWidth: number;
  defaultHeight: number;
}

function WidgetCard({ widget, onDelete, onRun }: { widget: Widget; onDelete: () => void; onRun: () => void }) {
  const [content, setContent] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  async function run() {
    setRunning(true);
    try {
      const response = await fetch(`/api/ai/widgets/${widget.id}/run`, { method: "POST" });
      const data = (await response.json().catch(() => ({}))) as { content?: string; message?: string };
      if (!response.ok || !data.content) throw new Error(data.message ?? "اجرای ویجت ممکن نشد.");
      setContent(data.content);
      onRun();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "اجرای ویجت ممکن نشد.");
    } finally {
      setRunning(false);
    }
  }
  return (
    <article className={`${cardClass} flex min-h-40 min-w-0 flex-col p-4`}>
      <div className="flex items-start gap-2">
        <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary"><SparklesIcon className="size-4" /></div>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold">{widget.name}</h3>
          {widget.description ? <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{widget.description}</p> : null}
        </div>
        <button type="button" onClick={onDelete} aria-label={`حذف ویجت ${widget.name}`} className="grid size-9 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><Trash2Icon className="size-4" /></button>
      </div>
      <div className="min-h-14 flex-1 pt-3 text-sm leading-6">
        {content ? <AiMarkdown content={content} /> : <p className="text-xs text-muted-foreground">برای تازه‌سازی این خلاصه، اجرا را بزنید.</p>}
      </div>
      <Button type="button" variant="outline" size="sm" onClick={() => void run()} disabled={running} className="mt-3 min-h-10 gap-2">
        <RefreshCwIcon className={running ? "size-4 opacity-60" : "size-4"} />
        {running ? "در حال خواندن…" : "تازه‌سازی"}
      </Button>
    </article>
  );
}

export function AiWorkspaceWidgets() {
  const locked = useFeatureLocked();
  const [widgets, setWidgets] = useState<Widget[]>([]);
  const [recommended, setRecommended] = useState<Recommendation[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (locked) return;
    setLoading(true);
    try {
      const response = await fetch("/api/ai/widgets");
      const data = (await response.json().catch(() => ({}))) as { widgets?: Widget[]; recommended?: Recommendation[] };
      if (!response.ok) throw new Error("خواندن ویجت‌ها ممکن نشد.");
      setWidgets(data.widgets ?? []);
      setRecommended(data.recommended ?? []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "خواندن ویجت‌ها ممکن نشد.");
    } finally {
      setLoading(false);
    }
  }, [locked]);
  useEffect(() => { void load(); }, [load]);

  async function create(input: { name: string; prompt: string; description?: string; sourceApp?: string; outputFormat?: string; width?: number; height?: number; requiredPermissions?: string[] }) {
    const response = await fetch("/api/ai/widgets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
    const data = (await response.json().catch(() => ({}))) as { widget?: Widget; error?: string };
    if (!response.ok || !data.widget) throw new Error(data.error ?? "ساخت ویجت ممکن نشد.");
    setWidgets((current) => [...current, data.widget!]);
    setRecommended((current) => current.filter((item) => item.name !== input.name));
  }
  async function copyRecommendation(item: Recommendation) {
    try {
      await create({ name: item.name, description: item.description, sourceApp: item.sourceApp, prompt: item.prompt, outputFormat: item.outputFormat, width: item.defaultWidth, height: item.defaultHeight, requiredPermissions: item.requiredPermissions });
      toast.success("ویجت پیشنهادی به ویجت‌های شما اضافه شد.");
    } catch (error) { toast.error(error instanceof Error ? error.message : "افزودن ویجت ممکن نشد."); }
  }
  async function submitCustom(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || !prompt.trim()) return;
    setSaving(true);
    try { await create({ name, prompt }); setName(""); setPrompt(""); setCreateOpen(false); toast.success("ویجت ساخته شد."); }
    catch (error) { toast.error(error instanceof Error ? error.message : "ساخت ویجت ممکن نشد."); }
    finally { setSaving(false); }
  }
  async function remove(id: string) {
    const response = await fetch(`/api/ai/widgets/${id}`, { method: "DELETE" });
    if (!response.ok) { toast.error("حذف ویجت ممکن نشد."); return; }
    setWidgets((current) => current.filter((widget) => widget.id !== id));
  }

  return (
    <section className="mx-auto w-full max-w-5xl px-2 pb-8 pt-6 sm:px-6 lg:col-span-2" aria-labelledby="ai-widgets-title">
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1"><p className="text-xs font-medium text-primary">مرکز توجه شما</p><h2 id="ai-widgets-title" className="mt-1 text-lg font-bold">ویجت‌های دستیار</h2><p className="mt-1 text-xs leading-5 text-muted-foreground">خلاصه‌های خواندنی که فقط با مجوزهای فعلی شما اجرا می‌شوند.</p></div>
        <Button type="button" size="sm" variant="outline" onClick={() => setCreateOpen((value) => !value)} className="min-h-10 gap-2"><PlusIcon className="size-4" /> ویجت جدید</Button>
      </div>
      {createOpen ? <form onSubmit={(event) => void submitCustom(event)} className="mb-5 grid gap-3 rounded-2xl border border-primary/20 bg-primary/5 p-4 md:grid-cols-2"><Input value={name} onChange={(event) => setName(event.target.value)} placeholder="نام ویجت، مثلاً فروش امروز" aria-label="نام ویجت" maxLength={100} required /><Textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="چه خلاصه‌ای را با داده‌های ثبت‌شده می‌خواهید؟" aria-label="دستور ویجت" maxLength={2000} required className="md:col-span-2" /><div className="flex justify-end gap-2 md:col-span-2"><Button type="button" variant="ghost" onClick={() => setCreateOpen(false)}>انصراف</Button><Button type="submit" disabled={saving} className="min-h-10">{saving ? "در حال ساخت…" : "ساخت ویجت"}</Button></div></form> : null}
      {loading ? <SectionCardSkeleton rows={3} label="در حال خواندن ویجت‌ها" /> : null}
      {!loading && recommended.length > 0 ? <div className="mb-6"><div className="mb-3 flex items-center gap-2"><span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-800 dark:bg-amber-500/15 dark:text-amber-200">پیشنهادی</span><span className="text-xs text-muted-foreground">بر اساس نوع کسب‌وکار و دسترسی‌های شما</span></div><div className="grid min-w-0 gap-3 md:grid-cols-2">{recommended.map((item) => <article key={item.id} className="flex min-w-0 items-center gap-3 rounded-2xl border border-dashed border-amber-300/70 bg-amber-50/40 p-4 dark:border-amber-500/30 dark:bg-amber-500/5"><div className="min-w-0 flex-1"><h3 className="truncate text-sm font-semibold">{item.name}</h3><p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{item.description}</p></div><Button type="button" size="sm" variant="outline" onClick={() => void copyRecommendation(item)} className="min-h-10 shrink-0">افزودن</Button></article>)}</div></div> : null}
      {!loading && widgets.length > 0 ? <div className="grid min-w-0 gap-3 md:grid-cols-2">{widgets.map((widget) => <WidgetCard key={widget.id} widget={widget} onDelete={() => void remove(widget.id)} onRun={() => {}} />)}</div> : null}
      {!loading && widgets.length === 0 && recommended.length === 0 ? <div className="rounded-2xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">هنوز ویجتی ندارید. از پیشنهادها یک مورد اضافه کنید یا ویجت خودتان را بسازید.</div> : null}
    </section>
  );
}
