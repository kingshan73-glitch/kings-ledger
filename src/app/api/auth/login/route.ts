// 설계 180: 로그인 판정과 감사로그를 서버 프록시 한곳에서 처리한다.
// - 브라우저가 Supabase 로 직접 가던 시절엔 실패 로그가 `/api/logs`(인증 필수) 에서 401 로 유실됐다.
// - 제한은 **IP 기준**이다 — 계정 잠금은 유일한 관리자 계정을 외부에서 잠그는 DoS 가 된다(예전에 그래서 뺐다).
// - 429 응답은 기록하지 않는다 — 차단 로그가 다시 차단 횟수를 늘리는 증식을 막는다.
// - ★실패 기록은 응답 **전에 await** 한다(교차리뷰 High) — `after()` 로 미루면 다음 요청이 직전 실패를 못 세어
//   "20회"가 실제로는 20+동시요청수 가 된다. 성공 로그만 `after()`(logInfo) 로 미룬다.
// - 한계: 공개 anon 키로 GoTrue 를 직접 두드리는 시도는 이 로그·제한 밖이다(Supabase 자체 제한만 남는다).
import { NextRequest, NextResponse } from "next/server";

import { loginIdToAuthEmail } from "@/lib/auth-email";
import {
  normalizeLoginInput,
  rateLimitWindowStart,
  resolveClientIp,
  shouldBlockLogin,
} from "@/lib/login-rate-limit";
import { logError, logInfo } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

const INVALID_CREDENTIALS = "로그인 ID 또는 비밀번호가 올바르지 않습니다.";
const TOO_MANY_ATTEMPTS = "로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.";

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "요청 형식이 올바르지 않습니다." },
      { status: 400 }
    );
  }

  const input = normalizeLoginInput(body);
  if (!input.ok) {
    return NextResponse.json({ error: input.error }, { status: 400 });
  }

  const { loginId, password } = input;
  const ip = resolveClientIp((name) => request.headers.get(name));
  const admin = createAdminClient();

  // ── 레이트리밋: 같은 IP(없으면 null 버킷)의 최근 창 안 실패 건수 ─────────────────────
  // 조회 실패는 fail-open(0건으로 진행) — 로그 조회 장애가 본인 로그인을 막으면 안 된다(설계 180 §1).
  // 대신 그 사실을 감사로그에 남긴다(교차리뷰 Medium: console 만으로는 "제한이 꺼져 있었다"를 못 본다).
  let recentFailures = 0;
  try {
    let query = admin
      .from("app_logs")
      .select("id", { count: "exact", head: true })
      .eq("action", "LOGIN_FAILED")
      .gte("created_at", rateLimitWindowStart(new Date()));
    query = ip ? query.eq("ip_address", ip) : query.is("ip_address", null);
    const { count, error } = await query;
    if (error) throw error;
    recentFailures = count ?? 0;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[login] 레이트리밋 로그 조회 실패(fail-open): ${reason}`);
    logError("LOGIN_RATE_CHECK_FAILED", "로그인 레이트리밋 조회 실패 — 제한 없이 진행", {
      details: { reason },
    });
  }

  if (shouldBlockLogin(recentFailures)) {
    return NextResponse.json({ error: TOO_MANY_ATTEMPTS }, { status: 429 });
  }

  // ── 인증: SSR 쿠키 클라이언트라 성공하면 세션 쿠키가 응답에 실린다 ──────────────────
  const supabase = await createClient();
  const { data, error: signInError } = await supabase.auth.signInWithPassword({
    email: loginIdToAuthEmail(loginId),
    password,
  });

  if (signInError) {
    // ★await — 레이트리밋이 이 행을 세므로 응답보다 먼저 커밋돼야 한다. 실패 응답이 몇십 ms 늦는 건 무방하다.
    // 응답엔 사유를 싣지 않는다(계정 열거 방지). login_id 는 details 에만(ID 칸에 비번을 잘못 친 경우의 노출면을 줄인다).
    const { error: insertError } = await admin.from("app_logs").insert({
      level: "ERROR",
      action: "LOGIN_FAILED",
      message: "Login failed",
      ip_address: ip,
      details: {
        login_id: loginId,
        reason: signInError.message,
        status: signInError.status ?? null,
      },
    });
    if (insertError) {
      // 기록 실패도 fail-open(401 은 그대로 준다) — 쓰기 장애가 본인 로그인까지 막으면 안 된다. 그동안 제한이 안 쌓이는 건 감수(설계 180 §1).
      console.error(`[login] LOGIN_FAILED 기록 실패(fail-open): ${insertError.message}`);
    }
    return NextResponse.json({ error: INVALID_CREDENTIALS }, { status: 401 });
  }

  if (!data.session) {
    // user 만 오고 세션이 없는 경로(MFA 승급 대기 등). 쿠키가 안 실렸는데 200 을 주면 화면이 말없이 로그인으로 되돌아온다.
    logError("LOGIN", "로그인 응답에 세션이 없어 실패 처리", {
      actor_id: data.user?.id,
      details: { login_id: loginId },
    });
    return NextResponse.json(
      { error: "세션을 만들지 못했습니다. 잠시 후 다시 시도해 주세요." },
      { status: 500 }
    );
  }

  logInfo("LOGIN", "Login succeeded", { actor_id: data.user.id });
  return NextResponse.json({ success: true });
}
