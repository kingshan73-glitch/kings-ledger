/** 2026-09-09 — 짧은 상호 학습 차단과 기존 부분일치 매칭 회귀 테스트. */
const {
  DEFAULT_MERCHANT_MAP,
  MERCHANT_LEARN_MIN_LEN,
  matchMerchantRule,
  shouldLearnMerchantKey,
} = await import("../src/lib/household/defaults");

let fail = 0;

// 객체는 JSON 으로 찍는다 — `[object Object]` 로는 실패했을 때 무엇이 달랐는지 알 수 없다(교차리뷰 Low).
const show = (v: unknown) => (v !== null && typeof v === "object" ? JSON.stringify(v) : String(v));
function eq(label: string, got: unknown, want: unknown) {
  const ok = got === want;
  if (!ok) fail++;
  console.log(`  ${ok ? "✅" : "❌"} ${label}: 기대=[${show(want)}] 실제=[${show(got)}]`);
}

console.log("\n[0] 시드에 ktx→교통비 가 있고 kt 보다 길어서 이긴다 (시드 줄을 지우면 여기서 떨어진다)");
const seedKtx = DEFAULT_MERCHANT_MAP.filter((m) => m.key === "ktx");
eq("시드 ktx 1개", seedKtx.length, 1);
eq("시드 ktx 카테고리", seedKtx[0]?.category, "교통비");
eq("시드 kt 도 여전히 통신비", DEFAULT_MERCHANT_MAP.find((m) => m.key === "kt")?.category, "통신비");
{
  const seedRules = DEFAULT_MERCHANT_MAP.map((m) => ({ merchant_key: m.key, category_id: m.category }));
  eq("실제 시드로 KTX 동대구 → 교통비", matchMerchantRule("KTX 동대구", seedRules)?.category_id, "교통비");
  eq("실제 시드로 KT → 통신비", matchMerchantRule("KT", seedRules)?.category_id, "통신비");
  eq("실제 시드로 KTX특송(장부 실존, 택배) → 교통비", matchMerchantRule("KTX특송", seedRules)?.category_id, "교통비");
}

console.log("\n[1] 학습 최소 길이를 고정한다");
eq("MERCHANT_LEARN_MIN_LEN", MERCHANT_LEARN_MIN_LEN, 4);

console.log("\n[2] 3자 이하·빈 값은 학습하지 않는다");
for (const merchant of ["카카오", "이자", "kt", "  이자  ", "", null, undefined]) {
  eq(JSON.stringify(merchant), shouldLearnMerchantKey(merchant), false);
}

console.log("\n[3] 4자 이상 상호는 학습한다");
for (const merchant of ["늘봄약국", "스톤오븐", "소라식당", "카카오페이", "카페24"]) {
  eq(merchant, shouldLearnMerchantKey(merchant), true);
}

console.log("\n[4] 경계 길이를 확인한다");
eq("정확히 4자 카페24", shouldLearnMerchantKey("카페24"), true);
eq("3자 생협", shouldLearnMerchantKey("생협"), false);

console.log("\n[5] 기존 부분일치와 최장 키 우선 매칭은 그대로다");
const chickenRule = { merchant_key: "치킨", category_id: "c1" };
eq("교촌치킨은 짧은 시드 키로 매칭", matchMerchantRule("교촌치킨", [chickenRule]), chickenRule);

const telRule = { merchant_key: "kt", category_id: "tel" };
const trainRule = { merchant_key: "ktx", category_id: "tr" };
eq("KTX 동대구는 더 긴 ktx 규칙 우선", matchMerchantRule("KTX 동대구", [telRule, trainRule]), trainRule);

console.log(fail === 0 ? "\n전부 통과 ✅" : `\n${fail}건 실패 ❌`);
process.exit(fail === 0 ? 0 : 1);
