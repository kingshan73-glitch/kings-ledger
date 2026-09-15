// 가계부 공통 월(YYYY-MM) 헬퍼. 각 화면에 흩어져 있던 동일 함수를 한 곳으로 모은다.

/** 주어진 날짜의 'YYYY-MM' 키. 기본값은 오늘. */
export function thisMonthKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** 'YYYY-MM'에서 delta개월 이동한 'YYYY-MM'. */
export function shiftMonth(ym: string, delta: number) {
  const [y, m] = ym.split("-").map(Number);
  return thisMonthKey(new Date(y, m - 1 + delta, 1));
}

/** 'YYYY-MM'의 조회 구간 [start, end) — end는 다음 달 1일(미만 비교용). */
export function monthRange(ym: string) {
  const [y, m] = ym.split("-").map(Number);
  return { start: `${ym}-01`, end: `${thisMonthKey(new Date(y, m, 1))}-01` };
}

// ── 기간(날짜 범위) 검색용 헬퍼 ─────────────────────────────────────────
// start/end 모두 inclusive 'YYYY-MM-DD'. 쿼리는 .gte("txn_date",start).lte("txn_date",end).

/** 로컬 기준 'YYYY-MM-DD'. */
function ymd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * 'YYYY-MM-DD'의 다음 날.
 * 이 파일의 기간 헬퍼는 inclusive end 인데 fetchTxnsPaged 는 반열림 [from, end) 이라,
 * 그 경계를 넘길 때 쓴다. 호출부마다 날짜 산술을 복붙하면 말일·연말에서 어긋난다.
 */
export function nextDay(date: string) {
  const [y, m, d] = date.split("-").map(Number);
  return ymd(new Date(y, m - 1, d + 1)); // Date 가 월·연 넘김을 알아서 처리
}

/** 'YYYY-MM'의 1일 ~ 말일(inclusive). */
export function rangeOfMonth(ym: string) {
  const [y, m] = ym.split("-").map(Number);
  return { start: `${ym}-01`, end: ymd(new Date(y, m, 0)) }; // new Date(y, m, 0) = 그 달 말일
}

/** 연도의 1/1 ~ 12/31(inclusive). */
export function rangeOfYear(year: number) {
  return { start: `${year}-01-01`, end: `${year}-12-31` };
}

export type RangePreset = "thisYear" | "thisMonth" | "lastMonth" | "last3Months";

/** 빠른 기간 프리셋 → inclusive {start,end}. */
export function presetRange(preset: RangePreset) {
  const now = new Date();
  if (preset === "thisYear") return rangeOfYear(now.getFullYear());
  if (preset === "lastMonth") return rangeOfMonth(shiftMonth(thisMonthKey(now), -1));
  if (preset === "last3Months") return { start: `${shiftMonth(thisMonthKey(now), -2)}-01`, end: ymd(now) }; // 최근 3개월(이번 달 포함) 1일~오늘
  return rangeOfMonth(thisMonthKey(now)); // thisMonth
}
