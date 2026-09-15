// 익월 출금(설계 81) 스모크 테스트 — DB 없이 합성 데이터로 계산 규칙을 검증한다.
//   npm run test:next-outflow
// 검증 항목:
//   1) 익월 기본금액 = 당월 출금금액(실지급) 우선, 없으면 당월 예상금액
//   2) 카드대금이 익월 항목으로 이월된다(익월 캘린더엔 안 나오므로)
//   3) 익월 amount_override 가 기본값을 덮는다
//   4) 익월 탭 합계(nextOutTotal) == ③ 예측의 익월 outflow
//   5) 익월 오버라이드가 당월 숫자(pendingOutAll/paidOutAll)를 바꾸지 않는다
//   6) 익월 released 는 익월에서만 빠진다
// (scripts/test_sms_parser.mts 와 같은 동적 import 방식 — tsx 로 TS 소스를 그대로 읽는다)
const { cashflowSnapshot } = await import("../src/lib/household/cashflow-snapshot");
const { cashflowCalendar, projectMonths } = await import("../src/lib/household/calc");
import type {
  HhCashflowOverride,
  HhInstallment,
  HhLoan,
  HhPaymentMethod,
  HhScheduledPayment,
  HhTransaction,
} from "../src/lib/household/types";

const MONTH = "2026-07";
const NEXT = "2026-08";
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

// ── 합성 마스터 ────────────────────────────────────────────────
const scheduled: HhScheduledPayment[] = [
  {
    id: "sp-rent", owner_auth_uid: OWNER, title: "월세", direction: "out", amount: 500_000,
    frequency: "monthly", pay_day: 5, account_id: "acc-1", category_id: "cat-1",
    is_active: true, start_date: null, end_date: null, person_id: null, memo: null,
    sort_order: 0, created_at: "", updated_at: "",
  } as unknown as HhScheduledPayment,
  {
    id: "sp-salary", owner_auth_uid: OWNER, title: "급여", direction: "in", amount: 4_000_000,
    frequency: "monthly", pay_day: 25, account_id: "acc-1", category_id: "cat-in",
    is_active: true, start_date: null, end_date: null, person_id: null, memo: null,
    sort_order: 0, created_at: "", updated_at: "",
  } as unknown as HhScheduledPayment,
];

const loans: HhLoan[] = [
  {
    id: "loan-1", owner_auth_uid: OWNER, name: "디딤돌", principal: 50_000_000,
    current_balance: 40_000_000, monthly_payment: 514_097, payment_day: 25,
    status: "active", origin_date: "2020-01-01", maturity_date: "2040-01-01",
    interest_rate: 3.5, account_id: "acc-1", created_at: "", updated_at: "",
  } as unknown as HhLoan,
];

const installments: HhInstallment[] = [];

const methods: HhPaymentMethod[] = [
  {
    id: "pm-card", owner_auth_uid: OWNER, name: "현대카드", kind: "credit",
    billing_day: 15, linked_account_id: "acc-1", is_active: true,
    sort_order: 0, created_at: "", updated_at: "",
  } as unknown as HhPaymentMethod,
];

// 당월 카드 사용액 = 300,000 → 당월 카드대금 항목 생성
const txns: HhTransaction[] = [
  { id: "t1", owner_auth_uid: OWNER, type: "expense", txn_date: "2026-07-03", amount: 300_000,
    payment_method_id: "pm-card", category_id: "cat-2", account_id: null, counterparty: "쇼핑",
    memo: null, person_id: null, source: "manual", from_account_id: null, to_account_id: null,
    created_at: "", updated_at: "" } as unknown as HhTransaction,
];

// 최근 3개월 실적 — 각 항목이 '최근 출금 기록 없음'으로 빠지지 않도록.
// 월세는 당월 실지급 480,000(예상 500,000과 다름) → 익월 기본값은 480,000 이어야 한다.
const recentOutflows = [
  { amount: 480_000, counterparty: "월세", txn_date: "2026-07-05" },
  { amount: 514_097, counterparty: "디딤돌 상환", txn_date: "2026-07-25" },
  { amount: 300_000, counterparty: "현대카드 카드대금", txn_date: "2026-07-15" },
];

const base = {
  scheduled, loans, installments, txns, methods,
  recentOutflows, totalCash: 10_000_000, horizon: 3,
};

// ── 1. 오버라이드 없음 ─────────────────────────────────────────
console.log("\n[1] 익월 기본값 = 당월 출금금액 우선, 없으면 당월 예상금액");
const snapA = cashflowSnapshot(MONTH, { ...base, overrides: [], nextOverrides: [] });
eq("익월 = 2026-08", snapA.nextMonth, NEXT);

const nextBy = (k: string) => snapA.nextItems.find((i) => i.key === k);
const curBy = (k: string) => snapA.classified.find((i) => i.key === k);

const rentCur = curBy("fixed:sp-rent");
const rentNext = nextBy("fixed:sp-rent");
eq("당월 월세 예상금액 500,000", rentCur?.amount, 500_000);
eq("당월 월세 출금금액(실지급) 480,000", rentCur?.paidAmount, 480_000);
eq("→ 익월 월세 기본값이 실지급 480,000 을 따라간다", rentNext?.amount, 480_000);
eq("   (참고 컬럼) 당월 출금금액 480,000", rentNext?.currentPaid, 480_000);

console.log("\n[2] 카드대금이 익월로 이월된다 (익월 캘린더엔 안 나옴)");
const cardNext = nextBy("card:pm-card");
check("익월에 카드대금 항목이 존재", !!cardNext);
eq("익월 카드대금 = 당월 실지급 300,000", cardNext?.amount, 300_000);
eq("익월 카드 납부일 = billing_day 15", cardNext?.day, 15);
eq("익월 카드가 '출금 예정'으로 분류(reason 없음)", cardNext?.reason, null);

console.log("\n[4] 익월 탭 합계 · 예측 익월 출금");
const expectedTotal = 480_000 + 514_097 + 300_000;
eq("nextOutTotal = 월세480,000 + 대출514,097 + 카드300,000", snapA.nextOutTotal, expectedTotal);
const tabSum = snapA.nextActiveItems.reduce((s, i) => s + i.amount, 0);
eq("익월 탭 tfoot 합계도 동일", tabSum, expectedTotal);
const projNext = snapA.projection.find((p) => p.ym === NEXT);
eq("③ 예측 익월 outflow == nextForecastOut", projNext?.outflow, snapA.nextForecastOut);
eq("날짜 미정 항목이 없으면 탭 합계 == 예측 익월", snapA.nextForecastOut, expectedTotal);
check("③ 예측 익익월은 카드 제외(현행 유지) → 익월과 다르다",
  snapA.projection[2] !== undefined && snapA.projection[2].outflow !== expectedTotal,
  `익익월 outflow=${snapA.projection[2]?.outflow}`);

// ── 3. 익월 override 로 카드값 직접 입력 ───────────────────────
console.log("\n[3] 익월 카드값을 직접 입력하면 기본값을 덮는다");
const ov = (patch: Partial<HhCashflowOverride>): HhCashflowOverride =>
  ({
    id: "ov", owner_auth_uid: OWNER, year_month: NEXT, source_kind: "card", source_id: "pm-card",
    amount_override: null, account_id: null, released: false, day_override: null, paid_override: null,
    created_at: "", updated_at: "", ...patch,
  }) as HhCashflowOverride;

const snapB = cashflowSnapshot(MONTH, {
  ...base, overrides: [], nextOverrides: [ov({ amount_override: 1_250_000 })],
});
const cardB = snapB.nextItems.find((i) => i.key === "card:pm-card");
eq("입력한 익월 카드값 1,250,000 이 반영", cardB?.amount, 1_250_000);
eq("'입력함' 배지 플래그가 켜진다", cardB?.amountOverridden, true);
eq("참고 컬럼의 당월 출금금액은 그대로 300,000", cardB?.currentPaid, 300_000);
const expectedB = 480_000 + 514_097 + 1_250_000;
eq("익월 합계가 입력값 기준으로 갱신", snapB.nextOutTotal, expectedB);
eq("③ 예측 익월 outflow 도 함께 갱신", snapB.projection.find((p) => p.ym === NEXT)?.outflow, expectedB);

// ── 5. 익월 입력이 당월을 오염시키지 않는지 ────────────────────
console.log("\n[5] 익월 입력은 당월 숫자를 바꾸지 않는다 (년월 분리)");
eq("당월 출금예정 합계 불변", snapB.pendingOutAll, snapA.pendingOutAll);
eq("당월 출금금액 합계 불변", snapB.paidOutAll, snapA.paidOutAll);
eq("당월 항목 수 불변", snapB.activeItems.length, snapA.activeItems.length);
eq("이번 달 잔액 불변", snapB.monthEndCash, snapA.monthEndCash);
eq("③ 예측 당월(k=0) outflow 불변",
  snapB.projection[0].outflow, snapA.projection[0].outflow);

// ── 6. 익월 제외 ───────────────────────────────────────────────
console.log("\n[6] 익월 '예측에서 제외'는 익월에서만 빠진다");
const snapC = cashflowSnapshot(MONTH, {
  ...base, overrides: [], nextOverrides: [ov({ released: true })],
});
const cardC = snapC.nextItems.find((i) => i.key === "card:pm-card");
eq("익월 카드 사유 = manual(직접 제외)", cardC?.reason, "manual");
check("익월 예정 목록에서 빠진다", !snapC.nextActiveItems.some((i) => i.key === "card:pm-card"));
eq("익월 합계에서 카드 300,000 제외", snapC.nextOutTotal, 480_000 + 514_097);
check("당월 카드는 그대로 예정에 남는다", snapC.activeItems.some((i) => i.key === "card:pm-card"));

// ── 7. 날짜 미정(주간 고정비)은 탭에선 빠지되 예측엔 들어간다 ──
// 설계 65 §F: 날짜 유무는 월 단위 예측에 무관. 여기서 빼면 익월 출금이 과소계상되어
// 월말 예상현금이 낙관적으로 나온다(자금부족 경고가 늦어짐).
console.log("\n[7] 날짜 미정 항목: 탭에선 제외, 예측에는 포함 (설계 65 §F)");
const weekly: HhScheduledPayment = {
  id: "sp-weekly", owner_auth_uid: OWNER, title: "주간 장보기", direction: "out", amount: 100_000,
  frequency: "weekly", pay_day: null, account_id: "acc-1", category_id: "cat-3",
  is_active: true, start_date: null, end_date: null, person_id: null, memo: null,
  sort_order: 0, created_at: "", updated_at: "",
} as unknown as HhScheduledPayment;

const snapD = cashflowSnapshot(MONTH, {
  ...base,
  scheduled: [...scheduled, weekly],
  // 주간 항목도 최근 실적이 있어야 §F 대상(paidRecently)이 된다.
  recentOutflows: [...recentOutflows, { amount: 433_000, counterparty: "주간 장보기", txn_date: "2026-07-10" }],
  overrides: [], nextOverrides: [],
});
const weeklyNext = snapD.nextItems.find((i) => i.key === "fixed:sp-weekly");
eq("주간 항목 사유 = undated(날짜 미정)", weeklyNext?.reason, "undated");
check("→ 익월 탭에는 안 보인다", !snapD.nextActiveItems.some((i) => i.key === "fixed:sp-weekly"));
eq("→ 그러나 예측에는 포함(inForecast)", weeklyNext?.inForecast, true);
check("예측 익월 출금 > 탭 합계 (날짜 미정분만큼)",
  snapD.nextForecastOut > snapD.nextOutTotal,
  `예측=${snapD.nextForecastOut}, 탭=${snapD.nextOutTotal}`);
eq("차이 = 주간 항목 금액", snapD.nextForecastOut - snapD.nextOutTotal, weeklyNext?.amount);
eq("③ 예측 익월 outflow 는 예측용 합계를 쓴다",
  snapD.projection.find((p) => p.ym === NEXT)?.outflow, snapD.nextForecastOut);

// ── 8. 당월 '미출금'(출금금액 0/비움)이 익월에 0원으로 새지 않는다 ──
console.log("\n[8] 당월 출금금액을 비운(미출금) 항목이 익월 0원으로 이월되지 않는다");
const snapE = cashflowSnapshot(MONTH, {
  ...base,
  // 월세를 '미출금'으로 표시(설계 65: 비우면 paid_override=0)
  overrides: [{
    id: "ov-cur", owner_auth_uid: OWNER, year_month: MONTH, source_kind: "fixed", source_id: "sp-rent",
    amount_override: null, account_id: null, released: false, day_override: null, paid_override: 0,
    created_at: "", updated_at: "",
  } as HhCashflowOverride],
  nextOverrides: [],
});
const rentE = snapE.nextItems.find((i) => i.key === "fixed:sp-rent");
eq("당월 월세 출금금액 = 0 (미출금)", snapE.classified.find((i) => i.key === "fixed:sp-rent")?.paidAmount, 0);
eq("→ 익월 기본값은 0 이 아니라 당월 예상금액 500,000", rentE?.amount, 500_000);
eq("→ 참고 컬럼도 '-'(null) 로 표시된다", rentE?.currentPaid, null);

// ── 9. 당월 예정(최근실적 없이 날짜만 확정)은 익월 예정으로 이어진다 ──
// 카드대금은 청구액이 매달 달라 최근 실적 매칭(paidRecently)이 안 된다. 당월엔 팀장이 날짜를
// 확정(day_override)해 '예정'으로 남지만, 그 확정은 월별이라 익월로 안 넘어가 예전엔 no-recent 로
// 빠졌다. 이제 당월 '예정' 상태를 익월이 이어받아 카드대금이 익월 탭에서 사라지지 않는다. (보스 요청 2026-07-18)
console.log("\n[9] 당월 예정(최근실적 없이 날짜확정)은 익월 예정으로 이어진다 (보스 요청 2026-07-18)");
const variCard: HhScheduledPayment = {
  id: "sp-varicard", owner_auth_uid: OWNER, title: "변동카드대금", direction: "out", amount: 200_000,
  frequency: "monthly", pay_day: 20, account_id: "acc-1", category_id: "cat-4",
  is_active: true, start_date: null, end_date: null, person_id: null, memo: null,
  sort_order: 0, created_at: "", updated_at: "",
} as unknown as HhScheduledPayment;
const curDayOv: HhCashflowOverride = {
  id: "ov-vari", owner_auth_uid: OWNER, year_month: MONTH, source_kind: "fixed", source_id: "sp-varicard",
  amount_override: null, account_id: null, released: false, day_override: 20, paid_override: null,
  created_at: "", updated_at: "",
} as HhCashflowOverride;
const snapG = cashflowSnapshot(MONTH, {
  ...base,
  scheduled: [...scheduled, variCard],
  // recentOutflows 에 변동카드대금 매칭 없음 → paidRecently=false (당월은 day_override 로 예정 유지)
  overrides: [curDayOv],
  nextOverrides: [], // 익월엔 날짜 확정 없음 → 예전 로직이면 no-recent 로 빠졌을 자리
});
const variCur = snapG.classified.find((i) => i.key === "fixed:sp-varicard");
const variNext = snapG.nextItems.find((i) => i.key === "fixed:sp-varicard");
check("전제: 최근 실적 매칭 없음(paidRecently=false)", !snapG.paidRecently.has("fixed:sp-varicard"));
eq("당월은 날짜확정으로 예정(reason 없음)", variCur?.reason, null);
eq("★익월도 예정으로 이어짐(예전엔 no-recent 로 빠짐)", variNext?.reason, null);
check("익월 예정 목록에 존재", snapG.nextActiveItems.some((i) => i.key === "fixed:sp-varicard"));
eq("익월 예측(inForecast)에도 포함", variNext?.inForecast, true);
check("당월 예정 항목은 모두 익월 예정으로 이어진다(누락 0)",
  snapG.activeItems.every((c) => snapG.nextActiveItems.some((n) => n.key === c.key)));

// ── 10. 이번 달 일시정지는 익월 재개를 막지 않는다 (설계 97 결함A) ──
// 카드대금류(청구액이 매달 달라 paidRecently 매칭 불가)를 이번 달만 쉬면, 예전 로직은
// 당월 reason='manual' → wasActiveThisMonth=false → 익월 no-recent 로 빠뜨려 재개가 안 됐다.
console.log("\n[10] 이번 달 일시정지 → 익월 자동 재개 (설계 97)");
const pauseCard: HhScheduledPayment = {
  id: "sp-pausecard", owner_auth_uid: OWNER, title: "일시정지대상카드", direction: "out", amount: 200_000,
  frequency: "monthly", pay_day: 20, account_id: "acc-1", category_id: "cat-4",
  is_active: true, start_date: null, end_date: null, person_id: null, memo: null,
  sort_order: 0, created_at: "", updated_at: "",
} as unknown as HhScheduledPayment;
// 당월: 날짜확정(예정 상태였다는 뜻) + released(이번 달만 쉼)
const curPauseOv: HhCashflowOverride = {
  id: "ov-pause", owner_auth_uid: OWNER, year_month: MONTH, source_kind: "fixed", source_id: "sp-pausecard",
  amount_override: null, account_id: null, released: true, day_override: 20, paid_override: null,
  created_at: "", updated_at: "",
} as HhCashflowOverride;
const snapH = cashflowSnapshot(MONTH, {
  ...base,
  scheduled: [...scheduled, pauseCard],
  // 최근 실적 매칭 없음 → paidRecently=false (카드대금류 재현)
  overrides: [curPauseOv],
  nextOverrides: [], // 익월엔 아무 오버라이드 없음 = 자동 재개돼야 하는 자리
});
const pauseCur = snapH.classified.find((i) => i.key === "fixed:sp-pausecard");
const pauseNext = snapH.nextItems.find((i) => i.key === "fixed:sp-pausecard");
check("전제: 최근 실적 매칭 없음", !snapH.paidRecently.has("fixed:sp-pausecard"));
eq("당월은 일시정지(manual)", pauseCur?.reason, "manual");
check("→ 당월 예정 목록에서 빠진다", !snapH.activeItems.some((i) => i.key === "fixed:sp-pausecard"));
eq("★익월은 자동 재개(reason 없음)", pauseNext?.reason, null);
eq("★익월 예측에도 포함", pauseNext?.inForecast, true);
check("→ 익월 예정 목록에 보인다", snapH.nextActiveItems.some((i) => i.key === "fixed:sp-pausecard"));

// 자동 분류 사유(undated/no-recent)는 이 완화 대상이 아니다 — 사용자의 '이번 달만 쉼' 의사표시가 아니므로.
const weeklyNextH = snapD.nextItems.find((i) => i.key === "fixed:sp-weekly");
eq("undated 는 익월에도 그대로 제외(회귀 방지)", weeklyNextH?.reason, "undated");

// ── 11. 일시정지는 '그 달만' 예측에서 빠진다 (설계 97 결함B) ──
// 예전엔 forecastSourceIds 가 월 구분 없이 계산돼, 이번 달 한 번 쉬면 3/6/12개월 예측
// 전 기간에서 항목이 사라졌다(일시정지가 영구정지로 예측됨).
console.log("\n[11] 일시정지는 그 달에서만 빠지고 다음 달부터 예측에 복귀 (설계 97)");
// 월세(sp-rent)는 최근 실적이 있어 예측 대상이다. 이번 달만 일시정지시킨다.
const snapI = cashflowSnapshot(MONTH, {
  ...base,
  overrides: [{
    id: "ov-rent-pause", owner_auth_uid: OWNER, year_month: MONTH, source_kind: "fixed", source_id: "sp-rent",
    amount_override: null, account_id: null, released: true, day_override: null, paid_override: null,
    created_at: "", updated_at: "",
  } as HhCashflowOverride],
  nextOverrides: [],
});
// 기준값: 아무 일시정지 없는 snapA 와 비교한다.
const rentAmount = 500_000; // 월세 예상금액(원본). 예측은 원본 scheduled 금액으로 굴러간다.
// ★당월(k=0) 예측 출금은 '아직 안 낸 것'만 담는다(설계 110). 이 fixture 의 월세·대출·카드는 전부
//   당월 실적이 있어 '지급됨'이라, 월세를 일시정지해도 k=0 은 변하지 않는 게 맞다 —
//   이미 나간 돈은 시작 잔액에 반영돼 있으므로 예측이 또 빼서도, 도로 더해서도 안 된다.
eq("이미 지급된 항목은 일시정지해도 당월 예측이 안 변한다(설계 110)",
  snapI.projection[0].outflow, snapA.projection[0].outflow);
// 그래서 일시정지의 당월 효과는 **미지급** 항목으로 확인한다(지난달 실적만 있는 항목).
const unpaidFix: HhScheduledPayment = {
  id: "sp-unpaidfix", owner_auth_uid: OWNER, title: "미지급고정비", direction: "out", amount: 123_000,
  frequency: "monthly", pay_day: 28, account_id: "acc-1", category_id: "cat-5",
  is_active: true, start_date: null, end_date: null, person_id: null, memo: null,
  sort_order: 0, created_at: "", updated_at: "",
} as unknown as HhScheduledPayment;
const baseUnpaid = {
  ...base,
  scheduled: [...scheduled, unpaidFix],
  // 지난달 실적만 → 예측 대상(paidRecently)이면서 당월 미지급
  recentOutflows: [...recentOutflows, { amount: 123_000, counterparty: "미지급고정비", txn_date: "2026-06-28" }],
  nextOverrides: [],
};
const snapU0 = cashflowSnapshot(MONTH, { ...baseUnpaid, overrides: [] });
const snapU1 = cashflowSnapshot(MONTH, {
  ...baseUnpaid,
  overrides: [{
    id: "ov-unpaid-pause", owner_auth_uid: OWNER, year_month: MONTH, source_kind: "fixed", source_id: "sp-unpaidfix",
    amount_override: null, account_id: null, released: true, day_override: null, paid_override: null,
    created_at: "", updated_at: "",
  } as HhCashflowOverride],
});
eq("전제: 미지급 항목이 당월 예측에 들어있다", snapU0.projection[0].outflow, snapA.projection[0].outflow + 123_000);
eq("당월(k=0) 예측 출금에서 일시정지한 미지급 항목이 빠진다",
  snapU1.projection[0].outflow, snapU0.projection[0].outflow - 123_000);
eq("★익익월(k=2)은 그대로 — 자동 재개",
  snapI.projection[2].outflow, snapA.projection[2].outflow);
// ★'일시정지 ≠ 영구정지' 를 독립적으로 못박는다.
//   (예전엔 바로 위 단언과 같은 식이라 항상 함께 통과/실패했다 = 검증이 아니었다.)
//   영구정지(is_active=false)로 만든 대조군과 비교해, 일시정지가 그 값으로 떨어지지 않음을 본다.
const snapIPerm = cashflowSnapshot(MONTH, {
  ...base,
  scheduled: scheduled.map((s) => (s.id === "sp-rent" ? { ...s, is_active: false } : s)),
  overrides: [],
  nextOverrides: [],
});
check("★일시정지는 영구정지와 다르다 — 익익월 예측이 영구정지 값으로 떨어지지 않는다",
  snapI.projection[2].outflow !== snapIPerm.projection[2].outflow,
  `일시정지 ${snapI.projection[2].outflow} vs 영구정지 ${snapIPerm.projection[2].outflow} — 같으면 영구 소멸 회귀`);
eq("   (대조군 확인) 영구정지면 익익월에서 월세만큼 빠진다",
  snapIPerm.projection[2].outflow, snapA.projection[2].outflow - rentAmount);
// 익월(k=1)은 nextForecastOut 대체 주입 경로(설계 81 §E)를 타므로 별도로 확인한다.
eq("익월도 재개되어 예측 출금이 유지된다",
  snapI.projection[1].outflow, snapA.projection[1].outflow);

// ── 12. 하위호환: excludedByYm 을 안 넘기면 기존 산출과 완전히 같다 (설계 97 §7-④) ──
// projectMonths 는 excludedByYm 을 선택 인자로 받는다(설계 97). 안 넘긴 호출의 산출이
// 한 자리라도 달라지면 안 된다 — scripts/test_scheduled_period.mts 가 실제로 무인자로 부르고,
// 시그니처가 선택 인자인 이상 앞으로의 호출부도 그렇게 부를 수 있다.
// (프로덕션 호출부는 cashflow-snapshot.ts 하나뿐이고 거기선 항상 넘긴다.)
console.log("\n[12] excludedByYm 미전달 시 기존 산출과 동일 (설계 97 §7-④ 하위호환)");
const projInputs = { scheduled, loans, installments };
const projNoArg = projectMonths(10_000_000, MONTH, 3, projInputs);

// ★반드시 '고정 기대값'과 비교한다 — 다른 호출과 비교하면 의미가 없다.
//   excludedByYm?.get(ym) 은 인자 미전달·빈 Map·무관한 달 Map 이 전부 undefined 로 수렴하므로,
//   그 셋을 서로 비교하는 단언은 구현이 어떻게 망가지든 항상 통과하는 항진명제다.
//   (실제로 그렇게 짰다가 `excludedByYm?.get(ym) ?? new Set(["sp-salary"])` 뮤테이션을
//    전부 통과시켰다 — 무인자 호출부가 정기수입 400만원을 조용히 잃는데도 초록불이었다.)
const GOLDEN = [
  { ym: "2026-07", inflow: 4_000_000, outflow: 1_014_097, net: 2_985_903, openingCash: 10_000_000, closingCash: 12_985_903 },
  { ym: "2026-08", inflow: 4_000_000, outflow: 1_014_097, net: 2_985_903, openingCash: 12_985_903, closingCash: 15_971_806 },
  { ym: "2026-09", inflow: 4_000_000, outflow: 1_014_097, net: 2_985_903, openingCash: 15_971_806, closingCash: 18_957_709 },
];
eq("인자 미전달 산출이 고정 기대값과 일치", JSON.stringify(projNoArg), JSON.stringify(GOLDEN));

// 선택 인자를 어떤 형태로 넘겨도 '기존 동작 그대로'여야 한다 — 각각 고정 기대값과 대조한다.
const projEmptyMap = projectMonths(10_000_000, MONTH, 3, projInputs, new Set(), undefined, new Map());
eq("빈 Map 전달도 고정 기대값과 일치", JSON.stringify(projEmptyMap), JSON.stringify(GOLDEN));
const projOtherYm = projectMonths(10_000_000, MONTH, 3, projInputs, new Set(), undefined,
  new Map([["1999-01", new Set(["sp-rent"])]]));
eq("관계없는 달의 제외도 고정 기대값과 일치", JSON.stringify(projOtherYm), JSON.stringify(GOLDEN));

// 반대로 실제 해당 월을 넘기면 반드시 달라져야 한다(인자가 죽어 있으면 여기서 잡힌다).
const projThisYm = projectMonths(10_000_000, MONTH, 3, projInputs, new Set(), undefined,
  new Map([[MONTH, new Set(["sp-rent"])]]));
check("(대조) 해당 월을 넘기면 산출이 실제로 달라진다",
  JSON.stringify(projThisYm) !== JSON.stringify(GOLDEN),
  "excludedByYm 이 아무 효과가 없다면 위 하위호환 단언은 의미가 없다");

// ── 13. 자동 사유 no-recent 는 익월에도 그대로 제외 (설계 97 §7-⑤) ──
// §5.1 의 wasActiveThisMonth 완화가 건드리는 분기가 정확히 no-recent 다.
// 사용자의 '이번 달만 쉼' 의사표시(manual)가 아닌데 재개되면 안 된다.
console.log("\n[13] no-recent 는 익월에도 그대로 제외 (설계 97 §7-⑤ 회귀 방지)");
const snapK = cashflowSnapshot(MONTH, {
  ...base,
  scheduled: [...scheduled, pauseCard],
  overrides: [], // 오버라이드 없음 = 사용자의 일시정지 의사표시가 없다
  nextOverrides: [],
});
const nrCur = snapK.classified.find((i) => i.key === "fixed:sp-pausecard");
const nrNext = snapK.nextItems.find((i) => i.key === "fixed:sp-pausecard");
check("전제: 최근 실적 매칭 없음", !snapK.paidRecently.has("fixed:sp-pausecard"));
eq("당월 사유 = no-recent", nrCur?.reason, "no-recent");
eq("★익월에도 no-recent 그대로 (manual 처럼 재개되면 안 된다)", nrNext?.reason, "no-recent");
check("→ 익월 예정 목록에도 안 보인다", !snapK.nextActiveItems.some((i) => i.key === "fixed:sp-pausecard"));

console.log("\n[14] 통합카드 할부는 같은 카드 묶음의 활성 카드 결제계좌를 사용");
const groupedMethods = [
  {
    id: "pm-samsung-old", owner_auth_uid: OWNER, name: "삼성카드(김하늘)", kind: "credit",
    billing_day: null, linked_account_id: null, is_active: false,
    sort_order: 0, created_at: "", updated_at: "",
  } as unknown as HhPaymentMethod,
  {
    id: "pm-samsung-active", owner_auth_uid: OWNER, name: "삼성카드(김하늘) 달달할인 카드", kind: "credit",
    billing_day: null, linked_account_id: "acc-toss", is_active: true,
    sort_order: 1, created_at: "", updated_at: "",
  } as unknown as HhPaymentMethod,
];
const groupedInstallment = {
  id: "ins-samsung", owner_auth_uid: OWNER, start_date: "2026-07-01",
  payment_method_id: "pm-samsung-old", category_id: "cat-appliance", title: "청소기",
  total_amount: 120_000, total_count: 12, start_installment: 1, is_active: true,
  created_at: "", updated_at: "",
} as HhInstallment;
const groupedCalendar = cashflowCalendar(MONTH, {
  scheduled: [], loans: [], installments: [groupedInstallment], txns: [], methods: groupedMethods,
});
const groupedEntry = groupedCalendar.undated.find((i) => i.sourceId === groupedInstallment.id);
eq("비활성 통합카드 할부의 결제계좌", groupedEntry?.defaultAccountId, "acc-toss");


// ── 15. 대출 출금계좌는 원천(hh_loan.account_id)에서 온다 (설계 185) ──
// 컬럼은 2026-07-16 에 생겼는데 캘린더가 안 읽어서, 당월은 사람이 손으로 지정한
// 오버라이드로만 채워지고 **익월은 늘 빈칸**이었다(2026-08-19 실측: 익월 빈 10건 전부 대출).
// 오버라이드는 '이 달만 다른 계좌' 라는 뜻이므로 여전히 원천보다 우선한다.
console.log("\n[15] 대출 출금계좌 = 그 달 오버라이드 > hh_loan.account_id > 빈칸");
const snapL = cashflowSnapshot(MONTH, { ...base, overrides: [], nextOverrides: [] });
eq("당월 대출 출금계좌 = 원천 계좌", snapL.activeItems.find((i) => i.key === "loan:loan-1")?.accountId, "acc-1");
eq("★익월 대출 출금계좌 = 원천 계좌 (오버라이드 없이도 채워진다)",
  snapL.nextActiveItems.find((i) => i.key === "loan:loan-1")?.accountId, "acc-1");

const ovLoan = (patch: Partial<HhCashflowOverride>): HhCashflowOverride =>
  ({
    id: "ov-loan", owner_auth_uid: OWNER, year_month: MONTH, source_kind: "loan", source_id: "loan-1",
    amount_override: null, account_id: null, released: false, day_override: null, paid_override: null,
    created_at: "", updated_at: "", ...patch,
  }) as HhCashflowOverride;

const snapLo = cashflowSnapshot(MONTH, {
  ...base,
  overrides: [ovLoan({ account_id: "acc-2" })],
  nextOverrides: [ovLoan({ year_month: NEXT, account_id: "acc-3" })],
});
eq("당월 오버라이드가 원천 계좌를 이긴다", snapLo.activeItems.find((i) => i.key === "loan:loan-1")?.accountId, "acc-2");
eq("익월 오버라이드가 원천 계좌를 이긴다", snapLo.nextActiveItems.find((i) => i.key === "loan:loan-1")?.accountId, "acc-3");

// 원천에 계좌가 없는 대출은 예전 그대로 빈칸이다 — 없는 값을 지어내지 않는다.
const loansNoAcct: HhLoan[] = [{ ...loans[0], account_id: null }];
const snapLn = cashflowSnapshot(MONTH, { ...base, loans: loansNoAcct, overrides: [], nextOverrides: [] });
eq("원천 계좌가 없으면 당월도 빈칸", snapLn.activeItems.find((i) => i.key === "loan:loan-1")?.accountId, null);
eq("원천 계좌가 없으면 익월도 빈칸", snapLn.nextActiveItems.find((i) => i.key === "loan:loan-1")?.accountId, null);


// ── 16. 대출 계좌는 '표시'에만 쓰고 '매칭'엔 안 쓴다 (설계 185 후속) ──
// §[15] 로 대출이 원천 계좌를 갖게 되자, 계좌 게이트(설계 166)가 대출에도 걸리기 시작했다.
// 게이트는 *금액이 딱 안 맞는 payment 는 출금계좌가 다르면 안 붙인다* 인데, 대출 원장의 계좌는
// **현재값 하나**뿐이라 과거 달에 대면 시대착오가 된다.
// ★실사례(2026-08-19 실측): 팀장이 은행 주계좌를 두 번 바꿨다 — 신한(4/28 해지)·하나1(6/27 해지).
//   그래서 2026-04 약관대출 2,989원(신한에서 나감)과 2026-06 하나저축은행 387,740원(하나1에서 나감)이
//   매칭에서 끊겼다. **실제로 낸 돈인데 화면이 '미출금'이라 말하고** 6월 이번달 잔액을 마이너스로
//   뒤집으며 하나은행 부족액 388,070 경고까지 띄웠다. 게이트는 남의 거래를 훔치는 걸 막는 장치인데
//   여기선 진짜 주인을 막았다. 팀장 판정 2026-08-19: 대출은 매칭 게이트에서 뺀다.
// ★이 테스트는 **종단(cashflowSnapshot)** 으로 검증한다 — matchOutflowActuals 에 계좌를 손으로
//   먹이면 defaultAccountOf 를 안 거쳐 설계 185 회귀를 못 잡는다(2026-08-19 리뷰가 잡은 실수).
console.log("\n[16] 대출 원천 계좌는 매칭 게이트에 안 쓰인다 (표시에만 — 설계 185 후속)");
{
  // 옛 계좌에서 나간 상환 — 금액이 330원 달라 score<3(게이트 적용 구간)이다.
  const oldAcctPaid = [
    { amount: 480_000, counterparty: "월세", txn_date: "2026-07-05", type: "expense", account_id: "acc-1" },
    { amount: 513_767, counterparty: "디딤돌 상환", txn_date: "2026-07-25", type: "payment", from_account_id: "acc-old" },
  ];
  const snap = cashflowSnapshot(MONTH, {
    ...base, recentOutflows: oldAcctPaid as never, overrides: [], nextOverrides: [],
    accountIds: ["acc-1", "acc-old"],
  });
  const loanItem = snap.classified.find((i) => i.key === "loan:loan-1");
  eq("★해지된 옛 계좌에서 나간 상환도 그 대출 것으로 잡는다", loanItem?.paidAmount, 513_767);
  eq("표시용 출금계좌는 여전히 원천 계좌다(매칭과 별개)", loanItem?.accountId, "acc-1");
  eq("잡혔으므로 '최근 실적 없음'으로 사라지지 않는다", loanItem?.reason, null);
}

console.log(`\n${failures === 0 ? "✅ 전체 통과" : `❌ 실패 ${failures}건`}`);
process.exit(failures === 0 ? 0 : 1);
