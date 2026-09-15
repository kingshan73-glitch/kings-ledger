// 결제문자 자동수집 v2 실동작 검증 (설계 docs/household/22).
// 토큰 발급 → 6종 문자 파싱(승인/취소/입금/출금/이체/자동이체) → 두 경로(/sms, /inbox/sms)
// → guessed_kind 저장·잔액 제외 확인 → 잘못된/없는 토큰 401 → purge-raw 인증 401 → 정리.
// 실행: BASE_URL=http://localhost:3000 node --env-file=.env.local scripts/test_sms_ingest.mjs
import { createClient } from "@supabase/supabase-js";
import { createHash } from "crypto";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BASE = process.env.BASE_URL || "http://localhost:3000";
const MARK = "__SMS_TEST__";

const admin = createClient(url, service, { auth: { persistSession: false } });
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };

const { data: anyRow } = await admin.from("hh_category").select("owner_auth_uid").limit(1).single();
const owner = anyRow.owner_auth_uid;

const raw = `${MARK}_${Math.random().toString(16).slice(2)}`;
const tokenHash = createHash("sha256").update(raw).digest("hex");
const { data: tok, error: tErr } = await admin.from("hh_ingest_token").insert({ owner_auth_uid: owner, token_hash: tokenHash, label: MARK }).select("id").single();
if (tErr) { console.error("토큰 시드 실패:", tErr.message); process.exit(1); }

const insertedIds = [];
async function post(path, text, sender) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Ingest-Token": raw },
    body: JSON.stringify({ text, sender }),
  });
  const json = await res.json().catch(() => ({}));
  if (json.id) insertedIds.push(json.id);
  return { status: res.status, json };
}

console.log(`엔드포인트=${BASE}/api/household/inbox/sms\n`);

// 1) 거래종류별 파싱 (금액은 각기 달라 dedup 충돌 회피)
const cases = [
  { kind: "approve", amount: 12345, text: "[Web발신] 삼성카드 승인 12,345원 일시불 06/21 14:30 스타벅스", sender: "15881234" },
  { kind: "cancel", amount: 5001, text: "[Web발신] 삼성카드 승인취소 5,001원 06/21 스타벅스", sender: "15881234" },
  { kind: "deposit", amount: 1000002, text: "[Web발신] 국민은행 입금 1,000,002원 잔액 2,500,000원 급여", sender: "15881111" },
  { kind: "withdraw", amount: 30003, text: "[Web발신] 우리은행 출금 30,003원 잔액 100,000원 ATM", sender: "15881122" },
  { kind: "transfer", amount: 200004, text: "[Web발신] 하나은행 이체 200,004원 홍길동", sender: "15881133" },
  { kind: "autopay", amount: 55005, text: "[Web발신] 신한카드 자동이체 55,005원 통신요금", sender: "15447200" },
];
for (const cse of cases) {
  const { status, json } = await post("/api/household/inbox/sms", cse.text, cse.sender);
  ok(status === 201 && json.kind === cse.kind && json.amount === cse.amount,
    `${cse.kind}: status=${status} kind=${json.kind} amount=${json.amount} (기대 ${cse.amount})`);
}

// 2) 입금 건의 잔액 제외 + guessed_kind 저장 확인
const depId = insertedIds[2];
if (depId) {
  const { data: row } = await admin.from("hh_transaction_inbox").select("*").eq("id", depId).single();
  ok(row?.guessed_amount === 1000002, `입금 금액=거래액(잔액 2,500,000 제외, got ${row?.guessed_amount})`);
  ok(row?.guessed_kind === "deposit", `guessed_kind 저장(${row?.guessed_kind})`);
  ok(row?.guessed_type === "income", `입금→guessed_type=income(${row?.guessed_type})`);
  ok(row?.source === "sms" && row?.status === "pending", "source=sms, status=pending");
}

// 3) 기존 경로(/sms)도 동작
const legacy = await post("/api/household/sms", "[Web발신] 현대카드 승인 7,007원 06/21 메가커피", "15776200");
ok(legacy.status === 201 && legacy.json.kind === "approve", `기존 경로 /sms 동작(status=${legacy.status})`);

// 4) 중복 수집은 200 duplicate
const dup = await post("/api/household/inbox/sms", cases[0].text, cases[0].sender);
ok(dup.status === 200 && dup.json.duplicate === true, `중복 수집 차단(status=${dup.status})`);

// 5) 모바일 앱별 payload 변형 허용
const formBody = new URLSearchParams({ message: "[Web발신] 국민은행 입금 88,008원 테스트입금", from: "15880001" });
const formRes = await fetch(`${BASE}/api/household/inbox/sms?device_token=${encodeURIComponent(raw)}`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: formBody,
});
const formJson = await formRes.json().catch(() => ({}));
if (formJson.id) insertedIds.push(formJson.id);
ok(formRes.status === 201 && formJson.kind === "deposit" && formJson.amount === 88008, `form message/from + query device_token(status=${formRes.status})`);

const plainRes = await fetch(`${BASE}/api/household/inbox/sms`, {
  method: "POST",
  headers: { "Content-Type": "text/plain", "X-Device-Token": raw },
  body: "[Web발신] 우리은행 출금 77,007원 테스트출금",
});
const plainJson = await plainRes.json().catch(() => ({}));
if (plainJson.id) insertedIds.push(plainJson.id);
ok(plainRes.status === 201 && plainJson.kind === "withdraw" && plainJson.amount === 77007, `plain + X-Device-Token(status=${plainRes.status})`);

const bearerRes = await fetch(`${BASE}/api/household/inbox/sms`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${raw}` },
  body: JSON.stringify({ body: "[Web발신] 하나은행 이체 66,006원 테스트이체", address: "15880002" }),
});
const bearerJson = await bearerRes.json().catch(() => ({}));
if (bearerJson.id) insertedIds.push(bearerJson.id);
ok(bearerRes.status === 201 && bearerJson.kind === "transfer" && bearerJson.amount === 66006, `JSON body/address + Authorization Bearer(status=${bearerRes.status})`);

// 5b) 토스 증권→토스뱅크 자기이체: "입금 <본인> → 내 토스뱅크 통장"은 배우자 토스뱅크가 아니라
//     본인 증권계좌→본인 토스뱅크로 추정돼야 한다(설계 68). 실데이터(38,901)와 금액을 달리 해 dedup 회피.
const { data: hjAccts } = await admin
  .from("hh_account")
  .select("id, name")
  .eq("owner_auth_uid", owner)
  .in("name", ["증권계좌(김하늘)", "토스뱅크(김하늘)"]);
const secAcc = hjAccts?.find((a) => a.name === "증권계좌(김하늘)");
const tossAcc = hjAccts?.find((a) => a.name === "토스뱅크(김하늘)");
if (secAcc && tossAcc) {
  const selfXfer = await post("/api/household/inbox/sms", "38,911원 입금 김하늘 → 내 토스뱅크 통장", "15771000");
  const selfRow = selfXfer.json.id
    ? (await admin.from("hh_transaction_inbox").select("*").eq("id", selfXfer.json.id).single()).data
    : null;
  ok(
    selfXfer.status === 201 &&
      selfRow?.guessed_type === "transfer" &&
      selfRow?.guessed_from_account_id === secAcc.id &&
      selfRow?.guessed_to_account_id === tossAcc.id,
    `증권→토스뱅크 자기이체 추정(from=${selfRow?.guessed_from_account_id === secAcc.id}, to=${selfRow?.guessed_to_account_id === tossAcc.id})`
  );
} else {
  console.log("  ⚠️ 증권계좌(김하늘)/토스뱅크(김하늘) 미존재 — 자기이체 케이스 건너뜀");
}

// 5c) 카드대금 납부 = payment: 은행 출금 문자(카드사명+출금/대금)는 지출이 아니라 납부로.
//     from=끝자리 매칭 은행계좌, 결제수단 없음(지출집계 제외). 설계 69.
//     ⚠️ 카테고리는 설계 105(2026-07-27)부터 '카드대금'을 자동으로 채운다(그전엔 null이 정답이었다).
//     이 종단 테스트는 dev 서버가 필요해 `npm test` 체인에 없어 그 변경 때 함께 갱신되지 못했다. (2026-07-28 정정)
const { data: kbNa } = await admin
  .from("hh_account").select("id, account_no")
  .eq("owner_auth_uid", owner).eq("name", "국민은행(이바다)").maybeSingle();
if (kbNa && (kbNa.account_no ?? "").replace(/\D/g, "").endsWith("111")) {
  const pay = await post("/api/household/inbox/sms", "출금 500,001원 이*다님 07/12 12:00 110-11-0***-111 삼성카드 카드대금출금 500,001 잔액100,000", "15881111");
  const payRow = pay.json.id
    ? (await admin.from("hh_transaction_inbox").select("*").eq("id", pay.json.id).single()).data
    : null;
  // 프로덕션(sms-ingest.ts)과 동일 조건으로 조회한다 — kind 를 빼면 같은 이름의 수입 카테고리가 있을 때
  // maybeSingle() 이 다중행 오류로 null 을 주고, 코드가 정상인데 테스트만 거짓 실패한다.
  const { data: cardCat } = await admin
    .from("hh_category").select("id")
    .eq("owner_auth_uid", owner).eq("kind", "expense").eq("name", "카드대금").maybeSingle();
  // 카테고리가 없으면 기대값이 null 이 되어 '자동기재가 아예 안 돼도 통과'하는 위양성이 된다 → 전제를 먼저 단언.
  ok(!!cardCat?.id, `전제: '카드대금' 지출 카테고리 존재(${cardCat?.id ? "있음" : "없음"})`);
  ok(
    pay.status === 201 &&
      payRow?.guessed_type === "payment" &&
      payRow?.guessed_from_account_id === kbNa.id &&
      payRow?.guessed_category_id === cardCat?.id &&
      payRow?.guessed_payment_method_id == null,
    `카드대금→payment 추정(type=${payRow?.guessed_type}, from일치=${payRow?.guessed_from_account_id === kbNa.id}, 카테고리=카드대금:${payRow?.guessed_category_id === (cardCat?.id ?? null)})`
  );
  // 5d) 잔액 저장(설계 71): '잔액100,000'이 reported_balance + 계좌(끝자리 매칭)로 저장돼야 한다.
  ok(
    payRow?.reported_balance === 100000 && payRow?.reported_balance_account_id === kbNa.id,
    `문자 잔액 저장(reported_balance=${payRow?.reported_balance}, 계좌일치=${payRow?.reported_balance_account_id === kbNa.id})`
  );
} else {
  console.log("  ⚠️ 국민은행(이바다)_111 계좌 미존재 — 카드대금 payment·잔액 케이스 건너뜀");
}

// 5e) 설계 107 ①: 수기입력(manual)은 금액·날짜만 같다고 실거래를 삼키면 안 된다.
//     실사례 2026-07-28 — 수기 '한별 용돈' 100,000원이 우리은행 출금 100,000원(상대처=계좌번호)을 duplicate 로 만들었다.
//     상호가 겹치면(=손으로 넣은 그 거래가 뒤늦게 문자로 옴) 여전히 duplicate 여야 한다.
const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });
const seededManual = [];
async function seedManual(merchant, amount) {
  const { data, error } = await admin
    .from("hh_transaction_inbox")
    .insert({ owner_auth_uid: owner, source: "manual", status: "confirmed", guessed_date: today, guessed_amount: amount, guessed_merchant: merchant, guessed_type: "expense", raw_text: MARK })
    .select("id")
    .single();
  if (error) throw new Error(`수기입력 시드 실패: ${error.message}`);
  seededManual.push(data.id);
}

await seedManual(`${MARK}_다른거래`, 61234);
const other = await post("/api/household/inbox/sms", `[Web발신] 우리 12:00 *120000 출금 61,234원 커피가게테스트 잔액 1,000원`, "15885000");
const otherRow = other.json.id ? (await admin.from("hh_transaction_inbox").select("status").eq("id", other.json.id).single()).data : null;
ok(otherRow?.status === "pending", `수기입력과 금액만 같은 실거래는 살아남는다(status=${otherRow?.status}, 기대 pending)`);

await seedManual("커피가게테스트", 62345);
const same = await post("/api/household/inbox/sms", `[Web발신] 우리 12:00 *120000 출금 62,345원 커피가게테스트 잔액 1,000원`, "15885000");
const sameRow = same.json.id ? (await admin.from("hh_transaction_inbox").select("status").eq("id", same.json.id).single()).data : null;
ok(sameRow?.status === "duplicate", `수기입력과 상호까지 같으면 중복 유지(status=${sameRow?.status}, 기대 duplicate)`);

// 5g) 설계 107 ① 회귀: 같은 실거래라도 소스마다 유형이 갈릴 수 있다(카드사 SMS 는 할부 개월수가 찍혀
//     installment, 앱 알림은 expense). 유형 '완전일치'를 요구하면 크로스소스 dedup 이 안 걸려
//     설계 63 의 원래 기능이 회귀한다 → 나가는 돈 계열은 같은 것으로 봐야 한다. (교차리뷰 2026-07-28)
const { data: seedNotif, error: seedErr } = await admin
  .from("hh_transaction_inbox")
  .insert({ owner_auth_uid: owner, source: "notification", status: "pending", guessed_date: today,
    guessed_amount: 64567, guessed_merchant: "스타벅스테스트", guessed_type: "expense", raw_text: MARK })
  .select("id")
  .single();
if (seedErr) throw new Error(`알림 시드 실패: ${seedErr.message}`);
seededManual.push(seedNotif.id); // 정리 대상에 포함
const inst = await post("/api/household/inbox/sms", "[Web발신] 삼성카드 승인 김*늘 64,567원 03개월 스타벅스테스트", "15881234");
const instRow = inst.json.id ? (await admin.from("hh_transaction_inbox").select("status, guessed_type").eq("id", inst.json.id).single()).data : null;
ok(
  instRow?.status === "duplicate",
  `유형이 갈려도(알림 expense ↔ SMS ${instRow?.guessed_type}) 크로스소스 중복 인정(status=${instRow?.status}, 기대 duplicate)`
);

// 5f) 설계 107 ②: 체크카드 결제의 출금계좌는 **카드에 연결된 계좌**여야 한다 —
//     과거 오확정으로 merchant_map 에 다른 계좌가 학습돼 있어도 그걸 따라가면 안 된다.
//     실사례 2026-07-28: 우리체크 결제 55,000원이 학습된 국민은행(이바다)에서 빠졌다.
const { data: allMethods } = await admin
  .from("hh_payment_method").select("id, name, kind, linked_account_id").eq("owner_auth_uid", owner);
// 카드앱 알림은 '{카드사}체크' 형태의 짧은 이름으로 온다 → 그 접두어를 가진 카드가 하나뿐인 체크카드만 고른다
// (국민 체크카드가 2장이면 '국민체크'로는 특정할 수 없어 매칭되지 않는 게 정상이다).
const prefixOf = (n) => n.replace(/\(.*$/, "").replace(/카드.*$/, "").trim();
const checkPm = (allMethods ?? [])
  .filter((m) => m.kind === "check" && m.linked_account_id)
  .find((m) => (allMethods ?? []).filter((x) => prefixOf(x.name) === prefixOf(m.name)).length === 1);
if (checkPm) {
  const otherAccount = (await admin.from("hh_account").select("id").eq("owner_auth_uid", owner).neq("id", checkPm.linked_account_id).limit(1).maybeSingle()).data;
  const merchant = `${MARK}체크가맹점`;
  // 잘못 학습된 계좌를 심어 둔다 → 이게 재사용되면 안 된다.
  const seededMap = otherAccount
    ? (await admin.from("hh_merchant_map").insert({ owner_auth_uid: owner, merchant_key: merchant, account_id: otherAccount.id }).select("id").single()).data
    : null;
  const chk = await post("/api/household/inbox/sms", `63,456원 결제 ${prefixOf(checkPm.name)}체크 | ${merchant}(일시불)`, "15885000");
  const chkRow = chk.json.id ? (await admin.from("hh_transaction_inbox").select("guessed_payment_method_id, guessed_account_id").eq("id", chk.json.id).single()).data : null;
  ok(
    chkRow?.guessed_payment_method_id === checkPm.id && chkRow?.guessed_account_id === checkPm.linked_account_id,
    `체크카드 출금계좌=연결계좌(학습된 다른 계좌 무시: 수단일치=${chkRow?.guessed_payment_method_id === checkPm.id}, 계좌일치=${chkRow?.guessed_account_id === checkPm.linked_account_id})`
  );
  if (seededMap) await admin.from("hh_merchant_map").delete().eq("id", seededMap.id);
} else {
  console.log("  ⚠️ 이름으로 특정 가능한 체크카드 미존재 — 설계 107 체크카드 케이스 건너뜀");
}

// 5h) 설계 163: 같은 결제의 카드 승인 + 은행 출금 문자(같은 날짜·시각·금액, 둘 다 SMS·형식 상이)는
//     둘째가 휴지통(ignored)으로 간다. 응답은 201 + duplicate/trashed — 삭제가 아니라 보존이다.
//     (probe 는 DB 직삽입이라 이 케이스가 핸들러 HTTP 경로의 유일한 종단 검증이다. 2026-08-12)
const stA = await post("/api/household/inbox/sms", "[Web발신] 삼성카드 승인 김*늘 43,210원 일시불 06/21 09:41 테스트상회163", "15881234");
const stB = await post("/api/household/inbox/sms", "[Web발신] 우리 06/21 09:41 출금 43,210원 테스트상회163 잔액 1,000원", "15881122");
const stARow = stA.json.id ? (await admin.from("hh_transaction_inbox").select("status").eq("id", stA.json.id).single()).data : null;
const stBRow = stB.json.id ? (await admin.from("hh_transaction_inbox").select("status").eq("id", stB.json.id).single()).data : null;
ok(stA.status === 201 && !stA.json.trashed && stARow?.status === "pending",
  `동일시각 1건째는 검토대기(status=${stARow?.status}, 기대 pending)`);
ok(stB.status === 201 && stB.json.trashed === true && stB.json.duplicate === true && stBRow?.status === "ignored",
  `동일시각 2건째는 휴지통(trashed=${stB.json.trashed}, status=${stBRow?.status}, 기대 ignored)`);

// 5i) 설계 163 취소 예외: 취소 문자는 원 승인과 같은 날짜·시각·금액이어도 pending 으로 남아야 한다
//     (여기 걸리면 설계 151 원거래 삭제 흐름이 휴지통으로 빨려 들어간다 — 교차리뷰가 잡은 회귀).
const stC = await post("/api/household/inbox/sms", "[Web발신] 삼성카드 승인취소 김*늘 43,210원 06/21 09:41 테스트상회163", "15881234");
const stCRow = stC.json.id ? (await admin.from("hh_transaction_inbox").select("status, guessed_kind").eq("id", stC.json.id).single()).data : null;
ok(stC.status === 201 && stCRow?.guessed_kind === "cancel" && stCRow?.status === "pending",
  `같은 시각·금액의 취소 문자는 검토대기 유지(kind=${stCRow?.guessed_kind}, status=${stCRow?.status}, 기대 pending)`);

// 5j) 설계 164: 같은 날 같은 가맹점·금액의 **다른 시각** 재결제는 둘 다 수집돼야 한다.
//     (예전 키에는 시각이 없어 두 번째가 무흔적 소실됐다 — 2026-08-11 잔액 사슬 -5,000 실사례.)
//     크로스소스 아님(둘 다 SMS 같은 형식), 동일시각 아님(분이 다름) — 순수 dedup 키 검증.
const rp1 = await post("/api/household/inbox/sms", "[Web발신] 우리 06/21 10:05 출금 5,432원 테스트분식164 잔액 9,000원", "15881122");
const rp2 = await post("/api/household/inbox/sms", "[Web발신] 우리 06/21 13:44 출금 5,432원 테스트분식164 잔액 3,568원", "15881122");
ok(rp1.status === 201 && rp2.status === 201 && !rp2.json.duplicate && rp1.json.id !== rp2.json.id,
  `같은 가맹점·금액 다른 시각 재결제 둘 다 수집(1=${rp1.status}, 2=${rp2.status}, dup=${rp2.json.duplicate ?? false})`);
// 재전송(완전 동일 원문)은 여전히 200 duplicate 로 차단된다 — 새 행도 안 생겨야 한다(저장소 수준).
const rp3 = await post("/api/household/inbox/sms", "[Web발신] 우리 06/21 13:44 출금 5,432원 테스트분식164 잔액 3,568원", "15881122");
const { count: rpCount } = await admin.from("hh_transaction_inbox")
  .select("*", { count: "exact", head: true }).eq("owner_auth_uid", owner)
  .eq("guessed_amount", 5432).eq("guessed_date", "2026-06-21");
ok(rp3.status === 200 && rp3.json.duplicate === true && !rp3.json.id && rpCount === 2,
  `재전송은 여전히 차단 + 행 미생성(status=${rp3.status}, 행수=${rpCount}, 기대 2)`);

// 5k) 설계 164×163 상호작용: 같은 분 재결제(은행 문자, 잔액만 다름)는 키가 갈려 소실되지 않고,
//     동일시각 규칙(163)이 둘째를 휴지통으로 보존한다 — 무흔적 소실에서 가시적 보존으로.
const sm1 = await post("/api/household/inbox/sms", "[Web발신] 우리 06/21 15:20 출금 6,543원 테스트분식164 잔액 9,000원", "15881122");
const sm2 = await post("/api/household/inbox/sms", "[Web발신] 우리 06/21 15:20 출금 6,543원 테스트분식164 잔액 2,457원", "15881122");
const sm2Row = sm2.json.id ? (await admin.from("hh_transaction_inbox").select("status").eq("id", sm2.json.id).single()).data : null;
ok(sm1.status === 201 && !sm1.json.trashed, `같은 분 재결제 1건째 수집(status=${sm1.status})`);
ok(sm2.status === 201 && sm2.json.trashed === true && sm2Row?.status === "ignored",
  `같은 분 재결제 2건째는 휴지통 보존 — 소실 아님(trashed=${sm2.json.trashed}, status=${sm2Row?.status}, 기대 ignored)`);

// 6) 잘못된/없는 토큰 401
const bad = await fetch(`${BASE}/api/household/inbox/sms`, { method: "POST", headers: { "Content-Type": "application/json", "X-Ingest-Token": "wrong" }, body: JSON.stringify({ text: "x" }) });
ok(bad.status === 401, `잘못된 토큰 401(${bad.status})`);
const noTok = await fetch(`${BASE}/api/household/inbox/sms`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "x" }) });
ok(noTok.status === 401, `토큰 없음 401(${noTok.status})`);

// 7) purge-raw cron 인증 없으면 401
// 5k) 카드론 안내문(설계 181) — 실행금 입금(income) + 조건 jsonb 가 저장되는지 종단. 금액은 실물과 다른 합성값(dedup 회피).
{
  const cardLoanText = "⁨1588-1688⁩<제목: 장기카드대출입금안내> [Web발신] KB국민카드 장기카드대출을 이용해주셔서 감사합니다. ■ 신청내역 대출금액 : 1,234만원 대출기간 : 12개월 적용이자율 : 15.50% 상환방식 : 원리금균등상환 대출취급일 : 2026-08-17 대출만기일 : 2027-08-17 납입예상총원리금 : 13,401,000원 * 대출철회권 : 대출 실행일 14일이내 신청 가능합니다.";
  const { status, json } = await post("/api/household/inbox/sms", cardLoanText, "15881688");
  ok(status === 201 && json.kind === "deposit" && json.amount === 12340000, `카드론 안내: status=${status} kind=${json.kind} amount=${json.amount} (기대 12,340,000 — 납입예상총원리금 13,401,000 을 집으면 안 된다)`);
  ok(!!json.id, `카드론 안내: 저장 id 반환(${json.id ?? "없음"})`);
  if (json.id) {
    const { data: row } = await admin.from("hh_transaction_inbox").select("guessed_type,guessed_merchant,guessed_loan_terms").eq("id", json.id).single();
    ok(row?.guessed_type === "income", `카드론 안내 → guessed_type=income(${row?.guessed_type})`);
    ok(row?.guessed_merchant === "KB국민카드", `카드론 안내 → 상호=카드사명(${row?.guessed_merchant})`);
    const lt = row?.guessed_loan_terms;
    ok(lt && lt.rate === 15.5 && lt.term_months === 12 && lt.repayment_type === "annuity" && lt.total_repayment === 13401000 && lt.maturity_date === "2027-08-17",
      `카드론 조건 jsonb 저장 ${JSON.stringify(lt)}`);
  }
}

const purge = await fetch(`${BASE}/api/household/inbox/purge-raw`);
ok(purge.status === 401, `purge-raw 무인증 401(${purge.status})`);

// 정리
for (const id of seededManual) await admin.from("hh_transaction_inbox").delete().eq("id", id);
for (const id of insertedIds) await admin.from("hh_transaction_inbox").delete().eq("id", id);
await admin.from("hh_ingest_token").delete().eq("id", tok.id);
const { count: leftTok } = await admin.from("hh_ingest_token").select("*", { count: "exact", head: true }).eq("label", MARK);
ok(leftTok === 0, `잔여 토큰 0건(${leftTok})`);

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
