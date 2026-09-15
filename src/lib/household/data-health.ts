// 데이터 건강도 — 숫자를 얼마나 믿어도 되는지 스스로 드러내는 지표. (설계 91 §4)
//
// 통계가 정확해 보이는 것과 실제로 정확한 것은 다르다. 입력이 비어 있거나 중복이면
// 화면은 여전히 그럴듯한 숫자를 보여주는데, 그게 가장 위험하다.
// 여기서는 "숨은 공백"만 센다 — 설계상 의도된 공란은 문제로 세지 않는다.
import type { HhCategory, HhPaymentMethod, HhTransaction } from "./types";
import { LOAN_CATEGORY_NAME } from "./calc";

export type HealthLevel = "ok" | "warn" | "bad";

export type HealthItem = {
  key: string;
  label: string;
  /** 사람이 읽는 값. 0건이면 "없음" */
  value: string;
  level: HealthLevel;
  /** 왜 이게 문제인지 — 화면에서 접어 보여준다 */
  hint: string;
};

export type DataHealth = {
  items: HealthItem[];
  /** 하나라도 warn/bad 면 통계를 '참고용'으로 봐야 한다 */
  worst: HealthLevel;
};

const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;

/** ISO 타임스탬프를 서울 기준 날짜(YYYY-MM-DD)로. */
function seoulDateOf(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

/** 두 날짜(YYYY-MM-DD) 사이의 달력 일수. 시각은 보지 않는다. */
function calendarDaysBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

/**
 * 거래·마스터를 훑어 건강도 항목을 만든다.
 *
 * ★계좌 미지정을 셀 때 신용카드 지출은 제외한다 — 설계 70상 신용카드 지출은 account_id 를
 *   비우는 게 정상이고, 실제 출금은 월 카드대금(payment)에서 잡힌다. 이걸 문제로 세면
 *   400건짜리 가짜 경고가 떠서 진짜 문제를 덮는다.
 */
export function computeDataHealth(input: {
  txns: HhTransaction[];
  categories: HhCategory[];
  paymentMethods: HhPaymentMethod[];
  /** 마지막 수집(inbox) 시각 ISO. 없으면 null */
  lastIngestAt: string | null;
  /** 오늘 날짜 YYYY-MM-DD (테스트 주입용) */
  today: string;
}): DataHealth {
  const { txns, categories, paymentMethods, lastIngestAt, today } = input;
  const items: HealthItem[] = [];

  // 1) 카테고리 미지정 — 이체는 카테고리가 없는 게 정상이다.
  const noCat = txns.filter((t) => t.type !== "transfer" && !t.category_id);
  const noCatSum = noCat.reduce((s, t) => s + Number(t.amount ?? 0), 0);
  items.push({
    key: "uncategorized",
    label: "미분류 거래",
    value: noCat.length ? `${noCat.length}건 · ${won(noCatSum)}` : "없음",
    level: noCat.length === 0 ? "ok" : noCatSum >= 1_000_000 ? "bad" : "warn",
    hint: "카테고리가 없으면 그 금액은 항목별 통계 어디에도 안 잡힌다. 합계는 맞는데 내역이 비는 상태.",
  });

  // 2) 즉시출금 수단인데 계좌 미연결 — 선불·체크는 결제 즉시 잔액이 빠져야 한다.
  //    신용카드는 여기서 제외(설계 70).
  const instantPmIds = new Set(
    paymentMethods.filter((p) => ["cash", "check"].includes(p.kind) && p.linked_account_id).map((p) => p.id)
  );
  const unlinkedInstant = txns.filter(
    (t) => t.type === "expense" && !t.account_id && t.payment_method_id && instantPmIds.has(t.payment_method_id)
  );
  const unlinkedSum = unlinkedInstant.reduce((s, t) => s + Number(t.amount ?? 0), 0);
  items.push({
    key: "unlinked-account",
    label: "계좌 미연결 (선불·체크)",
    value: unlinkedInstant.length ? `${unlinkedInstant.length}건 · ${won(unlinkedSum)}` : "없음",
    level: unlinkedInstant.length === 0 ? "ok" : "warn",
    hint: "선불·체크카드는 결제 즉시 계좌에서 빠진다. 계좌가 안 붙으면 그 계좌 잔액이 실제보다 많아 보인다. (신용카드는 카드대금에서 빠지므로 정상)",
  });

  // 3) 대출 상환 미연결 — 어느 대출인지 모르면 대출 통계가 불완전하다. (설계 92)
  const loanCat = categories.find((c) => c.name === LOAN_CATEGORY_NAME);
  if (loanCat) {
    const repay = txns.filter((t) => t.type === "payment" && t.category_id === loanCat.id);
    const unlinked = repay.filter((t) => !t.loan_id);
    const unlinkedLoanSum = unlinked.reduce((s, t) => s + Number(t.amount ?? 0), 0);
    const rate = repay.length ? Math.round(((repay.length - unlinked.length) / repay.length) * 100) : 100;
    items.push({
      key: "loan-unlinked",
      label: "대출 미연결 상환",
      value: unlinked.length ? `${unlinked.length}건 · ${won(unlinkedLoanSum)} (연결률 ${rate}%)` : "없음",
      level: unlinked.length === 0 ? "ok" : rate < 50 ? "bad" : "warn",
      hint: "어느 대출의 상환인지 연결돼 있지 않으면 대출별 잔액·상환 진척을 낼 수 없다. 이미 다 갚아 마스터가 없는 과거 대출이 대부분이다.",
    });
  }

  // 4) 완전동일 중복 후보 — 날짜·유형·금액·상대처·계좌가 모두 같은 거래.
  const seen = new Map<string, number>();
  for (const t of txns) {
    const k = `${t.type}|${t.amount}|${t.account_id}|${t.from_account_id}|${t.to_account_id}|${t.txn_date}|${t.counterparty}`;
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  const dupGroups = [...seen.values()].filter((n) => n > 1).length;
  items.push({
    key: "duplicates",
    label: "완전동일 중복 후보",
    value: dupGroups ? `${dupGroups}그룹` : "없음",
    level: dupGroups === 0 ? "ok" : dupGroups >= 10 ? "bad" : "warn",
    hint: "모든 항목이 같은 거래가 두 번 있다. 같은 날 같은 금액을 실제로 두 번 썼을 수도 있어 자동 삭제는 하지 않는다 — 확인이 필요하다는 표시다.",
  });

  // 5) 수집 공백 — 문자·알림이 며칠째 안 들어오면 폰 쪽이 끊긴 것이다.
  if (lastIngestAt) {
    // ★달력 일수로 센다. 타임스탬프 차이를 그대로 나누면 "그저께 08시 → 오늘 00시"가
    //   40시간이라 1일로 깎여 경고가 안 뜬다(회귀 테스트로 잡힌 실제 버그).
    const days = calendarDaysBetween(seoulDateOf(lastIngestAt), today);
    items.push({
      key: "ingest-gap",
      label: "마지막 수집",
      value: days <= 0 ? "오늘" : `${days}일 전`,
      level: days <= 1 ? "ok" : days <= 3 ? "warn" : "bad",
      hint: "폰의 문자·알림 수집이 끊기면 거래가 통째로 안 들어온다. 화면엔 '지출이 줄었다'로 보여서 알아채기 어렵다.",
    });
  }

  const worst: HealthLevel = items.some((i) => i.level === "bad")
    ? "bad"
    : items.some((i) => i.level === "warn")
      ? "warn"
      : "ok";
  return { items, worst };
}
