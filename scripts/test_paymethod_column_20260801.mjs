// 설계 118 실화면 검증 — 현금흐름 '결제방식' 열 + '출금계좌 / 결제계좌', 설정 비활성 접기.
// 읽기 전용(데이터 변경 없음). 스크린샷은 output/ 에 남긴다.
//
// 실행: BASE_URL=http://localhost:3100 node scripts/test_paymethod_column_20260801.mjs
import { chromium } from "playwright";
import { readFileSync, mkdirSync } from "node:fs";

const BASE = process.env.BASE_URL || "http://localhost:3100";
const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; })
);

const step = (m) => console.log(`\n▶ ${m}`);
let fail = 0;
const check = (ok, msg) => { console.log(`  ${ok ? "✅" : "❌"} ${msg}`); if (!ok) fail++; };

mkdirSync(new URL("../output/", import.meta.url), { recursive: true });
let browser;
try {
  step("로그인");
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.waitForSelector('button[type="submit"]:not([disabled])', { timeout: 20000 });
  await page.waitForTimeout(1200);
  await page.fill("#loginId", env.E2E_LOGIN_ID || "admin");
  if (!env.E2E_LOGIN_PASSWORD) throw new Error(".env.local 에 E2E_LOGIN_PASSWORD 가 없습니다.");
  await page.fill("#password", env.E2E_LOGIN_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard/, { timeout: 30000 });

  step("① 현금흐름 — 당월 출금 예정 표 헤더");
  await page.goto(`${BASE}/dashboard/household/cash`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);
  const table = page.locator("table").filter({ has: page.locator('th:text-is("결제방식")') }).first();
  await table.waitFor({ timeout: 30000 });
  const heads = await table.locator("thead th").allInnerTexts();
  console.log(`    헤더: ${heads.join(" | ")}`);
  check(heads.includes("결제방식"), "'결제방식' 열이 있다");
  check(heads.indexOf("결제방식") === heads.indexOf("카테고리") + 1, "'결제방식'이 카테고리 바로 뒤(카테고리와 계좌 사이)");
  check(heads.some((h) => h.includes("출금계좌 / 결제계좌")), "'출금계좌 / 결제계좌' 로 표기");
  check(!heads.includes("출금계좌"), "옛 '출금계좌' 단독 헤더는 없다");
  check(heads.some((h) => h.includes("출금금액 / 결제금액")), "'출금금액 / 결제금액' 로 표기 (설계 119)");

  step("② 열 개수 정합 — colgroup·thead·행·tfoot 이 모두 같아야 한다");
  const nCols = await table.locator("colgroup col").count();
  const nHead = heads.length;
  const firstRowCells = await table.locator("tbody tr").first().locator("td").count();
  const footCells = await table.locator("tfoot tr td").evaluateAll((tds) =>
    tds.reduce((s, td) => s + (td.colSpan || 1), 0));
  console.log(`    colgroup=${nCols} thead=${nHead} 첫행=${firstRowCells} tfoot(colspan합)=${footCells}`);
  check(nCols === 9 && nHead === 9, "당월 표는 9열");
  check(firstRowCells === 9, "본문 행도 9칸");
  check(footCells === 9, "합계행 colspan 합도 9 (어긋나면 합계가 밀려 보인다)");

  step("③ 카드 행 — 결제방식='카드 + 카드명', 계좌칸=결제계좌(고르는 칸 아님)");
  const cardRow = table.locator("tbody tr").filter({ has: page.locator('td:nth-child(4) >> text="카드"') }).first();
  const cardCount = await table.locator('tbody tr td:nth-child(4):has-text("카드")').count();
  console.log(`    카드결제 행 ${cardCount}건`);
  if (cardCount > 0) {
    const pay = (await cardRow.locator("td").nth(3).innerText()).replace(/\s+/g, " ").trim();
    const acct = (await cardRow.locator("td").nth(4).innerText()).replace(/\s+/g, " ").trim();
    const hasSelect = await cardRow.locator("td").nth(4).locator("select").count();
    console.log(`    결제방식="${pay}"  계좌칸="${acct}"  select=${hasSelect}`);
    check(pay === "카드", "결제방식 칸은 '카드' 뱃지만 (설계 119 — 카드명 제거)");
    check(/카드/.test(acct), "실제 결제 카드명이 '출금계좌 / 결제계좌' 칸에 있다 (설계 119)");
    check(hasSelect === 0, "카드 행 계좌칸은 드롭다운이 아니다(설계 70 위반 유도 차단)");
    check(acct.length > 0, "결제계좌(또는 미지정 경고)가 표시된다");
  } else {
    console.log("    (이 기간에 카드결제 행이 없어 건너뜀)");
  }

  step("④ 현금 행 — 결제방식='현금', 계좌칸은 여전히 고를 수 있다");
  const cashRow = table.locator("tbody tr").filter({ has: page.locator('td:nth-child(4) >> text="현금"') }).first();
  const cashCount = await table.locator('tbody tr td:nth-child(4):has-text("현금")').count();
  console.log(`    현금 행 ${cashCount}건`);
  if (cashCount > 0) {
    check((await cashRow.locator("td").nth(3).innerText()).includes("현금"), "결제방식 칸이 '현금'");
    check((await cashRow.locator("td").nth(4).locator("select").count()) === 1, "현금 행은 출금계좌 드롭다운 유지");
  }
  await page.screenshot({ path: "output/118_cash_current.png", fullPage: false });

  step("⑤ 익월 출금 탭도 같은 구조인지");
  const nextTab = page.getByRole("tab", { name: /익월/ }).first();
  if (await nextTab.count()) {
    await nextTab.click();
    await page.waitForTimeout(1500);
    const nt = page.locator("table").filter({ has: page.locator('th:text-is("결제방식")') }).first();
    const nHeads = await nt.locator("thead th").allInnerTexts();
    console.log(`    익월 헤더: ${nHeads.join(" | ")}`);
    check(nHeads.includes("결제방식"), "익월 표에도 '결제방식' 열");
    check(nHeads.some((h) => h.includes("출금계좌 / 결제계좌")), "익월도 '출금계좌 / 결제계좌'");
    const nCols2 = await nt.locator("colgroup col").count();
    const nFoot2 = await nt.locator("tfoot tr td").evaluateAll((tds) => tds.reduce((s, td) => s + (td.colSpan || 1), 0));
    console.log(`    익월 colgroup=${nCols2} thead=${nHeads.length} tfoot=${nFoot2}`);
    check(nCols2 === 8 && nHeads.length === 8 && nFoot2 === 8, "익월 표는 8열로 정합");
    await page.screenshot({ path: "output/118_cash_next.png", fullPage: false });
  }

  step("⑥ 설정 계좌정보 — 비활성 기본 숨김 + 맨 아래 + 펼치기");
  await page.goto(`${BASE}/dashboard/household/settings`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);
  const acctTable = page.locator("table").first();
  await acctTable.waitFor({ timeout: 30000 });
  // 접기 토글 행("비활성 N개 보기")은 데이터 행이 아니므로 센 데서 뺀다.
  const isToggleRow = (t) => /비활성 \d+개 (보기|접기)/.test(t);
  const badgesBefore = (await acctTable.locator("tbody tr").allInnerTexts()).filter((t) => !isToggleRow(t));
  const inactiveBefore = badgesBefore.filter((t) => t.includes("비활성")).length;
  console.log(`    접힘 상태: 행 ${badgesBefore.length}개 중 '비활성' 포함 ${inactiveBefore}개`);
  check(inactiveBefore === 0, "기본 상태에서 비활성 행이 보이지 않는다");

  const expand = page.getByRole("button", { name: /비활성 \d+개 보기/ }).first();
  check((await expand.count()) === 1, "'비활성 N개 보기' 버튼이 있다(되살릴 경로 유지)");
  await expand.click();
  await page.waitForTimeout(600);
  const rowsAfter = (await acctTable.locator("tbody tr").allInnerTexts()).filter((t) => !isToggleRow(t));
  const inactiveIdx = rowsAfter.map((t, idx) => (t.includes("비활성") ? idx : -1)).filter((i) => i >= 0);
  const activeIdx = rowsAfter.map((t, idx) => (t.includes("활성") && !t.includes("비활성") ? idx : -1)).filter((i) => i >= 0);
  console.log(`    펼침 상태: 행 ${rowsAfter.length}개 / 비활성 ${inactiveIdx.length}개`);
  check(inactiveIdx.length > 0, "펼치면 비활성 행이 나온다");
  check(
    activeIdx.length === 0 || inactiveIdx.length === 0 || Math.min(...inactiveIdx) > Math.max(...activeIdx),
    "비활성 행이 전부 활성 행보다 아래에 있다",
  );
  await page.screenshot({ path: "output/118_settings_expanded.png", fullPage: false });

  console.log(fail === 0 ? "\n전부 통과 ✅ (스크린샷: output/118_*.png)" : `\n실패 ${fail}건 ❌`);
} catch (e) {
  console.error("\n실행 중 오류:", e.message);
  fail++;
} finally {
  await browser?.close();
}
process.exit(fail === 0 ? 0 : 1);
