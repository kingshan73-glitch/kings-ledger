// 비활성 계좌 숨기기 전역 설정 (설계 89)
//
// 엑셀 재적재가 만든 계좌 잔재(하나은행 4개 중 3개 비활성 등)가 선택 드롭다운·잔액표를 어지럽혀
// 팀장 지시로 기본 숨김 처리한다. 단일 사용자용이라 DB 가 아니라 localStorage 에 둔다
// (hh_cash_forecast_horizon·hh_stats_trend_window 와 같은 관례).
//
// ★핵심 원칙: 숨기는 것은 '고를 수 있는 목록'이지 '이미 쓴 것'이 아니다.
// 하나저축은행 대출은 비활성 계좌 '하나은행(김하늘)1' 에 배정돼 있는데, 계좌명까지 숨기면
// 그 행의 출금계좌가 '?' 로 보여 원인 추적이 불가능해진다. 그래서 표기는 항상 살려둔다.
"use client";

import { useCallback, useSyncExternalStore } from "react";

export const LS_HIDE_INACTIVE = "hh_hide_inactive_accounts";

// localStorage 는 리액트 밖의 저장소라 useSyncExternalStore 로 구독한다.
// (useEffect + setState 방식은 react-hooks/set-state-in-effect 에 걸리고, 첫 렌더 깜빡임도 생긴다.)
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  // 다른 탭에서 바꿔도 따라오게.
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** 저장된 값. 미설정이면 기본 숨김(true). */
function getSnapshot(): boolean {
  return localStorage.getItem(LS_HIDE_INACTIVE) !== "0";
}

/** 서버 렌더에서는 기본값. 클라이언트에서 실제 값으로 즉시 맞춰진다. */
function getServerSnapshot(): boolean {
  return true;
}

export function readHideInactive(): boolean {
  if (typeof window === "undefined") return true;
  return getSnapshot();
}

/** [hide, setHide]. setHide 는 localStorage 에 쓰고 같은 화면의 다른 구독자에게도 알린다. */
export function useHideInactiveAccounts(): [boolean, (v: boolean) => void] {
  const hide = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setHide = useCallback((v: boolean) => {
    localStorage.setItem(LS_HIDE_INACTIVE, v ? "1" : "0");
    emit();
  }, []);

  return [hide, setHide];
}

/**
 * 선택목록·필터·잔액표용 계좌 필터.
 *
 * keepIds 에 든 계좌는 비활성이어도 남긴다 — 이미 그 계좌를 참조 중인 행을 수정할 때
 * 선택지가 사라지면 안 되기 때문(CLAUDE.md List→Popup 규칙: "수정 모드는 거르지 않는다").
 */
export function visibleAccounts<T extends { id: string; is_active: boolean }>(
  accounts: T[],
  hide: boolean,
  keepIds?: Iterable<string | null | undefined>
): T[] {
  if (!hide) return accounts;
  const keep = new Set<string>();
  for (const id of keepIds ?? []) if (id) keep.add(id);
  return accounts.filter((a) => a.is_active || keep.has(a.id));
}
