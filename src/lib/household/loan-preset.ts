// 설계 182 — 수집함 카드론 행 → 대출 팝업 프리필. 순수 함수만(next 의존 없음, 테스트 대상).
import type { LoanFormState } from "@/lib/household/loan-save";
import type { HhAccount, HhLoan, HhTransactionInbox } from "@/lib/household/types";

// 카드사 표기는 정본 별칭표(card-issuer.ts)로 — 'KB국민카드'·'KB카드' → '국민카드'. 은행명(국민은행)은 카드사가 아니라 null.
export { cardIssuerLabel } from "@/lib/household/card-issuer";
import { cardIssuerLabel } from "@/lib/household/card-issuer";
import { isCardLoan } from "@/lib/household/category-names";

/** '국민은행(홍길동)' → '홍길동' (마지막 괄호 안). 없으면 null. */
export function ownerFromAccountName(name: string | null | undefined): string | null {
  const m = (name ?? "").match(/\(([^()]*)\)\s*$/);
  const v = m?.[1]?.trim();
  return v || null;
}

type InboxForPreset = Pick<
  HhTransactionInbox,
  "guessed_institution" | "guessed_amount" | "guessed_date" | "guessed_account_id" | "guessed_loan_terms"
>;

/**
 * 프리필 값. ★`monthly_payment`·`payment_day` 는 넣지 않는다 — 카드론 원리금은 카드대금에 섞여 나가므로
 * 채우면 현금흐름에 이중계상된다(설계 176). 이름은 `{카드사}-{명의}-카드론({YY.MM})`, 명의는 입금계좌 이름의 괄호 안.
 */
export function loanPresetFromInbox(
  item: InboxForPreset,
  accounts: Pick<HhAccount, "id" | "name">[]
): Partial<LoanFormState> {
  const issuer = cardIssuerLabel(item.guessed_institution);
  const account = item.guessed_account_id ? accounts.find((a) => a.id === item.guessed_account_id) : undefined;
  const owner = ownerFromAccountName(account?.name);
  const ym = item.guessed_date && /^\d{4}-\d{2}/.test(item.guessed_date) ? `(${item.guessed_date.slice(2, 4)}.${item.guessed_date.slice(5, 7)})` : "";
  // ★대출명 첫 마디는 장식이 아니다 — loan-estimate.cardIssuerOf 가 첫 마디를 카드사로 읽어 카드대금 실납 판정에 쓴다.
  //   기관명이 카드사가 아니면(은행 입금 통지 등) 이름을 만들지 않는다 → 폼 검증이 막아 사람이 직접 적는다(설계 105, 리뷰 Critical).
  const name = issuer ? [issuer, owner, `카드론${ym}`].filter(Boolean).join("-") : "";
  const terms = item.guessed_loan_terms;
  const amount = item.guessed_amount ?? 0;
  return {
    name,
    origin_date: item.guessed_date ?? "",
    principal: amount,
    current_balance: amount,
    maturity_date: terms?.maturity_date ?? "",
    interest_rate: terms?.rate ?? "",
    repayment_type: terms?.repayment_type ?? "",
    // ★account_id 는 hh_loan 의 **출금(결제)계좌**다. 수집함의 guessed_account_id 는 실행금이 들어온 계좌라 다를 수 있어
    //   채우지 않는다 — 틀리면 카드대금 실납 판정이 조용히 false 가 된다(설계 105 빈칸 > 오값, 리뷰 Medium).
    account_id: "",
    status: "active",
  };
}

const DAY_MS = 86_400_000;

/** 같은 원금이고 실행일이 ±3일 안인 **카드론**(이미 등록됨 — 닫힌 것도 포함해서 호출부가 전체 대출을 넘긴다). 여럿이면 날짜가 가장 가까운 것. */
export function findRegisteredLoan<L extends Pick<HhLoan, "id" | "name" | "principal" | "origin_date">>(
  item: Pick<HhTransactionInbox, "guessed_amount" | "guessed_date">,
  loans: L[]
): L | null {
  if (item.guessed_amount == null || !item.guessed_date) return null;
  const base = Date.parse(item.guessed_date);
  if (Number.isNaN(base)) return null;
  let best: { loan: L; diff: number } | null = null;
  for (const loan of loans) {
    // 카드론끼리만 — 같은 주에 실행된 다른 대출(둥근 원금)이 「등록됨」으로 잡혀 등록 경로를 막지 않게(리뷰 Medium)
    if (!isCardLoan(loan)) continue;
    if (loan.principal !== item.guessed_amount || !loan.origin_date) continue;
    const d = Date.parse(loan.origin_date);
    if (Number.isNaN(d)) continue;
    const diff = Math.abs(d - base) / DAY_MS;
    if (diff > 3) continue;
    if (!best || diff < best.diff) best = { loan, diff };
  }
  return best?.loan ?? null;
}
