// 수입 원장 페이지 통계 카드의 '번 돈 / 빌린 돈' 분리 (설계 190 §9 ③).
// 요약 카드①(monthFlowTotals)이 수입 카테고리 '대출'(대출실행, 설계 189·192)을 빼는 것과 같은 잣대를 수입 페이지에도 준다.
// ★페이지 안에 인라인으로 두면 테스트가 못 잡는다(배포 전 교차리뷰) — 판정·합계·월평균까지 여기서 계산하고 페이지는 그리기만 한다.

export function splitIncomeByLoan<T extends { category_id: string | null }>(
  rows: readonly T[],
  loanIncomeCatId: string | null
): { earned: T[]; borrowed: T[] } {
  if (!loanIncomeCatId) return { earned: [...rows], borrowed: [] };

  const earned: T[] = [];
  const borrowed: T[] = [];
  for (const row of rows) {
    if (row.category_id === loanIncomeCatId) borrowed.push(row);
    else earned.push(row);
  }
  return { earned, borrowed };
}

export interface IncomeStats {
  /** 기간에 대출실행 행이 하나라도 있는가 — 카드 3장으로 갈리는 조건. ★합계>0 이 아니라 **행 존재**로 판정한다(0원 행이 '번 돈'에 섞이지 않게). */
  hasBorrowed: boolean;
  /** 첫 카드 값. 대출 행이 있으면 대출 제외 합계, 없으면 전체 합계(= 종전 "기간 수입 합계"). */
  statIncomeTotal: number;
  /** 대출실행(빌린 돈) 합계. */
  borrowedTotal: number;
  /** 월평균 = statIncomeTotal ÷ 걸친 월 수. 대출 행이 있으면 대출 제외 기준이다(라벨도 그렇게 붙인다). */
  monthlyAvg: number;
}

export function incomeStats<T extends { category_id: string | null; amount: number }>(
  rows: readonly T[],
  loanIncomeCatId: string | null,
  monthsInRange: number
): IncomeStats {
  const { earned, borrowed } = splitIncomeByLoan(rows, loanIncomeCatId);
  const sum = (xs: readonly T[]) => xs.reduce((s, r) => s + r.amount, 0);
  const hasBorrowed = borrowed.length > 0;
  const statIncomeTotal = hasBorrowed ? sum(earned) : sum(rows);
  const months = Math.max(1, monthsInRange);
  return { hasBorrowed, statIncomeTotal, borrowedTotal: sum(borrowed), monthlyAvg: Math.round(statIncomeTotal / months) };
}
