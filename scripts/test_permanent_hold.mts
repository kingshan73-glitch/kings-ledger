// 설계 98 스모크 테스트 — 영구보류 분류·계산 제외를 DB 없이 합성 데이터로 검증한다.
//   npm run test:perm-hold
const { cashflowSnapshot } = await import("../src/lib/household/cashflow-snapshot");
import type {
  HhCashflowOverride, HhInstallment, HhLoan, HhPaymentMethod, HhScheduledPayment, HhTransaction,
} from "../src/lib/household/types";

const MONTH = "2026-07";
const OWNER = "owner-1";
let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✅ ${name}`);
  else { failures++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}

function sp(over: Partial<HhScheduledPayment>): HhScheduledPayment {
  return {
    id: "x", owner_auth_uid: OWNER, title: "t", kind: "saving", amount: 100_000,
    frequency: "monthly", pay_day: 10, account_id: "acc-1", payment_method_id: null, category_id: "cat-1",
    person_id: null, payee: null, direction: "out", is_active: true,
    permanent_hold: false, start_date: null, end_date: null, created_at: "", updated_at: "",
    ...over,
  };
}

const scheduled: HhScheduledPayment[] = [
  sp({ id: "sp-active", title: "활성적금", is_active: true, permanent_hold: false }),
  sp({ id: "sp-held", title: "영구보류적금", is_active: false, permanent_hold: true }),
  sp({ id: "sp-retired", title: "폐지적금", is_active: false, permanent_hold: false }),
];

const input = {
  scheduled, loans: [] as HhLoan[], installments: [] as HhInstallment[],
  txns: [] as HhTransaction[], methods: [] as HhPaymentMethod[],
  overrides: [] as HhCashflowOverride[],
  // 예측(projection)은 최근 실적 매칭이 있어야 forecastSourceIds 에 들어간다(설계 65, cashflow-snapshot.ts).
  // sp-active 를 예측에 포함시켜 "영구보류/폐지는 빠지고 활성만 남는다"를 실제로 검증하기 위한 실적 매칭.
  // ★날짜를 **지난달**로 둔다: 당월 실적이면 '이미 지급됨'으로 잡혀 첫 달 예측 출금에서 빠지고(설계 110)
  //   그러면 첫 달 outflow 가 0 이 되어 이 단언이 영구보류를 검증하지 못하는 항진명제가 된다.
  recentOutflows: [{ amount: 100_000, counterparty: "활성적금", txn_date: "2026-06-10" }],
  totalCash: 1_000_000, horizon: 3,
};

const snap = cashflowSnapshot(MONTH, input);

check("영구보류 목록에 sp-held 만 포함", snap.permanentlyHeld.length === 1 && snap.permanentlyHeld[0].id === "sp-held",
  `실제 [${snap.permanentlyHeld.map((s) => s.id).join(",")}]`);
check("영구보류는 활성(예정) 목록에서 제외", !snap.activeItems.some((i) => i.sourceId === "sp-held"));
check("폐지는 영구보류 목록에도 없음", !snap.permanentlyHeld.some((s) => s.id === "sp-retired"));
check("폐지는 예정 목록에도 없음", !snap.activeItems.some((i) => i.sourceId === "sp-retired"));
check("영구보류·폐지는 예측 출금에서 빠짐(첫 달 outflow=활성적금 10만뿐)",
  snap.projection[0].outflow === 100_000, `실제 ${snap.projection[0].outflow}`);

console.log(failures === 0 ? "\n✅ 전부 통과" : `\n❌ ${failures}건 실패`);
process.exit(failures === 0 ? 0 : 1);
