// 대출 월납 역산·카드대금 실납 판정 회귀 테스트 (설계 167·168)
//
// 돈을 계산하는 순수함수인데 테스트가 없었다. 여기 박아 둔 기대값은 **실측·문서 근거가 있는 값**이다:
//   - 현대캐피탈 697,161원 = hh_loan 에 등록된 월납입금(2026-08-13 실DB 실측, 오차 0)
//   - 국민 26.08 원금균등 1회차 1,059,583원 = 설계 162 ⑥ 이 실측으로 남긴 값
// ★기대값을 코드에서 역으로 베끼지 마라 — 그러면 공식이 바뀔 때 테스트가 같이 틀린다.
//
// 실행: npx tsx scripts/test_loan_estimate.mts
import type { HhLoan, HhTransaction } from "../src/lib/household/types";
const { estimateMonthlyPayment, inRepaymentMonth, firstRepaymentMonth, cardBillPaidIn, cardIssuerOf } =
  await import("../src/lib/household/loan-estimate");

let fail = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = got === want;
  if (!ok) fail += 1;
  console.log(`  ${ok ? "✅" : "❌"} ${label}${ok ? "" : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
}

const loan = (over: Partial<HhLoan> = {}): HhLoan => ({
  id: "l", owner_auth_uid: "u", name: "테스트카드-김하늘-카드론(26.01)",
  origin_date: "2026-01-05", principal: 12_000_000, current_balance: 12_000_000,
  maturity_date: "2027-01-05", interest_rate: 12, monthly_payment: null, payment_day: 25,
  account_id: "acct", repayment_type: null, source: "manual", status: "active",
  created_at: "", updated_at: "", ...over,
});

console.log("[1] 원리금균등 — 등록 월납입금을 재현하는가 (실DB 실측 근거)");
// 현대캐피탈: 원금 1억 · 7.47% · 2025-08-08~2055-08-25 (360개월) · 등록 월납 697,161원
eq("현대캐피탈 697,161원", estimateMonthlyPayment(loan({
  name: "대출상환-현대캐피탈", principal: 100_000_000, interest_rate: 7.47,
  origin_date: "2025-08-08", maturity_date: "2055-08-25",
})), 697_161);

console.log("\n[2] 원금균등 — 회차마다 줄어든다 (설계 162 실측값 재현)");
// 국민 26.08: 1,500만 · 18.1% · 2026-08-02~2028-02-10 (18개월) · 첫 상환 2026-09
const kb = loan({
  name: "국민카드-이바다-카드론(26.08)", principal: 15_000_000, interest_rate: 18.1,
  origin_date: "2026-08-02", maturity_date: "2028-02-10", repayment_type: "equal_principal",
});
eq("1회차 = 833,333 + 226,250 = 1,059,583원", estimateMonthlyPayment(kb, "2026-09"), 1_059_583);
const first = estimateMonthlyPayment(kb, "2026-09")!;
const mid = estimateMonthlyPayment(kb, "2027-06")!;
const last = estimateMonthlyPayment(kb, "2028-02")!;
eq("회차가 갈수록 줄어든다 (1 > 10 > 18)", first > mid && mid > last, true);
// ★기대값을 코드와 같은 식으로 다시 계산하면 안 된다 — 공식이 바뀔 때 테스트가 같이 틀린다
//   (교차리뷰 지적. 원래 여기 `Math.round(P/n + (P/n)*r)` 를 적어 두어 자기충족이었다).
//   손으로 계산한 값을 그대로 박는다: 원금분 833,333.33 + 이자 833,333.33×0.01508333 = 12,569.44
//   → 845,902.77 → 845,903원.
eq("마지막(18)회차 = 845,903원", last, 845_903);
// ★만기를 넘겨 물어도 마지막 회차로 고정된다(음수 잔여원금 방지).
eq("만기 이후는 마지막 회차로 클램프", estimateMonthlyPayment(kb, "2029-01"), last);
eq("첫 상환월 이전은 1회차로 클램프", estimateMonthlyPayment(kb, "2026-08"), first);
eq("ym 을 안 주면 1회차", estimateMonthlyPayment(kb), first);

console.log("\n[3] 원금균등 1개월짜리 — n=1 경계");
const one = loan({ origin_date: "2026-01-05", maturity_date: "2026-02-05", principal: 1_200_000, interest_rate: 12, repayment_type: "equal_principal" });
eq("원금 전액 + 한 달 이자", estimateMonthlyPayment(one, "2026-02"), 1_200_000 + 12_000);

console.log("\n[4] 만기일시 — 이자만");
eq("잔액 기준", estimateMonthlyPayment(loan({ repayment_type: "interest_only", current_balance: 6_000_000, interest_rate: 12 })), 60_000);
// ★잔액 0 → 원금 폴백. 만기일시는 만기까지 원금이 줄지 않으므로 상환중이면 잔액 == 원금이다.
//   current_balance 는 NOT NULL DEFAULT 0 이라 등록 시 안 채우면 0 이 되는데, 그걸 이자 0원으로
//   읽으면 나가는 돈을 안 나간다고 말하게 된다. (교차리뷰 Major — 실측상 활성 대출 중 잔액 0 은 0건)
eq("잔액 0 이면 원금 폴백 (1,200만 × 1% = 120,000원)", estimateMonthlyPayment(loan({ repayment_type: "interest_only", current_balance: 0, interest_rate: 12 })), 120_000);
// 일부 상환해 잔액이 원금보다 작으면 잔액 쪽이 맞다 — 폴백은 0 일 때만이어야 한다.
eq("잔액이 원금보다 작으면 잔액 기준", estimateMonthlyPayment(loan({ repayment_type: "interest_only", current_balance: 3_000_000, interest_rate: 12 })), 30_000);

console.log("\n[5] null(미지정)은 원리금균등과 완전히 같아야 한다 (설계 168 — 기존 화면 숫자 불변)");
eq("null == annuity", estimateMonthlyPayment(loan({ repayment_type: null }), "2026-05"),
   estimateMonthlyPayment(loan({ repayment_type: "annuity" }), "2026-05"));

console.log("\n[6] 값이 모자라면 null — 없는 값을 지어내지 않는다");
eq("실행일 없음", estimateMonthlyPayment(loan({ origin_date: null })), null);
eq("만기 없음", estimateMonthlyPayment(loan({ maturity_date: null })), null);
eq("금리 없음", estimateMonthlyPayment(loan({ interest_rate: null })), null);
eq("만기가 실행일보다 앞", estimateMonthlyPayment(loan({ origin_date: "2027-01-05", maturity_date: "2026-01-05" })), null);

console.log("\n[7] 상환기간 경계 — 첫 상환월은 실행월의 '다음 달'");
eq("첫 상환월 = 2026-02", firstRepaymentMonth(loan()), "2026-02");
eq("12월 실행 → 이듬해 1월", firstRepaymentMonth(loan({ origin_date: "2026-12-11" })), "2027-01");
eq("실행월은 상환기간 밖", inRepaymentMonth(loan(), "2026-01"), false);
eq("첫 상환월은 안", inRepaymentMonth(loan(), "2026-02"), true);
eq("만기월은 포함", inRepaymentMonth(loan(), "2027-01"), true);
eq("만기 다음달은 밖", inRepaymentMonth(loan(), "2027-02"), false);

console.log("\n[8] 카드대금 실납 판정 — 증거가 있을 때만 (설계 131·167)");
const bill = (over: Partial<HhTransaction> = {}): HhTransaction => ({
  id: "p", owner_auth_uid: "u", txn_date: "2026-05-25", type: "payment", amount: 3_000_000,
  category_id: null, counterparty: "테스트카드", memo: null, note: null, payment_method_id: null,
  account_id: "acct", from_account_id: null, to_account_id: null, person_id: null,
  installment_id: null, loan_id: null, source: "manual", created_at: "", updated_at: "", ...over,
});
eq("카드사명 추출", cardIssuerOf("테스트카드-김하늘-카드론(26.01)"), "테스트카드");
eq("정상 카드대금 → 나갔다", cardBillPaidIn(loan(), [bill()], 1_000_000), true);
eq("다른 계좌 → 아니다", cardBillPaidIn(loan(), [bill({ account_id: "other" })], 1_000_000), false);
eq("다른 카드사 → 아니다", cardBillPaidIn(loan(), [bill({ counterparty: "딴카드" })], 1_000_000), false);
// ★loan_id 가 붙은 거래는 카드론 완제 등 '소속이 확정된' 거래다. 카드대금으로 세면 오판한다
//   (2026-08-04 삼성카드 623,653원 = 25.10 카드론 완제. 설계 167 ③ 가드).
eq("loan_id 붙은 거래 제외", cardBillPaidIn(loan(), [bill({ loan_id: "other-loan" })], 1_000_000), false);
// ★하한 미만은 제외 — 소액 결제 1건으로 월납 전액을 '나갔다'로 만들면 안 된다(교차리뷰 Major).
eq("하한 미만 소액 제외", cardBillPaidIn(loan(), [bill({ amount: 7_785 })], 1_000_000), false);
eq("하한 이상이면 인정", cardBillPaidIn(loan(), [bill({ amount: 1_000_000 })], 1_000_000), true);
eq("결제계좌 없는 대출 → 판정 불가", cardBillPaidIn(loan({ account_id: null }), [bill()], 0), false);

console.log("\n[9] buildCardLoanEstimate 는 상환완료를 스스로 거른다 (호출부에 기대지 않는다)");
{
  const { buildCardLoanEstimate } = await import("../src/lib/household/loan-estimate");
  const active = loan({ id: "a", name: "가카드-소유자-카드론(26.01)", repayment_type: "annuity" });
  const closed = loan({ id: "c", name: "나카드-소유자-카드론(25.01)", status: "closed", current_balance: 0 });
  const r = buildCardLoanEstimate([active, closed], "2026-06", []);
  eq("활성만 역산 대상", r.estMap.size, 1);
  eq("상환완료는 제외", r.estMap.has("c"), false);
}

// ★종료 판정은 **반드시 맨 끝**이다. 뒤에 검사를 더 붙이면 그 검사는 실패해도 exit 0 이 나가
//   검사기가 조용히 거짓말을 한다(2026-08-13 실제로 [9]를 뒤에 붙였다가 잡았다).
if (fail) {
  console.log(`\n❌ ${fail}건 실패`);
  process.exit(1);
}
console.log("\n✅ 전체 통과");
