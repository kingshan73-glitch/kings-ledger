import type { HhLoanTerms } from "./types";

const REPAYMENT_LABEL = {
  annuity: "원리금균등",
  equal_principal: "원금균등",
  interest_only: "만기일시",
} as const;

/**
 * 수집함 카드론 조건을 **짧은 조각 여러 개**로 돌려준다(표 셀에서는 조각마다 한 요소로 쌓는다 — 한 텍스트 노드가
 * 두 줄로 꺾이면 `test:table-render` H 위반이지만, 요소를 쌓은 여러 줄은 허용된다. 설계 122·125).
 *   [0] 이자율·기간·상환방식  [1] 만기  [2] 총원리금  — 있는 것만.
 */
export function formatLoanTermsParts(terms: HhLoanTerms): string[] {
  const head: string[] = [];
  if (terms.rate != null) head.push(`연 ${terms.rate.toFixed(2)}%`);
  if (terms.term_months != null) head.push(`${terms.term_months}개월`);
  if (terms.repayment_type != null) head.push(REPAYMENT_LABEL[terms.repayment_type]);
  const parts: string[] = [];
  if (head.length) parts.push(head.join(" · "));
  if (terms.maturity_date) parts.push(`만기 ${terms.maturity_date}`);
  if (terms.total_repayment != null) parts.push(`총 ${terms.total_repayment.toLocaleString("ko-KR")}원`);
  return parts;
}

/** 한 줄 표기(모바일 카드 등 표 밖). 조각을 ` · ` 로 잇는다. */
export function formatLoanTermsLine(terms: HhLoanTerms): string {
  return formatLoanTermsParts(terms).join(" · ");
}
