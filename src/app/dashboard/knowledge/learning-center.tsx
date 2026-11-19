"use client";

/**
 * «مسیر یادگیری من» — the member-facing Learning Center (issue #972,
 * Phase E), inside the existing `/knowledge` center rather than a second help
 * product.
 *
 * It shows the one aggregate the server already computes (`GET
 * /api/knowledge/learning-progress`: platform → app → section → page), the
 * curated learning paths with their real steps, and — only for a member with
 * `team.manage` — the staff assignment report. A tour step is never marked
 * complete here: that comes from the tour's own server progress. Article and
 * page steps are the member's own reading acknowledgement.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeftIcon,
  BookOpenIcon,
  CircleCheckIcon,
  CompassIcon,
  GraduationCapIcon,
  PlayIcon,
  RotateCcwIcon,
  UsersIcon,
} from "lucide-react";
import { useTourRuntime } from "@/components/tours/tour-provider";
import { Skeleton } from "@/components/ui/skeleton";
import { formatJalali } from "@/lib/jalali";
import { toPersianDigits } from "@/lib/digits";
import {
  CardEyebrow,
  EmptyState,
  KpiCard,
  KpiRow,
  PageHeader,
  PageShell,
  SectionCard,
  SectionCardSkeleton,
  StatusBadge,
  cardClass,
} from "@/app/dashboard/page-chrome";
import {
  DataTable,
  DataTableBody,
  DataTableHead,
  DataTableRow,
  Td,
  Th,
} from "@/app/dashboard/data-table";
import { api, ErrorBox } from "@/app/dashboard/ui";

type LessonStatus = "not_started" | "in_progress" | "completed";

interface ProgressView {
  status: LessonStatus;
  completedCount: number;
  totalSteps: number;
  percent: number;
  resumeStepId: string | null;
  outdated: boolean;
  lastActiveAt: string | null;
  completedAt: string | null;
}

interface PageProgress {
  pageKey: string;
  route: string;
  label: string;
  group: string;
  appKey: string | null;
  tours: Array<{
    id: string;
    title: string;
    status: LessonStatus;
    percent: number;
    resumeStepId: string | null;
    outdated: boolean;
  }>;
  paths: Array<{
    id: string;
    title: string;
    status: LessonStatus;
    percent: number;
    resumeStepId: string | null;
  }>;
}

interface LearningProgressPayload {
  platform: { eligible: number; completed: number; percent: number };
  apps: Array<{
    key: string;
    label: string;
    eligible: number;
    completed: number;
    percent: number;
    sections: Array<{
      key: string;
      label: string;
      eligible: number;
      completed: number;
      percent: number;
      pages: PageProgress[];
    }>;
  }>;
  nextLesson: { id: string; title: string; type: "tour" | "path"; route: string } | null;
  resumeLastTour: {
    id: string;
    title: string;
    type: "tour" | "path";
    route: string;
    resumeStepId: string | null;
    lastActiveAt: string | null;
  } | null;
  currentDevice: { id: string | null; paired: boolean; trusted: boolean };
}

interface LearningPathSummary {
  id: string;
  version: number;
  group: string;
  title: string;
  body: string;
  stepCount: number;
  progress: ProgressView;
}

interface PathStep {
  id: string;
  kind: "tour" | "article" | "page";
  target: string;
  title: string;
  body: string;
  completed: boolean;
}

interface PathDetail {
  path: LearningPathSummary;
  steps: PathStep[];
}

interface StaffRow {
  pathId?: string;
  tourId?: string;
  title: string;
  userId: string;
  fullName: string | null;
  assignedAt: string;
  state: LessonStatus | "unavailable";
  percent: number;
  completedAt: string | null;
  lastActiveAt: string | null;
}

interface StaffReport {
  paths: StaffRow[];
  tours: StaffRow[];
  counts: { paths: number; tours: number; incomplete: number; completed: number };
}

interface Recommendation {
  kind: "tour" | "path";
  id: string;
  title: string;
  route: string;
  percent: number;
  reason: string;
}

interface AnalyticsRow {
  tourId: string;
  title: string;
  route: string | null;
  started: number;
  completed: number;
  inProgress: number;
  abandoned: number;
  completionPercent: number;
  lastActiveAt: string | null;
  topStuckStep: { stepId: string; title: string | null; count: number } | null;
}

interface AnalyticsReport {
  tours: AnalyticsRow[];
  totals: { started: number; completed: number; inProgress: number; abandoned: number; completionPercent: number };
}

const STATUS_TEXT: Record<LessonStatus, string> = {
  not_started: "شروع نشده",
  in_progress: "در حال یادگیری",
  completed: "کامل شد",
};

function progressTone(status: LessonStatus): "active" | "positive" | "neutral" {
  if (status === "completed") return "positive";
  if (status === "in_progress") return "active";
  return "neutral";
}

function percentLabel(percent: number): string {
  return `${toPersianDigits(percent)}٪`;
}

function LearningSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="در حال آماده‌سازی مسیر یادگیری" className="space-y-4">
      <KpiRow>
        <Skeleton className="h-24 rounded-2xl" />
        <Skeleton className="h-24 rounded-2xl" />
        <Skeleton className="h-24 rounded-2xl" />
        <Skeleton className="h-24 rounded-2xl" />
      </KpiRow>
      <SectionCardSkeleton rows={4} />
      <SectionCardSkeleton rows={4} />
    </div>
  );
}

export function LearningCenter() {
  const tourRuntime = useTourRuntime();
  const [progress, setProgress] = useState<LearningProgressPayload | null>(null);
  const [paths, setPaths] = useState<LearningPathSummary[] | null>(null);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<PathDetail | null>(null);
  const [detailBusy, setDetailBusy] = useState("");
  const [marking, setMarking] = useState("");
  const [staff, setStaff] = useState<StaffReport | null>(null);
  const [analytics, setAnalytics] = useState<AnalyticsReport | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async () => {
    setError("");
    const [progressResult, pathsResult, staffResult] = await Promise.all([
      api<LearningProgressPayload>("/api/knowledge/learning-progress"),
      api<{ paths?: LearningPathSummary[] }>("/api/knowledge/learning-paths"),
      api<StaffReport>("/api/knowledge/learning-assignments"),
    ]);
    void api<{ recommendations?: Recommendation[] }>("/api/knowledge/recommendations")
      .then(({ ok, data }) => {
        if (ok && Array.isArray(data.recommendations)) setRecommendations(data.recommendations);
      })
      .catch(() => setRecommendations([]));
    if (!progressResult.ok || !pathsResult.ok) {
      setError("مسیر یادگیری بارگذاری نشد. دوباره تلاش کنید.");
      return;
    }
    setProgress(progressResult.data);
    setPaths(Array.isArray(pathsResult.data.paths) ? pathsResult.data.paths : []);
    if (staffResult.ok) {
      setStaff(staffResult.data);
      void api<AnalyticsReport>("/api/knowledge/learning-analytics")
        .then(({ ok, data }) => setAnalytics(ok ? data : null))
        .catch(() => setAnalytics(null));
    } else {
      // 403 is the expected answer for a member without `team.manage`; it is
      // not an error state, the section simply does not exist for them.
      setStaff(null);
      setAnalytics(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const openPath = useCallback(async (pathId: string) => {
    setDetailBusy(pathId);
    const { ok, data } = await api<PathDetail>(
      `/api/knowledge/learning-paths/${encodeURIComponent(pathId)}`,
    );
    setDetailBusy("");
    if (ok) setDetail(data);
  }, []);

  const startStep = useCallback(
    async (step: PathStep, pathId: string) => {
      if (!tourRuntime) return;
      setDetailBusy(step.id);
      const started = await tourRuntime.startTour(step.target);
      setDetailBusy("");
      if (started) {
        setDetail(null);
        // Their progress changed; refresh on the next look at this page.
        setReloadKey((value) => value + 1);
      } else {
        // A tour can be unavailable for this member; fall back to its page.
        setError("شروع تور ممکن نشد؛ از دکمهٔ آموزش همان صفحه امتحان کنید.");
      }
      void pathId;
    },
    [tourRuntime],
  );

  const markStep = useCallback(async (step: PathStep, pathId: string) => {
    setMarking(step.id);
    const { ok } = await api(
      `/api/knowledge/learning-paths/${encodeURIComponent(pathId)}/progress`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "step_completed", stepId: step.id }),
      },
    );
    setMarking("");
    if (!ok) {
      setError("ثبت این مرحله ممکن نشد؛ دوباره تلاش کنید.");
      return;
    }
    await openPath(pathId);
    setReloadKey((value) => value + 1);
  }, [openPath]);

  if (error && !progress) {
    return (
      <div className="space-y-3">
        <ErrorBox>{error}</ErrorBox>
        <button
          type="button"
          onClick={() => setReloadKey((value) => value + 1)}
          className="rounded-lg border border-border/80 px-4 py-2 text-sm font-medium text-foreground/80 transition-colors hover:bg-muted"
        >
          تلاش دوباره
        </button>
      </div>
    );
  }

  if (!progress || !paths) return <LearningSkeleton />;

  const { platform } = progress;

  return (
    <div className="space-y-5">
      {error ? <ErrorBox>{error}</ErrorBox> : null}

      <KpiRow>
        <KpiCard
          label="پیشرفت کل"
          value={percentLabel(platform.percent)}
          hint={`${toPersianDigits(platform.completed)} از ${toPersianDigits(platform.eligible)} مورد کامل شده`}
          icon={GraduationCapIcon}
        />
        <KpiCard
          label="مسیرهای یادگیری"
          value={toPersianDigits(paths.length)}
          hint="مسیرهای در دسترس نقش شما"
          icon={CompassIcon}
        />
        <KpiCard
          label="قدم بعدی"
          value={progress.nextLesson ? progress.nextLesson.title : "همه‌چیز کامل است"}
          hint={progress.nextLesson ? progress.nextLesson.route : "چیزی برای ادامه نمانده"}
          icon={PlayIcon}
        />
        <KpiCard
          label="دستگاه فعلی"
          value={progress.currentDevice.paired ? "جفت‌شده" : "جفت‌نشده"}
          hint={progress.currentDevice.trusted ? "این دستگاه مورد اعتماد است" : "پیشرفت روی حساب شما ذخیره می‌شود"}
          icon={UsersIcon}
        />
      </KpiRow>

      {recommendations.length > 0 ? (
        <SectionCard
          title="پیشنهاد برای شما"
          description="بر اساس صفحهٔ جاری، نقش شما و پیشرفتتان — فقط از تورها و مسیرهای منتشرشده. هیچ‌کدام خودکار شروع نمی‌شود."
        >
          <ul className="grid gap-3 md:grid-cols-2">
            {recommendations.map((item) => (
              <li key={`${item.kind}:${item.id}`} className={`${cardClass} flex flex-col gap-2 p-4`}>
                <p className="text-sm font-bold text-foreground">{item.title}</p>
                <p className="text-xs leading-5 text-muted-foreground">{item.reason}</p>
                <div className="mt-auto flex flex-wrap items-center gap-2">
                  {item.kind === "tour" && tourRuntime ? (
                    <button
                      type="button"
                      onClick={() => void tourRuntime.startTour(item.id)}
                      className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
                    >
                      <PlayIcon className="size-4" aria-hidden="true" />
                      شروع تور
                    </button>
                  ) : item.kind === "path" ? (
                    <button
                      type="button"
                      onClick={() => {
                        const path = paths.find((entry) => entry.id === item.id);
                        if (path) void openPath(path.id);
                      }}
                      className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border/80 px-3 text-sm font-medium text-foreground/80 transition-colors hover:bg-muted"
                    >
                      <CompassIcon className="size-4" aria-hidden="true" />
                      دیدن مسیر
                    </button>
                  ) : null}
                  <Link
                    href={item.route}
                    className="inline-flex min-h-9 items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <ArrowLeftIcon className="size-3.5" aria-hidden="true" />
                    رفتن به صفحه
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}

      {progress.resumeLastTour ? (
        <SectionCard
          title="ادامه از جایی که بودید"
          description={`${progress.resumeLastTour.title} — آخرین فعالیت: ${
            progress.resumeLastTour.lastActiveAt
              ? toPersianDigits(formatJalali(progress.resumeLastTour.lastActiveAt, { withMonthName: true }))
              : "—"
          }`}
          actions={
            progress.resumeLastTour.type === "tour" && tourRuntime ? (
              <button
                type="button"
                onClick={() => void tourRuntime.startTour(progress.resumeLastTour!.id)}
                className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
              >
                <PlayIcon className="size-4" aria-hidden="true" />
                ادامهٔ تور
              </button>
            ) : (
              <Link
                href={paths.find((path) => path.id === progress.resumeLastTour!.id) ? "/knowledge/learning" : progress.resumeLastTour.route}
                className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border/80 px-3 text-sm font-medium text-foreground/80 transition-colors hover:bg-muted"
              >
                <PlayIcon className="size-4" aria-hidden="true" />
                ادامه
              </Link>
            )
          }
        >
          <p className="text-sm leading-6 text-muted-foreground">
            پیشرفت شما در حساب و کسب‌وکار همین‌جا نگه داشته می‌شود؛ روی دستگاه دیگر هم همان را می‌بینید.
          </p>
        </SectionCard>
      ) : null}

      <SectionCard
        title="مسیرهای یادگیری"
        description="هر مسیر چند تور و راهنما را به یک هدف کاری وصل می‌کند. مرحله‌های تور با تأیید سرور کامل می‌شوند."
      >
        {paths.length === 0 ? (
          <EmptyState icon={CompassIcon} title="مسیری برای نقش شما ثبت نشده است">
            مقاله‌های مرکز آموزش را بخوانید یا از دکمهٔ آموزش هر صفحه تور آن را شروع کنید.
          </EmptyState>
        ) : (
          <ul className="space-y-3">
            {paths.map((path) => {
              const expanded = detail?.path.id === path.id;
              return (
                <li key={path.id} className={`${cardClass} p-4`}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <CardEyebrow>{path.group}</CardEyebrow>
                      <p className="mt-1 text-sm font-bold text-foreground">{path.title}</p>
                      <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">{path.body}</p>
                    </div>
                    <StatusBadge tone={progressTone(path.progress.status)} dot>
                      {STATUS_TEXT[path.progress.status]}
                    </StatusBadge>
                  </div>
                  <div
                    className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted"
                    role="progressbar"
                    aria-label={`پیشرفت ${path.title}`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={path.progress.percent}
                  >
                    <div className="h-full bg-primary" style={{ width: `${path.progress.percent}%` }} />
                  </div>
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs text-muted-foreground">
                      {toPersianDigits(path.progress.completedCount)} از {toPersianDigits(path.progress.totalSteps)} مرحله
                      {path.progress.outdated ? " — بخش‌هایی به‌روز شده‌اند" : ""}
                    </p>
                    <button
                      type="button"
                      onClick={() => (expanded ? setDetail(null) : void openPath(path.id))}
                      className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border/80 px-3 text-sm font-medium text-foreground/80 transition-colors hover:bg-muted"
                    >
                      {detailBusy === path.id ? "در حال باز کردن…" : expanded ? "بستن مرحله‌ها" : "دیدن مرحله‌ها"}
                    </button>
                  </div>

                  {expanded && detail ? (
                    <ol className="mt-3 space-y-2 border-t border-border/70 pt-3">
                      {detail.steps.map((step, index) => (
                        <li
                          key={step.id}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/40 px-3 py-2"
                        >
                          <div className="min-w-0">
                            <p className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                              {step.completed ? (
                                <CircleCheckIcon className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                              ) : (
                                <span className="text-xs text-muted-foreground">{toPersianDigits(index + 1)}.</span>
                              )}
                              {step.title}
                            </p>
                            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{step.body}</p>
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            {step.completed ? (
                              <StatusBadge tone="positive">انجام شد</StatusBadge>
                            ) : step.kind === "tour" ? (
                              <button
                                type="button"
                                disabled={!tourRuntime || detailBusy === step.id}
                                onClick={() => void startStep(step, path.id)}
                                className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
                              >
                                <PlayIcon className="size-4" aria-hidden="true" />
                                {detailBusy === step.id ? "در حال شروع…" : "شروع تور"}
                              </button>
                            ) : step.kind === "article" ? (
                              <>
                                <Link
                                  href={`/knowledge/a/${encodeURIComponent(step.target)}`}
                                  className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border/80 px-3 text-sm font-medium text-foreground/80 transition-colors hover:bg-muted"
                                >
                                  <BookOpenIcon className="size-4" aria-hidden="true" />
                                  خواندن
                                </Link>
                                <button
                                  type="button"
                                  disabled={marking === step.id}
                                  onClick={() => void markStep(step, path.id)}
                                  className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border/80 px-3 text-sm font-medium text-foreground/80 transition-colors hover:bg-muted disabled:opacity-60"
                                >
                                  <CircleCheckIcon className="size-4" aria-hidden="true" />
                                  خواندم
                                </button>
                              </>
                            ) : (
                              <>
                                <Link
                                  href={step.target}
                                  className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border/80 px-3 text-sm font-medium text-foreground/80 transition-colors hover:bg-muted"
                                >
                                  <ArrowLeftIcon className="size-4" aria-hidden="true" />
                                  رفتن به صفحه
                                </Link>
                                <button
                                  type="button"
                                  disabled={marking === step.id}
                                  onClick={() => void markStep(step, path.id)}
                                  className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border/80 px-3 text-sm font-medium text-foreground/80 transition-colors hover:bg-muted disabled:opacity-60"
                                >
                                  <CircleCheckIcon className="size-4" aria-hidden="true" />
                                  انجام شد
                                </button>
                              </>
                            )}
                          </div>
                        </li>
                      ))}
                    </ol>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>

      <SectionCard
        title="پیشرفت به تفکیک برنامه"
        description="درصدها فقط از محتوای منتشرشده و مجاز برای نقش شما ساخته می‌شوند."
      >
        {progress.apps.length === 0 ? (
          <EmptyState icon={CompassIcon} title="هنوز برنامهٔ فعالی برای شما ثبت نشده است">
            وقتی برنامه‌ای فعال شود، پیشرفت آن همین‌جا دیده می‌شود.
          </EmptyState>
        ) : (
          <ul className="space-y-3">
            {progress.apps.map((app) => (
              <li key={app.key}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-foreground">{app.label}</p>
                  <p className="text-xs text-muted-foreground">
                    {toPersianDigits(app.completed)} از {toPersianDigits(app.eligible)} — {percentLabel(app.percent)}
                  </p>
                </div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className="h-full bg-primary" style={{ width: `${app.percent}%` }} />
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {app.sections
                    .map((section) => `${section.label} ${percentLabel(section.percent)}`)
                    .join(" · ")}
                </p>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {staff ? (
        <SectionCard
          title="گزارش کارکنان"
          description="فقط برای دارندهٔ دسترسی مدیریت تیم: چه کسی چه چیزی را باید یاد بگیرد و کجا مانده است."
          footer={
            <p className="text-xs text-muted-foreground">
              {toPersianDigits(staff.counts.completed)} کامل · {toPersianDigits(staff.counts.incomplete)} ناتمام
            </p>
          }
        >
          {staff.paths.length === 0 && staff.tours.length === 0 ? (
            <EmptyState icon={UsersIcon} title="هنوز سفارشی به کارکنان داده نشده است">
              از دکمهٔ آموزش هر صفحه یا از همین بخش می‌توانید مسیر و تور را به همکاران اختصاص دهید.
            </EmptyState>
          ) : (
            <DataTable caption="گزارش یادگیری کارکنان">
              <DataTableHead>
                <Th>همکار</Th>
                <Th>یادگیری</Th>
                <Th>وضعیت</Th>
                <Th>آخرین فعالیت</Th>
              </DataTableHead>
              <DataTableBody>
                {[...staff.paths, ...staff.tours].map((row) => (
                  <DataTableRow key={`${row.userId}:${row.pathId ?? row.tourId}`}>
                    <Td>{row.fullName ?? row.userId}</Td>
                    <Td>
                      <span className="text-muted-foreground">
                        {row.pathId ? "مسیر" : "تور"} ·{" "}
                      </span>
                      {row.title}
                    </Td>
                    <Td>
                      <StatusBadge
                        tone={
                          row.state === "completed"
                            ? "positive"
                            : row.state === "in_progress"
                              ? "active"
                              : "neutral"
                        }
                      >
                        {row.state === "unavailable" ? "در دسترس نیست" : STATUS_TEXT[row.state]}
                      </StatusBadge>
                      <span className="ms-2 text-xs text-muted-foreground">{percentLabel(row.percent)}</span>
                    </Td>
                    <Td>
                      <span className="text-xs text-muted-foreground">
                        {row.lastActiveAt
                          ? toPersianDigits(formatJalali(row.lastActiveAt, { withMonthName: true }))
                          : "—"}
                      </span>
                    </Td>
                  </DataTableRow>
                ))}
              </DataTableBody>
            </DataTable>
          )}
        </SectionCard>
      ) : null}

      {analytics ? (
        <SectionCard
          title="تحلیل تورها"
          description="شروع، تکمیل، رهاکردن و مرحله‌ای که افراد ناتمام در آن مانده‌اند — فقط شمارش تجمیعی، بدون نام یا دادهٔ کسب‌وکار."
          footer={
            <p className="text-xs text-muted-foreground">
              {toPersianDigits(analytics.totals.started)} شروع · {toPersianDigits(analytics.totals.completed)} تکمیل ·{" "}
              {toPersianDigits(analytics.totals.abandoned)} رهاشده · نرخ تکمیل{" "}
              {percentLabel(analytics.totals.completionPercent)}
            </p>
          }
        >
          {analytics.tours.length === 0 ? (
            <EmptyState icon={CompassIcon} title="هنوز کسی توری را شروع نکرده است">
              وقتی اعضا تورها را باز کنند، آمار شرکت، تکمیل و رهاکردن همین‌جا دیده می‌شود.
            </EmptyState>
          ) : (
            <DataTable caption="تحلیل تورهای یادگیری">
              <DataTableHead>
                <Th>تور</Th>
                <Th numeric>شروع</Th>
                <Th numeric>تکمیل</Th>
                <Th numeric>در جریان</Th>
                <Th numeric>رهاشده</Th>
                <Th>مرحلهٔ توقف</Th>
              </DataTableHead>
              <DataTableBody>
                {analytics.tours.map((row) => (
                  <DataTableRow key={row.tourId}>
                    <Td>
                      <span className="block text-sm font-semibold text-foreground">{row.title}</span>
                      {row.route ? (
                        <span className="block text-[11px] text-muted-foreground" dir="ltr">
                          {row.route}
                        </span>
                      ) : null}
                    </Td>
                    <Td numeric>{toPersianDigits(row.started)}</Td>
                    <Td numeric>
                      {toPersianDigits(row.completed)}{" "}
                      <span className="text-[11px] text-muted-foreground">{percentLabel(row.completionPercent)}</span>
                    </Td>
                    <Td numeric>{toPersianDigits(row.inProgress)}</Td>
                    <Td numeric>{toPersianDigits(row.abandoned)}</Td>
                    <Td>
                      {row.topStuckStep ? (
                        <span className="text-xs text-muted-foreground">
                          {row.topStuckStep.title ?? row.topStuckStep.stepId} ·{" "}
                          {toPersianDigits(row.topStuckStep.count)} نفر
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </Td>
                  </DataTableRow>
                ))}
              </DataTableBody>
            </DataTable>
          )}
        </SectionCard>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Link
          href="/knowledge"
          className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border/80 px-3 text-sm font-medium text-foreground/80 transition-colors hover:bg-muted"
        >
          <BookOpenIcon className="size-4" aria-hidden="true" />
          بازگشت به مقاله‌ها
        </Link>
        <button
          type="button"
          onClick={() => setReloadKey((value) => value + 1)}
          className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border/80 px-3 text-sm font-medium text-foreground/80 transition-colors hover:bg-muted"
        >
          <RotateCcwIcon className="size-4" aria-hidden="true" />
          به‌روزرسانی پیشرفت
        </button>
      </div>
    </div>
  );
}

export default function LearningCenterPage() {
  return (
    <PageShell className="min-w-0">
      <PageHeader
        title="مسیر یادگیری من"
        description="مسیرهای یادگیری، پیشرفت شما در هر برنامه و — اگر دسترسی مدیریت تیم دارید — وضعیت یادگیری همکاران."
      />
      <LearningCenter />
    </PageShell>
  );
}
