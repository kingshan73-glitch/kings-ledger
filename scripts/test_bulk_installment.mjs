// 일회성 실동작 테스트(기능13): 할부 "여러 건 등록" 그리드가 hh_installment 에 insert 되는지 검증.
// title 을 마커(PLAYWRIGHT_TEST)로 → 저장 확인 → 즉시 삭제. 실데이터 오염 없음.
// 실행: node scripts/test_bulk_installment.mjs   (로컬 dev: BASE_URL=http://localhost:3000 ...)
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
  const { data } = await sb.from("hh_installment").delete().eq("title", MARKER).select("id");
  console.log(`  [정리:${label}] 할부 ${data?.length ?? 0}건 삭제`);
};

const step = (m) => console.log(`\n▶ ${m}`);
let browser;
try {
  step("사전 정리");
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
  console.log("  로그인 성공");

  step("할부 여러 건 등록 화면 진입");
  await page.goto(`${BASE}/dashboard/household/expenses/installment/new`, { waitUntil: "networkidle" });
  await page.waitForSelector("table tbody tr", { timeout: 20000 });

  // 컬럼: 시작일(date) | 카드(sel0) | 카테고리(sel1) | 내용(text) | 총금액(AmountInput=inputmode numeric) | 총회차(number) | 시작회차(number)
  const fillRow = async (tr, { total, count }) => {
    await tr.locator('input[type="date"]').fill("2027-01-15");
    await tr.locator("select").nth(0).selectOption({ index: 1 });
    await tr.locator("select").nth(1).selectOption({ index: 1 });
    // 내용(제목) = date/금액(inputmode)/회차(number) 아닌 유일한 평문 입력
    await tr.locator('input:not([type="date"]):not([inputmode="numeric"]):not([type="number"])').nth(0).fill(MARKER);
    await tr.locator('input[inputmode="numeric"]').nth(0).fill(String(total)); // 총금액(AmountInput)
    await tr.locator('input[type="number"]').nth(0).fill(String(count));       // 총회차(시작회차는 기본 1 유지)
  };

  step("테스트 행 2건 입력");
  await fillRow(page.locator("table tbody tr").nth(0), { total: 300000, count: 3 });
  await page.click('button:has-text("할부 행 추가")');
  await page.waitForFunction(() => document.querySelectorAll("table tbody tr").length >= 2);
  await fillRow(page.locator("table tbody tr").nth(1), { total: 600000, count: 6 });

  step('"등록" 클릭');
  // "저장 후 계속 입력"이 기본 ON(설계 60 R2)이면 저장 후 목록 이동을 안 하므로, 해제해 목록 이동을 유도.
  await page.uncheck('input[type="checkbox"]');
  await page.click('button:has-text("건 등록")');
  await page.waitForURL(/\/dashboard\/household\/expenses(?:\?.*)?$/, { timeout: 30000 });
  console.log("  등록 후 이동 →", page.url());
  await page.waitForTimeout(800);

  step("DB 검증");
  const { data: rows } = await sb.from("hh_installment").select("total_amount, total_count, is_active").eq("title", MARKER).order("total_amount");
  rows?.forEach((r) => console.log(`   - total=${r.total_amount} count=${r.total_count} active=${r.is_active}`));
  const t = rows?.map((r) => r.total_amount).sort((a, b) => a - b);
  const ok = rows?.length === 2 && t[0] === 300000 && t[1] === 600000 && rows.every((r) => r.is_active === true);

  step("정리");
  await cleanup("post");
  const { count: left } = await sb.from("hh_installment").select("id", { count: "exact", head: true }).eq("title", MARKER);

  console.log("\n================ 결과 ================");
  console.log(`할부 일괄등록 → DB insert : ${ok ? "✅ 성공 (2건, 총금액·회차 일치)" : "❌ 불일치"}`);
  console.log(`정리                      : 잔여 ${left ?? "?"}건 ${(left ?? 0) === 0 ? "✅" : "⚠️"}`);
  console.log("=====================================");
  process.exitCode = ok && (left ?? 0) === 0 ? 0 : 1;
} catch (e) {
  console.error("\n❌ 테스트 실패:", e.message);
  await cleanup("error").catch(() => {});
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
}
