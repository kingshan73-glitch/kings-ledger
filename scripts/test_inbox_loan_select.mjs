// 회귀 테스트: 수집함 확정 시 대출 선택 (설계 94).
// UI를 거치지 않고 RPC를 직접 호출해 검증한다. 마커 데이터만 만들고 끝나면 전부 삭제한다.
//  1) 대출을 고르고 확정 → 거래에 loan_id + '대출상환' 카테고리가 함께 들어간다
//  2) 되돌리기 → 거래 삭제 + guessed_loan_id 는 수집함에 남는다(재확정 시 재사용)
//  3) 아무것도 안 고르면 둘 다 null (기존 동작 보존)
//  4~5) 카드대금 선택 → 그 카테고리 / 대출과 동시 지정 시 대출이 우선
//  6) 재확정 시 남은 선택이 그대로 다시 연결된다
// 실행: node scripts/test_inbox_loan_select.mjs
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const MARKER = "LOAN_SELECT_TEST";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; })
);
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const user = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });

const step = (m) => console.log(`\n▶ ${m}`);
const assert = (cond, msg) => { if (!cond) throw new Error(`검증 실패: ${msg}`); console.log(`  OK ${msg}`); };

const cleanup = async (label) => {
  const { data: txn } = await admin.from("hh_transaction").delete().eq("counterparty", MARKER).select("id");
  const { data: ib } = await admin.from("hh_transaction_inbox").delete().eq("guessed_merchant", MARKER).select("id");
  console.log(`  [정리:${label}] 거래 ${txn?.length ?? 0} + 수집함 ${ib?.length ?? 0} 삭제`);
};

const seedInbox = async (owner, acctId, dedup, loanId, catId) => {
  const { data, error } = await admin.from("hh_transaction_inbox").insert({
    owner_auth_uid: owner,
    raw_text: "대출 선택 회귀 테스트 - 즉시 삭제 예정",
    source: "manual",
    guessed_date: "2027-03-15",
    guessed_amount: 8888,
    guessed_merchant: MARKER,
    guessed_type: "payment",
    guessed_from_account_id: acctId,
    guessed_loan_id: loanId ?? null,
    guessed_category_id: catId ?? null,
    confidence: 100,
    status: "pending",
    dedup_hash: `2027-03-15|8888|${MARKER}|${dedup}`,
  }).select("id").single();
  if (error) throw new Error("시드 실패: " + error.message);
  return data.id;
};

try {
  step("사전 정리 + 시드 준비");
  await cleanup("pre");
  const { data: acctRow } = await admin.from("hh_account").select("id, owner_auth_uid").limit(1).single();
  const { data: loanRow } = await admin.from("hh_loan").select("id, name").eq("status", "active").limit(1).single();
  const { data: loanCat } = await admin.from("hh_category").select("id").eq("name", "대출상환").limit(1).single();
  if (!acctRow || !loanRow || !loanCat) throw new Error("시드용 계좌/대출/대출상환 카테고리를 찾지 못함");
  const owner = acctRow.owner_auth_uid;
  console.log(`  대출: ${loanRow.name} / 대출상환 카테고리: ${loanCat.id.slice(0, 8)}…`);

  step(`로그인 (${env.E2E_LOGIN_ID || "admin"})`);
  const domain = env.NEXT_PUBLIC_AUTH_EMAIL_DOMAIN || "example.com";
  const { data: auth, error: authErr } = await user.auth.signInWithPassword({
    email: `${env.E2E_LOGIN_ID || "admin"}@${domain}`,
    password: env.E2E_LOGIN_PASSWORD,
  });
  if (authErr) throw new Error("로그인 실패: " + authErr.message);
  assert(auth.user.id === owner, "로그인 사용자 = 시드 owner");

  step("1) 대출을 고르고 확정 → loan_id + '대출상환' 카테고리");
  const ibId = await seedInbox(owner, acctRow.id, "with-loan", loanRow.id, null);
  const { data: txnId, error: cErr } = await user.rpc("hh_confirm_inbox", { p_inbox_id: ibId });
  assert(!cErr && txnId, `확정 성공 (${cErr?.message ?? ""})`);
  const { data: txn } = await admin.from("hh_transaction").select("*").eq("id", txnId).single();
  assert(txn.loan_id === loanRow.id, `loan_id 가 고른 대출과 일치 (${loanRow.name})`);
  assert(txn.category_id === loanCat.id, "category_id 가 '대출상환'으로 함께 채워짐");
  assert(txn.type === "payment", "유형은 payment 그대로");

  step("2) 되돌리기 → 거래 삭제 + guessed_loan_id 는 남는다");
  const { error: rErr } = await user.rpc("hh_revert_inbox", { p_inbox_id: ibId });
  assert(!rErr, `되돌리기 성공 (${rErr?.message ?? ""})`);
  const { data: gone } = await admin.from("hh_transaction").select("id").eq("id", txnId);
  assert((gone?.length ?? 0) === 0, "확정 거래 삭제됨");
  const { data: ibAfter } = await admin.from("hh_transaction_inbox").select("status, guessed_loan_id").eq("id", ibId).single();
  assert(ibAfter.status === "pending", "상태 pending 복원");
  assert(ibAfter.guessed_loan_id === loanRow.id, "guessed_loan_id 는 남아 재확정 시 재사용 가능");

  step("3) 아무것도 안 고르고 확정 → 둘 다 null (기존 동작 보존, 설계 69)");
  const ibId2 = await seedInbox(owner, acctRow.id, "no-loan", null, null);
  const { data: txnId2, error: cErr2 } = await user.rpc("hh_confirm_inbox", { p_inbox_id: ibId2 });
  assert(!cErr2 && txnId2, `확정 성공 (${cErr2?.message ?? ""})`);
  const { data: txn2 } = await admin.from("hh_transaction").select("*").eq("id", txnId2).single();
  assert(txn2.loan_id === null, "loan_id null");
  assert(txn2.category_id === null, "category_id null — 지출집계 제외 원칙 유지");

  step("4) 카드대금을 고르고 확정 → 그 카테고리가 들어간다 (설계 94 §5)");
  const { data: cardCat } = await admin.from("hh_category").select("id").eq("name", "카드대금").limit(1).single();
  const ibId3 = await seedInbox(owner, acctRow.id, "card", null, cardCat.id);
  const { data: txnId4, error: cErr4 } = await user.rpc("hh_confirm_inbox", { p_inbox_id: ibId3 });
  assert(!cErr4 && txnId4, `확정 성공 (${cErr4?.message ?? ""})`);
  const { data: txn4 } = await admin.from("hh_transaction").select("loan_id, category_id").eq("id", txnId4).single();
  assert(txn4.category_id === cardCat.id, "category_id 가 '카드대금'으로 채워짐 — 소급 분류 불필요");
  assert(txn4.loan_id === null, "loan_id 는 null (대출 아님)");

  step("5) 대출과 카테고리가 둘 다 있으면 대출이 이긴다 (대출 선택이 곧 분류)");
  const ibId4 = await seedInbox(owner, acctRow.id, "both", loanRow.id, cardCat.id);
  const { data: txnId5 } = await user.rpc("hh_confirm_inbox", { p_inbox_id: ibId4 });
  const { data: txn5 } = await admin.from("hh_transaction").select("loan_id, category_id").eq("id", txnId5).single();
  assert(txn5.category_id === loanCat.id, "'대출상환'이 우선 적용됨 (카드대금 아님)");
  assert(txn5.loan_id === loanRow.id, "loan_id 유지");

  step("6) 재확정 — 남은 guessed_loan_id 가 그대로 다시 연결된다");
  const { data: txnId3, error: cErr3 } = await user.rpc("hh_confirm_inbox", { p_inbox_id: ibId });
  assert(!cErr3 && txnId3, `재확정 성공 (${cErr3?.message ?? ""})`);
  const { data: txn3 } = await admin.from("hh_transaction").select("loan_id, category_id").eq("id", txnId3).single();
  assert(txn3.loan_id === loanRow.id && txn3.category_id === loanCat.id, "재확정에도 대출·카테고리 유지");

  console.log("\n✅ 전체 통과 (설계 94)");
} finally {
  await cleanup("post");
}
