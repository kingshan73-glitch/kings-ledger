// 현금흐름 FoldSection 헤더의 클릭 영역 검증 (팀장 지적 2026-08-01)
// 예전엔 토글 버튼이 헤더 전폭이라 제목 오른쪽 빈 공간을 눌러도 섹션이 접혔다.
// 이제 제목+화살표까지만 눌려야 한다. 읽기 전용(데이터 변경 없음).
//
// 실행: BASE_URL=http://localhost:3100 node scripts/test_fold_header_hitarea.mjs
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const BASE = process.env.BASE_URL || "http://localhost:3100";
const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; })
);

const step = (m) => console.log(`\n▶ ${m}`);
let fail = 0;
const check = (ok, msg) => { console.log(`  ${ok ? "✅" : "❌"} ${msg}`); if (!ok) fail++; };

let browser;
try {
  step("로그인");
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.waitForSelector('button[type="submit"]:not([disabled])', { timeout: 20000 });
  await page.waitForTimeout(1200);
  await page.fill("#loginId", env.E2E_LOGIN_ID || "admin");
  if (!env.E2E_LOGIN_PASSWORD) throw new Error(".env.local 에 E2E_LOGIN_PASSWORD 가 없습니다.");
  await page.fill("#password", env.E2E_LOGIN_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard/, { timeout: 30000 });

  step("현금흐름 화면 진입");
  await page.goto(`${BASE}/dashboard/household/cash`, { waitUntil: "networkidle" });
  const toggle = page.getByRole("button", { name: /계좌 잔액/ }).first();
  await toggle.waitFor({ timeout: 30000 });

  // 접혀 있으면 펼쳐서 기준 상태를 만든다(localStorage 로 상태가 유지되므로)
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await page.waitForTimeout(300);
  check((await toggle.getAttribute("aria-expanded")) === "true", "시작 상태: 펼침");

  step("① 클릭 영역이 헤더 전폭이 아닌지 (폭 비교)");
  const btn = await toggle.boundingBox();
  const rowBox = await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((e) => /계좌 잔액/.test(e.textContent || ""));
    const row = b?.closest("section")?.querySelector(":scope > div");
    const r = row?.getBoundingClientRect();
    return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
  });
  if (!rowBox) throw new Error("헤더 행을 찾지 못했습니다");
  const ratio = btn.width / rowBox.width;
  console.log(`  버튼 ${Math.round(btn.width)}px / 헤더 ${Math.round(rowBox.width)}px = ${(ratio * 100).toFixed(1)}%`);
  check(ratio < 0.4, `클릭 영역이 헤더 폭의 40% 미만 (수정 전에는 100%였다)`);

  step("② 제목 오른쪽 빈 공간을 눌러도 접히지 않는지");
  // 헤더 행 오른쪽 끝 근처 = 팀장이 잘못 누르던 자리
  await page.mouse.click(rowBox.x + rowBox.width - 40, rowBox.y + rowBox.height / 2);
  await page.waitForTimeout(400);
  check((await toggle.getAttribute("aria-expanded")) === "true", "빈 공간 클릭 후에도 펼친 상태 유지");

  step("③ 빈 공간 여러 지점 클릭 (가운데·3/4 지점)");
  for (const f of [0.5, 0.75]) {
    await page.mouse.click(rowBox.x + rowBox.width * f, rowBox.y + rowBox.height / 2);
    await page.waitForTimeout(300);
    check((await toggle.getAttribute("aria-expanded")) === "true", `${f * 100}% 지점 클릭 후에도 펼침 유지`);
  }

  step("④ 제목·화살표는 여전히 토글되는지");
  await toggle.click();
  await page.waitForTimeout(400);
  check((await toggle.getAttribute("aria-expanded")) === "false", "제목 클릭 → 접힘");
  await toggle.click();
  await page.waitForTimeout(400);
  check((await toggle.getAttribute("aria-expanded")) === "true", "제목 다시 클릭 → 펼침");

  step("⑤ 키보드 접근성 (Enter 로도 토글되는지)");
  await toggle.focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  check((await toggle.getAttribute("aria-expanded")) === "false", "Enter → 접힘");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  check((await toggle.getAttribute("aria-expanded")) === "true", "Enter → 다시 펼침");

  console.log(`\n${fail === 0 ? "✅ 전부 통과" : `❌ 실패 ${fail}건`}`);
} catch (e) {
  console.error("오류:", e.message);
  fail++;
} finally {
  if (browser) await browser.close();
}
process.exitCode = fail === 0 ? 0 : 1;
