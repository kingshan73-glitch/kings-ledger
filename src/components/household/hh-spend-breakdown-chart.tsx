// 지출 화면 하위탭(현금·카드) 바로 아래에 붙는 '무엇으로 얼마 썼나' 가로 막대그래프. (설계 144)
//
// 왜 가로 막대인가: 항목 이름이 '삼성카드(이바다) 트레이더스'처럼 길어 세로 막대에서는
// x축 라벨이 꺾이거나 잘린다. 가로로 눕히면 이름이 한 줄로 들어간다.
// 왜 카드 탭에만 있던 걸 현금에도 붙이나: 팀장 지시(2026-08-04) — "현금을 눌러도 그 바로 아래에
// 계좌별로, 카드를 눌러도 그 바로 아래에 그래프로".
"use client";

import { useCallback } from "react";
import { Bar, BarChart, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { useMasking } from "@/components/masking-provider";
import { formatAmountInMan } from "@/lib/utils";

export type BreakdownItem = { key: string; label: string; amount: number; count: number };

const BAR = "#60a5fa";        // 기본 막대(옅은 파랑)
const BAR_ON = "#2563eb";     // 선택된 막대(진한 파랑 — 탭 활성색과 같은 계열, 설계 142·143)
const ROW_H = 30;             // 막대 1개 높이
const PAD_Y = 24;             // 위아래 여백

export function HhSpendBreakdownChart({
  items,
  selectedKey,
  onSelect,
  emptyText,
}: {
  items: BreakdownItem[];
  /** 지금 필터로 걸린 항목(진한 색으로 표시) */
  selectedKey?: string;
  /** 막대를 누르면 그 항목으로 필터. 같은 것을 다시 누르면 해제(호출부 책임). */
  onSelect?: (key: string) => void;
  emptyText: string;
}) {
  const { mask, enabled: maskEnabled } = useMasking();

  // 마스킹이 켜지면 금액을 가린다 — 막대 길이까지 감춰야 어깨너머로 못 읽는다.
  const maskNum = useCallback(
    (n: number) => {
      if (!maskEnabled) return n;
      const digits = mask("expense_amount", String(Math.round(n))).replace(/[^\d]/g, "");
      return digits ? Number(digits) : 0;
    },
    [maskEnabled, mask]
  );

  if (items.length === 0) {
    return <p className="rounded-2xl border border-dashed border-border/70 bg-background/40 p-6 text-center text-sm text-muted-foreground">{emptyText}</p>;
  }

  const data = items.map((it) => ({
    ...it,
    label: mask("owner_name", it.label),
    value: maskNum(it.amount),
  }));
  const height = data.length * ROW_H + PAD_Y * 2;

  return (
    <div className="rounded-2xl border border-border/70 bg-card/60 p-3">
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} layout="vertical" margin={{ top: PAD_Y / 2, right: 96, bottom: PAD_Y / 2, left: 8 }}>
          <XAxis type="number" hide />
          {/* 이름이 길어 넉넉히(180) 잡는다. 넘치면 recharts 가 말줄임 대신 그대로 그리므로 폭을 준다. */}
          <YAxis type="category" dataKey="label" width={180} tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: "#475569" }} />
          <Tooltip
            cursor={{ fill: "rgba(37,99,235,0.06)" }}
            formatter={(v, _n, p) => {
              const n = Number(v ?? 0);
              const cnt = (p?.payload as BreakdownItem | undefined)?.count ?? 0;
              return [`${n.toLocaleString("ko-KR")}원 (${cnt}건)`, "합계"];
            }}
          />
          <Bar
            dataKey="value"
            radius={[0, 6, 6, 0]}
            barSize={18}
            onClick={(d: unknown) => onSelect?.((d as { payload?: BreakdownItem })?.payload?.key ?? (d as BreakdownItem).key)}
            className={onSelect ? "cursor-pointer" : undefined}
          >
            {data.map((d) => (
              <Cell key={d.key} fill={selectedKey === d.key ? BAR_ON : BAR} />
            ))}
            <LabelList
              dataKey="value"
              position="right"
              formatter={(v) => formatAmountInMan(Number(v ?? 0))}
              style={{ fontSize: 12, fill: "#334155" }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
