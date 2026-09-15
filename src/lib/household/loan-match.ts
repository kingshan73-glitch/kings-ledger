// 대출 ↔ 실제 납부거래 매칭. 대출관리 화면의 '당월 출금'·'전월 출금' 칸이 쓴다. (설계 92·167)
//
// ★설계 167 에서 page.tsx 의 useMemo 안에 있던 것을 **로직 변경 없이** 통째로 옮겼다.
//   전월·당월 두 달을 같은 술어로 재려면 함수여야 했다 — 화면에 술어를 복붙하면 그 순간 갈린다.
//   추출 전후 당월 결과가 같은지는 scripts/diag_loan_match_regression_20260813.mts 로 대조했다.
import type { HhLoan, HhTransaction } from "./types";

export interface LoanPaymentMatch {
  /** 대출 id → 그 달에 실제로 나간 금액 */
  actualMap: Map<string, number>;
  /** 그중 확정(loan_id 연결)이 아니라 추정으로 붙인 대출 id */
  estimatedIds: Set<string>;
}

/**
 * 한 달치 납부거래를 대출별로 집계한다. 4패스이며, 앞 패스가 확정한 대출·거래는 뒤 패스가 건드리지 않는다.
 *
 * ★확정과 추정을 섞어 한 숫자로 보여주면 안 된다. 추정은 금액·이름·날짜로 맞춘 값이라
 *   틀릴 수 있고(실제로 두 번 오탐: 열대모임·현대해상, 설계 89·90), 화면이 그걸 숨기면
 *   사용자는 틀린 숫자를 확신하게 된다. estimatedIds 로 구분해 표에 '추정'을 붙인다.
 */
export function matchLoanPayments(
  activeLoans: HhLoan[],
  activeLoanIds: Set<string>,
  payments: HhTransaction[],
): LoanPaymentMatch {
  const m = new Map<string, number>();
  const estimated = new Set<string>();
  const used = new Set<string>();

  // ① 확정 — loan_id 가 채워진 상환은 추정할 필요가 없다.
  //   상환완료 대출에 연결된 상환도 used 에는 넣는다 — 소속이 확정된 거래이므로
  //   다른(상환중) 대출의 이름·금액 매칭에 끌려가면 안 된다. 합계에만 넣지 않는다.
  for (const p of payments) {
    if (!p.loan_id) continue;
    used.add(p.id);
    if (!activeLoanIds.has(p.loan_id)) continue;
    m.set(p.loan_id, (m.get(p.loan_id) ?? 0) + p.amount);
  }

  // ② 이하 추정 — 확정된 대출은 건드리지 않는다. 추정 대상은 상환중 대출뿐이다.
  for (const l of activeLoans) {
    if (m.has(l.id) || !l.monthly_payment) continue;
    const hit = payments.find((p) => !used.has(p.id) && p.amount === l.monthly_payment);
    if (hit) {
      used.add(hit.id);
      m.set(l.id, (m.get(l.id) ?? 0) + hit.amount);
      estimated.add(l.id);
    }
  }

  // ③ 이름 매칭.
  for (const l of activeLoans) {
    // ★이미 값이 잡힌 대출(확정·추정 불문)은 건드리지 않는다.
    //   예전엔 `!estimated.has(l.id) && m.has(l.id)` 라 ①금액일치로 잡힌 추정분이 가드를 통과해
    //   이름 매칭분을 계속 더했다 — 대출명이 '국민은행'이면 '국민은행 카드대금'까지 얹혀
    //   상환액이 부풀었다(카드대금 vs 대출상환 이중계상, 설계 112·93과 같은 계열).
    if (m.has(l.id)) continue;
    const nm = l.name.replace(/\s+/g, "");
    if (!nm) continue;
    for (const p of payments) {
      if (used.has(p.id)) continue;
      const hay = `${p.counterparty ?? ""} ${p.memo ?? ""}`.replace(/\s+/g, "");
      // 카드대금은 대출 상환이 아니다 — 은행명이 겹쳐도(국민은행 대출 / 국민은행 카드대금) 후보에서 뺀다.
      if (hay.includes("카드대금")) continue;
      if (hay.includes(nm)) {
        used.add(p.id);
        m.set(l.id, p.amount);
        estimated.add(l.id);
        break; // 이름이 걸리는 모든 거래를 누적하지 않는다 — 1건만 추정한다.
      }
    }
  }

  // ④ 변동금리 등으로 금액·이름이 안 맞는 경우: 같은 출금계좌 + 상환일±4일 + 금액±15% 로 1건 추정 매칭.
  //    (예: 토스 사잇돌·가계주택자금 — 월납입금과 실제 출금액이 이자변동으로 달라 ①②를 놓친다.)
  //    대상 풀이 payment(대출·카드 대금)뿐이라 일반지출 오매칭 위험이 낮다.
  for (const l of activeLoans) {
    if (m.has(l.id) || !l.monthly_payment || !l.account_id) continue;
    const mp = l.monthly_payment;
    const hit = payments.find((p) => {
      if (used.has(p.id)) return false;
      if (p.from_account_id !== l.account_id && p.account_id !== l.account_id) return false;
      const day = Number(p.txn_date.slice(8, 10));
      const dayOk = l.payment_day == null || Math.abs(day - l.payment_day) <= 4;
      return dayOk && Math.abs(p.amount - mp) <= mp * 0.15;
    });
    if (hit) {
      used.add(hit.id);
      m.set(l.id, hit.amount);
      estimated.add(l.id);
    }
  }

  return { actualMap: m, estimatedIds: estimated };
}
