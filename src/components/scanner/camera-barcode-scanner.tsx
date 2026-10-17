"use client";

/**
 * In-app camera barcode / QR scanner for inventory and retail flows.
 *
 * The browser BarcodeDetector API is still absent or incomplete in common
 * mobile browsers, notably Safari and Firefox. This scanner therefore uses a
 * dynamically loaded ZXing reader for every camera session: it works from the
 * ordinary video stream and reads both QR codes and retail barcodes without
 * making the phone depend on that experimental API. The decoder only loads
 * when this dialog is opened, keeping it out of the normal POS bundle.
 *
 * Handheld wedge scanners continue to work through the ordinary text field
 * this dialog sits next to; this only covers the phone-camera case.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { CameraIcon, SwitchCameraIcon, XIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { toPersianDigits } from "@/lib/digits";
import { normalizeBarcode } from "@/lib/barcode";
import { useNative } from "@/components/native/native-provider";
import { scanWithNativeScanner } from "@/lib/native/capabilities-client";

type CameraFacing = "environment" | "user";

type ScannerControls = {
  stop: () => void | Promise<void>;
};

function stopMediaStream(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

function safelyStopControls(controls: ScannerControls | null): void {
  try {
    const stopped = controls?.stop();
    if (stopped && typeof (stopped as PromiseLike<unknown>).then === "function") {
      void Promise.resolve(stopped).catch(() => undefined);
    }
  } catch {
    // Stopping an already-ended stream is harmless. Camera cleanup must never
    // prevent the dialog from closing or a new camera from starting.
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "";
}

function canRetryWithIdealFacing(error: unknown): boolean {
  return [
    "OverconstrainedError",
    "ConstraintNotSatisfiedError",
    "NotFoundError",
    "DevicesNotFoundError",
    "TypeError",
  ].includes(errorName(error));
}

function cameraErrorMessage(error: unknown): string {
  const name = errorName(error);
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
    return "اجازهٔ دسترسی به دوربین داده نشد. در تنظیمات مرورگر اجازه دهید و دوباره تلاش کنید.";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "دوربینی روی این دستگاه پیدا نشد.";
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return "دوربین در برنامه یا برگهٔ دیگری در حال استفاده است. آن را ببندید و دوباره تلاش کنید.";
  }
  return "راه‌اندازی دوربین ناموفق بود. دوباره تلاش کنید یا کد را از عکس بخوانید.";
}

function cameraConstraints(facing: CameraFacing, exact: boolean): MediaStreamConstraints {
  return {
    audio: false,
    video: {
      facingMode: exact ? { exact: facing } : { ideal: facing },
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
  };
}

/**
 * Prefer the rear (or selected front) camera exactly. Some older mobile
 * browsers reject that constraint even though they have a usable camera, so
 * retry once with an ideal preference before giving up.
 */
async function requestCameraStream(facing: CameraFacing): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia(cameraConstraints(facing, true));
  } catch (error) {
    if (!canRetryWithIdealFacing(error)) throw error;
    return navigator.mediaDevices.getUserMedia(cameraConstraints(facing, false));
  }
}

function streamHasTorch(stream: MediaStream): boolean {
  const track = stream.getVideoTracks()[0];
  try {
    const capabilities =
      typeof track?.getCapabilities === "function"
        ? (track.getCapabilities() as { torch?: boolean })
        : {};
    return Boolean(capabilities.torch);
  } catch {
    return false;
  }
}

/**
 * Load only after the operator opens the scanner. ZXing decodes regular
 * video/canvas frames and supports both QR and the POS barcode families.
 */
async function createReader() {
  const { BarcodeFormat, BrowserMultiFormatReader } = await import("@zxing/browser");
  const reader = new BrowserMultiFormatReader(undefined, {
    delayBetweenScanAttempts: 250,
    delayBetweenScanSuccess: 250,
  });
  reader.possibleFormats = [
    BarcodeFormat.QR_CODE,
    BarcodeFormat.EAN_13,
    BarcodeFormat.EAN_8,
    BarcodeFormat.UPC_A,
    BarcodeFormat.UPC_E,
    BarcodeFormat.CODE_128,
    BarcodeFormat.CODE_39,
    BarcodeFormat.CODE_93,
    BarcodeFormat.CODABAR,
    BarcodeFormat.ITF,
    BarcodeFormat.RSS_14,
    BarcodeFormat.RSS_EXPANDED,
    BarcodeFormat.DATA_MATRIX,
  ];
  return reader;
}

export function CameraBarcodeScanner({
  open,
  onClose,
  onScan,
  title = "اسکن بارکد / QR",
  description = "بارکد یا QR کالا را در کادر قرار دهید تا به‌صورت خودکار خوانده شود.",
}: {
  open: boolean;
  onClose: () => void;
  /** Fired once per successful read; the parent owns lookup/tally. */
  onScan: (code: string) => void;
  title?: string;
  description?: string;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const controlsRef = useRef<ScannerControls | null>(null);
  const sessionRef = useRef(0);
  const lastCodeRef = useRef("");
  const lastAtRef = useRef(0);
  const onScanRef = useRef(onScan);
  const onCloseRef = useRef(onClose);
  const manualInputId = useId();
  const imageInputId = useId();

  const [error, setError] = useState("");
  const [status, setStatus] = useState<"idle" | "starting" | "live" | "unsupported">("idle");
  const [torchOn, setTorchOn] = useState(false);
  const [hasTorch, setHasTorch] = useState(false);
  const [facing, setFacing] = useState<CameraFacing>("environment");
  const [manualCode, setManualCode] = useState("");
  const [imageBusy, setImageBusy] = useState(false);
  const [nativeBusy, setNativeBusy] = useState(false);
  const { capabilities, request } = useNative();
  const hasNativeScanner = capabilities["barcode.scan"].provider === "native";

  // Keep the scan lifecycle stable if a parent re-renders while its dialog is
  // open. Restarting a phone camera because an inventory list refreshed is
  // disruptive and can make Safari revoke the stream.
  useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const stop = useCallback(() => {
    sessionRef.current += 1;
    safelyStopControls(controlsRef.current);
    controlsRef.current = null;

    const stream = streamRef.current;
    streamRef.current = null;
    stopMediaStream(stream);

    const video = videoRef.current;
    if (video) video.srcObject = null;

    setTorchOn(false);
    setHasTorch(false);
    setImageBusy(false);
  }, []);

  /** Stop the camera before handing a code to the calling inventory/POS flow. */
  const acceptRead = useCallback(
    (raw: string): boolean => {
      const code = normalizeBarcode(raw);
      if (!code) return false;

      // A held code must not flood a parent while the decoder is yielding more
      // than one frame. The camera also stops after a read, but retaining this
      // guard covers a late callback from a just-stopped reader.
      const now = Date.now();
      if (code === lastCodeRef.current && now - lastAtRef.current < 1600) return false;
      lastCodeRef.current = code;
      lastAtRef.current = now;

      stop();
      onScanRef.current(code);
      onCloseRef.current();
      return true;
    },
    [stop],
  );

  const startReader = useCallback(
    async (session: number, stream: MediaStream) => {
      try {
        if (sessionRef.current !== session) return;
        const video = videoRef.current;
        if (!video) throw new Error("Camera preview is unavailable");

        const reader = await createReader();
        if (sessionRef.current !== session) return;

        const controls = await reader.decodeFromStream(stream, video, (result, decodeError, callbackControls) => {
          if (sessionRef.current !== session) {
            safelyStopControls(callbackControls);
            return;
          }

          const raw = result?.getText();
          if (raw && acceptRead(raw)) {
            // `acceptRead` normally reaches these controls through the ref.
            // The first callback can arrive before decodeFromStream resolves,
            // so stop the callback's controls too.
            safelyStopControls(callbackControls);
            return;
          }

          // NotFound/format/checksum errors are normal while an operator is
          // aiming the camera. Any other error ends ZXing's loop, so make the
          // recovery path visible instead of leaving a black preview.
          const kind =
            decodeError && typeof (decodeError as { getKind?: () => string }).getKind === "function"
              ? (decodeError as { getKind: () => string }).getKind()
              : errorName(decodeError);
          if (decodeError && !["NotFoundException", "FormatException", "ChecksumException"].includes(kind)) {
            stop();
            setStatus("unsupported");
            setError("خواندن خودکار کد متوقف شد. دوباره تلاش کنید یا کد را از عکس بخوانید.");
          }
        });

        if (sessionRef.current !== session) {
          safelyStopControls(controls);
          return;
        }
        controlsRef.current = controls;
        setStatus("live");
      } catch {
        if (sessionRef.current !== session) return;
        stop();
        setStatus("unsupported");
        setError("خواندن خودکار کد آغاز نشد. دوباره تلاش کنید یا کد را از عکس بخوانید.");
      }
    },
    [acceptRead, stop],
  );

  const start = useCallback(
    async (nextFacing: CameraFacing) => {
      stop();
      const session = sessionRef.current;
      setError("");
      setStatus("starting");

      // Let a quick close (and React's development effect replay) cancel this
      // session before a browser permission prompt is opened.
      await Promise.resolve();
      if (sessionRef.current !== session) return;

      if (window.isSecureContext === false) {
        setStatus("unsupported");
        setError("برای استفاده از دوربین، سامانه را با نشانی امن HTTPS باز کنید.");
        return;
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus("unsupported");
        setError("دسترسی به دوربین در این مرورگر ممکن نیست. کد را از عکس بخوانید یا دستی وارد کنید.");
        return;
      }

      let stream: MediaStream;
      try {
        stream = await requestCameraStream(nextFacing);
      } catch (cameraError) {
        if (sessionRef.current !== session) return;
        setStatus("unsupported");
        setError(cameraErrorMessage(cameraError));
        return;
      }

      // The dialog may have closed while the browser's permission sheet was
      // open. Never leave that late stream holding the phone camera.
      if (sessionRef.current !== session) {
        stopMediaStream(stream);
        return;
      }

      streamRef.current = stream;
      setFacing(nextFacing);
      setHasTorch(streamHasTorch(stream));
      await startReader(session, stream);
    },
    [startReader, stop],
  );

  useEffect(() => {
    if (!open) {
      setStatus("idle");
      setManualCode("");
      setError("");
      setImageBusy(false);
      lastCodeRef.current = "";
      return;
    }

    void start("environment");
    return stop;
  }, [open, start, stop]);

  async function toggleTorch() {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track || typeof track.applyConstraints !== "function") return;
    const next = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] });
      setTorchOn(next);
    } catch {
      setHasTorch(false);
    }
  }

  function submitManual(e: React.FormEvent) {
    e.preventDefault();
    acceptRead(manualCode);
  }

  async function scanImage(file: File) {
    const session = sessionRef.current;
    setError("");
    setImageBusy(true);
    let objectUrl: string | null = null;

    try {
      const reader = await createReader();
      if (sessionRef.current !== session) return;
      objectUrl = URL.createObjectURL(file);
      const result = await reader.decodeFromImageUrl(objectUrl);
      if (sessionRef.current !== session) return;
      if (!acceptRead(result.getText())) {
        setError("کدی در تصویر پیدا نشد. عکس واضح و نزدیک از بارکد یا QR انتخاب کنید.");
      }
    } catch {
      if (sessionRef.current === session) {
        setError("کدی در تصویر پیدا نشد. عکس واضح و نزدیک از بارکد یا QR انتخاب کنید.");
      }
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      if (sessionRef.current === session) setImageBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-h-[92vh] overflow-y-auto p-0 sm:max-w-lg">
        <DialogHeader className="border-b border-border/80 px-4 py-3 sm:px-5">
          <DialogTitle className="flex items-center gap-2 text-base">
            <CameraIcon className="size-4 shrink-0 text-amber-700 dark:text-amber-300" aria-hidden="true" />
            {title}
          </DialogTitle>
          <DialogDescription className="text-xs leading-5">{description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 p-4 sm:p-5">
          <div className="relative overflow-hidden rounded-2xl border border-border bg-black">
            <video
              ref={videoRef}
              className="aspect-[3/4] w-full object-cover"
              playsInline
              muted
              autoPlay
            />
            {/* Aiming frame — visual only; detection runs on the full frame. */}
            <div
              className="pointer-events-none absolute inset-[18%] rounded-xl border-2 border-amber-400/90 dark:border-amber-500/50 shadow-[0_0_0_9999px_rgb(0_0_0/0.35)]"
              aria-hidden="true"
            />
            {status === "starting" ? (
              <p className="absolute inset-x-0 bottom-3 text-center text-xs text-white/90" aria-live="polite">
                در حال آماده‌سازی دوربین…
              </p>
            ) : null}
            {status === "live" ? (
              <p className="absolute inset-x-0 bottom-3 text-center text-xs text-white/90" aria-live="polite">
                بارکد یا QR را داخل کادر نگه دارید
              </p>
            ) : null}
          </div>

          {error ? (
            <p className="rounded-xl border border-rose-200 dark:border-rose-800 bg-rose-50 dark:bg-rose-500/15 px-3 py-2 text-xs leading-5 text-rose-800 dark:text-rose-200" role="alert">
              {error}
            </p>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              className="min-h-11 flex-1"
              onClick={() => void start(facing === "environment" ? "user" : "environment")}
              disabled={status === "starting"}
            >
              <SwitchCameraIcon className="size-4" aria-hidden="true" />
              تعویض دوربین
            </Button>
            {status === "unsupported" ? (
              <Button
                type="button"
                variant="outline"
                className="min-h-11 flex-1"
                onClick={() => void start(facing)}
              >
                تلاش دوباره
              </Button>
            ) : null}
            {hasTorch ? (
              <Button
                type="button"
                variant="outline"
                className="min-h-11 flex-1"
                aria-pressed={torchOn}
                onClick={() => void toggleTorch()}
              >
                {torchOn ? "خاموش کردن فلاش" : "روشن کردن فلاش"}
              </Button>
            ) : null}
            <Button type="button" variant="ghost" className="min-h-11" onClick={onClose}>
              <XIcon className="size-4" aria-hidden="true" />
              بستن
            </Button>
          </div>

          <input
            ref={imageInputRef}
            id={imageInputId}
            className="sr-only"
            type="file"
            accept="image/*"
            capture="environment"
            tabIndex={-1}
            onChange={(event) => {
              const file = event.target.files?.[0];
              // Selecting the same photo again must still fire change.
              event.target.value = "";
              if (file) void scanImage(file);
            }}
          />
          {hasNativeScanner ? (
            <Button
              type="button"
              className="min-h-11 w-full"
              disabled={nativeBusy}
              onClick={async () => {
                setNativeBusy(true);
                setError("");
                try {
                  const res = await scanWithNativeScanner(request, { prompt: title });
                  if (res.value) acceptRead(res.value);
                } catch {
                  setError("اسکنر بومی اندروید بسته شد یا کدی خوانده نشد. می‌توانید از دوربین صفحه یا ورود دستی استفاده کنید.");
                } finally {
                  setNativeBusy(false);
                }
              }}
            >
              <CameraIcon className="size-4" aria-hidden="true" />
              {nativeBusy ? "در حال اسکن بومی اندروید…" : "اسکن سریع با اسکنر بومی اندروید"}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            className="min-h-11 w-full"
            disabled={imageBusy}
            onClick={() => imageInputRef.current?.click()}
          >
            <CameraIcon className="size-4" aria-hidden="true" />
            {imageBusy ? "خواندن تصویر…" : "خواندن بارکد یا QR از عکس"}
          </Button>

          <form onSubmit={submitManual} className="space-y-2 rounded-xl border border-border bg-muted/80 p-3">
            <label className="block text-xs font-medium text-foreground/80" htmlFor={manualInputId}>
              ورود دستی کد
              <span className="ms-1 font-normal text-muted-foreground">
                (اگر دوربین نخواند)
              </span>
            </label>
            <div className="flex gap-2">
              <input
                id={manualInputId}
                dir="ltr"
                className="min-h-11 flex-1 rounded-lg border border-border bg-white dark:bg-card px-3 text-sm outline-none focus-visible:border-amber-500 dark:focus-visible:border-amber-500/60 focus-visible:ring focus-visible:ring-amber-400/40 dark:focus-visible:ring-amber-400/40"
                value={manualCode}
                onChange={(e) => setManualCode(e.target.value)}
                placeholder="مثلاً 6260123456789"
                autoComplete="off"
                inputMode="text"
              />
              <Button type="submit" className="min-h-11 shrink-0" disabled={!manualCode.trim()}>
                تأیید
              </Button>
            </div>
            {lastCodeRef.current ? (
              <p className="text-[11px] text-muted-foreground">
                آخرین خوانده‌شده: {toPersianDigits(lastCodeRef.current)}
              </p>
            ) : null}
          </form>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Compact trigger that opens the camera scanner dialog. */
export function CameraScanTrigger({
  onScan,
  label = "دوربین",
  className,
  disabled,
  title,
  description,
}: {
  onScan: (code: string) => void;
  label?: string;
  className?: string;
  disabled?: boolean;
  title?: string;
  description?: string;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  return (
    <>
      <Button
        type="button"
        variant="outline"
        className={className ?? "min-h-11 gap-1.5"}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <CameraIcon className="size-4" aria-hidden="true" />
        {label}
      </Button>
      <CameraBarcodeScanner
        open={open}
        onClose={close}
        onScan={onScan}
        title={title}
        description={description}
      />
    </>
  );
}
