// 현황(홈)과 현금흐름 화면이 '출금 예정'·'이번 달 잔액'·여러 달 예측을 **같은 숫자**로
// 보여주기 위한 공유 계산 모듈. (설계 docs/household/79)
// 화면별 파생(기간·계좌 필터, 카테고리 차트, 계좌별 잔액 표)은 각 페이지에 남긴다.

import {
  cashflowCalendar,
  matchOutflowActuals,
  outflowsForMatching,
  projectMonths,
  receivedInflowIds,
  scheduledActiveInYm,
  ymOf,
  type ActualOutflow,
  type CalendarEntry,
  type MonthProjection,
} from "./calc";
import { makeMethodResolver, type MethodResolver } from "./card-group";
import { shiftMonth } from "./month";
import type {
  HhCashflowOverride,
  HhCashflowSourceKind,
  HhInstallment,
  HhLoan,
  HhPaymentMethod,
  HhScheduledPayment,
  HhTransaction,
} from "./types";

// 출금예정 한 항목(오버라이드 반영 후). (cash 화면에서 이동, 설계 65)
export interface OutItem {
  key: string;
  sourceKind: HhCashflowSourceKind;
  sourceId: string;
  kind: CalendarEntry["kind"];
  label: string;
  categoryId: string | null; // 원본 카테고리(고정비·할부만)
  day: number | null; // 유효일 = day_override ?? naturalDay
  naturalDay: number | null; // 캘린더 자연 납부일(pay_day/billing_day)
  dayOverridden: boolean; // 사용자가 날짜를 직접 지정(확정)했는가
  amount: number; // 예상금액
  accountId: string | null;
  /** 결제수단(고정비에 지정된 카드 등) — 표의 출금계좌 칸에 카드명을 보여주는 데 쓴다. (설계 108) */
  paymentMethodId: string | null;
  /**
   * 신용카드 결제분 — 그날 현금이 안 빠진다. 표에는 보이되 **계좌 잔액 예측·출금예정 합계에서 뺀다.**
   * 실제 현금은 카드대금일에 카드대금 정기지출로 나가므로 같이 세면 이중차감이다. (설계 108)
   */
  cardCharge: boolean;
  /**
   * **항목 등록값 기준** 카드 결제분 — 그 달 오버라이드(설계 203)를 반영하기 **전** 값.
   * ★여러 달 예측 소속(forecastSourceIds)은 반드시 이 값으로 정한다. `cardCharge` 로 정하면
   *   "이 달만" 이어야 할 오버라이드가 **m+2 이후 전 구간**을 좌우한다(2026-09-04 교차리뷰 High).
   *   실측: 9월만 지갑으로 덮었더니 11·12월 예측 출금이 350,000 → 700,000 이 됐고,
   *   반대로 9월만 카드로 덮었더니 11·12월이 350,000 → 0 이 돼 예측이 낙관적으로 기울었다.
   */
  baseCardCharge: boolean;
  /**
   * **항목 등록값 기준** 출금계좌 — 그 달 결제수단 오버라이드를 반영하기 **전** 값(설계 203).
   * ★최근 3개월 매칭(`paidRecently`)에는 반드시 이 값을 넘긴다. 오버라이드가 적용된 `accountId` 를
   *   넘기면 신용카드로 덮은 달에 계좌가 null 이 되어 **설계 188 의 계좌 우선순위(36>33>30)가 흔들리고**,
   *   과거 실적의 주인이 같은 금액의 다른 항목으로 넘어간다 → `reason`·`forecastSourceIds`·익월까지
   *   따라 바뀐다(2026-09-05 덱스 교차검토 High. 실측: m+2 출금 100 → 0).
   */
  baseAccountId: string | null;
  /** 그 달 결제수단을 사람이 명시했는가(설계 203). day_override 와 같은 급의 '확정' 신호다. */
  methodOverridden: boolean;
  released: boolean; // 직접 제외(override.released)
  paidOverride: number | null; // 수기 입력 지급금액(override.paid_override)
}

// 예정/제외 재분류 결과(설계 65).
export type ReleaseReason = null | "manual" | "undated" | "no-recent";
// 사용자 용어(설계 70, 설계 97 C): '해제'는 실제 출금 취소로, 이전 문구는 영구 삭제로 오해될 수 있어
// 실제 동작인 '이번 달만 일시정지 · 다음 달 자동 재개' 계열로 표기.
export const RELEASE_REASON_LABEL: Record<"manual" | "undated" | "no-recent", string> = {
  manual: "이번 달 일시정지 · 다음 달 자동 재개",
  undated: "날짜 확인 필요",
  "no-recent": "최근 출금 기록 없음",
};

export interface ClassifiedItem extends OutItem {
  paidAmount: number | null; // 이번 달 매칭 실지급액(수기 paid_override 우선)
  reason: ReleaseReason; // null이면 예정(active)
}

/**
 * 출금 예정 항목을 실제 거래 매칭 입력으로 바꾼다.
 * 대출 원장의 계좌는 현재값 하나뿐이라 과거 거래에 게이트로 쓰지 않는다(설계 185 후속).
 * ★accountBlind(설계 188 후속): "계좌를 일부러 모른 채 매칭하는 항목(=대출)"을 매처에 알린다 —
 *   같은 금액 경쟁에서 계좌일치 우선패스(pass 36)가 대출 몫의 거래를 가로채지 않게 하는 근거.
 */
export function toOutflowMatchItem(
  item: Pick<OutItem, "key" | "sourceKind" | "amount" | "label" | "day" | "accountId">
) {
  return {
    key: item.key,
    amount: item.amount,
    label: item.label,
    day: item.day,
    accountId: item.sourceKind === "loan" ? null : item.accountId,
    accountBlind: item.sourceKind === "loan",
  };
}

// 익월 출금 한 항목(설계 81). 당월 값을 기준으로 끌어오고 카드값·변동금액을 익월 오버라이드로 덮는다.
export interface NextOutItem {
  key: string;
  sourceKind: HhCashflowSourceKind;
  sourceId: string;
  kind: CalendarEntry["kind"];
  label: string;
  categoryId: string | null;
  day: number | null; // 유효일 = 익월 day_override ?? naturalDay
  naturalDay: number | null;
  dayOverridden: boolean;
  currentPaid: number | null; // 당월 출금금액(실지급) — 화면 참고 컬럼
  currentAmount: number | null; // 당월 예상금액
  baseAmount: number; // 이월 기준값 = currentPaid ?? currentAmount ?? 원본금액
  amount: number; // 익월 예상금액 = 익월 amount_override ?? baseAmount
  amountOverridden: boolean; // 사용자가 익월 금액을 직접 입력했는가
  accountId: string | null;
  paymentMethodId: string | null; // 설계 108
  cardCharge: boolean; // 신용카드 결제분 = 현금 유출 합계에서 제외(설계 108)
  released: boolean;
  reason: ReleaseReason; // null이면 익월 예정(탭에 표시)
  /**
   * ③ 여러 달 예측에 넣을 항목인가 — 설계 65 §F와 **같은 기준**.
   * 탭 표시(reason==null)와 일부러 다르다: 날짜 미정(주간 고정비 등)이라도 최근 실적이 있으면
   * 월 단위 예측에는 넣는다(안 넣으면 출금을 과소계상해 월말 예상현금이 낙관적으로 나온다).
   */
  inForecast: boolean;
}

// 익월 항목 1건 생성. 캘린더에서 온 항목과 카드 이월 항목이 같은 규칙을 타도록 공용화. (설계 81 §C·§D)
function buildNextItem(
  base: {
    sourceKind: HhCashflowSourceKind;
    sourceId: string;
    kind: CalendarEntry["kind"];
    label: string;
    categoryId: string | null;
    naturalDay: number | null;
    fallbackAmount: number; // 당월에 없던 신규 항목(익월 시작 할부 등)에 쓸 원본 금액
    defaultAccountId: string | null;
    paymentMethodId: string | null;
    cardCharge: boolean;
  },
  ctx: {
    nextOverrideMap: Map<string, HhCashflowOverride>;
    classifiedByKey: Map<string, ClassifiedItem>;
    paidRecently: Map<string, ActualOutflow>;
    methodResolver?: MethodResolver;
  }
): NextOutItem {
  const key = `${base.sourceKind}:${base.sourceId}`;
  const ov = ctx.nextOverrideMap.get(key);
  const cur = ctx.classifiedByKey.get(key);
  // 익월 결제수단은 **익월 오버라이드로만** 정해진다 — 당월 것을 물려받지 않는다(설계 203 §4).
  // 물려받으면 "이번 달만 카드"가 영원히 카드로 굳는다.
  const eff = effectiveMethod(base, ov?.payment_method_id, ctx.methodResolver);

  // 당월 출금금액이 0/비움이면 '미출금'이라는 뜻이지(설계 65) '익월에 0원 나간다'는 뜻이 아니다.
  // → 실적으로 보지 않고 당월 예상금액으로 넘어간다.
  const rawPaid = cur?.paidAmount ?? null;
  const currentPaid = rawPaid != null && rawPaid > 0 ? rawPaid : null;
  const currentAmount = cur?.amount ?? null;
  // 이월 기준값: 당월 출금금액 > 당월 예상금액 > 원본 금액. (보스 확정 2026-07-17)
  const baseAmount = currentPaid ?? currentAmount ?? base.fallbackAmount;

  const day = ov?.day_override ?? base.naturalDay;
  const dayOverridden = ov?.day_override != null;
  const released = ov?.released ?? false;

  // 재분류 — 당월과 동일 기준. paidRecently(최근 3개월 실적)는 키가 같아 익월에도 그대로 유효.
  const paidRecently = ctx.paidRecently.has(key);
  // ★당월에 '예정'이던 항목은 익월에도 그대로 이어받는다(정기지출은 매달 반복되므로). (보스 요청 2026-07-18)
  // 카드대금은 청구액이 매달 달라 최근 실적 매칭(paidRecently)이 안 돼 익월에서 no-recent로 걸러졌다.
  // 날짜 확정(day_override)은 월별이라 익월로 안 넘어가므로, 당월 확정 상태를 이어받아 익월 탭에서 사라지지 않게 한다.
  // 일시정지(manual)는 '이 항목이 없어졌다'가 아니라 '이번 달만 쉰다'는 뜻이므로
  // 익월 판정에서는 당월에 활성이었던 것으로 취급한다 → 다음 달 자동 재개. (설계 97)
  // undated/no-recent 는 시스템 자동 분류 사유라 여기 포함하지 않는다.
  const wasActiveThisMonth = cur != null && (cur.reason == null || cur.reason === "manual");
  // ★익월도 당월과 같은 면제를 준다(설계 203) — 없으면 **익월 팝업에서 수단을 명시한 신규 항목이
  //   그 즉시 익월 표·예측에서 사라진다**(2026-09-05 덱스 교차검토 High. 다음 달 시작하는 카드 고정비를
  //   익월만 지갑으로 지정하면 reason=no-recent · inForecast=false · nextForecastOut=0 이 됐다).
  const methodOverridden =
    ov?.payment_method_id != null && (base.sourceKind === "fixed" || base.sourceKind === "installment");
  let reason: ReleaseReason = null;
  if (released) reason = "manual";
  else if (day == null) reason = "undated";
  // 카드 결제분은 은행 실출금이 없어 최근 실적이 영원히 안 잡힌다 → 당월과 같은 면제. (설계 108 교차리뷰)
  // 없으면 새로 등록한 카드결제 고정비가 익월 탭에서 통째로 사라진다.
  else if (!paidRecently && !dayOverridden && !wasActiveThisMonth && !eff.cardCharge && !methodOverridden)
    reason = "no-recent";

  return {
    key,
    sourceKind: base.sourceKind,
    sourceId: base.sourceId,
    kind: base.kind,
    label: base.label,
    categoryId: base.categoryId,
    day,
    naturalDay: base.naturalDay,
    dayOverridden,
    currentPaid,
    currentAmount,
    baseAmount,
    amount: ov?.amount_override ?? baseAmount,
    amountOverridden: ov?.amount_override != null,
    accountId: eff.cardCharge ? null : ov?.account_id ?? eff.defaultAccountId, // 카드 결제분은 계좌 없음(설계 108)
    paymentMethodId: eff.paymentMethodId,
    cardCharge: eff.cardCharge,
    released,
    reason,
    // 설계 65 §F + 당월 예정 이월(보스 요청 2026-07-18): 당월 예정이면 익월 예측에도 포함해 익월 탭↔예측 정합을 유지한다.
    // 표(reason)와 예측(inForecast)이 같은 신호를 봐야 두 숫자가 안 갈린다(설계 65 §F + 설계 203).
    inForecast: !released && (paidRecently || dayOverridden || wasActiveThisMonth || methodOverridden),
  };
}

// 캘린더 항목 + 오버라이드 → 화면용 출금 항목.
/**
 * 그 달만 결제수단을 갈아끼운 결과를 계산한다. (설계 203)
 * 오버라이드가 없으면 캘린더가 준 값을 **그대로** 돌려준다 — 종전 동작과 완전히 같다.
 * 대출은 결제수단 개념이 없어(cardChargeOf 가 항상 false) 오버라이드를 받아도 무시한다.
 */
function effectiveMethod(
  entry: Pick<CalendarEntry, "sourceKind" | "paymentMethodId" | "cardCharge" | "defaultAccountId">,
  ovMethodId: string | null | undefined,
  resolver?: MethodResolver
): { paymentMethodId: string | null; cardCharge: boolean; defaultAccountId: string | null } {
  const base = {
    paymentMethodId: entry.paymentMethodId,
    cardCharge: entry.cardCharge,
    defaultAccountId: entry.defaultAccountId,
  };
  // ★화이트리스트로 막는다(2026-09-05 교차리뷰 Low). 'loan 만 제외'로 두면 **카드대금(card) 행**에
  //   오버라이드가 들어왔을 때 그 카드대금이 cardCharge=true 로 뒤집혀 **출금예정 합계에서 통째로 빠진다**
  //   — 카드대금은 그날 실제로 통장에서 나가는 돈이다(설계 108). 지금 UI·스크립트로는 안 생기지만
  //   엔진이 스스로 막는 편이 안전하다. UI 의 canPickMethod 와 같은 집합이다.
  const pickable = entry.sourceKind === "fixed" || entry.sourceKind === "installment";
  if (!ovMethodId || !resolver || !pickable) return base;
  const cardCharge = resolver.isCardCharge(ovMethodId);
  return {
    paymentMethodId: ovMethodId,
    cardCharge,
    // 즉시출금(체크·지갑)으로 덮은 달은 그 수단의 연결계좌가 출금계좌다. 신용으로 덮었으면
    // 카드대금일에 빠지므로 계좌를 주지 않는다(아래 accountId 정규화가 어차피 null 로 만든다).
    defaultAccountId: resolver.isImmediate(ovMethodId) ? resolver.linkedAccountOf(ovMethodId) : null,
  };
}

export function buildOutItem(
  entry: CalendarEntry,
  day: number | null,
  overrideMap: Map<string, HhCashflowOverride>,
  resolver?: MethodResolver
): OutItem {
  const key = `${entry.sourceKind}:${entry.sourceId}`;
  const ov = overrideMap.get(key);
  const eff = effectiveMethod(entry, ov?.payment_method_id, resolver);
  return {
    key,
    sourceKind: entry.sourceKind,
    sourceId: entry.sourceId,
    kind: entry.kind,
    label: entry.label,
    categoryId: entry.categoryId,
    day: ov?.day_override ?? day, // 날짜 변경 시 오버라이드 우선 → 정렬·예상잔액에 반영
    naturalDay: day,
    dayOverridden: ov?.day_override != null,
    amount: ov?.amount_override ?? entry.amount,
    // 카드 결제분은 계좌에서 안 빠지므로 계좌를 갖지 않는다. 과거에 지정해 둔 오버라이드 계좌가 남아 있으면
    // 그 계좌가 '출금 후 잔액' 합계 범위(scopeAccIds)에 끼어 잔액이 부풀므로 여기서 정규화한다. (설계 108 교차리뷰)
    accountId: eff.cardCharge ? null : ov?.account_id ?? eff.defaultAccountId,
    paymentMethodId: eff.paymentMethodId,
    cardCharge: eff.cardCharge,
    baseCardCharge: entry.cardCharge,
    // 설계 203 이전과 **완전히 같은 식** — 결제수단 오버라이드만 안 탄다.
    baseAccountId: entry.cardCharge ? null : ov?.account_id ?? entry.defaultAccountId,
    methodOverridden:
      ov?.payment_method_id != null && (entry.sourceKind === "fixed" || entry.sourceKind === "installment"),
    released: ov?.released ?? false,
    paidOverride: ov?.paid_override ?? null,
  };
}

/**
 * 예정일보다 이만큼(일) 넘게 이른 거래는 그 항목의 실적으로 보지 않는다. (설계 131)
 * 5일 = 주말 밀림·며칠 선납까지는 같은 건으로 보되, 월초 거래가 중순·월말 예정 항목에 붙는 것은 막는 선.
 * (설계 105 의 정기지출 금액매칭도 ±5일을 쓴다 — 같은 자를 쓴다.)
 * ★상호까지 일치하는 짝은 이 가드를 면제받는다(matchOutflowActuals 참고).
 */
export const EARLY_DAY_TOLERANCE = 5;

export interface CashMatchOutflow extends ActualOutflow {
  type: "expense" | "payment" | "transfer";
  account_id: string | null;
  from_account_id: string | null;
  to_account_id: string | null;
  payment_method_id: string | null;
}

/**
 * 전월 출금 열 + 카드 결제분 실결제 매칭(설계 127·166) — 컴포넌트 밖 순수 함수.
 *
 * - 전월 열: 스냅샷의 당월 매칭과 **같은 규칙·같은 항목 풀·같은 날짜 가드**를 전월 거래에 적용(설계 127·131).
 * - 카드 결제분(표시 전용): "카드대금일 반영" 행도 실제 결제됐는지 보여야 한다(팀장 지시 2026-08-12).
 *   풀은 그 달의 ⓐ신용·할부 카드 지출(본 매칭 풀에서 빠진 것) + ⓑ본 매칭이 쓰고 남은 거래
 *   (체크·이체·지갑 결제 실사례: 목동수학 7/1 부천페이 · 영어과외 7/8 토스뱅크).
 *   **본 매칭 뒤에 남은 것만** 쓰므로 현금 항목의 거래를 훔칠 수 없다(설계 108 사고 구조 재발 없음).
 *   합계·잔액 계산에는 불참여 — 카드 결제분은 통장 출금이 아니다(설계 108).
 */
export function computeCashMatches(input: {
  month: string;
  classified: ClassifiedItem[];
  paidThisMonth: Map<string, ActualOutflow>;
  recentOutflows: CashMatchOutflow[];
  accounts: { id: string }[];
  methods: { id: string; kind: string }[];
}) {
  const { month, classified, paidThisMonth, recentOutflows, accounts, methods } = input;
  const prevYm = shiftMonth(month, -1);
  const cardMethodIdList = methods.filter((m) => m.kind === "credit" || m.kind === "installment").map((m) => m.id);
  const accIds = accounts.map((a) => a.id);
  // 내부 이체 제외는 스냅샷(당월)과 **같은 함수**로 — 두 열이 같은 자(尺)여야 한다. (설계 131)
  const matchPool = outflowsForMatching(recentOutflows, accIds, cardMethodIdList);
  const prevOutflowPool = matchPool.filter((t) => t.txn_date.slice(0, 7) === prevYm);
  // 직접 제외(released)한 항목을 맨 뒤로 미는 것도 당월 열과 같다 — 안 그러면 제외한 항목이
  // 남의 전월 거래를 먼저 가져간다(2026-08-09 구미아파트 실사례, cashflow-snapshot 의 matchItems 주석).
  // ★전월 열은 **당월 결제수단 오버라이드와 무관**해야 한다(설계 203 "이 달만"). 등록값으로 가른다 —
  //   안 그러면 당월만 지갑으로 바꿨을 뿐인데 **전월 카드 결제금액 표시가 사라진다**
  //   (2026-09-05 덱스 교차검토 Medium. 실측: prevCardPaid 100 → null).
  const items = classified
    .filter((i) => !i.baseCardCharge)
    .sort((a, b) => Number(a.released) - Number(b.released) || b.amount - a.amount)
    // accountId 의 대출 예외까지 공용 헬퍼로 맞춘다 — 스냅샷 matchItems 와 같은 자(설계 185 후속).
    .map((i) => toOutflowMatchItem({ ...i, accountId: i.baseAccountId }));
  // 당월 열과 같은 날짜 가드(설계 131) — 두 열이 같은 자(尺)여야 나란히 읽힌다.
  const prevPaidByKey = matchOutflowActuals(items, prevOutflowPool, { earlyDayTolerance: EARLY_DAY_TOLERANCE });

  const cardIdSet = new Set(cardMethodIdList);
  const cardTxnOf = (ym: string) =>
    recentOutflows.filter(
      (t) => t.txn_date.slice(0, 7) === ym && t.type === "expense" && t.payment_method_id != null && cardIdSet.has(t.payment_method_id)
    );
  const toCardItem = (i: ClassifiedItem) => ({ key: i.key, amount: i.amount, label: i.label, day: i.day });
  const sortForMatch = (a: ClassifiedItem, b: ClassifiedItem) =>
    Number(a.released) - Number(b.released) || b.amount - a.amount;
  // ★카드 행 풀은 **열마다 기준이 다르다**(설계 203).
  //   · 당월 표시(cardPaidByKey)는 그 달 얘기라 **그 달 값**(cardCharge)으로 가른다 —
  //     안 그러면 그 달만 카드로 지정한 행의 결제금액이 안 보인다.
  //   · 전월 표시(prevCardPaidByKey)는 지난달 얘기라 **등록값**(baseCardCharge)으로 가른다 —
  //     당월 오버라이드가 전월 표시를 바꾸면 "이 달만"이라는 계약을 깬다(덱스 교차검토 Medium).
  const nowCardItems = classified.filter((i) => i.cardCharge).sort(sortForMatch).map(toCardItem);
  const prevCardItems = classified.filter((i) => i.baseCardCharge).sort(sortForMatch).map(toCardItem);
  // 당월: 본 매칭(paidThisMonth)이 쓰고 남은 풀 + 카드 지출. 객체 동일성으로 가린다 —
  // recentOutflows 의 같은 행 참조가 스냅샷 매칭 결과에 그대로 들어 있다.
  // ★payment(카드대금·대출납부)는 뺀다 — 카드 결제분 항목이 payment 거래로 결제될 일은 없는데,
  //   미매칭 카드대금이 금액만 맞으면 카드 행 '결제금액'으로 표시될 수 있다(교차리뷰 2026-08-13).
  const usedNow = new Set(paidThisMonth.values());
  const nowPool = [
    ...cardTxnOf(month),
    ...matchPool.filter((t) => t.txn_date.slice(0, 7) === month && t.type !== "payment" && !usedNow.has(t)),
  ];
  // 전월: 전월 열 매칭이 쓰고 남은 풀 + 전월 카드 지출.
  const usedPrev = new Set(prevPaidByKey.values());
  const prevPool = [...cardTxnOf(prevYm), ...prevOutflowPool.filter((t) => t.type !== "payment" && !usedPrev.has(t))];
  return {
    prevPaidByKey,
    cardPaidByKey: matchOutflowActuals(nowCardItems, nowPool, { earlyDayTolerance: EARLY_DAY_TOLERANCE }),
    prevCardPaidByKey: matchOutflowActuals(prevCardItems, prevPool, { earlyDayTolerance: EARLY_DAY_TOLERANCE }),
  };
}

export interface CashflowSnapshotInput {
  scheduled: HhScheduledPayment[];
  loans: HhLoan[];
  installments: HhInstallment[];
  /** 거래 — 당월분만 있어도, 최근 3개월분이 섞여 있어도 된다(내부에서 월 필터). */
  txns: HhTransaction[];
  methods: HhPaymentMethod[];
  /** 당월 hh_cashflow_override 행들. */
  overrides: HhCashflowOverride[];
  /**
   * 익월 hh_cashflow_override 행들(익월 출금 탭 입력값). (설계 81)
   * 홈·현금흐름 두 화면이 **같이** 넘겨야 예측 익월 숫자가 갈리지 않는다(설계 79).
   */
  nextOverrides?: HhCashflowOverride[];
  /** 최근 3개월 실제 출금(expense·payment·transfer) — 예정 vs 실제 매칭용(설계 65). */
  recentOutflows: ActualOutflow[];
  /**
   * 등록 계좌 id 전부(비활성 포함) — 내부 이체를 매칭 풀에서 빼는 데 쓴다. (설계 131)
   * 안 넘기면 안 거른다. 현황(홈)·현금흐름 **두 화면 다 넘겨야** 같은 숫자가 나온다(설계 79).
   */
  accountIds?: string[];
  /** 현금성 계좌 잔액 합(주식 제외). */
  totalCash: number;
  /** 예측 개월 수(3/6/12). */
  horizon: number;
  /**
   * 변동 지출(생활비) 보정. (설계 173)
   * 예정에는 고정비·대출·할부·카드대금만 들어가 **레저·외식·생필품 같은 변동 지출이 통째로 빠진다**
   * — 그래서 예측이 매달 낙관적이었다(2026-08-14 실측: 6월 +166만 · 7월 +268만).
   * `monthly` 는 완료된 직전 3개월 평균(이상치 제외)이고, 첫 달은 **남은 일수 비례**로만 더한다
   * (월 전체를 더하면 이미 나간 변동 지출을 두 번 뺀다 — 설계 110 과 같은 함정).
   * 안 넘기거나 0이면 **기존 동작과 완전히 같다**(팀장이 화면에서 끌 수 있다).
   */
  variableSpend?: { monthly: number; firstMonth: number };
}

export interface CashflowSnapshot {
  classified: ClassifiedItem[];
  /** 예정(활성) 항목 — reason=null. */
  activeItems: ClassifiedItem[];
  /** 이번 달 쉬는(일시정지) 항목 — reason 있음. */
  releasedItems: ClassifiedItem[];
  /** 영구보류 항목 — is_active=false && permanent_hold=true. 계산엔 안 들어가고 '보류' 탭 영구보류 그룹 표시용. (설계 98) */
  permanentlyHeld: HhScheduledPayment[];
  /** 익월(month+1) 년월 문자열. */
  nextMonth: string;
  /** 익월 출금 전 항목(제외 사유 포함). (설계 81) */
  nextItems: NextOutItem[];
  /** 익월 출금 예정 항목 — reason=null. */
  nextActiveItems: NextOutItem[];
  /** 익월 탭에 보이는 출금 합계 = nextActiveItems 금액 합. */
  nextOutTotal: number;
  /**
   * ③ 예측에 반영되는 익월 출금 합계(inForecast 항목 합).
   * 날짜 미정 항목을 포함하므로 nextOutTotal 보다 클 수 있다 — 설계 65 §F 기준을 그대로 따른 것.
   */
  nextForecastOut: number;
  /**
   * ③ 예측 첫 달(당월)에 반영되는 출금 합계 — 이미 지급된 항목은 뺀 값. (설계 110)
   * 현재 잔액에 이미 반영된 출금을 예측에서 또 빼지 않기 위한 것.
   */
  currentForecastOut: number;
  /** 예측에 실제로 반영된 변동 지출 — 첫 달 몫과 이후 달 월액. (설계 173) */
  variableSpendApplied: { firstMonth: number; monthly: number };
  /** 최근 3개월 실적 매칭(항목 key → 실거래). */
  paidRecently: Map<string, ActualOutflow>;
  /**
   * 당월 실적 매칭(항목 key → 실거래) — classified[].paidAmount 의 원천.
   * 카드 결제분 표시 매칭(설계 166)이 "본 매칭이 쓰고 남은 거래"를 가리는 데 쓴다.
   */
  paidThisMonth: Map<string, ActualOutflow>;
  /** 출금 예정 = 활성 항목 중 미지급분 예상금액 합. */
  pendingOutAll: number;
  /** 출금금액 = 활성 항목 중 지급된 금액 합. */
  paidOutAll: number;
  /** 입금 예정 = 아직 안 들어온 정기수입 합. */
  pendingIn: number;
  /** 이번 달 잔액 = 현금보유 + 입금 예정 − 출금 예정. */
  monthEndCash: number;
  hasScheduledIncome: boolean;
  /** 당월 이미 입금된 정기수입 id(첫 달 예상수입에서 제외됨). */
  receivedInflow: Set<string>;
  /** 여러 달 앞 예측(설계 64·65 정합 필터 적용). */
  projection: MonthProjection[];
}

/**
 * 당월 출금 예정·이번 달 잔액·여러 달 예측을 한 번에 계산한다.
 * 현황(홈)과 현금흐름이 이 함수 하나를 쓰므로 두 화면의 숫자가 항상 같다. (설계 79)
 */
export function cashflowSnapshot(month: string, input: CashflowSnapshotInput): CashflowSnapshot {
  const overrideMap = new Map<string, HhCashflowOverride>();
  for (const o of input.overrides) overrideMap.set(`${o.source_kind}:${o.source_id}`, o);

  // 당월 출금 예정 — 고정비·대출·할부·신용카드 대금. (소비 거래는 섞지 않음)
  const cal = cashflowCalendar(month, {
    scheduled: input.scheduled,
    loans: input.loans,
    installments: input.installments,
    txns: input.txns,
    methods: input.methods,
  });
  // 그 달만 결제수단을 갈아끼우는 판정기(설계 203). 오버라이드가 없으면 아무것도 바꾸지 않는다.
  const methodResolver = makeMethodResolver(input.methods);
  const outItems: OutItem[] = [];
  for (const [day, entries] of cal.dated) {
    for (const e of entries) if (e.direction === "out") outItems.push(buildOutItem(e, day, overrideMap, methodResolver));
  }
  for (const e of cal.undated) if (e.direction === "out") outItems.push(buildOutItem(e, null, overrideMap, methodResolver));
  outItems.sort((a, b) => (a.day ?? 99) - (b.day ?? 99));

  // 예정 vs 실제 매칭(설계 65) — 이번 달·최근 3개월 실출금과 대조. 금액 큰 항목부터(동일금액 충돌 최소화).
  // ★카드로 결제되는 고정비는 매칭에서 제외한다(설계 108 후속, 2026-07-28 팀장 신고).
  //   은행 실출금이 없는 항목인데 매칭에 참여시키면 근사 규칙(상호 부분일치+금액 ±30%)으로 **남의 거래를
  //   훔친다** — 실사례: 통신비-SKT(카드, 111,490)가 KT(토스페이, 95,040)의 실거래를 가로채('KT'⊂'SKT'),
  //   당월출금·익월 예상금액이 95,040으로 둔갑하고 정작 KT 항목이 미출금으로 남았다.
  //   greedy 1거래=1항목 구조라 한 번 훔치면 진짜 주인이 영영 매칭 못 한다.
  // ★내부 이체(등록 계좌 → 등록 계좌)도 매칭 풀에서 뺀다 — 지갑 충전·통장 자리바꿈은 나간 돈이 아닌데
  //   금액만 맞으면 가져가서 엉뚱한 고정비가 '출금됨'으로 켜졌다(설계 131). accountIds 를 안 넘기면
  //   거르지 않는다(옛 호출부 호환) — 넘기는 화면과 안 넘기는 화면이 갈리지 않게 두 화면 다 넘길 것.
  // 신용·할부 카드 결제 지출도 뺀다 — 그날 통장에서 안 빠지는 돈이다(설계 108 과 대칭, 설계 131).
  const cardMethodIds = input.methods.filter((m) => m.kind === "credit" || m.kind === "installment").map((m) => m.id);
  const pool = input.accountIds
    ? outflowsForMatching(input.recentOutflows, input.accountIds, cardMethodIds)
    : input.recentOutflows;
  const monthOutflows = pool.filter((t) => ymOf(t.txn_date) === month);
  const releasedKeys = new Set(outItems.filter((i) => i.released).map((i) => i.key));
  // 매칭 항목의 기본 순서 — 카드 결제분 제외, 금액 큰 것부터(동일금액 충돌 최소화).
  const matchItems = [...outItems]
    .filter((i) => !i.cardCharge)
    .sort((a, b) => b.amount - a.amount)
    // accountId 는 payment 계좌 게이트용(설계 166) — 금액이 다른 카드대금이 남의 명의 항목에 붙는 것을 막는다.
    // ★대출은 계좌를 넘기지 않는다(설계 185 후속). 대출 원장의 `account_id` 는 **현재값 하나**뿐인데
    //   팀장은 은행 주계좌를 바꾼 이력이 있어(신한 2026-04-28 해지 · 하나1 2026-06-27 해지) 과거 달에
    //   현재 계좌를 대면 시대착오가 된다. 설계 185 로 대출이 계좌를 갖게 되자 실제로 2026-04(2,989)·
    //   2026-06(387,740) 상환이 게이트에 끊겨 **낸 돈이 '미출금'으로 뒤집히고** 6월 이번달 잔액이
    //   마이너스가 되며 없던 부족액 경고까지 떴다. 게이트는 남의 거래를 훔치는 걸 막는 장치인데
    //   여기선 진짜 주인을 막았다. 계좌는 **화면 표시·계좌별 집계용**으로만 쓰고 매칭엔 안 쓴다.
    //   (설계 185 이전 동작과 동일 — 그때도 대출은 늘 accountId=null 이라 게이트 면제였다.)
    .map((i) => toOutflowMatchItem(i));

  // ★**당월 매칭에서만** 직접 제외(released)한 항목을 맨 뒤로 민다. 매칭은 greedy 라 앞선 항목이
  //   거래를 먼저 가져가는데, 사용자가 "이번 달엔 안 나간다"고 못 박은 항목이 진짜 주인보다 먼저
  //   집어가면 **주인이 미출금으로 남는다** — 그것도 '제외' 탭에 숨어 있어 눈에 띄지 않는다.
  //   실측 2026-08-09(팀장 신고 "구미아파트 관리비 24만원이 안 잡힌다"):
  //   `학원비-미술학원-한솔`(5일, 8월 금액 오버라이드 140,000→**240,000**, released=true)이
  //   `관리비-구미아파트(부모님)`(7일, 240,000)의 8/7 실거래를 정확금액(score 3)으로 먼저 가져갔다.
  //   금액이 같으면 배열 순서(=예정일 오름차순)가 앞선 쪽이 이기는데 5일이 7일보다 앞이었다.
  //
  //   ⚠️**아예 빼면 안 된다** — released 항목의 당월 실지급액은 익월 기본값(설계 81 §E: 익월 예상 =
  //   당월 출금금액 우선)에 쓰인다. 빼 봤다가 `npm test` 의 '일시정지 자동 재개' 3건이 깨졌다(설계 97).
  //
  //   ⚠️**뒤로 미는 것으로 다 막히지는 않는다**(2026-08-09 배포 전 교차리뷰 지적). 매칭은 2패스라
  //   1패스(정확금액+상호일치, score 4)를 **전체 항목에 대해 먼저** 돈다 — released 가 score 4 면
  //   순서와 무관하게 1패스에서 가져간다. 이건 그대로 둔다: 상호까지 맞는 짝은 그 항목이 진짜
  //   주인일 개연성이 크고, "증거가 강한 짝부터 확정"이 2패스 구조의 취지이기 때문이다(설계 131).
  //   막는 것은 **증거가 약한 동일금액 경쟁**(score 3)이고, 구미아파트가 정확히 그 경우였다.
  const monthMatchItems = [...matchItems].sort((a, b) => Number(releasedKeys.has(a.key)) - Number(releasedKeys.has(b.key)));

  // 당월 '출금금액'에는 날짜 가드를 건다 — 예정일이 아직 한참 남았는데 월초 거래가 붙어
  // '이미 나갔다'로 보이던 문제(설계 131). paidRecently 는 **가드 없이** — 거기서 걸러지면
  // 항목이 '최근 출금 기록 없음'으로 표에서 통째로 사라진다.
  // ★paidRecently 에는 **released 후순위를 주지 마라**(교차리뷰 지적). released 는 '이번 달만'
  //   쉬는 것인데 그 순위를 최근 3개월 전체에 적용하면, 같은 금액의 활성 항목이 released 항목의
  //   **과거 실적**을 가져가 그 항목이 `forecastSourceIds` 에서 빠지고 다음 달 예측에서 사라진다.
  //   released 를 남겨 둔 이유가 최근 실적 보존인데 그 실적을 스스로 훼손하게 된다.
  //   ★paidRecently 는 **항목 등록값(baseCardCharge)** 으로 거른다(설계 203, 교차리뷰 High H2).
  //   이 결과는 forecastSourceIds 를 통해 **익익월 이후 전 구간**의 예측 소속을 정하는데,
  //   그 달만 유효해야 할 결제수단 오버라이드가 여기 섞이면 미래 예측이 통째로 흔들린다.
  //   당월 표(paidThisMonth)는 그 달 얘기라 오버라이드를 반영한 monthMatchItems 를 그대로 쓴다.
  const recentMatchItems = [...outItems]
    .filter((i) => !i.baseCardCharge)
    .sort((a, b) => b.amount - a.amount)
    // ★계좌도 **등록값**으로 넘긴다 — 오버라이드가 적용된 accountId 를 넘기면 설계 188 의 계좌
    //   우선순위가 달라져 과거 실적의 주인이 바뀐다(덱스 교차검토 High).
    .map((i) => toOutflowMatchItem({ ...i, accountId: i.baseAccountId }));
  const paidThisMonth = matchOutflowActuals(monthMatchItems, monthOutflows, { earlyDayTolerance: EARLY_DAY_TOLERANCE });
  const paidRecently = matchOutflowActuals(recentMatchItems, pool);

  // 재분류: 예정(reason=null) / 제외(사유). 날짜 미정·최근 3개월 실적 없음은 제외로.
  // 단 날짜를 직접 지정(day_override)했으면 확정으로 보고 예정 유지.
  const classified: ClassifiedItem[] = outItems.map((i) => {
    const paidAmount = i.paidOverride ?? paidThisMonth.get(i.key)?.amount ?? null;
    const recently = paidRecently.has(i.key);
    let reason: ReleaseReason = null;
    if (i.released) reason = "manual";
    else if (i.day == null) reason = "undated";
    // 카드로 결제되는 고정비는 은행 실출금이 없어 '최근 출금 기록'이 잡히지 않는다 →
    // 이 사유로 빼면 표에서 통째로 사라진다. 카드 결제분은 예정으로 유지한다. (설계 108)
    // ★그 달 결제수단을 사람이 지정했으면(설계 203) 면제한다 — 안 그러면 카드였던 항목을 지갑으로
    //   바꾸는 순간 `!cardCharge` 면제가 풀려 **그 행이 표에서 통째로 사라진다**(교차리뷰 High H1).
    //   게다가 사라진 행이 가는 '보류 > 확인필요' 탭에는 결제방식 열이 없어 되돌릴 수도 없다.
    else if (!recently && !i.dayOverridden && !i.cardCharge && !i.methodOverridden) reason = "no-recent";
    return { ...i, paidAmount, reason };
  });
  const activeItems = classified.filter((i) => i.reason == null);
  const releasedItems = classified.filter((i) => i.reason != null);
  // 영구보류: is_active=false 라 위 calc 산출물엔 애초에 없음 → 원본 scheduled에서 직접 집는다. (설계 98)
  const permanentlyHeld = input.scheduled.filter((s) => !s.is_active && s.permanent_hold);

  // 상단 요약: 출금예정(미지급)/출금금액(지급). 출금금액 비움/0 = 미출금(설계 65 2차).
  // ★카드로 결제되는 고정비는 **통장에서 그날 나가지 않는다** → 현금 유출 합계에서 뺀다.
  //   실제 현금은 카드대금일에 '카드대금' 정기지출로 한 번 나가므로 같이 세면 이중계상이다. (설계 108)
  const cashOutItems = activeItems.filter((i) => !i.cardCharge);
  const pendingOutAll = cashOutItems.filter((i) => !i.paidAmount).reduce((s, i) => s + i.amount, 0);
  const paidOutAll = cashOutItems.filter((i) => i.paidAmount).reduce((s, i) => s + (i.paidAmount ?? 0), 0);

  // ── 익월 출금 (설계 81) ──────────────────────────────────────────
  const nextMonth = shiftMonth(month, 1);
  const nextOverrideMap = new Map<string, HhCashflowOverride>();
  for (const o of input.nextOverrides ?? []) nextOverrideMap.set(`${o.source_kind}:${o.source_id}`, o);
  const classifiedByKey = new Map(classified.map((i) => [i.key, i]));
  const nextCtx = { nextOverrideMap, classifiedByKey, paidRecently, methodResolver };

  // 익월 캘린더 — 고정비·대출·할부. 할부 종료·대출 만기가 반영되므로 '익월에 실제 있는 항목'의 기준이 된다.
  // txns: [] 인 이유 — monthlyCashflow 는 txns 를 안 쓰고, 카드만 txns 를 쓰는데 카드는 아래에서 이월로 만든다.
  const nextCal = cashflowCalendar(nextMonth, {
    scheduled: input.scheduled,
    loans: input.loans,
    installments: input.installments,
    txns: [],
    methods: input.methods,
  });
  const nextItems: NextOutItem[] = [];
  const pushNext = (e: CalendarEntry, day: number | null) => {
    if (e.direction !== "out") return;
    nextItems.push(
      buildNextItem(
        {
          sourceKind: e.sourceKind,
          sourceId: e.sourceId,
          kind: e.kind,
          label: e.label,
          categoryId: e.categoryId,
          naturalDay: day,
          fallbackAmount: e.amount,
          defaultAccountId: e.defaultAccountId,
          paymentMethodId: e.paymentMethodId,
          cardCharge: e.cardCharge,
        },
        nextCtx
      )
    );
  };
  for (const [day, entries] of nextCal.dated) for (const e of entries) pushNext(e, day);
  for (const e of nextCal.undated) pushNext(e, null);

  // 카드대금은 익월 캘린더에 안 나온다(익월 거래가 아직 없어 used<=0 으로 걸러짐) → 당월 항목을 이월. (설계 81 §B)
  for (const c of classified) {
    if (c.sourceKind !== "card") continue;
    nextItems.push(
      buildNextItem(
        {
          sourceKind: c.sourceKind,
          sourceId: c.sourceId,
          kind: c.kind,
          label: c.label,
          categoryId: c.categoryId,
          naturalDay: c.naturalDay,
          fallbackAmount: c.amount,
          defaultAccountId: c.accountId,
          paymentMethodId: c.paymentMethodId,
          cardCharge: c.cardCharge, // 카드대금 자체는 false(그날 실제로 통장에서 나간다)
        },
        nextCtx
      )
    );
  }
  nextItems.sort((a, b) => (a.day ?? 99) - (b.day ?? 99));
  const nextActiveItems = nextItems.filter((i) => i.reason == null);
  // 탭에 보이는 합계(날짜 확정된 예정 항목만). 카드 결제분은 통장에서 안 빠지므로 합계에서 제외(설계 108).
  const nextOutTotal = nextActiveItems.filter((i) => !i.cardCharge).reduce((s, i) => s + i.amount, 0);
  // ③ 예측에 넣을 합계 — 날짜 미정이라도 최근 실적이 있으면 포함(설계 65 §F).
  // 탭 합계와 다를 수 있고, 그건 당월(② 합계 vs ③ 예측)에도 이미 있는 차이다.
  // 이 값을 안 쓰고 nextOutTotal 로 덮으면 익월만 '날짜 미정' 출금이 사라져 월말현금이 낙관적으로 나온다.
  const nextForecastOut = nextItems.filter((i) => i.inForecast && !i.cardCharge).reduce((s, i) => s + i.amount, 0);

  // ③ 예측 첫 달(당월)에 넣을 출금 합계 — **아직 지급되지 않은 것만.** (설계 110)
  // ★왜: 예측은 '현재 잔액'(input.totalCash)에서 출발한다. 이번 달에 이미 나간 고정비는 그 잔액에
  //   이미 반영돼 있는데, 월 전체 출금을 그대로 빼면 같은 돈을 두 번 빼는 셈이라 월말 예상현금이
  //   실제보다 낮게 나오고 '여유선 밑' 경고가 헛울린다. 월말이 가까울수록 오차가 커진다.
  //   수입 쪽은 receivedInflowIds 로 이 대칭을 이미 지키고 있었다(설계 65 수입 대칭) — 지출만 빠져 있었다.
  // 포함 기준은 forecastSourceIds(아래)와 같다: 최근 3개월 실적이 있거나 날짜를 확정한 항목,
  //   직접 제외(released) 아님, 카드 결제분 아님(카드대금이 그 현금 유출을 대표한다 — 설계 108).
  //   '날짜 미정' 은 월 단위 예측에 무관하므로 여기서도 빼지 않는다(설계 65 §F) →
  //   그만큼 pendingOutAll(=이번 달 잔액)보다 클 수 있고, 그 차이는 익월(② vs ③)에도 이미 있는 차이다.
  // 지급 판정은 pendingOutAll 과 같은 규칙(paidAmount 0/비움 = 미출금, 설계 65 2차)을 쓴다.
  const currentForecastOut = classified
    // 그 달 결제수단을 지정한 항목은 paidRecently(=base 기준)에 안 잡힐 수 있다 — 사람이 "이 달은
    // 현금으로 낸다"고 못 박았으므로 day_override 와 같이 취급해 당월 예측에 넣는다. (설계 203)
    .filter((i) => !i.released && !i.cardCharge && !i.paidAmount && (paidRecently.has(i.key) || i.dayOverridden || i.methodOverridden))
    .reduce((s, i) => s + i.amount, 0);

  // 변동 지출(생활비) 보정. (설계 173) 안 넘기면 0 = 기존 동작 그대로.
  // ★첫 달은 **남은 일수 비례분**만 쓴다 — 호출부가 이미 비례 계산해서 넘긴다(firstMonth).
  const vsFirst = Math.max(0, Math.round(input.variableSpend?.firstMonth ?? 0));
  const vsMonthly = Math.max(0, Math.round(input.variableSpend?.monthly ?? 0));

  // 여러 달 예측 정합(설계 65) — 최근 실적 있거나 날짜 확정했고 직접 제외 안 한 OUT 항목만 반영.
  // (날짜 유무는 월 단위 예측에 무관하므로 '날짜 미정' 제외 조건은 적용하지 않는다.)
  const forecastSourceIds = new Set<string>();
  // released 는 '그 달만' 쉬는 것이므로 예측 소속 자체는 유지하고,
  // 아래 pausedByYm 으로 해당 월에서만 뺀다. (설계 97 결함B)
  // 카드 결제분은 예측에서도 뺀다 — 카드대금 정기지출이 그 현금 유출을 대표한다. (설계 108)
  // ★`baseCardCharge`(항목 등록값)로 판정한다 — 그 달만인 결제수단 오버라이드가 m+2 이후 예측을
  //   좌우하면 안 된다(설계 203, 교차리뷰 High H2). paidRecently 도 같은 이유로 base 기준이다.
  for (const i of classified) if ((paidRecently.has(i.key) || i.dayOverridden) && !i.baseCardCharge) forecastSourceIds.add(i.sourceId);

  const hasScheduledIncome = input.scheduled.some((s) => s.is_active && s.direction === "in" && (s.amount ?? 0) > 0);
  // 수입(in)은 전부, 지출(out)은 예측 소스 집합만. 대출·할부도 동일 필터.
  const forecastScheduled = input.scheduled.filter((s) => s.direction === "in" || forecastSourceIds.has(s.id));
  const forecastLoans = input.loans.filter((l) => forecastSourceIds.has(l.id));
  const forecastInstallments = input.installments.filter((i) => forecastSourceIds.has(i.id));
  // 당월 이미 입금된 정기수입은 첫 달 예상수입에서 제외(이중계상 방지, 설계 65 수입 대칭).
  const receivedInflow = receivedInflowIds(month, forecastScheduled, input.txns);
  // 당월 일시정지(released)는 당월 예측에서만 뺀다 — 다음 달은 오버라이드가 없으므로 자동 재개. (설계 97)
  // ⚠️설계 110 이후 이 맵은 사실상 무효다: 첫 달 출금은 아래에서 currentForecastOut 으로 **통째로 대체**되고
  //   (그 안의 `!i.released` 가 실제 제외를 한다), 맵에는 month 키만 있어 익월 이후엔 애초에 걸리는 게 없다.
  //   남겨두는 이유는 projectMonths 의 계약(설계 97)을 호출부에서 계속 명시해 두는 것 + 첫 달 대체값을
  //   쓰지 않는 경로가 생기면 다시 살아나기 때문이다.
  //   ★일시정지 동작을 고칠 일이 있으면 **여기가 아니라 currentForecastOut 의 필터**를 고쳐야 한다.
  const pausedByYm = new Map<string, Set<string>>([
    [month, new Set(classified.filter((i) => i.released).map((i) => i.sourceId))],
  ]);
  // 첫 달은 이미 지급된 출금을 뺀 값으로, 익월은 익월 탭에서 확정한 값(카드값·변동금액 포함)으로 대체한다
  // → ① 이번 달 잔액 ≈ ③ 예측 첫 달 월말현금(설계 110), ② 익월 탭 합계 == ③ 예측 익월 출금(설계 81 §E).
  // 익익월 이후는 현행 유지(카드 제외) — 보스 확정 '익월만 반영'.
  const projection = projectMonths(input.totalCash, month, input.horizon, {
    scheduled: forecastScheduled,
    loans: forecastLoans,
    installments: forecastInstallments,
  }, receivedInflow, new Map([[month, currentForecastOut + vsFirst], [nextMonth, nextForecastOut + vsMonthly]]), pausedByYm, vsMonthly);

  // 이번 달 아직 안 들어온 정기수입 + 월말 예상 잔액(현금보유 + 입금예정 − 출금예정).
  // 종료된(또는 아직 시작 안 한) 정기수입은 빼야 한다 — 안 그러면 끝난 수입이 계속
  // '입금 예정'에 남아 이번 달 잔액이 부풀고, 같은 화면의 예측표(월별 예상수입)와 어긋난다.
  const pendingIn = input.scheduled
    .filter(
      (s) =>
        s.direction === "in" &&
        s.is_active &&
        (s.amount ?? 0) > 0 &&
        scheduledActiveInYm(s, month) &&
        !receivedInflow.has(s.id)
    )
    .reduce((acc, x) => acc + (x.amount ?? 0), 0);
  // ★'이번 달 잔액'과 '예측 첫 달 월말현금'은 같아야 한다(설계 79 정합) — 그래서 **같은 변동지출 몫**을 뺀다.
  const monthEndCash = input.totalCash + pendingIn - pendingOutAll - vsFirst;

  return {
    classified,
    activeItems,
    releasedItems,
    permanentlyHeld,
    nextMonth,
    nextItems,
    nextActiveItems,
    nextOutTotal,
    nextForecastOut,
    currentForecastOut,
    paidRecently,
    paidThisMonth,
    pendingOutAll,
    paidOutAll,
    pendingIn,
    monthEndCash,
    variableSpendApplied: { firstMonth: vsFirst, monthly: vsMonthly },
    hasScheduledIncome,
    receivedInflow,
    projection,
  };
}
