// 재무 건강 진단 (설계 157) — '시스템개선 > 재무관리' 탭이 쓰는 순수 계산 모듈.
//
// ★손으로 적은 조언을 넣지 않는다. 모든 항목은 **그 달 데이터에서 다시 뽑는다** —
//   금리·잔액·지출이 바뀌면 순위와 금액도 같이 바뀌어야 다음 달에도 쓸모가 있다.
// ★단정하지 않는다. 대환 가능 여부·중도상환 수수료처럼 데이터로 알 수 없는 것은
//   금액만 보여주고 "확인 필요"로 남긴다.
import type { HhLoan } from "./types";
import { isCardLoan } from "./category-names";

/** 고금리로 보는 하한(연 %). 이 위쪽을 '먼저 갚을 후보'로 모은다. */
export const HIGH_RATE = 12;

/**
 * 대환 목표 금리(연 %).
 * ★보유 대출의 **최저 금리를 목표선으로 쓰면 안 된다** — 디딤돌·분양자금 같은 정책자금이 1.5% 라
 *   "연 1,134만 절약" 같은 갈 수 없는 숫자가 1순위로 올라온다(2026-08-09 실측, 그래서 고쳤다).
 *   시중은행 신용대출로 옮기는 정도를 가정한 값이고, 실제 가능 여부는 사람이 확인해야 한다.
 */
export const REFINANCE_TARGET_RATE = 6;

export interface LoanRow {
  id: string;
  name: string;
  rate: number | null;
  balance: number;
  /** 연 이자 = 잔액 × 금리. 금리가 비어 있으면 0으로 두되 rateMissing 으로 표시한다. */
  yearlyInterest: number;
  rateMissing: boolean;
}

export interface SpendRow {
  category: string;
  total: number;
  monthly: number;
}

export type ActionKind = "high-rate" | "card-loan" | "refinance" | "variable-cost" | "cash-runway";

export interface FinanceAction {
  kind: ActionKind;
  title: string;
  /** 한 줄 근거 — 반드시 금액이 들어간다. */
  detail: string;
  /** 이 항목을 실행했을 때 아낄 수 있는 **연간** 금액. 비교·정렬의 기준. */
  yearlySaving: number;
  /** 데이터로 단정할 수 없어 사람이 확인해야 하는 항목 */
  needsCheck?: boolean;
}

export interface FinanceHealth {
  monthlyIncome: number;
  cash: number;
  loanBalance: number;
  /** ★'현재 잔액이 1년간 그대로일 때'의 연환산 이자다. 원금이 줄면 실제론 이보다 적다. */
  yearlyInterest: number;
  monthlyInterest: number;
  /** 금리를 안 적어 이자 계산에서 빠진 대출 수 — 0이 아니면 위 이자는 **과소계산**이다. */
  rateMissingCount: number;
  /** 월 이자 ÷ 월 정기수입. 수입이 0이면 null. */
  interestRatio: number | null;
  loans: LoanRow[];
  highRate: { rows: LoanRow[]; balance: number; yearlyInterest: number };
  cardLoan: { rows: LoanRow[]; balance: number; yearlyInterest: number };
  /** 보유 대출 중 가장 낮은 금리 — 대환 목표선의 근거로 쓴다. */
  lowestRate: number | null;
  topSpend: SpendRow[];
  /** 현금이 바닥나기까지 남은 개월(월 순감소 기준). 늘고 있으면 null. */
  runwayMonths: number | null;
  monthlyNet: number;
  actions: FinanceAction[];
}

export interface FinanceHealthInput {
  loans: HhLoan[];
  /** 활성 정기수입 금액 합 */
  monthlyIncome: number;
  /** 현금성 자산 합(증권 제외) */
  cash: number;
  /** 최근 N개월 카테고리별 지출 합계와 개월 수 */
  spendByCategory: { category: string; total: number }[];
  spendMonths: number;
  /**
   * 최근 N개월의 **실제** 월 순증감(수입 − 현금유출). 현금 소진 시점 계산에 쓴다.
   * ★현금유출은 `payment` 전액 + `expense` 중 **신용·할부 카드가 아닌 것**만 더해야 한다 —
   *   개별 카드승인(expense)과 월 카드대금(payment)을 둘 다 더하면 이중계상이다(설계 70·108).
   */
  monthlyNets: number[];
}

const won = (n: number) => Math.round(n).toLocaleString("ko-KR") + "원";

export function financeHealth(input: FinanceHealthInput): FinanceHealth {
  const live = input.loans.filter((l) => l.status === "active" && Number(l.current_balance) > 0);
  const loans: LoanRow[] = live
    .map((l) => {
      const rate = l.interest_rate == null ? null : Number(l.interest_rate);
      const balance = Number(l.current_balance);
      return {
        id: l.id,
        name: l.name,
        rate,
        balance,
        yearlyInterest: rate == null ? 0 : (balance * rate) / 100,
        rateMissing: rate == null,
      };
    })
    .sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1));

  const loanBalance = loans.reduce((s, l) => s + l.balance, 0);
  const yearlyInterest = loans.reduce((s, l) => s + l.yearlyInterest, 0);
  const rateMissingCount = loans.filter((l) => l.rateMissing).length;
  const monthlyInterest = yearlyInterest / 12;

  const pick = (rows: LoanRow[]) => ({
    rows,
    balance: rows.reduce((s, l) => s + l.balance, 0),
    yearlyInterest: rows.reduce((s, l) => s + l.yearlyInterest, 0),
  });
  const highRate = pick(loans.filter((l) => (l.rate ?? 0) >= HIGH_RATE));
  // 카드론은 이름으로 가른다 — 별도 플래그 컬럼이 없다. 임포터가 `<카드사>-<명의>-카드론(YY.MM)` 으로 만든다.
  const cardLoan = pick(loans.filter(isCardLoan));
  const rated = loans.filter((l) => l.rate != null);
  const lowestRate = rated.length ? Math.min(...rated.map((l) => l.rate as number)) : null;

  const months = Math.max(1, input.spendMonths);
  const topSpend: SpendRow[] = [...input.spendByCategory]
    .sort((a, b) => b.total - a.total)
    .slice(0, 3)
    .map((r) => ({ category: r.category, total: r.total, monthly: r.total / months }));

  // 현금 소진 — 최근 몇 달 순증감의 평균이 마이너스일 때만 의미가 있다.
  const nets = input.monthlyNets;
  const monthlyNet = nets.length ? nets.reduce((s, n) => s + n, 0) / nets.length : 0;
  const runwayMonths = monthlyNet < 0 && input.cash > 0 ? input.cash / -monthlyNet : null;

  const actions: FinanceAction[] = [];

  // ① 고금리부터 갚기 — 가장 비싼 두 건을 정리했을 때의 절약액으로 크기를 잰다.
  if (highRate.rows.length) {
    const top2 = highRate.rows.slice(0, 2);
    const saving = top2.reduce((s, l) => s + l.yearlyInterest, 0);
    actions.push({
      kind: "high-rate",
      title: `연 ${HIGH_RATE}% 이상 대출 ${highRate.rows.length}건을 먼저 갚기`,
      detail:
        `잔액 ${won(highRate.balance)} · 연이자 ${won(highRate.yearlyInterest)}(월 ${won(highRate.yearlyInterest / 12)}). ` +
        `가장 비싼 ${top2.length}건(${top2.map((l) => `${l.name} ${l.rate}%`).join(" · ")})만 정리해도 연 ${won(saving)} 아낀다.`,
      yearlySaving: saving,
    });
  }

  // ② 카드론 — 잔액 비중 대비 이자 비중이 얼마나 불리한지 보여준다.
  if (cardLoan.rows.length && loanBalance > 0 && yearlyInterest > 0) {
    const balShare = (cardLoan.balance / loanBalance) * 100;
    const intShare = (cardLoan.yearlyInterest / yearlyInterest) * 100;
    actions.push({
      kind: "card-loan",
      title: `카드론 ${cardLoan.rows.length}건 정리`,
      detail:
        `잔액 ${won(cardLoan.balance)} · 연이자 ${won(cardLoan.yearlyInterest)}(월 ${won(cardLoan.yearlyInterest / 12)}). ` +
        `전체 대출의 ${balShare.toFixed(0)}% 인데 이자의 ${intShare.toFixed(0)}% 를 낸다.`,
      yearlySaving: cardLoan.yearlyInterest,
    });
  }

  // ③ 대환 — 목표선은 **상수**다(보유 최저금리를 쓰면 정책자금 1.5% 가 끼어 허황된 숫자가 된다).
  if (highRate.rows.length) {
    const after = (highRate.balance * REFINANCE_TARGET_RATE) / 100;
    const saving = highRate.yearlyInterest - after;
    if (saving > 0) {
      actions.push({
        kind: "refinance",
        title: `고금리 잔액을 연 ${REFINANCE_TARGET_RATE}% 수준으로 옮기기`,
        detail:
          `고금리 ${won(highRate.balance)} 를 연 ${REFINANCE_TARGET_RATE}% 로 옮기면 ` +
          `연이자 ${won(highRate.yearlyInterest)} → ${won(after)}, 연 ${won(saving)} 절약. ` +
          `가능 여부·중도상환 수수료는 직접 확인해야 한다.`,
        yearlySaving: saving,
        needsCheck: true, // 대환 가능 여부는 데이터로 알 수 없다
      });
    }
  }

  // ④ 지출 상위 — 20%는 **가정**이다. 세금·의료비처럼 줄일 수 없는 항목도 상위에 오를 수 있어
  //    확정 절약액처럼 보이면 안 된다(배포 전 교차리뷰 지적) → 제목에 '가정'을 넣고 확인 필요로 둔다.
  if (topSpend.length) {
    const cut = 0.2;
    const saving = topSpend.reduce((s, r) => s + r.monthly * cut * 12, 0);
    actions.push({
      kind: "variable-cost",
      title: `지출 상위 ${topSpend.length}개 — ${cut * 100}% 줄인다고 가정하면`,
      detail:
        topSpend.map((r) => `${r.category} 월 ${won(r.monthly)}`).join(" · ") +
        `. 각각 ${cut * 100}% 씩 줄이면 월 ${won(saving / 12)} · 연 ${won(saving)}. ` +
        `줄일 수 있는 항목인지는 직접 봐야 한다(세금·의료비처럼 못 줄이는 것도 상위에 온다).`,
      yearlySaving: saving,
      needsCheck: true,
    });
  }

  // ⑤ 현금 소진 — 줄고 있을 때만 띄운다.
  //   ★"N개월 뒤 바닥"으로 단정하지 않는다. 실제로는 카드론 같은 **신규 차입으로 메우고 있어서**
  //     잔액이 유지되는 경우가 있다(2026-08-09 실측: 5~7월 전부 적자인데 현금은 그대로였고,
  //     8/2 에 카드론 1,500만이 들어와 있었다). 잔액이 버틴다고 흐름이 괜찮은 게 아니다.
  if (runwayMonths != null) {
    const allNegative = nets.length > 0 && nets.every((n) => n < 0);
    actions.push({
      kind: "cash-runway",
      title: allNegative ? "번 돈보다 나간 돈이 많다 (최근 전월 적자)" : "현금이 줄고 있다",
      detail:
        `현금성 ${won(input.cash)} · 최근 ${nets.length}개월 월 순증감 평균 ${won(monthlyNet)}. ` +
        `모자란 만큼은 새로 빌려 메우게 되고, 그만큼 이자가 다시 늘어난다. ` +
        `현금만 놓고 보면 약 ${runwayMonths.toFixed(1)}개월치다.`,
      yearlySaving: 0, // 절약액이 아니라 경고 — 정렬에서 뒤로 가되 목록에는 남는다
    });
  }

  // 절약액 큰 순. 단 **확인이 필요한 항목(대환)은 뒤로** — 검증 안 된 숫자가 1위면 오해를 부른다.
  actions.sort((a, b) => Number(a.needsCheck ?? false) - Number(b.needsCheck ?? false) || b.yearlySaving - a.yearlySaving);

  return {
    monthlyIncome: input.monthlyIncome,
    cash: input.cash,
    loanBalance,
    yearlyInterest,
    monthlyInterest,
    rateMissingCount,
    interestRatio: input.monthlyIncome > 0 ? monthlyInterest / input.monthlyIncome : null,
    loans,
    highRate,
    cardLoan,
    lowestRate,
    topSpend,
    runwayMonths,
    monthlyNet,
    actions,
  };
}
