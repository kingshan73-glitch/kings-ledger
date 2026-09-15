"use client";

import * as React from "react";

import { Input } from "@/components/ui/input";

/**
 * 원 단위 금액 입력 — 콤마 실시간 표시. (설계 docs/household/60 R1)
 * - type=text + inputMode=numeric: 모바일 숫자 키패드, 스핀버튼·휠 오입력 방지.
 * - 내부값은 number(원). 0이면 빈칸으로 표시(placeholder 노출).
 * - 숫자 외 문자는 입력 즉시 제거, 최대 12자리.
 *
 * allowFormula(설계 72): 엑셀처럼 `=3+5+70` 같은 사칙연산 식을 입력하면 합계로 계산.
 * 이자 수입처럼 작은 금액이 여러 번 들어올 때 합산 입력용. 수식 입력 중엔 아래에
 * 계산 결과를 미리 보여주고, 값은 실시간으로 반영된다(빈 식·오류 시 직전 값 유지).
 */

// 수식 판정: 사칙연산자(+ - * /)가 있거나 '='로 시작하면 수식으로 본다.
function isFormulaText(v: string): boolean {
  return /[+\-*/]/.test(v) || v.trimStart().startsWith("=");
}

/**
 * 안전한 사칙연산 평가. 허용 문자(숫자·+ - * / ( ) . 콤마·공백)만 통과시키고
 * 결과는 반올림 정수(원)로 돌려준다. 빈 식·문법오류·음수·비정상값은 null.
 */
export function evalAmountFormula(expr: string): number | null {
  const cleaned = expr.replace(/^\s*=/, "").replace(/,/g, "").trim();
  if (!cleaned) return null;
  // 허용 문자만 있는지 먼저 검사 → new Function 으로 임의코드 실행 여지 차단.
  if (!/^[0-9+\-*/().\s]+$/.test(cleaned)) return null;
  try {
    const result = new Function(`return (${cleaned});`)() as unknown;
    if (typeof result !== "number" || !Number.isFinite(result) || result < 0) return null;
    return Math.round(result);
  } catch {
    return null;
  }
}

export function AmountInput({
  value,
  onValueChange,
  allowFormula = false,
  className,
  ...props
}: Omit<React.ComponentProps<typeof Input>, "type" | "value" | "onChange"> & {
  value: number;
  onValueChange: (n: number) => void;
  /** 엑셀식 수식(=3+5+70) 합계 입력 허용 (설계 72). 기본 false. */
  allowFormula?: boolean;
}) {
  // 수식 편집 중 원문 버퍼. null 이면 콤마 표시(숫자 모드).
  const [draft, setDraft] = React.useState<string | null>(null);

  if (!allowFormula) {
    return (
      <Input
        type="text"
        inputMode="numeric"
        autoComplete="off"
        className={className}
        value={value === 0 ? "" : value.toLocaleString("ko-KR")}
        onChange={(e) => {
          const digits = e.target.value.replace(/\D/g, "").slice(0, 12);
          onValueChange(digits ? parseInt(digits, 10) : 0);
        }}
        {...props}
      />
    );
  }

  const showingFormula = draft !== null && isFormulaText(draft);
  const preview = showingFormula ? evalAmountFormula(draft) : null;
  const display = draft !== null ? draft : value === 0 ? "" : value.toLocaleString("ko-KR");

  return (
    <div className="space-y-1">
      <Input
        type="text"
        inputMode="numeric"
        autoComplete="off"
        className={className}
        value={display}
        onChange={(e) => {
          const v = e.target.value;
          if (isFormulaText(v)) {
            // 수식 모드: 원문을 그대로 유지하고, 계산 가능하면 값을 실시간 반영.
            setDraft(v);
            const n = evalAmountFormula(v);
            if (n !== null) onValueChange(n);
          } else {
            // 순수 숫자: 콤마 표시로 복귀하고 즉시 반영.
            setDraft(null);
            const digits = v.replace(/\D/g, "").slice(0, 12);
            onValueChange(digits ? parseInt(digits, 10) : 0);
          }
        }}
        onKeyDown={(e) => {
          // 수식 입력 중 Enter 는 폼 제출 대신 확정(콤마 표시로 정리).
          if (e.key === "Enter" && draft !== null) {
            e.preventDefault();
            setDraft(null);
          }
        }}
        onBlur={() => setDraft(null)}
        {...props}
      />
      {showingFormula ? (
        <p className={`text-xs ${preview !== null ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}`}>
          {preview !== null ? `= ${preview.toLocaleString("ko-KR")}원` : "계산할 수 없는 식입니다"}
        </p>
      ) : null}
    </div>
  );
}
