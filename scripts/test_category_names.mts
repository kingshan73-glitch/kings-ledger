const { CATEGORY_NAME, cardBillCategoryId, isCardLoan } = await import("../src/lib/household/category-names");

let fail = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = got === want;
  if (!ok) fail += 1;
  console.log(`  ${ok ? "✅" : "❌"} ${label}${ok ? "" : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
}

eq("대출상환 카테고리 이름", CATEGORY_NAME.loanRepay, "대출상환");
eq("대출실행 카테고리 이름", CATEGORY_NAME.loanIncome, "대출");
eq("카드대금 카테고리 이름", CATEGORY_NAME.cardBill, "카드대금");
eq("이자 카테고리 이름", CATEGORY_NAME.interest, "이자");
eq("용돈 카테고리 이름", CATEGORY_NAME.pocket, "용돈");

const categories = [
  { id: "inactive-card-bill", name: CATEGORY_NAME.cardBill, is_active: false },
  { id: "active-card-bill", name: CATEGORY_NAME.cardBill, is_active: true },
  { id: "other", name: "기타", is_active: true },
];
eq("활성 조건이 없으면 첫 카드대금", cardBillCategoryId(categories), "inactive-card-bill");
eq("activeOnly면 활성 카드대금", cardBillCategoryId(categories, { activeOnly: true }), "active-card-bill");
eq("카드대금이 없으면 null", cardBillCategoryId([{ id: "other", name: "기타" }]), null);
// 수집함 납부 드롭다운의 계약(활성 카드대금이 없으면 항목 자체를 숨긴다) — 비활성 행으로 폴백하면 비활성 카테고리로 분류된 거래가 생긴다.
eq("activeOnly 인데 활성 카드대금이 없으면 null(비활성으로 폴백하지 않음)", cardBillCategoryId([{ id: "inactive-card-bill", name: CATEGORY_NAME.cardBill, is_active: false }], { activeOnly: true }), null);

eq("이름에 카드론 포함", isCardLoan({ name: "테스트카드-카드론(26.01)" }), true);
eq("카드론이 없으면 false", isCardLoan({ name: "테스트 신용대출" }), false);
eq("카드론 판정은 대소문자를 바꾸지 않음", isCardLoan({ name: "테스트 CARDLOAN" }), false);

console.log(`\ncategory-names: ${fail ? "FAIL" : "PASS"}`);
process.exit(fail ? 1 : 0);
