// 대출 저장 규칙 검증 (설계 96) — 합성 케이스만, DB 없이.
//   npm run test:loan-save
//
// 이 파일이 지키는 것: 대출 금액이 DB 로 가는 경로가 팝업·페이지 두 개인데
// 검증과 변환은 loan-save.ts 한 곳뿐이어야 한다. 규칙이 갈라지면 여기서 깨진다.
const { validateLoanForm, loanFormWarnings, buildLoanPayload, loanFormFrom } = await import("../src/lib/household/loan-save");

let fail = 0;
const eq = (name: string, a: unknown, b: unknown) => {
  if (Object.is(a, b)) console.log(`  ✅ ${name}`);
  else { fail++; console.log(`  ❌ ${name} — 기대 ${JSON.stringify(b)}, 실제 ${JSON.stringify(a)}`); }
};

type Form = ReturnType<typeof loanFormFrom>;
const base = (over: Partial<Form> = {}): Form => ({ ...loanFormFrom(null), name: "디딤돌대출", principal: 50_000_000, ...over });

console.log("\n[1] 대출명");
eq("정상", validateLoanForm(base()), null);
eq("빈 이름 거부", validateLoanForm(base({ name: "" })), "대출명을 입력해주세요.");
eq("공백만 있는 이름 거부", validateLoanForm(base({ name: "   " })), "대출명을 입력해주세요.");

console.log("\n[2] 원금 — 0원 대출은 없다");
eq("1원 허용", validateLoanForm(base({ principal: 1 })), null);
eq("0원 거부", validateLoanForm(base({ principal: 0 })), "대출금액(원금)은 1원 이상이어야 합니다.");
eq("음수 거부", validateLoanForm(base({ principal: -1 })), "대출금액(원금)은 1원 이상이어야 합니다.");

console.log("\n[3] 상환일 1~28 (29~31 은 없는 달이 있어 막는다)");
eq("미입력 허용", validateLoanForm(base({ payment_day: "" })), null);
eq("1일 허용", validateLoanForm(base({ payment_day: 1 })), null);
eq("28일 허용", validateLoanForm(base({ payment_day: 28 })), null);
eq("0일 거부", validateLoanForm(base({ payment_day: 0 })), "상환일은 1~28 사이여야 합니다.");
eq("29일 거부", validateLoanForm(base({ payment_day: 29 })), "상환일은 1~28 사이여야 합니다.");

console.log("\n[4] payload — 빈 값은 0 이 아니라 null 이어야 한다");
// 0 으로 저장되면 '이자율 0%'·'상환일 0일'처럼 입력 안 한 값이 확정된 값처럼 굳는다.
const empty = buildLoanPayload(base());
eq("이자율 미입력 → null", empty.interest_rate, null);
eq("월납입금 미입력 → null", empty.monthly_payment, null);
eq("상환일 미입력 → null", empty.payment_day, null);
eq("대출일 미입력 → null", empty.origin_date, null);
eq("만기일 미입력 → null", empty.maturity_date, null);
eq("출금계좌 미지정 → null", empty.account_id, null);
eq("현재잔액 미입력 → 0 (잔액은 null 이 아니라 0)", empty.current_balance, 0);

console.log("\n[5] payload — 입력한 값은 숫자로 보존");
const filled = buildLoanPayload(base({
  name: "  디딤돌대출  ",
  interest_rate: 3.5,
  monthly_payment: 540_000,
  payment_day: 25,
  origin_date: "2024-03-01",
  maturity_date: "2054-03-01",
  account_id: "acct-1",
  current_balance: 48_000_000,
  status: "closed",
}));
eq("대출명 앞뒤 공백 제거", filled.name, "디딤돌대출");
eq("이자율 보존", filled.interest_rate, 3.5);
eq("월납입금 보존", filled.monthly_payment, 540_000);
eq("상환일 보존", filled.payment_day, 25);
eq("대출일 보존", filled.origin_date, "2024-03-01");
eq("출금계좌 보존", filled.account_id, "acct-1");
eq("현재잔액 보존", filled.current_balance, 48_000_000);
eq("상태 보존", filled.status, "closed");

console.log("\n[6] loanFormFrom — 등록 모드는 반드시 빈 값이어야 한다 (설계 96 (가))");
// 팝업 하나로 등록·수정을 겸하므로, 수정하던 값이 등록 폼에 남으면
// 엉뚱한 금액의 대출이 새로 생긴다. 열 때마다 target 으로부터 다시 만든다.
const prev = {
  id: "loan-1", owner_auth_uid: "u", name: "이전대출", origin_date: "2024-01-01",
  principal: 99_000_000, current_balance: 88_000_000, maturity_date: "2044-01-01",
  interest_rate: 4.2, monthly_payment: 700_000, payment_day: 15,
  account_id: "acct-9", repayment_type: "equal_principal" as const, source: "manual" as const,
  status: "active" as const, created_at: "", updated_at: "",
};
const edit = loanFormFrom(prev);
eq("수정 모드 — 값이 채워진다", edit.principal, 99_000_000);
eq("수정 모드 — 계좌도 채워진다", edit.account_id, "acct-9");
eq("수정 모드 — 상환방식도 채워진다 (설계 168)", edit.repayment_type, "equal_principal");

const fresh = loanFormFrom(null);
eq("등록 모드 — 대출명 빈 문자열", fresh.name, "");
eq("등록 모드 — 원금 0 (이전 99,000,000 이 남으면 안 된다)", fresh.principal, 0);
eq("등록 모드 — 잔액 0", fresh.current_balance, 0);
eq("등록 모드 — 이자율 빈 값", fresh.interest_rate, "");
eq("등록 모드 — 월납입금 빈 값", fresh.monthly_payment, "");
eq("등록 모드 — 상환일 빈 값", fresh.payment_day, "");
eq("등록 모드 — 계좌 빈 값", fresh.account_id, "");
// ★비워 두면 null 로 저장돼 '원리금균등 가정'이 된다 — 'annuity(확인함)'로 굳히면 안 된다.
eq("등록 모드 — 상환방식 미지정", fresh.repayment_type, "");
eq("미지정은 null 로 저장된다", buildLoanPayload(fresh).repayment_type, null);
eq("등록 모드 — 상태 기본 상환중", fresh.status, "active");
// 등록 폼은 그 자체로 저장 불가여야 한다(이름·원금이 비어 있으므로).
eq("등록 모드 초기 상태는 검증에서 막힌다", validateLoanForm(fresh), "대출명을 입력해주세요.");

console.log("\n[7] 음수·비정상 수치 검증 (설계 179 §4)");
eq("유한수가 아닌 원금 거부", validateLoanForm(base({ principal: Number.NaN })), "대출금액(원금)이 올바르지 않습니다.");
eq("음수 잔액 거부", validateLoanForm(base({ current_balance: -1 })), "현재잔액은 0원 이상이어야 합니다.");
eq("유한수가 아닌 잔액 거부", validateLoanForm(base({ current_balance: Number.POSITIVE_INFINITY })), "현재잔액은 0원 이상이어야 합니다.");
eq("음수 이자율 거부", validateLoanForm(base({ interest_rate: -0.1 })), "이자율은 0 이상이어야 합니다.");
eq("이자율 상한(numeric(5,2)) 초과 거부", validateLoanForm(base({ interest_rate: 1000 })), "이자율이 너무 큽니다(999.99% 이하). 연 %로 입력하세요.");
eq("음수 월상환액 거부", validateLoanForm(base({ monthly_payment: -1 })), "월 상환액은 0원 이상이어야 합니다.");
eq("빈 이자율·월상환액 허용", validateLoanForm(base({ interest_rate: "", monthly_payment: "" })), null);

console.log("\n[8] 현재잔액이 원금보다 큰 경우는 차단 대신 경고");
const overPrincipal = base({ principal: 50_000_000, current_balance: 51_000_000 });
eq("잔액>원금도 검증 통과", validateLoanForm(overPrincipal), null);
eq("잔액>원금이면 경고 1건", loanFormWarnings(overPrincipal).length, 1);
eq("잔액≤원금이면 경고 없음", loanFormWarnings(base({ current_balance: 50_000_000 })).length, 0);

if (fail) {
  console.log(`\n❌ ${fail}건 실패`);
  process.exit(1);
}
console.log("\n✅ 전체 통과");
