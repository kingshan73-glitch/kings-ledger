// 설계 203 — 정기지출 결제수단의 **월별 오버라이드** 검사. DB 없이 합성 데이터로 규칙을 고정한다.
//   npm run test:month-method
//
// 실사례를 그대로 본뜬다(2026-09-04 팀장 신고 "학원비 결제한 게 있는데 현금흐름에 반영이 안 되었어"):
//   · 학원비-목동수학 350,000 은 결제수단이 삼성카드(credit)로 **고정**돼 매달 cardCharge=true 라
//     지갑(부천페이)으로 낸 달의 현금 유출이 출금예정 합계에서 통째로 빠졌다(7~9월 실측 1,020,000원.
//     그중 350,000 은 아래 오매칭으로 엉뚱한 항목이 대신 세고 있어, 정정 후 순증은 670,000원).
//   · 그 사이 9/4 목동수학 350,000 거래를 금액만 같은 `학원비-영어과외`(350,000)가 가로챘다.
//     `matchItems.filter(i => !i.cardCharge)` 라 **정작 주인은 매칭 후보조차 아니었기 때문**이다.
//     (같은 사고가 2026-08-04 에도 났고 그땐 '카드 거래를 풀에서 빼서' 막았는데, 지갑으로 낸 달은
//      거래가 현금성이라 풀에 남아 구멍이 그대로였다 — calc.ts outflowsForMatching 주석 참고.)
//
// 검증 항목:
//   [1] 오버라이드가 없으면 **종전과 완전히 같다**(이 설계의 안전판)
//   [2] 카드 항목에 지갑을 지정한 달 → cardCharge=false · 출금계좌=지갑 연결계좌 · 합계에 들어온다
//   [3] ★그 달 매칭에 참여해 **자기 거래를 집고**, 금액만 같은 남이 못 가져간다
//   [4] 현금 항목에 카드를 지정한 달 → cardCharge=true · 계좌 없음 · 합계에서 빠진다
//   [5] 익월은 당월 오버라이드를 **물려받지 않는다**(설계 203 §4)
//   [6] 대출은 결제수단 개념이 없어 오버라이드를 받아도 무시한다
//   [7] 알 수 없는 결제수단 id 가 들어와도 죽지 않는다 — ★FK 가 ON DELETE SET NULL 이라 '수단 삭제'
//       로는 이 상태가 안 생긴다. 마이그레이션 이전 데이터·수동 조작 같은 **방어 경로**를 고정하는 것이다
//   [8] ★결제수단만 바꿔선 **안 풀린다** — 예정금액이 실제와 다르면 점수가 낮아 여전히 가로채인다
//   [9] ★금액 오버라이드까지 같이 넣어야 1패스(정확금액+상호일치)에서 주인이 가져간다
//  [10] ★수단만 바꿔 매칭이 안 붙어도 그 행이 표에서 사라지지 않는다
//  [11] ★그 달 오버라이드가 m+2 이후 예측을 바꾸지 않는다
//  [14] ★그 달 카드 지정이 **과거 실적의 주인**을 바꾸지 않는다(계좌 우선순위 오염)
//  [15] ★익월에만 있는 신규 항목도 수단을 명시하면 익월 표·예측에 남는다
//  [16] ★당월 지정이 **전월 열** 표시를 바꾸지 않는다
const { cashflowSnapshot, computeCashMatches } = await import("../src/lib/household/cashflow-snapshot");
import type {
  HhCashflowOverride,
  HhInstallment,
  HhLoan,
  HhPaymentMethod,
  HhScheduledPayment,
  HhTransaction,
} from "../src/lib/household/types";

const MONTH = "2026-09";
const NEXT = "2026-10";
const OWNER = "owner-1";

let failures = 0;
let groups = 0;
function group(name: string) {
  groups++;
  console.log(`\n[${groups}] ${name}`);
}
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

// ── 합성 마스터 ────────────────────────────────────────────────
const sp = (over: Partial<HhScheduledPayment> & { id: string; title: string; amount: number }) =>
  ({
    owner_auth_uid: OWNER, direction: "out", frequency: "monthly", pay_day: 5,
    account_id: null, category_id: "cat-edu", is_active: true, start_date: null, end_date: null,
    person_id: null, memo: null, sort_order: 0, payment_method_id: null, created_at: "", updated_at: "",
    ...over,
  }) as unknown as HhScheduledPayment;

const scheduled: HhScheduledPayment[] = [
  // 카드로 고정된 학원비 — 실제로는 달마다 카드↔지갑이 바뀐다.
  sp({ id: "sp-math", title: "학원비-목동수학", amount: 350_000, pay_day: 5, payment_method_id: "pm-card" }),
  // 같은 금액의 현금 항목 — 9월 실거래가 없는데도 목동수학 거래를 가로챘던 그 항목.
  sp({ id: "sp-eng", title: "학원비-영어과외", amount: 350_000, pay_day: 8, account_id: "acc-toss" }),
];

const loans: HhLoan[] = [
  {
    id: "loan-1", owner_auth_uid: OWNER, name: "대출상환-테스트", principal: 10_000_000,
    current_balance: 9_000_000, monthly_payment: 200_000, payment_day: 25,
    status: "active", origin_date: "2020-01-01", maturity_date: "2040-01-01",
    interest_rate: 3.5, account_id: "acc-woori", created_at: "", updated_at: "",
  } as unknown as HhLoan,
];
const installments: HhInstallment[] = [];

const methods: HhPaymentMethod[] = [
  { id: "pm-card", owner_auth_uid: OWNER, name: "삼성카드(김하늘)-1234", kind: "credit",
    billing_day: 25, linked_account_id: "acc-woori", is_active: true, sort_order: 0,
    created_at: "", updated_at: "" } as unknown as HhPaymentMethod,
  { id: "pm-wallet", owner_auth_uid: OWNER, name: "부천페이(이바다)", kind: "cash",
    billing_day: null, linked_account_id: "acc-bpay", is_active: true, sort_order: 1,
    created_at: "", updated_at: "" } as unknown as HhPaymentMethod,
];

// 9/4 목동수학 350,000 을 부천페이(지갑=현금성)로 결제 — 카드가 아니라 매칭 풀에 **남는다**.
const mathTxn = {
  amount: 350_000, counterparty: "목동수학보습학원", txn_date: "2026-09-04",
  type: "expense", account_id: "acc-bpay", from_account_id: null, to_account_id: null,
  payment_method_id: "pm-wallet",
};
const recentOutflows = [mathTxn];
const txns: HhTransaction[] = [];
const accountIds = ["acc-woori", "acc-bpay", "acc-toss"];

const ov = (over: Partial<HhCashflowOverride> & { source_id: string; year_month: string }) =>
  ({
    id: `ov-${over.source_id}-${over.year_month}`, owner_auth_uid: OWNER, source_kind: "fixed",
    amount_override: null, account_id: null, released: false, day_override: null,
    paid_override: null, payment_method_id: null, created_at: "", updated_at: "",
    ...over,
  }) as unknown as HhCashflowOverride;

const base = { scheduled, loans, installments, txns, methods, recentOutflows, accountIds, totalCash: 0, horizon: 3 };
const snapOf = (overrides: HhCashflowOverride[], nextOverrides: HhCashflowOverride[] = []) =>
  cashflowSnapshot(MONTH, { ...base, overrides, nextOverrides });
const itemOf = (s: ReturnType<typeof cashflowSnapshot>, key: string) => s.classified.find((i) => i.key === key);

// ── [1] 오버라이드 없음 = 종전 동작 ─────────────────────────────
group("오버라이드가 없으면 종전과 완전히 같다");
const A = snapOf([]);
const mathA = itemOf(A, "fixed:sp-math");
const engA = itemOf(A, "fixed:sp-eng");
eq("목동수학은 카드청구(항목에 신용카드가 붙어 있다)", mathA?.cardCharge, true);
eq("카드청구라 출금계좌 없음", mathA?.accountId, null);
eq("영어과외는 현금", engA?.cardCharge, false);
// ★이것이 팀장이 신고한 그 증상이다 — 재현되지 않으면 이 검사는 아무것도 지키지 못한다.
eq("★버그 재현: 주인이 매칭 후보가 아니라 영어과외가 목동수학 거래를 가로챈다", engA?.paidAmount, 350_000);
eq("★그리고 정작 목동수학은 빈칸", mathA?.paidAmount, null);

// ── [2] 카드 항목에 지갑 지정 → 현금으로 바뀐다 ─────────────────
group("그 달만 지갑으로 지정하면 현금 결제가 된다");
const B = snapOf([ov({ source_id: "sp-math", year_month: MONTH, payment_method_id: "pm-wallet" })]);
const mathB = itemOf(B, "fixed:sp-math");
eq("cardCharge 가 false 로 뒤집힌다", mathB?.cardCharge, false);
eq("출금계좌 = 그 지갑의 연결계좌", mathB?.accountId, "acc-bpay");
eq("표에 보이는 결제수단도 그 달 수단", mathB?.paymentMethodId, "pm-wallet");
check("합계(cashOut)에 들어온다", B.activeItems.some((i) => i.key === "fixed:sp-math" && !i.cardCharge));

// ── [3] ★매칭에 참여해 자기 거래를 집는다 ───────────────────────
group("★그 달 매칭에 참여해 자기 거래를 집고, 금액만 같은 남이 못 가져간다");
const engB = itemOf(B, "fixed:sp-eng");
eq("목동수학이 9/4 목동수학보습학원 350,000 을 가져간다", mathB?.paidAmount, 350_000);
eq("★영어과외는 빈칸으로 돌아간다(9월에 실제로 안 냈다)", engB?.paidAmount, null);
check(
  "매칭 결과가 상호까지 맞는 짝이다",
  B.paidThisMonth.get("fixed:sp-math")?.counterparty === "목동수학보습학원",
  `실제 ${B.paidThisMonth.get("fixed:sp-math")?.counterparty}`
);

// ── [4] 현금 항목에 카드 지정 → 합계에서 빠진다 ─────────────────
group("그 달만 카드로 지정하면 합계에서 빠진다(반대 방향)");
const C = snapOf([ov({ source_id: "sp-eng", year_month: MONTH, payment_method_id: "pm-card" })]);
const engC = itemOf(C, "fixed:sp-eng");
eq("cardCharge 가 true 로 바뀐다", engC?.cardCharge, true);
eq("카드 결제분은 계좌를 갖지 않는다(설계 108)", engC?.accountId, null);
check("합계에서 빠진다", !C.activeItems.some((i) => i.key === "fixed:sp-eng" && !i.cardCharge));
// 영어과외가 카드가 되어 매칭 풀에서 빠지면, 목동수학(여전히 카드)도 후보가 아니라 거래는 주인이 없다.
eq("영어과외는 더는 남의 거래를 가로채지 않는다", engC?.paidAmount, null);

// ── [5] 익월로 안 번진다 ────────────────────────────────────────
group("당월 오버라이드는 익월로 물려지지 않는다 (설계 203 §4)");
const D = snapOf([ov({ source_id: "sp-math", year_month: MONTH, payment_method_id: "pm-wallet" })]);
const mathNext = D.nextItems.find((i) => i.key === "fixed:sp-math");
eq("익월은 = 2026-10", D.nextMonth, NEXT);
eq("★익월 목동수학은 다시 카드청구(항목 등록값)", mathNext?.cardCharge, true);
eq("익월 결제수단도 항목 등록값", mathNext?.paymentMethodId, "pm-card");
// 익월에 따로 지정하면 그 달만 바뀐다.
const E = cashflowSnapshot(MONTH, {
  ...base, overrides: [],
  nextOverrides: [ov({ source_id: "sp-math", year_month: NEXT, payment_method_id: "pm-wallet" })],
});
const mathNextE = E.nextItems.find((i) => i.key === "fixed:sp-math");
eq("익월 오버라이드를 넣으면 익월만 현금", mathNextE?.cardCharge, false);
eq("   그때 당월은 그대로 카드", itemOf(E, "fixed:sp-math")?.cardCharge, true);

// ── [6] 대출은 무시 ────────────────────────────────────────────
group("대출은 결제수단 개념이 없어 오버라이드를 무시한다");
const F = snapOf([
  { ...ov({ source_id: "loan-1", year_month: MONTH, payment_method_id: "pm-card" }), source_kind: "loan" } as HhCashflowOverride,
]);
const loanF = itemOf(F, "loan:loan-1");
eq("대출은 여전히 cardCharge=false", loanF?.cardCharge, false);
eq("대출 출금계좌도 그대로", loanF?.accountId, "acc-woori");

// ── [7] 삭제된 결제수단 ────────────────────────────────────────
group("알 수 없는 결제수단 id 가 있어도 죽지 않는다 (FK 는 SET NULL 이라 실제 삭제로는 안 생기는 방어 경로)");
const G = snapOf([ov({ source_id: "sp-math", year_month: MONTH, payment_method_id: "pm-지워짐" })]);
const mathG = itemOf(G, "fixed:sp-math");
// 알 수 없는 수단은 신용이 아니므로 현금 취급이 된다 — 조용히 카드로 두는 것보다 합계에 넣는 쪽이 안전하다
// (안 넣으면 실제로 나간 돈이 또 사라진다 = 이 설계가 고치려던 바로 그 증상).
eq("모르는 수단은 현금 취급", mathG?.cardCharge, false);
eq("연결계좌를 모르니 계좌는 빈칸", mathG?.accountId, null);

// ── [8] ★실제 금액으로 재현 — 결제수단만 바꿔선 안 풀린다 ────────
group("★예정금액이 실제와 다르면 결제수단만 바꿔도 여전히 가로채인다 (실데이터 조건)");
// 실제 DB 값: 목동수학 예정 296,150(엑셀 최신 실적월) · 실결제 350,000 · 영어과외 예정 350,000.
// 매칭 패스는 40 → 36 → 20 → 10 이고, pass(20) 안에서 항목은 **금액 큰 순**으로 돈다.
//   영어과외: 정확금액(350,000==350,000) → score 30 (계좌 다름 +0)
//   목동수학: 근사+상호일치            → score 20
// 둘 다 pass(20) 후보인데 영어과외가 배열 앞이라 **먼저 가져간다.**
const scheduledReal: HhScheduledPayment[] = [
  sp({ id: "sp-math", title: "학원비-목동수학", amount: 296_150, pay_day: 5, payment_method_id: "pm-card" }),
  sp({ id: "sp-eng", title: "학원비-영어과외", amount: 350_000, pay_day: 8, account_id: "acc-toss" }),
];
const realBase = { ...base, scheduled: scheduledReal };
const H = cashflowSnapshot(MONTH, {
  ...realBase,
  overrides: [ov({ source_id: "sp-math", year_month: MONTH, payment_method_id: "pm-wallet" })],
  nextOverrides: [],
});
const mathH = H.classified.find((i) => i.key === "fixed:sp-math");
const engH = H.classified.find((i) => i.key === "fixed:sp-eng");
eq("결제수단은 현금으로 바뀐다", mathH?.cardCharge, false);
eq("★그래도 목동수학은 빈칸 — 금액이 296,150 이라 점수가 낮다", mathH?.paidAmount, null);
eq("★영어과외가 여전히 가로챈다", engH?.paidAmount, 350_000);

group("★금액 오버라이드까지 같이 넣어야 풀린다 (팀장이 7월에 손으로 하던 그것)");
const I = cashflowSnapshot(MONTH, {
  ...realBase,
  overrides: [
    ov({ source_id: "sp-math", year_month: MONTH, payment_method_id: "pm-wallet", amount_override: 350_000 }),
  ],
  nextOverrides: [],
});
const mathI = I.classified.find((i) => i.key === "fixed:sp-math");
const engI = I.classified.find((i) => i.key === "fixed:sp-eng");
eq("정확금액+상호일치(score 40)로 1패스에서 주인이 가져간다", mathI?.paidAmount, 350_000);
eq("★영어과외는 빈칸", engI?.paidAmount, null);
check(
  "가져간 거래가 목동수학보습학원이다",
  I.paidThisMonth.get("fixed:sp-math")?.counterparty === "목동수학보습학원"
);

// ── [10] ★H1 — 결제수단만 바꿔도 그 행이 표에서 사라지면 안 된다 ──
group("★수단만 바꿔 매칭이 안 붙어도 행이 표에 남는다 (교차리뷰 H1)");
// 카드 항목은 `!cardCharge` 덕에 no-recent 면제를 받고 있었다. 지갑으로 덮으면 그 면제가 풀리는데
// 그 달 매칭이 안 붙으면 reason="no-recent" 로 **활성 목록에서 통째로 사라진다** — 합계에도 안 들고
// 화면에도 없다. 게다가 사라진 행이 가는 '보류 > 확인필요' 탭엔 결제방식 열이 없어 되돌릴 수도 없다.
// → ov.payment_method_id 를 day_override 와 같은 급의 '사람이 명시했다' 신호로 보고 면제한다.
{
  const J = cashflowSnapshot(MONTH, {
    ...base, recentOutflows: [], // 거래가 아직 안 잡힌 달(선반영)
    overrides: [ov({ source_id: "sp-math", year_month: MONTH, payment_method_id: "pm-wallet" })],
    nextOverrides: [],
  });
  const mathJ = J.classified.find((i) => i.key === "fixed:sp-math");
  eq("현금으로 바뀐다", mathJ?.cardCharge, false);
  eq("★그래도 reason 은 null — 표에 남는다", mathJ?.reason, null);
  check("★활성 목록(activeItems)에 있다", J.activeItems.some((i) => i.key === "fixed:sp-math"));
  check("'제외' 목록엔 없다", !J.releasedItems.some((i) => i.key === "fixed:sp-math"));
}
// [8] 이 만든 상태(수단만 바꿈 + 거래는 있는데 남이 가져감)에서도 행은 남아 있어야 한다.
eq("[8] 상태에서도 목동수학이 표에 남는다", mathH?.reason, null);
check("[8] 상태에서도 활성 목록에 있다", H.activeItems.some((i) => i.key === "fixed:sp-math"));

// ── [11] ★H2 — 그 달 오버라이드가 여러 달 예측을 오염시키면 안 된다 ──
group("★그 달 오버라이드가 m+2 이후 예측을 바꾸지 않는다 (교차리뷰 H2)");
// forecastSourceIds 는 '어떤 항목이 앞으로도 매달 나가는가'를 정하는데, 예전엔 **그 달 오버라이드가
// 반영된** cardCharge 로 판정해 9월만 덮어도 11·12월이 통째로 달라졌다(실측: 350,000 → 700,000, → 0).
// 이제 baseCardCharge(항목 등록값)로 판정한다.
{
  const horizon4 = { ...base, horizon: 4 };
  const outAt = (s: ReturnType<typeof cashflowSnapshot>, i: number) => s.projection[i]?.outflow;
  const P0 = cashflowSnapshot(MONTH, { ...horizon4, overrides: [], nextOverrides: [] });
  const Pmath = cashflowSnapshot(MONTH, {
    ...horizon4, nextOverrides: [],
    overrides: [ov({ source_id: "sp-math", year_month: MONTH, payment_method_id: "pm-wallet" })],
  });
  const Peng = cashflowSnapshot(MONTH, {
    ...horizon4, nextOverrides: [],
    overrides: [ov({ source_id: "sp-eng", year_month: MONTH, payment_method_id: "pm-card" })],
  });
  for (const idx of [2, 3]) {
    eq(`m+${idx} 예측 출금 — 지갑으로 덮어도 그대로`, outAt(Pmath, idx), outAt(P0, idx));
    eq(`m+${idx} 예측 출금 — 카드로 덮어도 그대로`, outAt(Peng, idx), outAt(P0, idx));
  }
}

// ── [12] 이미 있는 계좌 오버라이드와의 우선순위 (교차리뷰 L1) ──
group("계좌 오버라이드가 이미 있으면 그것이 새 수단의 연결계좌를 이긴다 (문서화된 동작)");
{
  const K = snapOf([
    ov({ source_id: "sp-math", year_month: MONTH, payment_method_id: "pm-wallet", account_id: "acc-woori" }),
  ]);
  const mathK = K.classified.find((i) => i.key === "fixed:sp-math");
  eq("사람이 지정한 계좌가 이긴다", mathK?.accountId, "acc-woori");
}

// ── [13] 당월·익월 오버라이드가 동시에 있어도 서로 안 섞인다 ──
group("당월·익월 오버라이드가 동시에 있어도 각자 그 달만 본다");
{
  const L = cashflowSnapshot(MONTH, {
    ...base,
    overrides: [ov({ source_id: "sp-math", year_month: MONTH, payment_method_id: "pm-wallet" })],
    nextOverrides: [ov({ source_id: "sp-eng", year_month: NEXT, payment_method_id: "pm-card" })],
  });
  eq("당월 목동수학 = 현금", L.classified.find((i) => i.key === "fixed:sp-math")?.cardCharge, false);
  eq("당월 영어과외 = 현금(익월 것에 안 물듦)", L.classified.find((i) => i.key === "fixed:sp-eng")?.cardCharge, false);
  eq("익월 목동수학 = 카드(당월 것에 안 물듦)", L.nextItems.find((i) => i.key === "fixed:sp-math")?.cardCharge, true);
  eq("익월 영어과외 = 카드", L.nextItems.find((i) => i.key === "fixed:sp-eng")?.cardCharge, true);
}

// ── [14] ★덱스 High — paidRecently 가 계좌를 통해 오염되던 것 ──
group("★그 달 카드 지정이 과거 실적의 주인을 바꾸지 않는다 (덱스 교차검토 High)");
// recentMatchItems 는 baseCardCharge 로 걸렀지만 **계좌는 오버라이드가 적용된 값**을 넘기고 있었다.
// 점수(설계 188): 정확금액 30 + 계좌(같음 6 / 미상 3 / 다름 0). 패스는 40 → 36 → 20 순.
//   · 오버라이드 없음: 주인 = 30+6 = 36 → **pass(36) 전용 패스에서 먼저** 확정된다.
//   · 신용으로 덮으면 accountId 가 null 이 되어 주인 = 30+3 = 33 → pass(36) 을 못 타고,
//     pass(20) 에서 **배열이 앞선** 경쟁자(30)가 먼저 가져간다.
// 경쟁자는 이번 달로 끝나는 항목이라, 주인이 과거 실적을 뺏기면 forecastSourceIds 에서 빠져
// **m+2 이후 출금이 통째로 0** 이 된다.
{
  // 경쟁자를 배열 앞에 두려면 납부일이 더 빨라야 한다(outItems 는 day 오름차순 → 같은 금액은 그 순서 유지).
  const spRival = sp({ id: "sp-rival", title: "회비-이번달종료", amount: 100_000, pay_day: 4, account_id: "acc-B", end_date: `${MONTH}-30` });
  const spOwner = sp({ id: "sp-owner", title: "관리비-계속", amount: 100_000, pay_day: 5, account_id: "acc-A" });
  const past = [{
    amount: 100_000, counterparty: "지난달출금", txn_date: "2026-08-05",
    type: "expense", account_id: "acc-A", from_account_id: null, to_account_id: null, payment_method_id: null,
  }];
  const b = {
    scheduled: [spRival, spOwner], loans: [], installments: [], txns: [] as HhTransaction[], methods,
    recentOutflows: past, accountIds: ["acc-A", "acc-B"], totalCash: 0, horizon: 4,
  };
  const noOv = cashflowSnapshot(MONTH, { ...b, overrides: [], nextOverrides: [] });
  const withOv = cashflowSnapshot(MONTH, {
    ...b, nextOverrides: [],
    overrides: [ov({ source_id: "sp-owner", year_month: MONTH, payment_method_id: "pm-card" })],
  });
  // 과거 실적의 주인은 reason 으로 드러난다 — 뺏기면 '최근 출금 기록 없음'이 된다.
  const ownerReason = (s: ReturnType<typeof cashflowSnapshot>) =>
    s.classified.find((i) => i.key === "fixed:sp-owner")?.reason ?? null;
  eq("오버라이드 없을 때 주인은 과거 실적을 갖는다", ownerReason(noOv), null);
  eq("★카드로 덮어도 주인이 과거 실적을 지킨다", ownerReason(withOv), null);
  eq("★m+2 예측 출금도 그대로", withOv.projection[2]?.outflow, noOv.projection[2]?.outflow);
  eq("   m+3 도 그대로", withOv.projection[3]?.outflow, noOv.projection[3]?.outflow);
}

// ── [15] ★덱스 High — 익월 신규 항목이 수단을 명시해도 사라지던 것 ──
group("★익월에만 있는 신규 항목도 수단을 명시하면 익월 표·예측에 남는다 (덱스 교차검토 High)");
{
  // 다음 달부터 시작하는 카드 고정비 — 최근 실적도 날짜 오버라이드도 없다.
  const spNew = sp({
    id: "sp-new", title: "새학원비", amount: 200_000, pay_day: 10,
    payment_method_id: "pm-card", start_date: `${NEXT}-01`,
  });
  const b = {
    scheduled: [spNew], loans: [], installments: [], txns: [] as HhTransaction[], methods,
    recentOutflows: [], accountIds, totalCash: 0, horizon: 3,
  };
  const N = cashflowSnapshot(MONTH, {
    ...b, overrides: [],
    nextOverrides: [ov({ source_id: "sp-new", year_month: NEXT, payment_method_id: "pm-wallet" })],
  });
  const item = N.nextItems.find((i) => i.key === "fixed:sp-new");
  check("익월 항목이 존재한다", !!item);
  eq("현금으로 바뀐다", item?.cardCharge, false);
  eq("★reason 이 null — 익월 표에 남는다", item?.reason, null);
  check("★익월 활성 목록에 있다", N.nextActiveItems.some((i) => i.key === "fixed:sp-new"));
  eq("★예측에도 들어간다", item?.inForecast, true);
  check("nextForecastOut 이 0 이 아니다", N.nextForecastOut > 0, `실제 ${N.nextForecastOut}`);
}

// ── [16] ★덱스 Medium — 당월 오버라이드가 전월 열을 바꾸던 것 ──
group("★당월 결제수단 지정이 '전월 출금'·'전월 결제금액' 표시를 바꾸지 않는다 (덱스 교차검토 Medium)");
{
  const spCard = sp({ id: "sp-c", title: "학원비-목동수학", amount: 350_000, pay_day: 5, payment_method_id: "pm-card" });
  const prevCardTxn = {
    amount: 350_000, counterparty: "목동수학보습학원", txn_date: "2026-08-03",
    type: "expense", account_id: null, from_account_id: null, to_account_id: null,
    payment_method_id: "pm-card",
  };
  const b = {
    scheduled: [spCard], loans: [], installments: [], txns: [] as HhTransaction[], methods,
    recentOutflows: [prevCardTxn], accountIds, totalCash: 0, horizon: 3,
  };
  // ★맵만 보면 안 된다 — 맵을 고쳐도 **화면이 어느 맵을 읽는지**가 그대로면 값이 사라진다.
  //   실제로 그렇게 통과시켜 회귀를 냈다(2026-09-05 교차리뷰 High). 그래서 화면 분기를 그대로 옮겨
  //   **셀에 찍히는 값**을 잰다. cash/page.tsx 의 전월 열은 `i.baseCardCharge ? prevCard… : prev…` 다.
  const prevCellOf = (overrides: HhCashflowOverride[]) => {
    const snap = cashflowSnapshot(MONTH, { ...b, overrides, nextOverrides: [] });
    const { prevPaidByKey, prevCardPaidByKey } = computeCashMatches({
      month: MONTH, classified: snap.classified, paidThisMonth: snap.paidThisMonth,
      recentOutflows: [prevCardTxn] as never, accounts: accountIds.map((id) => ({ id })), methods,
    });
    const i = snap.classified.find((x) => x.key === "fixed:sp-c")!;
    const cell = i.baseCardCharge ? prevCardPaidByKey.get(i.key) : prevPaidByKey.get(i.key);
    return { cell: cell?.amount ?? null, map: prevCardPaidByKey.get(i.key)?.amount ?? null };
  };
  eq("오버라이드 없을 때 전월 카드 결제금액이 맵에 있다", prevCellOf([]).map, 350_000);
  eq("   그리고 화면 셀에도 찍힌다", prevCellOf([]).cell, 350_000);
  const after = prevCellOf([ov({ source_id: "sp-c", year_month: MONTH, payment_method_id: "pm-wallet" })]);
  eq("★당월만 지갑으로 바꿔도 맵은 그대로", after.map, 350_000);
  eq("★★그리고 화면 셀도 그대로 — 맵만 고치고 UI 를 안 고치면 여기서 걸린다", after.cell, 350_000);
}

console.log(failures === 0 ? `\n✅ 전부 통과 (${groups}묶음)` : `\n❌ 실패 ${failures}건`);
process.exit(failures === 0 ? 0 : 1);
