// `npm run dev` 시작 시 기본 로그인 정보를 눈에 띄게 보여주는 배너입니다.
// (package.json 의 predev 로 자동 실행됩니다. 강의/학습용 고정 계정 안내용.)

import { readFileSync } from "node:fs";

const C = {
  reset: "\x1b[0m", bold: "\x1b[1m",
  cyan: "\x1b[36m", yellow: "\x1b[33m", green: "\x1b[32m", gray: "\x1b[90m",
};

const line = "════════════════════════════════════════════";
console.log("");
console.log(C.cyan + line + C.reset);
console.log(C.cyan + "  🔑  " + C.bold + "킹스가계부 기본 로그인" + C.reset + C.gray + "  (강의용 고정 계정)" + C.reset);
console.log(C.cyan + "  ──────────────────────────────────────" + C.reset);
console.log("      👤  ID  :  " + C.bold + C.yellow + "admin" + C.reset);
// .env.local 에 E2E_LOGIN_PASSWORD 가 있으면 비번을 바꾼 것이므로 값을 찍지 않고 출처만 안내한다.
let pwLine = C.bold + C.yellow + "jadong!" + C.reset + C.gray + "  (설치 기본값)" + C.reset;
try {
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  if (/^E2E_LOGIN_PASSWORD=.+$/m.test(raw)) pwLine = C.gray + "변경된 비밀번호 사용 중 (.env.local 의 E2E_LOGIN_PASSWORD)" + C.reset;
} catch { /* .env.local 없으면 기본값 안내 유지 */ }
console.log("      🔒  PW  :  " + pwLine);
console.log(C.cyan + line + C.reset);
console.log("  🌐  " + C.green + "http://localhost:3000" + C.reset + " 에서 위 정보로 로그인하세요.");
console.log("  👉  " + C.bold + "로그인 후" + C.reset + " 왼쪽 사이드바 맨 아래 " + C.bold + "'내 이름'" + C.reset +
  " 클릭 → 마이페이지에서 " + C.bold + "비밀번호를 꼭 변경" + C.reset + "하세요!");
console.log("");
