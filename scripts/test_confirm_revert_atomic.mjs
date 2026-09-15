// 회귀 테스트: 수집함 확정/되돌리기 원자화 (설계 91).
// UI를 거치지 않고 RPC를 직접 호출해 검증한다. 마커 데이터만 만들고 끝나면 전부 삭제한다.
//  1) 동시 확정 2연발 → 거래는 정확히 1건, 두 호출 모두 같은 id 반환 (행 잠금 + 멱등)
//  2) hh_revert_inbox → 거래 삭제 + 상태 pending + 링크 해제 (단일 트랜잭션)
//  3) 되돌리기 멱등 — pending 상태에서 재호출해도 오류 없음
//  4) 할부 확정 → 되돌리기 → hh_installment 마스터 삭제 확인
// 실행: node scripts/test_confirm_revert_atomic.mjs
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const MARKER = "ATOMIC_RPC_TEST";

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
  const { data: inst } = await admin.from("hh_installment").delete().eq("title", MARKER).select("id");
  const { data: ib } = await admin.from("hh_transaction_inbox").delete().eq("guessed_merchant", MARKER).select("id");
  console.log(`  [정리:${label}] 거래 ${txn?.length ?? 0} + 할부 ${inst?.length ?? 0} + 수집함 ${ib?.length ?? 0} 삭제`);
};

const seedInbox = async (owner, extra) => {
  const { data, error } = await admin.from("hh_transaction_inbox").insert({
    owner_auth_uid: owner,
    raw_text: "원자화 회귀 테스트 - 즉시 삭제 예정",
    source: "manual",
    guessed_date: "2027-02-15",
    guessed_amount: 9999,
    guessed_merchant: MARKER,
    guessed_type: "expense",
    confidence: 100,
    status: "pending",
    dedup_hash: `2027-02-15|9999|${MARKER}|${extra.dedup}`,
    ...extra.cols,
  }).select("id").single();
  if (error) throw new Error("시드 실패: " + error.message);
  return data.id;
};

try {
  step("사전 정리 + 시드 준비");
  await cleanup("pre");
  const { data: catRow } = await admin.from("hh_category").select("id, owner_auth_uid").eq("kind", "expense").limit(1).single();
  const { data: pmRow } = await admin.from("hh_payment_method").select("id").limit(1).single();
  if (!catRow || !pmRow) throw new Error("시드용 카테고리/결제수단을 찾지 못함");
  const owner = catRow.owner_auth_uid;

  step(`로그인 (${env.E2E_LOGIN_ID || "admin"})`);
  const domain = env.NEXT_PUBLIC_AUTH_EMAIL_DOMAIN || "example.com";
  const { data: auth, error: authErr } = await user.auth.signInWithPassword({ email: `${env.E2E_LOGIN_ID || "admin"}@${domain}`, password: env.E2E_LOGIN_PASSWORD });
  if (authErr) throw new Error("로그인 실패: " + authErr.message);
  assert(auth.user.id === owner, "로그인 사용자 = 시드 owner");

  step("1) 동시 확정 2연발 — 거래는 1건이어야 한다");
  const ibId = await seedInbox(owner, { dedup: "race", cols: { guessed_category_id: catRow.id, guessed_payment_method_id: pmRow.id } });
  const [r1, r2] = await Promise.all([
    user.rpc("hh_confirm_inbox", { p_inbox_id: ibId }),
    user.rpc("hh_confirm_inbox", { p_inbox_id: ibId }),
  ]);
  assert(!r1.error && !r2.error, `두 호출 모두 성공 (${r1.error?.message ?? ""}${r2.error?.message ?? ""})`);
  assert(r1.data === r2.data, `두 호출이 같은 거래 id 반환 (${String(r1.data).slice(0, 8)}…)`);
  const { data: txns } = await admin.from("hh_transaction").select("id").eq("counterparty", MARKER);
  assert(txns?.length === 1, `생성된 거래 정확히 1건 (실제 ${txns?.length ?? 0}건)`);

  step("2) 되돌리기 — 거래 삭제 + pending 복원");
  const { error: revErr } = await user.rpc("hh_revert_inbox", { p_inbox_id: ibId });
  assert(!revErr, `되돌리기 성공 (${revErr?.message ?? ""})`);
  const { data: txnsAfter } = await admin.from("hh_transaction").select("id").eq("counterparty", MARKER);
  assert((txnsAfter?.length ?? 0) === 0, "확정 거래 삭제됨");
  const { data: ibRow } = await admin.from("hh_transaction_inbox").select("status, confirmed_txn_id, confirmed_installment_id").eq("id", ibId).single();
  assert(ibRow.status === "pending" && !ibRow.confirmed_txn_id && !ibRow.confirmed_installment_id, "상태 pending + 링크 해제");

  step("3) 되돌리기 멱등 — pending 재호출 무해");
  const { error: rev2Err } = await user.rpc("hh_revert_inbox", { p_inbox_id: ibId });
  assert(!rev2Err, "pending 상태 재호출 오류 없음");

  step("4) 할부 확정 → 되돌리기 — 할부 마스터 삭제");
  const ibId2 = await seedInbox(owner, { dedup: "inst", cols: { guessed_type: "installment", guessed_installment_months: 3, guessed_category_id: catRow.id, guessed_payment_method_id: pmRow.id } });
  const { data: instId, error: confErr } = await user.rpc("hh_confirm_inbox", { p_inbox_id: ibId2 });
  assert(!confErr && instId, `할부 확정 성공 (${confErr?.message ?? ""})`);
  const { data: instRows } = await admin.from("hh_installment").select("id").eq("title", MARKER);
  assert(instRows?.length === 1, "hh_installment 마스터 1건 생성");
  const { error: rev3Err } = await user.rpc("hh_revert_inbox", { p_inbox_id: ibId2 });
  assert(!rev3Err, `할부 되돌리기 성공 (${rev3Err?.message ?? ""})`);
  const { data: instAfter } = await admin.from("hh_installment").select("id").eq("title", MARKER);
  assert((instAfter?.length ?? 0) === 0, "할부 마스터 삭제됨");
  const { data: ibRow2 } = await admin.from("hh_transaction_inbox").select("status, confirmed_installment_id").eq("id", ibId2).single();
  assert(ibRow2.status === "pending" && !ibRow2.confirmed_installment_id, "할부 건도 pending + 링크 해제");

  step("테스트 데이터 정리");
  await cleanup("post");
  console.log("\n✅ 전체 통과");
} catch (e) {
  console.error("\n❌ " + e.message);
  await cleanup("error");
  process.exitCode = 1;
}
