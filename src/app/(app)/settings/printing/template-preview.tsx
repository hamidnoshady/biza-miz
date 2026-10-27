"use client";

/**
 * A secure, canonical preview of the production HTML.
 *
 * Thumbnail mode scales the whole measured document into a fixed, scroll-free
 * stage. Expanded mode keeps the natural paper ratio and lets the operator
 * scroll/zoom; only that expanded viewport has scrollbars. Content size is
 * reported from a sandboxed, opaque-origin iframe by a tiny fixed bridge, so
 * long thermal rolls are measured rather than clipped to an invented 400mm.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { getPaperDimensions, PAPERS, renderPrintTemplate, type PrintDocumentData, type PrintTemplate } from "@/lib/print-template";

const MM_TO_PX = 96 / 25.4;
const EXPANDED_PADDING_PX = 16;
const THUMBNAIL_STAGE_PX = 244;
const THUMBNAIL_INSET_PX = 12;
const THUMBNAIL_CROP_SCALE = 0.6;
const CROP_MASK = "linear-gradient(to bottom, #000 calc(100% - 48px), transparent)";
const CROP_FADE_STYLE = { maskImage: CROP_MASK, WebkitMaskImage: CROP_MASK } as const;

type PreviewMode = "thumbnail" | "expanded";
interface PreviewReport {
  width: number;
  height: number;
  pageTops: number[];
}

const BRIDGE_STYLE = `<style>html,body{overflow:hidden!important;scrollbar-width:none!important}::-webkit-scrollbar{display:none!important}</style>`;
const BRIDGE_SCRIPT = `
(() => {
  const report = () => {
    const pages = Array.from(document.querySelectorAll('.page'));
    if (!pages.length) return;
    const bounds = pages.map((page) => ({ top: page.offsetTop, height: page.offsetHeight, width: page.offsetWidth }));
    const width = Math.max(1, ...bounds.map((page) => page.width));
    const height = Math.max(1, ...bounds.map((page) => page.top + page.height));
    window.parent.postMessage({ kind: 'biza-print-preview-size', width, height, pageTops: bounds.map((page) => page.top), pageHeights: bounds.map((page) => page.height) }, '*');
  };
  const scheduleReport = () => requestAnimationFrame(report);
  if (window.ResizeObserver) {
    const observer = new ResizeObserver(scheduleReport);
    observer.observe(document.documentElement);
    if (document.body) observer.observe(document.body);
    document.querySelectorAll('.page').forEach((page) => observer.observe(page));
  }
  window.addEventListener('load', scheduleReport, { once: true });
  document.addEventListener('DOMContentLoaded', scheduleReport, { once: true });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(scheduleReport).catch(() => {});
  scheduleReport();
  setTimeout(scheduleReport, 100);
  setTimeout(scheduleReport, 500);
})();
`;

function withPreviewBridge(html: string, nonce: string | null): string {
  // A srcDoc document inherits the parent's enforced CSP. Give the bridge the
  // page's nonce in both policies instead of relying on unsafe-inline, which
  // cannot override that inherited policy.
  const safeNonce = nonce && /^[A-Za-z0-9+/_-]+={0,2}$/.test(nonce) ? nonce : null;
  const scriptSource = safeNonce ? `'nonce-${safeNonce}'` : "'none'";
  const bridgeCsp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src ${scriptSource}; font-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'" />`;
  const bridgeScript = `<script${safeNonce ? ` nonce="${safeNonce}"` : ""}>${BRIDGE_SCRIPT}</script>`;
  const headEnd = html.toLowerCase().lastIndexOf("</head>");
  if (headEnd < 0) return `${bridgeCsp}${BRIDGE_STYLE}${html}${bridgeScript}`;
  return `${html.slice(0, headEnd)}${bridgeCsp}${BRIDGE_STYLE}${bridgeScript}${html.slice(headEnd)}`;
}

function isPreviewReport(value: unknown): value is PreviewReport & { pageHeights: number[] } {
  if (!value || typeof value !== "object") return false;
  const report = value as Partial<PreviewReport> & { kind?: unknown; pageHeights?: unknown };
  return report.kind === "biza-print-preview-size" && Number.isFinite(report.width) && Number(report.width) > 0 &&
    Number.isFinite(report.height) && Number(report.height) > 0 && Array.isArray(report.pageTops) &&
    report.pageTops.every((top) => Number.isFinite(top) && top >= 0) && Array.isArray(report.pageHeights) &&
    report.pageHeights.every((height) => Number.isFinite(height) && height > 0);
}

export function TemplatePreview({
  template,
  data,
  className,
  maxHeightPx,
  mode = "expanded",
  scale = 1,
  pageIndex = 0,
  onPageCountChange,
}: {
  template: PrintTemplate;
  data: PrintDocumentData;
  className?: string;
  /** Thumbnail stage height (default 244) or an optional cap for the expanded viewer. */
  maxHeightPx?: number;
  mode?: PreviewMode;
  /** Expanded viewer zoom relative to fit-to-width; ignored for thumbnails. */
  scale?: number;
  /** Expanded viewer's zero-based page position. */
  pageIndex?: number;
  onPageCountChange?: (count: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [mounted, setMounted] = useState(mode === "expanded");
  const [report, setReport] = useState<PreviewReport | null>(null);
  const [failed, setFailed] = useState(false);
  const [cspNonce, setCspNonce] = useState<string | null>(null);
  // The srcDoc carries the page nonce in its own CSP, so no frame may load
  // before the nonce has been read: a frame already loaded with `script-src
  // 'none'` keeps its dead bridge when the srcDoc changes a moment later.
  const [nonceRead, setNonceRead] = useState(false);
  const html = useMemo(() => renderPrintTemplate(template, data), [template, data]);
  const srcDoc = useMemo(() => withPreviewBridge(html, cspNonce), [cspNonce, html]);
  const paper = PAPERS[template.paper];
  const dimensions = getPaperDimensions(template.paper, template.options.orientation);
  const pageWidthPx = Math.max(1, Math.round(dimensions.widthMm * MM_TO_PX));
  const fixedPageHeightPx = dimensions.heightMm === null ? null : dimensions.heightMm * MM_TO_PX;

  useEffect(() => {
    // The app shell's nonced script is emitted from the same middleware
    // request that supplied the enforced CSP. The browser intentionally hides
    // nonce attributes, but the DOM `nonce` property remains readable.
    const nonce = Array.from(document.scripts).find((script) => script.nonce)?.nonce ?? null;
    setCspNonce(nonce);
    setNonceRead(true);
  }, []);

  useEffect(() => {
    if (mode === "expanded") {
      setMounted(true);
      return;
    }
    const element = containerRef.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setMounted(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setMounted(true);
        observer.disconnect();
      }
    }, { rootMargin: "400px 0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [mode]);

  const live = mounted && nonceRead;

  useEffect(() => {
    setReport(null);
    setFailed(false);
    if (!live) return;
    const timeout = window.setTimeout(() => setFailed(true), 10_000);
    return () => window.clearTimeout(timeout);
  }, [live, srcDoc]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const measure = () => setContainerWidth(element.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [mode, maxHeightPx]);

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow || !isPreviewReport(event.data)) return;
      const { width, height, pageTops, pageHeights } = event.data;
      const safeWidth = Math.min(5000, Math.max(pageWidthPx, Math.ceil(width)));
      const safeTops = pageTops.map((top) => Math.min(100_000, Math.max(0, Math.floor(top))));
      const safeHeights = pageHeights.map((pageHeight) => Math.min(100_000, Math.max(1, Math.ceil(pageHeight))));
      const actualHeight = Math.min(100_000, Math.max(1, Math.ceil(height)));
      const navTops: number[] = [];
      safeTops.forEach((top, index) => {
        const sectionHeight = safeHeights[index] ?? actualHeight;
        const physicalPages = fixedPageHeightPx === null ? 1 : Math.max(1, Math.ceil(sectionHeight / fixedPageHeightPx));
        for (let page = 0; page < physicalPages && navTops.length < 50; page += 1) {
          navTops.push(Math.floor(top + page * (fixedPageHeightPx ?? sectionHeight)));
        }
      });
      const next = { width: safeWidth, height: Math.max(actualHeight, safeTops.at(-1) ?? 0), pageTops: navTops.length ? navTops : [0] };
      setReport((current) => current && current.width === next.width && current.height === next.height &&
        current.pageTops.length === next.pageTops.length && current.pageTops.every((top, index) => top === next.pageTops[index])
        ? current
        : next);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [fixedPageHeightPx, pageWidthPx]);

  const naturalWidth = report?.width ?? pageWidthPx;
  const naturalHeight = report?.height ?? (fixedPageHeightPx ?? Math.round(340 * MM_TO_PX));
  const stageHeightPx = maxHeightPx ?? THUMBNAIL_STAGE_PX;
  const stageInnerWidth = Math.max(0, containerWidth - THUMBNAIL_INSET_PX * 2);
  const stageInnerHeight = Math.max(0, stageHeightPx - THUMBNAIL_INSET_PX * 2);
  const widthScale = Math.min(1, stageInnerWidth / naturalWidth);
  const fitScale = Math.min(widthScale, stageInnerHeight / naturalHeight);
  // A long thermal roll fitted whole into the stage is a 25% sliver nobody can
  // read. Past a tall-enough ratio the thumbnail shows the top of the document
  // at a legible scale and fades out; the monitor dialog still shows all of it.
  const cropped = mode === "thumbnail" && fitScale < widthScale * 0.55;
  const thumbnailScale = cropped ? Math.max(fitScale, Math.min(widthScale, THUMBNAIL_CROP_SCALE)) : fitScale;
  const frameScale = mode === "thumbnail"
    ? thumbnailScale
    : Math.min(1, Math.max(0.1, (containerWidth - EXPANDED_PADDING_PX * 2) / naturalWidth)) * Math.min(2, Math.max(0.5, scale));
  const scaledWidth = naturalWidth * frameScale;
  const scaledHeight = naturalHeight * frameScale;
  const visibleHeight = mode === "thumbnail" ? Math.min(scaledHeight, stageInnerHeight) : scaledHeight;

  useEffect(() => {
    if (mode !== "expanded" || !report || !containerRef.current) return;
    const top = report.pageTops[Math.max(0, Math.min(pageIndex, report.pageTops.length - 1))] ?? 0;
    containerRef.current.scrollTo({ top: EXPANDED_PADDING_PX + top * frameScale, behavior: "smooth" });
  }, [frameScale, mode, pageIndex, report]);

  useEffect(() => {
    if (mode === "expanded" && report) onPageCountChange?.(report.pageTops.length);
  }, [mode, onPageCountChange, report]);

  const frame = report ? (
    <div
      // The page is scaled from its top-left corner; in an RTL parent an
      // iframe wider than this box would overflow to the left instead and the
      // scaled content would land outside it, leaving a blank sheet.
      dir="ltr"
      className="mx-auto overflow-hidden rounded-sm bg-white dark:bg-white shadow-[0_1px_7px_rgba(0,0,0,0.22)]"
      // A cropped thumbnail fades out at the bottom (a mask, not a background)
      // so it reads as "the document continues", not as a truncated page.
      style={{ width: scaledWidth, height: visibleHeight, ...(cropped ? CROP_FADE_STYLE : {}) }}
    >
      <iframe
        ref={iframeRef}
        title={`پیش‌نمایش چاپ ${template.name}`}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        srcDoc={srcDoc}
        className="block border-0 bg-white dark:bg-white"
        style={{
          width: naturalWidth,
          height: naturalHeight,
          maxWidth: "none",
          transform: `scale(${frameScale})`,
          transformOrigin: "top left",
          overflow: "hidden",
        }}
      />
    </div>
  ) : null;

  if (mode === "thumbnail") {
    return (
      <div
        ref={containerRef}
        className={`relative flex min-h-0 w-full items-center justify-center overflow-hidden rounded-xl border border-border/80 bg-muted/40 ${className ?? ""}`}
        style={{ height: stageHeightPx }}
        aria-label={`تصویر کامل قالب ${template.name}`}
      >
        {!report && !failed ? (
          <div className="absolute inset-2 z-10 flex items-center justify-center">
            <Skeleton aria-label="آماده‌سازی پیش‌نمایش" className="h-full w-full rounded-lg" />
          </div>
        ) : null}
        {report ? frame : null}
        {failed && !report ? (
          <p role="status" className="px-4 text-center text-xs text-muted-foreground">تصویر پیش‌نمایش آماده نشد؛ جزئیات قالب و امکان انتخاب همچنان در دسترس است.</p>
        ) : null}
        {live && !report ? (
          <iframe
            ref={iframeRef}
            title={`اندازه‌گیری پیش‌نمایش ${template.name}`}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            srcDoc={srcDoc}
            aria-hidden="true"
            tabIndex={-1}
            className="pointer-events-none fixed left-0 top-0 border-0 opacity-0"
            style={{ width: pageWidthPx, height: Math.max(160, Math.min(420, fixedPageHeightPx ?? 320)) }}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`h-full w-full overflow-auto overscroll-contain rounded-xl border border-border/80 bg-muted/40 p-3 sm:p-4 ${className ?? ""}`}
      style={{ maxHeight: maxHeightPx, minHeight: 220 }}
      aria-label={`پیش‌نمایش کامل قالب ${template.name}`}
    >
      {!report && !failed ? (
        <div className="flex min-h-64 items-center justify-center">
          <Skeleton aria-label="آماده‌سازی پیش‌نمایش" className="h-64 w-full rounded-lg" />
        </div>
      ) : null}
      {report ? frame : null}
      {failed && !report ? (
        <p role="status" className="p-6 text-center text-sm text-muted-foreground">پیش‌نمایش آماده نشد؛ اصل قالب دست‌نخورده باقی مانده است. دوباره باز کنید یا به پشتیبانی اطلاع دهید.</p>
      ) : null}
      {live && !report ? (
        <iframe
          ref={iframeRef}
          title={`اندازه‌گیری پیش‌نمایش ${template.name}`}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          srcDoc={srcDoc}
          aria-hidden="true"
          tabIndex={-1}
          className="pointer-events-none fixed left-0 top-0 border-0 opacity-0"
          style={{ width: pageWidthPx, height: Math.max(160, Math.min(420, fixedPageHeightPx ?? 320)) }}
        />
      ) : null}
    </div>
  );
}
