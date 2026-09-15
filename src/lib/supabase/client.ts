import { createBrowserClient } from "@supabase/ssr";

function instantiate() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

let browserClientSingleton: ReturnType<typeof instantiate> | null = null;

// 브라우저에서 매 페이지 마운트마다 새 클라이언트를 만들면 이전 인스턴스의 auto-refresh 타이머와
// onAuthStateChange 구독이 그대로 살아 있어 navigator.lock 을 점유한다. 다음 페이지의
// getSession() 워밍업이 이 락 해제를 기다리면서 "로딩중" 이 길게 노출되는 현상이 발생한다.
// 브라우저에서는 항상 같은 인스턴스를 재사용해 락 경합과 메모리 누수를 차단한다.
export function createClient() {
  if (typeof window === "undefined") {
    return instantiate();
  }
  if (!browserClientSingleton) {
    browserClientSingleton = instantiate();
  }
  return browserClientSingleton;
}

export async function clearClientSession() {
  const supabase = createClient();
  await supabase.auth.signOut();
  localStorage.removeItem("rememberMe");
}

// fetchData 시작 시점에 호출하는 세션 워밍업.
// 모바일 백그라운드 복귀 직후 JWT refresh 경합을 방지하기 위해 도입했지만,
// navigator.lock 이 다른 호출에 점유돼 있으면 무기한 대기할 수 있다.
// 짧은 타임아웃을 둬서 워밍업이 막혀도 페이지 로딩이 멈추지 않도록 한다.
export async function warmupSession(
  supabase: ReturnType<typeof createClient>,
  timeoutMs = 1500
): Promise<void> {
  try {
    await Promise.race([
      supabase.auth.getSession(),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  } catch {
    // 세션 조회 실패는 무시 — 후속 쿼리에서 쿠키 기반 인증이 처리한다.
  }
}
