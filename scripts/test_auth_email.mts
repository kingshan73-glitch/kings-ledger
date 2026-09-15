import { strict as assert } from "node:assert";

const { loginIdToAuthEmail } = await import("../src/lib/auth-email");

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

const syntheticDomain = "synthetic.test";

test("로그인 ID에 기본 도메인을 붙인다", () => {
  assert.equal(loginIdToAuthEmail("abc", syntheticDomain), "abc@synthetic.test");
});

test("로그인 ID 앞뒤 공백을 제거한다", () => {
  assert.equal(loginIdToAuthEmail(" abc ", syntheticDomain), "abc@synthetic.test");
});

test("이미 이메일 형식이면 그대로 반환한다", () => {
  assert.equal(loginIdToAuthEmail("a@b.com", syntheticDomain), "a@b.com");
});

test("도메인 인자가 환경변수보다 우선한다", () => {
  const previousDomain = process.env.NEXT_PUBLIC_AUTH_EMAIL_DOMAIN;
  process.env.NEXT_PUBLIC_AUTH_EMAIL_DOMAIN = "environment.test";
  try {
    assert.equal(loginIdToAuthEmail("abc", "argument.test"), "abc@argument.test");
  } finally {
    if (previousDomain === undefined) {
      delete process.env.NEXT_PUBLIC_AUTH_EMAIL_DOMAIN;
    } else {
      process.env.NEXT_PUBLIC_AUTH_EMAIL_DOMAIN = previousDomain;
    }
  }
});

console.log(`\nResult: ${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
