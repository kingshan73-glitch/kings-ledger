/**
 * 계좌별 색 — '출금계좌 / 결제계좌' 칸을 **소유자 단위**로 가른다. (설계 127, 팀장 지시 2026-08-03)
 *
 * ★설계 126(계좌마다 다른 색, 20색 팔레트)은 폐기됐다. 계좌 단위 색은 계좌를 추가·삭제하면
 *   전체 색이 밀리고, 20색을 훑어도 "이게 누구 통장인가"라는 실제 질문에는 답을 못 했다.
 *   팀장이 원한 구분은 **사람**이다: 김하늘 통장인가, 이바다 통장인가, 아니면 카드인가.
 *
 * 배정 규칙
 *   - **김하늘 계좌 = 연한 파랑, 이바다 계좌 = 연한 주황.** 소유자가 같으면 은행이 달라도 같은 색이다.
 *   - 그 밖의 소유자(공용·미상)는 연한 초록 — 두 사람 색과 겹치지 않게만 한다.
 *   - **카드 행은 CARD_TINT(연보라)** — 계좌 색과 항상 구분된다. "통장에서 그날 빠지는 돈"과
 *     "카드대금일에 몰아 나가는 돈"이 색만으로 갈리는 것이 목적이다.
 *   - 소유자 판별: ① 계좌의 person_id → 인물명 (persons 를 넘긴 화면) ② 없으면 계좌명에서 찾는다
 *     — 계좌명이 '국민은행(김하늘)'처럼 소유자를 품는 것이 이 앱의 명명 규칙이라 폴백이 안전하다.
 *   - 배경은 -50 이 아니라 **-100** 이다: -50 은 흰 배경 위에서 색이 거의 안 읽혔다(실측, 설계 126).
 *
 * ★클래스는 **문자열 리터럴 그대로** 둔다. Tailwind v4 는 소스를 훑어 클래스를 뽑으므로
 *   `bg-${c}-100` 처럼 조립하면 CSS 가 생성되지 않아 색이 통째로 안 나온다.
 * ★한 항목 안에서 같은 속성의 유틸을 겹치지 않는다(border/bg/text 각 1개) — 겹치면 뒤에 출력되는
 *   쪽이 이겨 의도한 색이 조용히 죽는다(CLAUDE.md 표·디자인 규칙).
 */

/** 소유자 → 색. 키는 hh_person 의 실제 이름과 계좌명 괄호 표기가 공유하는 문자열이다. */
const OWNER_TINTS: Record<string, string> = {
  김하늘: "border-blue-400 bg-blue-100 text-blue-900 dark:border-blue-700 dark:bg-blue-950/60 dark:text-blue-200",
  이바다: "border-orange-400 bg-orange-100 text-orange-900 dark:border-orange-700 dark:bg-orange-950/60 dark:text-orange-200",
};

/** 그 밖의 소유자(공용·미상) — 두 사람 색과 계열이 겹치지 않는 연한 초록. */
const OWNER_TINT_ETC =
  "border-emerald-400 bg-emerald-100 text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-200";

/**
 * 카드 행 전용(**회색**) — 소유자 색 어느 것과도 다르다. 카드는 "그날 통장에서 안 빠지는" 별종이라
 * 색부터 갈라야 훑을 때 현금 유출 행과 섞이지 않는다. (설계 127)
 *
 * ★2026-08-04 팀장 지시로 연보라 → **회색**. 색이 있는 칸은 "그날 통장에서 실제로 빠지는 돈"이고,
 *   카드는 그날 안 빠지므로 **무채색이 맞다**(연보라는 소유자 색과 같은 무게로 읽혀 눈이 헷갈렸다).
 */
export const CARD_TINT =
  "border-gray-300 bg-gray-100 text-gray-600 dark:border-gray-600 dark:bg-gray-800/60 dark:text-gray-300";

/** 계좌가 안 정해진 칸(‘계좌 선택…’)은 색을 주지 않는다 — 색은 '정해졌다'는 신호다. */
export const ACCOUNT_TINT_NONE = "border-border/60 bg-background";

/**
 * 계좌 id → 소유자 색 클래스 묶음(border/bg/text).
 * persons 를 넘기면 person_id 로 판별하고, 없으면(대출관리처럼 인물을 안 불러오는 화면) 계좌명으로 판별한다.
 * 호출부는 `useMemo` 로 감싸 계좌 목록이 바뀔 때만 다시 만든다.
 */
export function accountTintMap(
  accounts: { id: string; name: string; person_id?: string | null }[],
  persons?: { id: string; name: string }[],
): Map<string, string> {
  const personName = new Map((persons ?? []).map((p) => [p.id, p.name]));
  const owners = Object.keys(OWNER_TINTS);
  const m = new Map<string, string>();
  for (const a of accounts) {
    // 인물이 지정돼 있으면 그것이 답이다 — 제3의 인물 계좌를 이름 문자열로 두 사람 색에 오배정하지 않는다.
    const byPerson = a.person_id ? personName.get(a.person_id) : undefined;
    const owner = byPerson ?? owners.find((o) => a.name.includes(o));
    m.set(a.id, owner ? OWNER_TINTS[owner] ?? OWNER_TINT_ETC : OWNER_TINT_ETC);
  }
  return m;
}
