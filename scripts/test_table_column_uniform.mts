// 표 컬럼 폭 척도 검사 (설계 122, 팀장 지시 2026-08-01 6차)
//
// ★규칙이 바뀌었다. 예전(설계 120)에는 "전 컬럼이 100/n% 로 같은가"를 봤다.
//   그 규칙 자체가 오해였다 — 팀장이 보는 것은 열 폭이 아니라 **내용 사이의 여백**이고,
//   열을 같게 하면 날짜(44px)·체크박스(16px) 옆에만 130~250px 공백이 남아 오히려 어긋난다.
//   지금 규칙: **열 폭은 내용에 맞추고(HH_COL 척도), 내용 사이 공간을 같게 한다.**
//
// 이 정적 검사가 보는 것(소스만 — DB·서버 불필요):
//   A. `w-[N%]` 로 열 폭을 주지 않았는가        — % 폭은 내용과 무관하게 칸을 늘린다
//   B. 열 폭 숫자가 전부 `HH_COL.*` 인가         — 척도 밖 px 가 표마다 쌓이는 걸 막는다
//   C. `min-w-[Npx]` 를 손으로 적지 않았는가     — 고정폭 합과 어긋나면 가변 열이 0px 로 눌린다
//
// ★척도 값은 **원천(hh-board.tsx)에서 읽는다.** 여기에 상수를 복사해 두면 척도가 바뀔 때
//   검사기가 조용히 옛 값을 통과시킨다(RULES.md Rule 7).
//
// 화면에 실제로 그려진 간격은 이 검사로 알 수 없다 → `npm run test:table-render` 가 맡는다.
//   (설계 121 교훈 8: "위반 0"은 검사기가 보는 것에 대한 답일 뿐이다.)
//
// 예외: 파일 상단에 `// table-width-exempt: <이유>` 를 적으면 그 파일은 건너뛴다(이유 필수).
//
// 실행: npm run test:table-width
import fs from "node:fs";
import path from "node:path";

const ROOTS = ["src/app/dashboard", "src/components"];
const SCALE_FILE = "src/components/household/hh-board.tsx";

// ── 척도를 원천에서 읽는다 ─────────────────────────────────────────────────
const scaleSrc = fs.readFileSync(SCALE_FILE, "utf8");
const scaleBlock = scaleSrc.match(/export const HH_COL = \{([\s\S]*?)\n\} as const;/);
if (!scaleBlock) {
  console.error(`❌ ${SCALE_FILE} 에서 HH_COL 을 찾지 못했습니다. 척도 정의가 바뀌었다면 이 검사기도 고쳐야 합니다.`);
  process.exit(1);
}
const SCALE = new Map<string, number>();
for (const m of scaleBlock[1].matchAll(/^\s*(\w+):\s*(\d+),/gm)) SCALE.set(m[1], Number(m[2]));
if (SCALE.size === 0) {
  console.error("❌ HH_COL 에서 슬롯을 하나도 읽지 못했습니다(형식이 바뀌었을 수 있습니다).");
  process.exit(1);
}
const SCALE_PX = new Set(SCALE.values());
const SCALE_DESC = [...SCALE].map(([k, v]) => `${k}=${v}px`).join(" · ");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}
const files: string[] = [];
for (const r of ROOTS) if (fs.existsSync(r)) walk(r, files);

type Violation = { file: string; line: number; kind: string; detail: string };
const violations: Violation[] = [];
const exempted: string[] = [];
let filesScanned = 0;
let widthDecls = 0;

for (const file of files.sort()) {
  const src = fs.readFileSync(file, "utf8");
  const rel = file.split(path.sep).join("/");
  const exemptNote = src.match(/\/\/ table-width-exempt:\s*(.+)/);
  if (exemptNote) { exempted.push(`${rel} — 이유: ${exemptNote[1].trim()}`); continue; }
  // 표가 없는 파일은 셈에서 뺀다(표 파일만 세야 "0개 검사"를 실패로 잡을 수 있다).
  if (!/<table|<colgroup|HhBoard|BulkColumn|SimpleCol/.test(src)) continue;
  filesScanned++;

  const lines = src.split(/\r?\n/);
  lines.forEach((line, i) => {
    const at = i + 1;
    // 주석 안의 예시("예전엔 w-[25%] 였다")는 위반이 아니다.
    const code = line.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");

    // A. 퍼센트 폭 — <col>·<th>·컬럼 정의 어디에 있든 안 된다.
    if (/(?:<col\b|<th\b|className:)[^\n]*\bw-\[[\d.]+%\]/.test(code)) {
      violations.push({ file: rel, line: at, kind: "A 퍼센트 폭",
        detail: `${code.trim().slice(0, 90)} → HH_COL 척도(px)로 바꾸거나, 가변 열이면 폭을 생략할 것` });
    }

    // B. 척도 밖 px — `width: 120` 같은 날숫자.
    for (const m of code.matchAll(/\bwidth:\s*(\d+)\b/g)) {
      widthDecls++;
      if (!SCALE_PX.has(Number(m[1]))) {
        violations.push({ file: rel, line: at, kind: "B 척도 밖 px",
          detail: `width: ${m[1]} — 척도(${SCALE_DESC})에 없다. 골라 쓰거나, 새 종류면 HH_COL 에 실측 근거와 함께 추가할 것` });
      }
    }
    // HH_COL.x 로 준 것은 정상 — 선언 수만 센다(검사가 공회전하지 않았는지 확인용).
    widthDecls += [...code.matchAll(/\bwidth:\s*HH_COL\.\w+/g)].length;

    // C. 손으로 적은 표 최소폭.
    if (/<table\b[^\n]*\bmin-w-\[\d+px\]/.test(code) || /minWidth[:=]\s*"min-w-\[/.test(code)) {
      violations.push({ file: rel, line: at, kind: "C 손으로 적은 최소폭",
        detail: `${code.trim().slice(0, 90)} → tableMinWidth(cols) 로 계산할 것(고정폭 합과 어긋나면 가변 열이 눌린다)` });
    }
  });
}

// ── 결과 ───────────────────────────────────────────────────────────────────
console.log(`척도: ${SCALE_DESC}  (원천 ${SCALE_FILE})`);
console.log(`표 파일 ${filesScanned}개 검사 / 열 폭 선언 ${widthDecls}건 / 위반 ${violations.length}건`);
if (exempted.length) {
  console.log(`\n면제 ${exempted.length}건`);
  for (const e of exempted) console.log(`  · ${e}`);
}
// ★"검사한 파일이 0개"는 통과가 아니라 검사 실패다(경로 변경·정규식 오타를 초록으로 넘기지 않는다).
if (filesScanned === 0 || widthDecls === 0) {
  console.error(`\n❌ 검사가 공회전했다 — 표 파일 ${filesScanned}개 / 폭 선언 ${widthDecls}건. 통과로 치지 않는다.`);
  process.exit(1);
}
if (violations.length) {
  console.error("");
  for (const v of violations) console.error(`❌ ${v.file}:${v.line}  [${v.kind}] ${v.detail}`);
  console.error(`\n${violations.length}건. 열 폭은 HH_COL 척도(px)로만 주고, 길이를 예측할 수 없는 열은 폭을 생략한다. (설계 122)`);
  process.exit(1);
}
console.log("\n✅ 열 폭이 전부 척도 안에 있습니다. 화면에 그려진 간격은 npm run test:table-render 로 확인하세요.");
