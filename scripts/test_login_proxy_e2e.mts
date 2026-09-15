import { createClient } from "@supabase/supabase-js";

// ★정적 import 금지 — .mts(ESM)에서 CJS 로 컴파일된 src/*.ts 를 정적으로 끌면 named export 를 못 찾는다(tsx 함정). 다른 테스트와 같이 동적 import.
const { LOGIN_FAIL_LIMIT } = await import("../src/lib/login-rate-limit");

const args = process.argv.slice(2);
const baseIndex = args.indexOf("--base");
const baseArg = args.find((arg) => arg.startsWith("--base="));
const baseUrl = (
  baseArg?.slice("--base=".length) ??
  (baseIndex >= 0 ? args[baseIndex + 1] : undefined) ??
  "http://localhost:3000"
).replace(/\/$/, "");
const cleanup = args.includes("--cleanup");
// 실행마다 고유 ID·고유 IP — 사전 정리·검증·--cleanup 이 **이 실행이 만든 행만** 다루게 한다
//   (교차리뷰: 고정 값은 다른 실행·동시 실행의 행까지 지우거나 세어 거짓 통과한다). IP 는 문서용 예약대역 203.0.113.0/24 안 난수.
const runTag = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const testIp = `203.0.113.${2 + Math.floor(Math.random() * 252)}`;
const testLoginId = `login-proxy-e2e-${runTag}`;

// ★dev 서버 전용. 운영 URL 로 돌리면 Vercel 이 x-forwarded-for 를 덮어써 스푸핑한 testIp 가 아니라
//   **실행자의 실제 IP** 로 실패 20회가 쌓여 본인이 15분 차단된다(교차리뷰 Medium). 정말 필요하면 --allow-remote.
if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(baseUrl) && !args.includes("--allow-remote")) {
  console.error(`❌ ${baseUrl} 은 localhost 가 아닙니다. 운영 URL 에 돌리면 실행자 IP 가 차단됩니다. 정말이면 --allow-remote.`);
  process.exit(1);
}

const loginId = process.env.E2E_LOGIN_ID;
const password = process.env.E2E_LOGIN_PASSWORD;
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!loginId || !password || !supabaseUrl || !serviceRoleKey) {
  console.error(
    "❌ E2E_LOGIN_ID, E2E_LOGIN_PASSWORD, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY가 필요합니다."
  );
  process.exit(1);
}

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let failed = 0;
async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`✅ ${name}`);
  } catch (error) {
    failed++;
    console.error(`❌ ${name}: ${(error as Error).message}`);
  }
}

async function requestLogin(
  requestLoginId: string,
  requestPassword: string,
  ip?: string
) {
  return fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(ip ? { "x-forwarded-for": ip } : {}),
    },
    body: JSON.stringify({ loginId: requestLoginId, password: requestPassword }),
  });
}

await step("ⓐ 오답 로그인이 401을 반환한다", async () => {
  const response = await requestLogin(testLoginId, "wrong-password");
  if (response.status !== 401) {
    throw new Error(`기대 401, 실제 ${response.status}`);
  }
});

await step("ⓑ 정답 로그인이 세션 쿠키와 함께 200을 반환한다", async () => {
  const response = await requestLogin(loginId, password);
  if (response.status !== 200) {
    throw new Error(`기대 200, 실제 ${response.status}`);
  }
  const setCookie = response.headers.get("set-cookie") ?? "";
  if (!/(?:^|[,;]\s*)sb-[^=]*=/.test(setCookie)) {
    throw new Error("set-cookie에서 sb- 접두 세션 쿠키를 찾지 못했습니다.");
  }
});

await step(`ⓒ 오답 ${LOGIN_FAIL_LIMIT}회 뒤 추가 요청이 429를 반환한다`, async () => {
  // 사전 정리 — 같은 IP 로 15분 안에 재실행되면 첫 시도부터 429 가 난다. testIp 는 이 실행의 난수 IP(예약대역)라
  //   실사용 행도, 다른 실행의 행도(충돌 확률 1/252) 사실상 없다.
  const { error: preCleanError } = await admin
    .from("app_logs")
    .delete()
    .eq("action", "LOGIN_FAILED")
    .eq("ip_address", testIp);
  if (preCleanError) throw preCleanError;

  for (let attempt = 0; attempt < LOGIN_FAIL_LIMIT; attempt++) {
    const response = await requestLogin(
      testLoginId,
      "wrong-password",
      testIp
    );
    if (response.status !== 401) {
      throw new Error(`${attempt + 1}회째 기대 401, 실제 ${response.status}`);
    }
  }

  const blocked = await requestLogin(
    testLoginId,
    "wrong-password",
    testIp
  );
  if (blocked.status !== 429) {
    throw new Error(`한도 초과 요청 기대 429, 실제 ${blocked.status}`);
  }
});

await step("ⓓ app_logs에 IP별 LOGIN_FAILED가 한도 이상 기록된다", async () => {
  const { count, error } = await admin
    .from("app_logs")
    .select("id", { count: "exact", head: true })
    .eq("ip_address", testIp)
    .eq("action", "LOGIN_FAILED");
  if (error) throw error;
  if ((count ?? 0) < LOGIN_FAIL_LIMIT) {
    throw new Error(`기대 최소 ${LOGIN_FAIL_LIMIT}건, 실제 ${count ?? 0}건`);
  }
});

if (cleanup) {
  await step("ⓔ 테스트 IP의 LOGIN_FAILED 로그를 정리한다", async () => {
    // ★IP 만으로 지우지 않는다 — 이 스크립트가 만든 행(login_id 고정값)만 대상. ⓐ의 XFF 없는 행도 함께 정리된다.
    const { count, error: countError } = await admin
      .from("app_logs")
      .select("id", { count: "exact", head: true })
      .eq("action", "LOGIN_FAILED")
      .eq("details->>login_id", testLoginId);
    if (countError) throw countError;
    console.log(`   삭제 전 ${count ?? 0}건`);

    const { error: deleteError } = await admin
      .from("app_logs")
      .delete()
      .eq("action", "LOGIN_FAILED")
      .eq("details->>login_id", testLoginId);
    if (deleteError) throw deleteError;
  });
}

process.exit(failed === 0 ? 0 : 1);
