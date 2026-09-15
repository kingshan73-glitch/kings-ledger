// 설계 110 스모크 테스트 — 여러 달 예측의 **첫 달**이 이미 지급된 출금을 다시 빼지 않는지 DB 없이 검증한다.
//   npm run test:projection-first
//
// 왜 이 테스트가 있나: 예측은 '현재 잔액'에서 출발한다. 이번 달에 이미 나간 고정비는 그 잔액에 반영돼
// 있으므로 월 전체 출금을 그대로 빼면 같은 돈을 두 번 빼는 셈이다(월말이 가까울수록 오차가 커지고
// '여유선 밑' 경고가 헛울린다). 수입 쪽은 receivedInflowIds 로 진작 대칭을 지키고 있었고 지출만 빠져 있었다.
const { cashflowSnapshot } = await import("../src/lib/household/cashflow-snapshot");
import type {
  HhCashflowOverride, HhInstallment, HhLoan, HhPaymentMethod, HhScheduledPayment, HhTransaction,
} from "../src/lib/household/types";

const MONTH = "2026-07";
const NEXT = "2026-08";
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
function ov(over: Partial<HhCashflowOverride>): HhCashflowOverride {
  return {
    id: "ov", owner_auth_uid: OWNER, year_month: MONTH, source_kind: "fixed", source_id: "x",
    account_id: null, day_override: null, amount_override: null, paid_override: null,
    released: false, created_at: "", updated_at: "",
    ...over,
  } as unknown as HhCashflowOverride;
}

const TOTAL_CASH = 1_000_000;
const scheduled: HhScheduledPayment[] = [
  // 이번 달 5일에 이미 나갔다 → 현재 잔액에 반영돼 있다
  sp({ id: "sp-paid", title: "이미낸고정비", amount: 300_000, pay_day: 5 }),
  // 25일 예정 — 아직 안 나갔다
  sp({ id: "sp-unpaid", title: "아직안낸고정비", amount: 200_000, pay_day: 25 }),
  // 정기수입(아직 안 들어옴 — txns 를 비워 두므로 receivedInflowIds 가 안 잡는다)
  sp({ id: "sp-salary", title: "급여", amount: 1_000_000, pay_day: 25, direction: "in", account_id: "acc-bank" }),
];
// 최근 3개월 실적 — 예측 대상(forecast) 판정에 쓰인다.
// sp-paid 는 **당월** 실거래가 있어 '지급됨'으로 잡히고, sp-unpaid 는 지난달 실적만 있어 미지급이다.
const recentOutflows = [
  { amount: 300_000, counterparty: "이미낸고정비", txn_date: `${MONTH}-05` },
  { amount: 200_000, counterparty: "아직안낸고정비", txn_date: "2026-06-25" },
];

const base = {
  scheduled, loans: [] as HhLoan[], installments: [] as HhInstallment[],
  txns: [] as HhTransaction[], methods: [] as HhPaymentMethod[],
  overrides: [] as HhCashflowOverride[], recentOutflows, totalCash: TOTAL_CASH, horizon: 3,
};
const snap = cashflowSnapshot(MONTH, base);

// 1) 지급 판정이 먼저 맞아야 나머지 검증이 의미 있다.
const paid = snap.classified.find((i) => i.label === "이미낸고정비");
const unpaid = snap.classified.find((i) => i.label === "아직안낸고정비");
check("이미 낸 고정비가 '지급됨'으로 잡힌다", paid?.paidAmount === 300_000, `paidAmount=${paid?.paidAmount}`);
check("아직 안 낸 고정비는 미지급이다", unpaid?.paidAmount == null, `paidAmount=${unpaid?.paidAmount}`);

// 2) ★핵심 — 첫 달 예측 출금에 이미 낸 300,000 이 안 들어간다.
//    수정 전에는 500,000(월 전체)이 들어가 월말현금이 300,000 낮게 나왔다.
check("첫 달 예측 출금 = 미지급분만(200,000)", snap.currentForecastOut === 200_000, `currentForecastOut=${snap.currentForecastOut}`);
const first = snap.projection[0];
check("첫 달 행의 출금도 미지급분", first?.outflow === 200_000, `projection[0].outflow=${first?.outflow}`);

// 3) 같은 화면의 '이번 달 잔액'과 첫 달 월말현금이 같아야 한다(설계 79 숫자 정합).
//    날짜 미정 항목이 없으면 정확히 일치한다.
check("이번 달 잔액 = 1,800,000", snap.monthEndCash === 1_800_000, `monthEndCash=${snap.monthEndCash}`);
check(
  "첫 달 월말현금 == 이번 달 잔액",
  first?.closingCash === snap.monthEndCash,
  `closingCash=${first?.closingCash} vs monthEndCash=${snap.monthEndCash}`
);

// 4) 둘째 달부터는 월 전체 기준 그대로 — 이번 달에 냈다고 다음 달에 안 나가는 게 아니다.
//    (익월은 익월 탭 확정값 nextForecastOut 으로 대체되는데, 그 값도 두 항목 합이어야 한다.)
const second = snap.projection[1];
check("익월 예측 출금 = 월 전체(500,000)", second?.ym === NEXT && second?.outflow === 500_000, `projection[1]=${second?.ym} ${second?.outflow}`);
check("익월 탭 예측 합계도 500,000", snap.nextForecastOut === 500_000, `nextForecastOut=${snap.nextForecastOut}`);

// 5) ★지급금액 0/비움은 '미출금'이다(설계 65 2차) — 0 을 지급으로 보면 그 항목이 예측에서 영구히 사라진다.
//    2026-07-28 실사고: paid_override=0 이 자동매칭을 영구 차단해 카드대금이 계속 미지급으로 표시됐다.
const snapZero = cashflowSnapshot(MONTH, {
  ...base,
  overrides: [ov({ source_id: "sp-unpaid", paid_override: 0 })],
});
check(
  "지급금액 0은 미출금 → 첫 달 예측에 그대로 남는다",
  snapZero.currentForecastOut === 200_000,
  `currentForecastOut=${snapZero.currentForecastOut}`
);

// 6) 이미 받은 급여는 첫 달 예상수입에서 빠진다(기존 동작 회귀 — 지출 대칭의 짝).
const snapGotSalary = cashflowSnapshot(MONTH, {
  ...base,
  txns: [
    { id: "t1", type: "income", amount: 1_000_000, account_id: "acc-bank", txn_date: `${MONTH}-25` } as unknown as HhTransaction,
  ],
});
check("이미 입금된 급여는 첫 달 예상수입에서 제외", snapGotSalary.projection[0]?.inflow === 0, `inflow=${snapGotSalary.projection[0]?.inflow}`);
check(
  "그래도 첫 달 월말현금 == 이번 달 잔액",
  snapGotSalary.projection[0]?.closingCash === snapGotSalary.monthEndCash,
  `closingCash=${snapGotSalary.projection[0]?.closingCash} vs monthEndCash=${snapGotSalary.monthEndCash}`
);

// 6-b) ★예측 편입 조건 고정 — 최근 3개월 실적도 없고 날짜 확정도 안 한 항목은 첫 달 예측에 안 들어간다.
//     (설계 65 §F 기준. 이 단언이 없으면 `(paidRecently || dayOverridden)` 조건을 true 로 바꿔도
//      테스트가 전부 통과한다 — fixture의 모든 항목이 실적을 갖고 있어서다. 교차리뷰 지적 2026-07-30.)
const snapNoRecent = cashflowSnapshot(MONTH, {
  ...base,
  scheduled: [
    ...scheduled,
    sp({ id: "sp-norecent", title: "실적없는고정비", amount: 777_000, pay_day: 20 }),
  ],
});
const noRecent = snapNoRecent.classified.find((i) => i.label === "실적없는고정비");
check("전제: 최근 실적 매칭이 없다", !snapNoRecent.paidRecently.has(noRecent?.key ?? ""), `key=${noRecent?.key}`);
check("전제: 그래서 '최근 출금 기록 없음'으로 분류된다", noRecent?.reason === "no-recent", `reason=${noRecent?.reason}`);
check(
  "★최근 실적 없는 항목은 첫 달 예측 출금에 들어가지 않는다",
  snapNoRecent.currentForecastOut === snap.currentForecastOut,
  `currentForecastOut=${snapNoRecent.currentForecastOut} (기대 ${snap.currentForecastOut} — 777,000 이 새면 안 된다)`
);

// 7) 이번 달 일시정지(released)는 첫 달에서 빠지고 익월엔 자동 재개한다(설계 97 회귀).
//    첫 달 출금을 대체값으로 넘기게 됐으니 released 가 그 대체값에서도 빠지는지 확인해야 한다.
const snapPaused = cashflowSnapshot(MONTH, {
  ...base,
  overrides: [ov({ source_id: "sp-unpaid", released: true })],
});
check("일시정지 항목은 첫 달 예측 출금에서 빠진다", snapPaused.currentForecastOut === 0, `currentForecastOut=${snapPaused.currentForecastOut}`);
check("일시정지는 익월에 자동 재개된다", snapPaused.projection[1]?.outflow === 500_000, `projection[1].outflow=${snapPaused.projection[1]?.outflow}`);

// 8) ★성격이 다른 큰 입금을 '정기수입 받았다'로 오판하지 않는다. (2026-08-09, 팀장 신고)
//    금액 문턱(70%)은 아래쪽(소액 잡수입)만 막는다 — 대출 실행금처럼 **훨씬 큰** 입금은
//    오히려 문턱을 쉽게 넘어, 같은 계좌를 쓰는 정기수입이 통째로 예상수입에서 빠졌다.
//    실측: 8/2 카드론 15,000,000('대출')이 바다기획-이바다 2,000,000('기타수입')을 지웠다(735만→535만).
const inTxn = (over: Partial<HhTransaction>): HhTransaction =>
  ({
    id: "t", owner_auth_uid: OWNER, type: "income", txn_date: `${MONTH}-02`, amount: 0,
    category_id: null, counterparty: null, memo: null, note: null, payment_method_id: null,
    account_id: "acc-bank", from_account_id: null, to_account_id: null, person_id: null,
    installment_id: null, loan_id: null, source: "manual", created_at: "", updated_at: "",
    ...over,
  }) as unknown as HhTransaction;

const baseInflow = snap.projection[0].inflow;
const snapLoan = cashflowSnapshot(MONTH, {
  ...base,
  txns: [inTxn({ id: "t-loan", amount: 15_000_000, category_id: "cat-loan", counterparty: "KB국민카드" })],
});
check(
  "★대출 실행금(같은 계좌·다른 카테고리)을 급여 수령으로 오판하지 않는다",
  snapLoan.projection[0].inflow === baseInflow,
  `inflow=${snapLoan.projection[0].inflow} (기대 ${baseInflow} — 급여가 빠지면 안 된다)`
);

// 대조군 ⓐ — 같은 카테고리의 급여 입금이면 '받음'으로 잡혀 첫 달 예상수입에서 빠져야 한다.
const snapSalary = cashflowSnapshot(MONTH, {
  ...base,
  txns: [inTxn({ id: "t-sal", amount: 1_000_000, category_id: "cat-1", counterparty: "회사" })],
});
check(
  "(대조군) 같은 카테고리 급여 입금은 첫 달 예상수입에서 빠진다",
  snapSalary.projection[0].inflow === baseInflow - 1_000_000,
  `inflow=${snapSalary.projection[0].inflow} (기대 ${baseInflow - 1_000_000})`
);

// 대조군 ⓑ — 가릴 근거(상호·카테고리)가 아예 없으면 종전대로 계좌+금액만으로 인정한다.
const snapNoInfo = cashflowSnapshot(MONTH, {
  ...base,
  txns: [inTxn({ id: "t-noinfo", amount: 1_000_000, category_id: null, counterparty: null })],
});
check(
  "(대조군) 상호·카테고리가 모두 비면 종전대로 '받음'으로 인정한다",
  snapNoInfo.projection[0].inflow === baseInflow - 1_000_000,
  `inflow=${snapNoInfo.projection[0].inflow} (기대 ${baseInflow - 1_000_000})`
);

// ★★카테고리로 가르면 안 되는 이유 — 실데이터가 뒤죽박죽이다(배포 전 교차리뷰 지적을 실측으로 확인).
//   6/25 하늘상사 급여 5,556,592 가 '기타수입', 7/31 바다기획 2,000,000 이 '급여' 로 분류돼 있었다.
//   카테고리 불일치를 '안 받음'으로 보면 그 달이 **이중계상**된다. 상호가 맞으면 받은 것으로 봐야 한다.
const snapCatMismatch = cashflowSnapshot(MONTH, {
  ...base,
  txns: [inTxn({ id: "t-mis", amount: 1_000_000, category_id: "cat-other", counterparty: "급여" })],
});
check(
  "★상호가 맞으면 카테고리가 달라도 '받음'으로 인정한다(이중계상 방지)",
  snapCatMismatch.projection[0].inflow === baseInflow - 1_000_000,
  `inflow=${snapCatMismatch.projection[0].inflow} (기대 ${baseInflow - 1_000_000} — 카테고리로 뒤집으면 이중계상)`
);

console.log(failures ? `\n❌ 실패 ${failures}건` : "\n✅ 전부 통과");
process.exitCode = failures ? 1 : 0;
