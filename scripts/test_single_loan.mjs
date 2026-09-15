// 일회성 실동작 테스트: 대출 등록(단건 폼)이 실제로 DB(hh_loan)에 insert 되는지 브라우저로 검증.
// 대출 name 을 마커(PLAYWRIGHT_TEST)로 사용 → 저장 확인 → 즉시 삭제. 실데이터 오염 없음.
// 실행: BASE_URL=http://localhost:3000 node scripts/test_single_loan.mjs
// 참고: 단건 할부 "새로 만들기" 페이지는 폐지되고 여러 건 등록 그리드로 대체됨(설계 13). 할부 생성 검증은 test_bulk_installment.mjs.
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const BASE = process.env.BASE_URL || "http://localhost:3000";
const MARKER = "PLAYWRIGHT_TEST";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; })
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const cleanup = async (label) => {
  const { data: loan } = await sb.from("hh_loan").delete().eq("name", MARKER).select("id");
  console.log(`  [정리:${label}] 대출 ${loan?.length ?? 0}건 삭제`);
  return loan?.length ?? 0;
};

const step = (m) => console.log(`\n▶ ${m}`);
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
let browser;
try {
  step("사전 정리(이전 잔여 마커 행 제거)");
  await cleanup("pre");

  step("브라우저 기동 + 로그인 (admin / .env.local의 E2E_LOGIN_PASSWORD)");
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.waitForSelector('button[type="submit"]:not([disabled])', { timeout: 20000 });
  await page.waitForTimeout(1200);
  await page.fill("#loginId", "admin");
  if (!env.E2E_LOGIN_PASSWORD) throw new Error(".env.local 에 E2E_LOGIN_PASSWORD 가 없습니다.");
  await page.fill("#password", env.E2E_LOGIN_PASSWORD);
  await page.waitForFunction(() => document.querySelector("#loginId")?.value === "admin", { timeout: 10000 });
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard/, { timeout: 30000 });
  console.log("  로그인 성공 →", page.url());

  step("대출 등록 화면 진입 + 입력");
  await page.goto(`${BASE}/dashboard/household/loans/new`, { waitUntil: "networkidle" });
  await page.waitForSelector("#loan-name", { timeout: 20000 });
  await page.waitForTimeout(800);
  await page.fill("#loan-name", MARKER);
  await page.fill("#loan-principal", "1000000");
  await page.fill("#loan-balance", "800000");
  await page.fill("#loan-day", "25");
  await page.click('button[type="submit"]');
  await page.waitForURL(new RegExp(`/loans/${UUID.source}`), { timeout: 30000 });
  console.log("  대출 등록 후 이동 →", page.url());
  await page.waitForTimeout(600);

  step("대출 DB 검증");
  const { data: loanRows, error: loanErr } = await sb
    .from("hh_loan").select("id, name, principal, current_balance, payment_day, status").eq("name", MARKER);
  if (loanErr) throw new Error("대출 검증 쿼리 오류: " + loanErr.message);
  loanRows.forEach((r) => console.log(`   - principal=${r.principal} balance=${r.current_balance} day=${r.payment_day} status=${r.status}`));
  const loanOk = loanRows.length === 1 && loanRows[0].principal === 1000000 && loanRows[0].current_balance === 800000 && loanRows[0].payment_day === 25 && loanRows[0].status === "active";

  step("테스트 행 즉시 삭제(정리)");
  const removed = await cleanup("post");
  const { count: loanLeft } = await sb.from("hh_loan").select("id", { count: "exact", head: true }).eq("name", MARKER);

  console.log("\n================ 결과 ================");
  console.log(`대출 등록 → DB insert : ${loanOk ? "✅ 성공 (원금·잔액·상환일·상태 일치)" : "❌ 불일치"}`);
  console.log(`정리(삭제)            : ${removed}건 삭제, 잔여 ${loanLeft ?? "?"}건 ${(loanLeft ?? 0) === 0 ? "✅" : "⚠️"}`);
  console.log("=====================================");
  process.exitCode = loanOk && (loanLeft ?? 0) === 0 ? 0 : 1;
} catch (e) {
  console.error("\n❌ 테스트 실패:", e.message);
  await cleanup("error").catch(() => {});
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
}
