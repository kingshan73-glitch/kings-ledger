// 카드론 월 상환액 역산과 '그 달에 카드대금이 실제 나갔는가' 판정. (설계 167)
//
// ★왜 역산이 필요한가 — 카드론은 `monthly_payment` 가 **일부러 null** 이다(설계 162 ⑤).
//   카드론 상환은 카드 결제일에 **카드대금에 합산되어** 나가므로, 월납을 채우면 현금흐름이
//   같은 돈을 카드대금과 대출 양쪽에서 두 번 뺀다(설계 70·108 카드 회계모델).
//   그래서 DB 에는 안 넣고 **화면에서만 역산해 보여준다** — 현금흐름 계산엔 절대 흘리지 않는다.
//
// ⚠️이 값을 현금흐름 출금예정 합계와 더하면 이중계상이다. 대출관리 화면 안에서
//   '총 대출 부담'을 보여주는 용도로만 쓴다.
import { cardIssuerKey } from "./card-issuer";
export { isCardLoan } from "./category-names";
import { isCardLoan } from "./category-names";
import type { HhLoan, HhTransaction } from "./types";

/**
 * 대출명 앞부분에서 카드사명을 뽑는다. "삼성카드-김하늘-카드론(26.08)" → "삼성카드".
 * 카드대금 거래의 상호("삼성카드"·"현대카드대금")와 맞대보는 데 쓴다.
 *
 * 국민카드는 문자 상호가 「KB카드」로 온다 — 그래서 cardBillPaidIn 은 글자 포함 외에 **별칭 키**(card-issuer.ts,
 *   KB국민카드/KB카드/국민카드 → '국민')로도 맞춘다(설계 182 에서 예고된 별칭표를 붙임. 2026-08-17).
 */
export function cardIssuerOf(name: string): string | null {
  const head = name.split("-")[0]?.trim();
  return head && head.includes("카드") ? head : null;
}

/** 'YYYY-MM' 두 개 사이의 개월수. */
function monthsBetween(a: string, b: string) {
  const [ay, am] = a.slice(0, 7).split("-").map(Number);
  const [by, bm] = b.slice(0, 7).split("-").map(Number);
  return (by - ay) * 12 + (bm - am);
}

/**
 * 월 상환액 역산. 원금·금리·실행일·만기 중 하나라도 없으면 null(→ 화면은 '카드대금 포함'을 쓴다).
 *
 * `repayment_type` 별로 공식이 다르다(설계 168):
 *   annuity·null → `PMT = P·r/(1-(1+r)^-n)` (월마다 같다)
 *   equal_principal → `P/n + 잔여원금·r` — **회차마다 줄어들므로 ym 을 넘겨야 한다**
 *   interest_only → `잔액·r` (원금은 만기에 일시)
 *
 * ★공식이 실제 값을 재현하는지 검산했다(2026-08-13, 월납입금이 등록된 대출로 대조):
 *   현대캐피탈 697,161 = 697,161(오차 0) · 신한저축은행 247,450 vs 247,452(2원) ·
 *   토스 사잇돌 102,280 vs 100,976(1.3%) · 디딤돌 514,097 vs 500,424(2.7%).
 *   1.5% 정책자금 두 건만 2.7% 낮은데 거치·조건 차이로 보인다.
 *
 * ★설계 168 로 원금균등·만기일시도 제 공식으로 센다. 다만 `null`(미지정)은 여전히
 *   원리금균등 **가정**이므로 화면에서 '역산' 배지를 떼지 않는다.
 *   원금균등 공식은 설계 162 의 실측값으로 검산했다 — 국민 26.08(1,500만·18.1%·18개월)의
 *   1회차 = 833,333 + 226,250 = **1,059,583원**, 문서에 적힌 실제값과 일치한다.
 */
export function estimateMonthlyPayment(l: HhLoan, ym?: string): number | null {
  if (!l.origin_date || !l.maturity_date || l.interest_rate == null || l.principal <= 0) return null;
  const n = monthsBetween(l.origin_date, l.maturity_date);
  if (n <= 0) return null;
  const r = l.interest_rate / 100 / 12;

  // 만기일시 — 매달 이자만 내고 원금은 만기에 한 번에 갚는다(약관대출류).
  //
  // ★잔액 0 이면 **원금**을 쓴다. 추측이 아니라 정의다 — 만기일시는 만기까지 원금이 줄지 않으므로
  //   상환중인 대출의 잔액은 원금과 같다. `current_balance` 는 NOT NULL DEFAULT 0 이라
  //   등록할 때 안 채우면 0 이 되는데, 그걸 "이자 0원"으로 읽으면 나가는 돈을 안 나간다고 말하게 된다.
  //   (일부 상환한 경우엔 잔액이 원금보다 작으므로 잔액 쪽이 맞다 — 그래서 0 일 때만 폴백한다.)
  //
  // ⚠️한계(교차리뷰 Major): **완제됐는데 `status` 가 still active 인 행**이면 이 폴백이 과대해진다.
  //   2026-08-13 실측으로 활성 16건 중 잔액 0 은 **0건**이고, 완제 2건은 status=closed 라
  //   `activeLoans` 단계에서 걸러진다. 그런 행이 생기면 그건 상태값을 고칠 일이다.
  if (l.repayment_type === "interest_only") {
    return Math.round((l.current_balance > 0 ? l.current_balance : l.principal) * r);
  }

  // 원금균등 — 매달 원금은 같고 이자는 잔여원금에 붙어 **회차마다 줄어든다**.
  // ★평균값을 쓰면 초기 회차가 과소, 후기 회차가 과대다(설계 162 가 국민 26.08 에서 겪었다:
  //   18개월 평균 956,177 vs 1회차 실제 1,059,583 — 9월이 약 10만원 과소였다).
  //
  // ⚠️반올림 관행은 모른다(교차리뷰 Minor). 여기서는 원금분을 소수로 두고 회차 총액만 반올림한다.
  //   금융사가 매달 원금분을 원 단위로 절사하고 잔돈을 마지막 회차에 몰아주는 방식이면
  //   마지막 회차가 845,909원(우리 계산 845,903원) — **차이 6원**이다. 계약서 없이는 어느 쪽도
  //   추측이라 바꾸지 않았다. '역산' 배지가 붙는 추정값이므로 이 정도 오차는 감수한다.
  if (l.repayment_type === "equal_principal") {
    const principalPart = l.principal / n;
    // 회차 = 첫 상환월부터 센다. ym 이 없으면(가능 여부만 묻는 호출) 1회차로 본다.
    const first = firstRepaymentMonth(l);
    const idx = ym && first ? Math.min(Math.max(monthsBetween(first, ym) + 1, 1), n) : 1;
    const remaining = l.principal - principalPart * (idx - 1);
    return Math.round(principalPart + remaining * r);
  }

  // 원리금균등(annuity) — 기본값이자 null(미지정)의 가정.
  if (r <= 0) return Math.round(l.principal / n); // 무이자면 원금 균분
  return Math.round((l.principal * r) / (1 - Math.pow(1 + r, -n)));
}

/**
 * 그 달(ym)이 이 대출의 상환기간 안인가.
 * 첫 상환월은 **실행월의 다음 달**로 본다 — 카드론은 실행한 달에는 청구되지 않는다
 * (설계 162 ⑥ 실측: 삼성 26.08 은 8/11 실행이고 8/26 청구서에 없었다. 첫 상환은 9/26).
 */
export function inRepaymentMonth(l: HhLoan, ym: string): boolean {
  const first = firstRepaymentMonth(l);
  if (first && ym < first) return false;
  if (l.maturity_date && ym > l.maturity_date.slice(0, 7)) return false;
  return true;
}

/** 첫 상환월('YYYY-MM') = 실행월의 다음 달. 실행일이 없으면 null. */
export function firstRepaymentMonth(l: HhLoan): string | null {
  if (!l.origin_date) return null;
  const [y, m] = l.origin_date.slice(0, 7).split("-").map(Number);
  return `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}`;
}

/**
 * 그 달에 이 카드론이 실린 **카드대금이 실제로 통장에서 나갔는가**.
 *
 * 카드론은 개별 출금거래가 없어 '실제 나간 돈'을 직접 잴 수 없다. 대신 그 카드의 카드대금이
 * 결제됐는지를 보고 "그 안에 역산액이 들어 있다"고 본다. 세 가지를 모두 만족해야 한다:
 *   ① 카드론의 결제계좌에서 나갔고
 *   ② 상호·메모에 그 카드사명이 있고
 *   ③ `loan_id` 가 안 붙어 있다
 *
 * ★③이 없으면 오판한다 — 2026-08-04 삼성카드 623,653원은 25.10 카드론의 **완제 일시상환**
 *   (loan_id 연결됨)인데, 이걸 카드대금으로 세면 26.03·26.08 이 "8월에 나갔다"가 된다.
 *
 * ★설계 131 '출금됨 판정은 증거가 있을 때만' — 결제일 전이면 아직 안 나간 것이므로 false 다.
 *
 * ⚠️**구조적 한계(교차리뷰 Major, 고치지 못함)**: 같은 카드사의 카드를 **두 명의가 같은 계좌로**
 *   결제하면 서로를 구분할 수 없다. 거래 상호는 「삼성카드」처럼 카드사명뿐이라 **명의 정보가 없고,
 *   결제계좌가 유일한 구분자**이기 때문이다. 이 경우 한쪽 카드대금이 다른 쪽 카드론까지
 *   '나갔다'로 만든다. 2026-08-13 실측으로 **현재 그런 쌍은 0건**임을 확인했다
 *   (삼성@토스뱅크=김하늘 2건 · 현대@국민은행=이바다 3건 — 각 그룹이 전부 동일 명의 = 같은 카드).
 *   근본 해결은 `hh_loan` 에 결제수단 연결키가 생겨야 한다(설계 162 가 남긴 구조 과제).
 */
export function cardBillPaidIn(l: HhLoan, payments: HhTransaction[], minAmount = 0): boolean {
  const issuer = cardIssuerOf(l.name);
  if (!issuer || !l.account_id) return false;
  return payments.some((p) => {
    if (p.loan_id) return false; // ③
    if (p.account_id !== l.account_id && p.from_account_id !== l.account_id) return false; // ①
    if (p.amount < minAmount) return false; // ④
    const hay = `${p.counterparty ?? ""} ${p.memo ?? ""}`.replace(/\s+/g, "");
    if (hay.includes(issuer)) return true; // ②
    // ②' 별칭 — 「KB카드출금」 vs 「국민카드-…」 처럼 표기가 다른 같은 카드사. 상호(앞)와 메모(뒤) 각각 앞머리만 본다(넓은 부분일치 금지).
    const issuerKey = cardIssuerKey(issuer);
    return issuerKey != null && (cardIssuerKey(p.counterparty) === issuerKey || cardIssuerKey(p.memo) === issuerKey);
  });
}

/** 카드대금이 함께 나가는 단위 = 카드사 + 결제계좌. 같은 카드의 카드론들은 한 청구서에 실린다. */
function billGroupKey(l: HhLoan): string | null {
  const issuer = cardIssuerOf(l.name);
  return issuer && l.account_id ? `${issuer}|${l.account_id}` : null;
}

export interface CardLoanEstimate {
  /** 대출 id → 역산 월납(상환기간 안일 때만) */
  estMap: Map<string, number>;
  /** 그중 그 달에 카드대금이 실제 나간 대출 id */
  paidIds: Set<string>;
}

/** 한 달치 카드론 역산액과 '카드대금 실납' 여부를 한 번에 만든다. */
export function buildCardLoanEstimate(loans: HhLoan[], ym: string, payments: HhTransaction[]): CardLoanEstimate {
  const estMap = new Map<string, number>();
  const paidIds = new Set<string>();

  const inWindow: HhLoan[] = [];
  for (const l of loans) {
    // ★상환완료는 스스로 거른다 — 호출부가 걸러 주기를 기대하면 안 된다.
    //   화면(page.tsx)은 activeLoans 를 넘겨서 맞았지만, 전체를 넘긴 진단 스크립트에서
    //   완제 카드론 2건까지 역산돼 합계가 1,946,022 → 3,316,242 로 부풀었다(2026-08-13 실측).
    //   ★교차리뷰가 걱정한 '완제인데 잔액 0' 경로도 여기서 함께 막힌다.
    if (l.status !== "active") continue;
    if (!isCardLoan(l) || !inRepaymentMonth(l, ym)) continue;
    // ★ym 을 넘긴다 — 원금균등은 **그 달의 회차**에 따라 값이 다르다(설계 168).
    const est = estimateMonthlyPayment(l, ym);
    if (!est) continue;
    estMap.set(l.id, est);
    inWindow.push(l);
  }

  // ★같은 청구서에 실리는 카드론들의 역산액 합계를 **하한**으로 쓴다(설계 167, 교차리뷰 Major).
  //   금액을 안 보면 소액 결제 1건만 있어도 카드론 월납 전액이 '나갔다'가 된다 —
  //   실제로 이 저장소에 `KB카드 7,785원` 같은 소액 payment 가 있다. 1원 부분결제로 재현됨.
  //   하한을 넘는 카드대금이 있어야 "그 안에 카드론이 들어 있다"고 말할 수 있다.
  //   (2026-08-13 실측: 현재 카드대금 5건 전부 하한 이상이라 이 가드로 바뀌는 판정은 0건 —
  //    지금 결과를 유지한 채 미래 오판만 막는다.)
  const need = new Map<string, number>();
  for (const l of inWindow) {
    const k = billGroupKey(l);
    if (k) need.set(k, (need.get(k) ?? 0) + (estMap.get(l.id) ?? 0));
  }
  for (const l of inWindow) {
    const k = billGroupKey(l);
    if (cardBillPaidIn(l, payments, k ? need.get(k) ?? 0 : 0)) paidIds.add(l.id);
  }
  return { estMap, paidIds };
}
