// 카드 묶음 규칙 검증 (설계 86) — 합성 케이스 + 실제 DB 결제수단으로 대조.
//   npm run test:card-group            (합성만, DB 없이)
//   node --env-file=.env.local ... 로 실행하면 실 DB 대조까지
const { cardGroupOf, buildCardGroups, isGroupableKind } = await import("../src/lib/household/card-group");

let fail = 0;
const eq = (name: string, a: unknown, b: unknown) => {
  if (Object.is(a, b)) console.log(`  ✅ ${name}`);
  else { fail++; console.log(`  ❌ ${name} — 기대 ${JSON.stringify(b)}, 실제 ${JSON.stringify(a)}`); }
};

console.log("\n[1] 묶음 키 추출");
eq("상세카드 → 카드사(명의)", cardGroupOf("삼성카드(이바다) 트레이더스"), "삼성카드(이바다)");
eq("통합카드(접두어 자체) → 자기 자신", cardGroupOf("삼성카드(이바다)"), "삼성카드(이바다)");
eq("공백 여러 개 별칭", cardGroupOf("국민카드(이바다) KB ALL 카드"), "국민카드(이바다)");
eq("한글+영문 혼합", cardGroupOf("현대카드(이바다) 현대카드ZERO 할인형 하이패스"), "현대카드(이바다)");
eq("체크카드도 키 자체는 뽑힘(묶음 여부는 kind로 판단)", cardGroupOf("우리카드(김하늘) 체크카드"), "우리카드(김하늘)");
eq("괄호 없음 → null", cardGroupOf("현금"), null);
eq("빈 값 → null", cardGroupOf(""), null);
eq("null 입력 → null", cardGroupOf(null), null);

console.log("\n[2] 묶음 대상 kind (보스 확정: 체크카드 제외)");
eq("credit 묶음", isGroupableKind("credit"), true);
eq("installment 묶음", isGroupableKind("installment"), true);
eq("check 제외(즉시출금·설계 77)", isGroupableKind("check"), false);
eq("cash 제외(현금·부천페이 선불)", isGroupableKind("cash"), false);

console.log("\n[3] 묶음 구성 — 비활성 통합카드가 같은 묶음에 들어가야 한다(과거 지출이 거기 있음)");
const methods = [
  { id: "agg", name: "삼성카드(이바다)", kind: "credit", is_active: false },
  { id: "tr", name: "삼성카드(이바다) 트레이더스", kind: "credit", is_active: true },
  { id: "pet", name: "삼성카드(이바다) PET 카드", kind: "credit", is_active: true },
  { id: "chk", name: "국민카드(이바다) nori 체크카드", kind: "check", is_active: true },
  { id: "cash", name: "현금", kind: "cash", is_active: true },
  { id: "bcp", name: "부천페이(이바다)", kind: "cash", is_active: true },
] as Parameters<typeof buildCardGroups>[0];
const groups = buildCardGroups(methods);
eq("묶음 1개만 생성(삼성카드(이바다))", groups.length, 1);
eq("멤버 3장(비활성 통합 + 상세 2)", groups[0]?.methodIds.length, 3);
eq("비활성 통합카드 포함", groups[0]?.methodIds.includes("agg"), true);
eq("활성 멤버 있으니 allInactive=false", groups[0]?.allInactive, false);
eq("체크카드는 묶음에 안 섞임", groups.some((g) => g.methodIds.includes("chk")), false);
eq("현금·부천페이도 안 섞임", groups.some((g) => g.methodIds.includes("cash") || g.methodIds.includes("bcp")), false);

console.log("\n[4] 전부 비활성인 묶음");
const g2 = buildCardGroups([{ id: "a", name: "하나카드(김하늘)", kind: "credit", is_active: false }] as Parameters<typeof buildCardGroups>[0]);
eq("allInactive=true", g2[0]?.allInactive, true);

// ── 실 DB 대조(선택) ─────────────────────────────────────────
if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  const { createClient } = await import("@supabase/supabase-js");
  const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: pms } = await s.from("hh_payment_method").select("id,name,kind,is_active");
  if (pms) {
    console.log("\n[5] 실 DB 결제수단 묶음 결과");
    const real = buildCardGroups(pms);
    for (const g of real) {
      const names = g.methodIds.map((id) => pms.find((p) => p.id === id)?.name);
      console.log(`  ${g.key}${g.allInactive ? " (전부 비활성)" : ""} ← ${names.length}장: ${names.join(" / ")}`);
    }
    const ungrouped = pms.filter((p) => !real.some((g) => g.methodIds.includes(p.id)));
    console.log(`  [묶음 아님 ${ungrouped.length}건] ${ungrouped.map((p) => `${p.name}(${p.kind})`).join(", ")}`);
    eq("현금은 묶음 아님", ungrouped.some((p) => p.name === "현금"), true);
    eq("체크카드는 전부 묶음 아님", pms.filter((p) => p.kind === "check").every((p) => ungrouped.includes(p)), true);
  }
} else {
  console.log("\n[5] 실 DB 대조 건너뜀(.env.local 없이 실행)");
}

console.log(`\n${fail === 0 ? "✅ 전체 통과" : `❌ 실패 ${fail}건`}`);
// process.exit() 은 supabase 소켓이 열린 채 강제종료돼 Windows libuv 크래시(UV_HANDLE_CLOSING)를 낸다.
// exitCode 만 세팅하고 자연 종료시킨다. (기존 confirm_inbox.mjs 와 동일 관례)
process.exitCode = fail === 0 ? 0 : 1;
