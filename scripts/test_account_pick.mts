const { pickAccountByNumber } = await import("../src/lib/household/sms-ingest");

let pass = 0;
let fail = 0;

function ok(condition: boolean, message: string) {
  if (condition) {
    pass += 1;
    console.log(`  OK ${message}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${message}`);
  }
}

const parsed = { accountTail: null, accountPrefix: "110000", accountSuffix: "000" };

const unique = pickAccountByNumber([
  { id: "target", account_no: "110000-**-***000" },
  { id: "other", account_no: "110000-**-***999" },
], parsed);
ok(unique?.id === "target", `같은 prefix에서 suffix까지 일치하는 유일 계좌 선택: ${unique?.id ?? "null"}`);

const ambiguous = pickAccountByNumber([
  { id: "first", account_no: "110000-**-***000" },
  { id: "second", account_no: "110000-**-****000" },
], parsed);
ok(ambiguous === null, `prefix와 suffix가 모두 같은 계좌가 둘이면 미선택: ${ambiguous?.id ?? "null"}`);

console.log(`\nResult: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
