// 설계 131 검증: '출금금액' 자동매칭이 **안 나간 돈을 나갔다고 하지 않는다**.
//
// 실행: npm run test:outflow-match   (DB 불필요 — 순수 함수)
//
// 실측 배경(2026-08-04, 팀장 지적 "아직 출금 안 된 금액이 출금된 걸로 표시된다"): 8월 4건이 오표시였다.
//   ⓐ 용돈-한별 300,000  ← 부천페이 충전(내부 이체) 300,000
//   ⓑ 카드대금-하나카드 105,139 ← 통장 간 이체 100,000 (근사매칭)
//   ⓒ 학원비-한별(영어과외) 350,000 ← 신용카드로 낸 '목동수학보습학원' 350,000
//   ⓓ 한별/한솔(적금) 100,000(10일 예정) ← 8/3 거래 100,000 (예정일 한참 전)
// 아래 4묶음이 각각을 막는다. [5]는 "막다가 진짜 실적까지 잃지 않는다"를 지킨다.
const { matchOutflowActuals, outflowsForMatching } = await import("../src/lib/household/calc");
const { computeCashMatches, toOutflowMatchItem } = await import("../src/lib/household/cashflow-snapshot");

let fail = 0;
const eq = (name: string, a: unknown, b: unknown) => {
  if (Object.is(a, b)) console.log(`  ✅ ${name}`);
  else {
    fail++;
    console.log(`  ❌ ${name} — 기대 ${JSON.stringify(b)}, 실제 ${JSON.stringify(a)}`);
  }
};

const ACC = ["acc-kb", "acc-toss", "acc-pay"]; // 등록 계좌(부천페이 포함)
const CARD = ["pm-samsung"]; // 신용카드 결제수단
const TOL = { earlyDayTolerance: 5 };

console.log("\n[0] 스냅샷·전월 열 공용 매칭 item — 대출만 계좌 게이트를 면제한다(설계 185 후속)");
{
  const base = { key: "item:1", amount: 100_000, label: "예정 지출", day: 10, accountId: "acc-current" };
  eq("★대출은 현재 계좌를 매칭 게이트에 넘기지 않는다", toOutflowMatchItem({ ...base, sourceKind: "loan" }).accountId, null);
  eq("고정비는 계좌 게이트를 유지한다", toOutflowMatchItem({ ...base, sourceKind: "fixed" }).accountId, "acc-current");
  eq("할부도 계좌 게이트를 유지한다", toOutflowMatchItem({ ...base, sourceKind: "installment" }).accountId, "acc-current");
  // ★설계 188 후속(리뷰 High): 대출은 '계좌를 모르는 항목'임을 매처에 알린다 — 같은 금액 경쟁에서
  //   계좌일치 우선패스가 대출 몫을 가로채지 않게 하는 근거.
  eq("★대출은 accountBlind 표식을 단다", toOutflowMatchItem({ ...base, sourceKind: "loan" }).accountBlind, true);
  eq("고정비는 accountBlind 가 아니다", toOutflowMatchItem({ ...base, sourceKind: "fixed" }).accountBlind, false);
}

console.log("\n[0-1] 전월 열 종단 — 현재 대출계좌와 다른 과거 계좌의 상환도 잡는다(설계 185 후속)");
{
  const loan = {
    key: "loan:1", sourceKind: "loan", sourceId: "1", kind: "loan", label: "대출상환-합성저축은행",
    categoryId: null, day: 10, naturalDay: 10, dayOverridden: false, amount: 100_000,
    accountId: "acc-current", paymentMethodId: null, cardCharge: false,
    baseCardCharge: false, baseAccountId: "acc-current", methodOverridden: false, released: false,
    paidOverride: null, paidAmount: null, reason: null,
  } as const;
  const oldAccountPayment = {
    amount: 100_000, counterparty: "합성저축은행", txn_date: "2026-07-10", type: "payment" as const,
    account_id: null, from_account_id: "acc-old", to_account_id: null, payment_method_id: null,
  };
  const result = computeCashMatches({
    month: "2026-08", classified: [loan], paidThisMonth: new Map(), recentOutflows: [oldAccountPayment],
    accounts: [{ id: "acc-current" }, { id: "acc-old" }], methods: [],
  });
  eq("★계좌 A 등록 대출이 계좌 B의 전월 동일금액 상환과 매칭", result.prevPaidByKey.get("loan:1")?.amount, 100_000);

  // 계좌 게이트는 payment 의 금액 불일치(score 1·2)에만 작동한다. 동일금액(score 3)은 옛 호출부도
  // 통과하므로, 실제 회귀(변동금리·원리금 변동)를 RED 로 증명하는 근사금액 짝도 함께 둔다.
  const changedPayment = { ...oldAccountPayment, amount: 100_300 };
  const changedResult = computeCashMatches({
    month: "2026-08", classified: [loan], paidThisMonth: new Map(), recentOutflows: [changedPayment],
    accounts: [{ id: "acc-current" }, { id: "acc-old" }], methods: [],
  });
  eq("★계좌가 바뀐 대출의 전월 변동 상환액도 매칭", changedResult.prevPaidByKey.get("loan:1")?.amount, 100_300);
}

console.log("\n[1] 내부 이체(지갑 충전·통장 자리바꿈)는 매칭 풀에서 빠진다");
{
  const txns = [
    { amount: 300000, counterparty: "코나아이(주)(경기지역화폐)", txn_date: "2026-08-03", type: "transfer", from_account_id: "acc-kb", to_account_id: "acc-pay" },
    { amount: 500000, counterparty: "외부 송금", txn_date: "2026-08-03", type: "transfer", from_account_id: "acc-kb", to_account_id: null },
  ];
  const pool = outflowsForMatching(txns, ACC, CARD);
  eq("내부 이체 제외 후 1건", pool.length, 1);
  eq("남은 것은 외부 송금", pool[0].counterparty, "외부 송금");
  const m = matchOutflowActuals([{ key: "fixed:1", amount: 300000, label: "용돈-한별(농협 김교사)", day: 25 }], pool, TOL);
  eq("★충전이 용돈 항목에 안 붙는다", m.has("fixed:1"), false);
}

console.log("\n[2] 신용카드로 낸 지출은 매칭 풀에서 빠진다(그날 통장에서 안 나간다 — 설계 108 과 대칭)");
{
  const txns = [
    { amount: 350000, counterparty: "목동수학보습학원", txn_date: "2026-08-03", type: "expense", payment_method_id: "pm-samsung" },
    { amount: 350000, counterparty: "영어 과외비(박교사)", txn_date: "2026-08-08", type: "expense", payment_method_id: null },
  ];
  const pool = outflowsForMatching(txns, ACC, CARD);
  eq("카드 결제 제외 후 1건", pool.length, 1);
  const m = matchOutflowActuals([{ key: "fixed:2", amount: 350000, label: "학원비-한별(영어과외-박교사)", day: 8 }], pool, TOL);
  eq("★카드로 낸 학원비 거래를 다른 항목이 못 가져간다", m.get("fixed:2")?.counterparty, "영어 과외비(박교사)");
}

console.log("\n[3] 2패스 — 상호가 맞는 항목이 먼저 가져간다(가로채기 방지)");
{
  const txns = [{ amount: 350000, counterparty: "목동수학보습학원", txn_date: "2026-08-05", type: "expense" }];
  // 배열 순서상 '영어과외'가 앞이라 예전 규칙이면 이쪽이 가져갔다.
  const items = [
    { key: "fixed:eng", amount: 350000, label: "학원비-한별(영어과외-박교사)", day: 8 },
    { key: "fixed:math", amount: 350000, label: "학원비-목동수학-한별", day: 5 },
  ];
  const m = matchOutflowActuals(items, txns, TOL);
  eq("★상호가 맞는 목동수학이 가져간다", m.get("fixed:math")?.counterparty, "목동수학보습학원");
  eq("영어과외는 빈칸", m.has("fixed:eng"), false);
}

console.log("\n[4] 날짜 가드 — 예정일보다 한참 이른 거래는 그 항목의 것이 아니다");
{
  const txns = [{ amount: 100000, counterparty: "0202982070207", txn_date: "2026-08-03", type: "expense" }];
  const m = matchOutflowActuals([{ key: "fixed:save", amount: 100000, label: "한별/한솔(적금)", day: 10 }], txns, TOL);
  eq("★10일 예정 항목이 3일 거래를 안 가져간다", m.has("fixed:save"), false);
  const m2 = matchOutflowActuals([{ key: "fixed:save", amount: 100000, label: "한별/한솔(적금)", day: 10 }], txns);
  eq("가드를 안 주면 종전대로 매칭(옵션이다)", m2.has("fixed:save"), true);
}

console.log("\n[5] 막다가 진짜 실적을 잃지 않는다");
{
  // ⓐ 상호까지 맞으면 날짜가 일러도 인정(선납)
  const early = [{ amount: 95040, counterparty: "KT", txn_date: "2026-08-02", type: "expense" }];
  const m1 = matchOutflowActuals([{ key: "fixed:kt", amount: 95040, label: "KT(2025.10)", day: 20 }], early, TOL);
  eq("★상호일치는 날짜 가드 면제", m1.get("fixed:kt")?.counterparty, "KT");
  // ⓑ 늦게 나간 것(주말 밀림)은 막지 않는다
  const late = [{ amount: 70560, counterparty: "국민건강보험", txn_date: "2026-08-13", type: "expense" }];
  const m2 = matchOutflowActuals([{ key: "fixed:nhis", amount: 70560, label: "국민연금보험공단(건강보험)", day: 10 }], late, TOL);
  eq("늦은 출금은 그대로 매칭", m2.has("fixed:nhis"), true);
  // ⓒ 날짜를 모르는 항목(day=null)은 가드가 걸리지 않는다
  const undated = [{ amount: 12000, counterparty: "주간고정비", txn_date: "2026-08-01", type: "expense" }];
  const m3 = matchOutflowActuals([{ key: "fixed:wk", amount: 12000, label: "주간고정비", day: null }], undated, TOL);
  eq("day 미정 항목은 종전대로", m3.has("fixed:wk"), true);
  // ⓓ 체크·선불 카드 결제는 즉시 출금이라 풀에 남는다
  const check = [{ amount: 50000, counterparty: "이마트", txn_date: "2026-08-10", type: "expense", payment_method_id: "pm-check" }];
  eq("체크카드 결제는 안 거른다", outflowsForMatching(check, ACC, CARD).length, 1);
}

console.log("\n[6] 직접 제외(released)한 항목은 당월 매칭에서 후순위다 (2026-08-09, 팀장 신고)");
{
  // 배경: "구미아파트 관리비 24만원을 넣었는데 현금흐름에 안 잡힌다".
  // 원인은 `학원비-미술학원-한솔`(5일)이 8월에 금액 오버라이드로 240,000 이 되고 released(직접 제외)
  // 상태였는데도 매칭 풀에 남아, 구미아파트(7일, 240,000)의 8/7 실거래를 먼저 가져간 것.
  // 금액이 같으면 배열 순서(예정일 오름차순)가 앞선 쪽이 이긴다 — 5일이 7일보다 앞이다.
  // 거르는 주체는 호출부(cashflow-snapshot 의 matchItems, cash/page.tsx 의 prevPaidByKey)이므로
  // 여기서는 **거르지 않으면 훔친다**와 **거르면 진짜 주인이 받는다**를 나란히 고정한다.
  const txns = [{ amount: 240000, counterparty: "김교사(3030영어 (구미아파트)", txn_date: "2026-08-07", type: "expense" }];
  const excluded = { key: "fixed:art", amount: 240000, label: "학원비-미술학원-한솔", day: 5 };
  const owner = { key: "fixed:gumi", amount: 240000, label: "관리비-구미아파트(부모님)", day: 7 };

  // ⓐ 제외 항목이 앞에 있으면 훔친다 — 고치기 전의 순서(회귀 증거)
  const before = matchOutflowActuals([excluded, owner], txns, TOL);
  eq("★제외 항목이 앞에 있으면 남의 거래를 가져간다(회귀 증거)", before.get("fixed:art")?.amount, 240000);
  eq("  그래서 진짜 주인은 미출금으로 남는다", before.has("fixed:gumi"), false);

  // ⓑ 제외 항목을 맨 뒤로 밀면 진짜 주인이 가져간다 — 호출부가 이 순서를 만든다
  const after = matchOutflowActuals([owner, excluded], txns, TOL);
  eq("★제외 항목을 뒤로 밀면 진짜 주인이 가져간다", after.get("fixed:gumi")?.amount, 240000);
  eq("  제외 항목은 남은 거래가 없어 비게 된다", after.has("fixed:art"), false);

  // ⓒ ★그렇다고 제외 항목을 매칭에서 **빼면 안 된다** — 경쟁자가 없을 땐 자기 거래를 가져가야
  //   익월 기본값(설계 81 §E)과 '최근 3개월 실적' 판정이 유지된다. 뒤로 밀기만 하면 이게 지켜진다.
  const rentTxn = [{ amount: 480000, counterparty: "월세", txn_date: "2026-08-05", type: "expense" }];
  const alone = matchOutflowActuals([{ key: "fixed:rent", amount: 500000, label: "월세", day: 5 }], rentTxn, TOL);
  eq("★경쟁자가 없으면 제외 항목도 자기 거래를 가져간다", alone.get("fixed:rent")?.amount, 480000);
}

// ★위 [6]은 matchOutflowActuals 의 성질만 본다 — **운영 코드를 되돌려도 통과한다**(교차리뷰 지적).
//   그래서 실제 회귀는 여기서 cashflowSnapshot 을 통째로 돌려 잡는다. 순서를 만드는 주체가
//   cashflow-snapshot.ts 의 monthMatchItems 이므로, 그 정렬을 지우면 이 묶음이 빨갛게 된다.
console.log("\n[7] cashflowSnapshot 종단 — 제외 항목이 진짜 주인의 거래를 못 가져간다");
{
  const { cashflowSnapshot } = await import("../src/lib/household/cashflow-snapshot");
  const MONTH = "2026-08";
  const OWNER = "owner-1";
  const sp = (id: string, title: string, amount: number, day: number) =>
    ({
      id, owner_auth_uid: OWNER, title, direction: "out", amount, frequency: "monthly", pay_day: day,
      account_id: "acc-1", category_id: "cat-1", is_active: true, start_date: null, end_date: null,
      person_id: null, memo: null, sort_order: 0, created_at: "", updated_at: "",
    }) as never;

  // 미술학원(5일)은 '직접 제외', 구미아파트(7일)가 진짜 주인. 둘 다 240,000.
  const scheduled = [sp("sp-art", "학원비-미술학원-한솔", 240_000, 5), sp("sp-gumi", "관리비-구미아파트(부모님)", 240_000, 7)];
  const actual = { amount: 240_000, counterparty: "김교사(3030영어 (구미아파트)", txn_date: "2026-08-07" };
  // 두 항목 모두 '최근 실적 있음'이어야 표에 남는다 — 지난달 실적을 하나씩 준다.
  const recentOutflows = [
    actual,
    { amount: 240_000, counterparty: "모마미술관이화미술", txn_date: "2026-07-27" },
  ];
  const released = {
    id: "ov-art", owner_auth_uid: OWNER, year_month: MONTH, source_kind: "fixed", source_id: "sp-art",
    amount_override: null, account_id: null, released: true, day_override: null, paid_override: null,
    created_at: "", updated_at: "",
  } as never;

  const base = {
    scheduled, loans: [], installments: [], txns: [], methods: [],
    recentOutflows, totalCash: 10_000_000, horizon: 3, accountIds: ["acc-1"],
    overrides: [released], nextOverrides: [],
  };
  const snap = cashflowSnapshot(MONTH, base as never);
  const byKey = (k: string) => snap.classified.find((i: { key: string }) => i.key === k);

  eq("★진짜 주인(구미아파트)이 8/7 거래를 가져간다", byKey("fixed:sp-gumi")?.paidAmount, 240_000);
  eq("  제외한 미술학원은 그 거래를 못 가져간다", byKey("fixed:sp-art")?.paidAmount ?? null, null);
  // released 항목이 '최근 실적 없음'으로 표에서 사라지지 않아야 한다(빼면 안 되는 이유).
  // classified 에서 사라지면 다음 달 예측에서도 빠진다 — released 를 아예 빼면 안 되는 이유.
  eq("★제외 항목도 표에 남아 있다(최근 실적 판정은 살아 있다)", byKey("fixed:sp-art") != null, true);
}

console.log("\n[8] payment 3패스(설계 166) — 카드대금·대출납부는 금액이 달라도 상호·계좌로 잡는다");
{
  // 실측 배경(2026-08-12, 팀장 지적 "전월 출금이 빠진 게 있다"): 전월 payment 16건 중 6건이
  // 어느 행에도 안 붙었다 — 카드대금은 달마다 금액이 크게 변해 ±30% 근사가 깨진다.
  // ⓐ 상호 일치 + 금액 무관(현대카드 사례: 예상 1,625,572 vs 실납부 2,650,090)
  // 명의는 합성값(명의A/명의B) — 실명을 픽스처에 넣지 않는다(2026-08-10 교차리뷰 원칙).
  const hyundai = [{ amount: 2_650_090, counterparty: "현대카드대금", txn_date: "2026-07-01", type: "payment", from_account_id: "acc-kb" }];
  const m1 = matchOutflowActuals([{ key: "fixed:hd", amount: 1_625_572, label: "카드대금-현대카드-명의A", day: 1, accountId: "acc-kb" }], hyundai, TOL);
  eq("★카드대금은 금액이 ±30% 넘게 달라도 상호로 잡는다", m1.get("fixed:hd")?.amount, 2_650_090);

  // ⓑ 같은 상호("삼성카드")의 두 명의 — 출금계좌가 다른 항목엔 안 붙는다(오귀속 방지 계좌 게이트)
  const samsung = [{ amount: 1_363_233, counterparty: "삼성카드", txn_date: "2026-07-27", type: "payment", from_account_id: "acc-toss" }];
  const items2 = [
    { key: "fixed:na", amount: 1_200_000, label: "카드대금-삼성카드-명의A", day: 27, accountId: "acc-kb" },   // 계좌 불일치
    { key: "fixed:han", amount: 666_726, label: "카드대금-삼성카드-명의B", day: 26, accountId: "acc-toss" }, // 계좌 일치
  ];
  const m2 = matchOutflowActuals(items2, samsung, TOL);
  eq("★계좌가 다른 명의A는 못 가져간다", m2.has("fixed:na"), false);
  eq("★계좌가 맞는 명의B가 가져간다", m2.get("fixed:han")?.amount, 1_363_233);

  // ⓒ 근사-정밀 — 변동금리 대출은 상호가 아예 달라도 몇십 원 차이면 잡는다(사잇돌 87원차 실사례)
  const saitdol = [{ amount: 102_367, counterparty: "토스 대출 원금·이자 자동이체(0472)", txn_date: "2026-07-06", type: "payment", from_account_id: "acc-toss" }];
  const m3 = matchOutflowActuals([{ key: "loan:sd", amount: 102_280, label: "토스_사잇돌대출", day: 4, accountId: "acc-toss" }], saitdol, TOL);
  eq("★87원 차이 변동금리 대출납부를 잡는다(근사-정밀)", m3.get("loan:sd")?.amount, 102_367);

  // ⓓ kb→국민 별칭 — 은행 원문 "KB카드" 가 "국민카드" 행에 닿는다
  const kb = [{ amount: 459_200, counterparty: "KB카드 카드 (", txn_date: "2026-07-10", type: "payment", from_account_id: "acc-kb" }];
  const m4 = matchOutflowActuals([{ key: "fixed:kb", amount: 289_166, label: "카드대금-국민카드-이바다", day: 10, accountId: "acc-kb" }], kb, TOL);
  eq("★'KB카드' 원문이 '국민카드' 행에 붙는다(별칭)", m4.get("fixed:kb")?.amount, 459_200);

  // ⓔ ★expense 는 3패스 대상이 아니다 — SKT 가 KT 거래를 훔친 사고(설계 108 후속)의 재발 방지.
  //   금액이 ±30% 넘게 다른 expense 는 상호가 부분일치해도 종전대로 안 붙는다.
  const kt = [{ amount: 40_000, counterparty: "KT", txn_date: "2026-07-21", type: "expense" }];
  const m5 = matchOutflowActuals([{ key: "fixed:skt", amount: 111_490, label: "통신비-SKT", day: 26 }], kt, TOL);
  eq("★expense 는 금액 ±30% 초과면 종전대로 안 붙는다", m5.has("fixed:skt"), false);

  // ⓕ 날짜 가드는 3패스에도 걸린다 — 월초 payment 가 월말 예정 항목에 붙지 않는다
  const early = [{ amount: 500_000, counterparty: "몰라카드대금", txn_date: "2026-07-02", type: "payment", from_account_id: "acc-kb" }];
  const m6 = matchOutflowActuals([{ key: "fixed:late", amount: 499_900, label: "다른카드대금", day: 26, accountId: "acc-kb" }], early, TOL);
  eq("★월초 payment 가 월말 예정 항목에 안 붙는다(날짜 가드)", m6.has("fixed:late"), false);

  // ⓖ 계좌를 모르는 쪽이 있으면 게이트를 판정하지 않는다(등록 계좌가 낡은 실사례 보호)
  const unknownAcc = [{ amount: 387_740, counterparty: "하나저축은행", txn_date: "2026-07-10", type: "payment", from_account_id: "acc-hana" }];
  const m7 = matchOutflowActuals([{ key: "loan:hana", amount: 388_070, label: "대출상환-하나저축은행", day: 10, accountId: null }], unknownAcc, TOL);
  eq("★항목 계좌 미지정이면 게이트 없이 종전대로 잡는다", m7.get("loan:hana")?.amount, 387_740);

  // ⓗ 계좌를 **아는** 쪽끼리 다르면 안 붙는다 — ⓖ 의 짝(면제 아닌 쪽)을 함께 고정한다.
  //   ★대출이 이 게이트를 타는지는 여기서 정하지 않는다. 호출부(cashflow-snapshot)가 대출에는
  //   계좌를 아예 안 넘긴다 — 대출 원장의 계좌는 현재값 하나뿐이라 과거 달에 대면 시대착오라서다
  //   (설계 185 후속, 팀장 판정 2026-08-19). 그 종단 동작은 test_next_month_outflow §[16] 이 지킨다.
  //   여기 단위 테스트에 계좌를 손으로 먹이면 그 결정을 못 잡는다(2026-08-19 리뷰가 잡은 실수).
  const otherAcc = [{ amount: 387_740, counterparty: "하나저축은행", txn_date: "2026-07-10", type: "payment", from_account_id: "acc-hana-old" }];
  const m8 = matchOutflowActuals([{ key: "fixed:hana", amount: 388_070, label: "대출상환-하나저축은행", day: 10, accountId: "acc-hana" }], otherAcc, TOL);
  eq("★양쪽 계좌를 다 아는데 다르면 안 붙는다(게이트 본래 동작)", m8.has("fixed:hana"), false);
  const sameAcc = [{ amount: 387_740, counterparty: "하나저축은행", txn_date: "2026-07-10", type: "payment", from_account_id: "acc-hana" }];
  const m9 = matchOutflowActuals([{ key: "fixed:hana", amount: 388_070, label: "대출상환-하나저축은행", day: 10, accountId: "acc-hana" }], sameAcc, TOL);
  eq("계좌가 같으면 종전대로 잡는다", m9.get("fixed:hana")?.amount, 387_740);
}

console.log("\n[9] 금액 단독 일치는 계좌가 맞는 항목이 우선한다 (설계 188)");
{
  // 실측 배경(2026-08-24, 팀장 지적 "25일자 금액이 들어갔다"): 8/24 우리은행 출금 100,000
  // (상대=계좌번호 원문이라 상호 대조 불가 — 픽스처는 합성 번호)이 토스뱅크에서 나갈
  // '적금-한솔(증권)'(25일)에 '출금됨'으로 붙었다. 같은 금액·같은 계좌(우리은행)의
  // 진짜 주인은 당월보류라 배열 뒤였다.
  // ★하드 게이트(계좌 다르면 차단)는 기각 — 5개월 대조에서 계좌 전환 전(3~6월) 보험료
  //   실납부 6건이 미출금으로 뒤집혔다(설계 185 와 같은 시대착오. diag_gate_compare_20260824).
  //   대신 **정확금액 매칭 안에서 계좌 일치 짝을 먼저 확정**한다 — 경쟁자가 없으면 종전대로.
  const woori = [{ amount: 100_000, counterparty: "9990011122233", txn_date: "2026-08-24", type: "expense", account_id: "acc-woori" }];
  const items = [
    { key: "fixed:sec", amount: 100_000, label: "적금-한솔(증권)", day: 25, accountId: "acc-toss" },   // 계좌 불일치, 배열 앞
    { key: "fixed:chung", amount: 100_000, label: "적금-청약저축-합성", day: 25, accountId: "acc-woori" }, // 계좌 일치, 배열 뒤(보류)
  ];
  const m1 = matchOutflowActuals(items, woori, TOL);
  eq("★계좌가 맞는 항목이 배열 뒤(보류)여도 가져간다", m1.get("fixed:chung")?.amount, 100_000);
  eq("★계좌가 다른 항목은 빈칸으로 남는다", m1.has("fixed:sec"), false);

  // 경쟁자가 없으면 계좌가 달라도 종전대로 잡는다 — 계좌 전환 전 과거 달 실적 보호(설계 185 정신).
  const m2 = matchOutflowActuals([items[0]], woori, TOL);
  eq("★경쟁자가 없으면 계좌가 달라도 종전대로 잡는다(과거 실적 보호)", m2.get("fixed:sec")?.amount, 100_000);

  const noAcc = [{ amount: 100_000, counterparty: "9990011122233", txn_date: "2026-08-24", type: "expense" }];
  const m3 = matchOutflowActuals(items, noAcc, TOL);
  eq("거래 계좌 미상이면 우선순위 없이 종전대로(배열 앞이 가져감)", m3.get("fixed:sec")?.amount, 100_000);

  // 상호까지 맞으면(score 40) 계좌 우선순위보다 세다 — 낡은 등록계좌의 진짜 실적을 잃지 않는다.
  const named = [{ amount: 100_000, counterparty: "한솔 증권통장", txn_date: "2026-08-24", type: "expense", account_id: "acc-woori" }];
  const m4 = matchOutflowActuals(items, named, TOL);
  eq("★상호일치는 계좌 일치보다 우선한다", m4.get("fixed:sec")?.amount, 100_000);

  // 한 항목이 계좌 일치·불일치 거래를 다 볼 수 있으면 일치 쪽을 고른다.
  const two = [
    { amount: 100_000, counterparty: "1111111111111", txn_date: "2026-08-24", type: "expense", account_id: "acc-woori" },
    { amount: 100_000, counterparty: "2222222222222", txn_date: "2026-08-24", type: "expense", account_id: "acc-toss" },
  ];
  const m5 = matchOutflowActuals([items[0]], two, TOL);
  eq("★같은 금액이 여럿이면 자기 계좌 거래를 고른다", m5.get("fixed:sec")?.counterparty, "2222222222222");

  // ★payment 거래는 계좌 우선패스를 타지 않는다(적대적 리뷰 M1) — 대출은 호출부가 계좌를 안 넘겨
  //   정확금액 상한이 '미상'이라, 계좌일치 항목이 대출의 상환 거래(payment)를 가로채면 설계 185 의
  //   대출 실적 보호가 깨진다. payment 는 옛 동작(배열 순서) 그대로 둔다 — 이번 오귀속 사고의
  //   거래는 expense 라 수정 효과에는 지장이 없다.
  const loanPay = [{ amount: 300_000, counterparty: "1234567890123", txn_date: "2026-08-25", type: "payment", from_account_id: "acc-woori" }];
  const loanItems = [
    { key: "loan:a", amount: 300_000, label: "대출상환-합성", day: 25, accountId: null },      // 대출: 계좌 미상, 배열 앞
    { key: "fixed:b", amount: 300_000, label: "적금-합성", day: 25, accountId: "acc-woori" }, // 계좌 일치, 배열 뒤
  ];
  const m6 = matchOutflowActuals(loanItems, loanPay, TOL);
  eq("★payment 거래는 계좌일치 항목이 가로채지 못한다 — 대출(배열 앞)이 종전대로 가져간다", m6.get("loan:a")?.amount, 300_000);
  eq("  계좌일치 항목은 빈칸", m6.has("fixed:b"), false);

  // ★대출 상환이 expense 로 기록돼도 보호된다(클로드 리뷰 High) — 발급사명이 없는 계좌이체
  //   상환·약관대출 이자는 payment 가 아니라 expense 로 들어온다. 거래 타입이 아니라 **항목의
  //   accountBlind(대출)** 로 판정: 같은 금액의 대출이 경쟁에 있으면 그 금액은 세분하지 않는다
  //   (= 옛 배열 순서). 대출이 없는 금액에서만 계좌일치 우선패스가 작동한다.
  const loanExp = [{ amount: 300_000, counterparty: "1234567890123", txn_date: "2026-08-25", type: "expense", account_id: "acc-woori" }];
  const blindItems = [
    { key: "loan:a", amount: 300_000, label: "대출상환-합성", day: 25, accountId: null, accountBlind: true }, // 대출, 배열 앞
    { key: "fixed:b", amount: 300_000, label: "적금-합성", day: 25, accountId: "acc-woori" },               // 계좌 일치, 배열 뒤
  ];
  const m7 = matchOutflowActuals(blindItems, loanExp, TOL);
  eq("★expense 상환도 대출(배열 앞)이 종전대로 가져간다 — 계좌일치가 가로채지 못한다", m7.get("loan:a")?.amount, 300_000);
  eq("  계좌일치 항목은 빈칸으로 남는다", m7.has("fixed:b"), false);

  // 의도 고정(리뷰 M4): 활성 항목이 계좌 미상이고 보류 항목이 계좌 일치면 — **계좌 증거가 이긴다.**
  //   (설계 188 문서의 '남는 한계' 절에 공개된 트레이드오프. 대출은 위 accountBlind 로 별도 보호.)
  const pinItems = [
    { key: "fixed:unknown", amount: 100_000, label: "계좌미상-활성", day: 25, accountId: null },        // 배열 앞
    { key: "fixed:match", amount: 100_000, label: "계좌일치-보류", day: 25, accountId: "acc-woori" },  // 배열 뒤(보류)
  ];
  const m8 = matchOutflowActuals(pinItems, woori, TOL);
  eq("★계좌 미상 활성보다 계좌 일치 보류가 먼저다(의도 고정)", m8.get("fixed:match")?.amount, 100_000);

  // 의도 고정(리뷰 M5): 상호+근사(20)뿐인 항목은 정확금액+계좌일치(36) 항목에게 그 거래를 내준다.
  //   총 매칭 수가 줄 수 있는 공개된 트레이드오프 — 금액 우연(다른 항목 예정액 == 실거래액)이 필요해 드묾.
  const starveTxn = [{ amount: 500_000, counterparty: "BBB카드대금", txn_date: "2026-08-25", type: "expense", account_id: "acc-woori" }];
  const starveItems = [
    { key: "fixed:bbb", amount: 460_000, label: "BBB카드", day: 25, accountId: "acc-woori" },   // 상호+근사(20), 배열 앞
    { key: "fixed:ex", amount: 500_000, label: "무관항목", day: 25, accountId: "acc-woori" },   // 정확+계좌일치(36), 배열 뒤
  ];
  const m9 = matchOutflowActuals(starveItems, starveTxn, TOL);
  eq("★정확금액+계좌일치가 상호+근사보다 먼저다(의도 고정)", m9.get("fixed:ex")?.amount, 500_000);
  eq("  상호+근사 항목은 빈칸(공개된 트레이드오프)", m9.has("fixed:bbb"), false);
}

// ★[9]는 matchOutflowActuals 의 성질만 본다 — 호출부가 계좌를 안 넘기면 옛 코드로 되돌려도
//   통과한다(RULES 28). 그래서 cashflowSnapshot 을 통째로 돌려 종단으로도 고정한다.
console.log("\n[10] cashflowSnapshot 종단 — 보류 중인 진짜 주인(계좌 일치)이 거래를 가져간다 (설계 188)");
{
  const { cashflowSnapshot } = await import("../src/lib/household/cashflow-snapshot");
  const MONTH = "2026-08";
  const OWNER = "owner-1";
  const sp = (id: string, title: string, amount: number, day: number, accountId: string) =>
    ({
      id, owner_auth_uid: OWNER, title, direction: "out", amount, frequency: "monthly", pay_day: day,
      account_id: accountId, category_id: "cat-1", is_active: true, start_date: null, end_date: null,
      person_id: null, memo: null, sort_order: 0, created_at: "", updated_at: "",
    }) as never;
  // 실사례 축약: 활성 항목(토스뱅크)과 당월보류 항목(우리은행)이 같은 금액·같은 날.
  const scheduled = [
    sp("sp-sec", "적금-한솔(증권)", 100_000, 25, "acc-toss"),
    sp("sp-chung", "적금-청약저축-합성", 100_000, 25, "acc-woori"),
  ];
  const released = {
    id: "ov-chung", owner_auth_uid: OWNER, year_month: MONTH, source_kind: "fixed", source_id: "sp-chung",
    amount_override: null, account_id: null, released: true, day_override: null, paid_override: null,
    created_at: "", updated_at: "",
  } as never;
  const wooriTxn = { amount: 100_000, counterparty: "9990011122233", txn_date: "2026-08-24", type: "expense", account_id: "acc-woori" };
  const base = {
    scheduled, loans: [], installments: [], txns: [], methods: [],
    recentOutflows: [
      // 전월 실적(두 항목 다 표에 남도록) + 이번 달 우리은행 출금 1건.
      { amount: 100_000, counterparty: "한솔 증권통장", txn_date: "2026-07-26", type: "expense", account_id: "acc-toss" },
      { amount: 100_000, counterparty: "청약저축", txn_date: "2026-07-25", type: "expense", account_id: "acc-woori" },
      wooriTxn,
    ],
    totalCash: 10_000_000, horizon: 3, accountIds: ["acc-toss", "acc-woori"],
    overrides: [released], nextOverrides: [],
  };
  const snap = cashflowSnapshot(MONTH, base as never);
  const byKey = (k: string) => snap.classified.find((i: { key: string }) => i.key === k);
  eq("★활성 항목(다른 계좌)에 '출금됨'이 안 붙는다(빈칸)", byKey("fixed:sp-sec")?.paidAmount ?? null, null);
  eq("★보류 중인 같은 계좌 항목이 그 거래를 가져간다", byKey("fixed:sp-chung")?.paidAmount, 100_000);
}

console.log(fail === 0 ? "\n전부 통과 ✅" : `\n실패 ${fail}건 ❌`);
process.exit(fail === 0 ? 0 : 1);
