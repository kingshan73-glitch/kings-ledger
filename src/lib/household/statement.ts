// 명세서 파일(.csv/.xlsx) → 거래 후보 파싱. 모두 브라우저에서 처리(외부 전송 없음).
import * as XLSX from "xlsx";

import { parseAmount, parseDate } from "@/lib/household/paste";

export type StatementSheet = { headers: string[]; rows: string[][] };

/** 한 줄 CSV 파싱(따옴표 안 콤마 보존). */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQuote = false;
      } else cur += ch;
    } else if (ch === '"') inQuote = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

/** 파일의 첫 시트를 2차원 배열로. 첫 행을 헤더로 본다.
 * ⚠️ CSV는 xlsx를 거치면 날짜가 'M/D/YY'로 자동 변환되므로 텍스트로 직접 파싱한다. */
export async function readStatementFile(file: File): Promise<StatementSheet> {
  const isCsv = /\.csv$/i.test(file.name) || file.type.includes("csv");
  let matrix: string[][];
  if (isCsv) {
    const text = (await file.text()).replace(/^﻿/, "").replace(/\r\n?/g, "\n");
    matrix = text.split("\n").map((l) => parseCsvLine(l));
  } else {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const sheetName = wb.SheetNames[0];
    if (!sheetName) return { headers: [], rows: [] };
    const ws = wb.Sheets[sheetName];
    const raw = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: false, raw: false, defval: "" });
    matrix = raw.map((r) => (r ?? []).map((c) => String(c ?? "").trim()));
  }
  const cleaned = matrix.map((r) => r.map((c) => String(c ?? "").trim()));
  const nonEmpty = cleaned.filter((r) => r.some((c) => c !== ""));
  if (nonEmpty.length === 0) return { headers: [], rows: [] };
  return { headers: nonEmpty[0], rows: nonEmpty.slice(1) };
}

export type ColumnMapping = {
  dateCol: number;
  amountCol: number;
  merchantCol: number;
  typeCol: number | null; // 입금/출금 구분 컬럼(없으면 defaultType)
  defaultType: "income" | "expense";
};

export type ParsedStatementRow = {
  date: string;
  amount: number;
  merchant: string;
  type: "income" | "expense";
  raw: string;
};

const INCOME_HINT = /입금|수입|\+|입력|받음/;
const CANCEL_HINT = /취소|승인취소|반품|환불/;

/** 헤더명으로 컬럼 위치 자동 추정. 못 찾으면 -1. */
export function autoDetectMapping(headers: string[]): ColumnMapping {
  const find = (re: RegExp) => headers.findIndex((h) => re.test(h));
  const dateCol = find(/일자|날짜|거래일|이용일|승인일|date/i);
  const amountCol = find(/금액|이용금액|출금|입금|amount|원/i);
  const merchantCol = find(/가맹점|내용|적요|상호|이용처|내역|merchant|상점/i);
  const typeCol = find(/구분|입출금|유형|type/i);
  return {
    dateCol: dateCol >= 0 ? dateCol : 0,
    amountCol: amountCol >= 0 ? amountCol : 1,
    merchantCol: merchantCol >= 0 ? merchantCol : 2,
    typeCol: typeCol >= 0 ? typeCol : null,
    defaultType: "expense",
  };
}

/** 매핑에 따라 후보행 생성. 금액<=0·취소건은 제외. */
export function mapStatementRows(rows: string[][], m: ColumnMapping): { parsed: ParsedStatementRow[]; skipped: number } {
  let skipped = 0;
  const parsed: ParsedStatementRow[] = [];
  for (const r of rows) {
    const rawMerchant = (r[m.merchantCol] ?? "").trim();
    const date = parseDate(r[m.dateCol] ?? "");
    const amount = parseAmount(r[m.amountCol] ?? "");
    if (amount <= 0 || !date) { skipped++; continue; }
    if (CANCEL_HINT.test(rawMerchant)) { skipped++; continue; }
    let type: "income" | "expense" = m.defaultType;
    if (m.typeCol != null) type = INCOME_HINT.test(r[m.typeCol] ?? "") ? "income" : "expense";
    parsed.push({ date, amount, merchant: rawMerchant, type, raw: r.join(" | ") });
  }
  return { parsed, skipped };
}

// 소스(file/manual/sms)와 무관하게 같은 거래를 중복으로 잡도록 소스 접미사를 넣지 않는다.
// (수동 입력 후 같은 거래가 명세서로 또 들어오는 이중 수집을 막는다)
export function dedupHash(p: ParsedStatementRow): string {
  return `${p.date}|${p.amount}|${p.merchant}`;
}
