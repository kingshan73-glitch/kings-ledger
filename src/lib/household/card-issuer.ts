// 카드사 별칭 정본(설계 163). sms.ts(서버 파서)와 loan-estimate.ts·loan-preset.ts(클라이언트에서도 씀)가
// 같은 표를 보게 하려고 순수 모듈로 분리했다 — sms.ts 는 node `crypto` 를 import 하므로 클라이언트가 직접 못 끈다(설계 182).
// ★한 사실은 한 파일에만: 별칭을 고칠 땐 여기만.

/** 같은 카드사의 표기 변형(KB국민카드/국민카드/KB카드)을 한 키로 접는 별칭표. 순서 = 긴 별칭 먼저. */
export const CARD_ISSUER_ALIASES: Array<[alias: string, canon: string]> = [
  ["KB국민", "국민"], ["KB", "국민"], ["국민", "국민"],
  ["NH농협", "농협"], ["NH", "농협"], ["농협", "농협"],
  ["IBK기업", "기업"], ["기업", "기업"],
  // ★BC(비씨)는 넣지 않는다(교차리뷰 R2) — BC 는 회원은행 카드의 우산 브랜드라, 문자 기관명이
  //   'BC카드'로 오면 등록명('우리카드…' 등)과 영원히 불일치해 학습 폴백까지 차단된다(체계적 회귀).
  //   BC 는 카드사 단서로 취급하지 않아 기존 학습 동작을 보존한다.
  ["신한", "신한"], ["삼성", "삼성"], ["현대", "현대"], ["롯데", "롯데"], ["우리", "우리"], ["하나", "하나"],
  ["카카오", "카카오"], ["토스", "토스"], ["씨티", "씨티"], ["케이", "케이"], ["수협", "수협"],
  ["새마을", "새마을"], ["우체국", "우체국"],
];

/**
 * 카드사 정규화 키. (설계 163)
 * **'카드사 별칭 + 카드' 로 시작하는 문자열만** 카드사로 본다 — 은행 출금 통지의 기관명(국민은행 등)이나
 * 선불 지갑(부천페이)을 카드사와 동일시하지 않기 위해서다(넓은 부분일치 금지 — 모호하면 null).
 * 문자 기관명("KB국민카드")과 결제수단 등록명("국민카드(가족1) 체크카드") 양쪽에 써서
 * 두 쪽이 같은 카드사인지 비교한다.
 */
export function cardIssuerKey(name: string | null | undefined): string | null {
  if (!name) return null;
  const t = name.replace(/\s/g, "");
  for (const [alias, canon] of CARD_ISSUER_ALIASES) {
    if (t.startsWith(alias) && t.slice(alias.length).startsWith("카드")) return canon;
  }
  return null;
}

/** 정규화 키 → 대출명·표시에 쓰는 정본 표기('국민' → '국민카드'). 카드사가 아니면 null. */
export function cardIssuerLabel(name: string | null | undefined): string | null {
  const key = cardIssuerKey(name);
  return key ? `${key}카드` : null;
}
