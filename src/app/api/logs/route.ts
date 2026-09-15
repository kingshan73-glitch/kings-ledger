// 감사 로그 기록 전용 엔드포인트.
//
// ★GET(로그 열람)은 제거했다. 역할 검사 없이 service_role 로 app_logs 전체를 반환해서,
//   로그인만 하면 다른 사용자의 login_id·auth_uid 까지 그대로 읽혔다. 이 빌드(개인 가계부)에
//   로그 열람 화면이 없어 호출부도 없었다 — 남겨둘 이유가 없다.
//   다시 필요해지면 관리자 역할 검사를 넣어 되살릴 것.
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createRouteAuthErrorResponse, requireRouteUser } from "@/lib/route-auth";

const SERVER_ONLY_ACTIONS = new Set(["LOGIN_FAILED", "LOGIN_RATE_CHECK_FAILED"]);

export async function POST(request: NextRequest) {
  try {
    const { user, authUnavailable } = await requireRouteUser();
    if (!user) {
      return createRouteAuthErrorResponse(authUnavailable);
    }

    const body = await request.json();
    const { action, message, level, resource, resource_id, details } = body;

    if (!action || !message) {
      return NextResponse.json(
        { error: "action and message are required" },
        { status: 400 }
      );
    }

    // ★서버 전용 action 은 클라이언트가 못 쓴다 — 설계 180 이후 LOGIN_FAILED 는 레이트리밋의 **입력**이라,
    //   로그인한 사용자(또는 XSS)가 여기로 20건 넣으면 자기 IP 를 15분 잠글 수 있었다(배포 전 교차리뷰 M2).
    if (typeof action !== "string" || SERVER_ONLY_ACTIONS.has(action)) {
      return NextResponse.json({ error: "action not allowed" }, { status: 400 });
    }

    const logLevel = level === "ERROR" ? "ERROR" : "INFO";
    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;

    let actorId: string | null = null;
    let actorName: string | null = null;

    const admin = createAdminClient();

    // Resolve actor from authenticated user
    const { data: emp } = await admin
      .from("employees")
      .select("id, name")
      .eq("auth_uid", user.id)
      .maybeSingle();
    if (emp) {
      actorId = emp.id;
      actorName = emp.name;
    }
    const { error } = await admin.from("app_logs").insert({
      level: logLevel,
      action,
      message,
      resource: resource ?? null,
      resource_id: resource_id ?? null,
      actor_id: actorId,
      actor_name: actorName,
      ip_address: ip,
      details: details ?? null,
    });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
