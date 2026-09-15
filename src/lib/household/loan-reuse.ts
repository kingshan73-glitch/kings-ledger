export const GENERIC_PAYEE = /^(?:저축은행|은행|카드|캐피탈|보험|대출|금고|신협|수협|우체국|증권)$/;

export interface PriorLoanPayment {
  counterparty: string | null;
  amount: number;
  loan_id: string | null;
  txn_date: string;
}

interface ReusableLoanInput {
  merchant: string | null;
  amount: number;
  priorPayments: PriorLoanPayment[];
  activeLoanIds: Set<string>;
  asOfDate: string;
}

export function normalizeLoanPayee(value: string | null): string {
  return (value ?? "").replace(/\s+/g, "").toLowerCase();
}

function isoDay(iso: string): number | null {
  const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const time = Date.UTC(year, month - 1, day);
  const parsed = new Date(time);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) return null;
  return Math.floor(time / 86_400_000);
}

/** 같은 상호로 확정된 최근 납부가 한 활성 대출만 가리킬 때 그 대출을 재사용한다. (설계 194) */
export function pickReusableLoan(input: ReusableLoanInput): string | null {
  const merchant = normalizeLoanPayee(input.merchant);
  if (merchant.length < 3 || GENERIC_PAYEE.test(merchant)) return null;

  const asOfDay = isoDay(input.asOfDate);
  if (asOfDay == null || !Number.isFinite(input.amount) || input.amount < 0) return null;

  const matches = input.priorPayments.filter((payment) => {
    if (!payment.loan_id || normalizeLoanPayee(payment.counterparty) !== merchant) return false;
    const txnDay = isoDay(payment.txn_date);
    if (txnDay == null) return false;
    const ageDays = asOfDay - txnDay;
    return ageDays >= 0 && ageDays <= 400 && Number.isFinite(payment.amount) && payment.amount >= 0;
  });
  if (matches.length === 0) return null;

  const loanIds = new Set(matches.map((payment) => payment.loan_id as string));
  if (loanIds.size !== 1) return null;
  const [loanId] = loanIds;
  if (!input.activeLoanIds.has(loanId)) return null;

  // ★밴드의 기준은 지난 금액들의 **중앙값 하나**다 — min~max 스팬을 ±15% 로 벌리면 중도상환 1건이 섞이는 순간
  //   그 사이 아무 출금이나 payment 로 승격된다(배포 전 리뷰 High). 이자 변동 흡수엔 대표값 ±15% 면 충분하다.
  const amounts = matches.map((payment) => payment.amount).sort((a, b) => a - b);
  const ref = amounts[Math.floor(amounts.length / 2)];
  if (!(ref > 0)) return null;
  return input.amount >= ref * 0.85 && input.amount <= ref * 1.15 ? loanId : null;
}
