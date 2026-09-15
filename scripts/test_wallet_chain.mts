// 설계 161 검증: 선불 지갑(부천페이) 결제 문자는 지갑을 이름으로 지목하지 않는다(지갑이 소유자별로 둘).
// 대신 '총 보유 잔액'을 주므로 **직전 문자 잔액 − 이번 금액 == 이번 문자 잔액** 인 지갑을 물려받는다.
//
// 실행: npm run test:wallet-chain   (DB 불필요 — 엄격한 가짜 supabase 로 enrichParsed 통합 경로를 태운다)
//
// ★2026-08-10 보류 때의 교훈: 순수 함수만 테스트하면 통합 경로의 결함(창이 엉뚱한 컬럼에 걸림·전역 limit·
//   '총 보유 잔액 필수'가 직전 행에만 적용됨·계좌와 수단이 다른 지갑)을 하나도 못 잡는다.
//   그래서 여기 스텁은 **모르는 연산이면 던지고**, order/limit/gte/lte 를 실제 의미대로 구현한다.
//   또 재생(replay)은 학습값 때문에 거짓 통과하므로, 사례마다 학습값을 **오염시키거나 비워서** 사슬만 남긴다.
//
// 실사례(2026-08-18): 하삼동커피 부천옥길점 — 08-16 우리체크 확정으로 학습이 덮여 08-18 부천페이 결제가
//   빈칸으로 왔다(설계 160 가드가 우리은행 오배정은 막았지만 올바른 지갑을 채우진 못했다).
//   문자잔액 사슬 221,550 → 209,580 → 201,980 이 부천페이(이바다)을 유일하게 가리켰다.
const { enrichParsed } = await import("../src/lib/household/sms-ingest");
const { extractWalletBalance, walletChainLinks, shiftIsoDate, seoulToday, extractWalletLabel, walletLabelPick, WALLET_LABEL_HISTORY_LIMIT } = await import("../src/lib/household/sms");

let fail = 0;
const eq = (name: string, a: unknown, b: unknown) => {
  if (Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b)) console.log(`  ✅ ${name}`);
  else {
    fail++;
    console.log(`  ❌ ${name} — 기대 ${JSON.stringify(b)}, 실제 ${JSON.stringify(a)}`);
  }
};

type Row = Record<string, unknown>;

/**
 * 엄격한 supabase 스텁. enrichParsed 가 쓰는 연산만 구현하되 **의미를 그대로** 구현한다.
 * - 없는 컬럼은 null 로 본다(관대하게 통과시키지 않는다).
 * - order 는 호출 순서대로 1차·2차 정렬키, limit 은 정렬 뒤 자른다, maybeSingle 은 첫 행.
 * - 모르는 메서드는 던진다 — 코드가 새 연산을 쓰면 테스트가 조용히 통과하지 못하게.
 */
function strictStub(tables: Record<string, Row[]>, log?: string[], failWhen?: (table: string) => boolean) {
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
            // Postgres 기본: ASC 는 NULLS LAST, DESC 는 NULLS FIRST.
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
        // SQL LIKE 의미 그대로: % = 임의 길이, _ = 한 글자, 대소문자 무시, 앵커는 패턴 양끝.
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
        log?.push(`${table}:maybeSingle → ${out.length}`);
        return { data: out[0] ?? null, error: null };
      },
      single: async () => {
        const out = finish();
        return { data: out[0] ?? null, error: out.length === 1 ? null : { message: "single: 행 수 ≠ 1" } };
      },
      then: (resolve: (v: { data: Row[] | null; error: { message: string } | null }) => unknown) => {
        if (failWhen?.(table)) return resolve({ data: null, error: { message: "stub: 주입된 조회 실패" } });
        const out = finish();
        log?.push(`${table}:list → ${out.length}`);
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

// ── 고정 데이터 ───────────────────────────────────────────────────────────────
const OWNER = "owner-1";
const ACC_LBD = "acc-bpay-lbd"; // 부천페이(이바다) 지갑계좌
const ACC_KHN = "acc-bpay-khn"; // 부천페이(김하늘) 지갑계좌
const ACC_WOORI = "acc-woori"; // 우리은행(김하늘)
const PM_LBD = "pm-bpay-lbd";
const PM_KHN = "pm-bpay-khn";
const PM_WOORI_CHECK = "pm-woori-check";
const CAT_CAFE = "cat-cafe";
// ★기준일은 **원천(실제 오늘)에서 읽는다** — 하드코딩하면 검사기가 조용히 거짓말을 한다(2026-08-19 실사고).
//   부천페이 결제 문자에는 날짜가 없어(`occurredAt=null`) 구현이 사슬 창(45일)을 **실제 오늘** 기준으로 잡는다.
//   `TODAY = "2026-08-18"` 로 못박아 두니 하루 지난 08-19 에 경계 케이스가 하루 밀려 깨졌고,
//   '미래 행'으로 적어둔 08-20 은 08-21 이면 과거가 되어 판정이 통째로 뒤집혔다(둘 다 실측 확인).
//   그래서 모든 행 날짜는 오늘로부터의 **상대 오프셋** `D(n)` 으로 만든다(원래 실측일은 CHAIN 주석에 남겼다).
//   ★단 순수 `shiftIsoDate` 단위 테스트의 날짜 리터럴은 **날짜 산술 자체**를 재는 것이라 그대로 둔다.
const TODAY = seoulToday();
const D = (offsetDays: number) => shiftIsoDate(TODAY, offsetDays);

const accounts: Row[] = [
  { owner_auth_uid: OWNER, id: ACC_LBD, name: "부천페이(이바다)", account_no: null, person_id: "p-lbd", is_active: true },
  { owner_auth_uid: OWNER, id: ACC_KHN, name: "부천페이(김하늘)", account_no: null, person_id: "p-khn", is_active: true },
  { owner_auth_uid: OWNER, id: ACC_WOORI, name: "우리은행(김하늘)", account_no: "1002-120-000", person_id: "p-khn", is_active: true },
];
const wallets: Row[] = [
  { owner_auth_uid: OWNER, id: PM_LBD, name: "부천페이(이바다)", kind: "cash", card_no: null, linked_account_id: ACC_LBD, is_active: true },
  { owner_auth_uid: OWNER, id: PM_KHN, name: "부천페이(김하늘)", kind: "cash", card_no: null, linked_account_id: ACC_KHN, is_active: true },
  { owner_auth_uid: OWNER, id: PM_WOORI_CHECK, name: "우리카드(김하늘) 체크카드", kind: "check", card_no: "5387-1234-5678-0000", linked_account_id: ACC_WOORI, is_active: true },
];
const walletSms = (amount: number, merchant: string, balance: number, tag = "(캐릭터)") =>
  `결제 완료 ${amount.toLocaleString("ko-KR")}원${merchant} 부천페이 추가형 인센티브 ${Math.round(amount * 0.0909).toLocaleString("ko-KR")}원 부천페이${tag} 총 보유 잔액 ${balance.toLocaleString("ko-KR")}원`;
/** 수집함 직전 행. guessed_account_id 가 그 문자의 지갑(확정 때 화면에서 고친 값 포함). */
const inboxRow = (o: { date: string; collected: string; amount: number; merchant: string; balance: number; acct: string | null; pm?: string | null; status?: string; raw?: string }): Row => ({
  owner_auth_uid: OWNER,
  id: `inbox-${o.date}-${o.collected}-${o.merchant}`,
  status: o.status ?? "confirmed",
  source: "sms",
  guessed_date: o.date,
  collected_at: `${o.date}T${o.collected}:00+00:00`,
  guessed_amount: o.amount,
  guessed_account_id: o.acct,
  guessed_payment_method_id: o.pm ?? null,
  reported_balance: o.balance,
  raw_text: o.raw ?? walletSms(o.amount, o.merchant, o.balance),
});
const tables = (o: { merchantMap?: Row[]; inbox?: Row[]; methods?: Row[]; accounts?: Row[] }): Record<string, Row[]> => ({
  hh_merchant_map: o.merchantMap ?? [],
  hh_account: o.accounts ?? accounts,
  hh_payment_method: o.methods ?? wallets,
  hh_person: [
    { owner_auth_uid: OWNER, id: "p-lbd", name: "이바다" },
    { owner_auth_uid: OWNER, id: "p-khn", name: "김하늘" },
  ],
  hh_category: [{ owner_auth_uid: OWNER, id: CAT_CAFE, name: "다과/카페비", kind: "expense" }],
  hh_loan: [],
  hh_scheduled_payment: [],
  hh_transaction_inbox: o.inbox ?? [],
  hh_transaction: [],
});
/** 08-16 우리체크 확정이 덮어쓴 '오염된' 학습값 — 설계 160 가드가 막아 빈칸이 되던 상태. */
const POLLUTED = [{ owner_auth_uid: OWNER, merchant_key: "하삼동커피 부천옥길점", category_id: CAT_CAFE, payment_method_id: PM_WOORI_CHECK, account_id: ACC_WOORI }];
/** 실측 사슬(2026-08-18 기준): 08-13 카페게이트 221,550(이바다) → 08-18 브레댄코 209,580(이바다). 김하늘 지갑은 08-12 189,354.
 *  날짜는 오늘 기준 상대 오프셋으로 둔다 — 간격만 재현하면 되고, 절대일은 창(45일) 밖으로 늙어 죽는다. */
const CHAIN = [
  inboxRow({ date: D(-6), collected: "11:04", amount: 160000, merchant: "미래인재입시학원(주)", balance: 189354, acct: ACC_KHN, raw: walletSms(160000, " 미래인재입시학원(주)", 189354, "") }),
  inboxRow({ date: D(-5), collected: "01:39", amount: 8000, merchant: "카페게이트 부천옥길점", balance: 221550, acct: ACC_LBD }),
  inboxRow({ date: TODAY, collected: "00:04", amount: 11970, merchant: "브레댄코 부천옥길점", balance: 209580, acct: ACC_LBD, status: "pending" }),
];
const HASAMDONG = walletSms(7600, "하삼동커피 부천옥길점", 201980);

console.log("[0] 순수 함수");
{
  eq("총 보유 잔액 추출(캐릭터)", extractWalletBalance(HASAMDONG), 201980);
  eq("총 보유 잔액 추출(무표기)", extractWalletBalance("… 부천페이 총 보유 잔액 189,354원"), 189354);
  eq("★은행 잔액은 거부(충전 문자)", extractWalletBalance("[Web발신] 국민 08/03 19:41 경기지역화폐 오픈뱅킹출금 300,000 잔액4,875,291"), null);
  eq("잔액 없음", extractWalletBalance("3,800원 결제 우리체크 | 하삼동커피 부천옥길점(일시불)"), null);
  eq("사슬 1개", walletChainLinks({ amount: 7600, balance: 201980 }, [{ walletAccountId: ACC_LBD, prevBalance: 209580 }, { walletAccountId: ACC_KHN, prevBalance: 189354 }]), [ACC_LBD]);
  eq("사슬 0개(충전 직후)", walletChainLinks({ amount: 7600, balance: 531980 }, [{ walletAccountId: ACC_LBD, prevBalance: 209580 }]), []);
  eq("사슬 2개(우연 일치)", walletChainLinks({ amount: 100, balance: 900 }, [{ walletAccountId: ACC_LBD, prevBalance: 1000 }, { walletAccountId: ACC_KHN, prevBalance: 1000 }]), [ACC_LBD, ACC_KHN]);
  eq("금액 0 은 판정 안 함", walletChainLinks({ amount: 0, balance: 1000 }, [{ walletAccountId: ACC_LBD, prevBalance: 1000 }]), []);
  eq("날짜 이동", shiftIsoDate("2026-08-18", -45), "2026-07-04");
  eq("날짜 이동(월말 넘김)", shiftIsoDate("2026-03-01", -1), "2026-02-28");
  // ★seoulToday 자체를 고정 시각으로 잰다 — 아래 섹션들은 픽스처와 구현이 **같은 seoulToday** 를
  //   쓰므로, 타임존이 UTC 로 깨져도 둘 다 똑같이 밀려서 전부 통과해 버린다(교차리뷰 2026-08-19).
  //   여기서만 실제 서울 변환을 리터럴로 고정한다.
  eq("서울 오늘: UTC 자정은 서울에선 이미 그날 오전 9시", seoulToday(new Date("2026-08-19T00:00:00Z")), "2026-08-19");
  eq("★서울 오늘: UTC 15:00 은 서울에선 이미 다음 날(UTC 로 깨지면 여기서 걸린다)", seoulToday(new Date("2026-08-19T15:00:00Z")), "2026-08-20");
  eq("서울 오늘: UTC 14:59 은 아직 같은 날", seoulToday(new Date("2026-08-19T14:59:59Z")), "2026-08-19");
  eq("서울 오늘: 연말 넘김", seoulToday(new Date("2026-12-31T15:00:00Z")), "2027-01-01");
}

console.log("\n[1] 실사례 — 학습이 우리체크로 오염돼도 사슬이 부천페이(이바다)을 유일하게 가리킨다");
{
  const { fields } = await enrichParsed(strictStub(tables({ merchantMap: POLLUTED, inbox: CHAIN })), OWNER, HASAMDONG, null);
  eq("★출금계좌 = 부천페이(이바다)", fields.guessed_account_id, ACC_LBD);
  eq("★결제수단 = 부천페이(이바다) (같은 지갑)", fields.guessed_payment_method_id, PM_LBD);
  eq("우리은행·우리체크 오배정 없음", fields.guessed_account_id === ACC_WOORI || fields.guessed_payment_method_id === PM_WOORI_CHECK, false);
  eq("카테고리 학습값은 유지", fields.guessed_category_id, CAT_CAFE);
  eq("잔액 귀속 = 그 지갑(문자 사슬 근거)", fields.reported_balance_account_id, ACC_LBD);
  eq("잔액", fields.reported_balance, 201980);
}

console.log("\n[2] 새 가맹점(학습값 없음) — 사슬만으로 지갑이 붙는다 (★보류 때 '학습값 있을 때만' 조건에 갇혀 안 돌던 결함)");
{
  const sms = walletSms(5000, "처음가는가게", 196980);
  const { fields } = await enrichParsed(strictStub(tables({ inbox: [...CHAIN, inboxRow({ date: TODAY, collected: "00:13", amount: 7600, merchant: "하삼동커피 부천옥길점", balance: 201980, acct: ACC_LBD })] })), OWNER, sms, null);
  eq("출금계좌 = 부천페이(이바다)", fields.guessed_account_id, ACC_LBD);
  eq("결제수단 = 부천페이(이바다)", fields.guessed_payment_method_id, PM_LBD);
  eq("카테고리 없음(학습 없음)", fields.guessed_category_id, null);
}

console.log("\n[3] 사슬 불성립(충전 직후 — 지갑 잔액이 뛰었다) → 빈칸. 오염된 학습값도 여전히 막힌다");
{
  const sms = walletSms(7600, "하삼동커피 부천옥길점", 531980);
  const { fields } = await enrichParsed(strictStub(tables({ merchantMap: POLLUTED, inbox: CHAIN })), OWNER, sms, null);
  eq("출금계좌 = 빈칸", fields.guessed_account_id, null);
  eq("결제수단 = 빈칸", fields.guessed_payment_method_id, null);
  eq("잔액 귀속 없음", fields.reported_balance_account_id, null);
  eq("카테고리 학습값은 유지", fields.guessed_category_id, CAT_CAFE);
}

console.log("\n[4] 두 지갑 모두 사슬 성립(우연 일치) → 모호 → 빈칸");
{
  const both = [
    inboxRow({ date: D(-1), collected: "01:00", amount: 1000, merchant: "가게A", balance: 50000, acct: ACC_LBD }),
    inboxRow({ date: D(-1), collected: "02:00", amount: 1000, merchant: "가게B", balance: 50000, acct: ACC_KHN }),
  ];
  const { fields } = await enrichParsed(strictStub(tables({ inbox: both })), OWNER, walletSms(3000, "가게C", 47000), null);
  eq("출금계좌 = 빈칸", fields.guessed_account_id, null);
  eq("결제수단 = 빈칸", fields.guessed_payment_method_id, null);
}

console.log("\n[5] ★'총 보유 잔액'이 없는 문자(은행 잔액만)는 사슬을 돌리지 않는다 — 이번 문자에도 적용(보류 때 Major 3)");
{
  // 직전 이바다 지갑 잔액 209,580 − 7,600 = 201,980 이 은행 '잔액'과 우연히 같아도 지갑을 붙이면 안 된다.
  const bankSms = "[Web발신] 우리 08/18 09:13 *120000 출금 7,600원 하삼동커피 부 잔액 201,980원";
  const { fields, parsed } = await enrichParsed(strictStub(tables({ inbox: CHAIN })), OWNER, bankSms, null);
  eq("은행 잔액은 파싱됨", parsed.balance, 201980);
  eq("지갑 계좌가 붙지 않음", [ACC_LBD, ACC_KHN].includes(fields.guessed_account_id as string), false);
  eq("지갑 결제수단이 붙지 않음", [PM_LBD, PM_KHN].includes(fields.guessed_payment_method_id as string), false);
}

console.log("\n[6] ★창은 거래일 기준 45일 — 오래된 직전 건과는 잇지 않고, 미래 날짜 건은 '직전'이 아니다(보류 때 Major 1)");
{
  const old = [inboxRow({ date: D(-46), collected: "01:00", amount: 1000, merchant: "옛가게", balance: 209580, acct: ACC_LBD })];
  const r1 = await enrichParsed(strictStub(tables({ inbox: old })), OWNER, HASAMDONG, null);
  eq("46일 전 건 → 빈칸", r1.fields.guessed_account_id, null);
  const edge = [inboxRow({ date: D(-45), collected: "01:00", amount: 1000, merchant: "옛가게", balance: 209580, acct: ACC_LBD })];
  const r2 = await enrichParsed(strictStub(tables({ inbox: edge })), OWNER, HASAMDONG, null);
  eq("45일 전 건 → 이어짐", r2.fields.guessed_account_id, ACC_LBD);
  // 소급 수집: 수집시각은 오늘이지만 거래일이 미래인 행(문자에 날짜가 있는 다른 종류)이 섞여도 직전으로 삼지 않는다.
  // ★D(2) 로 둔다 — 예전처럼 절대일("2026-08-20")로 적으면 이틀 뒤엔 '미래'가 아니라 **유효한 앵커**가 되어
  //   사슬이 성립해 버린다(실측: 그 날짜를 과거로 바꾸면 이 케이스가 acc-bpay-lbd 로 뒤집힌다).
  const future = [
    inboxRow({ date: D(2), collected: "00:00", amount: 1000, merchant: "미래가게", balance: 209580, acct: ACC_LBD }),
    inboxRow({ date: D(-8), collected: "00:00", amount: 1000, merchant: "과거가게", balance: 300000, acct: ACC_LBD }),
  ];
  const r3 = await enrichParsed(strictStub(tables({ inbox: future })), OWNER, HASAMDONG, null);
  eq("미래 행은 무시 → 과거 행(300,000)과는 불성립 → 빈칸", r3.fields.guessed_account_id, null);
}

console.log("\n[7] ★지갑별 직전 건 — 한 지갑이 최근 행을 아무리 많이 점유해도 다른 지갑의 직전 건이 보인다(보류 때 Major 2)");
{
  const rows: Row[] = [inboxRow({ date: D(-8), collected: "00:00", amount: 1000, merchant: "김하늘가게", balance: 100000, acct: ACC_KHN })];
  for (let i = 0; i < 80; i++) rows.push(inboxRow({ date: D(-3), collected: `${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`, amount: 100, merchant: `이바다가게${i}`, balance: 500000 - i, acct: ACC_LBD }));
  const { fields } = await enrichParsed(strictStub(tables({ inbox: rows })), OWNER, walletSms(2500, "새가게", 97500), null);
  eq("김하늘 지갑으로 이어짐", fields.guessed_account_id, ACC_KHN);
  eq("결제수단 = 부천페이(김하늘)", fields.guessed_payment_method_id, PM_KHN);
}

console.log("\n[8] ★계좌와 결제수단은 같은 지갑 — 선택된 계좌에 연결된 수단만 채우고, 연결 수단이 둘이면 수단은 빈칸(보류 때 Major 4)");
{
  const twoMethods = [...wallets, { owner_auth_uid: OWNER, id: "pm-bpay-lbd-2", name: "부천페이(이바다) 예비", kind: "cash", card_no: null, linked_account_id: ACC_LBD, is_active: true }];
  const { fields } = await enrichParsed(strictStub(tables({ inbox: CHAIN, methods: twoMethods })), OWNER, HASAMDONG, null);
  eq("출금계좌 = 부천페이(이바다)", fields.guessed_account_id, ACC_LBD);
  eq("결제수단 = 빈칸(연결 수단 2개 → 모호)", fields.guessed_payment_method_id, null);
  // ★교차리뷰 H2: 학습값이 '상대 지갑 수단'이면 그 뒤 학습 폴백이 수단을 다시 얹어 계좌≠수단이 되던 뒷문.
  const learnedOther = [{ owner_auth_uid: OWNER, merchant_key: "하삼동커피 부천옥길점", category_id: CAT_CAFE, payment_method_id: PM_KHN, account_id: ACC_KHN }];
  const r2 = await enrichParsed(strictStub(tables({ inbox: CHAIN, methods: twoMethods, merchantMap: learnedOther })), OWNER, HASAMDONG, null);
  eq("(상대 지갑 학습) 출금계좌 = 부천페이(이바다)", r2.fields.guessed_account_id, ACC_LBD);
  eq("★(상대 지갑 학습) 결제수단에 김하늘 지갑이 얹히지 않는다", r2.fields.guessed_payment_method_id, null);
}

console.log("\n[9] 직전 행이 '지갑 미배정(빈칸)'이면 앵커가 아니다 — 그 앞 배정된 행과 이어지지 않으면 빈칸(틀리게 채우지 않는다)");
{
  const rows = [
    inboxRow({ date: D(-5), collected: "01:39", amount: 8000, merchant: "카페게이트 부천옥길점", balance: 221550, acct: ACC_LBD }),
    inboxRow({ date: TODAY, collected: "00:04", amount: 11970, merchant: "브레댄코 부천옥길점", balance: 209580, acct: null, status: "pending" }),
  ];
  const { fields } = await enrichParsed(strictStub(tables({ inbox: rows })), OWNER, HASAMDONG, null);
  eq("출금계좌 = 빈칸(사슬 끊김)", fields.guessed_account_id, null);
}

console.log("\n[10] 회귀 — 지갑이 하나뿐인 소유자: 이름 폴백(설계 105)이 그대로 동작하고 사슬이 그걸 뒤집지 않는다");
{
  const oneWallet = wallets.filter((w) => w.id !== PM_KHN);
  const oneAcc = accounts.filter((a) => a.id !== ACC_KHN);
  const { fields } = await enrichParsed(strictStub(tables({ inbox: [], methods: oneWallet, accounts: oneAcc })), OWNER, HASAMDONG, null);
  eq("결제수단 = 유일한 부천페이", fields.guessed_payment_method_id, PM_LBD);
  eq("출금계좌 = 연결계좌", fields.guessed_account_id, ACC_LBD);
}

console.log("\n[11] ★지갑이 둘 이상이면 사슬이 유일한 권위 — 사슬이 못 정하면 학습된 지갑값도 쓰지 않는다(교차리뷰 High: 상대 지갑 학습 → 앵커 오염 → 연쇄 오배정)");
{
  const learnedWallet = [{ owner_auth_uid: OWNER, merchant_key: "하삼동커피 부천옥길점", category_id: CAT_CAFE, payment_method_id: PM_LBD, account_id: ACC_LBD }];
  const { fields } = await enrichParsed(strictStub(tables({ merchantMap: learnedWallet, inbox: [] })), OWNER, HASAMDONG, null);
  eq("앵커 없음 → 출금계좌 = 빈칸(학습된 지갑값 폴백 금지)", fields.guessed_account_id, null);
  eq("결제수단 = 빈칸", fields.guessed_payment_method_id, null);
  eq("카테고리 학습값은 유지", fields.guessed_category_id, CAT_CAFE);
  // 상대 지갑이 학습돼 있고 충전 직후(사슬 불성립)여도 상대 지갑으로 붙지 않는다 → 그 행이 앵커가 되어 연쇄로 번지는 경로 차단.
  const learnedOther = [{ owner_auth_uid: OWNER, merchant_key: "하삼동커피 부천옥길점", category_id: CAT_CAFE, payment_method_id: PM_KHN, account_id: ACC_KHN }];
  const r2 = await enrichParsed(strictStub(tables({ merchantMap: learnedOther, inbox: CHAIN })), OWNER, walletSms(7600, "하삼동커피 부천옥길점", 531980), null);
  eq("★충전 직후 + 상대 지갑 학습 → 빈칸(상대 지갑으로 안 붙음)", r2.fields.guessed_account_id, null);
  eq("결제수단 = 빈칸", r2.fields.guessed_payment_method_id, null);
  // 지갑이 하나뿐이면 종전대로(이름 폴백·학습값) — 틀릴 지갑이 없다.
  const oneWallet = wallets.filter((w) => w.id !== PM_KHN);
  const oneAcc = accounts.filter((a) => a.id !== ACC_KHN);
  const r3 = await enrichParsed(strictStub(tables({ merchantMap: learnedWallet, inbox: [], methods: oneWallet, accounts: oneAcc })), OWNER, HASAMDONG, null);
  eq("지갑 1개: 출금계좌 = 그 지갑", r3.fields.guessed_account_id, ACC_LBD);
  eq("지갑 1개: 결제수단 = 그 지갑", r3.fields.guessed_payment_method_id, PM_LBD);
}

console.log("\n[12] 회귀 — 우리체크 알림(카드명 지목)은 사슬과 무관하게 종전대로 우리은행 연결계좌");
{
  const noti = "3,800원 결제 우리체크 | 하삼동커피 부천옥길점(일시불)";
  const { fields } = await enrichParsed(strictStub(tables({ merchantMap: POLLUTED, inbox: CHAIN })), OWNER, noti, null);
  eq("결제수단 = 우리체크", fields.guessed_payment_method_id, PM_WOORI_CHECK);
  eq("출금계좌 = 우리은행", fields.guessed_account_id, ACC_WOORI);
}

console.log("\n[13] ★앵커 조회가 실패하면 사슬을 포기한다 — 한 지갑이 조용히 빠져 '모호→빈칸'이 '유일→오배정'으로 뒤집히지 않게(교차리뷰 M4)");
{
  const both = [
    inboxRow({ date: D(-1), collected: "01:00", amount: 1000, merchant: "가게A", balance: 50000, acct: ACC_LBD }),
    inboxRow({ date: D(-1), collected: "02:00", amount: 1000, merchant: "가게B", balance: 50000, acct: ACC_KHN }),
  ];
  const { fields } = await enrichParsed(strictStub(tables({ inbox: both }), undefined, (t) => t === "hh_transaction_inbox"), OWNER, walletSms(3000, "가게C", 47000), null);
  eq("출금계좌 = 빈칸", fields.guessed_account_id, null);
  eq("결제수단 = 빈칸", fields.guessed_payment_method_id, null);
}

console.log("\n[14] 앵커 원문의 표기 변형('총보유잔액')도 앵커로 잡힌다 — ilike 를 느슨하게 걸고 판정은 extractWalletBalance 한 곳(교차리뷰 M5)");
{
  const rows = [inboxRow({ date: D(-1), collected: "01:00", amount: 1000, merchant: "가게A", balance: 209580, acct: ACC_LBD, raw: "결제 완료 1,000원가게A 부천페이 추가형 인센티브 91원 부천페이(캐릭터) 총보유잔액 209,580원" })];
  const { fields } = await enrichParsed(strictStub(tables({ inbox: rows })), OWNER, HASAMDONG, null);
  eq("출금계좌 = 부천페이(이바다)", fields.guessed_account_id, ACC_LBD);
}

console.log("\n[15] 원문에 은행 '잔액'과 '총 보유 잔액'이 함께 있으면 계좌는 사슬로 채우되 잔액 귀속은 비운다(교차리뷰 M6)");
{
  const sms = "결제 완료 7,600원하삼동커피 부천옥길점 잔액 999,999원 부천페이 추가형 인센티브 691원 부천페이(캐릭터) 총 보유 잔액 201,980원";
  const { fields, parsed } = await enrichParsed(strictStub(tables({ inbox: CHAIN })), OWNER, sms, null);
  eq("parsed.balance 는 첫 '잔액'(은행값)", parsed.balance, 999999);
  eq("출금계좌 = 부천페이(이바다)", fields.guessed_account_id, ACC_LBD);
  eq("★잔액 귀속 = 없음(은행 잔액을 지갑에 붙이지 않음)", fields.reported_balance_account_id, null);
}

console.log("\n[16] 휴지통(ignored)·중복(duplicate) 행은 앵커가 아니다");
{
  const rows = [
    inboxRow({ date: D(-1), collected: "01:00", amount: 1000, merchant: "가게A", balance: 209580, acct: ACC_LBD, status: "ignored" }),
    inboxRow({ date: D(-2), collected: "01:00", amount: 1000, merchant: "가게B", balance: 300000, acct: ACC_LBD, status: "duplicate" }),
  ];
  const { fields } = await enrichParsed(strictStub(tables({ inbox: rows })), OWNER, HASAMDONG, null);
  eq("출금계좌 = 빈칸", fields.guessed_account_id, null);
  const rows2 = [inboxRow({ date: D(-1), collected: "01:00", amount: 1000, merchant: "가게A", balance: 209580, acct: ACC_LBD, status: "archived" })];
  const r2 = await enrichParsed(strictStub(tables({ inbox: rows2 })), OWNER, HASAMDONG, null);
  eq("archived 행은 앵커", r2.fields.guessed_account_id, ACC_LBD);
}

console.log("\n[17] ★선불 수단 조회가 실패하면 학습 계좌·수단은 쓰지 않고 카테고리만 유지한다");
{
  const learnedWallet = [{ owner_auth_uid: OWNER, merchant_key: "하삼동커피 부천옥길점", category_id: CAT_CAFE, payment_method_id: PM_LBD, account_id: ACC_LBD }];
  const { fields } = await enrichParsed(
    strictStub(tables({ merchantMap: learnedWallet, inbox: CHAIN }), undefined, (t) => t === "hh_payment_method"),
    OWNER,
    HASAMDONG,
    null,
  );
  eq("조회 실패 → 출금계좌 = 빈칸", fields.guessed_account_id, null);
  eq("조회 실패 → 결제수단 = 빈칸", fields.guessed_payment_method_id, null);
  eq("조회 실패여도 카테고리 학습값은 유지", fields.guessed_category_id, CAT_CAFE);
}

console.log("\n[197-0] 설계 197 순수 함수 — 표기 추출·만장일치 판정");
{
  eq("표기(캐릭터)", extractWalletLabel(HASAMDONG, "부천페이"), "부천페이|캐릭터");
  eq("표기(무표기)", extractWalletLabel(walletSms(160000, " 미래인재입시학원(주)", 189354, ""), "부천페이"), "부천페이|");
  eq("전각 괄호", extractWalletLabel("부천페이（캐릭터）총 보유 잔액 1원", "부천페이"), "부천페이|캐릭터");
  eq("총 보유 잔액 없음 → null", extractWalletLabel("3,800원 결제 우리체크 | 하삼동커피", "부천페이"), null);
  eq("기관 null → null", extractWalletLabel(HASAMDONG, null), null);
  eq("기관이 잔액 앞에 없음 → null", extractWalletLabel("코나 총 보유 잔액 1원", "부천페이"), null);
  const H = (label: string, w: string, n: number) => Array.from({ length: n }, () => ({ label, walletAccountId: w }));
  eq("3건 만장일치 → 채택", walletLabelPick("부천페이|", H("부천페이|", ACC_KHN, 3)), ACC_KHN);
  eq("2건 → 부족", walletLabelPick("부천페이|", H("부천페이|", ACC_KHN, 2)), null);
  eq("3건인데 지갑 갈림(2+1) → 빈칸(다수결 없음)", walletLabelPick("부천페이|", [...H("부천페이|", ACC_KHN, 2), ...H("부천페이|", ACC_LBD, 1)]), null);
  eq("다른 표기는 세지 않음", walletLabelPick("부천페이|캐릭터", [...H("부천페이|", ACC_KHN, 3), ...H("부천페이|캐릭터", ACC_LBD, 1)]), null);
  eq("다른 표기가 섞여도 내 표기만 만장일치면 채택", walletLabelPick("부천페이|", [...H("부천페이|", ACC_KHN, 3), ...H("부천페이|캐릭터", ACC_LBD, 5)]), ACC_KHN);
  eq("표기 null → null", walletLabelPick(null, H("부천페이|", ACC_KHN, 3)), null);
}

// 실사례 2026-09-01: 코나아이 500,000 충전 직후 김하늘 지갑 결제 240,000(잔액 400,354) — 앵커 8/25 잔액 90,354 와 안 이어져 빈칸.
// 사람이 확정한 이력에서 무표기 → 김하늘 지갑 (5/5), 캐릭터 → 이바다 지갑 (38/38).
const HIST_LABEL = [
  inboxRow({ date: D(-20), collected: "01:00", amount: 8000, merchant: "카페게이트 부천옥길점", balance: 90354, acct: ACC_KHN, raw: walletSms(8000, " 카페게이트 부천옥길점", 90354, "") }),
  inboxRow({ date: D(-22), collected: "01:00", amount: 11000, merchant: "블루클럽", balance: 98354, acct: ACC_KHN, raw: walletSms(11000, " 블루클럽", 98354, "") }),
  inboxRow({ date: D(-23), collected: "01:00", amount: 12000, merchant: "카페게이트 부천옥길점", balance: 177354, acct: null, pm: PM_KHN, raw: walletSms(12000, " 카페게이트 부천옥길점", 177354, "") }),
  inboxRow({ date: D(-3), collected: "01:00", amount: 7600, merchant: "하삼동커피 부천옥길점", balance: 23130, acct: ACC_LBD }),
  inboxRow({ date: D(-4), collected: "01:00", amount: 13230, merchant: "브레댄코 부천옥길점", balance: 30730, acct: ACC_LBD }),
  inboxRow({ date: D(-5), collected: "01:00", amount: 7600, merchant: "하삼동커피 부천옥길점", balance: 43960, acct: ACC_LBD }),
];
const AFTER_CHARGE = walletSms(240000, " 아이엠(IM)리듬 체조 클럽", 400354, "");

console.log("\n[197-1] 실사례 — 충전 직후라 사슬 불성립 → 무표기 이력(계좌 2건 + 수단만 1건 = 3건 만장일치)이 김하늘 지갑을 가리킨다");
{
  const { fields } = await enrichParsed(strictStub(tables({ inbox: HIST_LABEL })), OWNER, AFTER_CHARGE, null);
  eq("★출금계좌 = 부천페이(김하늘)", fields.guessed_account_id, ACC_KHN);
  eq("★결제수단 = 부천페이(김하늘)", fields.guessed_payment_method_id, PM_KHN);
  eq("★잔액 귀속 없음 — 표기는 통계 근거뿐이라 잔액까지 남의 지갑에 얹지 않는다(교차리뷰 M3)", fields.reported_balance_account_id, null);
  eq("잔액 값 자체는 보존", fields.reported_balance, 400354);
}

console.log("\n[197-2] 이어지는 다음 건 — 앞 건이 pending 이라도 사슬(161)이 먼저 잇는다(표기 폴백은 안 돈다)");
{
  const pendingFirst = inboxRow({ date: TODAY, collected: "07:24", amount: 240000, merchant: "아이엠(IM)리듬 체조 클럽", balance: 400354, acct: ACC_KHN, pm: PM_KHN, status: "pending", raw: AFTER_CHARGE });
  const { fields } = await enrichParsed(strictStub(tables({ inbox: [...HIST_LABEL, pendingFirst] })), OWNER, walletSms(140000, " 모마미술관이화미술교습소", 260354, ""), null);
  eq("출금계좌 = 부천페이(김하늘)", fields.guessed_account_id, ACC_KHN);
  eq("결제수단 = 부천페이(김하늘)", fields.guessed_payment_method_id, PM_KHN);
}

console.log("\n[197-3] ★사슬이 권위 — 표기 이력이 김하늘를 가리켜도 사슬이 이바다을 유일하게 잇으면 이바다");
{
  // 이바다 지갑 앵커 209,580 → 7,600 결제 → 201,980. 문자엔 무표기(김하늘 표기)를 일부러 넣는다.
  const rows = [...HIST_LABEL, inboxRow({ date: D(-1), collected: "01:00", amount: 11970, merchant: "브레댄코 부천옥길점", balance: 209580, acct: ACC_LBD })];
  const { fields } = await enrichParsed(strictStub(tables({ inbox: rows })), OWNER, walletSms(7600, "하삼동커피 부천옥길점", 201980, ""), null);
  eq("출금계좌 = 부천페이(이바다) (사슬)", fields.guessed_account_id, ACC_LBD);
}

console.log("\n[197-4] 이력 부족(무표기 2건) → 빈칸");
{
  const { fields } = await enrichParsed(strictStub(tables({ inbox: HIST_LABEL.slice(1) })), OWNER, AFTER_CHARGE, null);
  eq("출금계좌 = 빈칸", fields.guessed_account_id, null);
  eq("결제수단 = 빈칸", fields.guessed_payment_method_id, null);
}

console.log("\n[197-5] ★표기가 두 지갑에 걸리면(상대 배우자가 같은 상품 카드) 만장일치 깨짐 → 빈칸");
{
  const split = [...HIST_LABEL, inboxRow({ date: D(-2), collected: "01:00", amount: 1000, merchant: "가게Z", balance: 5000, acct: ACC_LBD, raw: walletSms(1000, " 가게Z", 5000, "") })];
  const { fields } = await enrichParsed(strictStub(tables({ inbox: split })), OWNER, AFTER_CHARGE, null);
  eq("출금계좌 = 빈칸", fields.guessed_account_id, null);
}

console.log("\n[197-6] ★pending 은 이력으로 세지 않는다(오배정 증폭 방지) — 무표기 3건이 전부 pending 이면 빈칸");
{
  const pend = HIST_LABEL.map((r) => (r.guessed_account_id === ACC_KHN || r.guessed_payment_method_id === PM_KHN ? { ...r, status: "pending" } : r));
  const { fields } = await enrichParsed(strictStub(tables({ inbox: pend })), OWNER, AFTER_CHARGE, null);
  eq("출금계좌 = 빈칸", fields.guessed_account_id, null);
}

console.log("\n[197-7] 이력 창 365일 — 366일 전 확정은 세지 않는다");
{
  const old = HIST_LABEL.map((r) => (r.guessed_account_id === ACC_KHN || r.guessed_payment_method_id === PM_KHN ? { ...r, guessed_date: D(-366) } : r));
  const r1 = await enrichParsed(strictStub(tables({ inbox: old })), OWNER, AFTER_CHARGE, null);
  eq("366일 전 → 빈칸", r1.fields.guessed_account_id, null);
  const edge = HIST_LABEL.map((r) => (r.guessed_account_id === ACC_KHN || r.guessed_payment_method_id === PM_KHN ? { ...r, guessed_date: D(-365) } : r));
  const r2 = await enrichParsed(strictStub(tables({ inbox: edge })), OWNER, AFTER_CHARGE, null);
  eq("365일 전 → 채택", r2.fields.guessed_account_id, ACC_KHN);
}

console.log("\n[197-9] ★이력이 조회 상한에 닿으면 잘린 것 — 반대 지갑 확정이 빠져 거짓 만장일치가 될 수 있으니 빈칸(교차리뷰 M1)");
{
  // 무표기 → 김하늘 3건은 오래됐고(D(-300)), 그 위에 **무표기 → 이바다** 결제가 상한만큼 최근에 쌓였다.
  // 전체 이력으로는 무표기가 두 지갑에 걸려 '갈림→빈칸'이 맞다. limit 이 오래된 김하늘 3건을 잘라내면 잘린 이력은
  // '이바다 만장일치'로 보인다 — 가드가 없으면 이바다으로 **오배정**, 가드가 있으면 빈칸. (재검증 M2: 예전 픽스처는
  // 채움 행이 캐릭터 표기라 가드 유무와 무관하게 빈칸이 나와 아무것도 구분하지 못했다.)
  const rows: Row[] = HIST_LABEL.map((r) => (r.guessed_account_id === ACC_KHN || r.guessed_payment_method_id === PM_KHN ? { ...r, guessed_date: D(-300) } : r));
  for (let i = 0; i < WALLET_LABEL_HISTORY_LIMIT; i++) rows.push(inboxRow({ date: D(-1 - (i % 100)), collected: `${String(Math.floor(i / 60) % 24).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`, amount: 100, merchant: `이바다가게${i}`, balance: 900000 - i, acct: ACC_LBD, raw: walletSms(100, ` 이바다가게${i}`, 900000 - i, "") }));
  const { fields } = await enrichParsed(strictStub(tables({ inbox: rows })), OWNER, AFTER_CHARGE, null);
  eq("★상한에 닿음(잘린 이력은 이바다 만장일치로 보임) → 출금계좌 = 빈칸", fields.guessed_account_id, null);
  // 같은 데이터에서 상한 아래로 내려가면(김하늘 3건이 보이면) 갈림 → 역시 빈칸. 가드 판정과 진짜 갈림 판정이 같은 결론이어야 한다.
  const fewer = rows.slice(0, HIST_LABEL.length + WALLET_LABEL_HISTORY_LIMIT - 10);
  const r2 = await enrichParsed(strictStub(tables({ inbox: fewer })), OWNER, AFTER_CHARGE, null);
  eq("상한 아래 · 두 지갑에 걸림 → 빈칸", r2.fields.guessed_account_id, null);
  // 김하늘 3건을 아예 빼면 무표기 = 이바다 만장일치가 **진짜**라 채택돼야 한다(가드가 과하게 막지 않는지).
  const onlyLbd = rows.filter((r) => r.guessed_account_id !== ACC_KHN && r.guessed_payment_method_id !== PM_KHN).slice(0, WALLET_LABEL_HISTORY_LIMIT - 10);
  const r3 = await enrichParsed(strictStub(tables({ inbox: onlyLbd })), OWNER, AFTER_CHARGE, null);
  eq("상한 아래 · 진짜 만장일치 → 이바다 채택", r3.fields.guessed_account_id, ACC_LBD);
}

console.log("\n[197-8] 이력 조회 실패 → 던지지 않고 빈칸");
{
  const { fields } = await enrichParsed(strictStub(tables({ inbox: HIST_LABEL }), undefined, (t) => t === "hh_transaction_inbox"), OWNER, AFTER_CHARGE, null);
  eq("출금계좌 = 빈칸", fields.guessed_account_id, null);
}

console.log(fail === 0 ? "\n전부 통과 ✅" : `\n실패 ${fail}건 ❌`);
process.exit(fail === 0 ? 0 : 1);
