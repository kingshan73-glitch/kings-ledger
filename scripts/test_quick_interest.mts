// 토스 이자 빠른 입력 단위 테스트 (설계 172)
//
// ★여기서 고정하는 것은 "편해졌는가"가 아니라 **손입력이 만들던 흔들림이 사라졌는가**다.
//   2026-08-14 실측: 같은 이자를 7가지 이름으로 넣고 계셨고(토스이자/통장이자/통장 이자/토스 이자/
//   이자/토스뱅크 이자/토스이자 추가), 그중 1건은 엉뚱한 계좌(국민은행)에 붙었다.
//   빠른 입력의 존재 이유가 이 두 가지를 원천에서 막는 것이므로, 음성 케이스로 못 박아 둔다.
import { strict as assert } from "node:assert";

const {
  QUICK_INTEREST,
  buildQuickInterestForm,
  resolveQuickInterestRefs,
  findSameDayAmount,
  daysSinceLast,
  shouldWarnMissing,
  isFutureDate,
  isAllowedAccount,
  pickDefaultAccount,
  worstInterestGap,
  planQuickInterestBatch,
  quickInterestDedupHash,
} = await import("../src/lib/household/quick-interest");

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ❌ ${name}\n     ${(e as Error).message}`); }
};

// ── 고정값 ─────────────────────────────────────────────────────────────
test("★상대처는 항상 '토스이자' 한 가지다 (이름 변주가 여기서 끊긴다)", () => {
  const f = buildQuickInterestForm({ amount: 128, date: "2026-08-14", categoryId: "cat-1", accountId: "acc-1" });
  assert.equal(f.guessed_merchant, "토스이자");
  assert.equal(QUICK_INTEREST.merchant, "토스이자");
});

test("수입·이자 카테고리·입금계좌가 고정으로 채워진다", () => {
  const f = buildQuickInterestForm({ amount: 128, date: "2026-08-14", categoryId: "cat-1", accountId: "acc-1" });
  assert.equal(f.guessed_type, "income");
  assert.equal(f.guessed_category_id, "cat-1");
  assert.equal(f.guessed_account_id, "acc-1");
  assert.equal(f.guessed_amount, 128);
  assert.equal(f.guessed_date, "2026-08-14");
});

test("★수입에 쓰이지 않는 칸은 반드시 비운다 (결제수단·이체계좌·할부)", () => {
  // 수입인데 결제수단이 차 있으면 확정 검증(validateItem)과 집계가 어긋난다.
  const f = buildQuickInterestForm({ amount: 128, date: "2026-08-14", categoryId: "cat-1", accountId: "acc-1" });
  assert.equal(f.guessed_payment_method_id, null);
  assert.equal(f.guessed_from_account_id, null);
  assert.equal(f.guessed_to_account_id, null);
  assert.equal(f.guessed_installment_months, null);
});

test("금액이 0 이하이면 폼을 만들지 않는다", () => {
  assert.throws(() => buildQuickInterestForm({ amount: 0, date: "2026-08-14", categoryId: "c", accountId: "a" }));
  assert.throws(() => buildQuickInterestForm({ amount: -5, date: "2026-08-14", categoryId: "c", accountId: "a" }));
});

// ── 카테고리·계좌 찾기 ─────────────────────────────────────────────────
const CATS = [
  { id: "c-food", name: "식비", kind: "expense" },
  { id: "c-int", name: "이자", kind: "income" },
  { id: "c-int-x", name: "이자세금", kind: "expense" },
];
// ★픽스처에 실명·실계좌를 쓰지 않는다 — 쓰는 순간 덱스(Codex) 교차리뷰가 중단된다(누적 7회).
//   명의는 '명의A/명의B'. 이 규칙은 2026-08-14 에 또 어겨서 리뷰가 한 번 막혔다.
const ACCTS = [
  { id: "a-kb", name: "국민은행(명의B)", is_active: true },
  { id: "a-toss", name: "토스뱅크(명의A)", is_active: true },
  { id: "a-toss-old", name: "토스뱅크(옛)", is_active: false },
];

test("이자 카테고리와 토스뱅크 계좌를 찾는다 (활성 후보가 하나뿐일 때)", () => {
  const r = resolveQuickInterestRefs(CATS, ACCTS);
  assert.equal(r.categoryId, "c-int");
  assert.equal(r.accountId, "a-toss");
  assert.equal(r.missing, null);
});

test("★'이자세금'(지출) 을 이자 카테고리로 집지 않는다 — kind 와 정확한 이름으로 고른다", () => {
  const r = resolveQuickInterestRefs([{ id: "c-int-x", name: "이자세금", kind: "expense" }], ACCTS);
  assert.equal(r.categoryId, null);
  assert.ok(r.missing);
});

test("★비활성 계좌는 고르지 않는다", () => {
  const r = resolveQuickInterestRefs(CATS, [{ id: "a-toss-old", name: "토스뱅크(명의A)", is_active: false }]);
  assert.equal(r.accountId, null);
  assert.ok(r.missing);
});

test("★못 찾으면 조용히 null 을 넣지 말고 무엇이 없는지 말한다", () => {
  // 계좌·카테고리를 못 찾은 채 저장하면 확정이 막히거나 계좌 없는 수입이 생긴다.
  const r = resolveQuickInterestRefs([], []);
  assert.equal(r.categoryId, null);
  assert.equal(r.accountId, null);
  assert.ok(r.missing?.includes("이자"));
  assert.ok(r.missing?.includes("토스뱅크"));
});

// ── 같은 날 같은 금액 가드 ────────────────────────────────────────────
const ITEMS = [
  { guessed_date: "2026-08-14", guessed_amount: 128, guessed_merchant: "토스이자" },
  { guessed_date: "2026-08-13", guessed_amount: 125, guessed_merchant: "토스이자" },
  { guessed_date: "2026-08-14", guessed_amount: 4500, guessed_merchant: "씨유(CU)" },
];

test("같은 날 같은 금액의 이자가 이미 있으면 잡아낸다 (두 번 누른 실수)", () => {
  assert.ok(findSameDayAmount(ITEMS, "2026-08-14", 128));
});

test("★날짜나 금액이 다르면 막지 않는다", () => {
  assert.equal(findSameDayAmount(ITEMS, "2026-08-14", 129), null);
  assert.equal(findSameDayAmount(ITEMS, "2026-08-12", 128), null);
});

test("★이자가 아닌 같은 금액 거래는 가드 대상이 아니다", () => {
  // 8/14 에 4,500원 지출이 있어도 4,500원 이자 입력을 막으면 안 된다.
  assert.equal(findSameDayAmount(ITEMS, "2026-08-14", 4500), null);
});

// ── 계좌를 함께 보는 중복 가드 (교차리뷰 2차 Major) ────────────────────
const ITEMS_ACCT = [
  { guessed_date: "2026-08-14", guessed_amount: 128, guessed_merchant: "토스이자", guessed_account_id: "a-1" },
];

test("★★같은 날 같은 금액이어도 **계좌가 다르면** 막지 않는다", () => {
  // 두 명의가 같은 날 같은 금액(소액이라 흔하다)의 이자를 받을 수 있다.
  // 계좌를 안 보고 막으면 한쪽 이자를 영영 못 넣는다.
  assert.equal(findSameDayAmount(ITEMS_ACCT, "2026-08-14", 128, "a-2"), null);
});

test("같은 계좌면 막는다 (버튼을 두 번 누른 실수)", () => {
  assert.ok(findSameDayAmount(ITEMS_ACCT, "2026-08-14", 128, "a-1"));
});

test("★계좌를 모르는 옛 행은 계좌 조건 없이 막는다 (근거 없이 통과시키지 않는다)", () => {
  const old = [{ guessed_date: "2026-08-14", guessed_amount: 128, guessed_merchant: "토스이자" }];
  assert.ok(findSameDayAmount(old, "2026-08-14", 128, "a-2"));
});

test("★화면이 준 계좌가 후보 밖이면 거부한다 (핸들러는 화면 값을 믿지 않는다)", () => {
  const candidates = [{ id: "a-1" }, { id: "a-2" }];
  assert.equal(isAllowedAccount(candidates, "a-1"), true);
  assert.equal(isAllowedAccount(candidates, "a-9"), false);
  assert.equal(isAllowedAccount([], "a-1"), false);
});

// ── 미입력 일수 ───────────────────────────────────────────────────────
test("마지막 기록일로부터 며칠 비었는지 센다", () => {
  assert.equal(daysSinceLast("2026-08-14", "2026-08-14"), 0);
  assert.equal(daysSinceLast("2026-08-13", "2026-08-14"), 1);
  assert.equal(daysSinceLast("2026-08-08", "2026-08-14"), 6);
});

test("기록이 아예 없으면 null (배지를 띄우되 일수는 말하지 않는다)", () => {
  assert.equal(daysSinceLast(null, "2026-08-14"), null);
});

test("★2일 이상 비었을 때만 알린다 — 어제 넣었으면 조용하다", () => {
  assert.equal(shouldWarnMissing(0), false);
  assert.equal(shouldWarnMissing(1), false);
  assert.equal(shouldWarnMissing(2), true);
  assert.equal(shouldWarnMissing(6), true);
  assert.equal(shouldWarnMissing(null), true); // 기록이 없는 상태도 알린다
});

test("★미래 날짜가 마지막이어도 음수 일수를 내지 않는다", () => {
  assert.equal(daysSinceLast("2026-08-20", "2026-08-14"), 0);
});

// ── 교차리뷰(2026-08-14, Codex)로 추가된 케이스 ────────────────────────
test("★미래 날짜는 입력에서 막는다 — 오입력이 미입력 경고를 잠그기 때문", () => {
  // 08-24 로 잘못 넣으면 '마지막 기록'이 미래가 되고, daysSinceLast 가 0 으로 눌러
  // 그날까지 경고가 안 뜬다. 그래서 클램프에 기대지 않고 입력에서 거른다.
  assert.equal(isFutureDate("2026-08-15", "2026-08-14"), true);
  assert.equal(isFutureDate("2026-09-01", "2026-08-14"), true);
  assert.equal(isFutureDate("2026-08-14", "2026-08-14"), false); // 오늘은 통과
  assert.equal(isFutureDate("2026-08-13", "2026-08-14"), false);
});

test("날짜 문자열이 깨져 있으면 미래로 단정하지 않는다(별도 검증에 맡긴다)", () => {
  assert.equal(isFutureDate("", "2026-08-14"), false);
  assert.equal(isFutureDate("2026-13-99", "2026-08-14"), false);
});

// ── 명의를 코드에 쓰지 않고 계좌를 고르는 방식 (2026-08-14 재설계) ──────
// 같은 은행 계좌가 명의별로 둘 있어 은행명만으로는 못 고른다. 그렇다고 소스에 실명을 쓰면
// 덱스 리뷰가 중단된다. → 명의 대신 **이자가 실제로 들어오던 계좌**로 좁힌다.
const TWO_TOSS = [
  { id: "a-1", name: "토스뱅크(명의A)", is_active: true },
  { id: "a-2", name: "토스뱅크(명의B)", is_active: true },
];

test("후보 목록은 활성 + 해당 은행만 담는다 (화면 드롭다운의 원천)", () => {
  const r = resolveQuickInterestRefs(CATS, ACCTS);
  assert.deepEqual(r.candidates.map((c) => c.id), ["a-toss"]);
});

test("★같은 은행 계좌가 둘인데 근거가 없으면 기본값을 비운다 (사람이 고른다)", () => {
  // 첫 행을 임의로 집으면 **다른 사람 계좌**에 이자가 쌓이고, 잔액이 어긋나기 전엔 아무도 모른다.
  const r = resolveQuickInterestRefs(CATS, TWO_TOSS);
  assert.equal(r.accountId, null);
  assert.equal(r.candidates.length, 2); // 고를 수는 있어야 한다
  assert.equal(r.missing, null); // 계좌가 아예 없는 것과는 다르다 — 화면에서 고르면 된다
});

test("★둘이어도 이자가 들어오던 계좌가 후보 안이면 그걸 기본값으로 제안한다", () => {
  const r = resolveQuickInterestRefs(CATS, TWO_TOSS, "a-2");
  assert.equal(r.accountId, "a-2");
});

test("★이자가 들어오던 계좌가 후보 밖이면 기본값을 비운다", () => {
  const r = resolveQuickInterestRefs(CATS, TWO_TOSS, "a-kb");
  assert.equal(r.accountId, null);
});

test("후보가 하나뿐이고 근거가 아예 없으면(첫 사용) 그 하나를 제안한다", () => {
  const r = resolveQuickInterestRefs(CATS, [{ id: "a-1", name: "토스뱅크 통장(명의A)", is_active: true }]);
  assert.equal(r.accountId, "a-1");
});

test("★★후보가 하나여도 근거가 딴 데를 가리키면 제안하지 않는다 (교차리뷰 2차 Major)", () => {
  // 원래 쓰던 계좌가 비활성화되면 **같은 은행의 다른 명의 계좌**만 후보로 남는다.
  // 예전 구현은 그걸 자동 선택했고, 테스트가 그 위험한 동작을 회귀 규칙으로 고정하고 있었다.
  const r = resolveQuickInterestRefs(CATS, [{ id: "a-1", name: "토스뱅크(명의B)", is_active: true }], "a-gone");
  assert.equal(r.accountId, null);
  assert.equal(r.candidates.length, 1);
});

test("★해당 은행 계좌가 아예 없을 때만 '못 찾았다'고 말한다", () => {
  const r = resolveQuickInterestRefs(CATS, [{ id: "a-kb", name: "국민은행(명의B)", is_active: true }]);
  assert.equal(r.accountId, null);
  assert.equal(r.candidates.length, 0);
  assert.ok(r.missing?.includes("토스뱅크"));
});

test("★상수에 사람 이름 자리를 두지 않는다 — 은행명까지만", () => {
  // 소스 전체의 실명 검사는 이 단위 테스트가 아니라 커밋 전 `git diff --cached` grep 이 한다
  // (RULES 참조). 여기서는 **실명을 담을 자리였던 필드가 되살아나는 것**만 막는다.
  assert.equal(QUICK_INTEREST.accountBank, "토스뱅크");
  assert.equal("accountName" in QUICK_INTEREST, false);
  assert.equal("accountParts" in QUICK_INTEREST, false);
});

// ── 계좌가 여럿일 때 목적이 지켜지는가 (2026-08-14 4차 점검) ────────────
// 전제: 같은 은행 계좌가 명의별로 둘이고, 지금은 한쪽에만 이자를 넣고 있다(실측 194건 vs 0건).
const STATS_ONE = [
  { accountId: "a-1", accountName: "토스뱅크(명의A)", lastDate: "2026-08-13", count: 194 },
  { accountId: "a-2", accountName: "토스뱅크(명의B)", lastDate: null, count: 0 },
];

test("★기본 계좌는 '가장 많이 받아 온 계좌' — 다른 계좌에 한 번 넣어도 안 흔들린다", () => {
  // '가장 최근 계좌'로 정하면 딴 계좌에 한 번 넣는 순간 다음날 기본값이 넘어간다.
  const afterOneOther = [
    { accountId: "a-1", accountName: "토스뱅크(명의A)", lastDate: "2026-08-13", count: 194 },
    { accountId: "a-2", accountName: "토스뱅크(명의B)", lastDate: "2026-08-14", count: 1 }, // 더 최근
  ];
  assert.equal(pickDefaultAccount(afterOneOther), "a-1");
});

test("이력이 아예 없으면 기본값을 고르지 않는다 (사람이 고른다)", () => {
  assert.equal(pickDefaultAccount([{ accountId: "a-1", accountName: "x", lastDate: null, count: 0 }]), null);
});

test("★건수가 동률이면 고르지 않는다 — 임의로 집으면 다른 명의 계좌에 쌓인다", () => {
  const tied = [
    { accountId: "a-1", accountName: "토스뱅크(명의A)", lastDate: "2026-08-13", count: 5 },
    { accountId: "a-2", accountName: "토스뱅크(명의B)", lastDate: "2026-08-14", count: 5 },
  ];
  assert.equal(pickDefaultAccount(tied), null);
});

test("★★한 계좌가 비었는데 다른 계좌가 최신이어도 경고가 사라지지 않는다", () => {
  // 이게 이번 점검의 본체다. 계좌 전체에서 '최신 1건'만 보면 A 가 사흘 비어도 조용해진다.
  const mixed = [
    { accountId: "a-1", accountName: "토스뱅크(명의A)", lastDate: "2026-08-11", count: 194 },
    { accountId: "a-2", accountName: "토스뱅크(명의B)", lastDate: "2026-08-14", count: 3 },
  ];
  const w = worstInterestGap(mixed, "2026-08-14");
  assert.equal(w?.accountName, "토스뱅크(명의A)");
  assert.equal(w?.days, 3);
  assert.equal(shouldWarnMissing(w?.days ?? null), true);
});

test("이자를 안 받는 계좌 때문에 매일 경고가 뜨지는 않는다", () => {
  const w = worstInterestGap(STATS_ONE, "2026-08-14");
  assert.equal(w?.accountName, "토스뱅크(명의A)");
  assert.equal(w?.days, 1);
  assert.equal(shouldWarnMissing(w?.days ?? null), false);
});

test("이력 있는 계좌가 하나도 없으면 판정 자체가 없다", () => {
  assert.equal(worstInterestGap([{ accountId: "a", accountName: "x", lastDate: null, count: 0 }], "2026-08-14"), null);
});

// ── 여러 건 한 번에 넣기 (설계 184) ─────────────────────────────────────
// 팀장 요청 2026-08-19: "작은 금액들이 많아서 번거롭다" — 토스뱅크는 상품마다 이자가 따로 들어온다.
test("빈 줄(0)은 빼고 입력 순서를 지킨다 · 합계를 낸다", () => {
  const p = planQuickInterestBatch([128, 0, 15, 3, 0]);
  assert.equal(p.error, null);
  assert.deepEqual(p.rows.map((r) => r.amount), [128, 15, 3]);
  assert.deepEqual(p.distinctAmounts, [128, 15, 3]);
  assert.equal(p.total, 146);
});

test("★전부 빈 줄이면 넣을 게 없다고 말한다 (조용히 0건 저장하지 않는다)", () => {
  const p = planQuickInterestBatch([0, 0]);
  assert.ok(p.error);
  assert.equal(p.rows.length, 0);
});

test("음수·소수는 오류다 (수식 평가는 정수만 내므로 이건 오입력)", () => {
  assert.ok(planQuickInterestBatch([128, -1]).error);
  assert.ok(planQuickInterestBatch([1.5]).error);
});

test("★NaN 은 빈 줄이 아니라 오류다 — 조용히 빠지면 3줄 넣고 2건만 저장된다 (리뷰 2026-08-19)", () => {
  const p = planQuickInterestBatch([128, NaN, 3]);
  assert.ok(p.error);
  assert.equal(p.rows.length, 0);
});

test("★한 배치 안의 같은 금액은 허용하되 2번째부터 ordinal 이 붙는다 (두 상품이 1원씩)", () => {
  const p = planQuickInterestBatch([1, 1, 5]);
  assert.equal(p.error, null);
  assert.deepEqual(p.rows, [{ amount: 1, ordinal: 1 }, { amount: 1, ordinal: 2 }, { amount: 5, ordinal: 1 }]);
  // 중복 가드에는 금액을 한 번씩만 넘긴다 — 배치 안 중복은 가드 대상이 아니다.
  assert.deepEqual(p.distinctAmounts, [1, 5]);
});

test("★dedup_hash 는 첫 건이 옛 포맷 그대로(호환), 2번째부터 `#n` 으로 UNIQUE 를 피한다", () => {
  const first = quickInterestDedupHash({ date: "2026-08-19", amount: 1, accountId: "acc-1", ordinal: 1 });
  assert.equal(first, "2026-08-19|1|토스이자|acc-1");
  assert.equal(quickInterestDedupHash({ date: "2026-08-19", amount: 1, accountId: "acc-1" }), first);
  assert.equal(quickInterestDedupHash({ date: "2026-08-19", amount: 1, accountId: "acc-1", ordinal: 2 }), `${first}#2`);
});

test("★ordinal 계약: 0·소수·음수는 조용히 통과시키지 않는다(0 은 1번째와 같은 해시가 돼 충돌한다)", () => {
  const arg = { date: "2026-08-19", amount: 1, accountId: "acc-1" };
  assert.throws(() => quickInterestDedupHash({ ...arg, ordinal: 0 }), /1 이상의 정수/);
  assert.throws(() => quickInterestDedupHash({ ...arg, ordinal: 2.5 }), /1 이상의 정수/);
  assert.throws(() => quickInterestDedupHash({ ...arg, ordinal: -1 }), /1 이상의 정수/);
  // undefined 는 옛 호출부(1건 흐름) — 그대로 base 해시다.
  assert.equal(quickInterestDedupHash({ ...arg, ordinal: undefined }), "2026-08-19|1|토스이자|acc-1");
});

test("1건만 넣는 옛 흐름은 계획이 1행·ordinal 1 로 그대로다", () => {
  const p = planQuickInterestBatch([128]);
  assert.deepEqual(p.rows, [{ amount: 128, ordinal: 1 }]);
  assert.equal(p.total, 128);
});

console.log(`\nResult: ${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
