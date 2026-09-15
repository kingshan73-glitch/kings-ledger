// 킹스가계부 데모 데이터 시드 스크립트.
// 관리자(admin) 계정 소유로 가상의 가계부 데이터(인물·계좌·카드·대출·정기지출·할부·거래)를 넣는다.
//
// 사용법:
//   node scripts/seed-demo.mjs              # 시드 (재실행해도 이미 있는 행은 건너뜀 = 멱등)
//   node scripts/seed-demo.mjs --dry-run    # 넣을 계획·건수만 출력, DB 쓰기 없음
//   node scripts/seed-demo.mjs --reset      # 데모 행만 삭제 (자식 → 부모 순서)
//   node scripts/seed-demo.mjs --today=2026-09-15   # 기준일 고정(재현용, 기본은 오늘)
//
// 멱등 원리:
//   - 모든 데모 행은 "소유자 uid + 고정 키"의 sha256 으로 만든 **결정적 UUID** 를 id 로 가진다.
//     같은 계정에 다시 돌리면 같은 id 가 나오므로 "이미 있는 id 는 건너뛴다".
//   - 거래(hh_transaction)는 추가로 note='DEMO' 태그를 달아 조회·삭제한다.
//   - 카테고리는 앱 기본값(설정 > 기본값 생성)과 같은 이름을 쓰므로 데모 태그를 달지 않고, --reset 에서도 지우지 않는다.
//
// ── 의존한 스키마 (테이블 · 컬럼 · 정의한 마이그레이션) ─────────────────────────────
// hh_person            id, owner_auth_uid, name, sort_order, is_active                         20260613000000_household_init.sql
// hh_account           id, owner_auth_uid, name, bank, account_no, person_id, kind(checking|stock|family|other),
//                      opening_balance, sort_order, is_active                                   20260613000000_household_init.sql
// hh_category          owner_auth_uid, name, kind(income|expense), is_fixed, sort_order, is_active
//                      UNIQUE(owner_auth_uid, name, kind)                                      20260613000000_household_init.sql
// hh_payment_method    id, owner_auth_uid, name, kind(cash|check|credit|installment), person_id, linked_account_id,
//                      billing_day(1~28), is_active, sort_order                                20260613000000_household_init.sql
//                      card_no, card_expiry                                                     20260615000000_payment_method_card.sql
// hh_loan              id, owner_auth_uid, name, origin_date, principal(>0), current_balance(>=0), maturity_date,
//                      interest_rate numeric(5,2), monthly_payment, payment_day(1~28), status(active|closed)
//                                                                                              20260613000000_household_init.sql
//                      account_id → hh_account                                                 20260716000000_loan_withdraw_account.sql
//                      repayment_type(annuity|equal_principal|interest_only|null)              20260813000000_loan_repayment_type.sql
//                      source(manual|import) default manual                                    20260813010000_loan_installment_source.sql
//                      숫자 CHECK(principal>0, current_balance>=0, rate/monthly >=0)          20260817020000_loan_numeric_checks.sql
// hh_installment       id, owner_auth_uid, start_date, payment_method_id, category_id, title, total_amount,
//                      total_count(>0), start_installment(1..total_count), is_active           20260613000000_household_init.sql
//                                                                                              20260817010000_installment_count_check.sql
//                      source(manual|import) default manual                                    20260813010000_loan_installment_source.sql
// hh_scheduled_payment id, owner_auth_uid, title, kind(autopay|subscription|insurance|telecom|maintenance|saving|loan|card_bill|income),
//                      amount, frequency(monthly|weekly|bimonthly), pay_day(1~28), account_id, category_id, person_id,
//                      direction(out|in), is_active, start_date, end_date                      20260613000000_household_init.sql
//                      payee                                                                   20260614000000_scheduled_payment_payee.sql
//                      permanent_hold default false                                            20260723000000_scheduled_payment_permanent_hold.sql
//                      payment_method_id → hh_payment_method                                   20260728000000_scheduled_payment_method.sql
//                      import_key (안 씀, NULL)                                                20260827000000_scheduled_import_key.sql
// hh_transaction       id, owner_auth_uid, txn_date, type(income|expense|installment|transfer|payment), amount(>=0),
//                      category_id, counterparty, memo, note, payment_method_id, account_id, from_account_id,
//                      to_account_id, person_id, installment_id, source(manual|inbox|import)   20260613000000_household_init.sql
//                      유형별 필수필드 CHECK(hh_transaction_type_fields):
//                        income   = account_id + category_id, from/to NULL
//                        expense  = category_id + (payment_method_id OR account_id), from/to NULL
//                        transfer = from_account_id + to_account_id (서로 다름)
//                        payment  = from_account_id                                            20260625010000_expense_account_only.sql
//                      loan_id → hh_loan                                                       20260720010000_loan_link.sql
//                      FK 는 RESTRICT (마스터 삭제 전 거래를 먼저 지워야 한다)                 20260618000000_data_integrity.sql
// 앱 관례(코드에서 확인):
//   - 대출 상환 = type 'payment' + loan_id + category '대출상환'  (20260720040000_inbox_payment_category.sql, calc.ts loanCategoryId)
//   - 카드 대금 = type 'payment' + from_account_id + category '카드대금' (src/lib/household/category-names.ts)
//   - 정기지출 '카드대금' 행은 category '카드대금' 으로 판별 (household-summary.tsx), 대출 상환은 hh_loan 이 직접 항목이 되므로
//     정기지출(kind 'loan') 행을 따로 만들지 않는다(calc.ts monthlyCashflow 가 둘 다 더해 이중계상됨).
//   - 할부 월 청구분은 계산으로 파생하므로 type 'installment' 거래는 만들지 않는다 (20260702000000_installment_inbox.sql 주석).
//   - 카테고리 이름은 src/lib/household/defaults.ts + category-names.ts 의 것만 쓴다.
// ───────────────────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

// ── 옵션 ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const RESET = args.includes("--reset");
const TODAY_ARG = args.find((a) => a.startsWith("--today="))?.slice("--today=".length);

const DEMO_TAG = "DEMO"; // hh_transaction.note 에 넣는 마커
const DEFAULT_LOGIN_ID = "admin";
const DEFAULT_PASSWORD_HINT = "jadong!"; // create-admin.mjs 의 기본값(안내 문구용)

// ── .env.local 로드 (create-admin.mjs 와 같은 방식) ───────────────────────────
function loadEnvFile(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return false;
  }
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
  return true;
}

// 실행 위치(cwd)의 .env.local 우선, 없으면 스크립트 기준 프로젝트 루트의 .env.local
if (!loadEnvFile(".env.local")) {
  loadEnvFile(fileURLToPath(new URL("../.env.local", import.meta.url)));
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const domain = process.env.NEXT_PUBLIC_AUTH_EMAIL_DOMAIN || "example.com";

if (!url || !serviceKey) {
  console.error(
    "\n[오류] .env.local 에 NEXT_PUBLIC_SUPABASE_URL 과 SUPABASE_SERVICE_ROLE_KEY 가 필요합니다.\n" +
      "      초기 설정(npm run setup:admin)이 끝난 뒤 실행하세요.\n"
  );
  process.exit(1);
}

const loginId = (process.env.ADMIN_LOGIN_ID || process.env.ADMIN_ID || DEFAULT_LOGIN_ID).trim();
const email = loginId.includes("@") ? loginId : `${loginId}@${domain}`;

const supabase = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ── 유틸 ──────────────────────────────────────────────────────────────────────

// 결정적 UUID: 같은 소유자 + 같은 키 → 항상 같은 id (멱등의 핵심)
function demoId(owner, key) {
  const hex = createHash("sha256").update(`kings-ledger-demo:${owner}:${key}`).digest("hex").slice(0, 32).split("");
  hex[12] = "4"; // version 4 형식
  hex[16] = "89ab"[parseInt(hex[16], 16) % 4]; // variant
  const s = hex.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

// 시드 고정 의사난수 (mulberry32) — 재실행해도 같은 금액·날짜가 나온다
function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad2 = (n) => String(n).padStart(2, "0");
const ymd = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;
const daysInMonth = (y, m) => new Date(y, m, 0).getDate(); // m: 1~12
function parseYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}
function localToday() {
  const d = new Date();
  return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
}
function shiftMonth({ y, m }, delta) {
  const idx = y * 12 + (m - 1) + delta;
  return { y: Math.floor(idx / 12), m: (idx % 12) + 1 };
}
const ymKey = ({ y, m }) => `${y}-${pad2(m)}`;
const won = (n) => `${Number(n).toLocaleString("ko-KR")}원`;

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ── 데모 데이터 정의 (전부 가상) ──────────────────────────────────────────────

// 지출 카테고리: src/lib/household/defaults.ts DEFAULT_EXPENSE_CATEGORIES 와 동일 순서
const EXPENSE_CATEGORIES = [
  "외식비", "다과/카페비", "식료품비", "생필품", "미용/뷰티", "양육비", "육아용품", "교육비", "적금", "보험",
  "기부금", "교통비", "차량유지비", "통신비", "구독료", "관리비", "의료비", "쇼핑", "경조사비", "레저/기타", "여행", "용돈",
];
// 앱이 이름으로 찾는 특수 카테고리 (category-names.ts): 납부 거래 분류용
const EXTRA_EXPENSE_CATEGORIES = ["카드대금", "대출상환"];
// 수입 카테고리: DEFAULT_INCOME_CATEGORIES
const INCOME_CATEGORIES = ["급여", "이자", "증권판매", "환급/캐시백", "기타수입"];

function buildPlan(owner, today) {
  const id = (key) => demoId(owner, key);
  const rng = makeRng(20260915);
  const randInt = (min, max) => min + Math.floor(rng() * (max - min + 1));
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  const round10 = (n) => Math.round(n / 10) * 10;

  // 1) 인물
  const P = {
    me: { id: id("person:김하늘"), name: "김하늘", sort_order: 0 },
    spouse: { id: id("person:이바다"), name: "이바다", sort_order: 1 },
    family: { id: id("person:가족"), name: "가족", sort_order: 2 },
  };
  const persons = Object.values(P).map((p) => ({ ...p, owner_auth_uid: owner, is_active: true }));

  // 2) 계좌 (정확히 3개)
  const A = {
    kb: { id: id("account:국민은행(김하늘)"), name: "국민은행(김하늘)", bank: "국민은행", account_no: "110-123-456789", person_id: P.me.id, opening_balance: 3_200_000, sort_order: 0 },
    kakao: { id: id("account:카카오뱅크(김하늘)"), name: "카카오뱅크(김하늘)", bank: "카카오뱅크", account_no: "3333-01-1234567", person_id: P.me.id, opening_balance: 850_000, sort_order: 1 },
    shinhan: { id: id("account:신한은행(이바다)"), name: "신한은행(이바다)", bank: "신한은행", account_no: "110-456-789012", person_id: P.spouse.id, opening_balance: 1_900_000, sort_order: 2 },
  };
  const accounts = Object.values(A).map((a) => ({ ...a, owner_auth_uid: owner, kind: "checking", is_active: true }));

  // 3) 결제수단: 현금 1개 + 신용카드 3개(각각 결제계좌 연결)
  const CASH = { id: id("method:현금"), name: "현금", kind: "cash", person_id: null, linked_account_id: null, billing_day: null, card_no: null, card_expiry: null, sort_order: 0 };
  const C = {
    samsung: { id: id("method:삼성카드(김하늘)"), name: "삼성카드(김하늘)", kind: "credit", person_id: P.me.id, linked_account_id: A.kb.id, billing_day: 14, card_no: "****-****-****-1234", card_expiry: "12/28", sort_order: 1 },
    hyundai: { id: id("method:현대카드(이바다)"), name: "현대카드(이바다)", kind: "credit", person_id: P.spouse.id, linked_account_id: A.shinhan.id, billing_day: 12, card_no: "****-****-****-5678", card_expiry: "06/29", sort_order: 2 },
    kbcard: { id: id("method:국민카드(김하늘)"), name: "국민카드(김하늘)", kind: "credit", person_id: P.me.id, linked_account_id: A.kakao.id, billing_day: 20, card_no: "****-****-****-9012", card_expiry: "03/30", sort_order: 3 },
  };
  const methods = [CASH, ...Object.values(C)].map((m) => ({ ...m, owner_auth_uid: owner, is_active: true }));

  // 4) 대출 (정확히 3개). 월 상환액은 원리금균등 근사값.
  const L = {
    house: { id: id("loan:주택담보대출"), name: "주택담보대출(국민은행)", origin_date: "2023-03-15", principal: 200_000_000, current_balance: 181_500_000, maturity_date: "2053-03-15", interest_rate: 3.85, monthly_payment: 938_000, payment_day: 15, account_id: A.kb.id, repayment_type: "annuity" },
    credit: { id: id("loan:신용대출"), name: "신용대출(카카오뱅크)", origin_date: "2024-09-01", principal: 30_000_000, current_balance: 20_400_000, maturity_date: "2029-09-01", interest_rate: 5.9, monthly_payment: 578_000, payment_day: 5, account_id: A.kakao.id, repayment_type: "annuity" },
    car: { id: id("loan:자동차할부"), name: "자동차 할부 대출(현대캐피탈)", origin_date: "2024-06-20", principal: 18_000_000, current_balance: 9_100_000, maturity_date: "2027-06-20", interest_rate: 4.5, monthly_payment: 535_000, payment_day: 20, account_id: A.shinhan.id, repayment_type: "annuity" },
  };
  const loans = Object.values(L).map((l) => ({ ...l, owner_auth_uid: owner, status: "active", source: "manual" }));

  // 5) 정기지출/정기수입. cat = 카테고리 이름(삽입 시 id 로 바꾼다). method 가 신용카드면 '카드로 내는 고정비'.
  const S = [
    { key: "관리비", title: "아파트 관리비", kind: "maintenance", amount: 245_000, pay_day: 10, account: A.kb, method: null, cat: "관리비", person: P.family, payee: "국민은행(김하늘)" },
    { key: "통신비-김하늘", title: "통신비(SKT 김하늘)", kind: "telecom", amount: 65_000, pay_day: 18, account: null, method: C.samsung, cat: "통신비", person: P.me, payee: "삼성카드(김하늘)" },
    { key: "통신비-이바다", title: "통신비(KT 이바다)", kind: "telecom", amount: 49_500, pay_day: 18, account: A.shinhan, method: null, cat: "통신비", person: P.spouse, payee: "신한은행(이바다)" },
    { key: "실손보험", title: "실손보험(삼성화재)", kind: "insurance", amount: 128_000, pay_day: 5, account: A.kb, method: null, cat: "보험", person: P.family, payee: "국민은행(김하늘)" },
    { key: "자동차보험", title: "자동차보험(DB손해보험)", kind: "insurance", amount: 92_000, pay_day: 27, account: A.shinhan, method: null, cat: "보험", person: P.spouse, payee: "신한은행(이바다)" },
    { key: "학원비", title: "학원비(영어학원)", kind: "autopay", amount: 350_000, pay_day: 8, account: A.kakao, method: null, cat: "교육비", person: P.family, payee: "카카오뱅크(김하늘)" },
    { key: "넷플릭스", title: "넷플릭스", kind: "subscription", amount: 17_000, pay_day: 3, account: null, method: C.kbcard, cat: "구독료", person: P.me, payee: "국민카드(김하늘)" },
    { key: "청약적금", title: "주택청약 적금", kind: "saving", amount: 200_000, pay_day: 25, account: A.kb, method: null, cat: "적금", person: P.me, payee: "국민은행(김하늘)" },
    // 카드대금(설계 108 이후 카드 현금유출은 이 행이 대표) — 금액은 평균치, 실제 납부는 전월 사용액으로 거래를 만든다
    { key: "카드대금-삼성", title: "카드대금-삼성카드-김하늘", kind: "card_bill", amount: 650_000, pay_day: C.samsung.billing_day, account: A.kb, method: null, cat: "카드대금", person: P.me, payee: "국민은행(김하늘)", card: C.samsung },
    { key: "카드대금-현대", title: "카드대금-현대카드-이바다", kind: "card_bill", amount: 480_000, pay_day: C.hyundai.billing_day, account: A.shinhan, method: null, cat: "카드대금", person: P.spouse, payee: "신한은행(이바다)", card: C.hyundai },
    { key: "카드대금-국민", title: "카드대금-국민카드-김하늘", kind: "card_bill", amount: 420_000, pay_day: C.kbcard.billing_day, account: A.kakao, method: null, cat: "카드대금", person: P.me, payee: "카카오뱅크(김하늘)", card: C.kbcard },
    // 정기수입 (현금흐름 예측이 켜지려면 direction 'in' 행이 필요하다)
    { key: "급여-김하늘", title: "급여(김하늘)", kind: "income", amount: 3_800_000, pay_day: 25, account: A.kb, method: null, cat: "급여", catKind: "income", person: P.me, payee: "(주)한빛소프트", direction: "in" },
    { key: "급여-이바다", title: "급여(이바다)", kind: "income", amount: 2_400_000, pay_day: 10, account: A.shinhan, method: null, cat: "급여", catKind: "income", person: P.spouse, payee: "행복유치원", direction: "in" },
  ].map((s) => ({ ...s, id: id(`scheduled:${s.key}`) }));

  const scheduled = S.map((s) => ({
    id: s.id,
    owner_auth_uid: owner,
    title: s.title,
    kind: s.kind,
    amount: s.amount,
    frequency: "monthly",
    pay_day: s.pay_day,
    account_id: s.account?.id ?? null,
    payment_method_id: s.method?.id ?? null,
    category: { name: s.cat, kind: s.catKind ?? "expense" }, // 삽입 시 category_id 로 변환
    person_id: s.person?.id ?? null,
    payee: s.payee,
    direction: s.direction ?? "out",
    is_active: true,
    permanent_hold: false,
    start_date: "2026-01-01",
    end_date: null,
  }));

  // 6) 할부 2건 (월 청구분은 앱이 계산으로 파생 — 거래를 만들지 않는다)
  const I = [
    { id: id("installment:노트북"), title: "노트북 구매(할부 6개월)", start_date: "2026-07-06", method: C.samsung, cat: "쇼핑", total_amount: 1_440_000, total_count: 6 },
    { id: id("installment:냉장고"), title: "냉장고(할부 10개월)", start_date: "2026-05-12", method: C.hyundai, cat: "쇼핑", total_amount: 1_890_000, total_count: 10 },
  ];
  const installments = I.map((i) => ({
    id: i.id,
    owner_auth_uid: owner,
    start_date: i.start_date,
    payment_method_id: i.method.id,
    category: { name: i.cat, kind: "expense" },
    title: i.title,
    total_amount: i.total_amount,
    total_count: i.total_count,
    start_installment: 1,
    is_active: true,
    source: "manual",
  }));

  // 7) 거래 — 최근 3개 온전한 달 + 이번 달(오늘까지)
  const todayStr = ymd(today.y, today.m, today.d);
  const startYm = shiftMonth(today, -3);
  const months = [];
  for (let k = 0; k <= 3; k++) months.push(shiftMonth(startYm, k));
  const inRange = (dateStr) => dateStr <= todayStr;
  const dayOf = ({ y, m }, d) => ymd(y, m, Math.min(d, daysInMonth(y, m)));

  const txns = [];
  let seq = 0;
  const add = (key, row) => {
    if (!inRange(row.txn_date)) return;
    seq += 1;
    txns.push({
      id: id(`txn:${key}`),
      owner_auth_uid: owner,
      note: DEMO_TAG,
      source: "manual",
      category: null,
      counterparty: null,
      memo: null,
      payment_method_id: null,
      account_id: null,
      from_account_id: null,
      to_account_id: null,
      person_id: null,
      installment_id: null,
      loan_id: null,
      ...row,
    });
  };

  // 변동지출 템플릿: cat 카테고리, 가맹점 후보, 금액 범위, 월 건수(소수는 확률)
  const VARIABLE = [
    { cat: "식료품비", merchants: ["이마트 부천점", "홈플러스 상동점", "마켓컬리", "하나로마트"], min: 28_000, max: 125_000, perMonth: 5 },
    { cat: "외식비", merchants: ["배달의민족", "김밥천국", "맘스터치", "스시노칸도", "교촌치킨", "한솥도시락"], min: 9_000, max: 68_000, perMonth: 6 },
    { cat: "다과/카페비", merchants: ["스타벅스", "이디야커피", "파리바게뜨", "투썸플레이스"], min: 4_500, max: 19_000, perMonth: 6 },
    { cat: "교통비", merchants: ["티머니 후불교통", "카카오택시", "코레일 KTX"], min: 1_400, max: 38_000, perMonth: 4 },
    { cat: "차량유지비", merchants: ["GS칼텍스 주유소", "하이패스 통행료"], min: 45_000, max: 95_000, perMonth: 2 },
    { cat: "생필품", merchants: ["다이소", "GS25", "쿠팡"], min: 4_000, max: 42_000, perMonth: 3 },
    { cat: "의료비", merchants: ["연세소아과의원", "온누리약국", "바른치과"], min: 4_500, max: 48_000, perMonth: 2 },
    { cat: "쇼핑", merchants: ["무신사", "쿠팡", "교보문고"], min: 19_000, max: 89_000, perMonth: 2 },
    { cat: "미용/뷰티", merchants: ["올리브영", "블루클럽 헤어"], min: 14_000, max: 62_000, perMonth: 1 },
    { cat: "육아용품", merchants: ["베이비앙", "맘스몰"], min: 22_000, max: 74_000, perMonth: 1 },
    { cat: "레저/기타", merchants: ["CGV", "롯데월드", "교보핫트랙스"], min: 14_000, max: 52_000, perMonth: 1 },
    { cat: "경조사비", merchants: ["축의금", "조의금"], min: 50_000, max: 100_000, perMonth: 0.5, cash: true },
  ];
  // 결제수단 가중 선택: 삼성 35% · 국민 25% · 현대 25% · 현금(카카오뱅크 출금) 15%
  const pickMethod = () => {
    const r = rng();
    if (r < 0.35) return { method: C.samsung, account: null, person: P.me };
    if (r < 0.6) return { method: C.kbcard, account: null, person: P.me };
    if (r < 0.85) return { method: C.hyundai, account: null, person: P.spouse };
    return { method: CASH, account: A.kakao, person: P.me };
  };

  for (const mo of months) {
    const ym = ymKey(mo);
    const dim = daysInMonth(mo.y, mo.m);

    // 급여 (본인 25일 · 배우자 10일)
    add(`${ym}:income:me`, { txn_date: dayOf(mo, 25), type: "income", amount: 3_800_000, category: { name: "급여", kind: "income" }, account_id: A.kb.id, counterparty: "(주)한빛소프트", memo: "월급", person_id: P.me.id });
    add(`${ym}:income:spouse`, { txn_date: dayOf(mo, 10), type: "income", amount: 2_400_000, category: { name: "급여", kind: "income" }, account_id: A.shinhan.id, counterparty: "행복유치원", memo: "월급", person_id: P.spouse.id });
    // 이자 (월말)
    add(`${ym}:income:interest`, { txn_date: dayOf(mo, dim), type: "income", amount: randInt(1_000, 2_200), category: { name: "이자", kind: "income" }, account_id: A.kakao.id, counterparty: "카카오뱅크 이자", memo: "예금이자", person_id: P.me.id });

    // 정기지출 실적 (계좌 출금 = 현금 결제수단 + 출금계좌 / 카드 결제 = 그 카드)
    for (const s of S) {
      if (s.direction === "in" || s.kind === "card_bill") continue;
      add(`${ym}:fixed:${s.key}`, {
        txn_date: dayOf(mo, s.pay_day),
        type: "expense",
        amount: s.amount,
        category: { name: s.cat, kind: "expense" },
        payment_method_id: s.method ? s.method.id : CASH.id,
        account_id: s.account ? s.account.id : null,
        counterparty: s.title,
        memo: "자동이체",
        person_id: s.person?.id ?? null,
      });
    }

    // 대출 상환 (payment + loan_id + 대출상환 카테고리)
    for (const [k, l] of Object.entries(L)) {
      add(`${ym}:loan:${k}`, {
        txn_date: dayOf(mo, l.payment_day),
        type: "payment",
        amount: l.monthly_payment,
        category: { name: "대출상환", kind: "expense" },
        from_account_id: l.account_id,
        loan_id: l.id,
        counterparty: l.name,
        memo: "원리금 자동납부",
      });
    }

    // 자녀 용돈 (1일, 카카오뱅크 현금)
    add(`${ym}:pocket`, { txn_date: dayOf(mo, 1), type: "expense", amount: 50_000, category: { name: "용돈", kind: "expense" }, payment_method_id: CASH.id, account_id: A.kakao.id, counterparty: "용돈", memo: "자녀 용돈", person_id: P.family.id });

    // 변동지출 (~34건/월)
    let n = 0;
    for (const t of VARIABLE) {
      const count = Math.floor(t.perMonth) + (rng() < t.perMonth % 1 ? 1 : 0);
      for (let i = 0; i < count; i++) {
        const day = randInt(1, dim);
        const amount = round10(randInt(t.min, t.max));
        const pm = t.cash ? { method: CASH, account: A.kb, person: P.me } : pickMethod();
        n += 1;
        add(`${ym}:var:${n}`, {
          txn_date: dayOf(mo, day),
          type: "expense",
          amount,
          category: { name: t.cat, kind: "expense" },
          payment_method_id: pm.method.id,
          account_id: pm.account?.id ?? null,
          counterparty: pick(t.merchants),
          memo: null,
          person_id: pm.person.id,
        });
      }
    }

    // 계좌 간 이체
    add(`${ym}:transfer:living`, { txn_date: dayOf(mo, 26), type: "transfer", amount: 1_200_000, from_account_id: A.kb.id, to_account_id: A.kakao.id, memo: "생활비 이체" });
    add(`${ym}:transfer:shared`, { txn_date: dayOf(mo, 11), type: "transfer", amount: 500_000, from_account_id: A.shinhan.id, to_account_id: A.kb.id, memo: "공동생활비" });
  }

  // 캐시백 1건 (두 번째 달)
  if (months[1]) add(`${ymKey(months[1])}:income:cashback`, { txn_date: dayOf(months[1], 16), type: "income", amount: 12_500, category: { name: "환급/캐시백", kind: "income" }, account_id: A.kb.id, counterparty: "삼성카드 캐시백", memo: "카드 실적 캐시백", person_id: P.me.id });

  // 카드대금 납부: 전월 카드 사용액(+전월 할부 청구분). 전월 데이터가 없는 첫 달은 정기지출 평균치.
  const cardUsage = new Map(); // `${cardId}:${ym}` → 합계
  for (const t of txns) {
    if (t.type !== "expense" || !t.payment_method_id || t.payment_method_id === CASH.id) continue;
    const k = `${t.payment_method_id}:${t.txn_date.slice(0, 7)}`;
    cardUsage.set(k, (cardUsage.get(k) ?? 0) + t.amount);
  }
  const installmentMonthly = (cardId, ym) => {
    let sum = 0;
    for (const ins of I) {
      if (ins.method.id !== cardId) continue;
      const s = parseYmd(ins.start_date);
      const elapsed = (Number(ym.slice(0, 4)) - s.y) * 12 + (Number(ym.slice(5, 7)) - s.m);
      if (elapsed < 0 || elapsed >= ins.total_count) continue;
      const base = Math.floor(ins.total_amount / ins.total_count);
      sum += elapsed === ins.total_count - 1 ? ins.total_amount - base * (ins.total_count - 1) : base;
    }
    return sum;
  };
  for (const mo of months) {
    const ym = ymKey(mo);
    const prevYm = ymKey(shiftMonth(mo, -1));
    for (const s of S) {
      if (s.kind !== "card_bill") continue;
      const hasPrev = months.some((m) => ymKey(m) === prevYm);
      const amount = hasPrev ? (cardUsage.get(`${s.card.id}:${prevYm}`) ?? 0) + installmentMonthly(s.card.id, prevYm) : s.amount;
      if (amount <= 0) continue;
      add(`${ym}:cardbill:${s.key}`, {
        txn_date: dayOf(mo, s.pay_day),
        type: "payment",
        amount,
        category: { name: "카드대금", kind: "expense" },
        from_account_id: s.account.id,
        counterparty: s.card.name.replace(/\(.*\)$/, ""), // "삼성카드" — 정기지출 제목과 상호 일치용
        memo: `${prevYm} 이용분 카드대금`,
        person_id: s.person.id,
      });
    }
  }

  txns.sort((a, b) => (a.txn_date < b.txn_date ? -1 : a.txn_date > b.txn_date ? 1 : a.id < b.id ? -1 : 1));

  return { persons, accounts, methods, loans, scheduled, installments, txns, months: months.map(ymKey), todayStr, cashId: CASH.id };
}

// ── DB 작업 ───────────────────────────────────────────────────────────────────

async function findAuthUserByEmail(targetEmail) {
  const { data, error } = await supabase.auth.admin.listUsers({ page: 1, perPage: 200 });
  if (error) throw new Error(error.message);
  return data.users.find((u) => u.email?.toLowerCase() === targetEmail.toLowerCase()) || null;
}

// 카테고리는 이름으로 찾고 없으면 만든다(앱 '기본값 생성' 과 같은 규칙). 반환: `${kind}:${name}` → id
async function ensureCategories(owner) {
  const { data: existing, error } = await supabase
    .from("hh_category")
    .select("id,name,kind")
    .eq("owner_auth_uid", owner);
  if (error) throw new Error(`hh_category 조회 실패: ${error.message}`);
  const map = new Map((existing ?? []).map((c) => [`${c.kind}:${c.name}`, c.id]));

  const wanted = [
    ...INCOME_CATEGORIES.map((name, i) => ({ name, kind: "income", sort_order: i })),
    ...EXPENSE_CATEGORIES.map((name, i) => ({ name, kind: "expense", sort_order: i })),
    ...EXTRA_EXPENSE_CATEGORIES.map((name, i) => ({ name, kind: "expense", sort_order: 90 + i })),
  ];
  const missing = wanted.filter((c) => !map.has(`${c.kind}:${c.name}`));
  if (missing.length && !DRY_RUN) {
    const rows = missing.map((c) => ({ owner_auth_uid: owner, name: c.name, kind: c.kind, is_fixed: false, sort_order: c.sort_order, is_active: true }));
    const { data, error: insErr } = await supabase.from("hh_category").insert(rows).select("id,name,kind");
    if (insErr) throw new Error(`hh_category 생성 실패: ${insErr.message}`);
    for (const c of data) map.set(`${c.kind}:${c.name}`, c.id);
  } else if (missing.length) {
    // dry-run: 아직 없는 카테고리는 "만들 예정" 표식 id 로 채워 뒤 단계 계획이 계속 돌게 한다
    for (const c of missing) map.set(`${c.kind}:${c.name}`, `(dry-run:${c.name})`);
  }
  return { map, created: missing.length, existing: wanted.length - missing.length };
}

// 결정적 id 기준으로 "없는 행만" 넣는다. category 필드는 id 로 치환.
async function insertMissing(table, rows, catMap) {
  const ids = rows.map((r) => r.id);
  const existing = new Set();
  for (const part of chunk(ids, 100)) {
    const { data, error } = await supabase.from(table).select("id").in("id", part);
    if (error) throw new Error(`${table} 조회 실패: ${error.message}`);
    for (const r of data) existing.add(r.id);
  }
  const toInsert = rows
    .filter((r) => !existing.has(r.id))
    .map((r) => {
      const { category, ...rest } = r;
      if (category === undefined) return rest;
      if (category === null) return { ...rest, category_id: null };
      const cid = catMap.get(`${category.kind}:${category.name}`);
      if (!cid) throw new Error(`${table}: 카테고리 '${category.name}'(${category.kind}) 가 없습니다.`);
      return { ...rest, category_id: cid };
    });
  if (!DRY_RUN) {
    for (const part of chunk(toInsert, 100)) {
      const { error } = await supabase.from(table).insert(part);
      if (error) throw new Error(`${table} 삽입 실패: ${error.message}`);
    }
  }
  return { inserted: toInsert.length, skipped: existing.size };
}

// 앱 '기본값 생성' 이 만든 '현금' 결제수단이 이미 있으면 그것을 재사용한다(같은 이름 2개 방지).
// 재사용한 행은 데모 id 가 아니므로 --reset 에서도 지우지 않는다.
async function reuseExistingCash(owner, plan) {
  const { data, error } = await supabase
    .from("hh_payment_method")
    .select("id")
    .eq("owner_auth_uid", owner)
    .eq("kind", "cash")
    .eq("name", "현금")
    .neq("id", plan.cashId)
    .limit(1);
  if (error) throw new Error(`hh_payment_method 조회 실패: ${error.message}`);
  const found = data?.[0]?.id;
  if (!found) return;
  console.log("  기존 '현금' 결제수단을 재사용합니다.");
  plan.methods = plan.methods.filter((m) => m.id !== plan.cashId);
  for (const t of plan.txns) if (t.payment_method_id === plan.cashId) t.payment_method_id = found;
  plan.cashId = found;
}

async function seed(owner, plan) {
  const summary = [];
  const cats = await ensureCategories(owner);
  summary.push({ 테이블: "hh_category", 신규: cats.created, 기존: cats.existing });
  await reuseExistingCash(owner, plan);

  const steps = [
    ["hh_person", plan.persons],
    ["hh_account", plan.accounts],
    ["hh_payment_method", plan.methods],
    ["hh_loan", plan.loans],
    ["hh_scheduled_payment", plan.scheduled],
    ["hh_installment", plan.installments],
    ["hh_transaction", plan.txns],
  ];
  for (const [table, rows] of steps) {
    const r = await insertMissing(table, rows, cats.map);
    summary.push({ 테이블: table, 신규: r.inserted, 기존: r.skipped });
    console.log(`  ${DRY_RUN ? "[계획]" : "[완료]"} ${table.padEnd(22)} 신규 ${String(r.inserted).padStart(4)}건 · 기존 ${String(r.skipped).padStart(4)}건`);
  }
  return summary;
}

// 데모 행만 삭제. 자식(거래) → 할부 → 정기지출 → 대출 → 결제수단 → 계좌 → 인물.
async function reset(owner, plan) {
  const summary = [];
  const del = async (table, ids, label) => {
    let q = supabase.from(table).delete().eq("owner_auth_uid", owner);
    q = ids ? q.in("id", ids) : q.eq("note", DEMO_TAG);
    if (DRY_RUN) {
      let s = supabase.from(table).select("id").eq("owner_auth_uid", owner);
      s = ids ? s.in("id", ids) : s.eq("note", DEMO_TAG);
      const { data, error } = await s;
      if (error) throw new Error(`${table} 조회 실패: ${error.message}`);
      summary.push({ 테이블: table, 삭제예정: data.length });
      console.log(`  [계획] ${label.padEnd(22)} 삭제 예정 ${data.length}건`);
      return;
    }
    const { data, error } = await q.select("id");
    if (error) {
      throw new Error(
        `${table} 삭제 실패: ${error.message}\n` +
          `      (데모 마스터를 참조하는 '직접 등록한' 거래·할부가 있으면 FK 로 막힙니다. 그 행을 먼저 지우거나 다른 계좌/카드로 옮기세요.)`
      );
    }
    summary.push({ 테이블: table, 삭제: data.length });
    console.log(`  [완료] ${label.padEnd(22)} 삭제 ${data.length}건`);
  };

  await del("hh_transaction", null, "hh_transaction(note=DEMO)");
  await del("hh_installment", plan.installments.map((r) => r.id), "hh_installment");
  await del("hh_scheduled_payment", plan.scheduled.map((r) => r.id), "hh_scheduled_payment");
  await del("hh_loan", plan.loans.map((r) => r.id), "hh_loan");
  await del("hh_payment_method", plan.methods.map((r) => r.id), "hh_payment_method");
  await del("hh_account", plan.accounts.map((r) => r.id), "hh_account");
  await del("hh_person", plan.persons.map((r) => r.id), "hh_person");
  return summary;
}

function printPlan(plan) {
  const byType = {};
  for (const t of plan.txns) byType[t.type] = (byType[t.type] ?? 0) + 1;
  console.log(`\n기준일 ${plan.todayStr} · 거래 생성 월: ${plan.months.join(", ")}`);
  console.log(`  인물 ${plan.persons.length} · 계좌 ${plan.accounts.length} · 결제수단 ${plan.methods.length}(현금 1 + 카드 3)`);
  console.log(`  대출 ${plan.loans.length} · 정기지출/수입 ${plan.scheduled.length} · 할부 ${plan.installments.length}`);
  console.log(
    `  거래 ${plan.txns.length}건 — ` +
      Object.entries(byType).map(([k, v]) => `${k} ${v}`).join(" · ")
  );
  for (const a of plan.accounts) console.log(`    계좌  ${a.name.padEnd(14)} 기초잔액 ${won(a.opening_balance)}`);
  for (const l of plan.loans) console.log(`    대출  ${l.name.padEnd(18)} 잔액 ${won(l.current_balance)} · 월 ${won(l.monthly_payment)} · 매월 ${l.payment_day}일`);
}

async function main() {
  const todayParsed = TODAY_ARG ? parseYmd(TODAY_ARG) : localToday();
  if (!todayParsed) {
    console.error("[오류] --today 는 YYYY-MM-DD 형식이어야 합니다.");
    process.exit(1);
  }

  console.log(`\n킹스가계부 데모 데이터 ${RESET ? "삭제" : "시드"}${DRY_RUN ? " (dry-run: 쓰기 없음)" : ""}`);
  console.log(`관리자 조회 중... (로그인 ID: ${loginId}, 이메일: ${email})`);

  const admin = await findAuthUserByEmail(email);
  if (!admin) {
    console.error(`\n[오류] 관리자 사용자(${email})가 없습니다. 먼저 npm run setup:admin 을 실행하세요.\n`);
    process.exit(1);
  }
  const owner = admin.id;
  console.log(`  소유자 uid: ${owner}`);

  const plan = buildPlan(owner, todayParsed);
  printPlan(plan);
  console.log("");

  const summary = RESET ? await reset(owner, plan) : await seed(owner, plan);

  console.log("\n요약");
  console.table(summary);

  if (!RESET) {
    console.log("========================================");
    console.log(`  데모 데이터 ${DRY_RUN ? "계획 확인 완료 (DB 변경 없음)" : "준비 완료!"}`);
    console.log(`  로그인 ID : ${loginId}`);
    console.log(`  비밀번호  : ${DEFAULT_PASSWORD_HINT}  (setup:admin 기본값 — 바꿨다면 바꾼 값)`);
    console.log("========================================");
    console.log("npm run dev 후 http://localhost:3000 에서 로그인하세요.");
    console.log("지우려면: node scripts/seed-demo.mjs --reset\n");
  } else {
    console.log(`\n데모 행 삭제 ${DRY_RUN ? "계획 확인 완료 (DB 변경 없음)" : "완료"}. (카테고리는 앱 기본값과 같아 남겨 둡니다.)\n`);
  }
}

main().catch((err) => {
  console.error("\n[오류] 데모 시드 실패:", err.message);
  console.error("Supabase 마이그레이션(supabase db push)과 setup:admin 이 먼저 끝났는지 확인하세요.\n");
  process.exit(1);
});
