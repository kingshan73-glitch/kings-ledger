"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

import { createClient } from "@/lib/supabase/client";

const SESSION_REFRESH_INTERVAL_MS = 10 * 60 * 1000; // 10분

export function SessionGuard() {
  const router = useRouter();
  const redirecting = useRef(false);

  useEffect(() => {
    const supabase = createClient();

    function goToLogin() {
      if (redirecting.current) return;
      redirecting.current = true;
      router.replace("/login");
    }

    // 세션 확인 및 갱신 — 네트워크 오류는 무시하고 인증 실패만 처리
    async function ensureSession() {
      try {
        const { data, error } = await supabase.auth.getSession();
        if (data.session) return; // 유효한 세션 존재

        // 세션이 없으면 refresh 시도
        const { data: refreshed, error: refreshError } =
          await supabase.auth.refreshSession();
        if (refreshed.session) return; // 갱신 성공

        // refresh token도 없으면 → 진짜 로그아웃
        // 단, 네트워크 오류면 리다이렉트하지 않음
        if (isNetworkError(error) || isNetworkError(refreshError)) return;
        goToLogin();
      } catch {
        // 네트워크 오류 등 예외는 무시 — 다음 주기에 재시도
      }
    }

    // 초기 세션 확인
    ensureSession();

    // 10분마다 세션 자동 갱신 — JWT 만료 방지
    const refreshTimer = setInterval(async () => {
      try {
        await supabase.auth.refreshSession();
      } catch {
        // 네트워크 오류 무시
      }
    }, SESSION_REFRESH_INTERVAL_MS);

    // 탭 활성화 시 세션 갱신 — 장시간 비활성 후 복귀 대응
    function handleVisibilityChange() {
      if (document.visibilityState === "visible") {
        ensureSession();
      }
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);

    // 온라인 복귀 시 세션 갱신
    function handleOnline() {
      ensureSession();
    }
    window.addEventListener("online", handleOnline);

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT") {
        goToLogin();
        return;
      }
      // 세션이 사라졌을 때 복구 시도
      if (!session) {
        setTimeout(() => {
          void ensureSession();
        }, 0);
      }
    });

    return () => {
      clearInterval(refreshTimer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("online", handleOnline);
      subscription.unsubscribe();
    };
  }, [router]);

  return null;
}

/** 네트워크/서버 오류인지 판별 — 인증 실패와 구분 */
function isNetworkError(
  error: { message?: string; status?: number } | null | undefined
): boolean {
  if (!error) return false;
  const msg = error.message?.toLowerCase() ?? "";
  if (msg.includes("fetch") || msg.includes("network") || msg.includes("failed to fetch")) {
    return true;
  }
  // 5xx 서버 오류도 일시적인 문제로 간주
  if (error.status && error.status >= 500) return true;
  return false;
}
