import { NextRequest, NextResponse } from "next/server";
import { loginIdToAuthEmail } from "@/lib/auth-email";
import { createAdminClient } from "@/lib/supabase/admin";
import { logInfo, logError } from "@/lib/logger";
import { createRouteAuthErrorResponse, requireRouteUser } from "@/lib/route-auth";

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, department, position, email, phone, login_id } = body;

    if (!name?.trim()) {
      return NextResponse.json(
        { error: "이름은 필수 항목입니다" },
        { status: 400 }
      );
    }

    if (!login_id?.trim()) {
      return NextResponse.json(
        { error: "아이디는 필수 항목입니다" },
        { status: 400 }
      );
    }

    const normalizedLoginId = login_id.trim();
    // 아이디에 '@' 를 허용하면 프로필 변경으로 자기 Auth 이메일을 임의 주소로 바꾸는 경로가 열린다(설계 179 리뷰).
    // 로그인 화면의 '@ 그대로' 규칙은 이메일 직접 로그인용이지 아이디 형식이 아니다.
    if (!/^[A-Za-z0-9._-]+$/.test(normalizedLoginId)) {
      return NextResponse.json(
        { error: "아이디는 영문·숫자·. _ - 만 쓸 수 있습니다" },
        { status: 400 }
      );
    }
    const newEmail = loginIdToAuthEmail(normalizedLoginId);

    const { user, authUnavailable } = await requireRouteUser();
    if (!user) {
      return createRouteAuthErrorResponse(authUnavailable);
    }

    const adminSupabase = createAdminClient();

    // 현재 직원 조회
    const { data: currentEmp } = await adminSupabase
      .from("employees")
      .select("id, login_id")
      .eq("auth_uid", user.id)
      .maybeSingle();

    if (!currentEmp) {
      return NextResponse.json(
        { error: "직원 정보를 찾을 수 없습니다" },
        { status: 404 }
      );
    }

    // login_id 중복 체크 (본인 제외)
    if (normalizedLoginId !== currentEmp.login_id) {
      const { data: existing } = await adminSupabase
        .from("employees")
        .select("id")
        .eq("login_id", normalizedLoginId)
        .neq("id", currentEmp.id)
        .maybeSingle();

      if (existing) {
        return NextResponse.json(
          { error: "이미 사용 중인 아이디입니다" },
          { status: 409 }
        );
      }
    }

    const loginIdChanged = normalizedLoginId !== currentEmp.login_id;
    const authEmailChanged = loginIdChanged && user.email !== newEmail;

    // login_id가 변경된 경우 auth email을 먼저 업데이트
    if (authEmailChanged) {
      const { error: authError } = await adminSupabase.auth.admin.updateUserById(user.id, {
        email: newEmail,
      });

      if (authError) {
        logError("UPDATE_PROFILE", `로그인 아이디 변경 실패: ${authError.message}`, {
          actor_id: user.id,
          resource: "employee",
          resource_id: currentEmp.id,
        });
        return NextResponse.json(
          { error: `로그인 아이디 변경에 실패했습니다: ${authError.message}` },
          { status: 400 }
        );
      }
    }

    // 직원 정보 업데이트 (employee_type 제외)
    const { error } = await adminSupabase
      .from("employees")
      .update({
        name: name.trim(),
        department: department?.trim() || null,
        position: position?.trim() || null,
        email: email?.trim() || null,
        phone: phone?.trim() || null,
        login_id: normalizedLoginId,
      })
      .eq("id", currentEmp.id);

    if (error) {
      let rollbackFailed = false;
      if (authEmailChanged) {
        const { error: rollbackError } = await adminSupabase.auth.admin.updateUserById(user.id, {
          email: user.email!,
        });
        if (rollbackError) {
          rollbackFailed = true;
          logError("UPDATE_PROFILE", `Auth 이메일 롤백 실패: ${rollbackError.message}`, {
            actor_id: user.id,
            resource: "employee",
            resource_id: currentEmp.id,
          });
        }
      }

      logError("UPDATE_PROFILE", `프로필 수정 실패: ${error.message}`, {
        actor_id: user.id,   // ★없으면 actor_name 이 null 로 남아 "누가 바꿨는지" 를 못 가린다
        resource: "employee",
        resource_id: currentEmp.id,
      });
      const partial = authEmailChanged && rollbackFailed
        ? " (로그인 이메일은 이미 새 아이디로 바뀌었을 수 있습니다 — 새 아이디로 로그인해 보고 관리자에게 알리세요)"
        : "";
      return NextResponse.json({ error: error.message + partial }, { status: 400 });
    }

    logInfo("UPDATE_PROFILE", "프로필 수정 완료", {
      actor_id: user.id,   // ★없으면 actor_name 이 null 로 남아 "누가 바꿨는지" 를 못 가린다
      resource: "employee",
      resource_id: currentEmp.id,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    logError(
      "UPDATE_PROFILE",
      `프로필 수정 중 서버 오류: ${error instanceof Error ? error.message : String(error)}`
    );
    return NextResponse.json(
      { error: "서버 오류가 발생했습니다" },
      { status: 500 }
    );
  }
}
