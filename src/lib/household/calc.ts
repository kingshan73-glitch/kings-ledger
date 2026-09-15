import { shiftMonth } from "@/lib/household/month";
import { makeMethodResolver } from "@/lib/household/card-group";
import { CATEGORY_NAME } from "@/lib/household/category-names";
import type {
  HhBudget,
  HhCategory,
  HhInstallment,
  HhLoan,
  HhPaymentMethod,
  HhScheduledPayment,
  HhTransaction,
} from "@/lib/household/types";

// 'YYYY-MM' 형태로 변환
export function ymOf(dateISO: string): string {
  return dateISO.slice(0, 7);
}

// 할부의 마지막 회차가 청구되는 달('YYYY-MM').
// 시작월(start_date) 기준으로 (총회차 − 시작회차)개월 뒤가 마지막 회차.
export function installmentEndYm(inst: HhInstallment): string {
  return shiftMonth(ymOf(inst.start_date), inst.total_count - inst.start_installment);
}

// ym2 - ym1 (개월 수). 같은 달이면 0.
export function monthsBetween(ym1: string, ym2: string): number {
  const [y1, m1] = ym1.split("-").map(Number);
  const [y2, m2] = ym2.split("-").map(Number);
  return (y2 - y1) * 12 + (m2 - m1);
}

// 할부 월금액 = 총금액 / 총회차 (반올림; 끝수는 마지막 회차에서 보정)
export function installmentMonthly(totalAmount: number, totalCount: number): number {
  if (totalCount <= 0) return 0;
  return Math.round(totalAmount / totalCount);
}

export interface InstallmentProgress {
  monthly: number; // 이번 회차 월금액 (마지막 회차는 보정값)
  current: number; // refYm 기준 회차 번호
  doneCount: number; // refYm 이전까지 납부 완료 회차 수
  remaining: number; // 남은 잔액
  activeInMonth: boolean; // refYm 에 이 할부가 청구되는가
}

// 특정 월(refYm, 'YYYY-MM') 기준 할부 진행 상태.
export function installmentProgress(inst: HhInstallment, refYm: string): InstallmentProgress {
  const baseMonthly = installmentMonthly(inst.total_amount, inst.total_count);
  const startYm = ymOf(inst.start_date);
  const elapsed = monthsBetween(startYm, refYm); // 시작월=0
  const current = elapsed + inst.start_installment;
  const activeInMonth = elapsed >= 0 && current >= inst.start_installment && current <= inst.total_count;
  const doneCount = Math.min(Math.max(current - 1, 0), inst.total_count);
  const remaining = Math.max(inst.total_amount - doneCount * baseMonthly, 0);
  // 마지막 회차는 끝수 보정
  const monthly =
    current === inst.total_count ? inst.total_amount - (inst.total_count - 1) * baseMonthly : baseMonthly;
  return { monthly, current, doneCount, remaining, activeInMonth };
}

// ───────────────────────── 현금흐름 예측 ─────────────────────────

export interface CashflowItem {
  label: string;
  amount: number;
  source: "scheduled" | "loan" | "installment";
  sourceId: string; // 원본 레코드 id (scheduled/loan/installment)
  day: number | null; // 납부일(1~28). 없으면 null
  direction: "out" | "in";
}

// 정기지출 주기를 월 환산액으로 (격월/주간은 근사치).
// 주간은 ×4 가 아니라 연 52주 ÷ 12개월(≈4.333)로 환산한다. ×4 는 한 달을 28일로 보는 셈이라
// 매달 약 7.7% 씩 적게 잡히고, 그만큼 예측이 낙관적으로 기운다. (설계 91 §6)
const WEEKS_PER_MONTH = 52 / 12;
function scheduledMonthlyAmount(sp: HhScheduledPayment): number {
  const amt = sp.amount ?? 0;
  if (sp.frequency === "weekly") return Math.round(amt * WEEKS_PER_MONTH);
  if (sp.frequency === "bimonthly") return Math.round(amt / 2);
  return amt;
}

// pay_day 를 그 달 말일로 클램프한다. "말일" 은 pay_day=31 로 표기하는데,
// 30일·2월 달엔 실제 말일(30/28/29)로 맞춰야 달력·월중잔액·당월예정 범위필터에서 누락되지 않는다.
function lastDayOf(ym: string): number {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m, 0).getDate();
}
function clampDayToMonth(day: number | null | undefined, ym: string): number | null {
  if (day == null) return null;
  return Math.min(day, lastDayOf(ym));
}

// 정기항목이 해당 월(ym)에 유효한지 — 시작월 ≤ ym ≤ 종료월. null이면 그 방향 무제한.
// (월 단위 예측이라 'YYYY-MM' 문자열 비교로 충분.)
export function scheduledActiveInYm(sp: HhScheduledPayment, ym: string): boolean {
  if (sp.start_date && ymOf(sp.start_date) > ym) return false;
  if (sp.end_date && ymOf(sp.end_date) < ym) return false;
  return true;
}

// 대출이 해당 월에 상환 중인지 — 실행월 ≤ ym ≤ 만기월.
function loanActiveInYm(loan: HhLoan, ym: string): boolean {
  if (loan.origin_date && ymOf(loan.origin_date) > ym) return false;
  if (loan.maturity_date && ymOf(loan.maturity_date) < ym) return false;
  return true;
}

// 특정 월(refYm)에 예상되는 현금흐름 항목 목록.
//
// ★기간 필터(시작월·종료월)는 여기 안에서 한다. 예전엔 projectMonths 만 걸러서,
//   같은 화면의 '당월 출금 예정'(cashflowCalendar → monthlyCashflow 직접 호출)과
//   '여러 달 앞 예측'(projectMonths)이 서로 다른 기준을 써서 숫자가 어긋났다 —
//   끝난 학원비가 출금 예정에는 남고 예측 첫 달에는 빠지는 식.
export function monthlyCashflow(
  refYm: string,
  inputs: {
    scheduled: HhScheduledPayment[];
    loans: HhLoan[];
    installments: HhInstallment[];
  }
): { items: CashflowItem[]; totalOut: number; totalIn: number } {
  const items: CashflowItem[] = [];

  for (const sp of inputs.scheduled) {
    if (!sp.is_active || sp.amount == null) continue;
    if (!scheduledActiveInYm(sp, refYm)) continue;
    const monthly = scheduledMonthlyAmount(sp);
    if (monthly <= 0) continue;
    items.push({
      label: sp.title,
      amount: monthly,
      source: "scheduled",
      sourceId: sp.id,
      day: sp.frequency === "weekly" ? null : clampDayToMonth(sp.pay_day, refYm),
      direction: sp.direction,
    });
  }

  for (const loan of inputs.loans) {
    if (loan.status !== "active" || !loan.monthly_payment) continue;
    if (!loanActiveInYm(loan, refYm)) continue;
    items.push({
      // ★이름 뒤에 " 상환" 을 붙이지 않는다(팀장 지시 2026-08-04, 설계 131). 대출 이름이 이미
      //   `대출상환-롯데캐피탈`·`아파트대출` 처럼 무엇인지 말하고 있어서, 접미어는 "…캐피탈 상환 상환"
      //   같은 중복만 만들고 열 폭만 먹었다. (설계 124 의 「… 상환」 일원화는 여기서 폐기된다.)
      label: loan.name,
      amount: loan.monthly_payment,
      source: "loan",
      sourceId: loan.id,
      day: clampDayToMonth(loan.payment_day, refYm),
      direction: "out",
    });
  }

  for (const ins of inputs.installments) {
    if (!ins.is_active) continue;
    const p = installmentProgress(ins, refYm);
    if (!p.activeInMonth) continue;
    items.push({
      label: `${ins.title ?? "할부"} (${p.current}/${ins.total_count})`,
      amount: p.monthly,
      source: "installment",
      sourceId: ins.id,
      day: null,
      direction: "out",
    });
  }

  const totalOut = items.filter((i) => i.direction === "out").reduce((s, i) => s + i.amount, 0);
  const totalIn = items.filter((i) => i.direction === "in").reduce((s, i) => s + i.amount, 0);
  return { items, totalOut, totalIn };
}

// ───────────────────────── 예정 vs 실제 매칭 (설계 65) ─────────────────────────

export interface ActualOutflow {
  amount: number;
  counterparty: string | null;
  txn_date: string;
  /** 아래 4개는 '매칭 풀에서 뺄 거래' 판정용(설계 131). 없으면 거르지 않는다. */
  type?: string | null;
  from_account_id?: string | null;
  to_account_id?: string | null;
  payment_method_id?: string | null;
  /** 지출의 출금계좌 — payment 계좌 게이트(설계 166) 판정용. 없으면 판정하지 않는다. */
  account_id?: string | null;
}

/**
 * 예정↔실제 매칭에 **쓰면 안 되는 거래**를 걸러 낸다. (설계 131)
 *
 * 내부 이체(등록 계좌 → 등록 계좌)는 가계 밖으로 나간 돈이 아니다 — 지갑 충전·통장 간 자리바꿈이다.
 * 그런데 매칭은 금액만 맞으면 가져가므로, 이런 거래가 풀에 있으면 **엉뚱한 고정비가 '출금됨'으로 켜진다.**
 * 실측 2026-08-04: `용돈-한별 300,000` ← 부천페이 충전(코나아이) 300,000,
 *                  `카드대금-하나카드 105,139` ← 통장 간 이체 100,000(근사매칭).
 * 판정 기준은 설계 128 과 같다 — **등록 계좌인지**로 보고 사람(person_id)으로 보지 않는다.
 * 외부 송금(도착 계좌가 우리 것이 아님)은 실제로 나간 돈이므로 **남긴다**(용돈 송금 등이 여기 해당).
 */
export function outflowsForMatching<T extends ActualOutflow>(
  txns: T[],
  accountIds: Set<string> | string[],
  /**
   * 신용·할부 카드 결제수단 id — 그 카드로 낸 **지출은 그날 통장에서 안 빠진다**(카드대금일에 몰아 나감).
   * 설계 108 은 '카드로 내는 고정비 항목'을 매칭에서 뺐는데, **거래 쪽은 안 뺐다** — 그래서 주인 없는
   * 카드 결제 거래가 풀에 남아 금액만 같은 다른 항목이 가져갔다.
   * 실측 2026-08-04: `학원비-한별(영어과외-박교사) 350,000`(8일 예정)이 8/3 신용카드 결제
   * `목동수학보습학원 350,000`(= 카드로 내는 학원비 항목의 거래)을 가져가 '출금됨'으로 켜져 있었다.
   * 체크·선불(cash)은 즉시 빠지므로 **거르지 않는다**.
   */
  cardMethodIds?: Set<string> | string[]
): T[] {
  const ids = accountIds instanceof Set ? accountIds : new Set(accountIds);
  const cards = cardMethodIds ? (cardMethodIds instanceof Set ? cardMethodIds : new Set(cardMethodIds)) : null;
  return txns.filter((t) => {
    if (cards && t.type === "expense" && t.payment_method_id && cards.has(t.payment_method_id)) return false;
    if (t.type !== "transfer") return true;
    return !(t.from_account_id && t.to_account_id && ids.has(t.from_account_id) && ids.has(t.to_account_id));
  });
}

// 상대처/항목명 정규화 — 공백·법인표기·괄호·구분기호 제거 후 소문자.
// ★kb→국민 별칭(설계 166): 은행 원문은 "KB카드", 항목명은 "국민카드" 로 표기가 갈려
//   같은 브랜드인데 상호 일치(cpHit)가 구조적으로 실패했다(실측 2026-08-12: 7/10 "KB카드 카드("
//   459,200 이 카드대금-국민카드-이바다 에 안 붙어 전월 출금이 '-'). 브랜드 동일 표기만 접는다 —
//   가맹점명 일반에 손대는 것이 아니라 이 매칭의 정규화 안에서만이다.
function normLabel(s: string): string {
  return s.replace(/\s|㈜|\(주\)|주식회사/g, "").replace(/[()[\]\-_·]/g, "").toLowerCase().replace(/kb/g, "국민");
}

// 예상 출금항목을 실거래에 매칭. 한 거래는 한 항목에만 소비된다.
//
// ★2패스다(설계 131). 예전엔 항목 순서대로 한 번만 훑어서 **증거가 약한 항목이 먼저 가져갔다** —
//   실측 2026-08-04: `학원비-한별(영어과외-박교사)`(350,000)이 상호가 명백한
//   `목동수학보습학원 350,000` 거래를 가로채, 정작 `학원비-목동수학-한별` 이 미출금으로 남았다.
//   → **1패스에서 '정확금액 + 상호일치'(score 4)만 배정**하고, 남은 거래로 2패스를 돈다.
//   greedy 는 그대로지만 "증거가 강한 짝부터" 확정하므로 이런 가로채기가 구조적으로 안 생긴다.
//
// ★**예정일보다 한참 이른 거래는 그 항목의 것이 아니다**(설계 131, 팀장 지시 2026-08-04:
//   "아직 출금 안 된 금액이 출금된 걸로 표시된다"). `earlyDayTolerance` 를 주면 거래일이
//   예정일보다 그만큼 이상 이른 거래는 후보에서 뺀다. 단 **상호까지 맞는 짝(score 4)은 예외** —
//   증거가 확실한데 날짜로 막으면 진짜 실적을 잃는다(선납·조기이체가 실제로 있다).
//   늦게 나간 것(주말 밀림 등)은 막지 않는다 — 한쪽 방향만 본다.
//   ⚠️'최근 3개월 실적 있음' 판정(paidRecently)에는 주지 마라. 거기서 걸러지면 항목이
//     '최근 출금 기록 없음'으로 표에서 통째로 빠진다(월이 달라 일자 비교가 무의미하기도 하다).
//
// ★payment(카드대금·대출납부) 3패스(score 1, 설계 166) — 카드대금은 "매달 반드시 나가되 금액이
//   달마다 크게 변하는" 돈이라 ±30% 근사가 자주 깨진다(실측 2026-08-12: 전월 payment 16건 중 6건이
//   어느 행에도 안 붙어, 현대카드 2,650,090 등 가장 큰 출금들의 '전월 출금'이 '-' 였다).
//   payment 타입 거래 한정으로 ⓐ상호 일치(금액 무관) ⓑ근사-정밀(차이 ≤ max(1,000원, 0.5%) —
//   변동금리 대출의 87원·107원 차이용)을 마지막 순위로 붙인다.
//   ★계좌 게이트: payment 가 금액 불일치(score<30)로 붙으려면 항목·거래의 출금계좌가 달라선 안 된다
//   (둘 다 알 때만 판정) — 같은 카드사 카드가 두 명의로 있으면 상호("삼성카드")로는 못 가르기 때문.
//   실측(2026-07-27): 명의 갑의 계좌에서 나간 카드대금 1,363,233 이 명의 을의 카드대금 항목에
//   오귀속돼 있었다. payment 의 exact(30 이상)는 오늘 동작 그대로 둔다 — 기존 매칭을 줄이지 않는다.
//
// ★점수 체계(설계 188 개정): 40 = 정확금액+상호일치 · 36/33/30 = 정확금액을 계좌 일치도로 세분
//   (payment 제외 — 아래 pass 안 주석) · 20 = 근사+상호일치 · 10 = payment 특례. 옛 4/3/2/1 의
//   상대 순서는 그대로고, 정확금액 안에서만 '같은 계좌' 짝을 pass(36)로 먼저 확정한다.
//
// 반환: item.key → 매칭된 실거래.
export function matchOutflowActuals(
  items: { key: string; amount: number; label: string; day?: number | null; accountId?: string | null; accountBlind?: boolean }[],
  txns: ActualOutflow[],
  opts?: { earlyDayTolerance?: number }
): Map<string, ActualOutflow> {
  const result = new Map<string, ActualOutflow>();
  const used = new Array(txns.length).fill(false);
  // ★설계 188 후속(리뷰 High): 같은 금액의 accountBlind 항목(=대출, 계좌를 일부러 안 넘김)이
  //   경쟁에 있으면 그 금액은 계좌 세분을 하지 않는다(전부 33 → 옛 배열 순서). 대출 상환은
  //   payment 뿐 아니라 **expense 로도** 기록된다(발급사명 없는 계좌이체·약관대출 이자) —
  //   거래 타입 제외만으로는 대출 보호가 새기 때문에 항목 쪽에서 판정한다.
  const blindAmounts = new Set(items.filter((i) => i.accountBlind).map((i) => i.amount));

  const cpHitOf = (label: string, counterparty: string | null) => {
    const nl = normLabel(label);
    const cp = normLabel(counterparty ?? "");
    return (
      cp.length >= 2 &&
      nl.length >= 2 &&
      (nl.includes(cp.slice(0, Math.min(4, cp.length))) || cp.includes(nl.slice(0, Math.min(4, nl.length))))
    );
  };

  const pass = (minScore: number) => {
    for (const it of items) {
      if (result.has(it.key)) continue;
      let bestIdx = -1;
      let bestScore = 0;
      let bestDiff = Infinity;
      for (let i = 0; i < txns.length; i++) {
        if (used[i]) continue;
        const t = txns[i];
        const exact = t.amount === it.amount;
        const cpHit = cpHitOf(it.label, t.counterparty);
        const approx = Math.abs(t.amount - it.amount) <= Math.max(1000, it.amount * 0.3);
        // 근사-정밀: 변동금리로 월납이 몇십~몇백 원 흔들리는 대출용(1,000원 또는 0.5% 이내).
        const nearExact = Math.abs(t.amount - it.amount) <= Math.max(1000, it.amount * 0.005);
        // ★설계 188: 정확금액 단독 매칭(옛 score 3)을 계좌로 세분한다 — 같은 계좌(36) >
        //   계좌 미상·다른 계좌(33·30, 이 서열은 한 항목이 거래를 고를 때만 작동한다).
        //   상호가 계좌번호 원문인 송금은 cpHit 이 구조적으로 불가능해, 다른 계좌의 동일금액
        //   거래가 '출금됨'으로 붙었다(실측 2026-08-24: 우리은행 출금 100,000 이 토스뱅크 적금
        //   항목에 오귀속 — 같은 계좌의 진짜 주인은 당월보류라 배열 뒤였다). **차단이 아니라
        //   우선순위다** — 다른 계좌라도 경쟁자가 없으면 종전대로 잡는다. 계좌 전환 전 과거 달
        //   (2026-03~06 보험료 등)의 실납부는 등록계좌와 달라서, 하드 게이트는 5개월 대조에서
        //   진짜 실적 6건을 미출금으로 뒤집었다(설계 185 와 같은 시대착오라 기각.
        //   diag_gate_compare_20260824).
        // ★payment 거래와 blindAmounts(같은 금액의 대출이 경쟁 중)는 세분하지 않는다(전부 '미상'
        //   취급 → 옛 배열 순서 그대로) — 대출은 호출부가 계좌를 안 넘겨 상한이 '미상'이라,
        //   계좌일치 항목이 대출 상환을 가로채면 설계 185 의 대출 보호가 깨진다(리뷰 2트랙 High).
        const txnAcc = t.from_account_id ?? t.account_id;
        const accScore = // 6=같은 계좌 · 3=판정 안 함(미상/세분 제외) · 0=다른 계좌
          t.type !== "payment" && !blindAmounts.has(t.amount) && it.accountId && txnAcc
            ? (it.accountId === txnAcc ? 6 : 0)
            : 3;
        let score = 0;
        if (exact && cpHit) score = 40;
        else if (exact) score = 30 + accScore;
        else if (cpHit && approx) score = 20;
        else if (t.type === "payment" && (cpHit || nearExact)) score = 10;
        if (score < minScore) continue;
        // 계좌 게이트(설계 166) — payment 가 금액 불일치로 붙을 땐 출금계좌가 서로 달라선 안 된다.
        // 계좌를 모르는 쪽이 있으면 판정하지 않는다(등록값이 낡은 실사례가 있어 막지 않는 쪽이 안전).
        if (t.type === "payment" && score > 0 && score < 30) {
          if (it.accountId && txnAcc && it.accountId !== txnAcc) continue;
        }
        // 예정일보다 한참 이른 거래는 그 항목의 것이 아니다(상호까지 맞는 score 40 은 예외).
        const tol = opts?.earlyDayTolerance;
        if (tol != null && score < 40 && it.day != null) {
          const txnDay = Number(t.txn_date.slice(8, 10));
          if (Number.isFinite(txnDay) && txnDay < it.day - tol) continue;
        }
        const diff = Math.abs(t.amount - it.amount);
        if (score > bestScore || (score === bestScore && diff < bestDiff)) {
          bestScore = score;
          bestIdx = i;
          bestDiff = diff;
        }
      }
      if (bestIdx < 0) continue;
      used[bestIdx] = true;
      result.set(it.key, txns[bestIdx]);
    }
  };

  pass(40); // 1패스: 정확금액 + 상호일치만
  pass(36); // 1.5패스: 정확금액 + 출금계좌 일치 — 배열 뒤(보류) 항목이라도 자기 계좌 거래를 먼저 받는다(설계 188)
  pass(20); // 2패스: 나머지(정확금액 단독, 근사+상호일치)
  pass(10); // 3패스: payment 한정 — 상호일치(금액 무관) 또는 근사-정밀. (설계 166)
  return result;
}

// ───────────────────────── 여러 달 앞 예측 (설계 64) ─────────────────────────

export interface MonthProjection {
  ym: string; // 'YYYY-MM'
  inflow: number; // 정기수입 합
  outflow: number; // 고정비+대출+할부(+scheduled 카드) 합
  net: number; // inflow - outflow
  openingCash: number; // 월초 현금성 합 (직전 달 closingCash, 첫 달은 현재 잔액 합)
  closingCash: number; // openingCash + net
}

// 당월 이미 입금이 확인된 정기수입 id 집합.
// 판정: 해당 정기수입 계좌로 이번 달 income 거래 중 "급여 규모(예상액의 70% 이상)"인 단일 입금이 있으면 받음.
// 왜: 예측은 현재 현금잔액(startCash, 이미 받은 급여 반영됨)에서 출발하는데,
// 첫 달에 그 급여를 예상수입으로 또 더하면 이중계상된다(설계 65 수입 대칭). 받은 것은 첫 달 예상에서 뺀다.
// 금액 문턱을 두는 이유: 계좌만 보면 급여 전 소액 잡수입(이자·환급 등)을 급여로 오판해
// 아직 안 온 급여를 예상에서 빼버려 현금부족 경고가 오작동한다(실측으로 확인된 오탐).
// 상여로 금액이 커지는 건 문턱을 넘으므로 안전. 문턱 미달(월중 소액 잡수입)은 급여로 치지 않는다.
const RECEIVED_INFLOW_RATIO = 0.7;
export function receivedInflowIds(
  ym: string,
  scheduled: HhScheduledPayment[],
  txns: HhTransaction[]
): Set<string> {
  const ids = new Set<string>();
  for (const sp of scheduled) {
    if (sp.direction !== "in" || !sp.is_active || !sp.account_id || !sp.amount) continue;
    const threshold = sp.amount * RECEIVED_INFLOW_RATIO;
    // ★금액 문턱만으로는 **성격이 다른 큰 입금**을 못 막는다. 문턱은 아래쪽(소액 잡수입)만 막는데,
    //   대출 실행금처럼 훨씬 큰 입금은 오히려 문턱을 쉽게 넘는다. (2026-08-09, 팀장 신고)
    //   실측: 8/2 카드론 15,000,000 이 국민은행(이바다) 으로 들어와, 같은 계좌를 쓰는 정기수입
    //   `바다기획-이바다` 2,000,000 을 '이미 받았다'로 판정해 8월 예상수입에서 뺐다(735만 → 535만).
    //
    // ⚠️**카테고리로는 못 가른다** — 실데이터가 뒤죽박죽이다(배포 전 교차리뷰 지적 → 실측으로 확인):
    //   6/25 하늘상사 급여 5,556,592 가 '기타수입', 7/31 바다기획 2,000,000 이 '급여' 로 분류돼 있다.
    //   카테고리 불일치를 '안 받음'으로 보면 그 달들이 **이중계상**된다(이번 오판과 정반대 사고).
    // → **상호로 가른다.** '하늘상사'·'바다기획' 은 항목명과 겹치고 'KB국민카드' 는 안 겹친다.
    //   근거(상호 또는 카테고리)가 하나라도 맞으면 받은 것으로 보고, 확인할 근거가 **아예 없을 때만**
    //   종전처럼 계좌+금액만으로 인정한다.
    const spLabel = normLabel(`${sp.title ?? ""}${sp.payee ?? ""}`);
    const got = txns.some((t) => {
      if (t.type !== "income" || t.account_id !== sp.account_id) return false;
      if (ymOf(t.txn_date) !== ym || t.amount < threshold) return false;
      const cp = normLabel(t.counterparty ?? "");
      const cpKnown = cp.length >= 2 && spLabel.length >= 2;
      const cpHit = cpKnown && (spLabel.includes(cp.slice(0, Math.min(4, cp.length))) || cp.includes(spLabel.slice(0, Math.min(4, spLabel.length))));
      const catKnown = Boolean(sp.category_id && t.category_id);
      const catHit = catKnown && t.category_id === sp.category_id;
      if (cpHit || catHit) return true;
      return !cpKnown && !catKnown; // 가릴 근거가 전혀 없을 때만 종전대로
    });
    if (got) ids.add(sp.id);
  }
  return ids;
}

// 현재 현금성 잔액에서 시작해 fromYm부터 monthsAhead개월을 순차로 굴린다.
// 카드·대출·할부는 전부 scheduled에 있으므로 monthlyCashflow를 달마다 굴리면 그대로 반영된다.
// 예측 경로에서만 scheduled의 시작/종료월을 존중(만기 지난 대출·아직 안 시작한 수입 제외).
// firstMonthReceivedInflowIds: 첫 달(k=0)에 이미 입금된 정기수입 — 첫 달 예상수입에서 제외(이중계상 방지).
export function projectMonths(
  startCash: number,
  fromYm: string,
  monthsAhead: number,
  inputs: { scheduled: HhScheduledPayment[]; loans: HhLoan[]; installments: HhInstallment[] },
  firstMonthReceivedInflowIds: Set<string> = new Set(),
  /**
   * 특정 월의 출금 합계를 캘린더 산출값 대신 이 값으로 대체한다(ym → 출금합계).
   * 두 곳에서 쓴다:
   *  - 익월: 익월 출금 탭에서 확정한 카드값·변동금액을 예측에 반영. (설계 81 §E)
   *  - 첫 달(당월): **아직 지급되지 않은 출금만** 넘긴다. 예측은 '현재 잔액'에서 출발하고
   *    이번 달에 이미 나간 돈은 그 잔액에 반영돼 있으므로, 월 전체를 빼면 이중차감이다. (설계 110)
   * 넘기지 않으면 기존 동작 그대로.
   */
  outflowByYm?: Map<string, number>,
  /**
   * 그 달에만 제외할 항목(ym → sourceId 집합). 이번 달 일시정지(override.released)를
   * **해당 월에서만** 빼고 다음 달부터는 자동 재개하기 위한 것. (설계 97)
   * 넘기지 않으면 기존 동작 그대로.
   */
  excludedByYm?: Map<string, Set<string>>,
  /**
   * `outflowByYm` 에 값이 없는 달에 더할 고정 금액 — 변동 지출(생활비) 월액. (설계 173)
   * ★맵에 든 달(첫 달·익월)은 **호출부가 이미 더해서** 넣으므로 여기서 또 더하지 않는다.
   *   이 인자가 없으면 3개월째부터 변동 지출이 빠져 **뒤로 갈수록 예측이 낙관적**이 된다.
   */
  extraMonthlyOut = 0
): MonthProjection[] {
  const out: MonthProjection[] = [];
  let opening = startCash;
  for (let k = 0; k < monthsAhead; k++) {
    const ym = shiftMonth(fromYm, k);
    // 시작·종료월 필터는 monthlyCashflow 안에서 한다(모든 호출부가 같은 기준을 쓰도록).
    // 여기 남는 건 예측에만 있는 규칙 — 첫 달에 이미 받은 정기수입 제외(이중계상 방지),
    // 그리고 그 달만 쉬는 일시정지 제외(설계 97).
    const excluded = excludedByYm?.get(ym);
    const scheduled = inputs.scheduled.filter(
      (s) =>
        !(k === 0 && s.direction === "in" && firstMonthReceivedInflowIds.has(s.id)) &&
        !excluded?.has(s.id)
    );
    const loans = excluded ? inputs.loans.filter((l) => !excluded.has(l.id)) : inputs.loans;
    const installments = excluded
      ? inputs.installments.filter((i) => !excluded.has(i.id))
      : inputs.installments;
    const cf = monthlyCashflow(ym, { scheduled, loans, installments });
    // monthlyCashflow 는 카드대금을 모르므로(카드는 cashflowCalendar 에서만 붙는다) 익월은 대체값을 쓴다.
    const outflow = outflowByYm?.get(ym) ?? cf.totalOut + Math.max(0, extraMonthlyOut);
    const net = cf.totalIn - outflow;
    const closingCash = opening + net;
    out.push({ ym, inflow: cf.totalIn, outflow, net, openingCash: opening, closingCash });
    opening = closingCash;
  }
  return out;
}

// ───────────────────────── 월간 관제판 헬퍼 ─────────────────────────

// 이번 달 예정 출금 중 fromDay(오늘) 이후로 아직 남은 합. 날짜 미지정(주간 등)은 보수적으로 전액 포함.
export function remainingOutflow(items: CashflowItem[], fromDay: number): number {
  return items
    .filter((i) => i.direction === "out" && (i.day == null || i.day >= fromDay))
    .reduce((s, i) => s + i.amount, 0);
}

// 향후 7일(fromDay ~ fromDay+7) 출금 예정 합.
export function next7daysOutflow(items: CashflowItem[], fromDay: number): number {
  return items
    .filter((i) => i.direction === "out" && i.day != null && i.day >= fromDay && i.day <= fromDay + 7)
    .reduce((s, i) => s + i.amount, 0);
}

// 특정 월의 카테고리별 지출액(지출 거래 + 그 달 할부 청구분). key=category_id.
export function categorySpending(
  ym: string,
  txns: HhTransaction[],
  installments: HhInstallment[]
): Map<string, number> {
  const map = new Map<string, number>();
  for (const t of txns) {
    if (t.type !== "expense" || ymOf(t.txn_date) !== ym || !t.category_id) continue;
    map.set(t.category_id, (map.get(t.category_id) ?? 0) + t.amount);
  }
  for (const ins of installments) {
    if (!ins.is_active || !ins.category_id) continue;
    const p = installmentProgress(ins, ym);
    if (!p.activeInMonth) continue;
    map.set(ins.category_id, (map.get(ins.category_id) ?? 0) + p.monthly);
  }
  return map;
}

export interface BudgetLine {
  categoryId: string;
  name: string;
  spent: number;
  budget: number;
  over: number; // spent - budget (양수면 초과)
}

// 예산 대비 지출 상태. 단순 누적(이번달 지출 합) vs 예산.
export function budgetStatus(
  ym: string,
  txns: HhTransaction[],
  installments: HhInstallment[],
  categories: HhCategory[],
  budgets: HhBudget[]
): { lines: BudgetLine[]; overCount: number; overTotal: number } {
  const spend = categorySpending(ym, txns, installments);
  const nameOf = new Map(categories.map((c) => [c.id, c.name]));
  const lines = budgets
    .filter((b) => b.ym === ym)
    .map((b) => {
      const spent = spend.get(b.category_id) ?? 0;
      return { categoryId: b.category_id, name: nameOf.get(b.category_id) ?? "?", spent, budget: b.amount, over: spent - b.amount };
    })
    .sort((a, b) => b.over - a.over);
  const over = lines.filter((l) => l.over > 0);
  return { lines, overCount: over.length, overTotal: over.reduce((s, l) => s + l.over, 0) };
}

// ───────────────────────── 현금흐름 캘린더 ─────────────────────────

export type CalendarKind = "income" | "fixed" | "loan" | "installment" | "card";

export type CashflowSourceKind = "fixed" | "loan" | "installment" | "card";

export interface CalendarEntry {
  kind: CalendarKind;
  label: string;
  amount: number;
  direction: "in" | "out";
  sourceKind: CashflowSourceKind; // 오버라이드 식별용 (income은 fixed로 분류, 출금표에서 미사용)
  sourceId: string; // 원본 레코드 id
  defaultAccountId: string | null; // 자동 추론 출금계좌(오버라이드 없을 때)
  categoryId: string | null; // 원본의 카테고리(고정비·할부만; 대출·카드대금은 없음)
  /** 이 항목이 결제되는 수단(고정비에 지정된 카드 등). 표에 카드명을 보여주는 데 쓴다. (설계 108) */
  paymentMethodId: string | null;
  /**
   * 신용카드로 결제돼 **그날 현금이 안 빠지는** 항목인가. (설계 108)
   * true 면 표에는 보이되 계좌 잔액 예측·출금예정 합계에서 뺀다 — 실제 현금은 카드대금일에
   * 카드대금 정기지출로 한 번 나가므로, 같이 세면 이중차감이다.
   */
  cardCharge: boolean;
}

// 캘린더 배지 표시 정보(아이콘·이름·색 톤). UI에서 공유.
export const CALENDAR_KIND_META: Record<CalendarKind, { icon: string; name: string }> = {
  income: { icon: "💰", name: "수입" },
  card: { icon: "💳", name: "카드결제" },
  loan: { icon: "🏦", name: "대출상환" },
  fixed: { icon: "🔁", name: "고정비" },
  installment: { icon: "📿", name: "할부" },
};

// monthlyCashflow source → 캘린더 kind.
function calendarKindOf(item: CashflowItem): CalendarKind {
  if (item.source === "loan") return "loan";
  if (item.source === "installment") return "installment";
  return item.direction === "in" ? "income" : "fixed"; // scheduled
}

// 특정 월(refYm)의 현금흐름을 날짜별로 모은다.
// dated: 날짜(1~31) → 항목들 / undated: 납부일 미지정(주간 고정비·할부 등).
// 신용카드 청구분은 결제수단 billing_day에 'card' 배지로 추가(이번 달 신용카드 사용액 기준 — 대시보드와 동일 근사).
export function cashflowCalendar(
  refYm: string,
  inputs: {
    scheduled: HhScheduledPayment[];
    loans: HhLoan[];
    installments: HhInstallment[];
    txns: HhTransaction[];
    methods: HhPaymentMethod[];
  }
): { dated: Map<number, CalendarEntry[]>; undated: CalendarEntry[] } {
  const dated = new Map<number, CalendarEntry[]>();
  const undated: CalendarEntry[] = [];

  const push = (day: number | null, entry: CalendarEntry) => {
    if (day == null) {
      undated.push(entry);
      return;
    }
    const list = dated.get(day) ?? [];
    list.push(entry);
    dated.set(day, list);
  };

  const schedById = new Map(inputs.scheduled.map((s) => [s.id, s]));
  const insById = new Map(inputs.installments.map((i) => [i.id, i]));
  const loanById = new Map(inputs.loans.map((l) => [l.id, l]));
  // 연결계좌·카드청구 판정은 card-group.ts 의 makeMethodResolver 가 유일한 정의다(설계 203).
  // 스냅샷(buildOutItem)도 그 달 결제수단 오버라이드로 같은 판정을 해야 해서 사본을 두지 않는다.
  const methodResolver = makeMethodResolver(inputs.methods);
  const linkedAccountOf = methodResolver.linkedAccountOf;

  // 고정비·할부에 지정된 결제수단(설계 108: 고정비도 카드로 결제될 수 있다).
  const methodOf = (item: CashflowItem): string | null => {
    if (item.source === "scheduled") return schedById.get(item.sourceId)?.payment_method_id ?? null;
    if (item.source === "installment") return insById.get(item.sourceId)?.payment_method_id ?? null;
    return null; // loan
  };
  // 자동 추론 출금계좌: 고정비=등록계좌(없으면 체크·선불카드의 연결계좌), 할부=결제수단 연결계좌,
  // 대출=대출에 등록된 출금계좌(hh_loan.account_id).
  // 신용카드로 결제되는 고정비는 그날 계좌에서 안 빠지므로 계좌를 추론하지 않는다(cardCharge 로 따로 표시).
  const defaultAccountOf = (item: CashflowItem): string | null => {
    if (item.source === "scheduled") {
      const s = schedById.get(item.sourceId);
      if (s?.account_id) return s.account_id;
      // 체크·선불은 즉시 출금이라 연결계좌가 곧 출금계좌다. 신용카드는 카드대금일에 빠진다.
      return methodResolver.isImmediate(s?.payment_method_id) ? linkedAccountOf(s!.payment_method_id) : null;
    }
    if (item.source === "installment") {
      const pmId = insById.get(item.sourceId)?.payment_method_id;
      return linkedAccountOf(pmId);
    }
    // 대출은 대출 정보에 등록된 출금계좌를 그대로 쓴다. (설계 185)
    // 컬럼은 2026-07-16 에 생겼는데 여기서 안 읽어
    // 당월은 사람이 손으로 지정한 그 달 오버라이드로만 채워지고 **익월은 늘 빈칸**이었다
    // (2026-08-19 실측: 익월 빈 10건이 전부 대출). 오버라이드는 '이 달만 다른 계좌' 라는 뜻이라
    // 호출부에서 여전히 이 값보다 우선한다.
    return loanById.get(item.sourceId)?.account_id ?? null;
  };
  // 신용카드 결제분인가 — 현금 유출은 카드대금일에 일어난다. (설계 108, 할부 확장은 설계 111)
  // ★할부도 포함한다: 카드 할부 회차는 그날 통장에서 안 빠지고 그 카드의 **카드대금에 얹혀** 나간다.
  //   할부를 따로 세면 카드대금과 이중차감이다(2026-07-30 실측: 당월 청구 할부 13건 전부 신용카드,
  //   합 1,049,244원이 대응 카드대금 항목과 겹쳐 있었다). 대출은 계좌에서 직접 빠지므로 해당 없음.
  const cardChargeOf = (item: CashflowItem): boolean => {
    if (item.source === "loan") return false;
    const pmId =
      item.source === "scheduled"
        ? schedById.get(item.sourceId)?.payment_method_id
        : insById.get(item.sourceId)?.payment_method_id;
    return methodResolver.isCardCharge(pmId);
  };
  const sourceKindOf = (item: CashflowItem): CashflowSourceKind =>
    item.source === "scheduled" ? "fixed" : item.source;
  // 원본 카테고리(고정비=정기지출.category_id, 할부=할부.category_id, 대출=없음).
  const categoryOf = (item: CashflowItem): string | null => {
    if (item.source === "scheduled") return schedById.get(item.sourceId)?.category_id ?? null;
    if (item.source === "installment") return insById.get(item.sourceId)?.category_id ?? null;
    return null; // loan
  };

  const cf = monthlyCashflow(refYm, {
    scheduled: inputs.scheduled,
    loans: inputs.loans,
    installments: inputs.installments,
  });
  for (const item of cf.items) {
    push(item.day, {
      kind: calendarKindOf(item),
      label: item.label,
      amount: item.amount,
      direction: item.direction,
      sourceKind: sourceKindOf(item),
      sourceId: item.sourceId,
      defaultAccountId: defaultAccountOf(item),
      categoryId: categoryOf(item),
      paymentMethodId: methodOf(item),
      cardCharge: cardChargeOf(item),
    });
  }

  // 신용카드 청구분 — 결제수단별 이번 달 사용액을 billing_day에 배치.
  const creditMethods = inputs.methods.filter((m) => m.kind === "credit" && m.billing_day != null);
  for (const m of creditMethods) {
    const used = inputs.txns
      .filter((t) => t.type === "expense" && ymOf(t.txn_date) === refYm && t.payment_method_id === m.id)
      .reduce((s, t) => s + t.amount, 0);
    if (used <= 0) continue;
    push(m.billing_day, {
      kind: "card",
      label: `${m.name} 카드대금`,
      amount: used,
      direction: "out",
      sourceKind: "card",
      sourceId: m.id,
      defaultAccountId: linkedAccountOf(m.id),
      categoryId: null,
      paymentMethodId: m.id, // 카드대금 자체는 그 카드의 청구분 — 현금은 실제로 이 날 빠진다
      cardCharge: false,
    });
  }

  return { dated, undated };
}

// 출금예정 항목을 계좌별로 시작잔액에서 순차 차감해 각 항목 "출금 후 예상잔액"을 만든다.
// (날짜 오름차순, 날짜미정은 맨 뒤. 계좌 미지정 항목은 제외.) key → 출금 후 잔액.
export interface ProjectedItem {
  key: string;
  accountId: string | null;
  amount: number;
  day: number | null;
}

export function projectedBalances(
  startBalances: Record<string, number>,
  items: ProjectedItem[]
): Record<string, number> {
  const result: Record<string, number> = {};
  const byAccount = new Map<string, ProjectedItem[]>();
  for (const it of items) {
    if (!it.accountId) continue;
    const arr = byAccount.get(it.accountId) ?? [];
    arr.push(it);
    byAccount.set(it.accountId, arr);
  }
  for (const [acc, list] of byAccount) {
    const sorted = [...list].sort((a, b) => (a.day ?? 99) - (b.day ?? 99));
    let bal = startBalances[acc] ?? 0;
    for (const it of sorted) {
      bal -= it.amount;
      result[it.key] = bal;
    }
  }
  return result;
}

export interface SpendingSpike {
  categoryId: string;
  name: string;
  thisMonth: number;
  prevMonth: number;
  delta: number;
}

// 전월 대비 지출 급증 카테고리 Top-N (증가액 기준).
export function monthOverMonthSpike(
  ym: string,
  prevYm: string,
  txns: HhTransaction[],
  installments: HhInstallment[],
  categories: HhCategory[],
  topN = 3
): SpendingSpike[] {
  const cur = categorySpending(ym, txns, installments);
  const prev = categorySpending(prevYm, txns, installments);
  const nameOf = new Map(categories.map((c) => [c.id, c.name]));
  const ids = new Set([...cur.keys(), ...prev.keys()]);
  return [...ids]
    .map((id) => {
      const thisMonth = cur.get(id) ?? 0;
      const prevMonth = prev.get(id) ?? 0;
      return { categoryId: id, name: nameOf.get(id) ?? "?", thisMonth, prevMonth, delta: thisMonth - prevMonth };
    })
    .filter((s) => s.delta > 0)
    .sort((a, b) => b.delta - a.delta)
    .slice(0, topN);
}

// ═══════════════ 통계: 과다지출 판정 + 연간 집계 (설계 docs/household/61) ═══════════════

/** 과다지출 판정 규칙(설계 61 R2). 비율 AND 절대액 동시 충족으로 소액 잡음을 억제한다. */
export const OVERSPEND_RULES = {
  window: 6, // 비교 기간: 직전 N개월 평균
  overRatio: 1.5,
  overMinDiff: 50_000, // 🔴 과다: 평균×1.5 이상 & 차액 5만원 이상
  warnRatio: 1.2,
  warnMinDiff: 30_000, // 🟡 주의: 평균×1.2 이상 & 차액 3만원 이상
  newMin: 100_000, // 🔵 신규: 직전 평균 0인데 당월 10만원 이상
} as const;

export interface OverspendLine {
  categoryId: string;
  current: number; // 당월 지출(할부 청구분 포함)
  average: number; // 직전 6개월 평균
  diff: number; // current - average
  level: "over" | "warn" | "new";
}

/** 당월 카테고리 지출을 직전 N개월 평균과 비교해 평소 범위를 벗어난 항목만 돌려준다. 초과액 내림차순. */
export function overspendReport(
  ym: string,
  txns: HhTransaction[],
  installments: HhInstallment[]
): OverspendLine[] {
  const current = categorySpending(ym, txns, installments);
  const sums = new Map<string, number>();
  for (let i = 1; i <= OVERSPEND_RULES.window; i++) {
    for (const [id, v] of categorySpending(shiftMonth(ym, -i), txns, installments)) {
      sums.set(id, (sums.get(id) ?? 0) + v);
    }
  }
  const lines: OverspendLine[] = [];
  for (const [id, cur] of current) {
    const average = Math.round((sums.get(id) ?? 0) / OVERSPEND_RULES.window);
    const diff = cur - average;
    let level: OverspendLine["level"] | null = null;
    if (average === 0) {
      if (cur >= OVERSPEND_RULES.newMin) level = "new";
    } else if (cur >= average * OVERSPEND_RULES.overRatio && diff >= OVERSPEND_RULES.overMinDiff) {
      level = "over";
    } else if (cur >= average * OVERSPEND_RULES.warnRatio && diff >= OVERSPEND_RULES.warnMinDiff) {
      level = "warn";
    }
    if (level) lines.push({ categoryId: id, current: cur, average, diff, level });
  }
  return lines.sort((a, b) => b.diff - a.diff);
}

/**
 * 한 달의 수입/지출/대출실행/대출상환 합계.
 *
 * ★기준(설계 189 — 팀장 지시 2026-08-26):
 * - **수입은 '번 돈'만** 센다. 대출 실행금(빌린 돈)은 수입 카테고리 '대출'로 들어오는데,
 *   그대로 세면 8월처럼 카드론 2건(2,870만)이 급여를 덮어 그래프가 소득 급증처럼 읽힌다.
 *   `loanIncomeCategoryId` 를 주면 그 카테고리의 income 거래를 수입에서 뺀다.
 * - **지출은 결제월 기준**. 할부도 월별로 쪼개지 않고 **결제한 달에 총액**으로 넣는다.
 *   (할부는 `hh_installment` 에만 있고 같은 금액의 expense 거래가 따로 없다 —
 *    2026-08-26 전수 확인, 동액 거래 0건 — 그래서 총액을 넣어도 이중계상이 아니다.)
 * - 카드대금·이체는 여전히 제외한다(카드로 쓴 시점에 이미 지출로 잡혀 있어 두 번 세게 된다).
 *
 * loanIncomeCategoryId 를 주면 수입에서 뺀 대출 **실행금**을 loanIn 으로 함께 낸다(설계 192).
 * loanCategoryId 를 주면 대출 **상환액**도 함께 낸다(설계 90 §2).
 * 대출 상환은 소비가 아니라 **부채 감소**라 지출과 겹치지 않으므로 별도 계열로 세워도 이중계상이 아니다.
 */
export function monthFlowTotals(
  ym: string,
  txns: HhTransaction[],
  installments: HhInstallment[],
  loanCategoryId?: string | null,
  loanIncomeCategoryId?: string | null
): { income: number; expense: number; loan: number; loanIn: number } {
  let income = 0;
  let expense = 0;
  let loan = 0;
  let loanIn = 0;
  for (const t of txns) {
    if (ymOf(t.txn_date) !== ym) continue;
    if (t.type === "income") {
      // 빌린 돈은 번 수입에서 빼되, 별도 대출실행 계열에는 남긴다(설계 192).
      if (loanIncomeCategoryId && t.category_id === loanIncomeCategoryId) {
        loanIn += t.amount;
        continue;
      }
      income += t.amount;
    } else if (t.type === "expense") expense += t.amount;
    else if (t.type === "payment" && loanCategoryId && t.category_id === loanCategoryId) loan += t.amount;
  }
  for (const ins of installments) {
    if (!ins.is_active) continue;
    // 결제월에 총액 — 청구분 분할(installmentProgress)을 쓰지 않는다(설계 189).
    if (ymOf(ins.start_date) === ym) expense += ins.total_amount;
  }
  return { income, expense, loan, loanIn };
}

/** '대출상환' 카테고리 id. 이름으로 찾는다 — payment 거래를 대출/카드로 가르는 유일한 기준이다(설계 90 §1). */
export const LOAN_CATEGORY_NAME = CATEGORY_NAME.loanRepay;

export function loanCategoryId(categories: { id: string; name: string }[]): string | null {
  return categories.find((c) => c.name === LOAN_CATEGORY_NAME)?.id ?? null;
}

/**
 * 대출 **실행금**(빌린 돈)이 들어오는 수입 카테고리 id (설계 189).
 * ★`kind === "income"` 까지 본다 — 이름만 보면 지출 쪽 '대출상환'·'대출이자' 같은 항목을 잘못 집을 수 있다.
 */
export const LOAN_INCOME_CATEGORY_NAME = CATEGORY_NAME.loanIncome;

export function loanIncomeCategoryId(categories: { id: string; name: string; kind?: string }[]): string | null {
  return categories.find((c) => c.name === LOAN_INCOME_CATEGORY_NAME && (c.kind === undefined || c.kind === "income"))?.id ?? null;
}

/** 여러 달의 카테고리별 지출 합계(할부 포함). 연간 비교용. */
export function categorySpendingRange(
  months: string[],
  txns: HhTransaction[],
  installments: HhInstallment[]
): Map<string, number> {
  const out = new Map<string, number>();
  for (const ym of months) {
    for (const [id, v] of categorySpending(ym, txns, installments)) {
      out.set(id, (out.get(id) ?? 0) + v);
    }
  }
  return out;
}

// ── 통계 '추이' 탭: 카테고리별 3/6개월 변동 + 절약 후보 (설계 88) ──────────────

export const TREND_RULES = {
  minorMonthlyAvg: 10_000, // 양쪽 기간 월평균이 모두 이 미만이면 '소액 항목'으로 접음
  riseStreak: 3, // 상승세: 마지막 완결월 N개 연속 증가
  riseMinTotal: 30_000, // 상승세 판정에 필요한 최소 상승폭 합(노이즈 컷)
  discretionaryMinAvg: 100_000, // 재량지출 후보: 최근 월평균 최소액
  discretionaryKeywords: ["외식", "카페", "다과", "간식", "취미", "여가", "문화", "쇼핑"],
  // 저축성 카테고리는 늘어도 낭비가 아니므로 절약 후보에서 제외(증감 목록에는 그대로 표시).
  savingExcludeKeywords: ["적금", "저축", "청약", "투자"],
  maxCandidates: 5,
} as const;

export interface CategoryTrendLine {
  categoryId: string;
  /** 완결월 2N개 지출(오래된 → 최근). 앞 N개=직전 기간, 뒤 N개=최근 기간. */
  months: number[];
  /** 진행 중인 당월 지출(비교 계산 제외, 스파크라인 참고점 전용). */
  currentMonth: number;
  totalRecent: number;
  totalPrev: number;
  recentAvg: number;
  prevAvg: number;
  /** 기간 합 증감(totalRecent - totalPrev). 목록 정렬·막대 기준. */
  diffTotal: number;
  /** 소액(양쪽 기간 월평균 모두 minorMonthlyAvg 미만) — 화면에서 한 줄로 접음. */
  minor: boolean;
}

/**
 * 카테고리별 최근 N개월 vs 직전 N개월 변동. 진행 중인 당월은 비교에서 제외한다
 * (당월을 넣으면 전 카테고리가 '덜 썼다'로 왜곡). baseYm = 마지막 완결월.
 */
export function categoryTrend(
  baseYm: string,
  windowN: number,
  currentYm: string,
  txns: HhTransaction[],
  installments: HhInstallment[]
): CategoryTrendLine[] {
  const monthKeys = Array.from({ length: windowN * 2 }, (_, i) => shiftMonth(baseYm, i - windowN * 2 + 1));
  const spends = monthKeys.map((ym) => categorySpending(ym, txns, installments));
  const currentSpend = categorySpending(currentYm, txns, installments);

  const ids = new Set<string>();
  for (const s of spends) for (const id of s.keys()) ids.add(id);
  for (const id of currentSpend.keys()) ids.add(id);

  const lines: CategoryTrendLine[] = [];
  for (const id of ids) {
    const months = spends.map((s) => s.get(id) ?? 0);
    const totalPrev = months.slice(0, windowN).reduce((a, b) => a + b, 0);
    const totalRecent = months.slice(windowN).reduce((a, b) => a + b, 0);
    const currentMonth = currentSpend.get(id) ?? 0;
    if (totalPrev === 0 && totalRecent === 0 && currentMonth === 0) continue;
    const recentAvg = Math.round(totalRecent / windowN);
    const prevAvg = Math.round(totalPrev / windowN);
    lines.push({
      categoryId: id,
      months,
      currentMonth,
      totalRecent,
      totalPrev,
      recentAvg,
      prevAvg,
      diffTotal: totalRecent - totalPrev,
      minor: recentAvg < TREND_RULES.minorMonthlyAvg && prevAvg < TREND_RULES.minorMonthlyAvg,
    });
  }
  return lines.sort((a, b) => b.diffTotal - a.diffTotal);
}

export type SavingSignal = "surge" | "new" | "rising" | "discretionary";

export interface SavingCandidate {
  categoryId: string;
  signals: SavingSignal[];
  recentAvg: number;
  prevAvg: number;
  /** 직전 기간 수준으로 되돌리면 월 얼마 아끼는지(= 월평균 증가분). 재량 단독이면 0. */
  monthlySaving: number;
}

/**
 * 절약 후보 종합 판정(설계 88). 급증·신규는 과다지출 점검(OVERSPEND_RULES)과 같은
 * 문턱을 재사용하고, 상승세·재량은 TREND_RULES 기준. 월 절약 가능액 내림차순 상위 5개.
 */
export function savingCandidates(
  trend: CategoryTrendLine[],
  categoryNameOf: (id: string) => string
): SavingCandidate[] {
  const out: SavingCandidate[] = [];
  for (const t of trend) {
    if (t.minor) continue;
    const catName = categoryNameOf(t.categoryId);
    if (TREND_RULES.savingExcludeKeywords.some((kw) => catName.includes(kw))) continue;
    const signals: SavingSignal[] = [];
    const diffAvg = t.recentAvg - t.prevAvg;

    if (t.prevAvg === 0) {
      if (t.recentAvg >= OVERSPEND_RULES.newMin) signals.push("new");
    } else if (t.recentAvg >= t.prevAvg * OVERSPEND_RULES.warnRatio && diffAvg >= OVERSPEND_RULES.warnMinDiff) {
      signals.push("surge");
    }

    // 상승세: 마지막 riseStreak개 완결월이 연속 증가 & 상승폭 합이 문턱 이상
    const k = TREND_RULES.riseStreak;
    if (t.months.length >= k) {
      const tail = t.months.slice(-k);
      const rising = tail.every((v, i) => i === 0 || v > tail[i - 1]);
      if (rising && tail[k - 1] - tail[0] >= TREND_RULES.riseMinTotal) signals.push("rising");
    }

    if (
      TREND_RULES.discretionaryKeywords.some((kw) => catName.includes(kw)) &&
      t.recentAvg >= TREND_RULES.discretionaryMinAvg
    ) {
      signals.push("discretionary");
    }

    if (signals.length === 0) continue;
    const structural = signals.some((s) => s !== "discretionary");
    out.push({
      categoryId: t.categoryId,
      signals,
      recentAvg: t.recentAvg,
      prevAvg: t.prevAvg,
      monthlySaving: structural ? Math.max(0, diffAvg) : 0,
    });
  }
  return out
    .sort((a, b) => b.monthlySaving - a.monthlySaving || b.recentAvg - a.recentAvg)
    .slice(0, TREND_RULES.maxCandidates);
}
