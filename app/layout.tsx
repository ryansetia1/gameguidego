import type { Metadata, Viewport } from "next";
import { Rubik } from "next/font/google";
import type { ReactNode } from "react";
import { Analytics } from "@vercel/analytics/next";

import "./globals.css";
import { ServiceWorkerRegister } from "./sw-register";

const rubik = Rubik({
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-rubik",
  display: "swap",
});

const themeInitScript = `(function(){try{var t=localStorage.getItem("gg:theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t;}catch(e){}})();`;

// iOS ignores manifest background_color; a colored launch screen needs one
// pre-rendered image per device resolution. Portrait-only curated set (files in
// public/splash, solid #00FFAA + centered logo). CSS px = device px / dpr.
const APPLE_SPLASH: { w: number; h: number; dpr: number }[] = [
  { w: 1290, h: 2796, dpr: 3 },
  { w: 1179, h: 2556, dpr: 3 },
  { w: 1170, h: 2532, dpr: 3 },
  { w: 1284, h: 2778, dpr: 3 },
  { w: 1125, h: 2436, dpr: 3 },
  { w: 1080, h: 2340, dpr: 3 },
  { w: 828, h: 1792, dpr: 2 },
  { w: 750, h: 1334, dpr: 2 },
  { w: 1536, h: 2048, dpr: 2 },
  { w: 1668, h: 2388, dpr: 2 },
  { w: 2048, h: 2732, dpr: 2 },
];

export const metadata: Metadata = {
  title: "Game Guide Go",
  description: "Find your way out when your adventure gets stuck.",
  applicationName: "Game Guide Go",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Game Guide Go",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#00FFAA" },
    { media: "(prefers-color-scheme: dark)", color: "#14181a" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={rubik.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        {APPLE_SPLASH.map(({ w, h, dpr }) => (
          <link
            key={`${w}x${h}`}
            rel="apple-touch-startup-image"
            media={`screen and (device-width: ${w / dpr}px) and (device-height: ${h / dpr}px) and (-webkit-device-pixel-ratio: ${dpr}) and (orientation: portrait)`}
            href={`/splash/apple-splash-${w}-${h}.png`}
          />
        ))}
      </head>
      <body className={rubik.className} suppressHydrationWarning>
        {children}
        <ServiceWorkerRegister />
        <Analytics />
      </body>
    </html>
  );
}
