// 설계 200 실동작 검증 — 문자·알림을 **동시에** 쏴서 경쟁을 실제로 일으키고,
// 짝마다 pending 이 정확히 1건인지 본다. 사후 스윕이 실제로 발동했는지(`swept:true`)도 센다.
//
// 실행: BASE_URL=http://localhost:3100 npx tsx scripts/test_cross_sweep_live.mts
//   ★dev 서버가 필요해 `npm test` 체인 밖이다(test:sms-ingest 와 같은 성격).
//   ★임시 토큰·수집 행은 끝에 전부 지운다. 가맹점명·계좌 끝자리 모두 합성값이다(`__SWEEP_TEST__` · `*000000`).
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

for (const line of fs.readFileSync(path.resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] ??= m[2];
}
const BASE = process.env.BASE_URL || "http://localhost:3100";
const MARK = "__SWEEP_TEST__";
const PAIRS = 8;

// ★★운영 서버에 쏘지 못하게 막는다 — 이 스크립트는 실 DB 에 쓰고 지운다.
//   BASE_URL 이 env 로 열려 있어 운영 주소를 넣으면 그대로 라이브에 적재된다.
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(BASE)) {
  console.error(`❌ BASE_URL 이 로컬이 아니다(${BASE}). 이 스크립트는 dev 서버 전용이다 — 중단한다.`);
  process.exit(1);
}

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };

const { data: anyRow } = await admin.from("hh_category").select("owner_auth_uid").limit(1).single();
const owner = anyRow!.owner_auth_uid as string;

const rawToken = `${MARK}_${Math.random().toString(16).slice(2)}`;
const { data: tok, error: tErr } = await admin
  .from("hh_ingest_token")
  .insert({ owner_auth_uid: owner, token_hash: createHash("sha256").update(rawToken).digest("hex"), label: MARK })
  .select("id")
  .single();
if (tErr) { console.error("토큰 시드 실패:", tErr.message); process.exit(1); }

const inserted: string[] = [];
const post = async (path: string, body: Record<string, unknown>) => {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Ingest-Token": rawToken },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof json.id === "string") inserted.push(json.id);
  return json;
};

const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const mmdd = today.slice(5).replace("-", "/");

console.log(`엔드포인트=${BASE} · 짝 ${PAIRS}개를 동시에 발사\n`);

// ★본문에서 예외가 나도(dev 서버 미기동 등) **정리는 반드시 돈다** — 안 그러면 임시 토큰과
//   수집행이 실 DB 에 그대로 남는다.
let bodyErr: unknown = null;
try {

// ★16개 요청을 한꺼번에 쏜다 — 경쟁을 실제로 일으키려면 순차 발사로는 부족하다.
//   금액이 짝마다 달라 다른 짝끼리 섞이지 않는다(판정 기준이 금액+날짜라서).
const amountOf = (i: number) => 917000 + i;
const fired = await Promise.all(
  Array.from({ length: PAIRS }, (_, i) => {
    const won = amountOf(i).toLocaleString("en-US");
    const hhmm = `${String(9 + i).padStart(2, "0")}:1${i}`;
    // 같은 결제의 두 경로. 시각을 다르게 둬 설계 163(동일시각 → 휴지통)이 아니라
    // 설계 63/200(크로스소스) 경로를 타게 한다.
    return Promise.all([
      post("/api/household/inbox", {
        source: "toss", app: "토스",
        title: `${won}원 결제`, text: `우리체크 | ${MARK}${i}(일시불)`,
        receivedAt: Date.now(),
      }),
      post("/api/household/inbox/sms", {
        text: `[Web발신]\n우리 ${mmdd} ${hhmm}\n*000000\n출금 ${won}원\n${MARK}${i}\n잔액 1,234원`,
        sender: "1588-5000",
      }),
    ]);
  })
);

// ★판정은 응답 플래그가 아니라 **DB 의 실제 status** 로 한다.
//   사전조회(crossDup)로 duplicate 가 된 경우 응답에는 아무 표시도 없다(선재 동작) — 응답만 세면 거짓말이 된다.
let sweptCount = 0;
const results: { amount: number; pending: number; statuses: string[]; swept: boolean }[] = [];
for (let i = 0; i < PAIRS; i++) {
  const [notif, sms] = fired[i];
  const swept = notif.swept === true || sms.swept === true;
  if (swept) sweptCount++;
  // ★★`MARK` 로 반드시 좁힌다. 금액+owner 만으로 긁으면 **같은 금액의 실거래 수집행**이
  //   삭제 목록에 섞여 들어가고, 아래 정리에서 `delete()` 로 **영구 삭제**된다(상태 변경이 아니다).
  //   금액 917,000 대는 지금 실데이터에 없지만, 이 스크립트가 그걸 전제로 살면 안 된다.
  const { data: rows } = await admin
    .from("hh_transaction_inbox")
    .select("id,status,source")
    .eq("owner_auth_uid", owner)
    .eq("guessed_amount", amountOf(i))
    .ilike("raw_text", `%${MARK}%`);
  for (const r of rows ?? []) if (!inserted.includes(r.id)) inserted.push(r.id);
  const statuses = (rows ?? []).map((r) => `${r.source}=${r.status}`);
  const pending = (rows ?? []).filter((r) => r.status === "pending").length;
  results.push({ amount: amountOf(i), pending, statuses, swept });
  console.log(`  짝${i} ${amountOf(i).toLocaleString("en-US")}원 → ${statuses.join(" · ")} ${swept ? "(★사후 스윕이 처리)" : ""}`);
}

console.log("\n=== 판정 ===");
ok(results.every((r) => r.pending === 1), `모든 짝에서 pending 이 정확히 1건 (${results.map((r) => r.pending).join(",")})`);
ok(results.every((r) => r.statuses.length === 2), "짝마다 2건이 다 적재됐다(삭제가 아니라 상태 표시)");
ok(results.every((r) => r.statuses.some((s) => s.endsWith("=duplicate"))), "패자는 duplicate 다(휴지통 ignored 가 아니라 — 설계 63/200 경로를 탔다)");
console.log(`  · ★사후 스윕이 잡은 짝 ${sweptCount}개 / 사전조회가 잡은 짝 ${PAIRS - sweptCount}개`);
if (sweptCount === 0) console.log("  ※ 이번 실행에선 경쟁이 안 일어나 사전조회가 전부 잡았다(스윕 경로는 단위테스트가 덮는다).");

// 무관한 단건 수집이 스윕에 휩쓸리지 않는지 — 회귀 확인.
const solo = await post("/api/household/inbox/sms", {
  text: `[Web발신]\n우리 ${mmdd} 23:59\n*000000\n출금 918,999원\n${MARK}SOLO\n잔액 1,234원`,
  sender: "1588-5000",
});
ok(solo.duplicate !== true && typeof solo.id === "string", "짝 없는 단건은 그대로 pending 으로 남는다");

} catch (e) {
  bodyErr = e;
  console.error("❌ 본문 실행 중 예외 — 정리는 계속한다:", e instanceof Error ? e.message : e);
}

// ── 정리 ────────────────────────────────────────────────────────────────────
const { data: leftovers } = await admin.from("hh_transaction_inbox").select("id").eq("owner_auth_uid", owner).ilike("raw_text", `%${MARK}%`);
for (const r of leftovers ?? []) if (!inserted.includes(r.id)) inserted.push(r.id);

// ★★삭제 직전에 **원문이 MARK 를 포함하는 행만** 남긴다 — 이 목록에 실거래가 섞여 들어오는 경로가
//   하나라도 생기면(금액만 보고 긁는 등) `delete()` 는 되돌릴 수 없다. 마지막 관문을 하나 더 둔다.
const { data: mine } = await admin.from("hh_transaction_inbox").select("id").in("id", inserted).ilike("raw_text", `%${MARK}%`);
const deletable = (mine ?? []).map((r) => r.id);
const refused = inserted.filter((id) => !deletable.includes(id));
if (refused.length) console.error(`⚠️ MARK 가 없어 삭제하지 않은 id ${refused.length}건: ${refused.join(", ")}`);
ok(refused.length === 0, `삭제 목록이 전부 테스트 행이다 (제외 ${refused.length}건)`);

const { error: delErr } = deletable.length
  ? await admin.from("hh_transaction_inbox").delete().in("id", deletable)
  : { error: null };
const { error: tokErr } = await admin.from("hh_ingest_token").delete().eq("id", tok!.id);
ok(!delErr && !tokErr, `정리 완료 — 수집 행 ${deletable.length}건 + 임시 토큰 삭제 (${delErr?.message ?? tokErr?.message ?? "오류 없음"})`);
const { data: rest } = await admin.from("hh_transaction_inbox").select("id").ilike("raw_text", `%${MARK}%`);
ok((rest ?? []).length === 0, `테스트 흔적 0건 남음 (실제 ${(rest ?? []).length}건)`);

console.log(`\n${fail === 0 && !bodyErr ? "✅ 전부 통과" : `❌ ${fail}건 실패${bodyErr ? " + 본문 예외" : ""}`} (통과 ${pass})`);
process.exitCode = fail === 0 && !bodyErr ? 0 : 1;
