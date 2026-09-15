import { strict as assert } from "node:assert";

const { formatLoanTermsParts, formatLoanTermsLine } = await import("../src/lib/household/loan-terms-format");

let passed = 0;
let failed = 0;
const test = (name: string, fn: () => void) => {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failed++;
    console.log(`  ❌ ${name}\n     ${(error as Error).message}`);
  }
};

test("모든 카드론 조건을 한 줄로 표시", () => {
  assert.equal(formatLoanTermsLine({ rate: 18.1, term_months: 18, repayment_type: "equal_principal", total_repayment: 17211195, maturity_date: "2028-02-10" }), "연 18.10% · 18개월 · 원금균등 · 만기 2028-02-10 · 총 17,211,195원");
});

test("있는 조건만 표시", () => {
  assert.equal(formatLoanTermsLine({ rate: 12.2, term_months: null, repayment_type: null, total_repayment: null, maturity_date: null }), "연 12.20%");
});

test("모든 조건이 null이면 빈 문자열", () => {
  assert.equal(formatLoanTermsLine({ rate: null, term_months: null, repayment_type: null, total_repayment: null, maturity_date: null }), "");
});

test("상환방식 3종 라벨", () => {
  const base = { rate: null, term_months: null, total_repayment: null, maturity_date: null };
  assert.deepEqual(
    ["annuity", "equal_principal", "interest_only"].map((repayment_type) => formatLoanTermsLine({ ...base, repayment_type: repayment_type as "annuity" | "equal_principal" | "interest_only" })),
    ["원리금균등", "원금균등", "만기일시"]
  );
});

test("표용 조각: [이자율·기간·상환방식] [만기] [총원리금] 순, 있는 것만", () => {
  assert.deepEqual(
    formatLoanTermsParts({ rate: 18.1, term_months: 18, repayment_type: "equal_principal", total_repayment: 17211195, maturity_date: "2028-02-10" }),
    ["연 18.10% · 18개월 · 원금균등", "만기 2028-02-10", "총 17,211,195원"]
  );
  assert.deepEqual(formatLoanTermsParts({ rate: 12.2, term_months: null, repayment_type: null, total_repayment: null, maturity_date: null }), ["연 12.20%"]);
  assert.deepEqual(formatLoanTermsParts({ rate: null, term_months: null, repayment_type: null, total_repayment: null, maturity_date: null }), []);
});

console.log(`\nResult: ${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
