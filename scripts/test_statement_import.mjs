// 일회성 실동작 테스트(기능15): 명세서 파일 업로드가 hh_transaction_inbox(source='file', pending)에 적재되는지 검증.
// 임시 CSV(가맹점=PLAYWRIGHT_TEST) 업로드 → 자동 컬럼매핑 → 수집함 추가 → 검증 → 즉시 삭제. 실데이터 오염 없음.
// 실행: node scripts/test_statement_import.mjs   (로컬 dev: BASE_URL=http://localhost:3000 ...)
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.BASE_URL || "http://localhost:3000";
const MARKER = "PLAYWRIGHT_TEST";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; })
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const cleanup = async (label) => {
  const { data } = await sb.from("hh_transaction_inbox").delete().eq("guessed_merchant", MARKER).select("id");
  console.log(`  [정리:${label}] 수집함 ${data?.length ?? 0}건 삭제`);
};

const step = (m) => console.log(`\n▶ ${m}`);
const csvPath = join(tmpdir(), "playwright_statement_test.csv");
let browser;
try {
  step("사전 정리 + 임시 CSV 생성");
  await cleanup("pre");
  // 헤더: 날짜,금액,가맹점 (autoDetect가 잡는 이름). 마커 가맹점 2건.
  const csv = ["날짜,금액,가맹점", `2027-01-10,15000,${MARKER}`, `2027-01-11,27000,${MARKER}`].join("\n");
  writeFileSync(csvPath, "﻿" + csv, "utf8"); // BOM으로 한글 안전
  console.log("  CSV:", csvPath);

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

  step("수집함 → 명세서 업로드 다이얼로그");
  await page.goto(`${BASE}/dashboard/household/inbox`, { waitUntil: "networkidle" });
  await page.click('button:has-text("명세서 업로드")');
  await page.waitForSelector('input[type="file"]', { state: "attached", timeout: 10000 });

  step("CSV 업로드 → 자동 매핑 → 미리보기");
  await page.setInputFiles('input[type="file"]', csvPath);
  // 미리보기 테이블에 마커 행이 보일 때까지 대기
  await page.waitForSelector(`text=${MARKER}`, { timeout: 15000 });
  await page.waitForTimeout(500);

  step('"수집함에 N건 추가" 클릭');
  await page.click('button:has-text("수집함에")');
  await page.waitForSelector("text=수집했습니다", { timeout: 15000 });
  await page.waitForTimeout(800);

  step("DB 검증 (service_role)");
  const { data: rows } = await sb.from("hh_transaction_inbox")
    .select("guessed_amount, guessed_date, guessed_type, source, source_adapter, status")
    .eq("guessed_merchant", MARKER).order("guessed_amount");
  rows?.forEach((r) => console.log(`   - amount=${r.guessed_amount} date=${r.guessed_date} type=${r.guessed_type} source=${r.source} adapter=${r.source_adapter} status=${r.status}`));
  const a = rows?.map((r) => r.guessed_amount).sort((x, y) => x - y);
  const ok = rows?.length === 2 && a[0] === 15000 && a[1] === 27000 &&
    rows.every((r) => r.source === "file" && r.status === "pending" && r.guessed_type === "expense" && r.guessed_date.startsWith("2027-01"));

  step("정리");
  await cleanup("post");
  const { count: left } = await sb.from("hh_transaction_inbox").select("id", { count: "exact", head: true }).eq("guessed_merchant", MARKER);

  console.log("\n================ 결과 ================");
  console.log(`명세서 업로드 → 수집함(file/pending) : ${ok ? "✅ 성공 (2건, 금액·날짜·source=file·pending 일치)" : "❌ 불일치"}`);
  console.log(`정리                                 : 잔여 ${left ?? "?"}건 ${(left ?? 0) === 0 ? "✅" : "⚠️"}`);
  console.log("=====================================");
  process.exitCode = ok && (left ?? 0) === 0 ? 0 : 1;
} catch (e) {
  console.error("\n❌ 테스트 실패:", e.message);
  await cleanup("error").catch(() => {});
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  try { rmSync(csvPath, { force: true }); } catch { /* noop */ }
}
