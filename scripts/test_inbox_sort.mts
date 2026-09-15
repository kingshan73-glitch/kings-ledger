// 설계 152 — 수집함 화면 정렬 회귀 테스트(순수 로직, 라이브 DB 불필요).
// `npm test` 체인에 넣는다. 정렬 규칙을 건드리면 이걸 돌려라.
type Row = { id: string; collected_at: string; guessed_date: string | null; guessed_time: string | null; label: string };

// ★page.tsx 의 inboxSortKey 와 **같은 식**이어야 한다. 바뀌면 여기도 같이 고칠 것.
function sortKey(r: Row): string {
  const date = r.guessed_date ?? "0000-00-00";
  const kstHm = new Date(new Date(r.collected_at).getTime() + 9 * 3600 * 1000).toISOString().slice(11, 16);
  const time = r.guessed_time ?? kstHm;
  return `${date} ${time} ${r.collected_at} ${r.id}`;
}
const order = (rows: Row[]) => [...rows].sort((a, b) => sortKey(b).localeCompare(sortKey(a))).map((r) => r.label);

let pass = 0;
let fail = 0;
const ok = (c: boolean, m: string) => {
  if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); }
};
const eq = (got: string[], want: string[], m: string) =>
  ok(JSON.stringify(got) === JSON.stringify(want), `${m}\n      got  ${got.join(" > ")}\n      want ${want.join(" > ")}`);

console.log("[1] 거래일 내림차순 — 늦게 수집된 어제 거래가 위로 올라오지 않는다");
eq(
  order([
    // 08-05 거래인데 08-06 02:27 KST 에 수집됨(실사례: 토스이자)
    { id: "a", collected_at: "2026-08-05T17:27:00Z", guessed_date: "2026-08-05", guessed_time: null, label: "토스이자(8/5거래)" },
    { id: "b", collected_at: "2026-08-06T01:00:00Z", guessed_date: "2026-08-06", guessed_time: "10:00", label: "8/6거래" },
  ]),
  ["8/6거래", "토스이자(8/5거래)"],
  "거래일이 늦은 쪽이 위",
);

console.log("\n[2] ★같은 결제의 두 경로(은행SMS+카드앱)가 붙어 있는다 — 시각 없는 쪽을 뒤로 몰지 않는다");
const pair = order([
  { id: "s", collected_at: "2026-08-05T12:04:00Z", guessed_date: "2026-08-05", guessed_time: "21:04", label: "OK할인마트(은행SMS)" },
  { id: "n", collected_at: "2026-08-05T12:04:00Z", guessed_date: "2026-08-05", guessed_time: null, label: "OK할인마트(카드앱)" },
  { id: "x", collected_at: "2026-08-05T04:05:00Z", guessed_date: "2026-08-05", guessed_time: "13:05", label: "씨스페이스(13:05)" },
]);
ok(Math.abs(pair.indexOf("OK할인마트(은행SMS)") - pair.indexOf("OK할인마트(카드앱)")) === 1, `짝이 인접: ${pair.join(" > ")}`);
ok(pair[2] === "씨스페이스(13:05)", "더 이른 거래가 아래");

console.log("\n[3] 같은 날 시각 내림차순");
eq(
  order([
    { id: "1", collected_at: "2026-08-05T01:00:00Z", guessed_date: "2026-08-05", guessed_time: "10:45", label: "10:45" },
    { id: "2", collected_at: "2026-08-05T01:00:00Z", guessed_date: "2026-08-05", guessed_time: "21:04", label: "21:04" },
    { id: "3", collected_at: "2026-08-05T01:00:00Z", guessed_date: "2026-08-05", guessed_time: "13:05", label: "13:05" },
  ]),
  ["21:04", "13:05", "10:45"],
  "21:04 > 13:05 > 10:45",
);

console.log("\n[4] 오파싱된 옛 날짜는 아래로 가라앉는다(중간에 끼어 목록을 끊지 않는다)");
const withBad = order([
  { id: "1", collected_at: "2026-08-05T05:31:00Z", guessed_date: "2025-08-06", guessed_time: null, label: "오파싱(2025년)" },
  { id: "2", collected_at: "2026-08-05T04:00:00Z", guessed_date: "2026-08-05", guessed_time: "13:00", label: "정상(8/5)" },
]);
ok(withBad[withBad.length - 1] === "오파싱(2025년)", `맨 아래로: ${withBad.join(" > ")}`);

console.log("\n[5] 순서가 흔들리지 않는다(같은 값이어도 id 로 확정)");
const same: Row[] = [
  { id: "aaa", collected_at: "2026-08-05T01:00:00Z", guessed_date: "2026-08-05", guessed_time: "10:00", label: "A" },
  { id: "bbb", collected_at: "2026-08-05T01:00:00Z", guessed_date: "2026-08-05", guessed_time: "10:00", label: "B" },
];
ok(JSON.stringify(order(same)) === JSON.stringify(order([...same].reverse())), "입력 순서가 달라도 결과 동일");

console.log("\n[6] guessed_date 가 없어도 죽지 않는다");
ok(order([{ id: "z", collected_at: "2026-08-05T01:00:00Z", guessed_date: null, guessed_time: null, label: "날짜없음" }]).length === 1, "예외 없이 처리");

console.log(`\nResult: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
