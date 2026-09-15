import { headers } from "next/headers";
import { after } from "next/server";
import { resolveClientIp } from "@/lib/login-rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";

interface LogOptions {
  resource?: string;
  resource_id?: string;
  actor_id?: string;
  actor_name?: string;
  details?: Record<string, unknown>;
}

async function getIp(): Promise<string | null> {
  try {
    const h = await headers();
    // 로그인 프록시(설계 180)와 같은 규칙으로 — 아니면 같은 요청의 LOGIN_FAILED(라우트 직접 insert)와
    // LOGIN(logger 경유)의 ip_address 가 앞단 프록시 구성에 따라 서로 달라진다(교차리뷰 M3).
    return resolveClientIp((name) => h.get(name));
  } catch {
    return null;
  }
}

async function resolveActor(authUid: string): Promise<{ id: string; name: string } | null> {
  try {
    const supabase = createAdminClient();
    const { data } = await supabase
      .from("employees")
      .select("id, name")
      .eq("auth_uid", authUid)
      .maybeSingle();
    return data;
  } catch {
    return null;
  }
}

/**
 * 감사로그 1건을 적는다.
 *
 * ★**응답을 보낸 뒤에도 끝나야 한다.** 예전에는 insert 를 만들어 놓고 `.then()` 만 걸어 두고
 *   (await 없이) 곧장 반환했다 — 서버리스에서는 응답 직후 함수가 얼거나 죽어서 그 insert 가
 *   **조용히 사라질 수 있다.** 감사로그가 "가끔 안 남는" 것은 없는 것과 같다(2026-08-09 리뷰 지적).
 *   → Next 의 `after()` 로 응답 뒤 실행을 **예약**한다. 호출부는 종전처럼 await 하지 않아도 된다.
 *   ⚠️절대 보장은 아니다 — `after` 작업도 그 라우트의 `maxDuration` 안에서만 돌고, `waitUntil` 이
 *     없는 환경에서는 아래 폴백(fire-and-forget)으로 떨어진다. 종전보다 훨씬 낫다는 뜻이지
 *     "무조건 남는다"는 뜻이 아니다.
 *
 * ★`headers()` 는 요청 스코프에서만 읽힌다 — `after()` 안에서 읽으면 늦다. **IP 는 미리 받아** 넘긴다.
 * ★insert 실패를 통째로 삼키지 않는다. 던지지는 않되(로그 때문에 본 작업이 죽으면 안 된다)
 *   `console.error` 로 남겨 Vercel 로그에서 보이게 한다.
 */
function writeLog(
  level: "INFO" | "ERROR",
  action: string,
  message: string,
  opts?: LogOptions
): void {
  // ★`headers()` 를 **지금**(요청 스코프에서) 호출해 둔다. await 는 after() 안에서 해도 된다 —
  //   늦으면 안 되는 것은 호출 시점이지 완료 시점이 아니다.
  const ipPromise = getIp();

  const task = async () => {
    try {
      const ip = await ipPromise;
      const supabase = createAdminClient();

      let actorId = opts?.actor_id ?? null;
      let actorName = opts?.actor_name ?? null;

      // If we have an auth_uid in actor_id but no name, resolve it
      if (actorId && !actorName) {
        const actor = await resolveActor(actorId);
        if (actor) {
          actorName = actor.name;
          actorId = actor.id;
        }
      }

      const { error } = await supabase.from("app_logs").insert({
        level,
        action,
        message,
        resource: opts?.resource ?? null,
        resource_id: opts?.resource_id ?? null,
        actor_id: actorId,
        actor_name: actorName,
        ip_address: ip,
        details: opts?.details ?? null,
      });
      if (error) console.error(`[app_logs] 기록 실패 — ${action}: ${error.message}`);
    } catch (e) {
      console.error(`[app_logs] 기록 실패 — ${action}:`, e);
    }
  };

  // ★after() 는 **동기로** 등록해야 한다 — 등록 전에 응답이 나가면 예약 자체가 무효다.
  try {
    after(task);
  } catch {
    // 요청 스코프 밖(스크립트·초기화 등)에서 부르면 after() 가 던진다 — 그땐 그냥 띄운다.
    void task();
  }
}

export function logInfo(action: string, message: string, opts?: LogOptions) {
  writeLog("INFO", action, message, opts);
}

export function logError(action: string, message: string, opts?: LogOptions) {
  writeLog("ERROR", action, message, opts);
}
