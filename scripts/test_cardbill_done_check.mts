// 설계 205-A — 카드대금 출금완료 안내와 수집함/장부 증거의 순수 매칭 테스트(DB 불필요).
const {
  CARD_BILL_DONE_EVIDENCE_STATUSES,
  CARD_BILL_DONE_GRACE_DAYS,
  cardBillDoneCollectedBefore,
  cardBillDoneNoticeDateRange,
  findUnmatchedCardBillNotices,
} = await import("../src/lib/household/cardbill-done-check");

let failures = 0;
function check(name: string, condition: boolean, detail?: string) {
  if (condition) console.log(`  ✅ ${name}`);
  else {
    failures++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const notice = { id: "notice-1", guessed_date: "2026-09-10", guessed_amount: 1_503_040 };
const unmatchedIds = (
  notices: Array<{ id: string; guessed_date: string | null; guessed_amount: number | string | null }>,
  inbox: Array<{ id: string; guessed_date: string | null; guessed_amount: number | string | null }> = [],
  txns: Array<{ txn_date: string | null; amount: number | string | null }> = [],
) => findUnmatchedCardBillNotices(notices, inbox, txns).map((row) => row.id).join(",");

console.log("① 같은 금액·날짜 창의 증거는 안내의 짝이다");
check("수집함 증거 매칭", unmatchedIds([notice], [{ id: "inbox-1", guessed_date: "2026-09-10", guessed_amount: 1_503_040 }]) === "");
check("장부 증거 매칭", unmatchedIds([notice], [], [{ txn_date: "2026-09-11", amount: 1_503_040 }]) === "");
check("정확히 3일 경계 매칭", unmatchedIds([notice], [{ id: "inbox-1", guessed_date: "2026-09-07", guessed_amount: 1_503_040 }]) === "");

console.log("\n② 조회 범위 계산값과 증거 상태 상수(★실제 쿼리에 붙었는지는 이 테스트가 못 본다 — page.tsx fetchCardBillDoneCheck)");
check("수신 24시간 유예", cardBillDoneCollectedBefore(new Date("2026-09-11T00:05:00+09:00")) === "2026-09-09T15:05:00.000Z", cardBillDoneCollectedBefore(new Date("2026-09-11T00:05:00+09:00")));
const dateRange = cardBillDoneNoticeDateRange("2026-09-11");
check("유예일은 1일", CARD_BILL_DONE_GRACE_DAYS === 1);
check("60일 하한", dateRange.lowerBound === "2026-07-13", dateRange.lowerBound);
check("어제 상한", dateRange.upperBound === "2026-09-10", dateRange.upperBound);
check("증거 상태는 pending/confirmed/archived", CARD_BILL_DONE_EVIDENCE_STATUSES.join(",") === "pending,confirmed,archived");

console.log("\n③ 범위 밖·다른 금액·자기 자신은 짝이 아니다");
check("4일 차이는 미매칭", unmatchedIds([notice], [{ id: "inbox-1", guessed_date: "2026-09-06", guessed_amount: 1_503_040 }]) === "notice-1");
check("다른 금액은 미매칭", unmatchedIds([notice], [{ id: "inbox-1", guessed_date: "2026-09-10", guessed_amount: 1_503_041 }]) === "notice-1");
check("같은 id의 수집함 행은 자기 자신이라 제외", unmatchedIds([notice], [{ ...notice, guessed_amount: "1503040" }]) === "notice-1");

console.log("\n④ Supabase numeric 문자열과 빈 입력을 안전하게 처리한다");
check("문자열 금액과 숫자 금액 매칭", unmatchedIds([{ ...notice, guessed_amount: "1503040" }], [], [{ txn_date: "2026-09-10", amount: 1_503_040 }]) === "");
check("빈 안내 입력", unmatchedIds([], [], []) === "");
check("증거가 모두 비면 안내 유지", unmatchedIds([notice], [], []) === "notice-1");

console.log(failures === 0 ? "\n✅ 전부 통과" : `\n❌ ${failures}건 실패`);
process.exitCode = failures === 0 ? 0 : 1;
