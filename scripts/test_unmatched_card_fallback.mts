// 설계 117 검증: 문자에 카드 끝4가 있는데 등록 카드와 못 맞추면(미등록 카드),
// merchant_map 이 학습해 둔 계좌·결제수단을 폴백으로 채우지 않는다. 카테고리 학습값은 유지한다.
//
// 실행: npm run test:card-fallback   (DB 불필요 — 가짜 supabase 스텁으로 순수 검증)
//
// 실사례(2026-08-01): 삼성1234 승인이 카드 등록보다 1시간52분 먼저 수집돼 매칭에 실패했고,
// 같은 가게를 7/19 이바다 국민 체크카드로 썼던 학습값이 붙어 국민은행(이바다) 출금으로 잡혔다.
const { enrichParsed } = await import("../src/lib/household/sms-ingest");

let fail = 0;
const eq = (name: string, a: unknown, b: unknown) => {
  if (Object.is(a, b)) console.log(`  ✅ ${name}`);
  else {
    fail++;
    console.log(`  ❌ ${name} — 기대 ${JSON.stringify(b)}, 실제 ${JSON.stringify(a)}`);
  }
};

const OWNER = "owner-1";
const ACC_KB = "acc-kb"; // 국민은행(이바다)
const CAT_FOOD = "cat-food";
const PM_KB_CHECK = "pm-kb-check"; // 국민카드(이바다) nori 체크카드 — 끝4 2065
const PM_SS_1234 = "pm-ss-1234"; // 삼성카드(김하늘)-1234 (등록 전/후를 갈아끼운다)

type Row = Record<string, unknown>;

/** enrichParsed 가 쓰는 만큼만 구현한 체이너블 supabase 스텁. eq/not/ilike 는 행에 그 컬럼이 있을 때만 거른다. */
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

/** 국민은행(이바다)을 학습해 둔 '쇼어(Shore)' 규칙 — 7/19 체크카드출금으로 배운 값. */
const baseTables = (methods: Row[]): Record<string, Row[]> => ({
  hh_merchant_map: [
    { owner_auth_uid: OWNER, merchant_key: "쇼어(Shore)", category_id: CAT_FOOD, payment_method_id: null, account_id: ACC_KB },
  ],
  hh_account: [{ owner_auth_uid: OWNER, id: ACC_KB, name: "국민은행(이바다)", account_no: "110-11-0111-111", person_id: "p-lbd", is_active: true }],
  hh_payment_method: methods,
  hh_person: [{ owner_auth_uid: OWNER, id: "p-lbd", name: "이바다" }],
  hh_category: [],
  hh_loan: [],
  hh_scheduled_payment: [],
});

const SMS_1234 = "삼성카드 삼성1234승인 김*늘 61,800원 일시불 08/01 12:53 쇼어(Shore) 누적2,325,895원";

const METHOD_KB_CHECK: Row = {
  owner_auth_uid: OWNER,
  id: PM_KB_CHECK,
  name: "국민카드(이바다) nori 체크카드",
  kind: "check",
  card_no: "1234-5678-9012-2065",
  linked_account_id: ACC_KB,
};
const METHOD_SS_1234: Row = {
  owner_auth_uid: OWNER,
  id: PM_SS_1234,
  name: "삼성카드(김하늘)-1234",
  kind: "credit",
  card_no: "9999-0000-0000-1234",
  linked_account_id: null,
};

console.log("\n[1] 미등록 카드(1234 등록 전) — 학습된 국민은행 계좌가 붙으면 안 된다");
{
  const { fields, parsed } = await enrichParsed(stub(baseTables([METHOD_KB_CHECK])), OWNER, SMS_1234, null);
  eq("끝4는 1234로 파싱", parsed.cardLast4, "1234");
  eq("결제수단 = 빈칸(추측 금지)", fields.guessed_payment_method_id, null);
  eq("★출금계좌 = 빈칸 (국민은행 폴백 차단)", fields.guessed_account_id, null);
  eq("카테고리 학습값은 유지", fields.guessed_category_id, CAT_FOOD);
  eq("금액", fields.guessed_amount, 61800);
  eq("상호", fields.guessed_merchant, "쇼어(Shore)");
}

console.log("\n[2] 카드 등록 후 — 삼성카드(김하늘)-1234 로 맞고, 신용카드라 계좌는 비어 있다(설계 70)");
{
  const { fields } = await enrichParsed(stub(baseTables([METHOD_KB_CHECK, METHOD_SS_1234])), OWNER, SMS_1234, null);
  eq("결제수단 = 1234 카드", fields.guessed_payment_method_id, PM_SS_1234);
  eq("출금계좌 = 빈칸(신용카드)", fields.guessed_account_id, null);
  eq("카테고리 학습값 유지", fields.guessed_category_id, CAT_FOOD);
}

console.log("\n[3] 회귀 — 끝4가 맞는 체크카드는 종전대로 연결계좌가 채워진다(설계 77·107)");
{
  const sms = "국민카드 국민2065승인 이*다 12,000원 일시불 08/01 12:53 쇼어(Shore)";
  const { fields } = await enrichParsed(stub(baseTables([METHOD_KB_CHECK])), OWNER, sms, null);
  eq("결제수단 = 국민 체크카드", fields.guessed_payment_method_id, PM_KB_CHECK);
  eq("출금계좌 = 연결계좌(국민은행)", fields.guessed_account_id, ACC_KB);
}

console.log("\n[4] 회귀 — 끝4가 아예 없는 문자(카드 아님)는 학습 폴백을 그대로 쓴다");
{
  const sms = "출금 54,000원 이*다님 08/01 12:53 쇼어(Shore) 자동이체 54,000";
  const { parsed, fields } = await enrichParsed(stub(baseTables([METHOD_KB_CHECK])), OWNER, sms, null);
  eq("끝4 없음", parsed.cardLast4, null);
  eq("★학습된 국민은행 계좌 폴백 유지", fields.guessed_account_id, ACC_KB);
}

console.log(fail === 0 ? "\n전부 통과 ✅" : `\n실패 ${fail}건 ❌`);
process.exit(fail === 0 ? 0 : 1);
