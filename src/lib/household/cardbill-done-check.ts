import { shiftIsoDate } from "./sms";

/** 카드대금 사후 안내 점검 범위. (설계 205-A) */
export const CARD_BILL_DONE_LOOKBACK_DAYS = 60;
export const CARD_BILL_DONE_GRACE_DAYS = 1;
/** 받은 뒤 24시간 유예 — 날짜 유예만으로는 23:58 에 온 안내가 몇 분 만에 대상이 된다(ship 교차리뷰 Claude L1). */
export const CARD_BILL_DONE_GRACE_HOURS = 24;
export const CARD_BILL_DONE_MATCH_WINDOW_DAYS = 3;
export const CARD_BILL_DONE_TRACE_PREFIX = "trace|";
export const CARD_BILL_DONE_QUERY_LIMIT = 1000;
export const CARD_BILL_DONE_EVIDENCE_STATUSES = ["pending", "confirmed", "archived"] as const;

type NumericAmount = number | string | null;

export type CardBillDoneNotice = {
  id: string;
  guessed_date: string | null;
  guessed_amount: NumericAmount;
};

export type CardBillDoneInboxEvidence = {
  id: string;
  guessed_date: string | null;
  guessed_amount: NumericAmount;
};

export type CardBillDoneTxnEvidence = {
  txn_date: string | null;
  amount: NumericAmount;
};

function calendarDay(date: string | null): number | null {
  const match = date?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return Math.floor(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86_400_000);
}

function amountNumber(amount: NumericAmount): number | null {
  const value = typeof amount === "string" ? Number(amount) : amount;
  return value != null && Number.isFinite(value) ? value : null;
}

/** 이 시각 이전에 받은(collected_at) 안내만 점검 대상 — 은행 문자가 늦게 올 틈을 준다. */
export function cardBillDoneCollectedBefore(now: Date): string {
  return new Date(now.getTime() - CARD_BILL_DONE_GRACE_HOURS * 3_600_000).toISOString();
}

/** 카드대금 사후 안내 조회의 60일 하한과 1일 유예 상한. */
export function cardBillDoneNoticeDateRange(today: string): { lowerBound: string; upperBound: string } {
  return {
    lowerBound: shiftIsoDate(today, -CARD_BILL_DONE_LOOKBACK_DAYS),
    upperBound: shiftIsoDate(today, -CARD_BILL_DONE_GRACE_DAYS),
  };
}

function sameAmountNearDate(
  noticeDate: number,
  noticeAmount: number,
  evidenceDate: string | null,
  evidenceAmount: NumericAmount,
): boolean {
  const day = calendarDay(evidenceDate);
  const amount = amountNumber(evidenceAmount);
  return day != null && amount != null && amount === noticeAmount && Math.abs(day - noticeDate) <= CARD_BILL_DONE_MATCH_WINDOW_DAYS;
}

/** 같은 금액의 휴지통 밖 수집함/장부 증거가 ±3일 안에 없는 카드대금 사후 안내만 돌려준다. */
export function findUnmatchedCardBillNotices<T extends CardBillDoneNotice>(
  notices: readonly T[],
  inboxEvidence: readonly CardBillDoneInboxEvidence[],
  txnEvidence: readonly CardBillDoneTxnEvidence[],
): T[] {
  return notices.filter((notice) => {
    const noticeDate = calendarDay(notice.guessed_date);
    const noticeAmount = amountNumber(notice.guessed_amount);
    if (noticeDate == null || noticeAmount == null) return true;

    const hasInboxMatch = inboxEvidence.some((evidence) =>
      evidence.id !== notice.id && sameAmountNearDate(noticeDate, noticeAmount, evidence.guessed_date, evidence.guessed_amount),
    );
    if (hasInboxMatch) return false;

    return !txnEvidence.some((evidence) =>
      sameAmountNearDate(noticeDate, noticeAmount, evidence.txn_date, evidence.amount),
    );
  });
}
