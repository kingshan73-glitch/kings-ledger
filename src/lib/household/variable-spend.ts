/**
 * 변동 지출(생활비) 추정 — 예측이 매달 낙관적이던 것을 메운다. (설계 docs/household/173)
 *
 * 배경(2026-08-14 실측): 월말 예상 현금은 `현재잔액 + 예상수입 − 미지급 예정`인데, '예정'에 드는 것은
 * 고정비·대출·할부·카드대금뿐이다. 레저·외식·생필품 같은 **변동 지출이 통째로 빠져** 있어
 * 실제보다 매달 170~270만원 적게 잡혔다(6월 +166만 · 7월 +268만).
 *
 * ★가르는 기준은 **정기지출이 실제로 쓰는 카테고리 집합**이다(이름 문자열이 아니라 등록된 category_id).
 *   왜 이 방식인지, 처음 시도가 왜 실패했는지는 variableSpendOfMonth 주석에 적어 뒀다.
 */

/** 한 달치 표본 — 그 달 변동 지출 합. */
export type VariableSpendSample = { ym: string; amount: number };

/**
 * 그 달 변동 지출 = **정기지출이 쓰지 않는 카테고리의 통장 지출** 합.
 *
 * ★처음엔 `실제 유출 − 그 달 정기 예정`으로 잡으려 했는데 **못 쓴다**(2026-08-14 실화면에서 발각):
 *   정기지출·대출은 "현재" 상태만 저장돼 있어 **과거 달의 예정을 재현할 수 없다**
 *   (5·6월 스냅샷의 예정 항목이 5건뿐이었다 — 이번 달은 61건). 그래서 차액이 실제 유출 전액이 되어
 *   월 1,538만이라는 엉뚱한 값이 나왔다.
 * ★대신 **카테고리**로 가른다. 한계는 분명하다 — 정기지출이 쓰는 카테고리(교육비·용돈·생필품 등)의
 *   **비정기 지출까지 함께 빠져 과소 추정**된다. 그래도 0원(지금)보다 훨씬 낫고, 팀장이 값을 직접
 *   지정할 수 있게 열어 둔다.
 * ★`payment`(카드대금·대출상환)·`transfer` 는 세지 않는다 — 정기성이고, 카드대금은 이미 예정에 있다.
 */
export function variableSpendOfMonth(
  txns: { txn_date: string; type: string; amount: number; category_id: string | null }[],
  ym: string,
  fixedCategoryIds: Set<string>,
): number {
  return txns
    .filter((t) => t.type === "expense" && t.txn_date.slice(0, 7) === ym && !(t.category_id && fixedCategoryIds.has(t.category_id)))
    .reduce((s, t) => s + Number(t.amount), 0);
}

/** 정기지출(나가는 쪽)이 쓰는 카테고리 집합 — 변동 지출에서 뺄 기준. */
export function fixedCategoryIdsOf(scheduled: { direction?: string | null; category_id?: string | null }[]): Set<string> {
  return new Set(
    scheduled.filter((s) => s.direction !== "in").map((s) => s.category_id).filter((v): v is string => !!v),
  );
}

export type VariableSpendEstimate = {
  /** 월평균(이상치 제외 후). 표본이 없으면 0. */
  monthly: number;
  /** 실제로 평균에 든 달. */
  used: { ym: string; amount: number }[];
  /** 일회성 거액으로 판단해 뺀 달 — 화면에 이유를 밝힌다. */
  excluded: { ym: string; amount: number }[];
};

/**
 * 표본에서 월평균을 낸다.
 *
 * ★**중앙값의 3배를 넘는 달은 뺀다** — 카드론 실행·철회 같은 일회성 거액이 한 번 섞이면
 *   평균이 통째로 망가진다(2026-08-11 철회 1,506만이 실제로 있었다). 뺐다는 사실은 숨기지 않고
 *   화면에 적는다 — 조용히 빼면 "왜 이 금액이지?"를 아무도 설명할 수 없다.
 * ★표본이 2개 이하면 중앙값 판정이 불안정하므로 **제외하지 않는다**(그때는 전부 쓴다).
 */
export function variableSpendAverage(samples: VariableSpendSample[]): VariableSpendEstimate {
  const rows = samples.map((s) => ({ ym: s.ym, amount: Math.max(0, Math.round(s.amount)) }));
  if (rows.length === 0) return { monthly: 0, used: [], excluded: [] };
  if (rows.length <= 2) {
    return { monthly: Math.round(rows.reduce((a, b) => a + b.amount, 0) / rows.length), used: rows, excluded: [] };
  }
  const sorted = [...rows].map((r) => r.amount).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  const cap = median * 3;
  const used = rows.filter((r) => r.amount <= cap);
  const excluded = rows.filter((r) => r.amount > cap);
  // 전부 빠지는 일은 없지만(중앙값 자신은 항상 cap 이하), 방어적으로 막아 둔다.
  if (used.length === 0) return { monthly: Math.round(rows.reduce((a, b) => a + b.amount, 0) / rows.length), used: rows, excluded: [] };
  return { monthly: Math.round(used.reduce((a, b) => a + b.amount, 0) / used.length), used, excluded };
}

/**
 * 이번 달에 더할 몫 — **남은 일수 비례**.
 * ★월 전체를 더하면 이미 나간 변동 지출을 두 번 빼게 된다. 설계 110 에서 고정비로 똑같은 함정을
 *   밟았고(월말 예상현금이 −208만으로 잘못 나와 '현금 부족' 경고가 매달 헛울렸다) 여기서 반복하지 않는다.
 * ★오늘이 말일이면 0에 가깝고, 1일이면 전액이다.
 */
export function firstMonthVariableSpend(monthly: number, todayDay: number, daysInMonth: number): number {
  if (monthly <= 0) return 0;
  if (!Number.isFinite(todayDay) || !Number.isFinite(daysInMonth) || daysInMonth <= 0) return 0;
  const remaining = Math.max(0, Math.min(daysInMonth, daysInMonth - todayDay + 1));
  return Math.round((monthly * remaining) / daysInMonth);
}

/**
 * 화면이 스냅샷에 넘길 값을 한 번에 만든다 — **현황(홈)과 현금흐름이 갈리지 않도록 여기 한 곳에서.**
 * (설계 79 정합: 두 화면이 같은 함수를 쓴다. 한쪽만 고치면 같은 달 숫자가 달라진다.)
 *
 * @param samples 완료된 직전 달들의 {ym, amount}
 * @param currentYm 지금 보고 있는 달
 * @param todayDay 오늘 일(1~31). 이번 달이 아니면 1을 넘겨 전액을 쓴다.
 * @param enabled 팀장이 화면에서 끌 수 있다. 끄면 0 = 기존 동작과 완전히 같다.
 * @param overrideMonthly 팀장이 직접 조정한 월액(있으면 평균 대신 이 값).
 */
export function buildVariableSpendInput(
  samples: VariableSpendSample[],
  currentYm: string,
  todayDay: number,
  enabled: boolean,
  overrideMonthly?: number | null,
): { estimate: VariableSpendEstimate; input: { monthly: number; firstMonth: number } } {
  const estimate = variableSpendAverage(samples);
  if (!enabled) return { estimate, input: { monthly: 0, firstMonth: 0 } };
  const monthly = overrideMonthly != null && overrideMonthly >= 0 ? Math.round(overrideMonthly) : estimate.monthly;
  const firstMonth = firstMonthVariableSpend(monthly, todayDay, daysInYm(currentYm));
  return { estimate, input: { monthly, firstMonth } };
}

/** 그 달의 일수. */
export function daysInYm(ym: string): number {
  const [y, m] = ym.split("-").map(Number);
  if (!y || !m) return 30;
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
