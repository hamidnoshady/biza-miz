"use client";

/**
 * Issue #908 — the drawn signature.
 *
 * A `canvas` with pointer events, captured as a PNG data URL and sent to the
 * server with the OTP code. Three details are deliberate:
 *
 *  - **HiDPI scaling.** The canvas is sized in device pixels and drawn in CSS
 *    pixels, so a signature on a phone retina screen is as smooth as the same
 *    stroke in a desktop browser — a blurry signature is a dispute waiting to
 *    happen.
 *  - **A white-ish paper fill.** The PNG is composited onto the document, which
 *    may be dark-themed in the sender's browser; transparent strokes on a
 *    transparent background would be invisible there. The fill uses the theme
 *    token so it stays legible in both themes.
 *  - **Pointer capture**, so a stroke that leaves the canvas still completes
 *    instead of ending at the edge.
 */
import { useEffect, useRef, useState } from "react";

export function SignaturePad({
  onChange,
  disabled,
}: {
  /** Receives the PNG data URL, or `null` once the pad is cleared. */
  onChange: (dataUrl: string | null) => void;
  disabled?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const strokes = useRef(0);
  const [empty, setEmpty] = useState(true);

  const context = () => canvasRef.current?.getContext("2d") ?? null;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    const width = canvas.clientWidth || 520;
    const height = canvas.clientHeight || 180;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const ctx = context();
    if (!ctx) return;
    ctx.scale(ratio, ratio);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#111827";
  }, []);

  const point = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const start = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (disabled) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const ctx = context();
    if (!ctx) return;
    const { x, y } = point(event);
    ctx.beginPath();
    ctx.moveTo(x, y);
    drawing.current = true;
  };

  const move = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current || disabled) return;
    const ctx = context();
    if (!ctx) return;
    const { x, y } = point(event);
    ctx.lineTo(x, y);
    ctx.stroke();
    strokes.current += 1;
    if (strokes.current > 4) setEmpty(false);
  };

  const finish = () => {
    if (!drawing.current) return;
    drawing.current = false;
    if (strokes.current <= 4) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    onChange(canvas.toDataURL("image/png"));
  };

  const clear = () => {
    const canvas = canvasRef.current;
    const ctx = context();
    if (!canvas || !ctx) return;
    const width = canvas.clientWidth || 520;
    const height = canvas.clientHeight || 180;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = "#111827";
    strokes.current = 0;
    setEmpty(true);
    onChange(null);
  };

  return (
    <div className="space-y-2">
      <div className="rounded-xl border border-border bg-card p-2">
        <canvas
          ref={canvasRef}
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={finish}
          onPointerLeave={finish}
          onPointerCancel={finish}
          className="h-44 w-full touch-none rounded-lg"
          aria-label="کادر امضای دست‌نویس"
          role="img"
        />
      </div>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {empty ? "با انگشت یا ماوس در کادر بالا امضا کنید." : "امضا ثبت شد؛ می‌توانید دوباره بکشید."}
        </p>
        <button
          type="button"
          onClick={clear}
          disabled={disabled}
          className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
        >
          پاک‌کردن و امضای دوباره
        </button>
      </div>
    </div>
  );
}
