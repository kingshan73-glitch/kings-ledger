// 첫 관리자 계정을 만드는 스크립트입니다.
// Supabase Auth 사용자 + employees 테이블 행을 한 번에 생성합니다.
//
// 사용법:
//   npm run setup:admin                  # 기본값: 로그인ID=admin, 비밀번호 자동 생성
//   npm run setup:admin -- myid mypw      # 로그인ID/비밀번호 직접 지정
//
// 실행 후 출력되는 [로그인 ID]와 [비밀번호]로 로그인하세요.

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

// 강의/학습용 기본 관리자 계정 (외우기 쉽게 고정). 로그인 후 마이페이지에서 꼭 변경하세요.
const DEFAULT_LOGIN_ID = "admin";
const DEFAULT_PASSWORD = "jadong!"; // 6자 이상(Supabase Auth 최소 정책) 충족
// ⚠️ 이미 쓰던 계정에 재실행하면 비밀번호를 이 값으로 "덮어쓴다"(아래 updateUserById).
//    비밀번호를 바꿔 쓰는 중이면 .env.local 의 ADMIN_PASSWORD 가 우선 적용되므로 원복되지 않는다.

// .env.local 을 직접 읽어 환경변수로 로드 (Node 버전 무관)
function loadEnvFile(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile(".env.local");

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const domain = process.env.NEXT_PUBLIC_AUTH_EMAIL_DOMAIN || "example.com";

if (!url || !serviceKey) {
  console.error(
    "\n[오류] .env.local 에 NEXT_PUBLIC_SUPABASE_URL 과 SUPABASE_SERVICE_ROLE_KEY 가 필요합니다.\n" +
      "      Supabase 프로젝트의 Project Settings > API 에서 값을 복사해 .env.local 에 넣어주세요.\n"
  );
  process.exit(1);
}

const loginId = (process.argv[2] || process.env.ADMIN_LOGIN_ID || DEFAULT_LOGIN_ID).trim();
const name = (process.env.ADMIN_NAME || "관리자").trim();
const password = process.argv[3] || process.env.ADMIN_PASSWORD || DEFAULT_PASSWORD;
const email = loginId.includes("@") ? loginId : `${loginId}@${domain}`;

const supabase = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function findAuthUserByEmail(targetEmail) {
  // 사용자가 많지 않은 템플릿 환경 기준으로 첫 페이지에서 탐색
  const { data, error } = await supabase.auth.admin.listUsers({ page: 1, perPage: 200 });
  if (error) throw new Error(error.message);
  return data.users.find((u) => u.email?.toLowerCase() === targetEmail.toLowerCase()) || null;
}

async function main() {
  console.log(`\n관리자 계정 생성 중...  (로그인 ID: ${loginId}, 이메일: ${email})`);

  // 1) Supabase Auth 사용자 생성 (이미 있으면 비밀번호만 갱신)
  let authUserId;
  const created = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (created.error) {
    const msg = created.error.message || "";
    const alreadyExists =
      msg.toLowerCase().includes("already") || created.error.status === 422;
    if (!alreadyExists) throw new Error(msg);

    const existing = await findAuthUserByEmail(email);
    if (!existing) throw new Error(`이미 등록된 이메일이지만 사용자를 찾지 못했습니다: ${email}`);
    authUserId = existing.id;
    const upd = await supabase.auth.admin.updateUserById(authUserId, {
      password,
      email_confirm: true,
    });
    if (upd.error) throw new Error(upd.error.message);
    console.log("기존 Auth 사용자의 비밀번호를 갱신했습니다.");
  } else {
    authUserId = created.data.user.id;
    console.log("Auth 사용자를 생성했습니다.");
  }

  // 2) employees 행 생성/갱신 (관리자 권한)
  const { data: existingEmp, error: selErr } = await supabase
    .from("employees")
    .select("id")
    .eq("login_id", loginId)
    .maybeSingle();
  if (selErr) throw new Error(selErr.message);

  if (existingEmp) {
    const { error } = await supabase
      .from("employees")
      .update({ auth_uid: authUserId, email, employee_type: "관리자", is_active: true })
      .eq("id", existingEmp.id);
    if (error) throw new Error(error.message);
    console.log("기존 직원 레코드를 관리자 계정으로 갱신했습니다.");
  } else {
    const { error } = await supabase.from("employees").insert({
      name,
      login_id: loginId,
      email,
      employee_type: "관리자",
      is_active: true,
      auth_uid: authUserId,
    });
    if (error) throw new Error(error.message);
    console.log("관리자 직원 레코드를 생성했습니다.");
  }

  console.log("\n========================================");
  console.log("  🔑 관리자 계정 준비 완료!");
  console.log("  👤 로그인 ID : " + loginId);
  console.log("  🔒 비밀번호  : " + password);
  console.log("========================================");
  console.log("\n이제 `npm run dev` 후 위 정보로 로그인하세요.");
  console.log("👉 로그인 후 왼쪽 사이드바 맨 아래 '내 이름'을 눌러 마이페이지에서 비밀번호를 꼭 변경하세요.\n");
}

main().catch((err) => {
  console.error("\n[오류] 관리자 생성 실패:", err.message);
  console.error("Supabase 마이그레이션(supabase db push)이 먼저 적용되었는지 확인하세요.\n");
  process.exit(1);
});
