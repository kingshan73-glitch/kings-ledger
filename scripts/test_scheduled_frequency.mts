// 정기지출 주기별 월환산 검증 (설계 91 §6) — DB 없이 합성 데이터로 계산 규칙만 본다.
//   npm run test:sched-freq
// 검증 항목:
//   1) 매월(monthly)은 금액 그대로
//   2) 주간(weekly)은 52/12(≈4.333) 환산 — ×4 는 한 달을 28일로 보는 셈이라 7.7% 과소
//   3) 격월(bimonthly)은 절반
//   4) 주간 항목은 특정 납부일이 없다(day=null)
//   5) 방향(in/out) 합계가 주기 환산을 반영한다
const { monthlyCashflow } = await import("../src/lib/household/calc");
import type { HhScheduledPayment } from "../src/lib/household/types";

const MONTH = "2026-07";
const OWNER = "owner-1";

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

const sp = (over: Partial<HhScheduledPayment>): HhScheduledPayment => ({
  id: "sp", owner_auth_uid: OWNER, title: "항목", direction: "out", amount: 100_000,
  frequency: "monthly", pay_day: 10, account_id: "acc-1", category_id: "cat-1",
  is_active: true, start_date: null, end_date: null, person_id: null, memo: null,
  sort_order: 0, created_at: "", updated_at: "",
  ...over,
} as unknown as HhScheduledPayment);

const scheduled: HhScheduledPayment[] = [
  sp({ id: "sp-monthly", title: "월세", frequency: "monthly", amount: 500_000, pay_day: 5 }),
  sp({ id: "sp-weekly", title: "주간 장보기", frequency: "weekly", amount: 30_000, pay_day: 1 }),
  sp({ id: "sp-bimonthly", title: "격월 정기검진", frequency: "bimonthly", amount: 80_000, pay_day: 20 }),
  sp({ id: "sp-weekly-in", title: "주간 용돈수입", direction: "in", frequency: "weekly", amount: 10_000, pay_day: 3 }),
];

const { items, totalOut, totalIn } = monthlyCashflow(MONTH, { scheduled, loans: [], installments: [] });
const find = (id: string) => items.find((i) => i.sourceId === id);

console.log("▶ 주기별 월환산");
eq("매월은 금액 그대로", find("sp-monthly")?.amount, 500_000);
// 30,000 × 52/12 = 130,000
eq("주간은 52/12 환산", find("sp-weekly")?.amount, 130_000);
check("주간이 ×4(120,000)가 아니다", find("sp-weekly")?.amount !== 120_000);
eq("격월은 절반", find("sp-bimonthly")?.amount, 40_000);

console.log("\n▶ 납부일 처리");
eq("주간 항목은 납부일 없음", find("sp-weekly")?.day, null);
eq("매월 항목은 납부일 유지", find("sp-monthly")?.day, 5);

console.log("\n▶ 합계");
// out = 500,000 + 130,000 + 40,000
eq("출금 합계", totalOut, 670_000);
// in = 10,000 × 52/12 = 43,333
eq("입금 합계(주간 수입도 동일 환산)", totalIn, 43_333);

console.log(failures === 0 ? "\n✅ 전체 통과" : `\n❌ ${failures}건 실패`);
if (failures > 0) process.exitCode = 1;
