// 설계 84·130 검증: 충전 인센티브 동기화(syncChargeIncentive)의 계약.
//
// 실행: npm run test:charge-incentive   (DB 불필요 — 가짜 supabase 스텁으로 순수 검증)
//
// 이 함수는 통장이동 폼·팝업 **그리고 수집함 확정**(설계 130)이 함께 쓰는 단일 구현이다.
// 여기서 지키는 것: ① 대상 계좌·비율은 defaults.ts 규칙에서만 온다 ② 같은 이체에 두 번 만들지 않는다
// ③ 대상이 아니게 되면 지운다 ④ 조회 실패를 '없음'으로 강등하지 않는다(강등하면 편집할 때마다 10%씩 부푼다).
const { syncChargeIncentive, incentiveFor } = await import("../src/lib/household/sync-incentive");

let fail = 0;
const eq = (name: string, a: unknown, b: unknown) => {
  if (Object.is(a, b)) console.log(`  ✅ ${name}`);
  else {
    fail++;
    console.log(`  ❌ ${name} — 기대 ${JSON.stringify(b)}, 실제 ${JSON.stringify(a)}`);
  }
};

const OWNER = "owner-1";
const ACC_BANK = "acc-bank"; // 국민은행(이바다)
const ACC_PAY = "acc-pay"; // 부천페이(이바다)  ← 인센티브 대상
const CAT_CASHBACK = "cat-cashback"; // 환급/캐시백(income)
const TXN = "txn-1";

const accounts = [
  { id: ACC_BANK, name: "국민은행(이바다)" },
  { id: ACC_PAY, name: "부천페이(이바다)" },
] as never;

type Call = { table: string; op: string; payload?: unknown; id?: string };

/** hh_transaction(관련 인센티브 1건)·hh_category 만 흉내내는 스텁. 호출을 기록해 검사한다. */
function stub(opts: { existing?: { id: string } | null; findError?: string; category?: { id: string } | null }) {
  const calls: Call[] = [];
  const api = (table: string) => {
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () => {
        if (table === "hh_transaction") {
          if (opts.findError) return { data: null, error: { message: opts.findError } };
          return { data: opts.existing ?? null, error: null };
        }
        return { data: opts.category === undefined ? { id: CAT_CASHBACK } : opts.category, error: null };
      },
      insert: async (payload: unknown) => {
        calls.push({ table, op: "insert", payload });
        return { error: null };
      },
      update: (payload: unknown) => ({
        eq: async (_c: string, id: string) => {
          calls.push({ table, op: "update", payload, id });
          return { error: null };
        },
      }),
      delete: () => ({
        eq: async (_c: string, id: string) => {
          calls.push({ table, op: "delete", id });
          return { error: null };
        },
      }),
    };
    return chain;
  };
  return { sb: { from: (t: string) => api(t) } as never, calls };
}

console.log("\n[1] 규칙 판정 — 부천페이만 대상, 비율은 defaults.ts 에서 온다");
{
  const pay = incentiveFor(accounts, ACC_PAY, 300000);
  eq("부천페이 = 대상", pay.show, true);
  eq("300,000 의 인센티브 = 30,000", pay.incentive, 30000);
  const bank = incentiveFor(accounts, ACC_BANK, 300000);
  eq("일반 은행계좌 = 대상 아님", bank.show, false);
  eq("대상 아니면 0원", bank.incentive, 0);
}

console.log("\n[2] 신규 — 인센티브 수입 1건을 이체에 매달아 만든다(설계 130 수집함 확정 경로가 쓰는 길)");
{
  const { sb, calls } = stub({ existing: null });
  const res = await syncChargeIncentive(sb, {
    txnId: TXN, owner: OWNER, accounts, txnDate: "2026-08-03", amount: 300000, toAccountId: ACC_PAY,
  });
  eq("성공", res.ok, true);
  eq("insert 1회", calls.filter((c) => c.op === "insert").length, 1);
  const row = calls.find((c) => c.op === "insert")?.payload as Record<string, unknown>;
  eq("유형 = 수입", row.type, "income");
  eq("금액 = 30,000", row.amount, 30000);
  eq("입금계좌 = 부천페이", row.account_id, ACC_PAY);
  eq("카테고리 = 환급/캐시백", row.category_id, CAT_CASHBACK);
  eq("★원거래에 매단다(되돌리면 CASCADE 로 같이 지워진다)", row.related_txn_id, TXN);
  eq("날짜 = 이체 날짜", row.txn_date, "2026-08-03");
}

console.log("\n[3] 이미 있으면 update — 같은 이체에 두 건이 생기지 않는다(이중 적립 방지)");
{
  const { sb, calls } = stub({ existing: { id: "inc-1" } });
  const res = await syncChargeIncentive(sb, {
    txnId: TXN, owner: OWNER, accounts, txnDate: "2026-08-03", amount: 300000, toAccountId: ACC_PAY,
  });
  eq("성공", res.ok, true);
  eq("insert 0회", calls.filter((c) => c.op === "insert").length, 0);
  eq("update 1회", calls.filter((c) => c.op === "update").length, 1);
}

console.log("\n[4] 대상이 아니게 되면(입금계좌 변경) 남아있던 인센티브를 지운다");
{
  const { sb, calls } = stub({ existing: { id: "inc-1" } });
  const res = await syncChargeIncentive(sb, {
    txnId: TXN, owner: OWNER, accounts, txnDate: "2026-08-03", amount: 300000, toAccountId: ACC_BANK,
  });
  eq("성공", res.ok, true);
  eq("delete 1회", calls.filter((c) => c.op === "delete").length, 1);
  eq("insert 0회", calls.filter((c) => c.op === "insert").length, 0);
}

console.log("\n[5] ★조회 실패를 '없음'으로 강등하지 않는다 — 강등하면 편집할 때마다 10%씩 부푼다");
{
  const { sb, calls } = stub({ findError: "네트워크 오류" });
  const res = await syncChargeIncentive(sb, {
    txnId: TXN, owner: OWNER, accounts, txnDate: "2026-08-03", amount: 300000, toAccountId: ACC_PAY,
  });
  eq("실패로 보고", res.ok, false);
  eq("아무것도 쓰지 않는다", calls.length, 0);
}

console.log("\n[6] 카테고리가 없으면 조용히 넘어가지 않고 실패로 알린다");
{
  const { sb, calls } = stub({ existing: null, category: null });
  const res = await syncChargeIncentive(sb, {
    txnId: TXN, owner: OWNER, accounts, txnDate: "2026-08-03", amount: 300000, toAccountId: ACC_PAY,
  });
  eq("실패로 보고", res.ok, false);
  eq("insert 0회", calls.filter((c) => c.op === "insert").length, 0);
}

console.log(fail === 0 ? "\n전부 통과 ✅" : `\n실패 ${fail}건 ❌`);
process.exit(fail === 0 ? 0 : 1);
