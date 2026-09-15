// 카드 묶음(카드사·명의) — 결제수단을 병합하지 않고 화면에서만 합쳐 보기 위한 공용 규칙. (설계 86)
//
// 왜 병합이 아니라 묶음인가: 문자 수집이 카드를 찾는 유일한 열쇠가 카드번호 끝4자리(card_no)인데
// 결제수단 1건에 card_no 는 하나만 들어간다. 국민카드(이바다)=KB ALL(9013)+The Easy(9012) 처럼
// 한 묶음에 번호가 여럿이라 실제로 합치면 한 장은 자동분류가 끊긴다. (설계 26·86)

import type { HhPaymentMethod, HhPaymentMethodKind } from "./types";

/** 묶음 대상 = 신용성 결제수단만. 체크(즉시출금·설계 77)·현금·선불(부천페이·설계 84)은 성격이 달라 개별 유지. */
export function isGroupableKind(kind: HhPaymentMethodKind | null | undefined): boolean {
  return kind === "credit" || kind === "installment";
}

/**
 * 결제수단 이름에서 묶음 키(`카드사(명의)`)를 뽑는다. 첫 닫는 괄호까지.
 *   "삼성카드(이바다) 트레이더스" → "삼성카드(이바다)"
 *   "삼성카드(이바다)"           → "삼성카드(이바다)"   (엑셀 적재분 통합카드)
 *   "현금"                      → null                (괄호 없음 = 묶음 아님)
 */
export function cardGroupOf(name: string | null | undefined): string | null {
  if (!name) return null;
  const m = /^(.+?\([^)]*\))/.exec(name.trim());
  return m ? m[1] : null;
}

/** 결제수단의 묶음 키. 묶음 대상이 아니면 null. */
export function groupKeyOfMethod(m: Pick<HhPaymentMethod, "name" | "kind">): string | null {
  return isGroupableKind(m.kind) ? cardGroupOf(m.name) : null;
}

export interface CardGroup {
  /** 묶음 키 = 표시 이름. 예: "삼성카드(이바다)" */
  key: string;
  /** 이 묶음에 속한 결제수단 id 들(비활성 통합카드 포함 — 과거 지출이 거기 있다). */
  methodIds: string[];
  /** 전부 비활성이면 true(묶음 자체를 옅게 표시할 때 씀). */
  allInactive: boolean;
}

/**
 * 결제수단 목록 → 카드 묶음 목록. 멤버가 1건뿐인 묶음도 포함한다
 * (묶어도 안 묶어도 같지만, 드롭다운·합계에서 일관되게 '카드사(명의)' 축으로 보이는 게 낫다).
 */
export function buildCardGroups(methods: Pick<HhPaymentMethod, "id" | "name" | "kind" | "is_active">[]): CardGroup[] {
  const map = new Map<string, CardGroup>();
  for (const m of methods) {
    const key = groupKeyOfMethod(m);
    if (!key) continue;
    const g = map.get(key) ?? { key, methodIds: [], allInactive: true };
    g.methodIds.push(m.id);
    if (m.is_active) g.allInactive = false;
    map.set(key, g);
  }
  return [...map.values()].sort((a, b) => a.key.localeCompare(b.key, "ko"));
}

/** 결제수단 id → 묶음 키 조회표. 묶음 대상이 아닌 결제수단은 담기지 않는다. */
export function groupKeyByMethodId(methods: Pick<HhPaymentMethod, "id" | "name" | "kind">[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of methods) {
    const key = groupKeyOfMethod(m);
    if (key) map.set(m.id, key);
  }
  return map;
}

/**
 * 결제수단 조회기 — **`linkedAccountOf`·`isCardCharge` 의 유일한 정의.** (설계 203)
 *
 * 원래 `calc.ts` 의 `buildCalendar` 안에만 있었는데, 설계 203 이 그 달만 결제수단을 갈아끼우면서
 * 스냅샷(`buildOutItem`)도 같은 판정을 해야 했다. 사본을 두면 조용히 어긋나므로 여기로 올린다.
 */
export interface MethodResolver {
  /** 즉시출금 수단(체크·현금성 지갑)의 출금계좌. 신용은 카드대금일에 빠지므로 여기서 계좌를 주지 않는다. */
  linkedAccountOf(methodId: string | null | undefined): string | null;
  /** 신용카드 결제분인가 — 그날 현금이 안 빠지고 카드대금일에 나간다. (설계 108) */
  isCardCharge(methodId: string | null | undefined): boolean;
  /** 즉시출금(체크·현금성)인가 — 연결계좌가 곧 출금계좌다. */
  isImmediate(methodId: string | null | undefined): boolean;
}

export function makeMethodResolver(
  methods: Pick<HhPaymentMethod, "id" | "name" | "kind" | "is_active" | "linked_account_id">[]
): MethodResolver {
  const byId = new Map(methods.map((m) => [m.id, m]));
  // 과거 통합카드가 할부에 연결돼 있고, 현재 활성 세부카드에만 결제계좌가 있는 경우가 있다.
  // 같은 카드 묶음의 활성 결제수단 계좌를 통합카드의 기본 출금계좌로도 사용한다.
  const groupedAccount = new Map<string, string>();
  for (const method of [...methods].sort((a, b) => Number(b.is_active) - Number(a.is_active))) {
    const group = groupKeyOfMethod(method);
    if (group && method.linked_account_id && !groupedAccount.has(group)) {
      groupedAccount.set(group, method.linked_account_id);
    }
  }
  const linkedAccountOf = (methodId: string | null | undefined): string | null => {
    if (!methodId) return null;
    const method = byId.get(methodId);
    if (!method) return null;
    const group = groupKeyOfMethod(method);
    return method.linked_account_id ?? (group ? groupedAccount.get(group) ?? null : null);
  };
  return {
    linkedAccountOf,
    isCardCharge: (methodId) => (methodId ? byId.get(methodId)?.kind === "credit" : false),
    isImmediate: (methodId) => {
      const kind = methodId ? byId.get(methodId)?.kind : null;
      return kind === "check" || kind === "cash";
    },
  };
}
