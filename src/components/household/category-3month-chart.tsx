// 최근 3개월 카테고리별 지출 비교 막대그래프 (설계 90 §2)
//
// 원래 통계 '월간' 탭에 있던 것을 팀장 지시로 '요약' 탭으로 옮기면서 컴포넌트로 분리했다.
// 옮긴 것이지 복제한 것이 아니다 — 월간 탭에서는 제거했다.
"use client";

import { useCallback, useMemo } from "react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { SectionIntro } from "@/components/page-shell";
import { useMasking } from "@/components/masking-provider";
import type { MaskCategory } from "@/lib/masking";
import { formatAmountInMan } from "@/lib/utils";
import { categorySpending } from "@/lib/household/calc";
import { shiftMonth } from "@/lib/household/month";
import type { HhCategory, HhInstallment, HhTransaction } from "@/lib/household/types";

/**
 * 오래된 달 → 최근 달. 예전엔 하늘색 3단계(`#bae6fd`·`#7dd3fc`·`#0ea5e9`)라 **명도만 달라 분간이 안 됐고**,
 * 파랑은 이 앱에서 수입 색이라 지출 그래프에 쓰기에도 맞지 않았다(팀장 지시 2026-08-26, 설계 189).
 * 지금은 '지난 두 달은 회색, 이번 달만 호박색(=나가는 돈)'으로 세 막대가 한눈에 갈린다.
 */
const BAR_COLORS = ["#cbd5e1", "#64748b", "#f59e0b"];
const TOP_N = 12;

function won(n: number) {
  return `${n.toLocaleString("ko-KR")}원`;
}

interface Props {
  /** 기준 달(YYYY-MM). 이 달을 포함한 최근 3개월을 비교한다. */
  month: string;
  txns: HhTransaction[];
  installments: HhInstallment[];
  categories: HhCategory[];
}

export function Category3MonthChart({ month, txns, installments, categories }: Props) {
  const { mask, enabled: maskEnabled } = useMasking();

  const maskNum = useCallback(
    (n: number, cat: MaskCategory = "expense_amount") => {
      if (!maskEnabled) return n;
      const digits = mask(cat, String(Math.round(n))).replace(/[^\d]/g, "");
      return digits ? Number(digits) : 0;
    },
    [maskEnabled, mask]
  );

  const nameOf = useMemo(() => new Map(categories.map((c) => [c.id, c.name])), [categories]);
  const months3 = useMemo(() => [shiftMonth(month, -2), shiftMonth(month, -1), month], [month]);
  const monthLabels = useMemo(() => months3.map((ym) => `${Number(ym.slice(5, 7))}월`), [months3]);

  const data = useMemo(() => {
    const spends = months3.map((ym) => categorySpending(ym, txns, installments));
    const ids = new Set<string>();
    for (const s of spends) for (const id of s.keys()) ids.add(id);
    return [...ids]
      .map((id) => {
        const row: Record<string, string | number> = { name: nameOf.get(id) ?? "미분류" };
        let total = 0;
        months3.forEach((_, i) => {
          const v = spends[i].get(id) ?? 0;
          row[monthLabels[i]] = maskNum(v);
          total += v;
        });
        row._total = total;
        return row;
      })
      .filter((r) => Number(r._total) > 0)
      .sort((a, b) => Number(b._total) - Number(a._total))
      .slice(0, TOP_N);
  }, [months3, monthLabels, txns, installments, nameOf, maskNum]);

  return (
    <section className="space-y-3">
      <SectionIntro
        title="최근 3개월 항목별 지출"
        description={`이번 달을 포함한 최근 3개월의 카테고리별 지출(할부 청구분 포함, 상위 ${TOP_N}개)입니다.`}
      />
      {data.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border/70 bg-background/40 p-10 text-center">
          <p className="text-sm text-muted-foreground">최근 3개월 지출이 없습니다.</p>
        </div>
      ) : (
        <div className="rounded-2xl border border-border/70 bg-card/85 p-4 shadow-sm">
          {/* ★항목 이름이 막대 밑동에 붙어 읽기 나빴다 — 축과 글자 사이를 띄우고(tickMargin)
              기운 글자가 들어갈 자리를 늘렸다(height 60→76, bottom 여백 12). (팀장 지시 2026-08-26, 설계 189) */}
          <div className="h-96">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} margin={{ top: 8, right: 8, bottom: 12, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="name" fontSize={11} interval={0} angle={-30} textAnchor="end" height={76} tickMargin={10} tickLine={false} />
                <YAxis tickFormatter={(v) => formatAmountInMan(Number(v))} fontSize={11} width={48} tickMargin={6} tickLine={false} />
                <Tooltip formatter={(value) => won(Number(value))} />
                <Legend />
                {monthLabels.map((label, i) => (
                  <Bar key={label} dataKey={label} fill={BAR_COLORS[i]} barSize={16} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </section>
  );
}
