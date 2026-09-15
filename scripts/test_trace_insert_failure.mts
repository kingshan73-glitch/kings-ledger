// 설계 199 검증 — 휴지통 적재가 **실패했을 때** 그 사실이 위로 올라오는가.
//
// ★해피 패스만 검사하면 이 결함이 또 숨는다. 원래 결함이 바로 그거였다:
//   `insertTraceUnknown` 이 오류를 `return {}` 로 삼켜 호출부가 성공(201 `traced:true`)으로 답했고,
//   회귀 테스트는 `if (r.json.id)` 로 검증을 **건너뛰어** 초록이었다.
//
// 실행: npm run test:trace-fail   (DB 불필요 — 가짜 supabase 스텁)
const { insertTraceUnknown } = await import("../src/lib/household/sms-ingest");

let fail = 0;
const eq = (name: string, a: unknown, b: unknown) => {
  if (JSON.stringify(a) === JSON.stringify(b)) console.log(`  ✅ ${name}`);
  else {
    fail++;
    console.log(`  ❌ ${name} — 기대 ${JSON.stringify(b)}, 실제 ${JSON.stringify(a)}`);
  }
};

/** insert 결과만 정해 주는 최소 스텁. */
function stub(
  result: { data: unknown; error: { code?: string; message: string } | null },
  insertedRows?: unknown[],
) {
  const api: Record<string, unknown> = {
    insert: (row: unknown) => {
      insertedRows?.push(row);
      return api;
    },
    select: () => api,
    single: async () => result,
  };
  return { from: () => api } as never;
}

const OPTS = {
  source: "sms" as const,
  sourceAdapter: "1588-0000",
  rawText: "__TRACE_TEST__ 택배가 도착했습니다",
  date: "2026-09-03",
  time: null,
};

console.log("① 적재 성공 → id 를 돌려준다");
{
  const r = await insertTraceUnknown(stub({ data: { id: "row-1" }, error: null }), "owner-1", OPTS);
  eq("id 반환", r, { id: "row-1" });
}

console.log("\n② 같은 키가 이미 있으면(23505) 정상 — duplicate 로 답하고 실패가 아니다");
{
  const r = await insertTraceUnknown(stub({ data: null, error: { code: "23505", message: "duplicate key" } }), "owner-1", OPTS);
  eq("duplicate 반환", r, { duplicate: true });
  eq("failed 아님", (r as { failed?: boolean }).failed, undefined);
}

console.log("\n③ ★★그 밖의 오류는 삼키지 않고 failed 로 올린다 (설계 199 본체)");
{
  const r = (await insertTraceUnknown(
    stub({ data: null, error: { code: "42501", message: "permission denied for table" } }),
    "owner-1",
    OPTS
  )) as { failed?: boolean; error?: string; id?: string };
  eq("failed=true", r.failed, true);
  eq("오류 메시지를 싣는다", r.error, "permission denied for table");
  eq("★id 는 없다 — 호출부가 성공으로 오인할 수 없다", r.id, undefined);
}

console.log("\n④ ★빈 객체(옛 동작)를 돌려주지 않는다 — 그게 호출부를 속이던 값이다");
{
  const r = await insertTraceUnknown(stub({ data: null, error: { message: "네트워크 오류" } }), "owner-1", OPTS);
  eq("키가 있는 객체다", Object.keys(r as object).length > 0, true);
  eq("failed 로 식별된다", (r as { failed?: boolean }).failed, true);
}

console.log("\n⑤ guessedType 지정값과 생략 기본값을 삽입 행에 싣는다 (설계 205-B)");
{
  const paymentRows: unknown[] = [];
  await insertTraceUnknown(
    stub({ data: { id: "row-payment" }, error: null }, paymentRows),
    "owner-1",
    { ...OPTS, guessedType: "payment" },
  );
  eq("payment 지정", (paymentRows[0] as { guessed_type?: string }).guessed_type, "payment");

  const defaultRows: unknown[] = [];
  await insertTraceUnknown(stub({ data: { id: "row-default" }, error: null }, defaultRows), "owner-1", OPTS);
  eq("생략 시 expense", (defaultRows[0] as { guessed_type?: string }).guessed_type, "expense");
}

console.log(fail === 0 ? "\n✅ 전부 통과" : `\n❌ ${fail}건 실패`);
process.exitCode = fail === 0 ? 0 : 1;
