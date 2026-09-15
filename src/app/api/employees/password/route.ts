import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@supabase/supabase-js";
import { logInfo, logError } from "@/lib/logger";
import { createRouteAuthErrorResponse, requireRouteUser } from "@/lib/route-auth";

// PATCH: 본인 비밀번호 변경
export async function PATCH(request: NextRequest) {
  try {
    const { current_password, new_password } = await request.json();

    if (!current_password || !new_password) {
      return NextResponse.json(
        { error: "현재 비밀번호와 새 비밀번호를 입력해주세요" },
        { status: 400 }
      );
    }

    if (new_password.length < 6) {
      return NextResponse.json(
        { error: "새 비밀번호는 6자 이상이어야 합니다" },
        { status: 400 }
      );
    }

    const { user, authUnavailable } = await requireRouteUser();

    if (!user) {
      return createRouteAuthErrorResponse(authUnavailable);
    }

    if (!user.email) {
      return NextResponse.json({ error: "인증된 이메일이 없습니다" }, { status: 400 });
    }

    // 현재 비밀번호 확인 (세션에 영향 없는 별도 클라이언트 사용)
    const verifyClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );
    const { error: signInError } = await verifyClient.auth.signInWithPassword({
      email: user.email,
      password: current_password,
    });

    if (signInError) {
      // 실패도 기록한다 — 안 남기면 "바꿨는데 안 바뀌었다" 를 나중에 가릴 수 없다(app_logs 흔적 0건).
      // 화면 문구는 '불일치' 하나지만 실제로는 인증 서비스 장애·요청 과다일 수도 있어 원문을 남긴다.
      logInfo("CHANGE_PASSWORD", "비밀번호 변경 거부 — 현재 비밀번호 확인 실패", {
        actor_id: user.id,   // ★없으면 actor_name 이 null 로 남아 "누가 바꿨는지" 를 못 가린다

        resource: "employee",
        details: { auth_uid: user.id, reason: signInError.message },
      });
      return NextResponse.json(
        { error: "현재 비밀번호가 일치하지 않습니다" },
        { status: 400 }
      );
    }

    // 현재 비밀번호가 맞다고 확인된 뒤에야 '같은 값인지' 를 따진다.
    // 순서가 반대면 두 칸에 같은 오답을 넣었을 때 "현재 비밀번호와 같다" 는 틀린 안내가 나가고
    // 불일치 기록도 안 남는다(2026-08-09 배포 전 교차리뷰 지적).
    // 같은 값으로 바꾸면 Supabase 는 성공을 돌려주지만 실제로는 아무것도 안 바뀐다 —
    // 자동완성이 새 비밀번호 칸까지 옛 값으로 채우면 "변경 완료" 를 보고도 옛 값이 그대로 통한다.
    if (current_password === new_password) {
      logInfo("CHANGE_PASSWORD", "비밀번호 변경 거부 — 현재 비밀번호와 같은 값", {
        actor_id: user.id,   // ★없으면 actor_name 이 null 로 남아 "누가 바꿨는지" 를 못 가린다

        resource: "employee",
        details: { auth_uid: user.id },
      });
      return NextResponse.json(
        { error: "새 비밀번호가 현재 비밀번호와 같습니다. 다른 값으로 정해주세요" },
        { status: 400 }
      );
    }

    // Admin client로 비밀번호 변경
    const adminSupabase = createAdminClient();
    const { error } = await adminSupabase.auth.admin.updateUserById(user.id, {
      password: new_password,
    });

    if (error) {
      logError("CHANGE_PASSWORD", `비밀번호 변경 실패: ${error.message}`, {
        actor_id: user.id,   // ★없으면 actor_name 이 null 로 남아 "누가 바꿨는지" 를 못 가린다

        resource: "employee",
        details: { auth_uid: user.id },
      });
      // Supabase 원문은 로그에만 남긴다 — 화면에 그대로 띄우면 비밀번호 정책·인증 공급자
      // 설정 같은 내부 정보가 새어 나간다(배포 전 교차리뷰 지적).
      return NextResponse.json(
        { error: "비밀번호를 변경하지 못했습니다. 잠시 후 다시 시도해주세요" },
        { status: 400 }
      );
    }

    await adminSupabase
      .from("employees")
      .update({
        failed_login_count: 0,
        failed_login_window_started_at: null,
        last_failed_login_at: null,
      })
      .eq("auth_uid", user.id);

    logInfo("CHANGE_PASSWORD", "비밀번호 변경 완료", {
      actor_id: user.id,   // ★없으면 actor_name 이 null 로 남아 "누가 바꿨는지" 를 못 가린다

      resource: "employee",
      details: { auth_uid: user.id },
    });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: "서버 오류가 발생했습니다" },
      { status: 500 }
    );
  }
}
