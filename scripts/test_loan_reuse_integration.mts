// 설계 194 통합 검증: enrichParsed 가 (a) 키워드 없는 이자 출금 알림을 지난 확정 이력으로 payment 로 올리고 그 대출을 붙이는지
// (b) 출금계좌가 학습(merchant_map) 계좌가 아니라 대출 등록 계좌인지 (c) 이력이 없으면 종전대로 expense 인지
// (d) ③의 근거 대출과 ①의 금액 우연일치 대출이 갈리면 빈칸인지. DB 불필요 — 엄격한 가짜 supabase(test_insurance_cms.mts 와 동일 구현).
// 날짜는 절대일 금지(오늘 기준 상대). 픽스처는 가명.
const { enrichParsed } = await import("../src/lib/household/sms-ingest");

let fail = 0;
const eq = (name: string, a: unknown, b: unknown) => {
  if (Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b)) console.log(`  ✅ ${name}`);
  else { fail++; console.log(`  ❌ ${name} — 기대 ${JSON.stringify(b)}, 실제 ${JSON.stringify(a)}`); }
};
type Row = Record<string, unknown>;
function strictStub(tables: Record<string, Row[]>) {
  const build = (table: string, rows: Row[]) => {
    let cur = rows;
    const orders: { col: string; asc: boolean }[] = [];
    let lim: number | null = null;
    const finish = () => {
      let out = [...cur];
      if (orders.length) out.sort((x, y) => { for (const o of orders) { const a = x[o.col] as never, b = y[o.col] as never; if (a === b) continue; if (a == null) return o.asc ? 1 : -1; if (b == null) return o.asc ? -1 : 1; return (a < b ? -1 : 1) * (o.asc ? 1 : -1); } return 0; });
      if (lim != null) out = out.slice(0, lim);
      return out;
    };
    const cmp = (col: string, f: (v: unknown) => boolean) => { cur = cur.filter((r) => f(r[col] ?? null)); return proxy; };
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
      not: (col: string, op: string, val: unknown) => { if (op !== "is") throw new Error(`stub: not(${op}) 미구현`); return cmp(col, (v) => v !== val); },
      ilike: (col: string, pat: string) => { const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); const re = new RegExp("^" + String(pat).split(/(%|_)/).map((t) => (t === "%" ? "[\\s\\S]*" : t === "_" ? "[\\s\\S]" : esc(t))).join("") + "$", "i"); return cmp(col, (v) => re.test(String(v ?? ""))); },
      order: (col: string, opts?: { ascending?: boolean }) => { orders.push({ col, asc: opts?.ascending !== false }); return proxy; },
      limit: (n: number) => { lim = n; return proxy; },
      maybeSingle: async () => { const out = finish(); return { data: out[0] ?? null, error: null }; },
      single: async () => { const out = finish(); return { data: out[0] ?? null, error: out.length === 1 ? null : { message: "single: 행 수 ≠ 1" } }; },
      then: (resolve: (v: { data: Row[] | null; error: { message: string } | null }) => unknown) => resolve({ data: finish(), error: null }),
    };
    const proxy: Record<string, unknown> = new Proxy(api, { get(t, p) { if (p in t) return t[p as string]; if (p === "catch" || p === "finally" || typeof p === "symbol") return undefined; throw new Error(`stub: ${table}.${String(p)}() 미구현 — 스텁에 의미를 추가하라`); } });
    return proxy;
  };
  return { from: (t: string) => { if (!(t in tables)) throw new Error(`stub: 테이블 ${t} 미정의`); return build(t, structuredClone(tables[t])); } } as never;
}

const day = (offset: number) => { const d = new Date(); d.setUTCHours(12, 0, 0, 0); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };
const OWNER = "owner-1";
const ACC_TOSS = "acc-toss-a";   // 대출 등록 출금계좌(가명: 을은행(갑))
const ACC_LEARNED = "acc-learned"; // 짧은 키 '이자' 학습 규칙이 가리키는 엉뚱한 계좌
const LOAN = "loan-a", LOAN2 = "loan-b";
const CAT_LOAN = "cat-loanpay", CAT_INT = "cat-interest";
const MERCHANT = "갑보험이자";
const tables = (o: { prior?: Row[]; loans?: Row[]; map?: Row[] }): Record<string, Row[]> => ({
  hh_merchant_map: o.map ?? [],
  hh_account: [
    { owner_auth_uid: OWNER, id: ACC_TOSS, name: "을은행(갑)", account_no: null, person_id: "p-a", is_active: true },
    { owner_auth_uid: OWNER, id: ACC_LEARNED, name: "병은행(정)", account_no: null, person_id: "p-b", is_active: true },
  ],
  hh_payment_method: [],
  hh_person: [{ owner_auth_uid: OWNER, id: "p-a", name: "갑" }, { owner_auth_uid: OWNER, id: "p-b", name: "정" }],
  hh_category: [
    { owner_auth_uid: OWNER, id: CAT_LOAN, name: "대출상환", kind: "expense" },
    { owner_auth_uid: OWNER, id: CAT_INT, name: "이자", kind: "income" },
  ],
  hh_loan: o.loans ?? [{ owner_auth_uid: OWNER, id: LOAN, name: "약관대출-을보험-갑", monthly_payment: 3000, status: "active", account_id: ACC_TOSS }],
  hh_scheduled_payment: [],
  hh_transaction_inbox: [],
  hh_transaction: o.prior ?? [],
});
const prior = (amount: number, offset: number, loan_id = LOAN): Row => ({ owner_auth_uid: OWNER, id: `t-${amount}-${offset}`, type: "payment", amount, counterparty: MERCHANT, loan_id, txn_date: day(offset), category_id: CAT_LOAN });
// 실원문 꼴(토스 앱 알림, 설계 70 payment 키워드 없음) — 상호만 가명으로.
const TEXT = `요금납부 2,989원 출금 내 토스뱅크 통장 → ${MERCHANT}`;
// 짧은 키 '이자'(수입 규칙, 계좌 학습) — 실제 운영 규칙과 같은 병(설계 190 §5 계열).
const SHORT_KEY_RULE = { owner_auth_uid: OWNER, merchant_key: "이자", category_id: CAT_INT, payment_method_id: null, account_id: ACC_LEARNED };

console.log("[a] 지난 확정 이력(같은 상호·한 대출·금액 근접) → payment 승격 + 그 대출 + 대출 등록 계좌");
{
  const { fields } = await enrichParsed(strictStub(tables({ prior: [prior(2893, -35), prior(2989, -66)], map: [SHORT_KEY_RULE] })), OWNER, TEXT, "토스");
  eq("★유형 = payment (키워드 없어도 승격)", fields.guessed_type, "payment");
  eq("★대출 = 이력의 대출", fields.guessed_loan_id, LOAN);
  eq("★출금계좌 = 대출 등록 계좌(학습 계좌가 아니다)", fields.guessed_from_account_id, ACC_TOSS);
  eq("카테고리는 비움(확정 RPC 가 loan→대출상환)", fields.guessed_category_id, null);
}
console.log("\n[b] 이력이 없으면 종전대로 expense (승격 없음)");
{
  const { fields } = await enrichParsed(strictStub(tables({ map: [SHORT_KEY_RULE] })), OWNER, TEXT, "토스");
  eq("유형 = expense", fields.guessed_type, "expense");
  eq("대출 없음", fields.guessed_loan_id, null);
}
console.log("\n[c] 이력은 있으나 금액이 ±15% 밖(3배) → 승격 없음");
{
  const { fields } = await enrichParsed(strictStub(tables({ prior: [prior(1000, -30)] })), OWNER, TEXT, "토스");
  eq("유형 = expense", fields.guessed_type, "expense");
}
console.log("\n[d] ③의 근거 대출(loan-a)과 ①의 월납 우연일치 대출(loan-b, 월납 2,989)이 갈리면 → 대출은 빈칸");
{
  const loans = [
    { owner_auth_uid: OWNER, id: LOAN, name: "약관대출-을보험-갑", monthly_payment: 3000, status: "active", account_id: ACC_TOSS },
    { owner_auth_uid: OWNER, id: LOAN2, name: "신용대출-병캐피탈-정", monthly_payment: 2989, status: "active", account_id: ACC_LEARNED },
  ];
  const { fields } = await enrichParsed(strictStub(tables({ prior: [prior(2989, -30)], loans })), OWNER, TEXT, "토스");
  eq("유형 = payment(승격은 됨)", fields.guessed_type, "payment");
  eq("★대출 = 빈칸(근거 충돌은 어느 쪽도 믿지 않는다)", fields.guessed_loan_id, null);
}
console.log("\n[e] 이력이 두 대출을 가리키면 → 승격 없음");
{
  const { fields } = await enrichParsed(strictStub(tables({ prior: [prior(2989, -30, LOAN), prior(2989, -60, LOAN2)], loans: [
    { owner_auth_uid: OWNER, id: LOAN, name: "약관대출-을보험-갑", monthly_payment: 3000, status: "active", account_id: ACC_TOSS },
    { owner_auth_uid: OWNER, id: LOAN2, name: "신용대출-병캐피탈-정", monthly_payment: 50000, status: "active", account_id: ACC_LEARNED },
  ] })), OWNER, TEXT, "토스");
  eq("유형 = expense", fields.guessed_type, "expense");
}

console.log(fail ? `\n❌ ${fail}건 실패` : "\n✅ 전부 통과");
process.exit(fail ? 1 : 0);
