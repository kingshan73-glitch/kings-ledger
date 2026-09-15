// 설계 201 검증 — SQL 함수 `hh_sweep_demote_losers` 의 **원자성과 조건**을 실 DB 로 확인한다.
//
// ★스텁으로는 증명할 수 없는 것만 여기서 본다: 승자를 `for update` 로 잠근 뒤 같은 트랜잭션에서
//   패자를 내리는가, 그리고 승자·패자의 상태 조건이 실제로 걸리는가.
//   판정 로직(누가 짝이고 누가 승자인가)은 `npm run test:cross-sweep` 이 맡는다.
//
// 실행: npm run test:sweep-rpc   (실 DB 필요. 합성 행을 만들고 끝에 전부 지운다)
// ★가맹점·원문은 합성값(`__RPC_TEST__`)이고, 만든 행만 id 로 지운다.
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";

for (const line of fs.readFileSync(path.resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] ??= m[2];
}
const MARK = "__RPC_TEST__";
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };

const { data: anyRow, error: ownErr } = await admin.from("hh_category").select("owner_auth_uid").limit(1).single();
if (ownErr) throw new Error(`owner 조회 실패: ${ownErr.message}`);
const owner = anyRow!.owner_auth_uid as string;

const made: string[] = [];
let seq = 0;
/** 합성 수집행 하나. 금액은 실데이터와 겹치지 않게 매번 다르게 준다(어차피 id 로만 지운다). */
async function mkRow(status: string, source: string, amount: number) {
  seq += 1;
  const { data, error } = await admin
    .from("hh_transaction_inbox")
    .insert({
      owner_auth_uid: owner, source, status,
      raw_text: `${MARK} ${seq}`, dedup_hash: `${MARK}|${Date.now()}|${seq}|${Math.random()}`,
      guessed_date: "2026-09-03", guessed_amount: amount, guessed_merchant: `${MARK}${seq}`, guessed_type: "expense",
    })
    .select("id")
    .single();
  if (error) throw new Error(`행 생성 실패: ${error.message}`);
  made.push(data!.id as string);
  return data!.id as string;
}
const statusOf = async (id: string) => {
  const { data, error } = await admin.from("hh_transaction_inbox").select("status").eq("id", id).single();
  if (error) throw new Error(`상태 조회 실패: ${error.message}`);
  return data!.status as string;
};
const call = async (winner: string, losers: string[], opts: { owner?: string; self?: string | null } = {}) => {
  const { data, error } = await admin.rpc("hh_sweep_demote_losers", {
    p_owner: opts.owner ?? owner,
    p_self_id: opts.self === undefined ? losers[0] ?? winner : opts.self,
    p_winner_id: winner,
    p_loser_ids: losers,
  });
  if (error) throw new Error(`RPC 실패: ${error.message}`);
  return (data ?? []) as string[];
};

let bodyErr: unknown = null;
try {
  console.log("① 승자가 pending 이면 패자를 내린다");
  {
    const w = await mkRow("pending", "notification", 811001);
    const l = await mkRow("pending", "sms", 811001);
    const got = await call(w, [l]);
    ok(JSON.stringify(got) === JSON.stringify([l]), `내려간 id 를 돌려준다 (${got.length}건)`);
    ok((await statusOf(l)) === "duplicate", "패자 = duplicate");
    ok((await statusOf(w)) === "pending", "승자 = pending 그대로");
  }

  console.log("\n② 승자가 confirmed 여도 내린다 (이미 장부에 들어간 쪽이 이긴다)");
  {
    const w = await mkRow("confirmed", "notification", 811002);
    const l = await mkRow("pending", "sms", 811002);
    ok((await call(w, [l])).length === 1, "1건 내려감");
    ok((await statusOf(l)) === "duplicate", "패자 = duplicate");
  }

  console.log("\n③ ★★승자가 죽어 있으면(휴지통) 패자를 내리지 않는다 — 설계 200 「남은 창」이 닫힌 지점");
  {
    const w = await mkRow("ignored", "notification", 811003);
    const l = await mkRow("pending", "sms", 811003);
    const got = await call(w, [l]);
    ok(got.length === 0, "0건 반환");
    ok((await statusOf(l)) === "pending", "★패자가 pending 으로 남는다(대표가 사라지지 않는다)");
  }

  console.log("\n④ 승자가 duplicate 여도 내리지 않는다");
  {
    const w = await mkRow("duplicate", "notification", 811004);
    const l = await mkRow("pending", "sms", 811004);
    ok((await call(w, [l])).length === 0, "0건 반환");
    ok((await statusOf(l)) === "pending", "패자 그대로");
  }

  console.log("\n⑤ 패자가 pending 이 아니면 건드리지 않는다 (확정·휴지통 보호)");
  {
    const w = await mkRow("pending", "notification", 811005);
    const c = await mkRow("confirmed", "sms", 811005);
    const g = await mkRow("ignored", "sms", 811005);
    const got = await call(w, [c, g]);
    ok(got.length === 0, "0건 반환");
    ok((await statusOf(c)) === "confirmed" && (await statusOf(g)) === "ignored", "확정·휴지통 그대로");
  }

  console.log("\n⑥ 승자가 패자 목록에 섞여 들어와도 자기를 안 내린다");
  {
    const w = await mkRow("pending", "notification", 811006);
    const l = await mkRow("pending", "sms", 811006);
    const got = await call(w, [w, l]);
    ok(JSON.stringify(got) === JSON.stringify([l]), "승자는 제외하고 패자만");
    ok((await statusOf(w)) === "pending", "승자 = pending 그대로");
  }

  console.log("\n⑦ ★남의 owner 로는 아무것도 못 내린다");
  {
    const w = await mkRow("pending", "notification", 811007);
    const l = await mkRow("pending", "sms", 811007);
    const other = "00000000-0000-0000-0000-000000000000";
    ok((await call(w, [l], { owner: other })).length === 0, "0건 반환");
    ok((await statusOf(l)) === "pending", "패자 그대로");
  }

  console.log("\n⑧ 없는 승자 id · 빈 패자 목록은 조용히 0건");
  {
    const l = await mkRow("pending", "sms", 811008);
    ok((await call("00000000-0000-0000-0000-000000000001", [l])).length === 0, "없는 승자 → 0건");
    ok((await statusOf(l)) === "pending", "패자 그대로");
    const w = await mkRow("pending", "notification", 811008);
    ok((await call(w, [])).length === 0, "빈 목록 → 0건");
  }

  console.log("\n⑨ 여러 패자를 한 번에, 멱등하게");
  {
    const w = await mkRow("pending", "notification", 811009);
    const a = await mkRow("pending", "sms", 811009);
    const b = await mkRow("pending", "manual", 811009);
    ok((await call(w, [a, b])).length === 2, "2건 내려감");
    ok((await call(w, [a, b])).length === 0, "두 번째 호출은 0건 (이미 duplicate 라 조건에 안 걸린다)");
    ok((await statusOf(w)) === "pending", "승자 그대로");
  }
  console.log("\n⑩ ★★스윕을 촉발한 자기(p_self_id)가 pending 이 아니면 아무도 안 내린다 (배포 전 리뷰 — 양쪽 지적)");
  {
    // 3건 무리: 자기(휴지통) · 승자 A(pending) · B(pending).
    // 이 검사가 없으면 "휴지통에 있는 내가 방아쇠가 되어 남의 행 B 를 내리는" 동작이 조용히 산다.
    const me = await mkRow("ignored", "sms", 811010);
    const a = await mkRow("pending", "notification", 811010);
    const b = await mkRow("pending", "notification", 811010);
    const got = await call(a, [me, b], { self: me });
    ok(got.length === 0, "0건 반환");
    ok((await statusOf(b)) === "pending", "★남의 행 B 를 안 건드린다");
    ok((await statusOf(a)) === "pending", "승자 A 그대로");
  }

  console.log("\n⑪ 자기가 pending 이면 정상 동작한다 (⑩의 대조군)");
  {
    const me = await mkRow("pending", "sms", 811011);
    const a = await mkRow("pending", "notification", 811011);
    const got = await call(a, [me], { self: me });
    ok(got.length === 1, "1건 내려감");
    ok((await statusOf(me)) === "duplicate", "자기가 duplicate");
  }

  console.log("\n⑫ ★★진짜 동시성 — RPC 와 '승자를 휴지통으로' 를 동시에 발사");
  {
    // ★이 검사가 처음엔 "대표가 절대 0건이 되지 않는다"를 주장했다가 **실패했다**(20회 중 9회).
    //   그게 맞다 — 우리가 패자를 내린 **뒤** 사람이 승자를 휴지통에 넣으면 대표는 0건이 된다.
    //   그건 경쟁이 아니라 **사람이 살아남은 행을 버린 것**이고, 설계 63 이후 늘 있던 정상 동작이다
    //   (오늘도 사전조회가 문자를 duplicate 로 내린 뒤 알림을 버리면 똑같다).
    //   ★잘못된 주장을 검사가 잡았다 — 설계 201 문서의 "어떤 순서로 겹쳐도 대표가 0건이 되는 경로가
    //   없다"는 **과장이었고 고쳤다.**
    //
    // RPC 가 실제로 보장하는 것은 이것이다: **낡은 승자 정보로는 절대 강등하지 않는다.**
    //   그래서 여기서는 ⓐ반환값이 DB 실상태와 정확히 일치하는가(부분쓰기·유실 없음)
    //   ⓑ최종 상태가 두 정상 직렬화 중 하나인가 만 본다.
    const ROUNDS = 20;
    let mismatch = 0;
    let sweptFirst = 0;
    let illegal = 0;
    for (let i = 0; i < ROUNDS; i++) {
      const w = await mkRow("pending", "notification", 812000 + i);
      const l = await mkRow("pending", "sms", 812000 + i);
      const [got] = await Promise.all([
        call(w, [l], { self: l }),
        admin.from("hh_transaction_inbox").update({ status: "ignored" }).eq("id", w).eq("status", "pending"),
      ]);
      const [ws, ls] = [await statusOf(w), await statusOf(l)];
      // ⓐ 반환값과 실상태가 어긋나면 부분쓰기다.
      const saysDemoted = got.includes(l);
      if (saysDemoted !== (ls === "duplicate")) mismatch++;
      if (saysDemoted) sweptFirst++;
      // ⓑ 정상 직렬화는 둘뿐: 스윕이 먼저(승자 ignored·패자 duplicate) / 휴지통이 먼저(승자 ignored·패자 pending).
      const legal = ws === "ignored" && (ls === "duplicate" || ls === "pending");
      if (!legal) illegal++;
    }
    ok(mismatch === 0, `★반환값이 DB 실상태와 어긋난 경우 ${mismatch}건 (부분쓰기 없음)`);
    ok(illegal === 0, `★최종 상태가 정상 직렬화 밖인 경우 ${illegal}건`);
    console.log(`  · 스윕이 먼저 이긴 ${sweptFirst}회 / 휴지통이 먼저 이긴 ${ROUNDS - sweptFirst}회`);
    console.log(`  ※ 스윕이 먼저 이긴 경우는 '승자 ignored + 패자 duplicate' 가 된다 —`);
    console.log(`     사람이 살아남은 행을 버린 것이라 정상이다(설계 63 이후 동일). 두 행 다 탭에 남는다.`);
  }
  console.log("\n⑬ ★★TS 스윕 함수 → RPC → 실 DB 전 구간 (반환형 마샬링 포함)");
  {
    // ★라이브 웹훅 테스트(test:cross-sweep-live)는 **경쟁이 실제로 나야** 이 경로를 탄다 —
    //   서버가 데워지면 사전조회가 다 잡아서 몇 번을 돌려도 안 탈 수 있다(실측: 5회 연속 0건).
    //   그래서 여기서 스윕 함수를 실 DB 에 대고 직접 부른다. `returns uuid[]` 가 PostgREST 를 거쳐
    //   supabase-js 에 `string[]` 로 오는지는 **오직 이 경로에서만** 드러난다(스텁은 못 본다).
    const { sweepCrossSourceDuplicateAfterInsert } = await import("../src/lib/household/sms-ingest");
    const notif = await mkRow("pending", "notification", 813001);
    const sms = await mkRow("pending", "sms", 813001);
    const rows = await admin.from("hh_transaction_inbox").select("id,created_at").in("id", [notif, sms]);
    const createdAt = (rows.data ?? []).find((r) => r.id === sms)?.created_at as string;

    const res = await sweepCrossSourceDuplicateAfterInsert(
      admin,
      owner,
      { id: sms, source: "sms", createdAt },
      "2026-09-03",
      813001,
      { type: "expense", merchant: `${MARK}`, accountId: null, fromAccountId: null, toAccountId: null }
    );
    ok(Array.isArray(res.demoted), "★demoted 가 배열로 온다(uuid[] → string[] 마샬링)");
    ok(res.demoted.length === 1 && res.demoted[0] === sms, `자기(문자)를 내렸다고 보고 (${res.demoted.length}건)`);
    ok(res.demotedSelf === true, "demotedSelf=true");
    ok((await statusOf(sms)) === "duplicate", "★DB 도 duplicate — 보고와 실상태가 일치");
    ok((await statusOf(notif)) === "pending", "승자(알림)는 pending 유지");
  }
} catch (e) {
  bodyErr = e;
  console.error("❌ 본문 예외 — 정리는 계속한다:", e instanceof Error ? e.message : e);
}

// ── 정리: 내가 만든 id 만 지운다 ─────────────────────────────────────────────
if (made.length) {
  const { data: mine, error: chkErr } = await admin.from("hh_transaction_inbox").select("id").in("id", made).ilike("raw_text", `%${MARK}%`);
  if (chkErr) console.error("정리 전 확인 실패:", chkErr.message);
  const deletable = (mine ?? []).map((r) => r.id);
  ok(deletable.length === made.length, `삭제 목록이 전부 테스트 행이다 (${deletable.length}/${made.length})`);
  const { error: delErr } = await admin.from("hh_transaction_inbox").delete().in("id", deletable);
  ok(!delErr, `정리 완료 — ${deletable.length}건 (${delErr?.message ?? "오류 없음"})`);
}
const { data: rest } = await admin.from("hh_transaction_inbox").select("id").ilike("raw_text", `%${MARK}%`);
ok((rest ?? []).length === 0, `테스트 흔적 0건 남음 (실제 ${(rest ?? []).length}건)`);

console.log(`\n${fail === 0 && !bodyErr ? "✅ 전부 통과" : `❌ ${fail}건 실패${bodyErr ? " + 본문 예외" : ""}`} (통과 ${pass})`);
process.exitCode = fail === 0 && !bodyErr ? 0 : 1;
