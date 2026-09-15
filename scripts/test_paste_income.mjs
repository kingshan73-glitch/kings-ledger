// 일회성 실동작 테스트(기능14): 수입 일괄등록 그리드의 "엑셀에서 붙여넣기"가 행을 채우고 저장되는지 검증.
// 실제 카테고리/계좌 이름으로 TSV를 만들어 붙여넣기 → 등록 → hh_transaction 검증 → 즉시 삭제.
// 실행: node scripts/test_paste_income.mjs   (로컬 dev: BASE_URL=http://localhost:3000 ...)
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
  const { data } = await sb.from("hh_transaction").delete().eq("counterparty", MARKER).select("id");
  console.log(`  [정리:${label}] 삭제 ${data?.length ?? 0}건`);
};

const step = (m) => console.log(`\n▶ ${m}`);
let browser;
try {
  step("사전 정리 + 실제 카테고리/계좌 이름 조회");
  await cleanup("pre");
  const { data: cat } = await sb.from("hh_category").select("name").eq("kind", "income").limit(1).single();
  const { data: acc } = await sb.from("hh_account").select("name").limit(1).single();
  if (!cat || !acc) throw new Error("수입 카테고리/계좌가 없음");
  console.log(`  카테고리="${cat.name}" 계좌="${acc.name}"`);
  // 엑셀 복사 형식(TSV): 날짜 · 항목 · 입금계좌 · 금액 · 입금처 · 메모
  const tsv = [
    `2027-01-15\t${cat.name}\t${acc.name}\t12345\t${MARKER}\t붙여넣기-1`,
    `2027-01-16\t${cat.name}\t${acc.name}\t67890\t${MARKER}\t붙여넣기-2`,
  ].join("\n");

  step("브라우저 기동 + 로그인");
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

  step("수입 일괄등록 화면 → 붙여넣기 영역 열기");
  await page.goto(`${BASE}/dashboard/household/income/new`, { waitUntil: "networkidle" });
  await page.waitForSelector("table tbody tr", { timeout: 20000 });
  await page.click('button:has-text("엑셀에서 붙여넣기")');
  await page.waitForSelector("textarea", { timeout: 10000 });

  step("TSV 붙여넣기 → 행으로 추가");
  await page.fill("textarea", tsv);
  await page.click('button:has-text("행으로 추가")');
  await page.waitForFunction(() => document.querySelectorAll("table tbody tr").length >= 2, { timeout: 10000 });
  console.log("  그리드 행 수 =", await page.locator("table tbody tr").count());

  step('"등록" 클릭');
  // "저장 후 계속 입력"이 기본 ON(설계 60 R2)이면 저장 후 목록 이동을 안 하므로, 해제해 목록 이동을 유도.
  await page.uncheck('input[type="checkbox"]');
  await page.click('button:has-text("건 등록")');
  await page.waitForURL(/\/dashboard\/household\/income(?:\?.*)?$/, { timeout: 30000 });
  console.log("  등록 후 이동 →", page.url());
  await page.waitForTimeout(800);

  step("DB 검증");
  const { data: rows } = await sb.from("hh_transaction").select("amount, type, source, txn_date, category_id, account_id").eq("counterparty", MARKER).order("amount");
  rows?.forEach((r) => console.log(`   - amount=${r.amount} type=${r.type} date=${r.txn_date} cat=${r.category_id ? "O" : "X"} acc=${r.account_id ? "O" : "X"}`));
  const a = rows?.map((r) => r.amount).sort((x, y) => x - y);
  const ok = rows?.length === 2 && a[0] === 12345 && a[1] === 67890 &&
    rows.every((r) => r.type === "income" && r.category_id && r.account_id && r.txn_date.startsWith("2027-01"));

  step("정리");
  await cleanup("post");
  const { count: left } = await sb.from("hh_transaction").select("id", { count: "exact", head: true }).eq("counterparty", MARKER);

  console.log("\n================ 결과 ================");
  console.log(`엑셀 붙여넣기 → 그리드 → DB : ${ok ? "✅ 성공 (2건, 이름→id 매칭·금액·날짜 일치)" : "❌ 불일치"}`);
  console.log(`정리                        : 잔여 ${left ?? "?"}건 ${(left ?? 0) === 0 ? "✅" : "⚠️"}`);
  console.log("=====================================");
  process.exitCode = ok && (left ?? 0) === 0 ? 0 : 1;
} catch (e) {
  console.error("\n❌ 테스트 실패:", e.message);
  await cleanup("error").catch(() => {});
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
}
