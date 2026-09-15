// 설계 194 — 같은 상호로 확정된 지난 납부의 loan_id 재사용 판정(pickReusableLoan) 회귀 테스트.
// 날짜는 절대일을 쓰지 않는다(오늘 기준 상대 오프셋). 픽스처는 가명만.
const { pickReusableLoan, normalizeLoanPayee, GENERIC_PAYEE } = await import("../src/lib/household/loan-reuse");

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log(`  OK ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };
const day = (offset: number) => { const d = new Date(); d.setUTCHours(12, 0, 0, 0); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };
const TODAY = day(0);
const L = "loan-a", L2 = "loan-b";
const active = new Set([L, L2]);
const prior = (counterparty: string, amount: number, loan_id: string | null, offset: number) => ({ counterparty, amount, loan_id, txn_date: day(offset) });

// ① 정확일치 + 유일 + 금액 범위 안 → 채움
ok(pickReusableLoan({ merchant: "갑보험이자", amount: 2989, priorPayments: [prior("갑보험이자", 2893, L, -35), prior("갑보험이자", 2989, L, -66)], activeLoanIds: active, asOfDate: TODAY }) === L, "① 같은 상호·유일 대출·금액 근접 → 재사용");
// ② 부분일치만 → null
ok(pickReusableLoan({ merchant: "갑보험이자", amount: 2989, priorPayments: [prior("갑보험", 2989, L, -30)], activeLoanIds: active, asOfDate: TODAY }) === null, "② 부분일치(상호 조각)는 재사용하지 않는다");
// ③ 대출 둘 → null
ok(pickReusableLoan({ merchant: "갑보험이자", amount: 2989, priorPayments: [prior("갑보험이자", 2989, L, -30), prior("갑보험이자", 2989, L2, -60)], activeLoanIds: active, asOfDate: TODAY }) === null, "③ 지난 확정이 두 대출을 가리키면 모호 → 빈칸");
// ④ 금액 범위 밖(3배) → null
ok(pickReusableLoan({ merchant: "갑보험이자", amount: 9000, priorPayments: [prior("갑보험이자", 2989, L, -30)], activeLoanIds: active, asOfDate: TODAY }) === null, "④ 금액이 ±15% 범위 밖이면 빈칸");
// ⑤ 상호가 기관종류어 → null
ok(GENERIC_PAYEE.test(normalizeLoanPayee("저축은행")) && pickReusableLoan({ merchant: "저축은행", amount: 2989, priorPayments: [prior("저축은행", 2989, L, -30)], activeLoanIds: active, asOfDate: TODAY }) === null, "⑤ 상호가 '저축은행' 같은 기관종류어면 빈칸");
// ⑥ 401일 전 → null
ok(pickReusableLoan({ merchant: "갑보험이자", amount: 2989, priorPayments: [prior("갑보험이자", 2989, L, -401)], activeLoanIds: active, asOfDate: TODAY }) === null, "⑥ 400일보다 오래된 확정은 근거가 아니다");
ok(pickReusableLoan({ merchant: "갑보험이자", amount: 2989, priorPayments: [prior("갑보험이자", 2989, L, -400)], activeLoanIds: active, asOfDate: TODAY }) === L, "⑥' 정확히 400일 전은 포함");
// ⑦ 대출이 active 아님 → null
ok(pickReusableLoan({ merchant: "갑보험이자", amount: 2989, priorPayments: [prior("갑보험이자", 2989, L, -30)], activeLoanIds: new Set([L2]), asOfDate: TODAY }) === null, "⑦ 대출이 상환중(active)이 아니면 빈칸");
// ⑧ 실사례 형태: 상호 '현대약대이자'(도메인 데이터, AGENTS.md), 2,989 · 지난 확정 2,893(35일 전)·2,989(6일 전)
ok(pickReusableLoan({ merchant: "현대약대이자", amount: 2989, priorPayments: [prior("현대약대이자", 2893, L, -35), prior("현대약대이자", 2989, L, -6)], activeLoanIds: active, asOfDate: TODAY }) === L, "⑧ 실사례 — 이자 변동(2,893↔2,989)에도 같은 대출로 붙는다");
// ⑨ 공백·대소문자 차이는 같은 상호로 본다 / 미래 날짜·loan_id 없는 행은 무시
ok(pickReusableLoan({ merchant: "갑보험 이자", amount: 2989, priorPayments: [prior("갑보험이자", 2989, L, -30), prior("갑보험이자", 2989, null, -10), prior("갑보험이자", 2989, L2, +3)], activeLoanIds: active, asOfDate: TODAY }) === L, "⑨ 공백 차이는 같은 상호 · loan_id 없는 행·미래 행은 근거에서 제외");
// ⑪ 밴드는 지난 금액의 min~max 스팬이 아니라 중앙값 ±15% — 중도상환 1건이 섞여도 그 사이 금액이 통과하면 안 된다(배포 전 리뷰 High)
ok(pickReusableLoan({ merchant: "갑저축은행이자", amount: 1_200_000, priorPayments: [prior("갑저축은행이자", 300_000, L, -30), prior("갑저축은행이자", 300_000, L, -60), prior("갑저축은행이자", 5_000_000, L, -90)], activeLoanIds: active, asOfDate: TODAY }) === null, "⑪ 이력에 중도상환(500만)이 섞여도 120만은 빈칸(중앙값 30만 ±15% 밖)");
ok(pickReusableLoan({ merchant: "갑저축은행이자", amount: 320_000, priorPayments: [prior("갑저축은행이자", 300_000, L, -30), prior("갑저축은행이자", 300_000, L, -60), prior("갑저축은행이자", 5_000_000, L, -90)], activeLoanIds: active, asOfDate: TODAY }) === L, "⑪' 같은 이력에서 32만(중앙값 ±15% 안)은 붙는다");
// ⑩ 상호 2글자 → null
ok(pickReusableLoan({ merchant: "갑을", amount: 2989, priorPayments: [prior("갑을", 2989, L, -30)], activeLoanIds: active, asOfDate: TODAY }) === null, "⑩ 상호가 3글자 미만이면 빈칸");

console.log(`\nloan-reuse: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
