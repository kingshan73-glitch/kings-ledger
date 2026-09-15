// 설계 129 검증: 경기지역화폐(부천페이) 충전 문자의 이체 계좌 해석.
//
// 실행: npm run test:localpay-charge   (DB 불필요 — 가짜 supabase 스텁으로 순수 검증)
//
// 실사례(2026-08-03): 부부가 같은 날 300,000원씩 충전했는데
//   ⓐ 규칙(설계 52)의 하드코딩된 from("카카오뱅크(김하늘)")이 **문자가 지목한 계좌를 덮어써서**
//      이바다의 국민은행 출금이 김하늘 카카오뱅크 출금으로 잡혔고 → 두 건의 날짜·금액·출금계좌가
//      같아지며 뒤엣것이 '중복'으로 걸러져 **실거래 1건이 장부에서 통째로 빠졌다**.
//   ⓑ 규칙의 to("경기지역화폐")는 어느 계좌명과도 안 맞아 **항상 null** → 확정 RPC 가
//      '이체는 입금계좌가 필요합니다'로 막아 충전 문자는 확정 자체가 불가능했다.
// 아래 [1]·[2]·[3] 이 그 재발을 막는다. [4]·[5] 는 잔액 귀속(설계 71) 가드다.
const { enrichParsed } = await import("../src/lib/household/sms-ingest");

let fail = 0;
const eq = (name: string, a: unknown, b: unknown) => {
  if (Object.is(a, b)) console.log(`  ✅ ${name}`);
  else {
    fail++;
    console.log(`  ❌ ${name} — 기대 ${JSON.stringify(b)}, 실제 ${JSON.stringify(a)}`);
  }
};
const ne = (name: string, a: unknown, b: unknown) => {
  if (!Object.is(a, b)) console.log(`  ✅ ${name}`);
  else {
    fail++;
    console.log(`  ❌ ${name} — ${JSON.stringify(a)} 와 같으면 안 된다`);
  }
};

const OWNER = "owner-1";
const P_KHN = "p-khn";
const P_LBD = "p-lbd";
const ACC_KB_LBD = "acc-kb-lbd"; // 국민은행(이바다)  110-11-0***-111
const ACC_KAKAO_KHN = "acc-kakao-khn"; // 카카오뱅크(김하늘) 1000-****-0000
const ACC_KAKAO_LBD = "acc-kakao-lbd"; // 카카오뱅크(이바다) 300-20-**1111
const ACC_PAY_LBD = "acc-pay-lbd"; // 부천페이(이바다)  계좌번호 없음
const ACC_PAY_KHN = "acc-pay-khn"; // 부천페이(김하늘)  계좌번호 없음
const PM_KB_CHECK = "pm-kb-check"; // 국민카드(이바다) 체크카드 끝4 2065 → 국민은행(이바다) 연결
const CAT_FOOD = "cat-food";

type Row = Record<string, unknown>;

/** enrichParsed 가 쓰는 만큼만 구현한 체이너블 supabase 스텁(test_unmatched_card_fallback 과 동일 구조). */
function stub(tables: Record<string, Row[]>) {
  const build = (rows: Row[]) => {
    let cur = rows;
    const api: Record<string, unknown> = {
      select: () => api,
      order: () => api,
      limit: (n: number) => {
        cur = cur.slice(0, n);
        return api;
      },
      not: () => api,
      // 설계 194 의 지난 확정 조회(.gte/.lte txn_date) 가 쓴다 — 행에 그 컬럼이 있을 때만 문자열 비교로 거른다.
      gte: (col: string, val: unknown) => { cur = cur.filter((r) => !(col in r) || String(r[col]) >= String(val)); return api; },
      lte: (col: string, val: unknown) => { cur = cur.filter((r) => !(col in r) || String(r[col]) <= String(val)); return api; },
      ilike: (col: string, pat: string) => {
        const needle = String(pat).replace(/%/g, "");
        cur = cur.filter((r) => !(col in r) || String(r[col] ?? "").includes(needle));
        return api;
      },
      eq: (col: string, val: unknown) => {
        cur = cur.filter((r) => !(col in r) || r[col] === val);
        return api;
      },
      maybeSingle: async () => ({ data: cur[0] ?? null, error: null }),
      then: (resolve: (v: { data: Row[]; error: null }) => unknown) => resolve({ data: cur, error: null }),
    };
    return api;
  };
  return { from: (t: string) => build(structuredClone(tables[t] ?? [])) } as never;
}

const ACCOUNTS: Row[] = [
  { owner_auth_uid: OWNER, id: ACC_KB_LBD, name: "국민은행(이바다)", account_no: "110-11-0***-111", person_id: P_LBD, is_active: true },
  { owner_auth_uid: OWNER, id: ACC_KAKAO_KHN, name: "카카오뱅크(김하늘)", account_no: "1000-****-0000", person_id: P_KHN, is_active: true },
  { owner_auth_uid: OWNER, id: ACC_KAKAO_LBD, name: "카카오뱅크(이바다)", account_no: "300-20-**1111", person_id: P_LBD, is_active: true },
  { owner_auth_uid: OWNER, id: ACC_PAY_LBD, name: "부천페이(이바다)", account_no: null, person_id: P_LBD, is_active: true },
  { owner_auth_uid: OWNER, id: ACC_PAY_KHN, name: "부천페이(김하늘)", account_no: null, person_id: P_KHN, is_active: true },
];

/** merchant_map 이 '경기지역화폐'를 김하늘 카카오뱅크로 학습해 둔 상태 — 이바다 문자에 이게 붙으면 안 된다. */
const tables = (): Record<string, Row[]> => ({
  hh_merchant_map: [
    { owner_auth_uid: OWNER, merchant_key: "경기지역화폐 오픈뱅킹", category_id: null, payment_method_id: null, account_id: ACC_KAKAO_KHN },
    { owner_auth_uid: OWNER, merchant_key: "쇼어(Shore)", category_id: CAT_FOOD, payment_method_id: null, account_id: ACC_KB_LBD },
  ],
  hh_account: ACCOUNTS,
  hh_payment_method: [
    {
      owner_auth_uid: OWNER,
      id: PM_KB_CHECK,
      name: "국민카드(이바다) nori 체크카드",
      kind: "check",
      card_no: "1234-5678-9012-2065",
      linked_account_id: ACC_KB_LBD,
      is_active: true,
    },
  ],
  hh_person: [
    { owner_auth_uid: OWNER, id: P_KHN, name: "김하늘" },
    { owner_auth_uid: OWNER, id: P_LBD, name: "이바다" },
  ],
  hh_category: [],
  hh_loan: [],
  hh_scheduled_payment: [],
});

// 실제 수집된 원문 2건(2026-08-03). 손대지 말 것 — 이 형태가 결함을 드러낸다.
const SMS_LBD = "출금 300,000원이*다님 08/03 19:41 110-11-0***-111 경기지역화폐 오픈뱅킹출금 300,000 잔액4,875,291";
const NOTI_KHN = "300,000원 출금 내 토스뱅크 통장 → 코나아이(주)(경기지역화폐)";

console.log("\n[1] 이바다 은행 SMS — 문자가 지목한 계좌(국민은행(이바다))가 규칙 from 을 이긴다");
const lbd = await enrichParsed(stub(tables()), OWNER, SMS_LBD, null);
{
  const { fields } = lbd;
  eq("유형 = 이체", fields.guessed_type, "transfer");
  eq("금액", fields.guessed_amount, 300000);
  eq("★출금계좌 = 국민은행(이바다) (규칙·학습값이 아니라 문자)", fields.guessed_from_account_id, ACC_KB_LBD);
  eq("★입금계좌 = 부천페이(이바다) (같은 주인의 지갑)", fields.guessed_to_account_id, ACC_PAY_LBD);
  eq("이체라 단일계좌는 비운다", fields.guessed_account_id, null);
  eq("잔액", fields.reported_balance, 4875291);
  eq("잔액 귀속 = 국민은행(이바다)", fields.reported_balance_account_id, ACC_KB_LBD);
}

console.log("\n[2] 김하늘 토스 알림 — 문자에 계좌가 없으니 규칙 from 이 폴백으로 쓰인다");
const khn = await enrichParsed(stub(tables()), OWNER, NOTI_KHN, null);
{
  const { fields } = khn;
  eq("유형 = 이체", fields.guessed_type, "transfer");
  eq("출금계좌 = 카카오뱅크(김하늘) (규칙 폴백)", fields.guessed_from_account_id, ACC_KAKAO_KHN);
  eq("★입금계좌 = 부천페이(김하늘) (같은 주인의 지갑)", fields.guessed_to_account_id, ACC_PAY_KHN);
}

console.log("\n[3] ★부부가 같은 날 같은 금액을 충전해도 두 건이 서로 다른 끝점을 갖는다(중복 오판 방지)");
{
  ne("출금계좌가 서로 다르다", lbd.fields.guessed_from_account_id, khn.fields.guessed_from_account_id);
  ne("입금계좌가 서로 다르다", lbd.fields.guessed_to_account_id, khn.fields.guessed_to_account_id);
  eq("금액은 같다(그래서 계좌가 갈려야 한다)", lbd.fields.guessed_amount, khn.fields.guessed_amount);
}

console.log("\n[4] 잔액 귀속 — 계좌 근거가 문자에 없으면(학습값으로만 채워짐) 잔액을 아무 계좌에 붙이지 않는다");
{
  const sms = "출금 54,000원 이*다님 08/03 12:53 쇼어(Shore) 자동이체 54,000 잔액 1,000,000";
  const { fields } = await enrichParsed(stub(tables()), OWNER, sms, null);
  eq("출금계좌는 학습값 그대로(설계 117 회귀)", fields.guessed_account_id, ACC_KB_LBD);
  eq("잔액은 보존", fields.reported_balance, 1000000);
  eq("★잔액 귀속 계좌 = 빈칸 (문자에 근거 없음)", fields.reported_balance_account_id, null);
}

console.log("\n[5] 잔액 귀속 회귀 — 문자가 지목한 체크카드의 '잔액'은 연결계좌에 귀속한다");
{
  const sms = "국민카드 국민2065승인 이*다 12,000원 일시불 08/03 19:41 쇼어(Shore) 잔액 4,875,291";
  const { fields } = await enrichParsed(stub(tables()), OWNER, sms, null);
  eq("결제수단 = 국민 체크카드", fields.guessed_payment_method_id, PM_KB_CHECK);
  eq("출금계좌 = 연결계좌(설계 107)", fields.guessed_account_id, ACC_KB_LBD);
  eq("잔액 귀속 = 연결계좌", fields.reported_balance_account_id, ACC_KB_LBD);
}

console.log(fail === 0 ? "\n전부 통과 ✅" : `\n실패 ${fail}건 ❌`);
process.exit(fail === 0 ? 0 : 1);
