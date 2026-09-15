// 표 '그려진 뒤' 균일성 검사 — 화면 실측 (설계 121 → 판정 기준은 설계 122 로 교체)
//
// 왜 또 만드나: `npm run test:table-width` 는 **소스에 선언된 폭만** 본다.
//   2026-08-01 현금흐름 지적(4차) 때 그 검사는 "20개 표 위반 0"으로 통과했는데,
//   화면에서는 좌우 여백이 어긋나 있었다. 어긋난 곳이 전부 **셀 안쪽**이었기 때문이다:
//     ① 셀 패딩이 열마다 다름(px-2 vs px-4)
//     ② 셀 안 컨트롤 폭이 제각각(w-16 / w-full / w-28)
//     ③ <button> 은 flex 를 줘도 폭이 fit-content 라 옆 칸을 침범(실측 +44px)
//     ④ <table> 에 table-fixed 가 없어 선언한 %가 아예 무시됨
//   이 넷은 렌더링해야 보인다. 그래서 실제로 로그인해서 화면을 재는 검사가 따로 필요하다.
//
// 검사 항목(한 표당 6가지) — 전부 실측이다. 눈대중 금지.
//   A'. **내용(ink) 사이 간격 균등** ← 설계 122 의 본체. 경계별 '행들의 최소 간격'을 비교한다.
//       ★예전 A(열 폭 균등)를 대체했다. 열 폭을 같게 하는 것은 팀장 지적의 오독이었다 —
//         열이 같아도 짧은 내용(날짜 44px·체크박스 16px) 옆에만 130~250px 이 비었다.
//   B. 셀 좌우 패딩 동일 : 한 행 안에서 padding-left/right 가 전부 같은 값
//   C. 컨트롤 폭 = 가용폭 : select/input/textarea 는 반드시 w-full (셀폭 - 좌우패딩과 일치)
//   D. 칸 넘침 0         : 셀 안 어떤 요소도 가용폭을 넘지 않는다
//   E. 헤더 줄바꿈 0    : 열이 헤더보다 좁아 헤더가 두 줄로 꺾이지 않는가
//   G. **select 값 잘림 0** : 선택된 option 글자가 칸을 넘지 않는가 (F 는 select 를 제외하므로 별도, 설계 125)
//   H. **줄 꺾임 0**      : 한 텍스트가 두 줄로 꺾이지 않는가 — 요소를 쌓은 '의도된 2줄'과는 구분한다
//   F. **글자 잘림 0**  : truncate(overflow:hidden)로 **글자가 실제로 잘려 사라진** 셀이 없는가 (설계 123)
//       ★D 로는 절대 못 잡는다 — D 는 `overflowX === "visible"` 인 것만 보므로 truncate 를
//         **일부러 건너뛴다**(설계 120 이 truncate 를 정답으로 삼았기 때문). 그래서 검사기가
//         초록인 채로 현금흐름 '항목' 21칸이 잘려 있었다(팀장 지적 2026-08-02).
//       처방이 둘로 갈리니 메시지도 구분한다:
//         ① 열이 좁다      → 열 폭을 올린다(HH_COL 척도)
//         ② 열은 충분하다  → 셀 **안쪽** 요소가 좁다(inline-flex·max-w). 열을 넓혀도 안 풀린다.
//   → B·C·D 는 A' 를 성립시키는 장치다. 내용이 자기 칸을 채워야 간격이 패딩만으로 결정된다.
//   → E 는 스크린샷에서만 보이던 사각지대였다(설계 122). 검사기가 초록이어도 화면을 보라는 교훈의 산물.
//
// 대상 페이지는 **파일시스템에서 읽는다**(src/app/dashboard/**/page.tsx). 목록을 손으로 적으면
//   화면이 늘 때 검사기가 조용히 거짓말을 한다. 동적 라우트([id])는 못 열므로 건너뛰고 **몇 개를
//   건너뛰었는지 반드시 출력**한다(조용한 누락 금지).
// 각 페이지에서 탭(role=tab)을 하나씩 눌러 숨은 표까지 본다.
//
// 진짜 예외는 <table> 에 `data-uniform-exempt="<이유>"` 를 달면 건너뛴다(이유 없이 달지 말 것).
// ★그건 잘림·줄꺾임까지 함께 끈다. **A'(슬랙 균등)만** 빼려면 `data-slack-exempt="<이유>"` 를 쓴다.
//   면제된 표도 결과에 이유와 함께 출력된다.
//
// 실행: npm run test:table-render          (서버가 없으면 3100 포트로 직접 띄우고 끝나면 내린다)
//       BASE_URL=http://localhost:3100 npm run test:table-render   (이미 띄워둔 서버 재사용)
// 필요: .env.local 의 E2E_LOGIN_ID / E2E_LOGIN_PASSWORD, 그리고 DB 연결(실화면을 그리므로).
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chromium, type Browser, type Page } from "@playwright/test";

// (B 패딩·C 컨트롤 폭의 1.5px 반올림 여유는 브라우저 안 측정기 MEASURE 에 들어 있다)
// A' 열별 슬랙의 허용 편차.
// 고정폭으로는 0 을 만들 수 없다 — **탭·필터마다 내용 길이가 달라** 같은 열의 슬랙이 흔들린다
// (수집함 '카테고리'는 확정 탭에선 텍스트 81px, 미분류 탭에선 select. 실측 슬랙 차 30px 이상).
// 여기에 척도 슬롯 간격(8~24px)이 더해진다. 48px 은 그 둘을 덮으면서,
// 팀장이 실제로 잡아낸 어긋남(5차 30 vs 94px · 6차 130~250px)은 확실히 걸리는 선이다.
// ★2026-08-02 상향 48 → 112. 팀장 결정 = **"두 줄 방지" 우선**(설계 125).
//   두 목표는 같은 폭을 반대로 당긴다: 글자가 안 잘리려면 열을 **모든 탭 중 가장 긴 내용**에
//   맞춰야 하고, 그러면 내용이 짧은 탭에서는 그 차이만큼 슬랙이 남는다 — 이건 위반이 아니라 대가다.
//   실측 최대 편차 104.7px(수집함 휴지통 탭: 가맹점·계좌·사용내역이 대부분 '-')를 덮는 값으로 112 를 잡았다.
//   ⚠️약해진 것은 사실이다. 다만 팀장이 실제로 잡아낸 어긋남(5차 30 vs 94px · 6차 130~250px)은
//     여전히 걸린다. 진짜 '한 칸만 크게 빈' 사고는 130px 이상이었다.
const GAP_TOL_PX = 112;
const PORT = Number(process.env.PORT || 3100); // 3000 은 다른 세션 것일 수 있다
const ROWS_PER_TABLE = 5; // 본문 행을 몇 줄까지 볼지 — 첫 행만 보면 2번째 행 이후 위반을 놓친다
// ★F(글자 잘림)만은 **전 행**을 본다. B·C·D 는 열 속성이라 몇 줄만 봐도 되지만, 잘림은 **그 행의 값**이
//   길 때만 나므로 5행 표본으로는 6번째 이후를 통째로 놓친다 — 실제로 현금흐름 '항목'은 39행 중
//   21칸이 잘려 있었는데 앞 5행에는 잘린 게 없었다(교차리뷰 지적 2026-08-02).
//   비용은 싸다: 셀마다 scrollWidth/clientWidth 두 번 읽는 게 전부다.
const CUT_ROWS = 500;
// ★넓은 화면 하나만 재면 안 된다. 표는 `min-w-[...]` 에서 멈추므로 **좁은 데스크톱에서 먼저 깨진다** —
//   2026-08-01 설정 계좌정보 표가 1920 에서는 멀쩡한데 768~1100 에서 옆 칸을 +48px 침범했다(교차리뷰가 잡음).
//   좁은 쪽(768=md 진입점)과 넓은 쪽을 둘 다 본다. VW 를 주면 그 폭 하나만 본다.
// ★2026-08-11: 중간 폭 1280 을 넣었다. 768(md 진입)·1920(넓은 쪽)만 보던 탓에 **그 사이에서만
//   나는 결함**을 놓쳤다 — 지출 2단 보기의 '금액' 열 잘림(설계 145 이후 계속)이 그것이다.
//   1280 은 2단 각 단이 가장 좁아지는 구간이라 잘림이 제일 크게 드러난다(실측 124px).
const VIEWPORTS = process.env.VW ? [Number(process.env.VW)] : [768, 1280, 1920];

// ── .env.local (로그인 정보) ───────────────────────────────────────────────
const envPath = path.join(process.cwd(), ".env.local");
if (!fs.existsSync(envPath)) {
  console.error("❌ .env.local 이 없습니다. 이 검사는 실제 화면을 그리므로 로그인 정보가 필요합니다.");
  process.exit(1);
}
const env = Object.fromEntries(
  fs.readFileSync(envPath, "utf8").split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
);
const LOGIN_ID = env.E2E_LOGIN_ID || "admin";
if (!env.E2E_LOGIN_PASSWORD) {
  console.error("❌ .env.local 에 E2E_LOGIN_PASSWORD 가 없습니다. (기억 속 비밀번호를 쓰지 말 것)");
  process.exit(1);
}

// ── 대상 라우트: 파일시스템이 원천 ─────────────────────────────────────────
function routesUnder(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) routesUnder(p, out);
    else if (e.name === "page.tsx") out.push("/" + path.relative("src/app", dir).split(path.sep).join("/"));
  }
  return out;
}
const allRoutes = routesUnder("src/app/dashboard").sort();
const dynamic = allRoutes.filter((r) => r.includes("["));
// ONLY=cash 처럼 부분 문자열을 주면 그 화면만 본다(고치는 중 빠르게 돌릴 때).
const ONLY = process.env.ONLY;
const routes = allRoutes.filter((r) => !r.includes("[")).filter((r) => !ONLY || r.includes(ONLY));

// ── 서버 (없으면 직접 띄운다) ──────────────────────────────────────────────
const reachable = async (url: string) => {
  try { await fetch(url, { signal: AbortSignal.timeout(2500) }); return true; } catch { return false; }
};
let server: ChildProcess | null = null;
const BASE = process.env.BASE_URL || `http://localhost:${PORT}`;
if (!(await reachable(BASE))) {
  if (process.env.BASE_URL) { console.error(`❌ BASE_URL(${BASE}) 에 연결할 수 없습니다.`); process.exit(1); }
  console.log(`▶ dev 서버가 없어 ${PORT} 포트로 띄웁니다…`);
  // POSIX 는 detached 로 프로세스 그룹을 만들어야 shell 이 아니라 next dev 까지 죽는다.
  server = spawn("npm", ["run", "dev", "--", "-p", String(PORT)], {
    shell: true, stdio: "ignore", detached: process.platform !== "win32",
  });
  const until = Date.now() + 120_000;
  while (Date.now() < until && !(await reachable(BASE))) await new Promise((r) => setTimeout(r, 1000));
  if (!(await reachable(BASE))) { console.error("❌ dev 서버 기동 실패(120초)"); stopServer(); process.exit(1); }
  console.log("  기동 완료");
}
function stopServer() {
  if (!server?.pid) return;
  const pid = server.pid;
  server = null; // 재진입 방지(신호 핸들러와 finally 가 겹칠 수 있다)
  try {
    // ★spawnSync — 비동기로 던지고 바로 process.exit() 하면 taskkill 이 시작도 못 하고 죽어
    //   dev 서버 트리가 남는다(교차리뷰 지적: Codex·Claude 양쪽).
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(-pid, "SIGTERM"); // 프로세스 그룹째 — shell 만 죽이면 next dev 가 남는다
  } catch { /* 이미 죽었으면 무시 */ }
}
// ★내가 띄운 서버는 어떤 경로로 끝나든 내린다 — 안 그러면 3100 을 문 채 좀비로 남고,
//   다음 실행이 그 좀비를 "이미 떠 있는 서버"로 오인해 옛 코드를 검사한다(교차리뷰 지적).
const SIG_EXIT = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const; // 128 + 신호번호
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => { stopServer(); process.exit(SIG_EXIT[sig]); });
}
process.on("exit", stopServer);
process.on("uncaughtException", (e) => { stopServer(); console.error(e); process.exit(1); });

// ── 브라우저: Chrome 우선(전역 규칙), 안 뜨면 번들 Chromium 으로 폴백 ───────
async function launch(): Promise<{ browser: Browser; which: string }> {
  try {
    return { browser: await chromium.launch({ headless: true, channel: "chrome", timeout: 30_000 }), which: "Chrome" };
  } catch {
    console.log("  ⓘ Chrome 기동 실패 → 번들 Chromium 으로 검사합니다(레이아웃 엔진 동일).");
    return { browser: await chromium.launch({ headless: true }), which: "Chromium(번들)" };
  }
}

type Violation = { route: string; tab: string; table: string; kind: string; detail: string };
type Measured = { sig: string; exempt: string | null; slackExempt: string | null; cols: number[]; pads: string[]; ctrl: string[]; over: string[]; cut: string[]; wrap: string[]; rowsSeen: number; slack: (number | null)[]; headWrap: string[]; clip: string | null };

// 페이지 안에서 실행되는 측정기. 반환값은 순수 데이터(판정은 밖에서 한다).
// ★함수가 아니라 **문자열**로 넘긴다 — tsx(esbuild)가 함수에 __name 헬퍼를 심어 두는데
//   그 함수를 브라우저로 직렬화하면 "__name is not defined" 로 죽는다(실제로 겪음).
const MEASURE = `(() => {
  const round = (n) => Math.round(n * 10) / 10;
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  return [...document.querySelectorAll("table")].filter(visible).map((t) => {
    const ths = [...t.querySelectorAll("thead th")];
    const sig = ths.map((th) => (th.textContent || "").trim()).filter(Boolean).join(" | ").slice(0, 90) || "(헤더 없음)";
    const exempt = t.getAttribute("data-uniform-exempt");
    // A'(슬랙 균등)만 빼는 표식. data-uniform-exempt 는 잘림·줄꺾임까지 통째로 끄기 때문에
    // "폭은 다른 탭에 맞춰야 해서 이 탭 슬랙은 못 맞춘다" 같은 경우엔 과하다. (2026-08-02)
    const slackExempt = t.getAttribute("data-slack-exempt");
    // 헤더 수와 칸 수가 같은 본문 행들을 본다(colSpan 안내행·합계행 제외).
    // ★첫 행만 보면 2번째 행 이후의 위반을 통째로 놓친다(교차리뷰 지적) → ROWS 줄까지 훑는다.
    const allRows = [...t.querySelectorAll("tbody tr")]
      .filter((tr) => tr.children.length === ths.length && visible(tr));
    const bodyRows = allRows.slice(0, ${ROWS_PER_TABLE});
    const cutRows = allRows.slice(0, ${CUT_ROWS}); // F 는 전 행을 본다(위 상수 주석 참고)
    const cols = ths.map((th) => round(th.getBoundingClientRect().width));

    // ── I. ★표가 자기 껍데기를 넘는가 (2026-08-11 신설) ──────────────────
    // D 는 **셀 안 요소**만 본다. 표 전체가 껍데기(overflow-x 가 visible 이 아닌 조상)보다 넓어
    // **오른쪽 열이 통째로 잘리는 것**은 A'·D·E·F·G·H 어디에도 안 걸린다.
    //   실사례 2026-08-11(팀장 신고): 지출 2단 보기에서 '금액' 열이 47~124px 잘려 있었다.
    //   설계 145 당시 표가 592px 라 594px 단에 들어갔는데, 그 뒤 열 폭이 640px 로 커지면서
    //   **모든 뷰포트에서 항상 잘리는 상태**가 됐다(페이지 최대폭 1200 → 단 폭 594 고정).
    // ★D 가 못 잡은 이유: D-2 는 overflowX === "visible" 인 것만 보는데 껍데기는 auto 다.
    //   그래서 가로 스크롤로 '숨겨진' 넘침은 통째로 사각지대였다.
    // 규칙 근거(CLAUDE.md 표 컬럼 폭): 표 폭 = 척도 폭의 합이고 껍데기는 w-fit 이라
    //   **껍데기가 표보다 좁으면 그 자체가 규칙 위반**이다(가로 스크롤은 의도가 아니다).
    // ⚠️이 블록은 백틱 템플릿 문자열(MEASURE) 안이다 — 주석에도 백틱을 쓰면 문자열이 끊긴다.
    let clip = null;
    {
      let sc = t.parentElement;
      while (sc) {
        const ov = getComputedStyle(sc).overflowX;
        if (ov === "auto" || ov === "hidden" || ov === "scroll") break;
        sc = sc.parentElement;
      }
      if (sc) {
        const tw = t.getBoundingClientRect().width;
        const over = round(tw - sc.clientWidth);
        // ★판정을 좁힌다(2026-08-11 1차 시도가 너무 엄격했다).
        //   화면 자체가 표보다 좁아 생기는 가로 스크롤은 **위반이 아니다** — 768px 태블릿에서
        //   콘텐츠 폭이 532px 뿐이면 592px 표는 넘칠 수밖에 없다.
        //   진짜 결함은 **부모에는 자리가 있는데 껍데기만 좁은 경우**다(2단 분할처럼 폭을 나눠 쓴 탓).
        //   그래서 부모가 표를 담을 수 있을 때만 잡는다.
        const room = sc.parentElement ? sc.parentElement.clientWidth : 0;
        if (over > 1 && room >= tw - 1) {
          // 어느 열부터 잘리는지 — 누적 폭이 껍데기 안쪽 폭을 넘는 첫 열.
          let acc = 0, firstCut = null;
          for (let i = 0; i < ths.length; i++) {
            acc += ths[i].getBoundingClientRect().width;
            if (acc > sc.clientWidth + 1) { firstCut = ((ths[i].textContent || "").trim() || (i + 1) + "열"); break; }
          }
          clip = "표 " + round(tw) + "px 가 껍데기 " + round(sc.clientWidth) + "px 를 +" + over + "px 넘침"
               + " (부모엔 " + round(room) + "px 자리가 있다 = 레이아웃이 쪼갠 탓)"
               + (firstCut ? " — '" + firstCut + "' 열부터 잘린다" : "");
        }
      }
    }

    // ── E. 헤더 줄바꿈 ────────────────────────────────────────────────────
    // 열이 헤더보다 좁으면 헤더가 두 줄로 꺾인다. 요소 폭도 안 넘치고 글자도 안 잘려서
    // A'·D 어디에도 안 걸린다 — **스크린샷을 보고서야 찾았다**('출금금액 / 결제금액'의 '액' 한 글자).
    // 글자 Range 의 client rect 가 2개 이상이면 줄이 나뉜 것이다.
    const headWrap = [];
    ths.forEach((th, i) => {
      const w = document.createTreeWalker(th, NodeFilter.SHOW_TEXT);
      let nd, lines = 0;
      while ((nd = w.nextNode())) {
        if (!nd.nodeValue || !nd.nodeValue.trim()) continue;
        const rg = document.createRange();
        rg.selectNodeContents(nd);
        lines = Math.max(lines, rg.getClientRects().length);
      }
      if (lines > 1) headWrap.push(((th.textContent || "").trim().slice(0, 20)) + ": " + lines + "줄");
    });

    // ── A'. 내용(ink) 사이 간격 ─────────────────────────────────────────
    // ★상자가 아니라 **화면에 칠해지는 영역**을 잰다(설계 121 5차 교훈 / 설계 122 A').
    //   ink = 배경·테두리가 있는 요소 + 글자 Range 의 합집합을 **셀 경계로 클립**한 것.
    //   클립을 빼먹으면 overflow:hidden 으로 잘린 글자가 원래 길이로 보고돼 음수 간격이 나온다.
    const inkOf = (cell) => {
      const cr = cell.getBoundingClientRect();
      const cs = getComputedStyle(cell);
      const lo = cr.left + parseFloat(cs.paddingLeft);
      const hi = cr.right - parseFloat(cs.paddingRight);
      let min = Infinity, max = -Infinity;
      const consider = (l, r) => {
        l = Math.max(l, lo); r = Math.min(r, hi);
        if (r > l) { if (l < min) min = l; if (r > max) max = r; }
      };
      for (const el of cell.querySelectorAll("*")) {
        const s2 = getComputedStyle(el);
        const painted =
          (s2.backgroundColor && s2.backgroundColor !== "rgba(0, 0, 0, 0)" && s2.backgroundColor !== "transparent") ||
          parseFloat(s2.borderTopWidth) > 0 || parseFloat(s2.borderLeftWidth) > 0 ||
          ["SELECT", "INPUT", "TEXTAREA", "BUTTON"].indexOf(el.tagName) >= 0;
        if (!painted) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) consider(r.left, r.right);
      }
      const wk = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
      let nd;
      while ((nd = wk.nextNode())) {
        if (!nd.nodeValue || !nd.nodeValue.trim()) continue;
        const rg = document.createRange();
        rg.selectNodeContents(nd);
        const rects = rg.getClientRects();
        for (let k = 0; k < rects.length; k++) if (rects[k].width > 0) consider(rects[k].left, rects[k].right);
      }
      return min === Infinity ? null : { left: min, right: max };
    };
    // ★재는 것은 '열별 슬랙' = 칸의 안쪽 폭 − 그 열의 가장 넓은 내용.
    //   왜 경계 간격이 아니라 슬랙인가: 간격 = 앞 열 슬랙 + 패딩 32 이고, 우측정렬 숫자 열은
    //   자기 슬랙이 **앞 간격에 더해져** 정렬 때문에 값이 흔들린다(실측에서 이것 때문에 헤맸다).
    //   슬랙은 정렬과 무관한 그 열의 설계값이다. **슬랙이 전 열에서 같으면 = 사이 공간이 같다.**
    //   슬랙 0 이 이상이며(열폭 = 내용 + 패딩), 그때 모든 경계가 정확히 패딩 32px 가 된다.
    const slack = [];
    for (let k = 0; k < ths.length; k++) {
      // ★슬랙은 '이 열에서 가장 넓은 내용'과의 차이다 → **전 행**을 봐야 한다.
      //   5행 표본으로 재면 6번째 행에 있는 진짜 최대치를 놓쳐 슬랙이 부풀려진다 —
      //   실제로 현금흐름 '계좌' 열은 6번째 행 '증권계좌(김하늘)+증권 배지'(164)가 최대인데
      //   앞 5행만 보고 81 로 재서 슬랙을 +96.8px 로 보고했다(열은 제대로 잡혀 있었다).
      //   F 를 전 행으로 바꿨을 때와 같은 결함이다. (설계 125)
      // ★빈칸 표시('-')만 있는 열은 판정에서 뺀다. (2026-08-02)
      //   '-' 는 **내용이 아니라 내용이 없다는 표시**다. 그런데 폭 5px 짜리 잉크로 잡히는 바람에
      //   슬랙이 '열폭 − 5' 로 부풀어 그 열 하나가 A' 를 통째로 떨어뜨렸다
      //   (통장이동 '메모' +124.8px · 수집함 휴지통 '결제/출금계좌' +180.3px — 둘 다 전 행이 '-').
      //   내용이 아예 없는 열(widest < 0)을 이미 빼고 있었으니, 같은 이유로 여기도 뺀다.
      //   ※이 블록은 브라우저로 보내는 템플릿 문자열 안이다 — 주석에도 백틱을 쓰면 문자열이 끊긴다.
      //   ⚠️열을 좁혀서 풀 수 있는 문제가 아니다: 메모·계좌는 **다음 달이면 값이 찬다** —
      //     빈 달에 맞춰 좁히면 값이 들어온 순간 잘린다(설계 123 위반). 데이터 스냅샷에 맞추지 않는다.
      let widest = -1, inner = 0, allPlaceholder = true;
      for (const tr of cutRows) {
        const cell = tr.children[k];
        if (!cell) continue;
        const ink = inkOf(cell);
        if (!ink) continue;
        const cr = cell.getBoundingClientRect();
        const cs = getComputedStyle(cell);
        inner = cr.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        const w = ink.right - ink.left;
        if (w > widest) widest = w;
        const txt = (cell.textContent ?? "").trim();
        if (txt && txt !== "-" && txt !== "—") allPlaceholder = false;
      }
      slack.push(widest < 0 || allPlaceholder ? null : round(inner - widest)); // null = 판정 제외
    }

    const pads = [], ctrl = [], over = [], cut = [], wrap = [];
    // G·H 용 글자폭 자[尺] — select 는 scrollWidth 가 '가장 긴 option' 이라 못 쓴다(오탐).
    // **선택된 option 의 글자**를 같은 폰트로 직접 재야 실제 잘림을 알 수 있다. (설계 125)
    const ruler = document.createElement("span");
    ruler.style.cssText = "position:absolute;visibility:hidden;white-space:pre;left:-9999px;top:0";
    document.body.appendChild(ruler);
    const textWidth = (el, s) => {
      const cs = getComputedStyle(el);
      ruler.style.font = cs.font; ruler.style.letterSpacing = cs.letterSpacing;
      ruler.textContent = s;
      return ruler.getBoundingClientRect().width;
    };
    const seenMsg = new Set();
    const push = (arr, msg) => { if (!seenMsg.has(msg)) { seenMsg.add(msg); arr.push(msg); } };
    bodyRows.forEach((bodyRow, ri) => [...bodyRow.children].forEach((td, i) => {
      const cs = getComputedStyle(td);
      const pl = round(parseFloat(cs.paddingLeft));
      const pr = round(parseFloat(cs.paddingRight));
      if (ri === 0) pads.push(pl + "/" + pr); // 패딩은 열 속성이라 첫 행만 봐도 된다
      const avail = round(td.getBoundingClientRect().width) - pl - pr;
      const label = ((ths[i] && ths[i].textContent) || (i + 1) + "열").trim().slice(0, 12) || (i + 1) + "열";
      // 셀·컨트롤 단위 면제 — 복합 셀(입력칸 + 단위 라벨 등)은 컨트롤이 셀을 꽉 채울 수 없다.
      const exemptHere = (el) => !!el.closest("[data-uniform-exempt]");
      // C. 폼 컨트롤은 반드시 셀 가용폭을 꽉 채워야 한다(체크박스·라디오는 제외).
      for (const c of td.querySelectorAll("select, textarea, input")) {
        if (c.type === "checkbox" || c.type === "radio" || exemptHere(c)) continue;
        const w = round(c.getBoundingClientRect().width);
        if (Math.abs(w - avail) > 1.5) push(ctrl, label + ": " + c.tagName.toLowerCase() + " " + w + "px (가용 " + avail + "px)");
      }
      // D. 셀 안 어떤 요소도 가용폭을 넘지 않는다.
      for (const c of td.children) {
        if (exemptHere(c)) continue;
        const w = round(c.getBoundingClientRect().width);
        if (w - avail > 1.5) push(over, label + ": " + c.tagName.toLowerCase() + " 가 +" + round(w - avail) + "px 넘침");
      }
      // D-2. ★글자 넘침 — 요소 폭은 셀에 맞는데 안의 텍스트가 넘쳐 옆 칸을 덮는 경우.
      //      truncate(overflow-hidden)가 없는 whitespace-nowrap 셀에서 난다. 요소 폭만 봐서는 안 보인다
      //      (2026-08-01 대출 표에서 실제로 놓쳤다 — 대출명이 출금계좌 위에 겹쳐 그려졌다).
      //      ⚠️ select/input 은 제외한다 — <select> 의 scrollWidth 는 '가장 긴 option' 폭이라
      //      화면에서는 브라우저가 알아서 잘라 주는데도 넘침으로 잡힌다(오탐 확인 2026-08-01 수집함).
      const FORM = ["SELECT", "INPUT", "TEXTAREA", "OPTION"];
      for (const el of [td, ...td.querySelectorAll("*")]) {
        if (FORM.includes(el.tagName) || exemptHere(el)) continue;
        const sw = el.scrollWidth, cw = el.clientWidth;
        if (cw > 0 && sw - cw > 1 && getComputedStyle(el).overflowX === "visible") {
          push(over, label + ": 글자가 +" + (sw - cw) + "px 넘침(truncate 없음)");
          break;
        }
      }
    }));

    // G. ★select 안 '선택된 값'이 잘리지 않는가 — F 는 select 를 제외하므로 이건 별도다. (설계 125)
    // H. ★한 텍스트가 두 줄로 꺾이지 않는가 — 요소를 세로로 쌓은 '의도된 2줄'과 구분해야 하므로
    //    **한 텍스트 노드가 client rect 를 2개 이상 만든 경우**만 센다.
    cutRows.forEach((bodyRow) => [...bodyRow.children].forEach((td, i) => {
      const label = ((ths[i] && ths[i].textContent) || (i + 1) + "열").trim().slice(0, 12) || (i + 1) + "열";
      if (td.closest("[data-uniform-exempt]")) return;
      for (const sel of td.querySelectorAll("select")) {
        const cs = getComputedStyle(sel);
        // ★Chrome 은 기본 화살표 자리를 **padding-right 바깥에 따로 예약**한다 — clientWidth 에서
        //   padding 만 빼면 글자가 실제로 쓸 수 있는 폭보다 넓게 나와 잘림을 놓친다.
        //   2026-08-09 실측: 현금흐름 '출금계좌' select 를 이 계산으로는 '여유 13px' 이라 통과시켰는데
        //   3배 확대 스크린샷에서는 '국민은행(이바다' 처럼 닫는 괄호가 잘려 있었다.
        //   appearance 를 none 으로 끈 select(.hh-select)만 padding 계산이 맞는다.
        //   ⚠️16 은 **이 검사기가 도는 Chrome 기준 실측 보정값**이다(브라우저·확대배율·폰트에 따라 다르다).
        //   보편적인 '가용폭 정의'가 아니라 회귀를 잡기 위한 하한선으로 쓴다 — 값이 실제보다 작으면
        //   잘림을 놓치고, 크면 오탐이 난다. 다른 브라우저로 검사 대상을 넓히면 여기부터 다시 재라.
        const appearance = cs.appearance || cs.webkitAppearance || "auto";
        const ARROW_RESERVE = appearance === "none" ? 0 : 16;
        const inner = sel.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - ARROW_RESERVE;
        const opt = sel.options[sel.selectedIndex];
        if (!opt || inner <= 0) continue;
        const w = textWidth(sel, opt.text);
        if (w - inner > 1) push(wrap, label + ": select 값 \\"" + opt.text.slice(0, 18) + "\\" 가 +" + Math.ceil(w - inner) + "px 잘림");
      }
      const w2 = document.createTreeWalker(td, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = w2.nextNode())) {
        const s = (n.nodeValue || "").trim();
        if (!s) continue;
        const rg = document.createRange(); rg.selectNodeContents(n);
        const rects = [...rg.getClientRects()].filter((r) => r.width > 0);
        // ★줄 수는 rect **개수**가 아니라 서로 다른 top 개수다.
        //   overflow-wrap:anywhere 를 준 텍스트는 **한 줄 안에서도** 여러 inline box 로 쪼개져
        //   rect 가 2개 이상 나온다 — 개수로 세면 멀쩡한 한 줄을 '꺾임'으로 보고한다(오탐 실측:
        //   '카드대금-국민카드-이바다'이 스크린샷에선 한 줄인데 2줄로 보고됐다).
        const lines = new Set(rects.map((r) => Math.round(r.top)));
        if (lines.size > 1) {
          let need = 0; for (const r of rects) need += r.width;
          push(wrap, label + ": \\"" + s.slice(0, 16) + "\\" 가 " + lines.size + "줄로 꺾임(한 줄에 " + Math.ceil(need) + "px 필요)");
          break;
        }
      }
    }));
    ruler.remove();

    // F. ★글자 잘림 0 — truncate(overflow:hidden)로 글자가 실제로 사라진 셀. (설계 123)
    //    D-2 는 overflowX==='visible' 만 보므로 이건 통째로 사각지대였다.
    //    ★B·C·D 와 달리 **전 행**을 훑는다 — 잘림은 열 속성이 아니라 '그 행의 값' 속성이다.
    cutRows.forEach((bodyRow) => [...bodyRow.children].forEach((td, i) => {
      const cs = getComputedStyle(td);
      const pl = round(parseFloat(cs.paddingLeft));
      const pr = round(parseFloat(cs.paddingRight));
      const avail = round(td.getBoundingClientRect().width) - pl - pr;
      const label = ((ths[i] && ths[i].textContent) || (i + 1) + "열").trim().slice(0, 12) || (i + 1) + "열";
      const exemptHere = (el) => !!el.closest("[data-uniform-exempt]");
      const FORM = ["SELECT", "INPUT", "TEXTAREA", "OPTION"];
      for (const el of [td, ...td.querySelectorAll("*")]) {
        if (FORM.includes(el.tagName) || exemptHere(el)) continue;
        const sw = el.scrollWidth, cw = el.clientWidth;
        if (cw > 0 && sw - cw > 1 && getComputedStyle(el).overflowX !== "visible") {
          const short = sw - cw;
          // 열이 좁은 건지 안쪽 요소가 좁은 건지 가른다.
          //   자연폭 = 지금 칠해지는 폭(ink, 셀 경계로 클립됨) + 잘려 나간 폭.
          //   ★'avail - clientWidth' 로 가르면 안 된다 — 아이콘·배지 같은 형제 요소가
          //     자리를 먹은 만큼을 '남는 자리'로 착각해 열이 좁은데도 "충분"이라 답한다(실측 오진).
          const tdInk = inkOf(td);
          const nat = (tdInk ? tdInk.right - tdInk.left : cw) + short;
          push(cut, label + ": 글자 " + short + "px 잘림 → " + (nat > avail + 1
            ? "열을 " + Math.ceil(nat + pl + pr) + "px 로(현재 " + round(td.getBoundingClientRect().width) + ")"
            : "★열은 충분(가용 " + round(avail) + "), 셀 안쪽 요소가 좁다"));
          break;
        }
      }
    }));
    return { sig, exempt, slackExempt, cols, pads, ctrl, over, cut, wrap, rowsSeen: bodyRows.length, slack, headWrap, clip };
  });
})()`;

const violations: Violation[] = [];
const exempted: string[] = [];
let tablesChecked = 0;
let rowlessTables = 0; // 본문 행을 못 본 표 — B·C·D 가 공회전한 것이므로 반드시 보고한다
let browser: Browser | null = null;
try {
  const launched = await launch(); // ★try 안에서 띄운다 — 밖에서 던지면 finally 를 안 타 서버가 남는다
  browser = launched.browser;
  const page: Page = await browser.newPage();
  for (const vw of VIEWPORTS) {
    await page.setViewportSize({ width: vw, height: 1200 });
    if (vw === VIEWPORTS[0]) {
      await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
      await page.waitForSelector('button[type="submit"]:not([disabled])', { timeout: 30_000 });
      await page.waitForTimeout(600);
      await page.fill("#loginId", LOGIN_ID);
      await page.fill("#password", env.E2E_LOGIN_PASSWORD);
      await page.click('button[type="submit"]');
      await page.waitForURL(/\/dashboard/, { timeout: 40_000 });
      console.log(`▶ 로그인 OK · ${launched.which} · 대상 ${routes.length}개 화면 · 뷰포트 ${VIEWPORTS.join("/")}px\n`);
    }
    console.log(`── ${vw}px 검사`);

    for (const route of routes) {
      await page.goto(`${BASE}${route}`, { waitUntil: "networkidle" });
      await page.waitForTimeout(1200);
      // 탭이 있으면 하나씩 눌러 숨은 표까지 본다. 없으면 1회.
      const tabs = await page.getByRole("tab").all();
      // ★중복 제거 키에 탭 이름을 넣는다 — 헤더 문자열만 쓰면 '탭마다 헤더가 같은 다른 표'가
      //   첫 탭 이후 통째로 건너뛰어지는데도 exit 0 이 나간다(교차리뷰 지적: Codex).
      const seen = new Set<string>();
      const keyOf = (sig: string, tab: string) => `${tab}|${sig}`;
      for (let ti = 0; ti < Math.max(tabs.length, 1); ti++) {
        let tabName = "-";
        if (tabs.length) {
          try {
            tabName = ((await tabs[ti].textContent()) || "-").trim().slice(0, 20);
            await tabs[ti].click({ timeout: 5000 });
            await page.waitForTimeout(900);
          } catch { continue; }
        }
        const measured = (await page.evaluate(MEASURE)) as Measured[];
        for (const m of measured) {
          if (seen.has(keyOf(m.sig, tabName))) continue; // 같은 탭에서 같은 표를 두 번 세지 않는다
          seen.add(keyOf(m.sig, tabName));
          if (m.exempt) {
            const line = `${route} · ${m.sig} — 이유: ${m.exempt}`;
            if (!exempted.includes(line)) exempted.push(line);
            continue;
          }
          if (m.cols.length < 3) continue; // 3열 미만은 표라기보다 레이아웃
          tablesChecked++;
          if (m.rowsSeen === 0) rowlessTables++;
          const add = (kind: string, detail: string) =>
            violations.push({ route: `${route} @${vw}px`, tab: tabName, table: m.sig, kind, detail });
          // A'. 내용(ink) 사이 간격이 균일한가 — 이번 규칙(설계 122)의 본체.
          //   ★열 폭이 아니라 간격을 본다. 열 폭 균등은 설계 120·121 의 낡은 판정이었고,
          //     그걸로 "위반 0"이 나오는 상태에서 팀장 지적이 5차·6차로 계속 왔다.
          //   경계마다 **행들의 최소 간격**을 쓴다: 우측정렬 숫자는 자릿수에 따라 왼쪽 여백이
          //   달라지는데(정상), 최소값은 그 열의 가장 긴 내용일 때 = 설계상 의도한 간격이다.
          //   그 최소 간격들이 경계마다 다르면 = 어떤 칸만 늘 크게 빈 구조적 어긋남이다.
          const sl = m.slackExempt ? [] : m.slack.filter((x): x is number => x != null);
          if (m.slackExempt) {
            const line = `${route} · ${m.sig} — A' 만 면제, 이유: ${m.slackExempt}`;
            if (!exempted.includes(line)) exempted.push(line);
          }
          if (sl.length >= 2) {
            const spread = Math.round((Math.max(...sl) - Math.min(...sl)) * 10) / 10;
            if (spread > GAP_TOL_PX) {
              const worst = m.slack
                .map((x, k) => ({ k, x }))
                .filter((e): e is { k: number; x: number } => e.x != null)
                .sort((a, b) => b.x - a.x).slice(0, 3)
                .map((e) => `${(m.sig.split(" | ")[e.k] ?? `${e.k + 1}열`).trim()} +${e.x}px`);
              add("A' 열별 슬랙 불균등",
                `최대-최소 ${spread}px (허용 ${GAP_TOL_PX}px) — 넓은 쪽 ${worst.join(" / ")} · 전체 ${m.slack.join(", ")}`);
            }
          }
          if (new Set(m.pads).size > 1) add("B 셀 패딩 불일치", `좌/우 ${m.pads.join(", ")}`);
          if (m.ctrl.length) add("C 컨트롤이 w-full 아님", m.ctrl.join(" · "));
          if (m.over.length) add("D 칸 넘침", m.over.join(" · "));
          // I. 표가 껍데기를 넘어 오른쪽 열이 잘린다(2026-08-11 신설). data-uniform-exempt 만 면제.
          if (m.clip) add("I 표가 껍데기 넘침", m.clip);
          if (m.headWrap.length) add("E 헤더 줄바꿈", `${m.headWrap.join(" · ")} — 그 열을 한 슬롯 넓히거나 헤더 문구를 줄일 것`);
          if (m.wrap.length) add("G/H 잘림·줄꺾임", `${m.wrap.join(" · ")} — 그 열을 필요폭 이상 슬롯으로 넓히거나 표시 문자열을 줄일 것 (설계 125)`);
          if (m.cut.length) add("F 글자 잘림", `${m.cut.join(" · ")} — truncate 말고 HH_CELL.wrapText 로 줄바꿈할 것 (설계 123)`);
        }
      }
    }
  }
} finally {
  if (browser) await browser.close();
  stopServer();
}

// ── 결과 ───────────────────────────────────────────────────────────────────
console.log(`표 ${tablesChecked}개 검사 / 위반 ${violations.length}건`);
// ★"검사한 표가 0개"는 통과가 아니라 검사 실패다 — ONLY 오타·로그인 실패·라우트 변경이면
//   조용히 exit 0 이 나가 게이트가 거짓말을 한다(교차리뷰 지적).
if (tablesChecked === 0) {
  console.error(`❌ 검사한 표가 0개다. ONLY(${ONLY ?? "-"}) 오타이거나 화면이 안 그려졌을 수 있다 — 통과로 치지 않는다.`);
  stopServer();
  process.exit(1);
}
// 본문 행을 못 본 표는 B·C·D 가 공회전한 것이다. 막지는 않되 몇 개인지 반드시 알린다(조용한 누락 금지).
if (rowlessTables) console.log(`  ⚠️ 본문 행이 없어 A(열 폭)만 본 표 ${rowlessTables}개 — 데이터가 있는 상태로 다시 돌려 볼 것`);
if (dynamic.length) console.log(`  ⓘ 동적 라우트 ${dynamic.length}개는 열 수 없어 건너뜀: ${dynamic.join(", ")}`);
if (exempted.length) { console.log(`  ⓘ 면제된 표 ${exempted.length}개:`); for (const e of exempted) console.log(`     - ${e}`); }
if (violations.length) {
  console.log("");
  for (const v of violations) {
    console.log(`❌ ${v.route}${v.tab !== "-" ? ` [${v.tab}]` : ""}`);
    console.log(`   표: ${v.table}`);
    console.log(`   ${v.kind} — ${v.detail}`);
  }
  console.log("\n고치는 법 (CLAUDE.md 'UI Pattern: 표 컬럼 폭'):");
  console.log("  A' 슬랙   : 열 폭을 내용에 맞춰 HH_COL 척도에서 고른다(균등 분할은 설계 122 에서 폐기).");
  console.log("  B 패딩    : 한 표 안에서 px-2/px-4 를 섞지 않는다(전부 px-4).");
  console.log("  C 컨트롤  : select·input 은 w-full. 고정폭(w-16·w-28)과 min-w-* 를 지운다.");
  console.log("  D 넘침    : <button> 은 flex 여도 폭이 fit-content 다 — w-full 을 같이 준다.");
  console.log("  E 헤더    : 열이 헤더보다 좁다 — 한 슬롯 넓히거나 헤더 문구를 줄인다.");
  console.log("  F 잘림    : ★truncate 금지. HH_CELL.wrapText 로 줄바꿈시킨다(설계 123).");
  console.log("             폭으로만 풀려 하지 마라 — 사람이 짓는 이름은 길이 상한이 없다.");
  console.log("  I 껍데기  : 표가 껍데기보다 넓어 오른쪽 열이 잘린다. ★가로 스크롤은 해법이 아니다 —");
  console.log("             부모엔 자리가 있는데 껍데기만 좁다는 뜻이므로 **레이아웃**을 고친다");
  console.log("             (2단을 끄거나 단 폭을 늘린다). 열을 줄여 표를 좁히는 건 줄꺾임과");
  console.log("             맞바꾸는 것이니 G/H 를 함께 보고 정할 것 (설계 162 ⑨).");
  console.log("  진짜 예외면 <table> 에 data-uniform-exempt=\"<이유>\" 를 단다(남용 금지).");
}
process.exit(violations.length === 0 ? 0 : 1);
