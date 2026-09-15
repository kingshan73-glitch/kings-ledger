// 정기지출·대출의 시작월/종료월 필터 검증 — DB 없이 합성 데이터로 계산 규칙만 본다.
//   npm run test:sched-period
//
// 왜 이 테스트가 필요한가:
//   기간 필터가 예전엔 projectMonths 안에만 있었다. 그래서 같은 화면의 두 숫자가 어긋났다 —
//   '당월 출금 예정'(cashflowCalendar → monthlyCashflow 직접 호출)은 끝난 학원비를 계속 더하고,
//   '여러 달 앞 예측'(projectMonths)은 제외해서, 상단 카드와 아래 예측표가 달랐다.
//   필터를 monthlyCashflow 안으로 옮겼으므로, 두 경로가 같은 기준을 쓰는지 여기서 고정한다.
//   (현재 운영 데이터는 정기지출 76건이 전부 '매월'이고 종료일도 안 쓰고 있어
//    화면만 봐서는 이 경로가 검증되지 않는다 — 그래서 합성 데이터로 못박는다.)
//
// 검증 항목:
//   1) 종료월이 지난 정기지출은 제외 / 종료월 당월은 포함(경계)
//   2) 시작월이 아직 안 된 정기지출은 제외 / 시작월 당월은 포함(경계)
//   3) 만기가 지난 대출은 제외 / 실행 전 대출은 제외
//   4) monthlyCashflow 와 projectMonths 가 같은 달에 같은 값을 낸다(설계 79 취지)
const { monthlyCashflow, projectMonths } = await import("../src/lib/household/calc");
import type { HhLoan, HhScheduledPayment } from "../src/lib/household/types";

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

const loan = (over: Partial<HhLoan>): HhLoan => ({
  id: "loan", owner_auth_uid: OWNER, name: "대출", status: "active",
  principal: 10_000_000, current_balance: 5_000_000, monthly_payment: 300_000,
  payment_day: 15, account_id: "acc-1", origin_date: null, maturity_date: null,
  interest_rate: null, memo: null, sort_order: 0, created_at: "", updated_at: "",
  ...over,
} as unknown as HhLoan);

// 기준월 2026-07. 종료월이 2026-05 인 학원비는 빠지고, 2026-07 인 항목은 남아야 한다.
const scheduled: HhScheduledPayment[] = [
  sp({ id: "sp-ended", title: "학원비-끝남", amount: 300_000, end_date: "2026-05-31" }),
  sp({ id: "sp-ends-this-month", title: "학원비-이달종료", amount: 200_000, end_date: "2026-07-31" }),
  sp({ id: "sp-future", title: "아직-시작전", amount: 400_000, start_date: "2026-09-01" }),
  sp({ id: "sp-starts-this-month", title: "이달-시작", amount: 150_000, start_date: "2026-07-01" }),
  sp({ id: "sp-plain", title: "기간없음", amount: 100_000 }),
];

const loans: HhLoan[] = [
  loan({ id: "loan-matured", name: "만기지남", monthly_payment: 500_000, maturity_date: "2026-06-30" }),
  loan({ id: "loan-live", name: "상환중", monthly_payment: 250_000, maturity_date: "2030-01-01" }),
  loan({ id: "loan-future", name: "실행전", monthly_payment: 700_000, origin_date: "2026-10-01" }),
];

console.log("▶ 정기지출 기간 필터 (기준월 2026-07)");
const cf = monthlyCashflow("2026-07", { scheduled, loans: [], installments: [] });
const has = (id: string) => cf.items.some((i) => i.sourceId === id);
check("종료월이 지난 항목은 제외", !has("sp-ended"));
check("종료월 당월은 포함(경계 inclusive)", has("sp-ends-this-month"));
check("시작월이 아직 안 된 항목은 제외", !has("sp-future"));
check("시작월 당월은 포함(경계 inclusive)", has("sp-starts-this-month"));
check("기간 미지정 항목은 항상 포함", has("sp-plain"));
// 200,000 + 150,000 + 100,000 (끝난 300,000 과 미래 400,000 은 빠진다)
eq("출금 합계", cf.totalOut, 450_000);

console.log("\n▶ 대출 기간 필터");
const cfLoan = monthlyCashflow("2026-07", { scheduled: [], loans, installments: [] });
const hasLoan = (id: string) => cfLoan.items.some((i) => i.sourceId === id);
check("만기가 지난 대출은 제외", !hasLoan("loan-matured"));
check("상환중 대출은 포함", hasLoan("loan-live"));
check("실행 전 대출은 제외", !hasLoan("loan-future"));
eq("대출 출금 합계", cfLoan.totalOut, 250_000);

console.log("\n▶ 두 경로가 같은 기준을 쓰는지 (설계 79)");
// projectMonths 첫 달 = monthlyCashflow 같은 달. 예전엔 여기서 갈렸다.
const proj = projectMonths(0, "2026-07", 3, { scheduled, loans, installments: [] });
eq("예측 첫 달 출금 = monthlyCashflow 출금", proj[0].outflow, cf.totalOut + cfLoan.totalOut);
// 2026-08: 이달종료 학원비(200,000)가 빠져 250,000 감소
eq("2026-08 출금", proj[1].outflow, cf.totalOut + cfLoan.totalOut - 200_000);
// 2026-09: 시작전 항목(400,000)이 들어온다
eq("2026-09 출금", proj[2].outflow, cf.totalOut + cfLoan.totalOut - 200_000 + 400_000);

console.log(failures === 0 ? "\n✅ 전체 통과" : `\n❌ ${failures}건 실패`);
if (failures > 0) process.exitCode = 1;
