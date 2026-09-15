// 수입 원장 통계 카드의 번 돈/빌린 돈 분리 회귀 테스트 (설계 190 후속)
import { isDeepStrictEqual } from "node:util";

const { splitIncomeByLoan } = await import("../src/lib/household/income-split");

let pass = 0;
let fail = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { pass += 1; console.log(`  OK ${msg}`); }
  else { fail += 1; console.log(`  FAIL ${msg}`); }
}

const relativeDate = (offsetDays: number): string => {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + offsetDays);
  return date.toISOString().slice(0, 10);
};

const CAT = { earned: "cat-earned", borrowed: "cat-borrowed", other: "cat-other" };
const row = (id: string, category_id: string | null, amount: number, offsetDays: number) => ({
  id,
  category_id,
  amount,
  txn_date: relativeDate(offsetDays),
});
const sum = (rows: Array<{ amount: number }>) => rows.reduce((total, item) => total + item.amount, 0);

{
  const rows = [
    row("earned-1", CAT.earned, 3_000_000, -2),
    row("borrowed-1", CAT.borrowed, 8_000_000, -1),
    row("earned-2", CAT.other, 50_000, 0),
  ];
  const split = splitIncomeByLoan(rows, CAT.borrowed);
  ok(
    isDeepStrictEqual(split.earned.map((item) => item.id), ["earned-1", "earned-2"])
      && isDeepStrictEqual(split.borrowed.map((item) => item.id), ["borrowed-1"])
      && sum(split.earned) === 3_050_000
      && sum(split.borrowed) === 8_000_000,
    "대출 행이 있으면 번 돈과 빌린 돈을 분리한다"
  );
}

{
  const rows = [
    row("earned-1", CAT.earned, 2_000_000, 1),
    row("earned-2", CAT.other, 70_000, 2),
  ];
  const split = splitIncomeByLoan(rows, CAT.borrowed);
  ok(
    isDeepStrictEqual(split.earned, rows) && split.borrowed.length === 0,
    "대출 행이 없으면 모든 행을 번 돈으로 유지한다"
  );
}

{
  const rows = [row("unclassified", CAT.borrowed, 9_000_000, 3)];
  const split = splitIncomeByLoan(rows, null);
  ok(
    isDeepStrictEqual(split.earned, rows) && split.borrowed.length === 0,
    "대출 카테고리 id가 null이면 모든 행을 번 돈으로 유지한다"
  );
}

// ── incomeStats: 페이지가 그리는 판정·합계·월평균을 여기서 못박는다(배포 전 교차리뷰 — 페이지 인라인은 테스트가 못 잡았다) ──
const { incomeStats } = await import("../src/lib/household/income-split");
{
  const rows = [row("e1", CAT.earned, 3_000_000, -2), row("b1", CAT.borrowed, 8_000_000, -1), row("e2", CAT.other, 50_000, 0)];
  const s = incomeStats(rows, CAT.borrowed, 1);
  ok(s.hasBorrowed && s.statIncomeTotal === 3_050_000 && s.borrowedTotal === 8_000_000 && s.monthlyAvg === 3_050_000,
    "대출 행이 있으면 첫 카드·월평균은 대출 제외, 대출실행은 따로");
  const s3 = incomeStats(rows, CAT.borrowed, 3);
  ok(s3.monthlyAvg === Math.round(3_050_000 / 3), "월평균은 대출 제외 합계 ÷ 걸친 월 수");
}
{
  const rows = [row("e1", CAT.earned, 2_000_000, 1), row("e2", CAT.other, 70_000, 2)];
  const s = incomeStats(rows, CAT.borrowed, 1);
  ok(!s.hasBorrowed && s.statIncomeTotal === 2_070_000 && s.borrowedTotal === 0 && s.monthlyAvg === 2_070_000,
    "대출 행이 없으면 종전과 같은 전체 합계");
}
{
  const rows = [row("e1", CAT.earned, 1_000_000, -1), row("b0", CAT.borrowed, 0, 0)];
  const s = incomeStats(rows, CAT.borrowed, 1);
  ok(s.hasBorrowed && s.statIncomeTotal === 1_000_000 && s.borrowedTotal === 0,
    "0원 대출 행도 '행 존재'로 판정한다(합계>0 으로 가르면 접힌다)");
}
{
  const rows = [row("b1", CAT.borrowed, 5_000_000, 0)];
  const s = incomeStats(rows, null, 1);
  ok(!s.hasBorrowed && s.statIncomeTotal === 5_000_000, "대출 카테고리 id 가 null 이면 분리하지 않는다");
  ok(incomeStats([], CAT.borrowed, 0).monthlyAvg === 0, "행 0건·월 0 이어도 NaN 이 아니다");
}

console.log(`\nResult: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
