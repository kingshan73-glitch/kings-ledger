import { strict as assert } from "node:assert";

const {
  LOGIN_FAIL_WINDOW_MS,
  LOGIN_ID_MAX_LENGTH,
  PASSWORD_MAX_LENGTH,
  extractClientIp,
  normalizeLoginInput,
  rateLimitWindowStart,
  resolveClientIp,
  shouldBlockLogin,
} = await import("../src/lib/login-rate-limit");

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

test("객체가 아닌 입력을 거부한다", () => {
  assert.equal(normalizeLoginInput(null).ok, false);
});

test("빈 로그인 ID를 거부한다", () => {
  assert.equal(normalizeLoginInput({ loginId: "  ", password: "secret" }).ok, false);
});

test("빈 비밀번호를 거부한다", () => {
  assert.equal(normalizeLoginInput({ loginId: "tester", password: "" }).ok, false);
});

test("로그인 ID 앞뒤 공백을 제거한다", () => {
  assert.deepEqual(normalizeLoginInput({ loginId: " tester ", password: "secret" }), {
    ok: true,
    loginId: "tester",
    password: "secret",
  });
});

test("정상 입력을 반환한다", () => {
  assert.deepEqual(normalizeLoginInput({ loginId: "tester", password: "secret" }), {
    ok: true,
    loginId: "tester",
    password: "secret",
  });
});

test("배열 본문을 거부한다", () => {
  assert.equal(normalizeLoginInput([]).ok, false);
});

test("문자열이 아닌 필드를 거부한다", () => {
  assert.equal(normalizeLoginInput({ loginId: 1, password: "secret" }).ok, false);
  assert.equal(normalizeLoginInput({ loginId: "tester", password: null }).ok, false);
});

test("공백만 있는 비밀번호는 거부하지 않는다(비밀번호는 trim 하지 않는다)", () => {
  assert.deepEqual(normalizeLoginInput({ loginId: "tester", password: "   " }), {
    ok: true,
    loginId: "tester",
    password: "   ",
  });
});

test("로그인 ID 길이 상한을 넘기면 거부한다", () => {
  assert.equal(normalizeLoginInput({ loginId: "a".repeat(LOGIN_ID_MAX_LENGTH), password: "x" }).ok, true);
  assert.equal(normalizeLoginInput({ loginId: "a".repeat(LOGIN_ID_MAX_LENGTH + 1), password: "x" }).ok, false);
});

test("비밀번호 길이 상한을 넘기면 거부한다", () => {
  assert.equal(normalizeLoginInput({ loginId: "tester", password: "p".repeat(PASSWORD_MAX_LENGTH) }).ok, true);
  assert.equal(normalizeLoginInput({ loginId: "tester", password: "p".repeat(PASSWORD_MAX_LENGTH + 1) }).ok, false);
});

test("`@` 가 든 로그인 ID 를 거부한다(임의 이메일 겨냥 차단)", () => {
  assert.equal(normalizeLoginInput({ loginId: "someone@synthetic.test", password: "x" }).ok, false);
});

test("실패 19회는 차단하지 않는다", () => {
  assert.equal(shouldBlockLogin(19), false);
});

test("실패 20회는 차단한다", () => {
  assert.equal(shouldBlockLogin(20), true);
});

test("실패 0회는 차단하지 않는다", () => {
  assert.equal(shouldBlockLogin(0), false);
});

test("사용자 지정 한도를 적용한다", () => {
  assert.equal(shouldBlockLogin(3, 3), true);
});

test("15분 전 시각을 ISO 문자열로 반환한다", () => {
  const now = new Date("2026-08-17T12:30:00.000Z");
  assert.equal(LOGIN_FAIL_WINDOW_MS, 15 * 60 * 1000);
  assert.equal(rateLimitWindowStart(now), "2026-08-17T12:15:00.000Z");
});

test("헤더가 없으면 IP도 없다", () => {
  assert.equal(extractClientIp(null), null);
});

test("단일 IP를 반환한다", () => {
  assert.equal(extractClientIp("203.0.113.77"), "203.0.113.77");
});

test("콤마 목록의 첫 IP만 반환한다", () => {
  assert.equal(extractClientIp("203.0.113.77, 198.51.100.10"), "203.0.113.77");
});

test("IP 앞뒤 공백을 제거한다", () => {
  assert.equal(extractClientIp(" 203.0.113.77 "), "203.0.113.77");
});

test("빈 문자열 헤더는 IP 없음으로 본다", () => {
  assert.equal(extractClientIp(""), null);
});

test("IP 형식이 아닌 헤더 값은 버린다(쓰레기 키 방지) · IPv6 는 통과", () => {
  assert.equal(extractClientIp("not-an-ip; DROP TABLE"), null);
  assert.equal(extractClientIp("x".repeat(100)), null);
  assert.equal(extractClientIp("2001:db8::1"), "2001:db8::1");
  assert.equal(extractClientIp("::1"), "::1");
});

const headers = (map: Record<string, string>) => (name: string) => map[name] ?? null;

test("resolveClientIp: x-vercel-forwarded-for 를 최우선으로 쓴다", () => {
  assert.equal(
    resolveClientIp(
      headers({ "x-vercel-forwarded-for": "198.51.100.1", "x-real-ip": "198.51.100.2", "x-forwarded-for": "198.51.100.3" })
    ),
    "198.51.100.1"
  );
});

test("resolveClientIp: 다음은 x-real-ip, 그 다음이 x-forwarded-for 첫 항목", () => {
  assert.equal(resolveClientIp(headers({ "x-real-ip": "198.51.100.2", "x-forwarded-for": "198.51.100.3" })), "198.51.100.2");
  assert.equal(resolveClientIp(headers({ "x-forwarded-for": "198.51.100.3, 198.51.100.9" })), "198.51.100.3");
});

test("resolveClientIp: 아무 헤더도 없으면 null(호출부가 null 버킷으로 센다)", () => {
  assert.equal(resolveClientIp(headers({})), null);
  assert.equal(resolveClientIp(headers({ "x-forwarded-for": "  " })), null);
});

console.log(`\nResult: ${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
