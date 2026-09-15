import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // 세션 갱신: API 라우트 포함 모든 경로에서 수행
  // 네트워크/서버 오류 시에도 미들웨어가 죽지 않도록 try/catch
  let user = null;
  let authCallFailed = false;
  try {
    const result = await supabase.auth.getUser();
    user = result.data.user;
    // 네트워크/5xx 오류는 인증 실패가 아니라 일시적 장애로 간주
    if (result.error && isTransientAuthError(result.error)) {
      authCallFailed = true;
    }
  } catch {
    // Supabase 호출 자체가 실패 — 일시적 장애로 간주하고 통과시킴
    authCallFailed = true;
  }

  // API 라우트는 세션 갱신만 수행하고 리다이렉트하지 않음
  if (pathname.startsWith("/api/")) {
    return supabaseResponse;
  }

  // 인증 판정은 Supabase 가 실제로 검증한 user 로만 한다.
  // (설계 146) 예전엔 'sb-*auth-token' 쿠키가 있기만 하면 통과시켰는데, 쿠키 이름만
  // 맞추면 아무 값이나 넣어도 가드를 지나 대시보드가 200 으로 떴다(2026-08-04 실측).
  // 데이터는 RLS 가 막아 새지 않았지만 인증 가드로서는 무의미했다.
  // 일시 장애(authCallFailed)일 때만 통과시켜, 네트워크 오류로 강제 로그아웃되는 것은 계속 막는다.
  if (
    !user &&
    !authCallFailed &&
    !pathname.startsWith("/login") &&
    !pathname.startsWith("/auth")
  ) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return redirectWithSupabaseCookies(url, supabaseResponse);
  }

  // 로그인 상태로 /login 에 오면 대시보드로 돌려보낸다.
  // (설계 147) 예전엔 '/dashboard/workspace' 로 보냈는데 그런 라우트가 없어 404 였다
  // — 윤비서 템플릿 초기 커밋(38be67b)의 경로가 그대로 남아 있었다. 로그인한 채로
  // 사이트 루트를 열면 / → /login → /dashboard/workspace 로 이어져 404 를 만났다.
  // 착지점을 여기에 또 박지 않고 '/dashboard' 로 보낸다 — 실제 착지점은
  // src/app/dashboard/page.tsx 한 곳에서만 정한다(늘어나면 조용히 어긋난다).
  if (user && pathname.startsWith("/login")) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    return redirectWithSupabaseCookies(url, supabaseResponse);
  }

  return supabaseResponse;
}

function redirectWithSupabaseCookies(url: URL, supabaseResponse: NextResponse) {
  const response = NextResponse.redirect(url);

  supabaseResponse.cookies.getAll().forEach((cookie) => {
    response.cookies.set(cookie);
  });

  return response;
}

/** 일시적 장애(네트워크/5xx)인지 — 인증 실패와 구분 */
function isTransientAuthError(error: { message?: string; status?: number }): boolean {
  const msg = error.message?.toLowerCase() ?? "";
  if (msg.includes("fetch") || msg.includes("network") || msg.includes("timeout")) {
    return true;
  }
  if (error.status && error.status >= 500) return true;
  // 429(레이트리밋)도 인증 실패가 아니라 일시 장애다. (설계 147)
  // 미들웨어는 정적파일을 뺀 모든 요청에서 getUser() 를 호출하므로 RSC 프리페치가
  // 몰리면 429 가 날 수 있다. 예전엔 hasAuthCookie 예외가 이걸 흡수했는데
  // 설계 146 에서 그 예외를 없앴다 — 여기서 받지 않으면 멀쩡한 세션이 /login 으로 튕긴다.
  if (error.status === 429) return true;
  return false;
}

export const config = {
  matcher: [
    // 정적/공개 파일은 인증 가드에서 제외 — manifest·robots·sitemap·아이콘 등이
    // 비인증 상태에서 /login 으로 리다이렉트되지 않도록 한다.
    "/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|robots.txt|sitemap.xml|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|webmanifest)$).*)",
  ],
};
