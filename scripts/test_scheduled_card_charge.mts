// 설계 108 스모크 테스트 — 카드로 결제되는 고정비가 현금 유출에서 빠지는지 DB 없이 합성 데이터로 검증한다.
//   npm run test:card-charge
const { cashflowSnapshot } = await import("../src/lib/household/cashflow-snapshot");
import type {
  HhCashflowOverride, HhInstallment, HhLoan, HhPaymentMethod, HhScheduledPayment, HhTransaction,
} from "../src/lib/household/types";

const MONTH = "2026-07";
const OWNER = "owner-1";
let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✅ ${name}`);
  else { failures++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}

function sp(over: Partial<HhScheduledPayment>): HhScheduledPayment {
  return {
    id: "x", owner_auth_uid: OWNER, title: "t", kind: "autopay", amount: 100_000,
    frequency: "monthly", pay_day: 10, account_id: "acc-bank", payment_method_id: null,
    category_id: "cat-1", person_id: null, payee: null, direction: "out", is_active: true,
    permanent_hold: false, start_date: null, end_date: null, created_at: "", updated_at: "",
    ...over,
  };
}
function pm(over: Partial<HhPaymentMethod>): HhPaymentMethod {
  return {
    id: "pm", owner_auth_uid: OWNER, name: "카드", kind: "credit", card_no: null,
    linked_account_id: "acc-bank", billing_day: null, person_id: null, is_active: true,
    sort_order: 0, created_at: "", updated_at: "",
    ...over,
  } as HhPaymentMethod;
}

const methods: HhPaymentMethod[] = [
  pm({ id: "pm-credit", name: "삼성카드(김하늘)", kind: "credit", linked_account_id: "acc-bank" }),
  pm({ id: "pm-check", name: "우리체크(김하늘)", kind: "check", linked_account_id: "acc-bank" }),
];

const scheduled: HhScheduledPayment[] = [
  // ① 계좌에서 바로 빠지는 고정비
  sp({ id: "sp-bank", title: "은행자동이체", amount: 100_000, pay_day: 10 }),
  // ② 신용카드로 결제되는 고정비 — 현금은 카드대금일에 나간다
  sp({ id: "sp-card", title: "학원비(카드결제)", amount: 240_000, pay_day: 5, account_id: null, payment_method_id: "pm-credit" }),
  // ③ 체크카드 — 즉시 출금이므로 연결계좌에서 그대로 빠진다
  sp({ id: "sp-check", title: "체크카드 고정비", amount: 50_000, pay_day: 7, account_id: null, payment_method_id: "pm-check" }),
  // ④ 카드대금 자체 — 실제 현금 유출
  sp({ id: "sp-bill", title: "카드대금-삼성", kind: "card_bill", amount: 500_000, pay_day: 26 }),
];

// 최근 실적(설계 65) — 없으면 'no-recent'로 빠지므로 은행 항목엔 매칭을 준다.
// ★당월(2026-07)이 아니라 지난달로 둔다: 당월 매칭은 '이미 지급됨'으로 잡혀 출금예정(미지급)에서 빠진다.
const recentOutflows = [
  { amount: 100_000, counterparty: "은행자동이체", txn_date: "2026-06-10" },
  { amount: 50_000, counterparty: "체크카드 고정비", txn_date: "2026-06-07" },
  { amount: 500_000, counterparty: "카드대금-삼성", txn_date: "2026-06-26" },
];

const snap = cashflowSnapshot(MONTH, {
  scheduled, loans: [] as HhLoan[], installments: [] as HhInstallment[],
  txns: [] as HhTransaction[], methods, overrides: [] as HhCashflowOverride[],
  recentOutflows, totalCash: 1_000_000, horizon: 3,
});

const byTitle = (t: string) => snap.classified.find((i) => i.label === t);

// 1) 카드 결제분도 표에는 남아야 한다 — 은행 실출금이 없다고 사라지면 안 된다.
const card = byTitle("학원비(카드결제)");
check("카드 결제 고정비가 '출금 예정'에 남는다", card != null && card.reason == null, `reason=${card?.reason}`);
check("카드 결제 고정비에 cardCharge 표시", card?.cardCharge === true);

// 2) 현금 유출 합계에서는 빠진다 — 은행 100,000 + 체크 50,000 + 카드대금 500,000 = 650,000
check(
  "출금예정 합계에 카드 결제분(240,000) 미포함",
  snap.pendingOutAll === 650_000,
  `pendingOutAll=${snap.pendingOutAll} (기대 650000)`
);

// 3) 체크카드는 즉시 출금 → 연결계좌가 출금계좌로 잡히고 합계에 포함
const check1 = byTitle("체크카드 고정비");
check("체크카드 고정비는 cardCharge 아님", check1?.cardCharge === false);
check("체크카드 고정비의 출금계좌 = 카드 연결계좌", check1?.accountId === "acc-bank", `accountId=${check1?.accountId}`);

// 4) 카드대금 자체는 현금 유출이다
const bill = byTitle("카드대금-삼성");
check("카드대금 항목은 cardCharge 아님(실제 통장 출금)", bill?.cardCharge === false);

// 5) 월말 예상현금 = 현금 1,000,000 − 현금유출 650,000 (카드 결제분 이중차감 없음)
check("월말 예상현금에 카드 결제분 미차감", snap.monthEndCash === 350_000, `monthEndCash=${snap.monthEndCash}`);

// 6) 여러 달 예측에서도 카드 결제분은 빠진다(카드대금이 대표)
const first = snap.projection[0];
check(
  "예측 첫 달 출금에 카드 결제분 미포함",
  first != null && first.outflow === 650_000,
  `projection[0].outflow=${first?.outflow} (기대 650000)`
);

// ── 교차리뷰(2026-07-28)에서 드러난 구멍들 ──────────────────────────────

// 7) 익월 탭: 카드 결제분이 행에는 남고 합계에서는 빠진다(그래서 화면에 안내가 필요하다).
const nextCard = snap.nextActiveItems.find((i) => i.label === "학원비(카드결제)");
check("익월 탭에도 카드 결제분이 남는다", nextCard != null && nextCard.cardCharge === true, `nextCard=${nextCard?.label}`);
check(
  "익월 합계(nextOutTotal)에는 카드 결제분 미포함",
  snap.nextOutTotal === 650_000,
  `nextOutTotal=${snap.nextOutTotal} (기대 650000)`
);

// 8) 카드 결제분은 계좌를 갖지 않는다 — 예전에 지정해 둔 오버라이드 계좌가 남아 있어도 무시해야 한다.
//    (안 그러면 그 계좌가 '출금 후 잔액' 합계 범위에 끼어 잔액이 부푼다.)
const snapOv = cashflowSnapshot(MONTH, {
  scheduled, loans: [] as HhLoan[], installments: [] as HhInstallment[],
  txns: [] as HhTransaction[], methods,
  overrides: [
    { id: "ov1", owner_auth_uid: OWNER, year_month: MONTH, source_kind: "fixed", source_id: "sp-card",
      account_id: "acc-other", day_override: null, amount_override: null, paid_override: null, released: false,
      created_at: "", updated_at: "" },
  ] as unknown as HhCashflowOverride[],
  recentOutflows, totalCash: 1_000_000, horizon: 3,
});
const ovCard = snapOv.classified.find((i) => i.label === "학원비(카드결제)");
check("카드 결제분은 오버라이드 계좌가 있어도 계좌 없음으로 정규화", ovCard?.accountId === null, `accountId=${ovCard?.accountId}`);

// 9) 당월에 없던(다음 달 시작) 카드결제 고정비도 익월 탭에서 사라지면 안 된다 — 최근 실적이 영원히 안 잡히므로.
const future: HhScheduledPayment[] = [
  ...scheduled,
  sp({ id: "sp-card-new", title: "새 카드고정비", amount: 70_000, pay_day: 15, account_id: null,
      payment_method_id: "pm-credit", start_date: "2026-08-01" }),
];
const snapFuture = cashflowSnapshot(MONTH, {
  scheduled: future, loans: [] as HhLoan[], installments: [] as HhInstallment[],
  txns: [] as HhTransaction[], methods, overrides: [] as HhCashflowOverride[],
  recentOutflows, totalCash: 1_000_000, horizon: 3,
});
const newNext = snapFuture.nextItems.find((i) => i.label === "새 카드고정비");
check("다음 달 시작하는 카드결제 고정비가 익월 탭에 남는다", newNext != null && newNext.reason == null, `reason=${newNext?.reason}`);

// 10) 카드 결제분은 실출금 매칭에 참여하면 안 된다 — 근사 규칙(상호 부분일치+금액 ±30%)으로 남의 거래를 훔친다.
//     실사례(2026-07-28 팀장 신고): 통신비-SKT(카드, 111,490)가 KT(토스페이, 95,040)의 실거래를 가로채
//     ('KT'⊂'SKT') 당월출금·익월 예상금액이 95,040으로 둔갑했다.
const stealScheduled: HhScheduledPayment[] = [
  ...scheduled,
  sp({ id: "sp-kt", title: "KT요금", amount: 95_040, pay_day: 20, account_id: "acc-bank" }),
  sp({ id: "sp-skt", title: "SKT통신비", amount: 111_490, pay_day: 26, account_id: null, payment_method_id: "pm-credit" }),
];
const snapSteal = cashflowSnapshot(MONTH, {
  scheduled: stealScheduled, loans: [] as HhLoan[], installments: [] as HhInstallment[],
  txns: [] as HhTransaction[], methods, overrides: [] as HhCashflowOverride[],
  recentOutflows: [...recentOutflows, { amount: 95_040, counterparty: "KT", txn_date: "2026-07-21" }],
  totalCash: 1_000_000, horizon: 3,
});
const kt = snapSteal.classified.find((i) => i.label === "KT요금");
const skt = snapSteal.classified.find((i) => i.label === "SKT통신비");
check("실거래는 진짜 주인(KT)이 매칭한다", kt?.paidAmount === 95_040, `KT paidAmount=${kt?.paidAmount}`);
check("카드 결제분(SKT)은 남의 거래를 훔치지 않는다", skt?.paidAmount == null, `SKT paidAmount=${skt?.paidAmount}`);
const sktNext = snapSteal.nextItems.find((i) => i.label === "SKT통신비");
check("익월 예상금액이 훔친 금액으로 둔갑하지 않는다", sktNext?.amount === 111_490, `익월 amount=${sktNext?.amount}`);

// ── 설계 111 — 할부도 카드 결제면 현금 유출이 아니다 ─────────────────────
// 카드 할부 회차는 그날 통장에서 안 빠지고 그 카드의 **카드대금에 얹혀** 나간다.
// 따로 세면 카드대금과 이중차감이다(2026-07-30 실측: 당월 청구 할부 13건 전부 신용카드, 합 1,049,244원).
console.log("\n[설계 111] 카드 할부");
function ins(over: Partial<HhInstallment>): HhInstallment {
  return {
    id: "ins", owner_auth_uid: OWNER, title: "할부", start_date: `${MONTH}-01`,
    total_amount: 360_000, total_count: 3, start_installment: 1, is_active: true,
    payment_method_id: "pm-credit", category_id: "cat-1", created_at: "", updated_at: "",
    ...over,
  } as HhInstallment;
}
const installments: HhInstallment[] = [
  ins({ id: "ins-credit", title: "카드할부", payment_method_id: "pm-credit" }),   // 월 120,000
  ins({ id: "ins-check", title: "체크할부", payment_method_id: "pm-check", total_amount: 90_000 }), // 월 30,000
];
// 지난달 실적만 준다 → 예측 후보(paidRecently)이면서 당월 미지급.
// ★당월 실거래를 여기 섞으면 안 된다: 수정 전 구현(할부가 cardCharge 아님)에서도 그 거래가
//   할부에 매칭돼 paidAmount 가 생기고, 그러면 `!paidAmount` 필터에 걸려 예측에서 빠져
//   "예측 제외" 단언이 **잘못된 구현에서도 통과**한다(교차리뷰 지적 2026-07-30).
//   그래서 예측 검증용과 '거래 가로채기' 검증용 snapshot 을 분리한다.
const insRecent = [
  ...recentOutflows,
  { amount: 120_000, counterparty: "카드할부", txn_date: "2026-06-20" },
  { amount: 30_000, counterparty: "체크할부", txn_date: "2026-06-20" },
];
const insSnap = cashflowSnapshot(MONTH, {
  scheduled, loans: [] as HhLoan[], installments,
  txns: [] as HhTransaction[], methods, overrides: [] as HhCashflowOverride[],
  recentOutflows: insRecent,
  totalCash: 1_000_000, horizon: 3,
});
const insCredit = insSnap.classified.find((i) => i.sourceId === "ins-credit");
const insCheck = insSnap.classified.find((i) => i.sourceId === "ins-check");

check("신용카드 할부에 cardCharge 표시", insCredit?.cardCharge === true, `cardCharge=${insCredit?.cardCharge}`);
check(
  "신용카드 할부는 출금계좌를 갖지 않는다(카드 연결계좌로 차감하면 안 됨)",
  insCredit?.accountId === null,
  `accountId=${insCredit?.accountId}`
);
// 거래 가로채기 검증은 **당월 카드 사용거래를 넣은 별도 snapshot** 으로 한다.
const insStealSnap = cashflowSnapshot(MONTH, {
  scheduled, loans: [] as HhLoan[], installments,
  txns: [] as HhTransaction[], methods, overrides: [] as HhCashflowOverride[],
  // 당월 카드 사용 거래 — 할부 회차는 별도 은행 출금을 만들지 않으므로 이걸 '실지급'으로 잡으면 오염이다.
  recentOutflows: [...insRecent, { amount: 120_000, counterparty: "카드할부", txn_date: `${MONTH}-03` }],
  totalCash: 1_000_000, horizon: 3,
});
check(
  "★신용카드 할부는 실출금 매칭에 참여하지 않는다(카드 사용거래를 훔치지 않음)",
  insStealSnap.classified.find((i) => i.sourceId === "ins-credit")?.paidAmount == null,
  `paidAmount=${insStealSnap.classified.find((i) => i.sourceId === "ins-credit")?.paidAmount}`
);
// 예측: 카드 할부 120,000 은 빠지고 체크 할부 30,000 은 남는다(즉시 출금이므로).
check(
  "★예측 첫 달 출금에 신용카드 할부 미포함, 체크카드 할부는 포함",
  insSnap.currentForecastOut === 650_000 + 30_000,
  `currentForecastOut=${insSnap.currentForecastOut} (기대 680000)`
);
check("체크카드 할부는 cardCharge 아님", insCheck?.cardCharge === false, `cardCharge=${insCheck?.cardCharge}`);
check(
  "체크카드 할부의 출금계좌 = 카드 연결계좌",
  insCheck?.accountId === "acc-bank",
  `accountId=${insCheck?.accountId}`
);
// 익월 예측에서도 카드 할부는 빠진다(카드대금이 대표).
check(
  "익월 예측 합계에도 신용카드 할부 미포함",
  insSnap.nextForecastOut === 650_000 + 30_000,
  `nextForecastOut=${insSnap.nextForecastOut} (기대 680000)`
);
// 대출은 계좌에서 직접 빠지므로 결제수단과 무관하게 현금 유출이다(과잉 제외 방지).
const loanSnap = cashflowSnapshot(MONTH, {
  scheduled: [], loans: [
    { id: "loan-1", owner_auth_uid: OWNER, name: "대출", monthly_payment: 200_000, payment_day: 15,
      status: "active", origin_date: "2020-01-01", maturity_date: "2040-01-01" } as unknown as HhLoan,
  ],
  installments: [] as HhInstallment[], txns: [] as HhTransaction[], methods,
  overrides: [] as HhCashflowOverride[],
  recentOutflows: [{ amount: 200_000, counterparty: "대출 상환", txn_date: "2026-06-15" }],
  totalCash: 1_000_000, horizon: 3,
});
const loanItem = loanSnap.classified.find((i) => i.sourceKind === "loan");
check("대출 상환은 cardCharge 아님(계좌 직접 출금)", loanItem?.cardCharge === false, `cardCharge=${loanItem?.cardCharge}`);
check("대출 상환은 예측 출금에 포함", loanSnap.currentForecastOut === 200_000, `currentForecastOut=${loanSnap.currentForecastOut}`);

console.log(failures ? `\n❌ 실패 ${failures}건` : "\n✅ 전부 통과");
process.exitCode = failures ? 1 : 0;
