// 수집함 상호 표시 축약 단위 테스트 (설계 158)
//
// ★여기서 고정하는 것은 "무엇을 줄이는가"보다 **무엇을 줄이면 안 되는가**다.
//   교차리뷰(2026-08-09)가 잡은 오축약이 전부 음성 케이스로 들어 있다.
import { strict as assert } from "node:assert";

const { merchantDisplay, memoDisplay, categoryDisplay } = await import("../src/lib/household/merchant-display");

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ❌ ${name}\n     ${(e as Error).message}`); }
};

test("결제수단 꼬리표와 결제 플랫폼 접미사를 표시에서만 제거", () => {
  assert.deepEqual(
    merchantDisplay("카카오T주차_카카오페이 (토스뱅크 체크카드)"),
    { text: "카카오T주차", title: "카카오T주차_카카오페이 (토스뱅크 체크카드)" },
  );
});

test("꼬리표 없는 문자열은 그대로 통과", () => {
  assert.deepEqual(merchantDisplay("동네가게 본점"), { text: "동네가게 본점", title: "동네가게 본점" });
});

test("일반 괄호와 알 수 없는 언더스코어 접미사는 축약하지 않음", () => {
  assert.equal(merchantDisplay("상호(역곡점)").text, "상호(역곡점)");
  assert.equal(merchantDisplay("상호_별관").text, "상호_별관");
  assert.equal(merchantDisplay("아마노코리아(주)_TP타워").text, "아마노코리아(주)_TP타워");
});

test("★'카드'·'통장'으로 끝나는 정상 상호를 잘라 먹지 않는다 (교차리뷰 재현 케이스)", () => {
  assert.equal(merchantDisplay("생일선물 (포토카드)").text, "생일선물 (포토카드)");
  assert.equal(merchantDisplay("보드게임카페 (레드카드)").text, "보드게임카페 (레드카드)");
  assert.equal(merchantDisplay("저축상품 (모임통장)").text, "저축상품 (모임통장)");
  assert.equal(merchantDisplay("○○ (가상계좌)").text, "○○ (가상계좌)");
});

test("전각 괄호 꼬리표도 뗀다", () => {
  assert.equal(merchantDisplay("상호（토스뱅크 체크카드）").text, "상호");
});

test("괄호가 끝이 아니면 지우지 않는다", () => {
  assert.equal(merchantDisplay("상호 (체크카드) 역곡점").text, "상호 (체크카드) 역곡점");
});

test("★축약하면 비어 버리는 값은 축약을 포기한다 (빈 칸 = '미지정'과 뜻이 다르다)", () => {
  assert.deepEqual(merchantDisplay(" (체크카드)"), { text: " (체크카드)", title: " (체크카드)" });
});

test("빈 값은 '-' 로, title 은 만들지 않는다", () => {
  assert.deepEqual(merchantDisplay(null), { text: "-" });
  assert.deepEqual(merchantDisplay(""), { text: "-" });
});

test("★사용내역은 상호에서 자동으로 채워진 그대로일 때만 축약한다", () => {
  const auto = "카카오T주차_카카오페이 (토스뱅크 체크카드)";
  assert.equal(memoDisplay(auto, auto).text, "카카오T주차");            // 수집이 채운 값 = 축약
  assert.equal(memoDisplay("생일선물 (포토카드)", auto).text, "생일선물 (포토카드)"); // 사용자가 친 값 = 보존
  assert.equal(memoDisplay(auto, null).text, auto);                      // 상호가 없으면 손대지 않는다
  assert.deepEqual(memoDisplay(null, auto), { text: "-" });
});

test("카테고리 — '대출상환-' 구분 접두어와 꼬리 '대출' 을 뗀다 (가용폭 89.4px)", () => {
  assert.deepEqual(
    categoryDisplay("대출상환-국민주택분양자금대출"),
    { text: "국민주택분양자금", title: "대출상환-국민주택분양자금대출" },
  );
  assert.equal(categoryDisplay("대출상환-디딤돌대출").text, "디딤돌");
});

test("★대출상환이 아닌 카테고리는 손대지 않는다", () => {
  assert.equal(categoryDisplay("다과/카페비").text, "다과/카페비");
  assert.equal(categoryDisplay("차량유지비").text, "차량유지비");
  assert.equal(categoryDisplay("보험-실손의료비대출").text, "보험-실손의료비대출"); // 다른 구분은 그대로
});

test("★꼬리 공백이 있어도 '대출' 이 떨어진다 (trim 을 먼저)", () => {
  assert.equal(categoryDisplay("대출상환-디딤돌대출 ").text, "디딤돌");
});

test("★서로 다른 원문이 같은 표시값으로 합쳐질 수 있다 — 현재 동작을 고정해 둔다", () => {
  // 필터는 표시값으로 묶으므로 이 둘은 드롭다운에서 한 항목이 된다.
  // 지금 DB 에는 충돌 쌍이 없지만(2026-08-09 실화면 23종 확인), 대출을 추가할 때 이 성질을 기억할 것.
  assert.equal(categoryDisplay("대출상환-현대캐피탈대출").text, "현대캐피탈");
  assert.equal(categoryDisplay("대출상환-현대캐피탈").text, "현대캐피탈");
});

test("★카테고리도 축약하면 비는 값은 축약을 포기하고, 빈 값은 '-'", () => {
  assert.equal(categoryDisplay("대출상환-대출").text, "대출상환-대출");
  assert.deepEqual(categoryDisplay(null), { text: "-" });
  assert.deepEqual(categoryDisplay("-"), { text: "-" });
});

console.log(`\nResult: ${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
