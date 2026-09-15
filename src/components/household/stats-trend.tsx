"use client";

// 통계 '추이' 탭 (설계 88) — 카테고리별 3/6개월 변동(증감 순위 + 스파크라인) + 절약 후보.
// 완결된 월 기준으로 비교하고, 진행 중인 당월은 스파크라인 끝 참고점으로만 보여준다.

import { useCallback, useState } from "react";

import { SectionIntro } from "@/components/page-shell";
import { useMasking } from "@/components/masking-provider";
import type { MaskCategory } from "@/lib/masking";
import {
  categoryTrend,
  savingCandidates,
  TREND_RULES,
  type CategoryTrendLine,
  type SavingSignal,
} from "@/lib/household/calc";
import { shiftMonth, thisMonthKey } from "@/lib/household/month";
import type { HhCategory, HhInstallment, HhTransaction } from "@/lib/household/types";

const WINDOW_STORAGE_KEY = "hh_stats_trend_window";

// 색 규율(설계 80) + 이 페이지 '전년 대비' 블록 관례: 증가=rose, 감소=emerald.
// 방향은 부호·정렬로도 인코딩되므로 색맹에도 안전.
const SIGNAL_BADGE: Record<SavingSignal, { label: string; cls: string }> = {
  surge: { label: "급증", cls: "bg-rose-100 text-rose-700" },
  new: { label: "신규", cls: "bg-sky-100 text-sky-700" },
  rising: { label: "상승세", cls: "bg-amber-100 text-amber-700" },
  discretionary: { label: "재량", cls: "bg-slate-100 text-slate-700" },
};

function won(n: number) {
  return `${n.toLocaleString("ko-KR")}원`;
}

/** '2026-04' → '4월' (해가 다르면 '25년 11월'). */
function ymLabel(ym: string) {
  const [y, m] = ym.split("-");
  return y === thisMonthKey().slice(0, 4) ? `${Number(m)}월` : `${y.slice(2)}년 ${Number(m)}월`;
}

/** 경량 스파크라인 — 완결월 실선 + 당월(진행 중) 점선·속빈 점. 행당 recharts 인스턴스 방지. */
function Sparkline({ line, windowN }: { line: CategoryTrendLine; windowN: number }) {
  const width = 96;
  const height = 26;
  const values = [...line.months, line.currentMonth];
  const n = values.length;
  const max = Math.max(...values, 1);
  const stepX = width / (n - 1);
  const y = (v: number) => height - 3 - (v / max) * (height - 6);
  const x = (i: number) => i * stepX;
  const donePoints = line.months.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  const lastI = line.months.length - 1;
  // 직전/최근 기간 경계 표시(연한 세로선)
  const boundaryX = x(windowN - 1) + stepX / 2;
  return (
    <svg width={width} height={height} className="shrink-0" aria-hidden="true">
      <line x1={boundaryX} y1={2} x2={boundaryX} y2={height - 2} stroke="#e2e8f0" strokeWidth={1} />
      <polyline points={donePoints} fill="none" stroke="#94a3b8" strokeWidth={1.5} strokeLinejoin="round" />
      {/* 당월 참고점: 점선 연결 + 속빈 원 */}
      <line x1={x(lastI)} y1={y(line.months[lastI])} x2={x(n - 1)} y2={y(line.currentMonth)} stroke="#cbd5e1" strokeWidth={1.5} strokeDasharray="2 2" />
      <circle cx={x(n - 1)} cy={y(line.currentMonth)} r={2.5} fill="white" stroke="#94a3b8" strokeWidth={1.2} />
    </svg>
  );
}

export function StatsTrend({
  txns,
  installments,
  categories,
}: {
  txns: HhTransaction[];
  installments: HhInstallment[];
  categories: HhCategory[];
}) {
  const { mask, enabled: maskEnabled } = useMasking();

  const [windowN, setWindowN] = useState<3 | 6>(() => {
    if (typeof window === "undefined") return 3;
    return localStorage.getItem(WINDOW_STORAGE_KEY) === "6" ? 6 : 3;
  });
  const changeWindow = useCallback((n: 3 | 6) => {
    setWindowN(n);
    localStorage.setItem(WINDOW_STORAGE_KEY, String(n));
  }, []);

  // 마스킹: 표시 금액을 가상금액으로 치환(설계 39). 스파크라인은 상대 모양만 노출(달력 비례 바 준례).
  const maskNum = useCallback(
    (n: number, cat: MaskCategory = "expense_amount") => {
      if (!maskEnabled) return n;
      const digits = mask(cat, String(Math.round(n))).replace(/[^\d]/g, "");
      return digits ? Number(digits) : 0;
    },
    [maskEnabled, mask]
  );
  const maskedWon = useCallback((n: number) => won(maskNum(n)), [maskNum]);

  const currentYm = thisMonthKey();
  const baseYm = shiftMonth(currentYm, -1); // 마지막 완결월
  const nameOf = new Map(categories.map((c) => [c.id, c.name]));

  const trend = categoryTrend(baseYm, windowN, currentYm, txns, installments);
  const major = trend.filter((l) => !l.minor);
  const minorLines = trend.filter((l) => l.minor);
  const minorAgg = minorLines.reduce(
    (acc, l) => ({ recent: acc.recent + l.totalRecent, prev: acc.prev + l.totalPrev }),
    { recent: 0, prev: 0 }
  );
  const maxAbsDiff = Math.max(...major.map((l) => Math.abs(l.diffTotal)), 1);
  const candidates = savingCandidates(trend, (id) => nameOf.get(id) ?? "미분류");

  const recentRange = `${ymLabel(shiftMonth(baseYm, -windowN + 1))}~${ymLabel(baseYm)}`;
  const prevRange = `${ymLabel(shiftMonth(baseYm, -windowN * 2 + 1))}~${ymLabel(shiftMonth(baseYm, -windowN))}`;

  const windowToggle = (
    <div className="inline-flex rounded-lg border border-border/70 bg-muted/40 p-0.5 text-xs">
      {([3, 6] as const).map((n) => (
        <button
          key={n}
          type="button"
          className={`rounded-md px-2.5 py-1 font-medium transition-colors ${windowN === n ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
          onClick={() => changeWindow(n)}
        >
          {n}개월
        </button>
      ))}
    </div>
  );

  return (
    <div className="space-y-6">
      {/* ① 카테고리별 증감 순위 */}
      <section className="space-y-3">
        <SectionIntro
          title="카테고리별 증감"
          description={`완결된 달 기준 — 최근 ${windowN}개월(${recentRange})을 직전 ${windowN}개월(${prevRange})과 비교합니다. 진행 중인 이번 달은 미니 추이 끝의 ○ 참고점으로만 표시됩니다.`}
          action={windowToggle}
        />
        {major.length === 0 && minorLines.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border/70 bg-background/40 p-10 text-center">
            <p className="text-sm text-muted-foreground">비교할 지출이 없습니다.</p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-border/70 bg-card/85 shadow-sm">
            <ul className="divide-y divide-border/50">
              {major.map((l) => {
                const up = l.diffTotal > 0;
                const flat = l.diffTotal === 0;
                const pct = l.totalPrev > 0 ? Math.round((l.diffTotal / l.totalPrev) * 100) : null;
                const barPct = (Math.abs(l.diffTotal) / maxAbsDiff) * 100;
                return (
                  <li key={l.categoryId} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2">
                    <span
                      className={`w-10 shrink-0 rounded-full px-2 py-0.5 text-center text-xs font-semibold ${flat ? "bg-slate-100 text-slate-600" : up ? "bg-rose-100 text-rose-700" : "bg-emerald-100 text-emerald-700"}`}
                    >
                      {flat ? "동일" : up ? "증가" : "감소"}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{nameOf.get(l.categoryId) ?? "미분류"}</span>
                    <Sparkline line={l} windowN={windowN} />
                    <span className="hidden text-xs text-muted-foreground sm:inline">
                      최근 <b className="tabular-nums text-foreground">{maskedWon(l.totalRecent)}</b>
                      <span className="tabular-nums">{` (월평균 ${maskedWon(l.recentAvg)})`}</span>
                    </span>
                    <span className="flex w-36 shrink-0 items-center justify-end gap-2">
                      <span className="h-1.5 w-14 overflow-hidden rounded-full bg-muted">
                        <span
                          className={`block h-full rounded-full ${up ? "bg-rose-300" : "bg-emerald-300"}`}
                          style={{ width: `${barPct}%` }}
                        />
                      </span>
                      <span className={`tabular-nums text-sm font-semibold ${flat ? "text-muted-foreground" : up ? "text-rose-600" : "text-emerald-600"}`}>
                        {up ? "+" : flat ? "" : "−"}
                        {maskedWon(Math.abs(l.diffTotal))}
                        {pct != null && !flat ? ` (${up ? "+" : "−"}${Math.abs(pct)}%)` : ""}
                      </span>
                    </span>
                  </li>
                );
              })}
              {minorLines.length > 0 ? (
                <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-xs text-muted-foreground">
                  <span className="w-10 shrink-0 text-center">…</span>
                  <span className="min-w-0 flex-1">
                    소액 항목 {minorLines.length}개 (양쪽 기간 월평균 {won(TREND_RULES.minorMonthlyAvg)} 미만)
                  </span>
                  <span className="tabular-nums">
                    최근 {maskedWon(minorAgg.recent)} · 직전 {maskedWon(minorAgg.prev)}
                  </span>
                </li>
              ) : null}
            </ul>
          </div>
        )}
      </section>

      {/* ② 아낄 수 있는 부분 */}
      <section className="space-y-3">
        <SectionIntro
          title="아낄 수 있는 부분"
          description="급증·신규·상승세·재량지출 신호를 종합해 절약 여지가 큰 항목을 골라냅니다. 절약액은 임의 목표가 아니라 '직전 기간 수준으로 되돌리면 월 얼마'입니다."
        />
        {candidates.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border/70 bg-background/40 p-6 text-center">
            <p className="text-sm text-muted-foreground">이번엔 평소 범위입니다. 절약 후보가 없습니다. 👍</p>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {candidates.map((c) => {
              const discretionaryOnly = c.monthlySaving === 0;
              return (
                <div key={c.categoryId} className="rounded-2xl border border-border/70 bg-card/85 p-4 shadow-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold">{nameOf.get(c.categoryId) ?? "미분류"}</span>
                    {c.signals.map((s) => (
                      <span key={s} className={`rounded-full px-2 py-0.5 text-xs font-semibold ${SIGNAL_BADGE[s].cls}`}>
                        {SIGNAL_BADGE[s].label}
                      </span>
                    ))}
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    최근 {windowN}개월 월평균 <b className="tabular-nums text-foreground">{maskedWon(c.recentAvg)}</b>
                    {c.prevAvg > 0 ? (
                      <>
                        {" — 직전 "}
                        {windowN}개월(월평균 <span className="tabular-nums">{maskedWon(c.prevAvg)}</span>)보다{" "}
                        {c.recentAvg >= c.prevAvg ? "늘었습니다" : "줄었습니다"}.
                      </>
                    ) : (
                      " — 직전 기간에는 지출이 없던 항목입니다."
                    )}
                    {discretionaryOnly ? " 늘진 않았지만 조절 여지가 있는 지출입니다." : ""}
                  </p>
                  <p className="mt-2 text-sm">
                    {discretionaryOnly ? (
                      <span className="text-muted-foreground">
                        월평균 <b className="tabular-nums text-foreground">{maskedWon(c.recentAvg)}</b> 참고
                      </span>
                    ) : (
                      <>
                        직전 수준으로 되돌리면 월{" "}
                        <b className="tabular-nums text-foreground">{maskedWon(c.monthlySaving)}</b> 절약
                      </>
                    )}
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <p className="text-xs text-muted-foreground">
        ※ 지출 = 소비성 지출(일시불 + 할부 청구분). 카드대금 납부·대출 상환·통장이동은 포함하지 않습니다.
      </p>
    </div>
  );
}
