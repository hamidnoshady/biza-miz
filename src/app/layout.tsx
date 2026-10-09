import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import localFont from "next/font/local";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { PrintJobModal } from "@/app/dashboard/print-job-modal";
import { PwaRegister } from "@/components/pwa-register";
import { NativeProvider } from "@/components/native/native-provider";
import { CLOUD_EMBED_MARKER_SCRIPT } from "@/lib/cloud-embed";

const vazirmatn = localFont({
  src: "./fonts/Vazirmatn-Variable.woff2",
  variable: "--font-vazirmatn",
  display: "swap",
  weight: "100 900",
});

export const metadata: Metadata = {
  title: "پلتفرم مدیریت کسب‌وکار",
  description: "Business Suite — multi-app SaaS platform for business management",
  // Next 15 auto-links /manifest.webmanifest from manifest.ts; these add the
  // icon + iOS/standalone hints so the installed app looks and launches native.
  applicationName: "Business Suite",
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    // iOS ignores manifest icons entirely and only reads this link tag; it also
    // applies its own corner rounding, so this points at the non-rounded source.
    apple: "/apple-touch-icon.png",
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Business Suite",
  },
};

export const viewport: Viewport = {
  themeColor: "#0f172a",
  width: "device-width",
  initialScale: 1,
  // Zoom is locked on touch devices. A POS is a fixed-layout app driven by
  // thumbs: an accidental pinch or a double-tap on a price used to leave the
  // screen scaled and horizontally scrolled, with the fixed bottom bar and the
  // sticky headers half off-screen and no obvious way back. Desktop zoom
  // (Ctrl+wheel, browser zoom) is untouched — this only governs the visual
  // viewport. iOS Safari ignores `user-scalable` outside standalone mode, so the
  // CSS `touch-action` rule in globals.css and the gesture guard in
  // pwa-register.tsx close that gap; all three exist for one behaviour.
  maximumScale: 1,
  userScalable: false,
};


export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  
  return (
    <html lang="fa" dir="rtl" className={vazirmatn.variable} suppressHydrationWarning>
      <body className="font-sans">
        {/* Phase 46: inside the desktop's cloud pane, hide this page's own sidebar before it paints. */}
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: CLOUD_EMBED_MARKER_SCRIPT }} />
        <ThemeProvider nonce={nonce}>
          <NativeProvider>
            {children}
            <Toaster position="bottom-center" dir="rtl" />
            <PrintJobModal />
            <PwaRegister />
          </NativeProvider>
        </ThemeProvider>

      </body>
    </html>
  );
}
