import { strict as assert } from "node:assert";

const { validateInstallmentCounts } = await import("../src/lib/household/installment-validate");

let passed = 0;
let failed = 0;
const test = (name: string, fn: () => void) => {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failed++;
    console.log(`  ❌ ${name}\n     ${(error as Error).message}`);
  }
};

test("첫 회차는 유효하다", () => {
  assert.equal(validateInstallmentCounts(3, 1), null);
});

test("마지막 회차는 유효하다", () => {
  assert.equal(validateInstallmentCounts(3, 3), null);
});

test("시작 회차가 총 회차보다 크면 거부한다", () => {
  assert.match(validateInstallmentCounts(3, 4) ?? "", /이하/);
});

test("총 회차가 0이면 거부한다", () => {
  assert.equal(validateInstallmentCounts(0, 1), "총 회차는 1 이상이어야 합니다.");
});

test("시작 회차가 0이면 거부한다", () => {
  assert.equal(validateInstallmentCounts(3, 0), "시작 회차는 1 이상이어야 합니다.");
});

test("총 회차가 정수가 아니면 거부한다", () => {
  assert.equal(validateInstallmentCounts(3.5, 1), "총 회차는 1 이상이어야 합니다.");
});

console.log(`\nResult: ${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
