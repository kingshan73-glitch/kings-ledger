/**
 * 토스 이자 빠른 입력 — 순수 로직. (설계 docs/household/172)
 *
 * 배경(2026-08-14 실측): 토스뱅크 '지금 이자 받기'는 팀장님이 앱에서 직접 누르는 동작이라
 * **토스가 푸시를 안 띄운다** — 수집함 480건 전수에 이자 원문이 0건이었다(파서 결함이 아니다).
 * 그래서 이자는 계속 손으로 넣어 왔고, 그 결과 두 가지가 흔들렸다:
 *   ① 같은 이자가 7가지 이름으로 들어갔다(토스이자/통장이자/통장 이자/토스 이자/이자/토스뱅크 이자/토스이자 추가)
 *   ② 2026-07-25 1원이 토스뱅크가 아니라 **다른 은행·다른 명의** 계좌에 붙었다(오입력)
 * 여기서 고정값을 한 곳에 모아 그 흔들림을 원천에서 없앤다. 화면은 금액만 받는다.
 *
 * ★이름·계좌를 바꿔야 하면 QUICK_INTEREST 한 곳만 고친다 — 화면·테스트가 이 상수를 참조한다.
 */

import { CATEGORY_NAME } from "./category-names";

/** 빠른 입력이 항상 쓰는 고정값. */
export const QUICK_INTEREST = {
  /** 상대처(입금처). 이름 변주는 여기서 끊긴다. */
  merchant: "토스이자",
  /**
   * 입금계좌 후보를 좁히는 **은행명**. 명의(사람 이름)는 쓰지 않는다.
   * ★소스에 실명을 넣으면 Codex 교차리뷰가 즉시 중단된다(누적 7회, 2026-08-14 또 반복).
   *   그렇다고 은행명만으로는 부족하다 — 같은 은행 계좌가 명의별로 둘 있다.
   *   그래서 명의 대신 **"이자가 실제로 들어오던 계좌"**(preferredAccountId)로 좁힌다.
   *   실명은 DB 에만 있고 화면에는 DB 값이 그대로 보이므로 사용자 경험은 같다.
   */
  accountBank: "토스뱅크",
  /** 수입 카테고리 이름. */
  categoryName: CATEGORY_NAME.interest,
  /** 며칠 이상 비면 화면에서 알릴지. */
  warnAfterDays: 2,
} as const;

/** 수집함 행에 넣을 값. `hh_transaction_inbox` 의 guessed_* 와 같은 모양. */
export interface QuickInterestForm {
  guessed_type: "income";
  guessed_date: string;
  guessed_merchant: string;
  guessed_amount: number;
  guessed_category_id: string | null;
  guessed_account_id: string | null;
  guessed_payment_method_id: null;
  guessed_from_account_id: null;
  guessed_to_account_id: null;
  guessed_installment_months: null;
  raw_text: null;
}

/**
 * 빠른 입력 한 건을 만든다. 금액 말고는 전부 고정값이다.
 * ★수입에 안 쓰이는 칸(결제수단·이체계좌·할부개월)은 **반드시 null** 이어야 한다 —
 *   차 있으면 확정 검증(validateItem)과 지출 집계가 어긋난다.
 */
export function buildQuickInterestForm(input: {
  amount: number;
  date: string;
  categoryId: string | null;
  accountId: string | null;
}): QuickInterestForm {
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    throw new Error("금액은 1원 이상이어야 합니다.");
  }
  return {
    guessed_type: "income",
    guessed_date: input.date,
    guessed_merchant: QUICK_INTEREST.merchant,
    guessed_amount: input.amount,
    guessed_category_id: input.categoryId,
    guessed_account_id: input.accountId,
    guessed_payment_method_id: null,
    guessed_from_account_id: null,
    guessed_to_account_id: null,
    guessed_installment_months: null,
    raw_text: null,
  };
}

type CategoryLike = { id: string; name: string; kind: string };
type AccountLike = { id: string; name: string; is_active: boolean };

/**
 * 이자 카테고리를 찾고, 입금계좌 **후보와 기본 선택**을 낸다.
 * ★계좌는 여기서 확정하지 않는다 — 최종 선택은 사람이 화면에서 한다(아래 주석 참고).
 * ★못 찾으면 조용히 null 로 저장하지 않고 **무엇이 없는지** 말한다 —
 *   카테고리가 비면 확정이 막히고, 계좌가 비면 잔액에 안 잡히는 수입이 생긴다.
 */
export function resolveQuickInterestRefs(
  categories: CategoryLike[],
  accounts: AccountLike[],
  /** 지금까지 이자가 실제로 들어오던 계좌 id — 기본 선택의 근거로만 쓴다(확정 근거가 아니다). */
  preferredAccountId?: string | null,
): {
  categoryId: string | null;
  accountId: string | null;
  candidates: { id: string; name: string }[];
  missing: string | null;
} {
  // 카테고리: 수입 종류이면서 이름이 정확히 '이자'. '이자세금'(지출) 같은 이웃을 집으면 안 된다.
  const categoryId =
    categories.find((c) => c.kind === "income" && c.name.trim() === QUICK_INTEREST.categoryName)?.id ?? null;

  // 계좌: 활성 + 은행명 포함이 **후보**이고, 그중 무엇을 쓸지는 **사람이 화면에서 고른다.**
  // 여기서 내는 값은 '기본 선택 제안'일 뿐이다.
  //
  // ★자동 추론만으로는 안전하지 않다(교차리뷰 2026-08-14, Codex 2차):
  //   ⓐ 후보가 하나뿐이어도, 원래 쓰던 계좌가 비활성화되면 **같은 은행의 다른 명의 계좌**가
  //      유일 후보가 되어 조용히 선택된다.
  //   ⓑ preferredAccountId 는 '과거에 이자가 들어온 계좌'인데, 그 과거가 **오귀속이면**
  //      틀린 계좌를 계속 물려받는다(실제로 2026-07-25 오귀속 1건이 있다).
  //   그래서 ㉠기본값을 제안하되 ㉡화면이 반드시 보여 주고 바꿀 수 있게 하며
  //   ㉢**근거가 어긋나면 기본값을 비운다**(사람이 고르게 만든다).
  const candidates = accounts.filter((a) => a.is_active && a.name.includes(QUICK_INTEREST.accountBank));
  const preferred = preferredAccountId ? candidates.find((a) => a.id === preferredAccountId) : undefined;
  let accountId: string | null;
  if (preferred) {
    accountId = preferred.id; // 근거와 후보가 맞다 — 이걸 제안한다
  } else if (preferredAccountId) {
    // 이자가 들어오던 계좌를 알긴 아는데 **후보 밖**이다(비활성화·이름 변경·다른 은행).
    // 이때 남은 후보를 자동으로 집으면 ⓐ 시나리오가 된다 → 비워서 사람이 고르게 한다.
    accountId = null;
  } else {
    // 근거가 아예 없다(첫 사용). 후보가 하나뿐일 때만 제안한다.
    accountId = candidates.length === 1 ? candidates[0].id : null;
  }

  const gaps: string[] = [];
  if (!categoryId) gaps.push(`수입 카테고리 '${QUICK_INTEREST.categoryName}'`);
  if (!accountId && candidates.length === 0) gaps.push(`'${QUICK_INTEREST.accountBank}' 계좌`);
  return {
    categoryId,
    accountId,
    candidates: candidates.map((a) => ({ id: a.id, name: a.name })),
    missing: gaps.length ? `${gaps.join(" 과(와) ")} 를 찾을 수 없습니다.` : null,
  };
}

/**
 * 미래 날짜인가. 빠른 입력은 **오늘 이전만** 받는다.
 * ★막지 않으면 오타 한 번(예: 08-24)이 '마지막 이자 기록'을 미래로 만들어
 *   그날까지 미입력 경고가 통째로 잠긴다 — 오입력이 오입력을 숨긴다(교차리뷰 2026-08-14).
 */
export function isFutureDate(date: string, today: string): boolean {
  const a = Date.parse(`${date}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return a > b;
}

type InboxRowLike = {
  guessed_date: string | null;
  guessed_amount: number | null;
  guessed_merchant: string | null;
  guessed_account_id?: string | null;
};

/**
 * 같은 날 같은 금액의 이자가 **같은 계좌에** 이미 있는가 (버튼을 두 번 누른 실수 방지).
 * ★상호에 '이자'가 든 행만 본다 — 같은 날 우연히 금액이 같은 **다른 거래**까지 막으면
 *   진짜 이자를 못 넣게 된다(2026-08-14 실데이터에도 같은 금액의 다른 지출이 있었다).
 * ★계좌도 함께 본다 — 두 명의가 같은 날 같은 금액의 이자를 받을 수 있다(소액이라 흔하다).
 *   계좌를 빼고 막으면 **한쪽 이자를 영영 못 넣는다**(교차리뷰 2026-08-14 2차, Codex).
 */
export function findSameDayAmount(
  items: InboxRowLike[],
  date: string,
  amount: number,
  accountId?: string | null,
): InboxRowLike | null {
  return (
    items.find(
      (it) =>
        it.guessed_date === date &&
        Number(it.guessed_amount) === Number(amount) &&
        (it.guessed_merchant ?? "").includes("이자") &&
        // 계좌를 모르는 옛 행(guessed_account_id 없음)은 계좌 조건을 걸지 않는다 —
        // 근거 없이 통과시키는 쪽보다 막는 쪽이 안전하다.
        (!accountId || !it.guessed_account_id || it.guessed_account_id === accountId),
    ) ?? null
  );
}

/** 화면이 준 계좌가 실제 후보 안에 있는가. 핸들러는 화면 값을 그대로 믿지 않는다. */
export function isAllowedAccount(candidates: { id: string }[], accountId: string): boolean {
  return candidates.some((c) => c.id === accountId);
}

/** 마지막 기록일로부터 며칠 비었나. 기록이 없으면 null, 미래 날짜는 0 으로 눌러 음수를 막는다. */
export function daysSinceLast(lastDate: string | null, today: string): number | null {
  if (!lastDate) return null;
  const a = Date.parse(`${lastDate}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

/** 알릴지 말지. 기록이 아예 없는 상태(null)도 알린다. */
export function shouldWarnMissing(days: number | null): boolean {
  if (days === null) return true;
  return days >= QUICK_INTEREST.warnAfterDays;
}

/** 계좌 하나의 이자 이력 요약. */
export type InterestStat = { accountId: string; accountName: string; lastDate: string | null; count: number };

/**
 * 기본으로 제안할 계좌 — **이자를 가장 많이 받아 온 계좌**.
 *
 * ★'가장 최근 이자 계좌'로 정하면 안 된다(2026-08-14 4차 점검):
 *   다른 계좌에 딱 한 번 넣는 순간 **다음날 기본값이 그쪽으로 넘어간다.**
 *   매일 같은 계좌에 넣는 사람에게 기본값이 흔들리는 건 '손 한 번'이라는 목적을 깬다.
 *   건수는 하루아침에 뒤집히지 않으므로 안정적이다.
 * ★동률이거나 이력이 아예 없으면 **고르지 않는다** — 사람이 고른다.
 */
export function pickDefaultAccount(stats: InterestStat[]): string | null {
  const withHistory = stats.filter((s) => s.count > 0);
  if (withHistory.length === 0) return null;
  const top = withHistory.reduce((a, b) => (b.count > a.count ? b : a));
  const tied = withHistory.filter((s) => s.count === top.count);
  return tied.length === 1 ? top.accountId : null;
}

/**
 * 미입력 알림의 근거 — **이자를 받아 온 계좌들 중 가장 오래 빈 계좌**.
 *
 * ★계좌 전체에서 '최신 1건'만 보면 안 된다(2026-08-14 4차 점검):
 *   A 계좌가 사흘 비었어도 B 계좌에 오늘 넣었으면 **경고가 사라진다.**
 *   빠진 날을 알린다는 목적이 통째로 무력화된다.
 * ★이력이 없는 계좌(count 0)는 대상이 아니다 — 안 쓰는 계좌 때문에 매일 경고가 뜨면 안 된다.
 */
export function worstInterestGap(
  stats: InterestStat[],
  today: string,
): { accountName: string; lastDate: string | null; days: number | null } | null {
  const withHistory = stats.filter((s) => s.count > 0);
  if (withHistory.length === 0) return null;
  let worst = withHistory[0];
  let worstDays = daysSinceLast(worst.lastDate, today);
  for (const s of withHistory.slice(1)) {
    const d = daysSinceLast(s.lastDate, today);
    // null(기록 없음)이 가장 나쁘다 — 건수가 있는데 날짜를 못 읽은 상태이므로 알려야 한다.
    if (worstDays === null) break;
    if (d === null || d > worstDays) {
      worst = s;
      worstDays = d;
    }
  }
  return { accountName: worst.accountName, lastDate: worst.lastDate, days: worstDays };
}

// ── 여러 건 한 번에 넣기 (설계 184) ─────────────────────────────────────

/** 빠른 입력 배치가 항상 쓰는 dedup_hash. 수동 추가(handleAdd)와 같은 포맷 + 계좌(설계 172). */
export function quickInterestDedupHash(input: {
  date: string;
  amount: number;
  accountId: string;
  /** 같은 배치 안에서 같은 금액이 몇 번째인지(1부터). 2 이상이면 `#n` 을 붙여 UNIQUE 를 피한다. */
  ordinal?: number;
}): string {
  // ★ordinal 을 줬으면 1 이상의 정수여야 한다 — 0 을 주면 조용히 1번째와 **같은 해시**가 나와
  //   두 행이 충돌하고, 2.5 는 `#2.5` 라는 엉뚱한 키가 된다(교차리뷰 2026-08-19).
  //   지금 호출부는 planQuickInterestBatch 하나뿐이라 도달 불가지만, 계약을 열어 두지 않는다.
  if (input.ordinal !== undefined && (!Number.isInteger(input.ordinal) || input.ordinal < 1)) {
    throw new Error(`ordinal 은 1 이상의 정수여야 합니다: ${input.ordinal}`);
  }
  const base = `${input.date}|${input.amount}|${QUICK_INTEREST.merchant}|${input.accountId}`;
  return input.ordinal && input.ordinal > 1 ? `${base}#${input.ordinal}` : base;
}

/**
 * 팝업이 준 금액 목록을 **저장 계획**으로 바꾼다 — 순수 함수라 화면·DB 없이 검증한다.
 *
 * - 0·빈 칸은 조용히 뺀다(팝업의 남는 빈 줄). 음수·비수치는 오류다(수식 평가 실패가 아니라 오입력).
 * - 계획 배열의 순서는 입력한 그대로다(화면 정렬·장부 표시 순서까지 보장하진 않는다).
 * - ★한 배치 안의 **같은 금액은 허용**한다 — 토스뱅크는 상품(통장·모으기 등)마다 이자가 따로 들어와
 *   두 상품이 같은 1원을 줄 수 있다. 대신 2번째부터 dedup_hash 에 `#n` 을 붙여 UNIQUE 에 안 걸리게 한다.
 *   버튼 두 번 누름은 배치 **사이**의 문제라 화면·장부 가드(distinctAmounts)가 따로 막는다.
 */
export function planQuickInterestBatch(amounts: number[]): {
  rows: { amount: number; ordinal: number }[];
  /** 화면·장부 중복 가드에 넘길 금액(중복 제거). */
  distinctAmounts: number[];
  total: number;
  error: string | null;
} {
  const rows: { amount: number; ordinal: number }[] = [];
  const seen = new Map<number, number>();
  for (const raw of amounts) {
    if (raw === 0) continue; // 빈 줄. ★`!raw` 로 쓰면 NaN 까지 조용히 빠진다(리뷰 2026-08-19)
    if (!Number.isFinite(raw) || raw < 0 || !Number.isInteger(raw)) {
      return { rows: [], distinctAmounts: [], total: 0, error: "금액은 1원 이상의 정수여야 합니다." };
    }
    const n = (seen.get(raw) ?? 0) + 1;
    seen.set(raw, n);
    rows.push({ amount: raw, ordinal: n });
  }
  if (rows.length === 0) {
    return { rows: [], distinctAmounts: [], total: 0, error: "금액을 한 건 이상 넣어주세요." };
  }
  return {
    rows,
    distinctAmounts: [...seen.keys()],
    total: rows.reduce((s, r) => s + r.amount, 0),
    error: null,
  };
}
