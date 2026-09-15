// 통계 '추이' 탭 계산 검증 (설계 88) — 합성 케이스, DB 불필요.
//   npm run test:stats-trend
const { categoryTrend, savingCandidates, TREND_RULES, OVERSPEND_RULES } = await import("../src/lib/household/calc");
import type { HhTransaction } from "../src/lib/household/types";

let fail = 0;
const eq = (name: string, a: unknown, b: unknown) => {
  if (Object.is(a, b)) console.log(`  ✅ ${name}`);
  else { fail++; console.log(`  ❌ ${name} — 기대 ${JSON.stringify(b)}, 실제 ${JSON.stringify(a)}`); }
};

// 지출 거래 생성 헬퍼 — categoryTrend가 쓰는 필드만 채운다.
let seq = 0;
function ex(ym: string, categoryId: string, amount: number): HhTransaction {
  return { id: `t${seq++}`, txn_date: `${ym}-15`, type: "expense", amount, category_id: categoryId } as HhTransaction;
}

// 기준: baseYm=2026-06(마지막 완결월), currentYm=2026-07(진행 중), 3개월 창.
// 직전 기간 = 1~3월, 최근 기간 = 4~6월.
const BASE = "2026-06";
const CUR = "2026-07";

console.log("\n[1] 완결월 절단 — 진행 중인 당월은 비교에서 빠지고 참고점으로만");
{
  const txns = [ex("2026-04", "food", 100_000), ex("2026-07", "food", 999_999)];
  const [line] = categoryTrend(BASE, 3, CUR, txns, []);
  eq("months 길이=2N(6)", line.months.length, 6);
  eq("최근 기간 합에 당월 미포함", line.totalRecent, 100_000);
  eq("당월은 currentMonth로 분리", line.currentMonth, 999_999);
  eq("직전 기간 합 0", line.totalPrev, 0);
}

console.log("\n[2] 증감·정렬 — 더 쓴 카테고리가 위");
{
  const txns = [
    // up: 1~3월 30만 → 4~6월 60만 (+30만)
    ...["2026-01", "2026-02", "2026-03"].map((m) => ex(m, "up", 100_000)),
    ...["2026-04", "2026-05", "2026-06"].map((m) => ex(m, "up", 200_000)),
    // down: 1~3월 60만 → 4~6월 30만 (−30만)
    ...["2026-01", "2026-02", "2026-03"].map((m) => ex(m, "down", 200_000)),
    ...["2026-04", "2026-05", "2026-06"].map((m) => ex(m, "down", 100_000)),
  ];
  const lines = categoryTrend(BASE, 3, CUR, txns, []);
  eq("첫 행=증가 카테고리", lines[0].categoryId, "up");
  eq("증가 diffTotal", lines[0].diffTotal, 300_000);
  eq("감소 diffTotal", lines[1].diffTotal, -300_000);
  eq("월평균(최근)", lines[0].recentAvg, 200_000);
}

console.log("\n[3] 소액 접기 — 양쪽 기간 월평균 모두 1만원 미만");
{
  const txns = [ex("2026-02", "tiny", 9_000), ex("2026-05", "tiny", 8_000), ex("2026-05", "big", 50_000)];
  const lines = categoryTrend(BASE, 3, CUR, txns, []);
  eq("tiny=minor", lines.find((l) => l.categoryId === "tiny")?.minor, true);
  eq("big=minor 아님", lines.find((l) => l.categoryId === "big")?.minor, false);
}

console.log("\n[4] 절약 후보 — 급증 (평균×1.2↑ & 차 3만↑, 과다지출 문턱 재사용)");
{
  const txns = [
    ...["2026-01", "2026-02", "2026-03"].map((m) => ex(m, "dining", 100_000)),
    ...["2026-04", "2026-05", "2026-06"].map((m) => ex(m, "dining", 150_000)),
  ];
  const cands = savingCandidates(categoryTrend(BASE, 3, CUR, txns, []), () => "교통비");
  eq("후보 1개", cands.length, 1);
  eq("급증 신호", cands[0].signals.includes("surge"), true);
  eq("절약액=월평균 증가분", cands[0].monthlySaving, 50_000);
}

console.log("\n[5] 절약 후보 — 신규 (직전 0원, 최근 월평균 10만↑)");
{
  const txns = ["2026-04", "2026-05", "2026-06"].map((m) => ex(m, "newcat", OVERSPEND_RULES.newMin));
  const cands = savingCandidates(categoryTrend(BASE, 3, CUR, txns, []), () => "구독");
  eq("신규 신호", cands[0]?.signals.includes("new"), true);
  eq("절약액=월평균 전액", cands[0]?.monthlySaving, OVERSPEND_RULES.newMin);
}

console.log("\n[6] 절약 후보 — 상승세 (마지막 완결월 3개 연속 증가 & 합 3만↑)");
{
  // 평균 비교로는 급증 문턱(1.2배) 미달이지만 4→5→6월 연속 상승
  const txns = [
    ...["2026-01", "2026-02", "2026-03"].map((m) => ex(m, "edu", 100_000)),
    ex("2026-04", "edu", 90_000), ex("2026-05", "edu", 110_000), ex("2026-06", "edu", 130_000),
  ];
  const cands = savingCandidates(categoryTrend(BASE, 3, CUR, txns, []), () => "교육비");
  eq("상승세 신호", cands[0]?.signals.includes("rising"), true);
  eq("급증은 아님", cands[0]?.signals.includes("surge") ?? false, false);
}

console.log("\n[7] 절약 후보 — 재량지출 단독 (증가 없어도 절대액 크면 후보, 절약액 0)");
{
  const txns = [
    ...["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"].map((m) => ex(m, "cafe", 150_000)),
  ];
  const cands = savingCandidates(categoryTrend(BASE, 3, CUR, txns, []), () => "다과/카페비");
  eq("재량 신호", cands[0]?.signals.includes("discretionary"), true);
  eq("재량 단독=절약액 0(참고 표시용)", cands[0]?.monthlySaving, 0);
}

console.log("\n[8] 절약 후보 — 상위 5개 제한 + 절약액 내림차순");
{
  const txns: HhTransaction[] = [];
  for (let i = 1; i <= 7; i++) {
    for (const m of ["2026-01", "2026-02", "2026-03"]) txns.push(ex(m, `c${i}`, 100_000));
    for (const m of ["2026-04", "2026-05", "2026-06"]) txns.push(ex(m, `c${i}`, 100_000 + i * 40_000));
  }
  const cands = savingCandidates(categoryTrend(BASE, 3, CUR, txns, []), () => "잡비");
  eq(`후보 ${TREND_RULES.maxCandidates}개 제한`, cands.length, TREND_RULES.maxCandidates);
  eq("절약액 1위=c7", cands[0].categoryId, "c7");
  eq("내림차순", cands.every((c, i) => i === 0 || cands[i - 1].monthlySaving >= c.monthlySaving), true);
}

console.log("\n[10] 절약 후보 — 저축성 카테고리(적금 등)는 급증해도 제외");
{
  const txns = [
    ...["2026-01", "2026-02", "2026-03"].map((m) => ex(m, "save", 100_000)),
    ...["2026-04", "2026-05", "2026-06"].map((m) => ex(m, "save", 200_000)),
  ];
  const cands = savingCandidates(categoryTrend(BASE, 3, CUR, txns, []), () => "적금");
  eq("적금은 후보 아님", cands.length, 0);
}

console.log("\n[9] 6개월 창 — months 길이 12, 직전/최근 6개월 분할");
{
  const txns = [ex("2025-07", "food", 70_000), ex("2026-06", "food", 60_000)];
  const [line] = categoryTrend(BASE, 6, CUR, txns, []);
  eq("months 길이 12", line.months.length, 12);
  eq("2025-07은 직전 기간(첫 칸)", line.months[0], 70_000);
  eq("직전 합", line.totalPrev, 70_000);
  eq("최근 합", line.totalRecent, 60_000);
}

console.log(fail === 0 ? "\n전체 통과 ✅" : `\n실패 ${fail}건 ❌`);
process.exitCode = fail === 0 ? 0 : 1;
