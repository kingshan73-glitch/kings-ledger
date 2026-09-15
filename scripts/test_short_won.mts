// 월별 흐름 막대 위 짧은 금액 라벨 포맷 회귀 테스트 (설계 192)
const chart = await import("../src/components/household/monthly-flow-chart");
const { shortWon } = chart;

const cases: Array<[number, string, string]> = [
  [0, "", "0은 빈 라벨"],
  [9_999, "9,999", "1만원 미만은 원 단위 숫자만"],
  [10_000, "1만", "1만원 경계"],
  [123_456, "12만", "만원 단위 반올림"],
  [28_700_000, "2,870만", "1억원 미만 천 단위 구분"],
  [100_000_000, "1억", "1억원 경계"],
  [150_000_000, "1.5억", "억원 소수 첫째 자리"],
  [-123_456, "-12만", "음수는 부호를 보존하고 절댓값과 같은 규칙"],
  [9_999.5, "1만", "원 단위 반올림이 1만을 넘으면 만 단위로 승격"],
  [99_995_000, "1억", "만 단위 반올림이 1억을 넘으면 억 단위로 승격"],
  [99_994_999, "9,999만", "승격 직전 경계"],
];

let pass = 0;
let fail = 0;
for (const [input, expected, label] of cases) {
  const actual = shortWon(input);
  if (actual === expected) {
    pass += 1;
    console.log(`  OK ${label}: ${JSON.stringify(actual)}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

console.log(`\nResult: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
