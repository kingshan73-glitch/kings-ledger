// 엑셀/표 붙여넣기 + 명세서 파싱 공용 헬퍼.
// 엑셀 클립보드는 셀=탭(\t), 행=개행(\n). 명세서 CSV/XLSX도 2차원 배열로 환원해 같은 헬퍼를 쓴다.

import type { HhAccount, HhCategory, HhPaymentMethod } from "@/lib/household/types";

/** 클립보드/CSV 텍스트 → 2차원 배열. 빈 줄은 제거. */
export function splitMatrix(text: string): string[][] {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => line.split("\t").map((c) => c.trim()));
}

/** 다양한 날짜 표기 → YYYY-MM-DD. 실패 시 "". 연도 없으면 올해로 보정. */
export function parseDate(raw: string): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  // YYYY-MM-DD / YYYY.MM.DD / YYYY/MM/DD
  let m = s.match(/(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  // YYYYMMDD
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // M/D/YY 또는 M/D/YYYY (엑셀이 CSV 날짜를 이 형식으로 변환) → 월/일/연
  m = s.match(/^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})$/);
  if (m) {
    const yy = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${yy}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  // MM/DD or MM-DD → 연도 없음. 보통 가까운 과거(명세서·문자) 거래이므로
  // 올해로 봤을 때 오늘보다 미래면 작년으로 보정한다.
  m = s.match(/^(\d{1,2})[.\-/](\d{1,2})$/);
  if (m) {
    const mm = m[1].padStart(2, "0");
    const dd = m[2].padStart(2, "0");
    const now = new Date();
    let y = now.getFullYear();
    const candidate = new Date(`${y}-${mm}-${dd}T00:00:00`);
    if (Number.isFinite(candidate.getTime()) && candidate.getTime() > now.getTime()) y -= 1;
    return `${y}-${mm}-${dd}`;
  }
  return "";
}

/** 콤마·원·통화기호·공백 제거 후 정수. 음수/0/실패는 0. */
export function parseAmount(raw: string): number {
  const s = (raw ?? "").replace(/[^0-9.\-]/g, "");
  if (!s) return 0;
  const n = Math.trunc(Number(s));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function findByName<T extends { id: string; name: string }>(name: string, list: T[]): string | null {
  const s = (name ?? "").trim();
  if (!s) return null;
  const exact = list.find((x) => x.name === s);
  if (exact) return exact.id;
  const partial = list.find((x) => x.name.includes(s) || s.includes(x.name));
  return partial?.id ?? null;
}

export const findCategoryId = (name: string, cats: HhCategory[]) => findByName(name, cats);
export const findAccountId = (name: string, accs: HhAccount[]) => findByName(name, accs);
export const findMethodId = (name: string, ms: HhPaymentMethod[]) => findByName(name, ms);

/** 붙여넣기 행 상한 — 조용한 truncation 금지(초과분은 호출부에서 토스트). */
export const MAX_PASTE_ROWS = 500;

/** 첫 행이 헤더로 보이는지(지정한 금액 열이 숫자로 파싱 안 되면 헤더). */
export function looksLikeHeader(firstRow: string[], amountIdx: number): boolean {
  const cell = firstRow[amountIdx];
  if (cell == null) return false;
  return parseAmount(cell) === 0 && /[가-힣A-Za-z]/.test(cell);
}
