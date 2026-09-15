// 데이터 건강도 계산 검증 (설계 91 §4) — DB 없이 합성 데이터로 규칙만 본다.
//   npm run test:data-health
// 핵심 검증: 설계상 의도된 공란(신용카드 지출의 account_id)을 문제로 세지 않는가.
//            이걸 세면 400건짜리 가짜 경고가 진짜 문제를 덮는다.
const { computeDataHealth } = await import("../src/lib/household/data-health");
import type { HhCategory, HhPaymentMethod, HhTransaction } from "../src/lib/household/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failures++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function eq(name: string, actual: unknown, expected: unknown) {
  check(name, Object.is(actual, expected), `기대 ${expected}, 실제 ${actual}`);
}

const TODAY = "2026-07-20";
const CAT_LOAN = "cat-loan";
const categories = [
  { id: CAT_LOAN, name: "대출상환" },
  { id: "cat-food", name: "식료품비" },
] as unknown as HhCategory[];

const paymentMethods = [
  { id: "pm-credit", kind: "credit", linked_account_id: null },
  { id: "pm-check", kind: "check", linked_account_id: "acc-1" },
  { id: "pm-prepaid", kind: "cash", linked_account_id: "acc-2" },
] as unknown as HhPaymentMethod[];

const txn = (over: Partial<HhTransaction>): HhTransaction => ({
  id: Math.random().toString(36).slice(2), owner_auth_uid: "o", txn_date: "2026-07-01",
  type: "expense", amount: 10_000, category_id: "cat-food", counterparty: "가게", memo: null, note: null,
  payment_method_id: null, account_id: null, from_account_id: null, to_account_id: null,
  person_id: null, installment_id: null, loan_id: null, source: "manual",
  created_at: "", updated_at: "", source_sheet: null, source_row: null, related_txn_id: null,
  ...over,
} as unknown as HhTransaction);

const get = (h: ReturnType<typeof computeDataHealth>, key: string) => h.items.find((i) => i.key === key);

console.log("▶ 신용카드 지출의 빈 계좌는 문제가 아니다(설계 70)");
{
  const txns = Array.from({ length: 5 }, () => txn({ payment_method_id: "pm-credit", account_id: null }));
  const h = computeDataHealth({ txns, categories, paymentMethods, lastIngestAt: `${TODAY}T09:00:00+09:00`, today: TODAY });
  eq("계좌 미연결 = 없음", get(h, "unlinked-account")?.value, "없음");
  eq("계좌 미연결 level = ok", get(h, "unlinked-account")?.level, "ok");
}

console.log("\n▶ 선불·체크카드의 빈 계좌는 문제다");
{
  const txns = [
    txn({ payment_method_id: "pm-prepaid", account_id: null, amount: 350_000 }),
    txn({ payment_method_id: "pm-check", account_id: null, amount: 20_000 }),
    txn({ payment_method_id: "pm-check", account_id: "acc-1", amount: 5_000 }), // 정상건은 안 세야 함
  ];
  const h = computeDataHealth({ txns, categories, paymentMethods, lastIngestAt: `${TODAY}T09:00:00+09:00`, today: TODAY });
  eq("2건 370,000원", get(h, "unlinked-account")?.value, "2건 · 370,000원");
  eq("level = warn", get(h, "unlinked-account")?.level, "warn");
}

console.log("\n▶ 미분류: 이체는 카테고리 없어도 정상");
{
  const txns = [
    txn({ type: "transfer", category_id: null, amount: 1_000_000 }),
    txn({ type: "expense", category_id: null, amount: 30_000 }),
  ];
  const h = computeDataHealth({ txns, categories, paymentMethods, lastIngestAt: `${TODAY}T09:00:00+09:00`, today: TODAY });
  eq("이체 제외하고 1건만", get(h, "uncategorized")?.value, "1건 · 30,000원");
  eq("100만 미만은 warn", get(h, "uncategorized")?.level, "warn");
}
{
  const txns = [txn({ type: "payment", category_id: null, amount: 1_500_000 })];
  const h = computeDataHealth({ txns, categories, paymentMethods, lastIngestAt: `${TODAY}T09:00:00+09:00`, today: TODAY });
  eq("100만 이상은 bad", get(h, "uncategorized")?.level, "bad");
}

console.log("\n▶ 대출 미연결 상환 + 연결률");
{
  const txns = [
    txn({ type: "payment", category_id: CAT_LOAN, loan_id: "loan-1", amount: 200_000 }),
    txn({ type: "payment", category_id: CAT_LOAN, loan_id: null, amount: 300_000 }),
    txn({ type: "payment", category_id: CAT_LOAN, loan_id: null, amount: 100_000 }),
  ];
  const h = computeDataHealth({ txns, categories, paymentMethods, lastIngestAt: `${TODAY}T09:00:00+09:00`, today: TODAY });
  eq("2건 400,000원 연결률 33%", get(h, "loan-unlinked")?.value, "2건 · 400,000원 (연결률 33%)");
  eq("연결률 50% 미만은 bad", get(h, "loan-unlinked")?.level, "bad");
}

console.log("\n▶ 완전동일 중복 후보");
{
  const same = { txn_date: "2026-03-03", type: "expense" as const, amount: 4_500, counterparty: "담배", account_id: "acc-1" };
  const txns = [txn({ ...same }), txn({ ...same }), txn({ ...same, amount: 9_000 })];
  const h = computeDataHealth({ txns, categories, paymentMethods, lastIngestAt: `${TODAY}T09:00:00+09:00`, today: TODAY });
  eq("1그룹", get(h, "duplicates")?.value, "1그룹");
}

console.log("\n▶ 수집 공백");
{
  const base = { txns: [txn({})], categories, paymentMethods, today: TODAY };
  eq("오늘 수집 = ok", computeDataHealth({ ...base, lastIngestAt: `${TODAY}T08:00:00+09:00` }).items.find((i) => i.key === "ingest-gap")?.level, "ok");
  eq("2일 전 = warn", computeDataHealth({ ...base, lastIngestAt: "2026-07-18T08:00:00+09:00" }).items.find((i) => i.key === "ingest-gap")?.level, "warn");
  eq("7일 전 = bad", computeDataHealth({ ...base, lastIngestAt: "2026-07-13T08:00:00+09:00" }).items.find((i) => i.key === "ingest-gap")?.level, "bad");
  const noIngest = computeDataHealth({ ...base, lastIngestAt: null });
  check("수집 기록 없으면 항목 자체를 안 만든다", !noIngest.items.some((i) => i.key === "ingest-gap"));
}

console.log("\n▶ 전부 정상이면 worst = ok");
{
  const txns = [txn({ payment_method_id: "pm-credit" })];
  const h = computeDataHealth({ txns, categories, paymentMethods, lastIngestAt: `${TODAY}T08:00:00+09:00`, today: TODAY });
  eq("worst", h.worst, "ok");
}

console.log(failures === 0 ? "\n✅ 전체 통과" : `\n❌ ${failures}건 실패`);
if (failures > 0) process.exitCode = 1;
