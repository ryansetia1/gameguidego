import type { Metadata, Viewport } from "next";
import { Rubik } from "next/font/google";
import type { ReactNode } from "react";

import "./globals.css";
import { ServiceWorkerRegister } from "./sw-register";

const rubik = Rubik({
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-rubik",
  display: "swap",
});

const themeInitScript = `(function(){try{var t=localStorage.getItem("gg:theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t;}catch(e){}})();`;

export const metadata: Metadata = {
  title: "Game Guide Guru",
  description: "Find your way out when your adventure gets stuck.",
  applicationName: "Game Guide Guru",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Game Guide Guru",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f3f0e7" },
    { media: "(prefers-color-scheme: dark)", color: "#14181a" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={rubik.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className={rubik.className} suppressHydrationWarning>
        {children}
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
