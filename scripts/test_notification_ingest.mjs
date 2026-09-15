// 알림(Notification) 자동수집 실동작 검증 (설계 docs/household/42).
// 토큰 발급 → 알림 JSON POST → raw_meta 보존·source=notification·best-effort 파싱 확인
// → title+text+분단위 dedup → 401(토큰)·400(빈본문) → 정리.
// 실행: BASE_URL=http://localhost:3000 node --env-file=.env.local scripts/test_notification_ingest.mjs
import { createClient } from "@supabase/supabase-js";
import { createHash } from "crypto";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BASE = process.env.BASE_URL || "http://localhost:3000";
const MARK = "__NOTIF_TEST__";
const PATH = "/api/household/inbox";

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
async function post(body, { token = raw, headers = {} } = {}) {
  const h = { "Content-Type": "application/json", ...headers };
  if (token) h["X-Ingest-Token"] = token;
  const res = await fetch(`${BASE}${PATH}`, { method: "POST", headers: h, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (json.id) insertedIds.push(json.id);
  return { status: res.status, json };
}

console.log(`엔드포인트=${BASE}${PATH}\n`);

const recv = "2027-01-15T10:30:00+09:00"; // 고정 시각(분단위 dedup 검증용)

// 1) 토스류 알림: envelope 보존 + best-effort 파싱
const notif = {
  source: "macrodroid",
  app: "토스",
  package: "viva.republica.toss",
  title: `토스뱅크 ${MARK}`,
  text: "출금 9,000원 씨유(CU)옥길헤",
  bigText: "출금 9,000원 씨유(CU)옥길헤 잔액 74,958원",
  channel: "transaction",
  receivedAt: recv,
};
const r1 = await post(notif);
ok(r1.status === 201 && r1.json.source === "notification", `알림 적재 201·source=notification (status=${r1.status})`);
ok(r1.json.amount === 9000, `금액 파싱 9000 (got ${r1.json.amount})`);

// 2) DB 검증: raw_meta·source·source_adapter
if (r1.json.id) {
  const { data: row } = await admin.from("hh_transaction_inbox").select("*").eq("id", r1.json.id).single();
  ok(row?.source === "notification" && row?.status === "pending", "source=notification, status=pending");
  ok(row?.source_adapter === "토스", `source_adapter=앱명(토스) (got ${row?.source_adapter})`);
  // raw_text는 설계47대로 title+본문(bigText 우선) 합본으로 저장된다(중복문구는 1회).
  const expectedRaw = [notif.title, notif.bigText].filter(Boolean).join(" ").trim();
  ok(row?.raw_text === expectedRaw, `raw_text=title+bigText 합본 보존(설계47) (got ${row?.raw_text})`);
  ok(row?.raw_meta?.app === "토스" && row?.raw_meta?.package === "viva.republica.toss", "raw_meta에 app·package 보존");
  ok(row?.raw_meta?.channel === "transaction" && row?.raw_meta?.receivedAt === recv, "raw_meta에 channel·receivedAt 보존");
  ok(row?.guessed_kind === "withdraw" && row?.guessed_merchant?.includes("씨유"), `파싱(kind=${row?.guessed_kind}, merchant=${row?.guessed_merchant})`);
}

// 3) 중복: 같은 title+text+분단위시각 → 200 duplicate
const dup = await post(notif);
ok(dup.status === 200 && dup.json.duplicate === true, `중복(title+text+분단위) 차단 (status=${dup.status})`);

// 4) 같은 분이라도 text 다르면 신규
const notif2 = { ...notif, text: "출금 3,300원 다른가맹점", bigText: "출금 3,300원 다른가맹점 잔액 1,000원" };
const r2 = await post(notif2);
ok(r2.status === 201, `text 다르면 신규 적재 (status=${r2.status})`);

// 5) 빈 본문(title/text/bigText 모두 없음) → 400
const empty = await post({ source: "macrodroid", app: "토스", receivedAt: recv });
ok(empty.status === 400, `빈 본문 400 (${empty.status})`);

// 6) 토큰 검증
const bad = await post(notif, { token: "wrong" });
ok(bad.status === 401, `잘못된 토큰 401 (${bad.status})`);
const noTok = await post(notif, { token: null });
ok(noTok.status === 401, `토큰 없음 401 (${noTok.status})`);

// 7) 설계 165 — 캐시백 결합 알림("N원 캐시백 🎉 M원 결제")
// 7a) 먼저 같은 결제의 일반 알림이 수집돼 있고,
const payN = { ...notif, title: `토스 ${MARK} 결제`, text: "출금 21,343원 합성상점A", bigText: "출금 21,343원 합성상점A 잔액 90,000원", receivedAt: "2027-01-15T11:00:00+09:00" };
const p1 = await post(payN);
ok(p1.status === 201 && p1.json.amount === 21343, `165 결제 알림 선수집 (status=${p1.status}, amount=${p1.json.amount})`);
// 7b) 같은 날·같은 금액의 결합 알림이 뒤따르면 — 상호가 달라도 duplicate 로 격리(무흔적 아님)
const combo1 = { ...notif, title: `토스 ${MARK} 캐시백`, text: "42원 캐시백 🎉 21,343원 결제 | 합성상점A_PG", bigText: "42원 캐시백 🎉 21,343원 결제 | 합성상점A_PG 잔액 68,657원(토스뱅크 체크카드)", receivedAt: "2027-01-15T11:01:00+09:00" };
const c1 = await post(combo1);
const c1Row = c1.json.id ? (await admin.from("hh_transaction_inbox").select("status,guessed_amount").eq("id", c1.json.id).single()).data : null;
ok(c1.status === 201 && c1.json.amount === 21343, `165 결합 알림 금액=결제액 (got ${c1.json.amount}, 기대 21343 — 캐시백 42 아님)`);
ok(c1Row?.status === "duplicate", `165 결합 알림 재통보는 duplicate 격리 (status=${c1Row?.status})`);
// 7c) 형제 없는 단독 결합 알림은 pending + 금액=결제액 (2026-08-12 쿠팡 실사례의 본체)
const combo2 = { ...notif, title: `토스 ${MARK} 캐시백단독`, text: "57원 캐시백 🎉 17,891원 결제 | 합성상점B", bigText: "57원 캐시백 🎉 17,891원 결제 | 합성상점B 잔액 50,000원(토스뱅크 체크카드)", receivedAt: "2027-01-15T11:02:00+09:00" };
const c2 = await post(combo2);
const c2Row = c2.json.id ? (await admin.from("hh_transaction_inbox").select("status,guessed_amount").eq("id", c2.json.id).single()).data : null;
ok(c2.status === 201 && Number(c2Row?.guessed_amount) === 17891 && c2Row?.status === "pending",
  `165 단독 결합 알림은 pending + 결제액 (status=${c2Row?.status}, amount=${c2Row?.guessed_amount})`);
// 7d) 취소 결합 알림은 같은 날·금액 형제가 있어도 duplicate 로 격리되면 안 된다(설계 151 취소 흐름 보호)
const cancelCombo = { ...notif, title: `토스 ${MARK} 캐시백취소`, text: "42원 캐시백 취소 21,343원 결제 취소 | 합성상점A_PG", bigText: "42원 캐시백 취소 21,343원 결제 취소 | 합성상점A_PG 잔액 90,000원(토스뱅크 체크카드)", receivedAt: "2027-01-15T11:03:00+09:00" };
const c3 = await post(cancelCombo);
const c3Row = c3.json.id ? (await admin.from("hh_transaction_inbox").select("status,guessed_kind").eq("id", c3.json.id).single()).data : null;
ok(c3.status === 201 && c3Row?.guessed_kind === "cancel" && c3Row?.status !== "duplicate",
  `165 취소 결합 알림은 duplicate 격리 안 됨 (kind=${c3Row?.guessed_kind}, status=${c3Row?.status})`);
// 7e) 중복이 중복을 낳지 않는다 — 형제가 duplicate 상태뿐이면 새 결합 알림은 pending 으로 남는다.
//     (7c 의 pending 행을 admin 으로 duplicate 로 바꿔 '중복만 있는' 상태를 만든 뒤 재시도)
if (c2.json.id) {
  await admin.from("hh_transaction_inbox").update({ status: "duplicate" }).eq("id", c2.json.id);
  const combo3 = { ...notif, title: `토스 ${MARK} 캐시백재시도`, text: "31원 캐시백 🎉 17,891원 결제 | 합성상점B_PG", bigText: "31원 캐시백 🎉 17,891원 결제 | 합성상점B_PG 잔액 32,109원(토스뱅크 체크카드)", receivedAt: "2027-01-15T11:04:00+09:00" };
  const c4 = await post(combo3);
  const c4Row = c4.json.id ? (await admin.from("hh_transaction_inbox").select("status").eq("id", c4.json.id).single()).data : null;
  ok(c4.status === 201 && c4Row?.status === "pending", `165 duplicate 형제만 있으면 pending 유지 (status=${c4Row?.status})`);
}
// 7f) 수용 잔여의 고정(설계 165 §3): 결합 알림이 먼저 오고 결제 알림이 뒤따르면 둘 다 pending —
//     가드는 결합 알림 쪽에만 있다. 이 동작이 바뀌면(조용한 소실 등) 여기서 드러난다.
const comboFirst = { ...notif, title: `토스 ${MARK} 결합선착`, text: "18원 캐시백 🎉 44,553원 결제 | 합성상점C_PG", bigText: "18원 캐시백 🎉 44,553원 결제 | 합성상점C_PG 잔액 10,000원(토스뱅크 체크카드)", receivedAt: "2027-01-15T11:05:00+09:00" };
const f1 = await post(comboFirst);
const payAfter = { ...notif, title: `토스 ${MARK} 결제후착`, text: "출금 44,553원 합성상점C", bigText: "출금 44,553원 합성상점C 잔액 10,000원", receivedAt: "2027-01-15T11:06:00+09:00" };
const f2 = await post(payAfter);
const f1Row = f1.json.id ? (await admin.from("hh_transaction_inbox").select("status").eq("id", f1.json.id).single()).data : null;
const f2Row = f2.json.id ? (await admin.from("hh_transaction_inbox").select("status").eq("id", f2.json.id).single()).data : null;
ok(f1.status === 201 && f1Row?.status === "pending" && f2.status === 201 && f2Row?.status === "pending",
  `165 결합 선착 순서는 둘 다 pending(수용 잔여 고정) (결합=${f1Row?.status}, 결제=${f2Row?.status})`);

// 정리
for (const id of insertedIds) await admin.from("hh_transaction_inbox").delete().eq("id", id);
await admin.from("hh_ingest_token").delete().eq("id", tok.id);
const { count: leftTok } = await admin.from("hh_ingest_token").select("*", { count: "exact", head: true }).eq("label", MARK);
ok(leftTok === 0, `잔여 토큰 0건 (${leftTok})`);

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
