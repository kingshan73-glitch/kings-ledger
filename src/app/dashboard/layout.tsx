"use client";

import { MobileSidebar, Sidebar } from "@/components/sidebar";
import { SessionGuard } from "@/components/session-guard";
import { BackButton } from "@/components/back-button";
import { NavHistoryRecorder } from "@/components/nav-history";
import { MaskingProvider } from "@/components/masking-provider";
import { MaskModeIndicator } from "@/components/mask-mode-indicator";
import { cn } from "@/lib/utils";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const isFullWidth = false;
  // ★설계 121 에서 현금흐름·수집함만 1600px 로 넓혔던 것을 되돌렸다(설계 122).
  //   그때 넓힌 이유는 "전 컬럼 등간격이라 출금계좌 한 열만 넓힐 수 없어서" 였는데,
  //   등간격 규칙 자체가 폐기되어(열 폭을 내용에 맞춘다) 그 이유가 사라졌다.
  //   표가 내용 폭으로 줄어든 지금은 1280px 안에 들어와, 넓히면 오른쪽 빈 공간만 커진다.

  return (
    <MaskingProvider>
      <div className="flex h-screen overflow-hidden bg-background">
        <SessionGuard />
        <NavHistoryRecorder />
        <MaskModeIndicator />
        <Sidebar />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <MobileSidebar />
          <div className="flex min-h-0 flex-1 overflow-hidden">
            <BackButton />
            <main
              className={cn(
                "min-h-0 flex-1 overflow-x-hidden",
                isFullWidth ? "overflow-y-hidden" : "overflow-y-auto px-4 py-4 md:px-6 md:py-6"
              )}
            >
              <div
                className={cn(
                  "w-full",
                  isFullWidth ? "h-full" : "mx-auto max-w-7xl"
                )}
              >
                {children}
              </div>
            </main>
          </div>
        </div>
      </div>
    </MaskingProvider>
  );
}
