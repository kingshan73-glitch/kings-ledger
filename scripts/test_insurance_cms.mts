// 설계 186 검증: 보험료 CMS 출금은 '납부(payment)'가 아니라 '지출(보험)'로 흘린다.
// 'CMS출' 판정(설계 70)이 보험사 CMS 도 payment 로 몰아가던 것을, 등록된 보험 정기지출
// (kind='insurance')과 금액 정확일치 + 납부일 ±5일이면 되돌린다. 활성 대출 월납과 같은
// 금액이면 되돌리지 않는다(대출 원장 오염 방지).
//
// 실행: npm run test:insurance-cms   (DB 불필요 — 엄격한 가짜 supabase 로 enrichParsed 통합 경로를 태운다)
// 스텁은 test_wallet_chain.mts 의 것과 동일(모르는 연산이면 던진다).
const { enrichParsed } = await import("../src/lib/household/sms-ingest");

let fail = 0;
const eq = (name: string, a: unknown, b: unknown) => {
  if (Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b)) console.log(`  ✅ ${name}`);
  else {
    fail++;
    console.log(`  ❌ ${name} — 기대 ${JSON.stringify(b)}, 실제 ${JSON.stringify(a)}`);
  }
};

type Row = Record<string, unknown>;

/** 엄격한 supabase 스텁 — test_wallet_chain.mts 와 동일 구현(모르는 연산은 던진다).
 *  failWhen: 해당 테이블 조회를 에러로 만든다 — fail-closed 가드 검증용. */
function strictStub(tables: Record<string, Row[]>, failWhen?: (table: string) => boolean) {
  const build = (table: string, rows: Row[]) => {
    let cur = rows;
    const orders: { col: string; asc: boolean }[] = [];
    let lim: number | null = null;
    const finish = () => {
      let out = [...cur];
      if (orders.length) {
        out.sort((x, y) => {
          for (const o of orders) {
            const a = x[o.col] as string | number | null | undefined;
            const b = y[o.col] as string | number | null | undefined;
            if (a === b) continue;
            if (a == null) return o.asc ? 1 : -1;
            if (b == null) return o.asc ? -1 : 1;
            return (a < b ? -1 : 1) * (o.asc ? 1 : -1);
          }
          return 0;
        });
      }
      if (lim != null) out = out.slice(0, lim);
      return out;
    };
    const cmp = (col: string, f: (v: unknown) => boolean) => {
      cur = cur.filter((r) => f(r[col] ?? null));
      return proxy;
    };
    const api: Record<string, unknown> = {
      select: () => proxy,
      eq: (col: string, val: unknown) => cmp(col, (v) => v === val),
      neq: (col: string, val: unknown) => cmp(col, (v) => v !== val),
      is: (col: string, val: unknown) => cmp(col, (v) => v === val),
      in: (col: string, vals: unknown[]) => cmp(col, (v) => vals.includes(v)),
      gte: (col: string, val: string | number) => cmp(col, (v) => v != null && (v as string | number) >= val),
      lte: (col: string, val: string | number) => cmp(col, (v) => v != null && (v as string | number) <= val),
      gt: (col: string, val: string | number) => cmp(col, (v) => v != null && (v as string | number) > val),
      lt: (col: string, val: string | number) => cmp(col, (v) => v != null && (v as string | number) < val),
      not: (col: string, op: string, val: unknown) => {
        if (op !== "is") throw new Error(`stub: not(${op}) 미구현`);
        return cmp(col, (v) => v !== val);
      },
      ilike: (col: string, pat: string) => {
        const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const body = String(pat)
          .split(/(%|_)/)
          .map((t) => (t === "%" ? "[\\s\\S]*" : t === "_" ? "[\\s\\S]" : esc(t)))
          .join("");
        const re = new RegExp("^" + body + "$", "i");
        return cmp(col, (v) => re.test(String(v ?? "")));
      },
      order: (col: string, opts?: { ascending?: boolean }) => {
        orders.push({ col, asc: opts?.ascending !== false });
        return proxy;
      },
      limit: (n: number) => {
        lim = n;
        return proxy;
      },
      maybeSingle: async () => {
        if (failWhen?.(table)) return { data: null, error: { message: "stub: 주입된 조회 실패" } };
        const out = finish();
        return { data: out[0] ?? null, error: null };
      },
      single: async () => {
        const out = finish();
        return { data: out[0] ?? null, error: out.length === 1 ? null : { message: "single: 행 수 ≠ 1" } };
      },
      then: (resolve: (v: { data: Row[] | null; error: { message: string } | null }) => unknown) => {
        if (failWhen?.(table)) return resolve({ data: null, error: { message: "stub: 주입된 조회 실패" } });
        const out = finish();
        return resolve({ data: out, error: null });
      },
    };
    const proxy: Record<string, unknown> = new Proxy(api, {
      get(t, p) {
        if (p in t) return t[p as string];
        if (p === "catch" || p === "finally" || typeof p === "symbol") return undefined;
        throw new Error(`stub: ${table}.${String(p)}() 미구현 — 스텁에 의미를 추가하라`);
      },
    });
    return proxy;
  };
  return {
    from: (t: string) => {
      if (!(t in tables)) throw new Error(`stub: 테이블 ${t} 미정의`);
      return build(t, structuredClone(tables[t]));
    },
  } as never;
}

// ── 고정 데이터 (실사례 2026-08-21 국민은행(이바다) CMS 출금 기반, 도메인 데이터 — AGENTS.md PII 절) ──
const OWNER = "owner-1";
const ACC_KB_LBD = "acc-kb-lbd"; // 국민은행(이바다)
const CAT_INS = "cat-insurance"; // 보험
const CAT_LOAN = "cat-loanpay"; // 대출상환
const baseTables = (o: { scheds?: Row[]; loans?: Row[] }): Record<string, Row[]> => ({
  hh_merchant_map: [],
  hh_account: [
    // account_no 는 문자 원문의 마스킹 표기 그대로 둔다 — 전체 계좌번호를 합성으로라도 만들지 않는다.
    { owner_auth_uid: OWNER, id: ACC_KB_LBD, name: "국민은행(이바다)", account_no: "110-11-0***-111", person_id: "p-lbd", is_active: true },
  ],
  hh_payment_method: [],
  hh_person: [
    { owner_auth_uid: OWNER, id: "p-lbd", name: "이바다" },
    { owner_auth_uid: OWNER, id: "p-khn", name: "김하늘" },
  ],
  hh_category: [
    { owner_auth_uid: OWNER, id: CAT_INS, name: "보험", kind: "expense" },
    { owner_auth_uid: OWNER, id: CAT_LOAN, name: "대출상환", kind: "expense" },
  ],
  hh_loan: o.loans ?? [],
  hh_scheduled_payment: o.scheds ?? [],
  hh_transaction_inbox: [],
  hh_transaction: [],
});
/** 등록된 보험 정기지출(실측: 보험-DB손해보험 82,000 · 20일 · 국민은행(이바다) · 카테고리 보험). */
const insSched = (over: Row = {}): Row => ({
  owner_auth_uid: OWNER,
  id: "sched-ins-db",
  title: "보험-DB손해보험",
  kind: "insurance",
  amount: 82000,
  pay_day: 20,
  direction: "out",
  is_active: true,
  category_id: CAT_INS,
  account_id: ACC_KB_LBD,
  payee: "국민은행",
  ...over,
});
/** 실원문(2026-08-21): 은행 CMS 출금 — 'CMS출' 이 payment 판정을 만든다. */
const INS_SMS = "출금 82,000원이*다님 08/21 19:30 110-11-0***-111 DB손09408 공동CMS출 82,000 잔액1,829,525";
/** 실원문(2026-08-10): 대출 CMS — payment 로 남아야 한다(월납 정확일치로 대출 연결). */
const LOAN_SMS = "출금 247,450원이*다님 08/10 19:25 110-11-0***-111 신한저축은행 공동CMS출 247,450 잔액4,238,620";
const LOAN = { owner_auth_uid: OWNER, id: "loan-shinhan", name: "대출상환-신한저축은행", monthly_payment: 247450, status: "active", account_id: ACC_KB_LBD };

console.log("[1] 보험 정기지출과 금액·납부일 일치 → expense + 보험 + 등록 계좌 (★설계 186 본체)");
{
  const { fields } = await enrichParsed(strictStub(baseTables({ scheds: [insSched()] })), OWNER, INS_SMS, null);
  eq("★유형 = expense (payment 아님)", fields.guessed_type, "expense");
  eq("★카테고리 = 보험 (설계 105 블록이 채움)", fields.guessed_category_id, CAT_INS);
  eq("★출금계좌 = 국민은행(이바다)", fields.guessed_account_id, ACC_KB_LBD);
  eq("대출 연결 없음", fields.guessed_loan_id, null);
}

console.log("\n[2] 대출 CMS 는 그대로 payment + 대출 연결 (회귀 방지)");
{
  const { fields } = await enrichParsed(strictStub(baseTables({ scheds: [insSched()], loans: [LOAN] })), OWNER, LOAN_SMS, null);
  eq("유형 = payment 유지", fields.guessed_type, "payment");
  eq("대출 자동연결(월납 정확일치)", fields.guessed_loan_id, "loan-shinhan");
}

console.log("\n[3] ★보험 금액 == 활성 대출 월납 (충돌) → 되돌리지 않는다 (payment 유지)");
{
  const clashLoan = { ...LOAN, id: "loan-clash", name: "대출상환-충돌", monthly_payment: 82000 };
  const { fields } = await enrichParsed(strictStub(baseTables({ scheds: [insSched()], loans: [clashLoan] })), OWNER, INS_SMS, null);
  eq("유형 = payment 유지 (대출 오염 방지)", fields.guessed_type, "payment");
  // ★현행 문서화(교차리뷰 2026-08-22): payment 유지 후 설계 105 ① 이 월납 정확일치로 그 대출을
  //   자동 연결한다 — 진짜 충돌이 나면 보험료가 대출에 연결된 채 확정 대기한다(186 이전부터의 105
  //   동작). 실측 충돌 0건 + 확정은 화면에서 사람이 하므로 감수, 대신 여기서 눈에 보이게 못박는다.
  eq("(현행) 충돌 대출이 자동 연결됨", fields.guessed_loan_id, "loan-clash");
}

console.log("\n[4] 납부일이 ±5일 밖(등록 5일 vs 거래 21일) → 되돌리지 않는다");
{
  const { fields } = await enrichParsed(strictStub(baseTables({ scheds: [insSched({ pay_day: 5 })] })), OWNER, INS_SMS, null);
  eq("유형 = payment 유지", fields.guessed_type, "payment");
}

console.log("\n[5] 비활성 보험 정기지출 → 되돌리지 않는다");
{
  const { fields } = await enrichParsed(strictStub(baseTables({ scheds: [insSched({ is_active: false })] })), OWNER, INS_SMS, null);
  eq("유형 = payment 유지", fields.guessed_type, "payment");
}

console.log("\n[6] 보험이 아닌 정기지출(kind=loan)이 같은 금액이어도 → 되돌리지 않는다");
{
  const { fields } = await enrichParsed(strictStub(baseTables({ scheds: [insSched({ kind: "loan", title: "대출상환-DB손보", category_id: CAT_LOAN })] })), OWNER, INS_SMS, null);
  eq("유형 = payment 유지 (kind=insurance 만 되돌림)", fields.guessed_type, "payment");
}

console.log("\n[7] 월말 순환(음성): 등록 31일 vs 거래 21일 → 순환거리 10 > 5 → payment 유지");
{
  const { fields } = await enrichParsed(strictStub(baseTables({ scheds: [insSched({ pay_day: 31 })] })), OWNER, INS_SMS, null);
  eq("유형 = payment 유지", fields.guessed_type, "payment");
}

console.log("\n[8] 월말 순환(양성): 등록 31일 vs 거래 2일 → 순환거리 2 ≤ 5 → expense (31-diff 경로 실검증)");
{
  const sms = "출금 82,000원이*다님 09/02 19:30 110-11-0***-111 DB손09408 공동CMS출 82,000 잔액1,829,525";
  const { fields } = await enrichParsed(strictStub(baseTables({ scheds: [insSched({ pay_day: 31 })] })), OWNER, sms, null);
  eq("★유형 = expense (월 순환으로 창 안)", fields.guessed_type, "expense");
  eq("카테고리 = 보험", fields.guessed_category_id, CAT_INS);
}

console.log("\n[9] ★원문에 카드사명 → 카드대금이다, 보험 금액과 같아도 되돌리지 않는다 (교차리뷰 H1)");
{
  const sms = "출금 82,000원이*다님 08/21 19:30 110-11-0***-111 삼성카드출금 82,000 잔액1,829,525";
  const { fields } = await enrichParsed(strictStub(baseTables({ scheds: [insSched()] })), OWNER, sms, null);
  eq("유형 = payment 유지 (개별 승인과 이중계상 방지)", fields.guessed_type, "payment");
  eq("보험 카테고리 안 붙음", fields.guessed_category_id, null);
}

console.log("\n[10] ★같은 금액·같은 창에 보험 아닌 정기지출이 섞임 → 정체 모호, 되돌리지 않는다 (교차리뷰 M2)");
{
  const loanSched = insSched({ id: "sched-loan-db", title: "대출상환-DB손보", kind: "loan", category_id: CAT_LOAN });
  const { fields } = await enrichParsed(strictStub(baseTables({ scheds: [insSched(), loanSched] })), OWNER, INS_SMS, null);
  eq("유형 = payment 유지", fields.guessed_type, "payment");
}

console.log("\n[11] direction='in' 보험 항목은 근거가 아니다 → payment 유지");
{
  const { fields } = await enrichParsed(strictStub(baseTables({ scheds: [insSched({ direction: "in" })] })), OWNER, INS_SMS, null);
  eq("유형 = payment 유지", fields.guessed_type, "payment");
}

console.log("\n[12] ★대출 충돌 조회가 실패하면 되돌리지 않는다 — fail-closed (교차리뷰 M1)");
{
  const { fields } = await enrichParsed(strictStub(baseTables({ scheds: [insSched()] }), (t) => t === "hh_loan"), OWNER, INS_SMS, null);
  eq("유형 = payment 유지 (에러 ≠ 충돌 없음)", fields.guessed_type, "payment");
}

if (fail) {
  console.log(`\n❌ ${fail}건 실패`);
  process.exit(1);
}
console.log("\n✅ 전부 통과");
