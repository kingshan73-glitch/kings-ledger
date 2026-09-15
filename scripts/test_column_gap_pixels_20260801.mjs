// 설계 120 실측 — 표 컬럼 폭이 화면에서 실제로 등간격인지 getBoundingClientRect 로 잰다.
// (메모리 규칙: 눈대중 금지, 넓은 뷰포트에서도 확인)
//
// 실행: BASE_URL=http://localhost:3100 node scripts/test_column_gap_pixels_20260801.mjs
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const BASE = process.env.BASE_URL || "http://localhost:3100";
const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; })
);
let fail = 0;
const check = (ok, msg) => { console.log(`  ${ok ? "✅" : "❌"} ${msg}`); if (!ok) fail++; };

let browser;
try {
  browser = await chromium.launch({ headless: true });
  for (const width of [1920, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 1100 } });
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
    await page.waitForSelector('button[type="submit"]:not([disabled])', { timeout: 20000 });
    await page.waitForTimeout(1000);
    await page.fill("#loginId", env.E2E_LOGIN_ID || "admin");
    await page.fill("#password", env.E2E_LOGIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/dashboard/, { timeout: 30000 });
    await page.goto(`${BASE}/dashboard/household/cash`, { waitUntil: "networkidle" });
    await page.waitForTimeout(2500);

    console.log(`\n▶ 뷰포트 ${width}px`);
    const tables = page.locator("table");
    const n = await tables.count();
    for (let t = 0; t < n; t++) {
      const ths = tables.nth(t).locator("thead th");
      const c = await ths.count();
      if (c < 3) continue;
      const boxes = [];
      for (let i = 0; i < c; i++) boxes.push(await ths.nth(i).boundingBox());
      if (boxes.some((b) => !b || b.width === 0)) continue; // 숨은 표
      const widths = boxes.map((b) => Math.round(b.width));
      const avg = widths.reduce((s, w) => s + w, 0) / widths.length;
      const maxDev = Math.max(...widths.map((w) => Math.abs(w - avg)));
      const devPct = (maxDev / avg) * 100;
      const head = (await ths.nth(0).innerText()).replace(/\s+/g, " ").slice(0, 10);
      // 반올림·테두리 때문에 1~2px 오차는 난다 → 평균 대비 2% 이내면 등간격으로 본다.
      check(devPct <= 2, `[${head}…] ${c}열 폭 ${widths.join("/")}px — 최대편차 ${maxDev}px (${devPct.toFixed(1)}%)`);
    }
    await page.close();
  }
  console.log(fail === 0 ? "\n전부 등간격 ✅" : `\n등간격 아님 ${fail}건 ❌`);
} catch (e) {
  console.error("실행 중 오류:", e.message);
  fail++;
} finally {
  await browser?.close();
}
process.exit(fail === 0 ? 0 : 1);
