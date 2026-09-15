import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import { Toaster } from "sonner";

import { AppActivityTracker } from "@/components/app-activity-tracker";

import "./globals.css";

export const metadata: Metadata = {
  title: "kings의 가계부",
  description: "kings의 가계부 - 개인 가계 관리",
  // 개인 가계부라 공개 색인 대상이 없다. robots.txt(=src/app/robots.ts) 와 별개로
  // 페이지 자체에도 noindex 를 박아 둔다 — 외부에서 링크가 걸려도 색인되지 않게. (설계 146)
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: { index: false, follow: false },
  },
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/apple-icon.svg", sizes: "180x180", type: "image/svg+xml" }],
  },
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = {
  themeColor: "#0d6e6e",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <head>
        <link
          rel="stylesheet"
          as="style"
          crossOrigin="anonymous"
          href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css"
        />
      </head>
      <body className="antialiased">
        <Suspense fallback={null}>
          <AppActivityTracker />
        </Suspense>
        {children}
        <Toaster richColors position="bottom-right" closeButton />
      </body>
    </html>
  );
}
