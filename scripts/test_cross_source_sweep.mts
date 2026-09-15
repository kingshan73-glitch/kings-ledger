// 설계 200·201 검증 — 크로스소스 이중수집 사후 스윕의 **판정 로직**.
//   ★핵심은 "누가 스윕하든 짝에서 정확히 1건만 살아남는다"이다.
//     ⓐ 둘 다 스윕해도 답이 같고(멱등) ⓑ 커밋 순서가 created_at 순서와 뒤집혀도 1건이 내려간다.
//
// ★설계 201 이후 이 파일이 검증하는 것은 **누구를 패자로 고르는가**까지다.
//   "승자가 살아 있을 때만 내린다"는 원자성은 SQL 함수(`hh_sweep_demote_losers`)가 보장하므로
//   스텁으로는 증명할 수 없다 — 그건 실 DB 테스트 `npm run test:sweep-rpc` 가 맡는다.
//
// 실행: npm run test:cross-sweep   (DB 불필요 — 가짜 supabase 스텁으로 순수 검증)
// ★가맹점·계좌는 합성값이다(이 검사는 파서가 아니라 승자 판정만 본다 — 실제 도메인 값이 필요 없다).
const { sweepCrossSourceDuplicateAfterInsert } = await import("../src/lib/household/sms-ingest");

let fail = 0;
const eq = (name: string, a: unknown, b: unknown) => {
  if (JSON.stringify(a) === JSON.stringify(b)) console.log(`  ✅ ${name}`);
  else {
    fail++;
    console.log(`  ❌ ${name} — 기대 ${JSON.stringify(b)}, 실제 ${JSON.stringify(a)}`);
  }
};

type Row = Record<string, unknown>;
type Err = { message: string } | null;
type RpcCall = { winner: string; losers: string[]; owner: string; self: string };

/**
 * hh_transaction_inbox 조회 + `hh_sweep_demote_losers` RPC 만 흉내 내는 스텁.
 * RPC 는 **SQL 함수와 같은 규칙**으로 답한다(승자가 pending·confirmed 일 때만, 패자는 pending 만).
 * 그래야 "TS 가 SQL 에 무엇을 넘기는가"를 실제 결과로 검증할 수 있다.
 */
function stub(rows: Row[], fails: { candSelect?: string; rpc?: string; afterCandSelect?: () => void } = {}) {
  const rpcCalls: RpcCall[] = [];
  const from = (table: string) => {
    if (table !== "hh_transaction_inbox") throw new Error(`예상 밖 테이블: ${table}`);
    let cur = rows.slice();
    const api: Record<string, unknown> = {
      select: () => api,
      eq: (col: string, val: unknown) => {
        cur = cur.filter((r) => r[col] === val);
        return api;
      },
      // ★실 PostgREST 의 neq 는 SQL <> 라 NULL 행을 통과시키지 않는다 — 스텁도 같게 한다.
      neq: (col: string, val: unknown) => {
        cur = cur.filter((r) => r[col] != null && r[col] !== val);
        return api;
      },
      in: (col: string, vals: unknown[]) => {
        cur = cur.filter((r) => vals.includes(r[col]));
        return api;
      },
      then: (resolve: (v: { data: unknown; error: Err }) => unknown) => {
        if (fails.candSelect) return resolve({ data: null, error: { message: fails.candSelect } });
        // ★결과를 **먼저 복사**한 뒤 훅을 부른다 — 조회는 옛 상태를 봤고 그 직후 남이 바꾼 상황을 재현한다.
        const snapshot = cur.map((r) => ({ ...r }));
        fails.afterCandSelect?.();
        return resolve({ data: snapshot, error: null });
      },
    };
    return api;
  };
  const rpc = async (name: string, args: Record<string, unknown>) => {
    if (name !== "hh_sweep_demote_losers") throw new Error(`예상 밖 RPC: ${name}`);
    const winner = args.p_winner_id as string;
    const losers = args.p_loser_ids as string[];
    const selfId = args.p_self_id as string;
    rpcCalls.push({ winner, losers, owner: args.p_owner as string, self: selfId });
    if (fails.rpc) return { data: null, error: { message: fails.rpc } };
    const w = rows.find((r) => r.id === winner);
    // SQL 과 같은 규칙: 승자가 없거나 죽었으면 아무도 안 내린다.
    if (!w || (w.status !== "pending" && w.status !== "confirmed")) return { data: [], error: null };
    // SQL 과 같은 규칙: 스윕을 촉발한 자기가 pending 이 아니면 아무것도 안 한다.
    const me = rows.find((r) => r.id === selfId);
    if (!me || me.status !== "pending") return { data: [], error: null };
    const done: string[] = [];
    for (const id of losers) {
      const r = rows.find((x) => x.id === id);
      if (!r || r.id === winner || r.status !== "pending") continue;
      r.status = "duplicate";
      done.push(id);
    }
    return { data: done, error: null };
  };
  return { sb: { from, rpc } as never, rpcCalls };
}

const OWNER = "owner-1";
const DATE = "2026-09-03";
const AMT = 25000;
const OUT = { type: "expense", merchant: "가게A", accountId: "acc-1", fromAccountId: null, toAccountId: null };

/** 같은 결제가 두 경로로 들어온 짝. 알림이 먼저 시작(created_at 이름), 문자가 나중. */
const pair = (): Row[] => [
  {
    id: "id-notif", source: "notification", status: "pending", created_at: "2026-09-03T03:26:01.100Z",
    guessed_type: "expense", guessed_merchant: "가게A", guessed_account_id: "acc-1",
    guessed_from_account_id: null, guessed_to_account_id: null,
    guessed_date: DATE, guessed_amount: AMT, owner_auth_uid: OWNER,
  },
  {
    id: "id-sms", source: "sms", status: "pending", created_at: "2026-09-03T03:26:01.200Z",
    guessed_type: "expense", guessed_merchant: "가게A", guessed_account_id: "acc-1",
    guessed_from_account_id: null, guessed_to_account_id: null,
    guessed_date: DATE, guessed_amount: AMT, owner_auth_uid: OWNER,
  },
];
const statusOf = (rows: Row[], id: string) => rows.find((r) => r.id === id)!.status;
const selfOf = (rows: Row[], id: string) => {
  const r = rows.find((x) => x.id === id)!;
  return { id, source: r.source as string, createdAt: r.created_at as string };
};

console.log("① 경쟁 없음 — 후보가 없으면 RPC 를 부르지도 않는다");
{
  const rows = [pair()[0]];
  const { sb, rpcCalls } = stub(rows);
  const res = await sweepCrossSourceDuplicateAfterInsert(sb, OWNER, selfOf(rows, "id-notif"), DATE, AMT, OUT);
  eq("내려간 것 없음", res, { demotedSelf: false, demoted: [] });
  eq("RPC 호출 0회", rpcCalls.length, 0);
}

console.log("\n② 나중에 시작한 문자가 스윕 — 자기가 패자다");
{
  const rows = pair();
  const { sb, rpcCalls } = stub(rows);
  const res = await sweepCrossSourceDuplicateAfterInsert(sb, OWNER, selfOf(rows, "id-sms"), DATE, AMT, OUT);
  eq("자기를 내렸다", res.demotedSelf, true);
  eq("RPC 인자 = 승자 알림 · 패자 문자", { w: rpcCalls[0].winner, l: rpcCalls[0].losers }, { w: "id-notif", l: ["id-sms"] });
  eq("owner 를 넘긴다", rpcCalls[0].owner, OWNER);
  eq("알림은 pending 유지", statusOf(rows, "id-notif"), "pending");
  eq("문자는 duplicate", statusOf(rows, "id-sms"), "duplicate");
}

console.log("\n③ ★커밋 순서가 뒤집힌 경우 — 먼저 시작한 알림이 나중에 커밋해 스윕해도 1건이 내려간다");
// created_at 은 트랜잭션 '시작' 시각이라 커밋 순서와 다를 수 있다. "내가 늦으면 나를 내린다"로 하면
// 승자인 알림이 아무것도 안 해 **둘 다 살아남는다** — 그래서 스위퍼는 '짝의 패자'를 내린다.
{
  const rows = pair();
  const { sb } = stub(rows);
  const res = await sweepCrossSourceDuplicateAfterInsert(sb, OWNER, selfOf(rows, "id-notif"), DATE, AMT, OUT);
  eq("자기는 안 내려갔다", res.demotedSelf, false);
  eq("상대(문자)를 내렸다", res.demoted, ["id-sms"]);
  eq("정확히 1건만 pending", rows.filter((r) => r.status === "pending").length, 1);
}

console.log("\n④ ★둘 다 스윕해도 2건 모두 소실되지 않는다 (멱등)");
{
  const rows = pair();
  const { sb } = stub(rows);
  await sweepCrossSourceDuplicateAfterInsert(sb, OWNER, selfOf(rows, "id-notif"), DATE, AMT, OUT);
  await sweepCrossSourceDuplicateAfterInsert(sb, OWNER, selfOf(rows, "id-sms"), DATE, AMT, OUT);
  eq("승자(알림)는 살아 있다", statusOf(rows, "id-notif"), "pending");
  eq("패자(문자)만 duplicate", statusOf(rows, "id-sms"), "duplicate");
  eq("pending 정확히 1건", rows.filter((r) => r.status === "pending").length, 1);
}

console.log("\n⑤ 상대가 이미 확정(confirmed)이면 확정이 승자 — created_at 이 늦어도 이긴다");
{
  const rows = pair();
  rows[0].status = "confirmed";
  rows[0].created_at = "2026-09-03T03:26:09.999Z";
  const { sb } = stub(rows);
  const res = await sweepCrossSourceDuplicateAfterInsert(sb, OWNER, selfOf(rows, "id-sms"), DATE, AMT, OUT);
  eq("자기를 내렸다", res.demotedSelf, true);
  eq("확정 행은 그대로", statusOf(rows, "id-notif"), "confirmed");
}

console.log("\n⑥ 확정이 2건이면 아무것도 안 한다 (사람이 볼 일)");
{
  const rows = pair();
  rows[0].status = "confirmed";
  rows[1] = { ...rows[0], id: "id-notif2", created_at: "2026-09-03T03:26:01.150Z" };
  rows.push({ ...pair()[1], id: "id-sms2", created_at: "2026-09-03T03:26:01.300Z" });
  const { sb, rpcCalls } = stub(rows);
  const res = await sweepCrossSourceDuplicateAfterInsert(sb, OWNER, selfOf(rows, "id-sms2"), DATE, AMT, OUT);
  eq("내려간 것 없음", res.demoted, []);
  eq("RPC 호출 0회", rpcCalls.length, 0);
}

console.log("\n⑦ 금액이 없으면 판정하지 않는다 (설계 63 오탐 방지)");
{
  const rows = pair();
  const { sb, rpcCalls } = stub(rows);
  const res = await sweepCrossSourceDuplicateAfterInsert(sb, OWNER, selfOf(rows, "id-sms"), DATE, null, OUT);
  eq("내려간 것 없음", res, { demotedSelf: false, demoted: [] });
  eq("RPC 호출 0회", rpcCalls.length, 0);
}

console.log("\n⑧ 같은 소스끼리는 짝이 아니다 (크로스소스 판정)");
{
  const rows = pair();
  rows[0].source = "sms";
  const { sb, rpcCalls } = stub(rows);
  const res = await sweepCrossSourceDuplicateAfterInsert(sb, OWNER, selfOf(rows, "id-sms"), DATE, AMT, OUT);
  eq("내려간 것 없음", res.demoted, []);
  eq("RPC 호출 0회", rpcCalls.length, 0);
}

console.log("\n⑨ 방향이 다르면(수입 vs 지출) 짝이 아니다 (설계 107 보존)");
{
  const rows = pair();
  rows[0].guessed_type = "income";
  const { sb } = stub(rows);
  const res = await sweepCrossSourceDuplicateAfterInsert(sb, OWNER, selfOf(rows, "id-sms"), DATE, AMT, OUT);
  eq("내려간 것 없음", res.demoted, []);
}

console.log("\n⑩ 끝점이 안 겹치는 '다른 이체'는 짝이 아니다 (설계 63 보강 보존)");
{
  const rows = pair();
  for (const r of rows) {
    r.guessed_type = "transfer";
    r.guessed_account_id = null;
  }
  rows[0].guessed_from_account_id = "acc-9";
  rows[0].guessed_to_account_id = "acc-8";
  rows[1].guessed_from_account_id = "acc-1";
  rows[1].guessed_to_account_id = "acc-2";
  const { sb } = stub(rows);
  const res = await sweepCrossSourceDuplicateAfterInsert(sb, OWNER, selfOf(rows, "id-sms"), DATE, AMT, {
    type: "transfer", merchant: null, accountId: null, fromAccountId: "acc-1", toAccountId: "acc-2",
  });
  eq("내려간 것 없음", res.demoted, []);
}

console.log("\n⑪ 수기입력(manual) 은 근거 없으면 짝이 아니다 (설계 107 보존)");
{
  const rows = pair();
  rows[0].source = "manual";
  rows[0].guessed_merchant = "전혀다른상호";
  rows[0].guessed_account_id = "acc-9";
  const { sb } = stub(rows);
  const res = await sweepCrossSourceDuplicateAfterInsert(sb, OWNER, selfOf(rows, "id-sms"), DATE, AMT, OUT);
  eq("내려간 것 없음", res.demoted, []);
}

console.log("\n⑫ ★★수기입력은 승자는 되어도 **패자로는 안 내린다** (설계 200 배포 전 리뷰 M2)");
{
  // 사전조회(설계 63)는 늘 '들어온 행'만 내렸다. 스윕은 무리를 돌며 **기존 행**도 내리므로,
  // 팀장님이 손으로 넣은 행이 사전조회~스윕 사이에 커밋되면 그게 내려갈 수 있었다.
  const rows = pair();
  rows[1].created_at = "2026-09-03T03:26:01.000Z"; // self(문자)가 승자
  rows[0] = { ...rows[0], id: "id-manual", source: "manual", created_at: "2026-09-03T03:26:01.500Z" };
  const { sb, rpcCalls } = stub(rows);
  const res = await sweepCrossSourceDuplicateAfterInsert(sb, OWNER, selfOf(rows, "id-sms"), DATE, AMT, OUT);
  eq("내려간 것 없음", res.demoted, []);
  eq("★RPC 를 아예 안 부른다(패자 목록이 비었다)", rpcCalls.length, 0);
  eq("수기입력은 pending 그대로", statusOf(rows, "id-manual"), "pending");
}

console.log("\n⑬ 수기입력이 **승자**면 상대는 정상적으로 내려간다");
{
  const rows = pair();
  rows[0] = { ...rows[0], id: "id-manual", source: "manual", created_at: "2026-09-03T03:26:01.000Z" };
  const { sb } = stub(rows);
  const res = await sweepCrossSourceDuplicateAfterInsert(sb, OWNER, selfOf(rows, "id-sms"), DATE, AMT, OUT);
  eq("자기가 내려갔다", res.demotedSelf, true);
  eq("수기입력은 pending 유지", statusOf(rows, "id-manual"), "pending");
}

console.log("\n⑭ ★후보 조회가 실패하면 아무도 안 내린다 (fail-safe — 안 보이게 하느니 남긴다)");
{
  const rows = pair();
  const { sb, rpcCalls } = stub(rows, { candSelect: "stub: 주입된 후보 조회 실패" });
  const res = await sweepCrossSourceDuplicateAfterInsert(sb, OWNER, selfOf(rows, "id-sms"), DATE, AMT, OUT);
  eq("내려간 것 없음", res.demoted, []);
  eq("RPC 호출 0회", rpcCalls.length, 0);
  eq("두 건 다 pending 으로 남는다(= 이 변경 전 동작)", rows.filter((r) => r.status === "pending").length, 2);
}

console.log("\n⑮ ★RPC 가 실패하면 내렸다고 보고하지 않는다 (종전보다 나빠지지 않는다)");
{
  const rows = pair();
  const { sb } = stub(rows, { rpc: "stub: 주입된 RPC 실패" });
  const res = await sweepCrossSourceDuplicateAfterInsert(sb, OWNER, selfOf(rows, "id-sms"), DATE, AMT, OUT);
  eq("demotedSelf=false", res.demotedSelf, false);
  eq("내려간 것 없음", res.demoted, []);
  eq("두 건 다 pending", rows.filter((r) => r.status === "pending").length, 2);
}

console.log("\n⑯ ★★승자가 그 사이 휴지통이 되면 RPC 가 0건을 돌려준다 — 설계 200 의 「남은 창」이 닫혔다");
{
  // 설계 200 에서는 이 상황이 '승자=ignored · 패자=duplicate'(pending 대표 0건)로 끝났다.
  // 설계 201 은 승자를 잠그고 같은 트랜잭션에서 내리므로, 승자가 죽었으면 **패자도 안 내려간다.**
  // 재현: 후보 조회는 승자를 pending 으로 봤고, **그 직후** 사람이 휴지통으로 옮겼다.
  const rows = pair();
  const { sb, rpcCalls } = stub(rows, {
    afterCandSelect: () => {
      rows[0].status = "ignored";
    },
  });
  const res = await sweepCrossSourceDuplicateAfterInsert(sb, OWNER, selfOf(rows, "id-sms"), DATE, AMT, OUT);
  eq("RPC 는 불렀다(승자를 살아 있다고 믿고)", rpcCalls.length, 1);
  eq("내려간 것 없음", res.demoted, []);
  eq("★pending 대표가 남아 있다", statusOf(rows, "id-sms"), "pending");
}

console.log("\n⑰ RPC 가 일부만 돌려주면 그대로 보고한다 (그 사이 사람이 확정한 행은 안 내려간다)");
{
  const rows = pair();
  rows.push({ ...pair()[0], id: "id-notif3", created_at: "2026-09-03T03:26:01.300Z", status: "confirmed" });
  // 위 행이 confirmed 라 승자가 되고, 나머지 pending 2건이 패자 후보가 된다.
  rows[0].status = "pending";
  const { sb, rpcCalls } = stub(rows);
  const res = await sweepCrossSourceDuplicateAfterInsert(sb, OWNER, selfOf(rows, "id-sms"), DATE, AMT, OUT);
  eq("승자는 확정 행", rpcCalls[0].winner, "id-notif3");
  eq("패자 2건을 넘겼다", rpcCalls[0].losers.sort(), ["id-notif", "id-sms"]);
  eq("둘 다 내려갔다", res.demoted.sort(), ["id-notif", "id-sms"]);
  eq("확정 행은 그대로", statusOf(rows, "id-notif3"), "confirmed");
}

console.log(fail === 0 ? "\n✅ 전부 통과" : `\n❌ ${fail}건 실패`);
process.exitCode = fail === 0 ? 0 : 1;
