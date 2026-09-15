// 변동 지출 추정 단위 테스트 (설계 173)
//
// ★여기서 고정하는 것은 "평균을 잘 내는가"가 아니라 **예측이 거짓말하지 않는가**다.
//   ⓐ일회성 거액이 평균을 망치지 않는가 ⓑ이번 달에 이미 나간 돈을 두 번 빼지 않는가.
import { strict as assert } from "node:assert";

const { variableSpendOfMonth, fixedCategoryIdsOf, variableSpendAverage, firstMonthVariableSpend, daysInYm, buildVariableSpendInput } =
  await import("../src/lib/household/variable-spend");

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ❌ ${name}\n     ${(e as Error).message}`); }
};

// ── 그 달 변동 지출 (카테고리 기준) ──────────────────────────────────
const FIXED = fixedCategoryIdsOf([
  { direction: "out", category_id: "c-edu" },   // 학원비 정기지출
  { direction: "out", category_id: "c-loan" },  // 대출상환
  { direction: "in", category_id: "c-salary" }, // 수입은 기준에 안 든다
  { direction: "out", category_id: null },      // 카테고리 없는 정기지출은 무시
]);
const TX = [
  { txn_date: "2026-07-03", type: "expense", amount: 30_000, category_id: "c-food" },   // 변동 ○
  { txn_date: "2026-07-05", type: "expense", amount: 200_000, category_id: "c-edu" },   // 정기 카테고리 ✗
  { txn_date: "2026-07-06", type: "payment", amount: 500_000, category_id: "c-loan" },  // payment ✗
  { txn_date: "2026-07-07", type: "transfer", amount: 100_000, category_id: null },     // transfer ✗
  { txn_date: "2026-06-30", type: "expense", amount: 90_000, category_id: "c-food" },   // 다른 달 ✗
  { txn_date: "2026-07-09", type: "expense", amount: 12_000, category_id: null },       // 카테고리 없음 ○
];

test("정기지출이 쓰는 카테고리 집합 — 나가는 쪽만, 빈 값은 뺀다", () => {
  assert.equal(FIXED.has("c-edu"), true);
  assert.equal(FIXED.has("c-loan"), true);
  assert.equal(FIXED.has("c-salary"), false);
  assert.equal(FIXED.size, 2);
});

test("★변동 지출은 expense 만 세고, 정기 카테고리·다른 달은 뺀다", () => {
  assert.equal(variableSpendOfMonth(TX, "2026-07", FIXED), 30_000 + 12_000);
});

test("★payment·transfer 는 세지 않는다 (카드대금·대출상환은 이미 예정에 있다)", () => {
  const only = TX.filter((t) => t.type !== "expense");
  assert.equal(variableSpendOfMonth(only, "2026-07", FIXED), 0);
});

test("표본 3개월 평균", () => {
  // 실측(2026-08-14): 카테고리 기준 5월 273만 · 6월 367만 · 7월 227만
  const r = variableSpendAverage([
    { ym: "2026-05", amount: 2_732_786 },
    { ym: "2026-06", amount: 3_673_565 },
    { ym: "2026-07", amount: 2_273_545 },
  ]);
  assert.equal(r.used.length, 3);
  assert.equal(r.excluded.length, 0);
  assert.equal(r.monthly, Math.round((2_732_786 + 3_673_565 + 2_273_545) / 3));
});

test("★★일회성 거액이 든 달은 뺀다 — 카드론 철회 1,506만이 실제로 있었다", () => {
  const r = variableSpendAverage([
    { ym: "2026-06", amount: 1_664_603 },
    { ym: "2026-07", amount: 2_677_628 },
    { ym: "2026-08", amount: 18_568_319 }, // 일회성 거액이 섞인 달
  ]);
  assert.deepEqual(r.excluded.map((e) => e.ym), ["2026-08"]);
  assert.equal(r.monthly, Math.round((1_664_603 + 2_677_628) / 2));
});

test("★뺐다는 사실을 숨기지 않는다 (화면에 이유를 적기 위해 목록으로 낸다)", () => {
  const r = variableSpendAverage([
    { ym: "2026-06", amount: 1_000_000 },
    { ym: "2026-07", amount: 1_100_000 },
    { ym: "2026-08", amount: 28_000_000 },
  ]);
  assert.equal(r.excluded.length, 1);
  assert.ok(r.excluded[0].amount > 20_000_000);
});

test("★표본이 2개 이하면 이상치 제외를 하지 않는다 (중앙값이 불안정)", () => {
  const r = variableSpendAverage([
    { ym: "2026-07", amount: 1_000_000 },
    { ym: "2026-08", amount: 28_000_000 },
  ]);
  assert.equal(r.excluded.length, 0);
  assert.equal(r.used.length, 2);
});

test("표본이 없으면 0 (기능이 조용히 꺼진 것과 같다)", () => {
  const r = variableSpendAverage([]);
  assert.equal(r.monthly, 0);
  assert.deepEqual(r.used, []);
});

test("★★0원 표본이 섞이면 진짜 실적이 이상치로 죽는다 — 그래서 호출부가 빈 달을 빼야 한다", () => {
  // 거래가 아예 없는 달을 0원으로 넣으면 중앙값이 0이 되고 cap 도 0이라 유일한 실적 월이 제외된다.
  // 이 성질을 여기 못 박아 둔다 — 화면(fetchVariableSpendSamples)이 **거래 없는 달을 표본에서 뺀다.**
  // (교차리뷰 2026-08-14, Codex 가 재현해 보였다.)
  const bad = variableSpendAverage([
    { ym: "2026-05", amount: 0 },
    { ym: "2026-06", amount: 0 },
    { ym: "2026-07", amount: 3_000_000 },
  ]);
  assert.equal(bad.monthly, 0);
  assert.deepEqual(bad.excluded.map((e) => e.ym), ["2026-07"]);
  // 빈 달을 빼면 정상으로 돌아온다.
  const good = variableSpendAverage([{ ym: "2026-07", amount: 3_000_000 }]);
  assert.equal(good.monthly, 3_000_000);
});

// ── 이번 달 몫 — 이미 나간 돈을 두 번 빼지 않는다 ──────────────────────
test("★1일이면 전액, 말일이면 하루치만", () => {
  assert.equal(firstMonthVariableSpend(3_100_000, 1, 31), 3_100_000);
  assert.equal(firstMonthVariableSpend(3_100_000, 31, 31), 100_000);
});

test("★★14일이면 남은 18일치만 더한다 (설계 110 의 이중차감 함정을 반복하지 않는다)", () => {
  // 8/14 기준 남은 일수 = 31 - 14 + 1 = 18
  assert.equal(firstMonthVariableSpend(3_100_000, 14, 31), Math.round((3_100_000 * 18) / 31));
});

test("월평균이 0이거나 값이 이상하면 0 (예측에 쓰레기를 넣지 않는다)", () => {
  assert.equal(firstMonthVariableSpend(0, 14, 31), 0);
  assert.equal(firstMonthVariableSpend(3_000_000, NaN, 31), 0);
  assert.equal(firstMonthVariableSpend(3_000_000, 14, 0), 0);
});

test("★말일을 넘긴 날짜여도 음수가 되지 않는다", () => {
  assert.equal(firstMonthVariableSpend(3_100_000, 40, 31), 0);
});

test("월별 일수 — 윤년 2월 포함", () => {
  assert.equal(daysInYm("2026-08"), 31);
  assert.equal(daysInYm("2026-09"), 30);
  assert.equal(daysInYm("2026-02"), 28);
  assert.equal(daysInYm("2024-02"), 29);
});

// ── 화면이 넘길 값 만들기 (현황·현금흐름 두 화면이 공유, 설계 79) ───────
const SAMPLES = [
  { ym: "2026-05", amount: 2_732_786 },
  { ym: "2026-06", amount: 3_673_565 },
  { ym: "2026-07", amount: 2_273_545 },
];

test("★끄면 0 — 기존 동작과 완전히 같아진다", () => {
  const r = buildVariableSpendInput(SAMPLES, "2026-08", 14, false);
  assert.equal(r.input.monthly, 0);
  assert.equal(r.input.firstMonth, 0);
  assert.ok(r.estimate.monthly > 0); // 추정치 자체는 화면에 보여줄 수 있어야 한다
});

test("켜면 평균과 남은 일수 비례분을 함께 낸다", () => {
  const r = buildVariableSpendInput(SAMPLES, "2026-08", 14, true);
  assert.equal(r.input.monthly, r.estimate.monthly);
  assert.equal(r.input.firstMonth, Math.round((r.estimate.monthly * 18) / 31));
});

test("★팀장이 조정한 값이 있으면 평균 대신 그 값을 쓴다", () => {
  const r = buildVariableSpendInput(SAMPLES, "2026-08", 14, true, 3_000_000);
  assert.equal(r.input.monthly, 3_000_000);
  assert.equal(r.input.firstMonth, Math.round((3_000_000 * 18) / 31));
});

test("조정값 0도 존중한다 (0 = 이번 달엔 안 더한다)", () => {
  const r = buildVariableSpendInput(SAMPLES, "2026-08", 14, true, 0);
  assert.equal(r.input.monthly, 0);
  assert.equal(r.input.firstMonth, 0);
});

// ── 예측 전 구간에 반영되는가 (커밋 직전에 발견한 결함) ────────────────
const { projectMonths } = await import("../src/lib/household/calc");

test("★★3개월째에도 변동 지출이 들어간다 — 맵에 없는 달이 빠지면 뒤로 갈수록 낙관적이 된다", () => {
  // outflowByYm 에는 첫 달·익월만 넣는다(호출부가 이미 더해서). 3개월째부터는 extraMonthlyOut 이 맡는다.
  const base = { scheduled: [], loans: [], installments: [] };
  const withVs = projectMonths(0, "2026-08", 3, base, new Set(), new Map([["2026-08", 100], ["2026-09", 200]]), undefined, 3_000_000);
  assert.equal(withVs[0].outflow, 100); // 맵 값 그대로(이미 포함)
  assert.equal(withVs[1].outflow, 200); // 맵 값 그대로
  assert.equal(withVs[2].outflow, 3_000_000); // ← 맵에 없으니 여기서 더해진다
});

test("변동 지출이 0이면 3개월째도 예전과 같다", () => {
  const base = { scheduled: [], loans: [], installments: [] };
  const none = projectMonths(0, "2026-08", 3, base, new Set(), new Map([["2026-08", 100]]), undefined, 0);
  assert.equal(none[2].outflow, 0);
});

console.log(`\nResult: ${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
