// 설계 202 검증: 크로스소스 dedup 오탐을 **잔액 사슬의 안정 상태 복귀 여부**로 가려낸다.
//
// 실행: npm run test:dedup-falsepos   (DB 불필요 — 순수 함수)
//
// ★판정의 핵심: 진짜 중복이면 사슬이 언젠가 안정 상태로 **되돌아오고**, 오탐이면 장부에서 빠진
//   그 금액이 저절로 메워지지 않아 **영영 못 돌아온다.** 왜 중앙값이 아니라 '되풀이되는 값'인지는
//   docs/household/202_dedup-falsepos-balance-audit.md 와 아래 [10] 실측 회귀 참조.
const { buildResiduals, buildAccountMaterials, auditCandidate, findBaseline, ledgerDelta, sortChain } = await import("../src/lib/household/dedup-audit");

let fail = 0;
const eq = (name: string, a: unknown, b: unknown) => {
  if (Object.is(a, b)) console.log(`  ✅ ${name}`);
  else {
    fail++;
    console.log(`  ❌ ${name} — 기대 ${JSON.stringify(b)}, 실제 ${JSON.stringify(a)}`);
  }
};

/** 하루 한 건씩 -1,000 씩 빠지는 평범한 계좌. 장부와 문자가 정확히 맞는 상태. */
function cleanAccount(days: string[], opening = 100_000) {
  const ledger = days.map((d) => ({ date: d, delta: -1_000 }));
  let bal = opening;
  const chain = days.map((d) => ({ date: d, balance: (bal -= 1_000) }));
  return { opening, ledger, chain, pending: [] as { date: string; delta: number }[] };
}
const DAYS = ["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07", "2026-08-08"];
const CAND = { date: "2026-08-05", amount: 3_000, balance: 96_000, accountId: "acc-w" };

console.log("\n[1] 잔차 — 장부·미확정 pending·문자잔액을 한 자로 재는가");
{
  const a = cleanAccount(DAYS);
  const r = buildResiduals(a);
  eq("맞아 있는 계좌의 잔차는 전부 0", r.every((x) => x.residual === 0), true);
  eq("관측일 수만큼 나온다", r.length, DAYS.length);

  // 미확정 pending(장부엔 없지만 실제로 나간 돈)을 반영하지 않으면 잔차가 +금액이 된다.
  const withPending = { ...a, chain: a.chain.map((c) => (c.date >= "2026-08-05" ? { ...c, balance: c.balance - 4_500 } : c)) };
  eq("★pending 미반영이면 잔차가 +4,500 으로 뜬다(오탐과 같은 모양)", buildResiduals(withPending).at(-1)!.residual, 4_500);
  eq("★pending 을 반영하면 0 으로 돌아온다", buildResiduals({ ...withPending, pending: [{ date: "2026-08-05", delta: -4_500 }] }).at(-1)!.residual, 0);
}

console.log("\n[2] 안정 상태 — 잡음이 많아도 '되풀이되는 값'을 고른다");
{
  // 실측 모양: 되돌아오는 값 0 이 12번, 나머지는 제각각 한 번씩.
  const xs = [0, -24_400, 0, 0, -18_823, 0, -40_000, 0, -19_900, 0, -66_700, 0];
  eq("안정 상태 값", findBaseline(xs, 3)?.value, 0);
  eq("그 값이 나온 횟수", findBaseline(xs, 3)?.count, 7);
  eq("★근거가 얇으면 정하지 않는다", findBaseline([-1, -2, -3], 3), null);
  eq("동률이면 0 에 가까운 쪽", findBaseline([5_000, 5_000, 0, 0], 2)?.value, 0);
}

console.log("\n[3] 진짜 중복 — 장부가 이미 맞으면 안정 상태로 되돌아온다");
{
  const v = auditCandidate({ residuals: buildResiduals(cleanAccount(DAYS)), candidate: CAND });
  eq("판정", v.verdict, "true-duplicate");
  eq("안정 상태", v.baseline, 0);
  eq("되돌아왔다", v.returnsToBaseline, true);
}

console.log("\n[4] 오탐(2026-08-05 씨스페이스 3,000원 모양) — 두 번 나갔으면 영영 못 돌아온다");
{
  // 실제로는 3,000 이 두 번 나갔는데 장부엔 한 건뿐 → 후보 날짜부터 장부가 문자보다 3,000 많다.
  const a = cleanAccount(DAYS);
  const chain = a.chain.map((c) => (c.date >= "2026-08-05" ? { ...c, balance: c.balance - 3_000 } : c));
  const v = auditCandidate({ residuals: buildResiduals({ ...a, chain }), candidate: { ...CAND, balance: 94_000 } });
  eq("★판정", v.verdict, "false-positive-suspect");
  eq("안정 상태로 못 돌아왔다", v.returnsToBaseline, false);
  eq("얼마나 어긋났나", v.shift, 3_000);
}

console.log("\n[5] 만성 오차가 있어도 상관없다 — 절대값을 쓰면 안 되는 이유");
{
  const a = cleanAccount(DAYS);
  // 계좌 전체가 처음부터 50,000 어긋나 있다(기초잔액 오류 등). 안정 상태가 50,000 일 뿐이다.
  const chain = a.chain.map((c) => ({ ...c, balance: c.balance - 50_000 }));
  const v = auditCandidate({ residuals: buildResiduals({ ...a, chain }), candidate: { ...CAND, balance: 46_000 } });
  eq("만성 오차 50,000 이 있어도 진짜 중복으로 본다", v.verdict, "true-duplicate");
  eq("안정 상태", v.baseline, 50_000);

  // 만성 오차 위에 오탐이 겹쳐도 드러난다.
  const chain2 = chain.map((c) => (c.date >= "2026-08-05" ? { ...c, balance: c.balance - 3_000 } : c));
  eq("★만성 오차 위의 오탐도 잡는다", auditCandidate({ residuals: buildResiduals({ ...a, chain: chain2 }), candidate: { ...CAND, balance: 43_000 } }).verdict, "false-positive-suspect");
}

console.log("\n[6] '그날 마지막 문자 이후의 지출' 잡음이 판정을 흔들지 못한다");
{
  const a = cleanAccount(DAYS);
  // 8/07 하루만 문자 이후 지출 20,000 이 장부에 더 있다 → 그날 잔차만 튀고 다음 날 복귀.
  const ledger = [...a.ledger, { date: "2026-08-07", delta: -20_000 }];
  const chain = a.chain.map((c) => (c.date >= "2026-08-08" ? { ...c, balance: c.balance - 20_000 } : c));
  eq("튄 날이 있어도 복귀가 있으면 진짜 중복", auditCandidate({ residuals: buildResiduals({ ...a, ledger, chain }), candidate: CAND }).verdict, "true-duplicate");
}

console.log("\n[7] 한참 뒤에 별개 오차가 생겨도 후보 판정은 흔들리지 않는다");
{
  const a = cleanAccount(DAYS);
  const chain = a.chain.map((c) => (c.date >= "2026-08-08" ? { ...c, balance: c.balance - 9_999 } : c));
  eq("후보 직후에 복귀가 있으므로 진짜 중복", auditCandidate({ residuals: buildResiduals({ ...a, chain }), candidate: CAND }).verdict, "true-duplicate");
}

console.log("\n[8] 모르면 모른다고 한다 — 침묵하지 않는다");
{
  const res = buildResiduals(cleanAccount(DAYS));
  eq("잔액이 없으면 판정하지 않는다", auditCandidate({ residuals: res, candidate: { ...CAND, balance: null } }).verdict, "undecidable");
  eq("잔액계좌가 없으면 판정하지 않는다", auditCandidate({ residuals: res, candidate: { ...CAND, accountId: null } }).verdict, "undecidable");
  eq("금액이 없으면 판정하지 않는다", auditCandidate({ residuals: res, candidate: { ...CAND, amount: null } }).verdict, "undecidable");

  const a = cleanAccount(DAYS);
  // 후보 앞쪽 관측이 2건뿐이면 안정 상태를 정할 근거가 얇다.
  const thin = buildResiduals({ ...a, chain: a.chain.filter((c) => c.date >= "2026-08-03") });
  eq("★앞쪽 근거가 얇으면 undecidable", auditCandidate({ residuals: thin, candidate: CAND }).verdict, "undecidable");
  // 뒤쪽 관측이 없으면(후보가 사슬의 끝) 되돌아왔는지 볼 수 없다.
  const early = buildResiduals({ ...a, chain: a.chain.filter((c) => c.date < "2026-08-05") });
  const v = auditCandidate({ residuals: early, candidate: CAND });
  eq("★뒤쪽 관측이 없으면 undecidable", v.verdict, "undecidable");
  eq("안정 상태는 구한 만큼 근거로 남긴다", v.baseline, 0);
}

console.log("\n[9] 안정 상태로도 금액 위로도 안 오면 억지로 가르지 않는다");
{
  const a = cleanAccount(DAYS);
  const chain = a.chain.map((c) => (c.date >= "2026-08-05" ? { ...c, balance: c.balance - 7_777 } : c));
  const v = auditCandidate({ residuals: buildResiduals({ ...a, chain }), candidate: CAND });
  eq("판정", v.verdict, "undecidable");
  eq("어긋난 폭은 근거로 남긴다", v.shift, 7_777);
}

console.log("\n[10] ★실측 회귀 — 2026-09-04 우리은행(김하늘) 사슬 그대로. 알려진 3건은 전부 진짜 중복이다");
{
  // audit_dedup_falsepos.mts --verbose 가 실제로 뽑은 잔차 32일치. 판정 규칙을 바꾸면 여기서 깨진다.
  const residuals = ([
    ["2026-07-07", -24_400], ["2026-07-09", 0], ["2026-07-11", 0], ["2026-07-15", 0], ["2026-07-17", -18_823],
    ["2026-07-19", -40_000], ["2026-07-20", 0], ["2026-07-21", -19_900], ["2026-07-23", 0], ["2026-07-25", -66_700],
    ["2026-07-27", 0], ["2026-07-28", -55_000], ["2026-07-29", -70_150], ["2026-07-30", -9_000], ["2026-07-31", -13_000],
    ["2026-08-03", 0], ["2026-08-04", 0], ["2026-08-05", -6_740], ["2026-08-06", -35_000], ["2026-08-07", -31_800],
    ["2026-08-10", 0], ["2026-08-11", -101_300], ["2026-08-12", -17_160], ["2026-08-13", 0], ["2026-08-14", -176_000],
    ["2026-08-16", -4_500], ["2026-08-20", -42_900], ["2026-08-24", -7_000], ["2026-08-25", -14_400], ["2026-08-29", -4_500],
    ["2026-08-30", 0], ["2026-09-03", 0],
  ] as [string, number][]).map(([date, residual]) => ({ date, residual }));

  const cases = [
    { name: "8/30 씨유(CU)옥길헤 9,000", date: "2026-08-30", amount: 9_000, balance: 36_849 },
    { name: "9/3 어서와 25,000", date: "2026-09-03", amount: 25_000, balance: 7_349 },
    { name: "9/3 세븐일레븐 4,500", date: "2026-09-03", amount: 4_500, balance: 2_849 },
  ];
  for (const c of cases) {
    const v = auditCandidate({ residuals, candidate: { date: c.date, amount: c.amount, balance: c.balance, accountId: "acc-woori" } });
    eq(c.name, v.verdict, "true-duplicate");
  }
  eq("안정 상태는 0 이다", auditCandidate({ residuals, candidate: { ...cases[0], accountId: "acc-woori" } }).baseline, 0);

  // 같은 사슬에서 8/30 건이 만약 오탐이었다면(=8/30 이후 잔차가 9,000 위에 머물렀다면) 잡혔어야 한다.
  const shifted = residuals.map((r) => (r.date >= "2026-08-30" ? { ...r, residual: r.residual + 9_000 } : r));
  eq("★같은 사슬에 오탐을 심으면 잡는다", auditCandidate({ residuals: shifted, candidate: { ...cases[0], accountId: "acc-woori" } }).verdict, "false-positive-suspect");
}

console.log("\n[11] ★교차검토 반영 — '한 번 닿았다'로는 늑대를 부르지 않는다");
{
  const a = cleanAccount(DAYS);
  // 후보 이후 관측이 딱 1건인데 그게 마침 안정상태+금액이다(미귀속 pending 같은 잡음일 수 있다).
  const chain = a.chain.filter((c) => c.date <= "2026-08-05").map((c) => (c.date === "2026-08-05" ? { ...c, balance: c.balance - 3_000 } : c));
  const v = auditCandidate({ residuals: buildResiduals({ ...a, chain }), candidate: { ...CAND, balance: 94_000 } });
  eq("★관측 1건이면 오탐이라 말하지 않는다", v.verdict, "undecidable");
  eq("근거는 남긴다(어긋난 관측 수)", v.afterAtShifted, 1);

  // 관측이 2건 이상이고 거기 머무르면 그때 오탐이라 말한다.
  const chain2 = a.chain.filter((c) => c.date <= "2026-08-06").map((c) => (c.date >= "2026-08-05" ? { ...c, balance: c.balance - 3_000 } : c));
  eq("관측 2건이 머무르면 오탐 의심", auditCandidate({ residuals: buildResiduals({ ...a, chain: chain2 }), candidate: { ...CAND, balance: 94_000 } }).verdict, "false-positive-suspect");

  // 어긋난 값이 최빈이 아니면(한 번만 스치고 다른 데 자리 잡으면) 판정하지 않는다.
  const chain3 = a.chain.map((c) =>
    c.date === "2026-08-05" ? { ...c, balance: c.balance - 3_000 } : c.date > "2026-08-05" ? { ...c, balance: c.balance - 11_111 } : c);
  eq("★스치기만 한 값으로는 판정하지 않는다", auditCandidate({ residuals: buildResiduals({ ...a, chain: chain3 }), candidate: { ...CAND, balance: 94_000 } }).verdict, "undecidable");
}

console.log("\n[12] ★교차검토 반영 — 복귀와 어긋남이 섞이면 조용하되 그 사실을 말한다");
{
  const a = cleanAccount(DAYS);
  // 오탐(+3,000)인데 8/07 하루만 다른 오차가 정반대로 겹쳐 안정 상태에 닿았다.
  const chain = a.chain.map((c) => (c.date < "2026-08-05" || c.date === "2026-08-07" ? c : { ...c, balance: c.balance - 3_000 }));
  const v = auditCandidate({ residuals: buildResiduals({ ...a, chain }), candidate: { ...CAND, balance: 94_000 } });
  eq("복귀가 한 번이라도 있으면 조용한 쪽으로 간다", v.verdict, "true-duplicate");
  eq("★그러나 어긋난 관측이 있었다는 사실을 남긴다", v.afterAtShifted, 3);
  eq("복귀 관측 수도 남긴다", v.afterAtBaseline, 1);
  eq("섞였다는 경고를 reason 에 적는다", v.reason.includes("눈으로 확인"), true);
}

console.log("\n[13] ★교차검토 반영 — FROM 이전은 장부든 미확정이든 '같은 자'로 접는다");
{
  const ledgerRows = [
    { date: "2026-07-20", type: "expense", amount: 5_000, account_id: "acc-w", from_account_id: null, to_account_id: null },
    { date: "2026-08-02", type: "expense", amount: 1_000, account_id: "acc-w", from_account_id: null, to_account_id: null },
  ];
  // 2026-07-20 에 아직 확정 안 된 출금 7,000 이 있다 — 문자잔액에는 이미 반영돼 있다.
  const pendingRows = [{ date: "2026-07-20", type: "expense", amount: 7_000, account_id: "acc-w", from_account_id: null, to_account_id: null }];
  const chainRows = [{ date: "2026-08-02", balance: 100_000 - 5_000 - 7_000 - 1_000 }];
  const mat = buildAccountMaterials({ accountId: "acc-w", openingBalance: 100_000, from: "2026-08-01", ledgerRows, pendingRows, chainRows });
  eq("★FROM 이전 미확정도 기초로 접힌다", mat.opening, 100_000 - 5_000 - 7_000);
  eq("접힌 뒤 잔차는 0 이다", buildResiduals(mat).at(-1)!.residual, 0);
  eq("FROM 이후 장부만 일자별로 남는다", mat.ledger.length, 1);

  const mat2 = buildAccountMaterials({
    accountId: "acc-w", openingBalance: 0, from: "2026-08-01", ledgerRows: [],
    pendingRows: [{ date: "2026-08-02", kind: "cancel", type: "expense", amount: 9_000, account_id: "acc-w", from_account_id: null, to_account_id: null }],
    chainRows: [{ date: "2026-08-02", balance: 0, kind: "cancel" }],
  });
  eq("취소는 미확정에서 빠진다", mat2.pending.length, 0);
  eq("취소 문자는 사슬에서 빠진다", mat2.chain.length, 0);
}

console.log("\n[14] 증감식은 장부와 미확정이 같은 함수를 쓴다 — 카드 할부는 계좌를 건드리지 않는다");
{
  const W = "acc-w", K = "acc-k";
  const row = (o: Record<string, unknown>) => ({ type: null, amount: null, account_id: null, from_account_id: null, to_account_id: null, ...o });
  eq("수입", ledgerDelta(row({ type: "income", amount: 1_000, account_id: W }), W), 1_000);
  eq("지출", ledgerDelta(row({ type: "expense", amount: 1_000, account_id: W }), W), -1_000);
  eq("카드대금 납부는 출금계좌에서 빠진다", ledgerDelta(row({ type: "payment", amount: 1_000, from_account_id: W }), W), -1_000);
  eq("이체 나가는 쪽", ledgerDelta(row({ type: "transfer", amount: 1_000, from_account_id: W, to_account_id: K }), W), -1_000);
  eq("이체 들어오는 쪽", ledgerDelta(row({ type: "transfer", amount: 1_000, from_account_id: W, to_account_id: K }), K), 1_000);
  eq("★신용카드 할부는 은행 잔액을 건드리지 않는다", ledgerDelta(row({ type: "installment", amount: 1_000, account_id: W }), W), 0);
  eq("남의 계좌는 0", ledgerDelta(row({ type: "expense", amount: 1_000, account_id: K }), W), 0);
  eq("금액이 없으면 0", ledgerDelta(row({ type: "expense", amount: null, account_id: W }), W), 0);
}

console.log("\n[15] ★★배포 전 리뷰 Critical — 같은 날 문자가 여럿일 때 '그날 마지막'을 무엇으로 정하는가");
{
  // 이 설계가 존재하는 이유(같은 가게·같은 금액을 초 단위로 두 번)는 본문 시각이 **분 단위라 같다**.
  // 그때 순서를 id(uuid)로 가르면 동전 던지기가 되고, 하필 후보 당일 관측이 뒤집힌다.
  const rows = [
    { date: "2026-08-05", balance: 97_000, time: "22:04", seq: "2026-08-05T13:04:32.9Z", id: "zzzz" }, // 1차 출금 후
    { date: "2026-08-05", balance: 94_000, time: "22:04", seq: "2026-08-05T13:04:34.3Z", id: "aaaa" }, // 2차 출금 후(뒤에 도착)
  ];
  eq("★시각이 같으면 도착 순서가 가른다 — id 가 아니다", sortChain(rows).at(-1)!.balance, 94_000);
  eq("입력 순서를 뒤집어도 같다", sortChain([...rows].reverse()).at(-1)!.balance, 94_000);
  eq("시각 없는 행은 먼저로 본다(아는 행을 제치지 못한다)",
    sortChain([{ date: "2026-08-05", balance: 1, time: null, id: "zzzz" }, { date: "2026-08-05", balance: 2, time: "09:00", id: "aaaa" }]).at(-1)!.balance, 2);

  // 사슬 전체로 이어 붙여 판정까지 확인한다 — 오탐이 진짜중복으로 뒤집히면 안 된다.
  // 상황: 8/05 에 3,000 원이 **실제로 두 번** 나갔는데 장부엔 한 건만 들어갔다(뒤엣것이 duplicate 로 내려갔다).
  const days = ["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04"];
  const ledgerRows = [
    ...[...days, "2026-08-05", "2026-08-06"].map((d) => ({ date: d, type: "expense", amount: 1_000, account_id: "acc-w", from_account_id: null, to_account_id: null })),
    { date: "2026-08-05", type: "expense", amount: 3_000, account_id: "acc-w", from_account_id: null, to_account_id: null }, // 확정된 한 건만
  ];
  let b = 100_000;
  const chainRows: { date: string; balance: number; time?: string | null; seq?: string | null; id?: string | null }[] =
    days.map((d) => ({ date: d, balance: (b -= 1_000), time: "12:00", seq: `${d}T03:00:00Z`, id: "x" }));
  // 8/05 은행 실제: 96,000 −1,000 −3,000 −3,000. 문자 두 통이 **같은 분(22:04)** 에 찍혔다.
  chainRows.push({ date: "2026-08-05", balance: 92_000, time: "22:04", seq: "2026-08-05T13:04:32.9Z", id: "zzzz" });
  chainRows.push({ date: "2026-08-05", balance: 89_000, time: "22:04", seq: "2026-08-05T13:04:34.3Z", id: "aaaa" });
  chainRows.push({ date: "2026-08-06", balance: 88_000, time: "12:00", seq: "2026-08-06T03:00:00Z", id: "y" });
  const cand = { date: "2026-08-05", amount: 3_000, balance: 89_000, accountId: "acc-w" };
  const mat = buildAccountMaterials({ accountId: "acc-w", openingBalance: 100_000, from: "2026-08-01", ledgerRows, pendingRows: [], chainRows });
  eq("★같은 날 두 문자에서도 오탐이 잡힌다", auditCandidate({ residuals: buildResiduals(mat), candidate: cand }).verdict, "false-positive-suspect");

  // ★이 검사에 이빨이 있는지 확인 — 순서를 거꾸로(첫 문자를 '그날 마지막'으로) 잡으면 판정이 뒤집힌다.
  //   즉 sortChain 이 틀리면 여기서 반드시 깨진다.
  const wrong = buildAccountMaterials({
    accountId: "acc-w", openingBalance: 100_000, from: "2026-08-01", ledgerRows, pendingRows: [],
    chainRows: chainRows.map((c) => (c.date === "2026-08-05" ? { ...c, seq: c.balance === 92_000 ? "9" : "1" } : c)),
  });
  eq("★순서가 뒤집히면 오탐이 '진짜중복'으로 잘못 읽힌다(= 이 검사에 이빨이 있다)",
    auditCandidate({ residuals: buildResiduals(wrong), candidate: cand }).verdict, "true-duplicate");
}

console.log("\n[16] ★배포 전 리뷰 High — 재료에서 조용히 빠지는 미확정은 반드시 세어 돌려준다");
{
  const base = { accountId: "acc-w", openingBalance: 0, from: "2026-08-01", ledgerRows: [], chainRows: [] };
  const mat = buildAccountMaterials({
    ...base,
    pendingRows: [
      { date: "2026-08-02", type: "expense", amount: 5_000, account_id: null, from_account_id: null, to_account_id: null },   // 계좌미상
      { date: "2026-08-03", type: null, amount: 6_000, account_id: "acc-w", from_account_id: null, to_account_id: null },      // 유형미상
      { date: "2026-08-04", kind: "cancel", type: "expense", amount: 7_000, account_id: "acc-w", from_account_id: null, to_account_id: null }, // 취소
      { date: "2026-08-05", type: "expense", amount: 8_000, account_id: "acc-k", from_account_id: null, to_account_id: null }, // 남의 계좌 = 정상, 세지 않는다
      { date: "2026-08-06", type: "expense", amount: 9_000, account_id: "acc-w", from_account_id: null, to_account_id: null }, // 정상 반영
    ],
  });
  eq("정상 반영은 1건", mat.pending.length, 1);
  eq("★빠진 것은 3건이다", mat.dropped.length, 3);
  eq("이유를 남긴다", mat.dropped.map((d) => d.why).join(","), "계좌미상,유형미상,취소");
  eq("남의 계좌는 '빠진 것'이 아니다", mat.dropped.some((d) => Number(d.amount) === 8_000), false);
}

console.log("\n[17] ★배포 전 리뷰 M4·L5 — 동률은 입력 순서로 갈리지 않고, 금액 0 은 판정하지 않는다");
{
  eq("★절대값까지 동률이면 작은 값(음수)을 고른다", findBaseline([5_000, 5_000, -5_000, -5_000], 2)?.value, -5_000);
  eq("입력 순서를 뒤집어도 같다", findBaseline([-5_000, -5_000, 5_000, 5_000], 2)?.value, -5_000);
  const res = buildResiduals(cleanAccount(DAYS));
  eq("★금액 0 은 판정하지 않는다", auditCandidate({ residuals: res, candidate: { ...CAND, amount: 0 } }).verdict, "undecidable");
}

console.log(fail === 0 ? "\n✅ 전부 통과" : `\n❌ ${fail}건 실패`);
process.exit(fail === 0 ? 0 : 1);
