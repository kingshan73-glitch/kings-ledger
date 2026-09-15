"use client";

import { useMemo } from "react";

import { Masked } from "@/components/masked";
import { cn } from "@/lib/utils";
import type { HhTransaction } from "@/lib/household/types";

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

interface Props {
  month: string; // 'YYYY-MM'
  txns: HhTransaction[]; // 해당 월의 거래(income/expense). 실거래 기준.
}

/**
 * 당월 실거래 입금/지출 달력. (설계 docs/household/28)
 * 예정 기반 CashflowCalendar 와 달리 **이미 등록된 거래**만 날짜별로 합산해 보여준다.
 */
export function DailyTxnCalendar({ month, txns }: Props) {
  const byDay = useMemo(() => {
    const map = new Map<number, { income: number; expense: number }>();
    for (const t of txns) {
      if (t.txn_date.slice(0, 7) !== month) continue;
      if (t.type !== "income" && t.type !== "expense") continue;
      const day = Number(t.txn_date.slice(8, 10));
      if (!day) continue;
      const cur = map.get(day) ?? { income: 0, expense: 0 };
      if (t.type === "income") cur.income += t.amount;
      else cur.expense += t.amount;
      map.set(day, cur);
    }
    return map;
  }, [txns, month]);

  const monthIncome = useMemo(() => [...byDay.values()].reduce((s, d) => s + d.income, 0), [byDay]);
  const monthExpense = useMemo(() => [...byDay.values()].reduce((s, d) => s + d.expense, 0), [byDay]);
  // 지출 규모 비례 바(설계 80 규칙 5) — 숫자 색 대신 길이로 많이 쓴 날이 드러나게.
  const maxExpense = useMemo(() => Math.max(0, ...[...byDay.values()].map((d) => d.expense)), [byDay]);

  const [year, mon] = month.split("-").map(Number);
  const firstWeekday = new Date(year, mon - 1, 1).getDay();
  const daysInMonth = new Date(year, mon, 0).getDate();

  const today = new Date();
  const todayDay = today.getFullYear() === year && today.getMonth() + 1 === mon ? today.getDate() : -1;

  const cells: (number | null)[] = [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];

  return (
    <div className="rounded-2xl border border-border/70 bg-card/85 p-4 shadow-sm">
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <span className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400">● 입금 <Masked category="income_amount">{monthIncome.toLocaleString("ko-KR")}</Masked>원</span>
        <span className="inline-flex items-center gap-1 text-foreground">● 지출 <Masked category="expense_amount">{monthExpense.toLocaleString("ko-KR")}</Masked>원</span>
        {/* 지출 페이지 '기간 소비지출'과 다른 이유를 명시 — 할부 청구분은 날짜가 없는 가상 항목이라 달력엔 못 싣는다. */}
        <span className="text-muted-foreground">(일시불 실거래 기준 · 할부 청구분 제외라 지출 화면 합계와 다를 수 있음)</span>
      </div>

      <div className="grid grid-cols-7 gap-1 text-center text-xs font-medium text-muted-foreground">
        {WEEKDAYS.map((w, i) => (
          <div key={w} className={cn("py-1", i === 0 && "text-rose-500", i === 6 && "text-sky-500")}>{w}</div>
        ))}
      </div>

      <div className="mt-1 grid grid-cols-7 gap-1">
        {cells.map((day, idx) => {
          if (day == null) return <div key={`e${idx}`} className="min-h-16 rounded-lg" />;
          const d = byDay.get(day);
          const isToday = day === todayDay;
          return (
            <div
              key={day}
              className={cn(
                "min-h-16 rounded-lg border border-border/50 bg-background/40 p-1 text-left",
                isToday && "border-primary/60 bg-primary/5 ring-1 ring-primary/30"
              )}
            >
              <div className={cn("text-[11px] font-medium tabular-nums", isToday && "text-primary")}>{day}</div>
              {d && d.income > 0 ? (
                <div className="mt-0.5 truncate text-[10px] tabular-nums text-blue-600 dark:text-blue-400">+<Masked category="income_amount">{d.income.toLocaleString("ko-KR")}</Masked></div>
              ) : null}
              {d && d.expense > 0 ? (
                <>
                  <div className="truncate text-[10px] tabular-nums text-muted-foreground">-<Masked category="expense_amount">{d.expense.toLocaleString("ko-KR")}</Masked></div>
                  <div className="mt-1 h-0.5 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-foreground/35" style={{ width: `${Math.max(8, Math.round((d.expense / (maxExpense || 1)) * 100))}%` }} />
                  </div>
                </>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
