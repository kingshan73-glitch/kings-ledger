// 충전 인센티브 동기화 (설계 84) — 통장이동 팝업과 편집 폼이 함께 쓰는 단일 구현.
//
// 왜 lib 으로 뺐나:
//   원래 이 로직이 transfer-edit-dialog 안에만 있었다. CLAUDE.md 상 /transfers/[id]/edit
//   라우트는 직접 URL 접근용으로 존치되는데, 그쪽 폼(transfer-form)에는 '인센티브'라는
//   단어조차 없어서 — 그 경로로 충전액을 고치면 딸린 인센티브가 옛 금액으로 남아
//   계좌 잔액이 틀어졌다. 데이터 정합성 경로가 둘인데 하나만 고쳐진 상태였다.
//
// 인센티브 행은 related_txn_id 로 이체에 매달려 있다(ON DELETE CASCADE) —
// 이체를 지우면 DB 가 알아서 같이 지운다. 여기서 다루는 건 생성·갱신·삭제뿐이다.
import type { createClient } from "@/lib/supabase/client";
import { chargeIncentiveAmount, matchChargeIncentive } from "@/lib/household/defaults";
import type { HhAccount } from "@/lib/household/types";

type SB = ReturnType<typeof createClient>;

export type SyncIncentiveResult =
  /** 사용자에게 덧붙일 안내문. null 이면 덧붙일 말 없음. */
  { ok: true; message: string | null }
  /** 실패 — 호출부가 경고를 띄운다. 이체 저장 자체는 이미 끝났으므로 롤백하지 않는다. */
  | { ok: false; message: string };

/** 입금계좌가 인센티브 대상인지 + 얹힐 금액. 화면 표시에도 쓴다. */
export function incentiveFor(accounts: HhAccount[], toAccountId: string, amount: number) {
  const toAccount = accounts.find((a) => a.id === toAccountId) ?? null;
  const rule = matchChargeIncentive(toAccount?.name);
  const incentive = rule ? chargeIncentiveAmount(amount, rule.rate) : 0;
  return { rule, incentive, show: Boolean(rule) && incentive > 0 };
}

/**
 * 이체(txnId)에 딸린 인센티브 수입을 현재 입력값에 맞춰 생성/갱신/삭제한다.
 *
 * ★조회 실패를 '없음'으로 강등하지 않는다. 예전엔 error 를 구조분해조차 안 해서,
 *   조회가 실패하면 insert 경로로 빠져 같은 이체에 인센티브가 하나 더 생겼다.
 *   편집을 반복할수록 잔액이 충전액의 10%씩 부풀었다.
 */
export async function syncChargeIncentive(
  supabase: SB,
  args: {
    txnId: string;
    owner: string;
    accounts: HhAccount[];
    txnDate: string;
    amount: number;
    toAccountId: string;
  }
): Promise<SyncIncentiveResult> {
  const { txnId, owner, accounts, txnDate, amount, toAccountId } = args;
  const { rule, incentive, show } = incentiveFor(accounts, toAccountId, amount);

  const { data: existing, error: findErr } = await supabase
    .from("hh_transaction")
    .select("id")
    .eq("related_txn_id", txnId)
    .maybeSingle();
  if (findErr) {
    return { ok: false, message: `인센티브 확인 실패: ${findErr.message} — 인센티브는 손대지 않았습니다.` };
  }

  // 대상이 아니거나 금액이 0이면 남아있던 인센티브를 지운다(입금계좌를 바꾼 경우 등).
  if (!show || !rule) {
    if (!existing) return { ok: true, message: null };
    const { error: delErr } = await supabase.from("hh_transaction").delete().eq("id", existing.id);
    if (delErr) {
      // 못 지운 인센티브가 남으면 잔액을 계속 떠받친다 — 조용히 넘기면 안 된다.
      return { ok: false, message: `인센티브 삭제 실패: ${delErr.message} — 수입에 남아 있습니다.` };
    }
    return { ok: true, message: "충전 인센티브는 대상이 아니라 함께 삭제했습니다." };
  }

  const { data: cat, error: catErr } = await supabase
    .from("hh_category")
    .select("id")
    .eq("kind", "income")
    .eq("name", "환급/캐시백")
    .maybeSingle();
  if (catErr) {
    // 조회 실패를 '카테고리 없음'으로 안내하면 사용자가 이미 있는 카테고리를 또 만든다.
    return { ok: false, message: `카테고리 조회 실패: ${catErr.message} — 인센티브를 기록하지 못했습니다.` };
  }
  if (!cat) {
    return {
      ok: false,
      message: "'환급/캐시백' 수입 카테고리가 없어 인센티브를 기록하지 못했습니다. 설정에서 추가해주세요.",
    };
  }

  const row = {
    txn_date: txnDate,
    type: "income" as const,
    amount: incentive,
    category_id: cat.id,
    account_id: toAccountId,
    counterparty: rule.label,
    memo: `충전 ${amount.toLocaleString("ko-KR")}원의 ${Math.round(rule.rate * 100)}% 자동 지급`,
  };

  if (existing) {
    const { error } = await supabase.from("hh_transaction").update(row).eq("id", existing.id);
    if (error) return { ok: false, message: `인센티브 갱신 실패: ${error.message}` };
    return { ok: true, message: `인센티브 ${incentive.toLocaleString("ko-KR")}원도 함께 수정했습니다.` };
  }

  const { error } = await supabase
    .from("hh_transaction")
    .insert({ ...row, owner_auth_uid: owner, source: "manual", related_txn_id: txnId });
  if (error) return { ok: false, message: `인센티브 기록 실패: ${error.message}` };
  return { ok: true, message: `인센티브 ${incentive.toLocaleString("ko-KR")}원이 수입으로 함께 기록됐습니다.` };
}
