// 데이터 무결성 강화(docs/household/16) 실동작 검증.
// FK RESTRICT / hh_create_payments / 마감월 트리거 / hh_confirm_inbox(+멱등) 를
// 원격 DB(프로덕션과 동일)에 대해 검증하고 흔적을 즉시 정리한다.
// 실행: node --env-file=.env.local scripts/test_data_integrity.mjs
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
const YM = "2027-01";
const MARK = "__VERIFY_INTEGRITY__";

const admin = createClient(url, service, { auth: { persistSession: false } });
const user = createClient(url, anon, { auth: { persistSession: false } });

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };

const LOGIN_PW = process.env.E2E_LOGIN_PASSWORD;
if (!LOGIN_PW) { console.error("[중단] .env.local 에 E2E_LOGIN_PASSWORD 가 없습니다. `node --env-file=.env.local` 로 실행하세요."); process.exit(1); }
const LOGIN_EMAIL = `${process.env.E2E_LOGIN_ID || "admin"}@${process.env.NEXT_PUBLIC_AUTH_EMAIL_DOMAIN || "example.com"}`;
const { error: loginErr } = await user.auth.signInWithPassword({ email: LOGIN_EMAIL, password: LOGIN_PW });
if (loginErr) { console.error("로그인 실패:", loginErr.message); process.exit(1); }
const { data: { user: me } } = await user.auth.getUser();
const owner = me.id;
console.log(`로그인 OK (owner=${owner})\n`);

// ── 1. FK RESTRICT: 거래가 참조하는 카테고리는 삭제 거부 ──
console.log("1) FK RESTRICT (마스터 삭제 보호)");
const { data: refTxn } = await admin.from("hh_transaction").select("category_id").not("category_id", "is", null).limit(1).single();
const catId = refTxn.category_id;
const del = await admin.from("hh_category").delete().eq("id", catId);
ok(del.error?.code === "23503", `참조 중 카테고리 삭제 거부 (code=${del.error?.code})`);
const { count: stillThere } = await admin.from("hh_category").select("*", { count: "exact", head: true }).eq("id", catId);
ok(stillThere === 1, "카테고리가 그대로 보존됨(고아행 미발생)");

// ── 2. hh_create_payments: 마스터+이번달 실적 원자 생성 ──
console.log("\n2) hh_create_payments RPC (결제등록 원자성)");
const { data: ids, error: cErr } = await user.rpc("hh_create_payments", {
  p_items: [{ title: MARK, payee: null, kind: "autopay", amount: 12345, pay_day: 25, frequency: "monthly", account_id: null, category_id: null, is_active: true }],
  p_ym: YM,
});
ok(!cErr, `RPC 성공 (${cErr?.message ?? "ok"})`);
const spId = Array.isArray(ids) ? ids[0] : ids;
const { data: entry } = await admin.from("hh_payment_entry").select("*").eq("scheduled_payment_id", spId).eq("year_month", YM).maybeSingle();
ok(entry?.fixed_amount === 12345, `이번달 실적 자동 생성(fixed=${entry?.fixed_amount})`);

// ── 3. 마감월 트리거: 마감된 월 실적 수정 차단 ──
console.log("\n3) 마감월 잠금 트리거");
await admin.from("hh_payment_month_close").insert({ owner_auth_uid: owner, year_month: YM });
const updClosed = await admin.from("hh_payment_entry").update({ variable_amount: 999 }).eq("id", entry.id);
ok(!!updClosed.error, `마감월 실적 수정 차단 (${updClosed.error?.message?.slice(0, 40) ?? "차단 안됨!"})`);
await admin.from("hh_payment_month_close").delete().eq("owner_auth_uid", owner).eq("year_month", YM);
const updOpen = await admin.from("hh_payment_entry").update({ variable_amount: 0 }).eq("id", entry.id);
ok(!updOpen.error, "마감 취소 후 수정 가능");
// 정리
await admin.from("hh_payment_entry").delete().eq("id", entry.id);
await admin.from("hh_scheduled_payment").delete().eq("id", spId);

// ── 4. hh_confirm_inbox: 확정 원자성 + 재확정 멱등 ──
console.log("\n4) hh_confirm_inbox RPC (수집함 확정 원자성·멱등)");
const { data: cat } = await admin.from("hh_category").select("id").eq("kind", "expense").eq("is_active", true).limit(1).single();
const { data: pm } = await admin.from("hh_payment_method").select("id").eq("is_active", true).limit(1).single();
const { data: inbox } = await admin.from("hh_transaction_inbox").insert({
  owner_auth_uid: owner, source: "manual", status: "pending",
  guessed_type: "expense", guessed_amount: 5555, guessed_date: `${YM}-15`,
  guessed_category_id: cat.id, guessed_payment_method_id: pm.id, guessed_merchant: MARK,
  dedup_hash: `${MARK}-${YM}`,
}).select("id").single();

const { data: txnId, error: confErr } = await user.rpc("hh_confirm_inbox", { p_inbox_id: inbox.id });
ok(!confErr && txnId, `확정 RPC 성공 (txn=${String(txnId).slice(0, 8)}…)`);
const { data: txn } = await admin.from("hh_transaction").select("*").eq("id", txnId).single();
ok(txn?.source === "inbox" && txn?.amount === 5555, "거래 생성됨(source=inbox)");
const { data: inboxAfter } = await admin.from("hh_transaction_inbox").select("status, confirmed_txn_id").eq("id", inbox.id).single();
ok(inboxAfter.status === "confirmed" && inboxAfter.confirmed_txn_id === txnId, "수집함 status=confirmed + 거래연결");

// 재확정 → 같은 거래 id, 중복 미생성
const { data: txnId2 } = await user.rpc("hh_confirm_inbox", { p_inbox_id: inbox.id });
ok(txnId2 === txnId, "재확정 시 동일 거래 반환(멱등)");
const { count: txnCount } = await admin.from("hh_transaction").select("*", { count: "exact", head: true }).eq("counterparty", MARK).eq("source", "inbox");
ok(txnCount === 1, `중복 거래 미생성(count=${txnCount})`);

// 정리
await admin.from("hh_transaction").delete().eq("id", txnId);
await admin.from("hh_transaction_inbox").delete().eq("id", inbox.id);

// 이체 확정: 카테고리 없이 출금/입금 계좌로 transfer 거래 생성
const { data: transferAccounts } = await admin.from("hh_account").select("id").eq("is_active", true).limit(2);
if ((transferAccounts ?? []).length >= 2) {
  const transferMark = `${MARK}-transfer`;
  const [fromAccount, toAccount] = transferAccounts;
  const { data: transferInbox, error: transferInboxErr } = await admin.from("hh_transaction_inbox").insert({
    owner_auth_uid: owner, source: "manual", status: "pending",
    guessed_type: "transfer", guessed_amount: 7777, guessed_date: `${YM}-16`,
    guessed_from_account_id: fromAccount.id, guessed_to_account_id: toAccount.id,
    guessed_merchant: transferMark,
    dedup_hash: `${transferMark}-${YM}`,
  }).select("id").single();

  ok(!transferInboxErr && !!transferInbox, `이체 수집함 테스트 행 생성 (${transferInboxErr?.message ?? "ok"})`);
  if (transferInbox) {
    const { data: transferTxnId, error: transferErr } = await user.rpc("hh_confirm_inbox", { p_inbox_id: transferInbox.id });
    ok(!transferErr && transferTxnId, `이체 확정 RPC 성공 (${transferErr?.message ?? `txn=${String(transferTxnId).slice(0, 8)}…`})`);
    const { data: transferTxn } = transferTxnId
      ? await admin.from("hh_transaction").select("*").eq("id", transferTxnId).single()
      : { data: null };
    ok(
      transferTxn?.type === "transfer" &&
        transferTxn?.from_account_id === fromAccount.id &&
        transferTxn?.to_account_id === toAccount.id &&
        transferTxn?.category_id === null,
      "이체 거래 생성됨(type=transfer, 출금/입금 계좌 연결)"
    );

    if (transferTxnId) await admin.from("hh_transaction").delete().eq("id", transferTxnId);
    await admin.from("hh_transaction_inbox").delete().eq("id", transferInbox.id);
  }
} else {
  ok(true, "이체 확정 검증 건너뜀(활성 계좌 2개 미만)");
}

// 잔여 흔적 점검
const { count: leftSp } = await admin.from("hh_scheduled_payment").select("*", { count: "exact", head: true }).eq("title", MARK);
const { count: leftTxn } = await admin.from("hh_transaction").select("*", { count: "exact", head: true }).eq("counterparty", MARK);
ok(leftSp === 0 && leftTxn === 0, `잔여 흔적 0건 (sp=${leftSp}, txn=${leftTxn})`);

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
