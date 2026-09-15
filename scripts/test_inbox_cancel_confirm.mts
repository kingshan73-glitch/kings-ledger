// 설계 151 종단 테스트 — 승인취소 확정이 '새 거래 생성'이 아니라 '원 거래 삭제'로 가는가.
// 실제 DB 에 최소 테스트 데이터를 만들고, 끝나면 finally 에서 반드시 지운다.
// npm test 체인 밖이다(라이브 DB·로그인 필요). 취소 로직을 건드리면 이걸 돌려라.
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";

for (const line of fs.readFileSync(path.resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] ??= m[2];
}
const MARK = "설계151자동테스트";
let pass = 0;
let fail = 0;
const ok = (c: boolean, m: string) => {
  if (c) {
    pass++;
    console.log(`  ✅ ${m}`);
  } else {
    fail++;
    console.log(`  ❌ ${m}`);
  }
};

const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
  auth: { persistSession: false },
});
const { data: auth, error: authErr } = await anon.auth.signInWithPassword({
  email: `${process.env.E2E_LOGIN_ID || "admin"}@${process.env.NEXT_PUBLIC_AUTH_EMAIL_DOMAIN || "example.com"}`,
  password: process.env.E2E_LOGIN_PASSWORD!,
});
if (authErr) throw new Error(`로그인 실패: ${authErr.message}`);
const OWNER = auth.user!.id;

type CatRow = { id: string; name: string; kind: string };
type MethodRow = { id: string; name: string; kind: string };

const { data: cats } = await anon.from("hh_category").select("id,name,kind");
const CAT = ((cats ?? []) as CatRow[]).find((c) => c.kind === "expense")!;
const { data: methods } = await anon.from("hh_payment_method").select("id,name,kind");
const CARD = ((methods ?? []) as MethodRow[]).find((m) => m.kind === "credit")!;

const made: { txn: string[]; inbox: string[] } = { txn: [], inbox: [] };

async function mkTxn(amount: number) {
  const { data, error } = await anon
    .from("hh_transaction")
    .insert({
      owner_auth_uid: OWNER,
      txn_date: "2026-08-06",
      type: "expense",
      amount,
      category_id: CAT.id,
      payment_method_id: CARD.id,
      counterparty: MARK,
      source: "manual",
    })
    .select("id")
    .single();
  if (error) throw new Error(`테스트 거래 생성 실패: ${error.message}`);
  made.txn.push(data.id);
  return data.id as string;
}
async function mkInbox(fields: Record<string, unknown>) {
  const { data, error } = await anon
    .from("hh_transaction_inbox")
    .insert({
      owner_auth_uid: OWNER,
      source: "sms",
      raw_text: `${MARK} ${Math.random().toString(36).slice(2)}`,
      status: "pending",
      dedup_hash: `${MARK}-${Math.random().toString(36).slice(2)}`,
      guessed_date: "2026-08-06",
      ...fields,
    })
    .select("id")
    .single();
  if (error) throw new Error(`테스트 수집행 생성 실패: ${error.message}`);
  made.inbox.push(data.id);
  return data.id as string;
}

try {
  console.log("[1] 취소 확정 → 원 거래가 삭제되고, 원 거래를 만든 수집행도 닫힌다");
  const txn1 = await mkTxn(31);
  const origInbox = await mkInbox({ guessed_kind: "approve", guessed_type: "expense", guessed_amount: 31, status: "confirmed", confirmed_txn_id: txn1 });
  const cancelInbox = await mkInbox({ guessed_kind: "cancel", guessed_type: "expense", guessed_amount: 31, cancel_target_txn_id: txn1 });

  const { data: ret, error: e1 } = await anon.rpc("hh_confirm_inbox", { p_inbox_id: cancelInbox });
  ok(!e1, `확정 RPC 호출 성공 ${e1 ? "(" + e1.message + ")" : ""}`);
  ok(ret === txn1, "삭제한 거래 id 를 돌려준다");

  const { data: gone } = await anon.from("hh_transaction").select("id").eq("id", txn1);
  ok((gone ?? []).length === 0, "★원 거래가 삭제됐다(지출이 하나 더 생기지 않았다)");

  const { data: after } = await anon.from("hh_transaction_inbox").select("id,status").in("id", [origInbox, cancelInbox]);
  const st = new Map(((after ?? []) as { id: string; status: string }[]).map((r) => [r.id, r.status]));
  ok(st.get(cancelInbox) === "confirmed", "취소 수집행 = confirmed");
  ok(st.get(origInbox) === "ignored", "원 승인 수집행 = ignored(고아로 안 남는다)");

  console.log("\n[2] 멱등 — 다시 확정해도 다른 거래를 지우지 않는다");
  const txn2 = await mkTxn(32);
  const { error: e2 } = await anon.rpc("hh_confirm_inbox", { p_inbox_id: cancelInbox });
  ok(!e2, "재호출이 에러 없이 통과");
  const { data: still } = await anon.from("hh_transaction").select("id").eq("id", txn2);
  ok((still ?? []).length === 1, "★관계없는 거래는 그대로다");

  console.log("\n[2b] 취소 확정은 검토대기로 되돌릴 수 없다 (설계 179 §2)");
  const { error: revertError } = await anon.rpc("hh_revert_inbox", { p_inbox_id: cancelInbox });
  ok(!!revertError && revertError.message.includes("되돌릴 수 없습니다"), "★취소 확정 되돌리기가 복구 불가 안내와 함께 막힌다");
  const { data: stillConfirmed } = await anon.from("hh_transaction_inbox").select("status").eq("id", cancelInbox).single();
  ok(stillConfirmed?.status === "confirmed", "막힌 뒤에도 취소 수집행은 confirmed 그대로");

  console.log("\n[3] 대상을 못 찾은 취소는 조용히 넘어가지 않고 막힌다");
  const orphan = await mkInbox({ guessed_kind: "cancel", guessed_type: "expense", guessed_amount: 33, cancel_target_txn_id: null });
  const { error: e3 } = await anon.rpc("hh_confirm_inbox", { p_inbox_id: orphan });
  ok(!!e3, `대상 없는 취소는 예외로 막힌다 ${e3 ? "(" + String(e3.message).slice(0, 40) + "…)" : "— 막히지 않았다!"}`);
  const { data: noNew } = await anon.from("hh_transaction").select("id").eq("counterparty", MARK).eq("amount", 33);
  ok((noNew ?? []).length === 0, "★막힌 뒤 지출이 생기지 않았다");

  console.log("\n[4] 회귀 — 일반 지출 확정은 종전대로 거래를 만든다");
  const normal = await mkInbox({
    guessed_kind: "approve",
    guessed_type: "expense",
    guessed_amount: 34,
    guessed_category_id: CAT.id,
    guessed_payment_method_id: CARD.id,
    guessed_merchant: MARK,
  });
  const { data: newTxn, error: e4 } = await anon.rpc("hh_confirm_inbox", { p_inbox_id: normal });
  ok(!e4 && !!newTxn, `일반 지출 확정 성공 ${e4 ? "(" + e4.message + ")" : ""}`);
  if (newTxn) made.txn.push(newTxn as string);
  const { data: made4 } = await anon.from("hh_transaction").select("id,type,amount").eq("id", newTxn);
  const made4Rows = (made4 ?? []) as { id: string; type: string; amount: number }[];
  ok(made4Rows.length === 1 && made4Rows[0].amount === 34, "거래가 실제로 만들어졌다");

  console.log("\n[5] 수집 시점 자동 매칭 — 취소 문자가 원 거래를 스스로 찾는가");
  const { enrichParsed } = await import("../src/lib/household/sms-ingest");
  // 2026-08-01 쿠팡 42,260원 실사례를 재현한다(그날 실제로 물린 케이스).
  const CANCEL_SMS = "삼성카드 [삼성카드]1234취소\n08/06 쿠팡\n-42,260원";
  // ★결제수단은 파서가 끝4(1234)로 고르는 그 카드여야 한다 — 내가 고른 카드로 원 거래를 만들면
  //   매칭이 pm 조건에서 어긋나 '못 찾음'이 나오고, 그건 구현이 아니라 테스트가 틀린 것이다.
  const probe = await enrichParsed(anon, OWNER, CANCEL_SMS, null);
  const cardId = probe.fields.guessed_payment_method_id;
  const cardName = ((methods ?? []) as MethodRow[]).find((m) => m.id === cardId)?.name ?? "(없음)";
  console.log(`  · 파서가 1234 → ${cardName} 로 해석`);
  // ★환경 의존: 이 계정에 끝4 1234 카드가 없으면(카드 해지·개명) 원 거래를 못 만든다 — 구현 결함이 아니라
  //   테스트 전제가 깨진 것이니 건너뛴다(2026-08-17 실측: 1234 → (없음) 으로 CHECK 위반 크래시).
  if (!cardId) {
    console.log("  ⚠️ [5] 건너뜀 — 이 계정에 끝4 1234 카드가 없다(환경 의존, 구현 결함 아님)");
  } else {
  const card1234 = { id: cardId as string };
  const { data: coupang, error: ce } = await anon
    .from("hh_transaction")
    .insert({
      owner_auth_uid: OWNER,
      txn_date: "2026-08-06",
      type: "expense",
      amount: 42260,
      category_id: CAT.id,
      payment_method_id: card1234.id,
      counterparty: `쿠팡${MARK}`,
      source: "manual",
    })
    .select("id")
    .single();
  if (ce) throw new Error(ce.message);
  made.txn.push(coupang.id);

  const res = await enrichParsed(anon, OWNER, CANCEL_SMS, null);
  ok(res.fields.guessed_kind === "cancel", `kind=cancel 로 읽는다 (got ${res.fields.guessed_kind})`);
  ok(
    res.fields.cancel_target_txn_id === coupang.id,
    `★원 거래를 찾아낸다 (got ${res.fields.cancel_target_txn_id ? String(res.fields.cancel_target_txn_id).slice(0, 8) : "null"} / 기대 ${String(coupang.id).slice(0, 8)})`,
  );

  // 같은 금액이 둘이면 기계가 정하지 않는다 — 사람이 판단해야 한다.
  // ★이 단언은 바로 위에서 '1건일 때 찾아낸다'가 통과했을 때만 의미가 있다(둘 다 null 이면 항진명제).
  const twin = await mkTxn(42260);
  await anon.from("hh_transaction").update({ payment_method_id: card1234.id, counterparty: `쿠팡${MARK}` }).eq("id", twin);
  const res2 = await enrichParsed(anon, OWNER, CANCEL_SMS, null);
  ok(
    res.fields.cancel_target_txn_id !== null && res2.fields.cancel_target_txn_id === null,
    "★후보가 둘이면 비워 둔다(1건일 땐 찾았다는 전제 위에서 검사)",
  );
  } // if (cardId)
} finally {
  // ── 정리: 만든 것만 지운다 ──────────────────────────────────────────────
  for (const id of made.inbox) await anon.from("hh_transaction_inbox").delete().eq("id", id);
  for (const id of made.txn) await anon.from("hh_transaction").delete().eq("id", id);
  const { data: left } = await anon.from("hh_transaction").select("id").eq("counterparty", MARK);
  const { data: leftIn } = await anon.from("hh_transaction_inbox").select("id").ilike("raw_text", `%${MARK}%`);
  console.log(`\n정리: 남은 테스트 거래 ${(left ?? []).length}건 / 수집행 ${(leftIn ?? []).length}건 (둘 다 0이어야 한다)`);
  if ((left ?? []).length || (leftIn ?? []).length) fail++;
}

console.log(`\nResult: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
