// 일회성 실동작 테스트: 수입 "여러 건 등록"이 실제로 DB에 insert 되는지 브라우저로 검증.
// 미래월(2027-01)에 마커(PLAYWRIGHT_TEST) 행 2건을 UI로 등록 → service_role로 저장 확인 → 즉시 삭제.
// 실데이터 오염 없음. 실행: node scripts/test_bulk_income.mjs
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const BASE = process.env.BASE_URL || "http://localhost:3000";
const MARKER = "PLAYWRIGHT_TEST";

// .env.local 파싱 (service_role로 검증/정리)
const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; })
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const cleanup = async (label) => {
  const { data, error } = await sb.from("hh_transaction").delete().eq("counterparty", MARKER).select("id");
  if (error) console.log(`  [정리:${label}] 오류:`, error.message);
  else console.log(`  [정리:${label}] 삭제 ${data.length}건`);
  return data?.length ?? 0;
};

const step = (m) => console.log(`\n▶ ${m}`);
let browser;
try {
  step("사전 정리(이전 잔여 마커 행 제거)");
  await cleanup("pre");

  step("브라우저 기동 + 로그인 (admin / .env.local의 E2E_LOGIN_PASSWORD)");
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  // React(클라이언트 컴포넌트) 하이드레이션이 끝나야 onSubmit(preventDefault)이 붙는다.
  // 그 전에 클릭하면 네이티브 폼이 GET(?loginId=...)으로 전송돼 로그인이 안 됨.
  await page.waitForSelector('button[type="submit"]:not([disabled])', { timeout: 20000 });
  await page.waitForTimeout(1200);
  await page.fill("#loginId", "admin");
  if (!env.E2E_LOGIN_PASSWORD) throw new Error(".env.local 에 E2E_LOGIN_PASSWORD 가 없습니다.");
  await page.fill("#password", env.E2E_LOGIN_PASSWORD);
  // 컨트롤드 인풋에 값이 실제로 반영됐는지(=하이드레이션 완료) 확인 후 제출
  await page.waitForFunction(() => document.querySelector("#loginId")?.value === "admin", { timeout: 10000 });
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard/, { timeout: 30000 });
  console.log("  로그인 성공 →", page.url());

  step("수입 여러 건 등록 화면 진입");
  await page.goto(`${BASE}/dashboard/household/income/new`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("table tbody tr", { timeout: 20000 });

  const fillRow = async (tr, { amount, memo }) => {
    await tr.locator('input[type="date"]').fill("2027-01-15");
    await tr.locator("select").nth(0).selectOption({ index: 1 }); // 항목(수입 카테고리)
    await tr.locator("select").nth(1).selectOption({ index: 1 }); // 입금계좌
    await tr.locator('input[inputmode="numeric"]').fill(String(amount));
    const texts = tr.locator('input:not([type="date"]):not([inputmode="numeric"])');
    await texts.nth(0).fill(MARKER);  // 입금처
    await texts.nth(1).fill(memo);    // 메모
  };

  step("테스트 행 2건 입력");
  await fillRow(page.locator("table tbody tr").nth(0), { amount: 1111, memo: "자동테스트-삭제예정-1" });
  await page.click('button:has-text("수입 행 추가")');
  await page.waitForFunction(() => document.querySelectorAll("table tbody tr").length >= 2);
  await fillRow(page.locator("table tbody tr").nth(1), { amount: 2222, memo: "자동테스트-삭제예정-2" });

  step('"등록" 클릭');
  // "저장 후 계속 입력"이 기본 ON(설계 60 R2)이면 저장 후 목록 이동을 안 하므로, 해제해 목록 이동을 유도.
  await page.uncheck('input[type="checkbox"]');
  await page.click('button:has-text("건 등록")');
  // 성공 시 수입 목록(/income 또는 /income?…)으로 리다이렉트.
  // ⚠️ /income/new 에 매칭되지 않도록 income 뒤는 (쿼리|끝)만 허용한다.
  await page.waitForURL(/\/dashboard\/household\/income(?:\?.*)?$/, { timeout: 30000 });
  console.log("  등록 후 이동 →", page.url());
  // 목록 리다이렉트 후에도 커밋 직후 읽기 지연 여지를 줘서 검증 안정화
  await page.waitForTimeout(800);

  step("DB 저장 검증 (service_role)");
  const { data: rows, error } = await sb
    .from("hh_transaction")
    .select("id, type, source, txn_date, amount, counterparty, memo")
    .eq("counterparty", MARKER)
    .order("amount");
  if (error) throw new Error("검증 쿼리 오류: " + error.message);
  console.log(`  저장된 마커 행: ${rows.length}건`);
  rows.forEach((r) => console.log(`   - amount=${r.amount} type=${r.type} source=${r.source} date=${r.txn_date} memo=${r.memo}`));

  const amounts = rows.map((r) => r.amount).sort((a, b) => a - b);
  const ok = rows.length === 2 && amounts[0] === 1111 && amounts[1] === 2222 &&
    rows.every((r) => r.type === "income" && r.source === "manual" && r.txn_date === "2027-01-15");

  step("테스트 행 즉시 삭제(정리)");
  const removed = await cleanup("post");
  const { count: leftover } = await sb.from("hh_transaction").select("id", { count: "exact", head: true }).eq("counterparty", MARKER);

  console.log("\n================ 결과 ================");
  console.log(`UI 일괄등록 → DB insert : ${ok ? "✅ 성공 (2건, 금액·type·source·날짜 모두 일치)" : "❌ 불일치"}`);
  console.log(`정리(삭제)               : ${removed}건 삭제, 잔여 ${leftover ?? "?"}건 ${(leftover ?? 0) === 0 ? "✅" : "⚠️"}`);
  console.log("=====================================");
  process.exitCode = ok && (leftover ?? 0) === 0 ? 0 : 1;
} catch (e) {
  console.error("\n❌ 테스트 실패:", e.message);
  await cleanup("error").catch(() => {}); // 실패해도 마커 행은 반드시 정리
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
}
