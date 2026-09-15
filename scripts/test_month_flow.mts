// 월별 흐름 그래프의 숫자 규칙 회귀 테스트 (설계 189·190·192)
//
// ★왜 필요한가 — 2026-08-26 교차검토 지적: 이 커밋의 **핵심 숫자 변경**(할부를 결제월 총액으로,
//   수입에서 대출 실행금 제외, 마스킹이 0을 보존)에 테스트가 하나도 없었다. 전부 순수함수라 값싸다.
//   ★Rule 28 — 옛 규칙으로 되돌리면 실제로 실패하는지 확인하고 못박았다.
import { isDeepStrictEqual } from "node:util";

const calc = await import("../src/lib/household/calc");
const { monthFlowTotals, loanIncomeCategoryId, loanCategoryId } = calc;
const masking = await import("../src/lib/masking");

let pass = 0;
let fail = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { pass += 1; console.log(`  OK ${msg}`); }
  else { fail += 1; console.log(`  FAIL ${msg}`); }
}

// ── 픽스처 (전부 합성값) ───────────────────────────────────────────────────
const CAT = {
  salary: "cat-salary",
  loanIncome: "cat-loan-income",   // 수입 '대출' = 대출 실행금(빌린 돈)
  loanRepay: "cat-loan-repay",     // 지출 '대출상환' = 갚은 돈
  food: "cat-food",
};
const categories = [
  { id: CAT.salary, name: "급여", kind: "income" as const },
  { id: CAT.loanIncome, name: "대출", kind: "income" as const },
  { id: CAT.loanRepay, name: "대출상환", kind: "expense" as const },
  { id: CAT.food, name: "식료품비", kind: "expense" as const },
];
// `monthFlowTotals` 가 실제로 읽는 필드만 갖춘 최소 픽스처. 전체 행 타입을 흉내 내지 않는다 —
// 흉내 내면 스키마가 늘 때마다 테스트가 먼저 깨져 정작 규칙 회귀를 못 지킨다.
type TxnLike = Parameters<typeof monthFlowTotals>[1][number];
type InsLike = Parameters<typeof monthFlowTotals>[2][number];
const tx = (o: Partial<TxnLike>): TxnLike =>
  ({ id: "t", amount: 0, type: "expense", txn_date: "2026-03-10", category_id: null, ...o }) as TxnLike;
const ins = (o: Partial<InsLike>): InsLike =>
  ({ id: "i", is_active: true, start_date: "2026-03-10", total_amount: 0, total_count: 3, start_installment: 1, ...o }) as InsLike;

const LOAN_CAT = loanCategoryId(categories);
const LOAN_INCOME_CAT = loanIncomeCategoryId(categories);

// ── 카테고리 찾기 ─────────────────────────────────────────────────────────
ok(LOAN_INCOME_CAT === CAT.loanIncome, `loanIncomeCategoryId: 수입 '대출' 을 집는다 (${LOAN_INCOME_CAT})`);
ok(LOAN_CAT === CAT.loanRepay, `loanCategoryId: 지출 '대출상환' 을 집는다 (${LOAN_CAT})`);
// ★kind 를 함께 봐야 한다 — 이름만 보면 지출 쪽을 잘못 집는다.
ok(
  loanIncomeCategoryId([{ id: "x", name: "대출", kind: "expense" }]) === null,
  "loanIncomeCategoryId: 이름이 '대출' 이어도 kind 가 expense 면 안 집는다"
);
// ★못 찾으면 null — 이때 화면은 '대출 실행금을 뺐다'고 말하면 안 된다(monthly-flow-chart 가 문구·배너로 처리).
ok(
  loanIncomeCategoryId([{ id: "x", name: "대출금", kind: "income" }]) === null,
  "loanIncomeCategoryId: 이름이 바뀌면 null (조용히 예전 숫자로 돌아가는 지점)"
);

// ── 수입·대출실행·대출상환: 서로 겹치지 않는 계열 ────────────────────────
{
  const txns = [
    tx({ type: "income", amount: 5_000_000, category_id: CAT.salary, txn_date: "2026-03-25" }),
    tx({ type: "income", amount: 15_000_000, category_id: CAT.loanIncome, txn_date: "2026-03-02" }),
    tx({ type: "payment", amount: 900_000, category_id: CAT.loanRepay, txn_date: "2026-03-26" }),
  ];
  const withFilter = monthFlowTotals("2026-03", txns, [], LOAN_CAT, LOAN_INCOME_CAT);
  ok(withFilter.income === 5_000_000, `수입에서 대출 실행금 제외 (${withFilter.income})`);
  ok(withFilter.loanIn === 15_000_000, `대출 실행금은 loanIn 에만 집계 (${withFilter.loanIn})`);
  ok(withFilter.loan === 900_000, `대출 상환금은 loan 에만 집계 (${withFilter.loan})`);
  ok(withFilter.expense === 0, `대출 실행·상환은 지출과 겹치지 않음 (${withFilter.expense})`);
  // 인자를 안 주면 예전 동작 — 이 대비가 곧 회귀 가드다.
  const noFilter = monthFlowTotals("2026-03", txns, [], LOAN_CAT);
  ok(noFilter.income === 20_000_000, `필터 인자 없으면 예전대로 전액 (${noFilter.income})`);
  ok(noFilter.loanIn === 0, `필터 인자 없으면 대출실행 별도 집계 없음 (${noFilter.loanIn})`);

  const otherMonth = monthFlowTotals("2026-04", txns, [], LOAN_CAT, LOAN_INCOME_CAT);
  ok(otherMonth.loanIn === 0, `다른 달 대출 실행금은 0 (${otherMonth.loanIn})`);
  ok(otherMonth.loan === 0, `다른 달 대출 상환금은 0 (${otherMonth.loan})`);

  // ★type 가드 — 수입 카테고리 '대출'이 payment/expense 에 잘못 붙어도 loanIn 으로 새지 않는다.
  //   지금은 `else if` 순서가 지키는데, 카테고리 검사를 type 분기 위로 끌어올리는 리팩터링이 오면
  //   상환이 실행으로 둔갑한다(2026-08-27 검토 지적). 그걸 여기서 못박는다.
  const wrongType = monthFlowTotals(
    "2026-03",
    [
      tx({ type: "payment", amount: 700_000, category_id: CAT.loanIncome, txn_date: "2026-03-10" }),
      tx({ type: "expense", amount: 30_000, category_id: CAT.loanIncome, txn_date: "2026-03-11" }),
    ],
    [],
    LOAN_CAT,
    LOAN_INCOME_CAT
  );
  ok(wrongType.loanIn === 0 && wrongType.loan === 0, `income 이 아닌 거래는 카테고리가 '대출'이어도 loanIn/loan 에 안 들어감 (${wrongType.loanIn}/${wrongType.loan})`);
  ok(wrongType.expense === 30_000, `그중 expense 는 지출로만 (${wrongType.expense})`);
}

// ── 지출: 할부를 결제월에 총액으로 ────────────────────────────────────────
{
  const installments = [ins({ start_date: "2026-03-10", total_amount: 1_200_000, total_count: 12 })];
  const march = monthFlowTotals("2026-03", [], installments, LOAN_CAT, LOAN_INCOME_CAT);
  const april = monthFlowTotals("2026-04", [], installments, LOAN_CAT, LOAN_INCOME_CAT);
  ok(march.expense === 1_200_000, `할부: 결제월에 총액 (3월 ${march.expense})`);
  ok(april.expense === 0, `할부: 다음 달엔 0 — 쪼개지 않는다 (4월 ${april.expense})`);
  // ★이 기준의 대가: 해를 넘긴 할부는 **실제 나가는 해에 안 잡힌다**. 의도된 성질이라 못박아 둔다.
  const crossYear = [ins({ start_date: "2025-11-05", total_amount: 1_200_000, total_count: 12 })];
  ok(
    monthFlowTotals("2026-01", [], crossYear, LOAN_CAT, LOAN_INCOME_CAT).expense === 0,
    "할부: 2025년에 결제한 할부는 2026년 막대에 안 잡힌다(결제월 기준의 대가 — 의도된 성질)"
  );
}

// ── 지출 = 지출거래 + 할부(결제월). 카드대금·이체·대출상환은 제외 ─────────
{
  const txns = [
    tx({ type: "expense", amount: 30_000, category_id: CAT.food, txn_date: "2026-03-05" }),
    tx({ type: "payment", amount: 900_000, category_id: CAT.loanRepay, txn_date: "2026-03-25" }), // 대출 상환
    tx({ type: "payment", amount: 500_000, category_id: null, txn_date: "2026-03-26" }),          // 카드대금
    tx({ type: "transfer", amount: 700_000, txn_date: "2026-03-20" }),                            // 통장이동
  ];
  const f = monthFlowTotals("2026-03", txns, [ins({ total_amount: 100_000 })], LOAN_CAT, LOAN_INCOME_CAT);
  ok(f.expense === 130_000, `지출 = 지출거래 + 할부총액, 카드대금·이체 제외 (${f.expense})`);
  ok(f.loan === 900_000, `대출은 상환액만 별도 계열 (${f.loan})`);
  ok(f.income === 0, `수입 없음 (${f.income})`);
}

// ── 다른 달은 안 센다 ─────────────────────────────────────────────────────
{
  const f = monthFlowTotals("2026-03", [tx({ type: "expense", amount: 999, txn_date: "2026-04-01" })], [], LOAN_CAT, LOAN_INCOME_CAT);
  ok(isDeepStrictEqual(f, { income: 0, expense: 0, loan: 0, loanIn: 0 }), `다른 달 거래는 안 센다 (${JSON.stringify(f)})`);
}

// ── 비활성 할부는 빠진다 (동작 명시 — 과거 달이 소급해 줄어드는 지점) ──────
{
  const f = monthFlowTotals("2026-03", [], [ins({ total_amount: 500_000, is_active: false })], LOAN_CAT, LOAN_INCOME_CAT);
  ok(f.expense === 0, `비활성 할부는 결제월에서도 빠진다 — 끄면 과거 막대가 줄어든다(알려진 성질) (${f.expense})`);
}

// ── 마스킹: 0 은 그대로 둔다 ──────────────────────────────────────────────
{
  const { mask } = masking;
  for (const cat of ["amount", "income_amount", "expense_amount"] as const) {
    const zero = mask(cat, "0", true);
    ok(zero.replace(/[^\d]/g, "") === "0", `마스킹[${cat}]은 0 을 0 으로 둔다 (${zero})`);
  }
  ok(mask("expense_amount", "0원", true).replace(/[^\d]/g, "") === "0", `'0원' 도 그대로 (${mask("expense_amount", "0원", true)})`);
  // 0 이 아닌 금액은 여전히 가려야 한다 — 0 보존이 마스킹 자체를 죽이면 안 된다.
  ok(
    mask("expense_amount", "123456", true).replace(/[^\d]/g, "") !== "123456",
    `0 이 아닌 금액은 여전히 가린다 (${mask("expense_amount", "123456", true)})`
  );
  ok(mask("expense_amount", "123456", false) === "123456", "마스킹 OFF 면 원본 그대로");
}

console.log(`\nResult: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
