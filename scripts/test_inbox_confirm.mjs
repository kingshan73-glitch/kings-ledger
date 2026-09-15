// 일회성 실동작 테스트: 수집함 "확정"(pending → hh_transaction, source=inbox) 파이프라인 검증.
// service_role로 마커(guessed_merchant=PLAYWRIGHT_TEST) pending 행 1건 시드 → UI에서 확정 클릭
// → 거래 생성 + inbox 상태 confirmed + 가맹점 학습(merchant_map) 검증 → 전부 삭제. 실데이터 오염 없음.
// 실행: node scripts/test_inbox_confirm.mjs
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
  const { data: txn } = await sb.from("hh_transaction").delete().eq("counterparty", MARKER).select("id");
  const { data: ib } = await sb.from("hh_transaction_inbox").delete().eq("guessed_merchant", MARKER).select("id");
  const { data: mm } = await sb.from("hh_merchant_map").delete().eq("merchant_key", MARKER).select("merchant_key");
  console.log(`  [정리:${label}] 거래 ${txn?.length ?? 0} + 수집함 ${ib?.length ?? 0} + 학습맵 ${mm?.length ?? 0} 삭제`);
};

const step = (m) => console.log(`\n▶ ${m}`);
let browser;
try {
  step("사전 정리(이전 잔여 마커 제거)");
  await cleanup("pre");

  step("시드 준비 (owner/카테고리/결제수단 조회)");
  const { data: catRow } = await sb.from("hh_category").select("id, owner_auth_uid").eq("kind", "expense").limit(1).single();
  const { data: pmRow } = await sb.from("hh_payment_method").select("id").limit(1).single();
  if (!catRow || !pmRow) throw new Error("시드용 카테고리/결제수단을 찾지 못함 (기본값 생성 필요)");
  const owner = catRow.owner_auth_uid;
  console.log(`  owner=${owner.slice(0, 8)}… category=${catRow.id.slice(0, 8)}… method=${pmRow.id.slice(0, 8)}…`);

  step("수집함 pending 행 1건 시드 (guessed_merchant=마커)");
  const { error: seedErr } = await sb.from("hh_transaction_inbox").insert({
    owner_auth_uid: owner,
    raw_text: "PLAYWRIGHT 자동테스트 - 즉시 삭제 예정",
    source: "manual",
    guessed_date: "2027-01-15",
    guessed_amount: 9999,
    guessed_merchant: MARKER,
    guessed_category_id: catRow.id,
    guessed_payment_method_id: pmRow.id,
    guessed_type: "expense",
    confidence: 100,
    status: "pending",
    dedup_hash: `2027-01-15|9999|${MARKER}|playwright`,
  });
  if (seedErr) throw new Error("시드 실패: " + seedErr.message);
  console.log("  시드 완료");

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

  step("수집함 진입 → 마커 행 체크 → '선택 확정'");
  // 행별 '확정' 버튼은 폐지되고 체크박스+선택/전체 확정으로 바뀜(설계 55). '선택 확정'은
  // 체크한 행만 확정하므로 실제 pending 을 건드리지 않아 안전. 최종확인은 window.confirm 이라 수락 핸들러 등록.
  page.on("dialog", (d) => void d.accept());
  await page.goto(`${BASE}/dashboard/household/inbox`, { waitUntil: "networkidle" });
  const row = page.locator("tr", { hasText: MARKER });
  await row.first().waitFor({ timeout: 20000 });
  await row.first().locator('input[type="checkbox"]').check();
  await page.click('button:has-text("선택 확정")');
  // 확정 완료 토스트 대기 (sonner): "N건 확정 …"
  await page.waitForSelector("text=건 확정", { timeout: 15000 });
  await page.waitForTimeout(800);
  console.log("  확정 처리됨");

  step("DB 검증 (service_role)");
  const { data: txns } = await sb.from("hh_transaction").select("id, type, source, txn_date, amount, counterparty, category_id, payment_method_id").eq("counterparty", MARKER);
  const { data: ibs } = await sb.from("hh_transaction_inbox").select("id, status, confirmed_txn_id").eq("guessed_merchant", MARKER);
  const { data: mms } = await sb.from("hh_merchant_map").select("merchant_key, category_id").eq("merchant_key", MARKER);
  txns?.forEach((t) => console.log(`   거래: amount=${t.amount} type=${t.type} source=${t.source} date=${t.txn_date} cat=${t.category_id ? "O" : "X"} method=${t.payment_method_id ? "O" : "X"}`));
  ibs?.forEach((i) => console.log(`   수집함: status=${i.status} confirmed_txn=${i.confirmed_txn_id ? "연결됨" : "없음"}`));
  console.log(`   학습맵: ${mms?.length ?? 0}건 (가맹점→분류 자동학습)`);

  const txn = txns?.[0];
  const ib = ibs?.[0];
  const ok =
    txns?.length === 1 && txn.type === "expense" && txn.source === "inbox" && txn.amount === 9999 &&
    txn.txn_date === "2027-01-15" && txn.category_id && txn.payment_method_id &&
    ib?.status === "confirmed" && ib?.confirmed_txn_id === txn.id &&
    (mms?.length ?? 0) === 1;

  step("테스트 데이터 즉시 삭제(정리)");
  await cleanup("post");
  const { count: txnLeft } = await sb.from("hh_transaction").select("id", { count: "exact", head: true }).eq("counterparty", MARKER);
  const { count: ibLeft } = await sb.from("hh_transaction_inbox").select("id", { count: "exact", head: true }).eq("guessed_merchant", MARKER);
  const leftover = (txnLeft ?? 0) + (ibLeft ?? 0);

  console.log("\n================ 결과 ================");
  console.log(`수집함 확정 → 거래DB 반영 : ${ok ? "✅ 성공 (거래 생성·inbox=confirmed·가맹점 학습 모두 일치)" : "❌ 불일치"}`);
  console.log(`정리(삭제)                : 잔여 ${leftover}건 ${leftover === 0 ? "✅" : "⚠️"}`);
  console.log("=====================================");
  process.exitCode = ok && leftover === 0 ? 0 : 1;
} catch (e) {
  console.error("\n❌ 테스트 실패:", e.message);
  await cleanup("error").catch(() => {});
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
}
