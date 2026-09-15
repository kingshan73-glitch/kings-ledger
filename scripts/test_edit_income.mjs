// 일회성 실동작 테스트: 수입 "수정(/edit)" 경로가 실제로 DB를 update 하는지 브라우저로 검증.
// service_role로 마커(counterparty=PLAYWRIGHT_TEST) 수입 1건 시드 → UI에서 금액 수정 → update 확인 → 삭제.
// 실데이터 오염 없음. 실행: node scripts/test_edit_income.mjs
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
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
let browser;
try {
  step("사전 정리 + 시드 (수입 1건, 금액 1000)");
  await cleanup("pre");
  const { data: cat } = await sb.from("hh_category").select("id, owner_auth_uid").eq("kind", "income").limit(1).single();
  const { data: acc } = await sb.from("hh_account").select("id").limit(1).single();
  if (!cat || !acc) throw new Error("시드용 수입 카테고리/계좌를 찾지 못함");
  const { data: seed, error: seedErr } = await sb.from("hh_transaction").insert({
    owner_auth_uid: cat.owner_auth_uid, type: "income", source: "manual",
    txn_date: "2027-01-15", amount: 1000, category_id: cat.id, account_id: acc.id, counterparty: MARKER,
  }).select("id").single();
  if (seedErr) throw new Error("시드 실패: " + seedErr.message);
  console.log(`  시드 id=${seed.id.slice(0, 8)}… (amount=1000)`);

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

  step("수입 수정 화면 진입 → 금액 1000 → 2000 으로 수정");
  await page.goto(`${BASE}/dashboard/household/income/${seed.id}/edit`, { waitUntil: "networkidle" });
  await page.waitForSelector("#inc-amount", { timeout: 20000 });
  await page.waitForTimeout(800);
  await page.fill("#inc-amount", "2000");
  await page.fill("#inc-memo", "자동테스트-수정됨");
  await page.click('button[type="submit"]');
  await page.waitForURL(new RegExp(`/income/${UUID.source}$`), { timeout: 30000 });
  console.log("  수정 후 상세로 이동 →", page.url());
  await page.waitForTimeout(600);

  step("DB 검증 (service_role)");
  const { data: rows } = await sb.from("hh_transaction").select("id, amount, memo, type").eq("counterparty", MARKER);
  rows?.forEach((r) => console.log(`   - amount=${r.amount} memo=${r.memo} type=${r.type}`));
  const ok = rows?.length === 1 && rows[0].amount === 2000 && rows[0].memo === "자동테스트-수정됨";

  step("테스트 행 즉시 삭제(정리)");
  await cleanup("post");
  const { count: leftover } = await sb.from("hh_transaction").select("id", { count: "exact", head: true }).eq("counterparty", MARKER);

  console.log("\n================ 결과 ================");
  console.log(`수입 수정(/edit) → DB update : ${ok ? "✅ 성공 (1000→2000, 메모 반영)" : "❌ 불일치"}`);
  console.log(`정리(삭제)                   : 잔여 ${leftover ?? "?"}건 ${(leftover ?? 0) === 0 ? "✅" : "⚠️"}`);
  console.log("=====================================");
  process.exitCode = ok && (leftover ?? 0) === 0 ? 0 : 1;
} catch (e) {
  console.error("\n❌ 테스트 실패:", e.message);
  await cleanup("error").catch(() => {});
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
}
