// 설계 163 검증: ⓐ카드사 충돌 가드(문자 카드사 ≠ 학습 카드면 학습값을 쓰지 않는다)
//              ⓑ동일 날짜·시각·금액 이중수집 판정(hasSameTimeSibling)·인덱스 충돌 판별.
//
// 실행: npm run test:issuer-dedup   (DB 불필요 — 가짜 supabase 스텁으로 순수 검증)
// ★실거래 원문·실명·실계좌를 픽스처에 넣지 않는다(설계 163 §6). 전부 합성값이다.
const { enrichParsed, hasSameTimeSibling, insertInboxWithSameTimeRetry, isSameTimeIndexViolation } = await import("../src/lib/household/sms-ingest");
const { cardIssuerKey } = await import("../src/lib/household/sms");

let fail = 0;
const eq = (name: string, a: unknown, b: unknown) => {
  if (Object.is(a, b)) console.log(`  ✅ ${name}`);
  else {
    fail++;
    console.log(`  ❌ ${name} — 기대 ${JSON.stringify(b)}, 실제 ${JSON.stringify(a)}`);
  }
};

type Row = Record<string, unknown>;

/** enrichParsed·hasSameTimeSibling 이 쓰는 만큼만 구현한 체이너블 supabase 스텁. */
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
      neq: (col: string, val: unknown) => {
        // ★실 PostgREST 의 neq 는 SQL <> 라 NULL 행을 통과시키지 않는다 — 스텁도 같게 한다(교차리뷰 R2).
        cur = cur.filter((r) => !(col in r) || (r[col] != null && r[col] !== val));
        return api;
      },
      or: (expr: string) => {
        const conds = expr.split(",").map((c) => c.split("."));
        cur = cur.filter((r) =>
          conds.some(([col, op, val]) => {
            if (!(col in r)) return true;
            if (op === "is" && val === "null") return r[col] == null;
            if (op === "neq") return r[col] != null && r[col] !== val;
            if (op === "eq") return r[col] === val;
            return false;
          })
        );
        return api;
      },
      in: (col: string, vals: unknown[]) => {
        cur = cur.filter((r) => !(col in r) || vals.includes(r[col]));
        return api;
      },
      maybeSingle: async () => ({ data: cur[0] ?? null, error: null }),
      then: (resolve: (v: { data: Row[]; error: null }) => unknown) => resolve({ data: cur, error: null }),
    };
    return api;
  };
  return { from: (t: string) => build(structuredClone(tables[t] ?? [])) } as never;
}

const OWNER = "owner-1";
const ACC_KB = "acc-kb"; // 국민은행(가족1) — 합성
const CAT_FOOD = "cat-food";
const PM_KB_CHECK = "pm-kb-check"; // 국민카드(가족1) 체크카드 — 합성 끝4 9901
const PM_KB_CREDIT = "pm-kb-credit"; // 국민카드(가족1) 신용카드 — 합성 끝4 9902
const PM_SS_CREDIT = "pm-ss-credit"; // 삼성카드(가족2) — 학습돼 있던 '다른 카드사' 카드

const METHOD_KB_CHECK: Row = {
  owner_auth_uid: OWNER, id: PM_KB_CHECK, name: "국민카드(가족1) 체크카드", kind: "check",
  card_no: "9999-0000-1111-9901", linked_account_id: ACC_KB, is_active: true,
};
const METHOD_KB_CREDIT: Row = {
  owner_auth_uid: OWNER, id: PM_KB_CREDIT, name: "국민카드(가족1) 신용카드", kind: "credit",
  card_no: "9999-0000-1111-9902", linked_account_id: null, is_active: true,
};
const METHOD_SS_CREDIT: Row = {
  owner_auth_uid: OWNER, id: PM_SS_CREDIT, name: "삼성카드(가족2) 신용카드", kind: "credit",
  card_no: "9999-0000-1111-9903", linked_account_id: null, is_active: true,
};

/** 학습 사전: 합성 가맹점 '헤이즐넛상회' 를 예전에 삼성카드(신용)로 결제한 학습값. */
const tables = (methods: Row[], learned: Row | null = null): Record<string, Row[]> => ({
  hh_merchant_map: learned ? [learned] : [],
  hh_account: [{ owner_auth_uid: OWNER, id: ACC_KB, name: "국민은행(가족1)", account_no: "999-88-7777-001", person_id: "p-1", is_active: true }],
  hh_payment_method: methods,
  hh_person: [{ owner_auth_uid: OWNER, id: "p-1", name: "가족일" }],
  hh_category: [],
  hh_loan: [],
  hh_scheduled_payment: [],
});
const LEARNED_SS: Row = { owner_auth_uid: OWNER, merchant_key: "헤이즐넛상회", category_id: CAT_FOOD, payment_method_id: PM_SS_CREDIT, account_id: null };
const LEARNED_SS_WITH_ACC: Row = { ...LEARNED_SS, account_id: ACC_KB };

// 끝4 없는 카드 승인 문자(합성) — 카드사(기관명)만 있다.
const SMS_ISSUER_ONLY = "KB국민카드 승인 홍*동 7,700원 일시불 08/11 17:10 헤이즐넛상회 사용";
// 기관명이 아예 없는 출금 문자(합성) — 기존 학습 폴백이 유지되어야 한다.
const SMS_NO_ISSUER = "승인 홍*동 7,700원 일시불 08/11 17:10 헤이즐넛상회";

console.log("\n[A-1] 문자 카드사(국민) ≠ 학습 카드(삼성) → 학습 카드를 선택하지 않는다");
{
  const { parsed, fields } = await enrichParsed(stub(tables([METHOD_KB_CHECK, METHOD_KB_CREDIT, METHOD_SS_CREDIT], LEARNED_SS)), OWNER, SMS_ISSUER_ONLY, null);
  eq("끝4 없음(합성 문자 전제)", parsed.cardLast4, null);
  eq("기관명 = KB국민카드", parsed.institution, "KB국민카드");
  eq("★결제수단 = 빈칸(학습 삼성카드 차단, 국민 후보 2장이라 유일 아님)", fields.guessed_payment_method_id, null);
  eq("카테고리 학습값은 유지", fields.guessed_category_id, CAT_FOOD);
}

console.log("\n[A-2] 문자 카드사와 같은 활성 카드가 유일(신용) → 그 카드, 계좌는 빈칸(설계 70)");
{
  const { fields } = await enrichParsed(stub(tables([METHOD_KB_CREDIT, METHOD_SS_CREDIT], LEARNED_SS)), OWNER, SMS_ISSUER_ONLY, null);
  eq("결제수단 = 국민 신용카드", fields.guessed_payment_method_id, PM_KB_CREDIT);
  eq("출금계좌 = 빈칸(신용카드)", fields.guessed_account_id, null);
}

console.log("\n[A-3] 카드사 후보가 여러 개 → 빈칸(모호하면 빈칸), 학습 파생 계좌도 차단");
{
  const { fields } = await enrichParsed(stub(tables([METHOD_KB_CHECK, METHOD_KB_CREDIT], LEARNED_SS_WITH_ACC)), OWNER, SMS_ISSUER_ONLY, null);
  eq("결제수단 = 빈칸", fields.guessed_payment_method_id, null);
  eq("★학습에 딸려 온 계좌도 빈칸", fields.guessed_account_id, null);
  eq("카테고리 학습값은 유지", fields.guessed_category_id, CAT_FOOD);
}

console.log("\n[A-4] 카드사 단서 없음 + 학습 카드 → 기존 폴백 유지(회귀)");
{
  const { parsed, fields } = await enrichParsed(stub(tables([METHOD_KB_CHECK, METHOD_SS_CREDIT], LEARNED_SS)), OWNER, SMS_NO_ISSUER, null);
  eq("기관명 없음(합성 문자 전제)", parsed.institution, null);
  eq("학습 카드 폴백 유지", fields.guessed_payment_method_id, PM_SS_CREDIT);
}

console.log("\n[A-5] 유일 일치가 체크카드 → 연결계좌가 출금계좌로 지정(설계 107)");
{
  const { fields } = await enrichParsed(stub(tables([METHOD_KB_CHECK, METHOD_SS_CREDIT], LEARNED_SS)), OWNER, SMS_ISSUER_ONLY, null);
  eq("결제수단 = 국민 체크카드", fields.guessed_payment_method_id, PM_KB_CHECK);
  eq("출금계좌 = 연결계좌", fields.guessed_account_id, ACC_KB);
}

console.log("\n[A-6] 비활성 카드는 후보에서 제외 — 활성이 유일해지면 선택");
{
  const inactive = { ...METHOD_KB_CREDIT, is_active: false };
  const { fields } = await enrichParsed(stub(tables([METHOD_KB_CHECK, inactive, METHOD_SS_CREDIT], LEARNED_SS)), OWNER, SMS_ISSUER_ONLY, null);
  eq("결제수단 = 활성 국민 체크카드", fields.guessed_payment_method_id, PM_KB_CHECK);
}

console.log("\n[A-7] 끝4가 있으면 종전 규칙 그대로(카드사 유일 매칭보다 우선)");
{
  const sms = "KB국민카드 국민9902승인 홍*동 7,700원 일시불 08/11 17:10 헤이즐넛상회";
  const { parsed, fields } = await enrichParsed(stub(tables([METHOD_KB_CHECK, METHOD_KB_CREDIT], LEARNED_SS)), OWNER, sms, null);
  eq("끝4 = 9902", parsed.cardLast4, "9902");
  eq("결제수단 = 끝4가 지목한 신용카드", fields.guessed_payment_method_id, PM_KB_CREDIT);
}

console.log("\n[A-8] ★끝4가 있는데 등록 카드와 불일치(미등록 카드) → ③이 발동하면 안 된다(설계 117 가드 보존)");
{
  const sms = "KB국민카드 국민9999승인 홍*동 7,700원 일시불 08/11 17:10 헤이즐넛상회";
  const { parsed, fields } = await enrichParsed(stub(tables([METHOD_KB_CHECK], LEARNED_SS_WITH_ACC)), OWNER, sms, null);
  eq("끝4 = 9999(등록 없음)", parsed.cardLast4, "9999");
  eq("★결제수단 = 빈칸(카드사 유일이어도 다른 카드를 추측하지 않음)", fields.guessed_payment_method_id, null);
  eq("★학습 계좌도 빈칸(117 가드 유지)", fields.guessed_account_id, null);
  eq("카테고리 학습값은 유지", fields.guessed_category_id, CAT_FOOD);
}

console.log("\n[A-9] 카드사 문자라도 kind 가 승인·취소가 아니면(출금 등) ③ 미발동 — 납부 출금계좌를 오염시키지 않는다");
{
  // 카드사발 출금 통지는 카드대금 납부(payment)로 재분류된다(설계 94·105) — 결제수단은 원래 비워진다.
  // 여기서 검증하는 것은 kind 게이트다: ③이 발동해 롯데 카드(유일)를 고르면 설계 107 이 연결계좌를
  // 얹어 guessed_from_account_id 가 그 카드의 계좌로 오염된다. 게이트가 있으면 빈칸이다.
  const lotteCheck: Row = {
    owner_auth_uid: OWNER, id: "pm-lotte-check", name: "롯데카드(가족1) 체크카드", kind: "check",
    card_no: "9999-0000-1111-9904", linked_account_id: "acc-lotte", is_active: true,
  };
  const sms = "롯데카드 출금 5,000원 홍*동 08/11 17:10 헤이즐넛상회";
  const { parsed, fields } = await enrichParsed(stub(tables([lotteCheck, METHOD_SS_CREDIT], LEARNED_SS)), OWNER, sms, null);
  eq("kind = withdraw", parsed.kind, "withdraw");
  eq("기관명 = 롯데카드", parsed.institution, "롯데카드");
  eq("납부(payment)로 재분류", fields.guessed_type, "payment");
  eq("★③ 미발동 — 납부 출금계좌가 카드 연결계좌로 오염되지 않음", fields.guessed_from_account_id, null);
}

console.log("\n[U] cardIssuerKey 정규화 — 카드사만 받고, 표기 변형은 한 키로");
{
  eq("KB국민카드 → 국민", cardIssuerKey("KB국민카드"), "국민");
  eq("국민카드(가족1) 체크카드 → 국민", cardIssuerKey("국민카드(가족1) 체크카드"), "국민");
  eq("KB카드 → 국민", cardIssuerKey("KB카드"), "국민");
  eq("삼성카드(가족2) → 삼성", cardIssuerKey("삼성카드(가족2) 신용카드"), "삼성");
  eq("NH농협카드 → 농협", cardIssuerKey("NH농협카드"), "농협");
  eq("★국민은행 은 카드사가 아니다", cardIssuerKey("국민은행"), null);
  eq("★국민은행(가족1) 결제수단명도 아니다", cardIssuerKey("국민은행(가족1)"), null);
  eq("★부천페이 는 카드사가 아니다", cardIssuerKey("부천페이"), null);
  eq("★'체크카드' 단독은 카드사가 아니다", cardIssuerKey("체크카드"), null);
  eq("★BC카드는 우산 브랜드 — 카드사 단서 아님(학습 차단 회귀 방지)", cardIssuerKey("BC카드"), null);
  eq("★비씨카드도 동일", cardIssuerKey("비씨카드"), null);
  eq("빈 값", cardIssuerKey(null), null);
}

console.log("\n[B-1] hasSameTimeSibling — 같은 소유자·날짜·시각·금액의 pending/confirmed/archived 만 잡는다");
{
  const inboxRow = (status: string, kind = "withdraw"): Row => ({
    owner_auth_uid: OWNER, id: `row-${status}-${kind}`, status, guessed_kind: kind,
    guessed_date: "2026-08-11", guessed_time: "17:10", guessed_amount: 7800,
  });
  const mk = (rows: Row[]) => stub({ hh_transaction_inbox: rows });
  const K = "approve"; // 들어오는 문자의 kind(승인) — cancel 만 아니면 판정에 영향 없음
  eq("pending 형제 → true", await hasSameTimeSibling(mk([inboxRow("pending")]), OWNER, K, "2026-08-11", "17:10", 7800), true);
  eq("confirmed 형제 → true", await hasSameTimeSibling(mk([inboxRow("confirmed")]), OWNER, K, "2026-08-11", "17:10", 7800), true);
  eq("archived 형제 → true", await hasSameTimeSibling(mk([inboxRow("archived")]), OWNER, K, "2026-08-11", "17:10", 7800), true);
  eq("휴지통(ignored) 행은 무시 → false", await hasSameTimeSibling(mk([inboxRow("ignored")]), OWNER, K, "2026-08-11", "17:10", 7800), false);
  eq("중복(duplicate) 행은 무시 → false", await hasSameTimeSibling(mk([inboxRow("duplicate")]), OWNER, K, "2026-08-11", "17:10", 7800), false);
  eq("시각 다름 → false", await hasSameTimeSibling(mk([inboxRow("pending")]), OWNER, K, "2026-08-11", "17:11", 7800), false);
  eq("금액 다름 → false", await hasSameTimeSibling(mk([inboxRow("pending")]), OWNER, K, "2026-08-11", "17:10", 7900), false);
  eq("날짜 다름 → false", await hasSameTimeSibling(mk([inboxRow("pending")]), OWNER, K, "2026-08-12", "17:10", 7800), false);
  eq("시각 없음 → 판정 안 함(false)", await hasSameTimeSibling(mk([inboxRow("pending")]), OWNER, K, "2026-08-11", null, 7800), false);
  eq("금액 없음 → 판정 안 함(false)", await hasSameTimeSibling(mk([inboxRow("pending")]), OWNER, K, "2026-08-11", "17:10", null), false);
  eq("날짜 없음 → 판정 안 함(false)", await hasSameTimeSibling(mk([inboxRow("pending")]), OWNER, K, null, "17:10", 7800), false);
  // ★승인취소는 양방향 제외(교차리뷰) — 취소 문자는 원 승인과 같은 거래일·시각·금액이라,
  //   걸러 버리면 설계 151 의 원거래 삭제 흐름이 휴지통으로 빨려 들어간다.
  eq("★들어온 문자가 취소(cancel) → 형제가 있어도 판정 안 함(false)",
    await hasSameTimeSibling(mk([inboxRow("confirmed")]), OWNER, "cancel", "2026-08-11", "17:10", 7800), false);
  eq("★형제가 취소(cancel) 행 → 새 승인을 거르지 않음(false)",
    await hasSameTimeSibling(mk([inboxRow("pending", "cancel")]), OWNER, K, "2026-08-11", "17:10", 7800), false);
  // ★kind 가 NULL 인 옛 행도 형제다 — neq 는 NULL 을 빼 버려 인덱스 술어와 어긋났었다(교차리뷰 R2).
  {
    const nullKindRow: Row = { ...inboxRow("confirmed"), guessed_kind: null };
    eq("★kind=NULL 형제도 잡는다(인덱스 술어와 기준 일치)",
      await hasSameTimeSibling(mk([nullKindRow]), OWNER, K, "2026-08-11", "17:10", 7800), true);
  }
  // 조회 에러 → false(수집을 죽이지 않음). 주석의 보장 범위 그 자체를 검증한다.
  {
    const errApi: Record<string, unknown> = {};
    for (const m of ["select", "eq", "neq", "or", "in", "limit"]) errApi[m] = () => errApi;
    (errApi as Record<string, unknown>).then = (resolve: (v: unknown) => unknown) =>
      resolve({ data: null, error: { message: "synthetic query failure" } });
    const errStub = { from: () => errApi } as never;
    eq("★조회 실패 → false(로그만, throw 없음)",
      await hasSameTimeSibling(errStub, OWNER, K, "2026-08-11", "17:10", 7800), false);
  }
}

console.log("\n[B-2] isSameTimeIndexViolation — 동일시각 인덱스 충돌만 가려낸다");
{
  eq("동일시각 인덱스 23505 → true",
    isSameTimeIndexViolation({ code: "23505", message: 'duplicate key value violates unique constraint "hh_inbox_same_time_pending_uq"' }), true);
  eq("기존 dedup 제약 23505 → false",
    isSameTimeIndexViolation({ code: "23505", message: 'duplicate key value violates unique constraint "hh_inbox_dedup_unique"' }), false);
  eq("다른 에러코드 → false", isSameTimeIndexViolation({ code: "23503", message: "hh_inbox_same_time_pending_uq" }), false);
  eq("null → false", isSameTimeIndexViolation(null), false);
}

console.log("\n[B-3] insertInboxWithSameTimeRetry — 인덱스 충돌(경쟁)이면 휴지통 재삽입, dedup 충돌이면 그대로 반환");
{
  const SAME_TIME_ERR = { code: "23505", message: 'duplicate key value violates unique constraint "hh_inbox_same_time_pending_uq"' };
  const DEDUP_ERR = { code: "23505", message: 'duplicate key value violates unique constraint "hh_inbox_dedup_unique"' };
  /** insert 호출마다 responses 를 순서대로 돌려주는 스텁. 호출된 행도 기록한다. */
  const insertStub = (responses: Array<{ data?: Row | null; error?: Row | null }>) => {
    let i = 0;
    const calls: Row[] = [];
    const sb = {
      from: () => ({
        insert: (row: Row) => {
          calls.push(row);
          const r = responses[Math.min(i++, responses.length - 1)];
          return { select: () => ({ single: async () => ({ data: r.data ?? null, error: r.error ?? null }) }) };
        },
      }),
    } as never;
    return { sb, calls };
  };
  const ROW: Row = { owner_auth_uid: OWNER, status: "pending", guessed_amount: 7800, dedup_hash: "synthetic-key" };

  {
    const { sb, calls } = insertStub([{ data: { id: "new-1" } }]);
    const r = await insertInboxWithSameTimeRetry(sb, ROW);
    eq("정상 삽입 → id 반환", r.id, "new-1");
    eq("정상 삽입 → 경쟁 아님", r.trashedByRace, false);
    eq("정상 삽입 → insert 1회", calls.length, 1);
  }
  {
    const { sb, calls } = insertStub([{ error: SAME_TIME_ERR }, { data: { id: "trash-1" } }]);
    const r = await insertInboxWithSameTimeRetry(sb, ROW);
    eq("★경쟁 충돌 → 재삽입 id 반환", r.id, "trash-1");
    eq("★경쟁 충돌 → trashedByRace=true", r.trashedByRace, true);
    eq("★재삽입 행은 status=ignored", calls[1]?.status, "ignored");
    eq("★재삽입 행은 dedup_hash 유지(동일 원문 재전송 억제)", calls[1]?.dedup_hash, "synthetic-key");
  }
  {
    const { sb, calls } = insertStub([{ error: DEDUP_ERR }]);
    const r = await insertInboxWithSameTimeRetry(sb, ROW);
    eq("dedup 충돌 → 재시도 없이 에러 반환(호출자가 duplicate 처리)", r.error?.code, "23505");
    eq("dedup 충돌 → insert 1회", calls.length, 1);
  }
  {
    const { sb, calls } = insertStub([{ error: SAME_TIME_ERR }, { error: DEDUP_ERR }]);
    const r = await insertInboxWithSameTimeRetry(sb, ROW);
    eq("경쟁 충돌 후 재삽입도 dedup 충돌 → 에러 반환(동일 원문 이미 보존됨)", r.error?.code, "23505");
    eq("재시도까지 insert 2회", calls.length, 2);
  }
}

console.log(fail === 0 ? "\n전부 통과 ✅" : `\n실패 ${fail}건 ❌`);
process.exit(fail === 0 ? 0 : 1);
