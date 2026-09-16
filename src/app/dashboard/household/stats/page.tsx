"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { toast } from "sonner";

import {
  ErrorState,
  LoadingState,
  PageShell,
  SectionIntro,
} from "@/components/page-shell";
import { HhMonthNav, HhPageHeader } from "@/components/household/hh-page-header";
import { DailyTxnCalendar } from "@/components/household/daily-txn-calendar";
import { HH_COL, colStyles, tableMinWidth } from "@/components/household/hh-board";
import { HouseholdSummary } from "@/components/household/household-summary";
import { MonthlyFlowChart } from "@/components/household/monthly-flow-chart";
import { StatsTrend } from "@/components/household/stats-trend";
import { useMasking } from "@/components/masking-provider";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import { formatAmountInMan } from "@/lib/utils";
import type { MaskCategory } from "@/lib/masking";
import {
  categorySpendingRange,
  OVERSPEND_RULES,
  overspendReport,
  ymOf,
} from "@/lib/household/calc";
import { fetchTxnsPaged } from "@/lib/household/fetch-txns";
import { monthRange, shiftMonth, thisMonthKey } from "@/lib/household/month";
import type { HhCategory, HhInstallment, HhPaymentMethod, HhTransaction } from "@/lib/household/types";
import { groupKeyByMethodId } from "@/lib/household/card-group";

const YEAR_COMPARE_COLORS = { prev: "#cbd5e1", cur: "#0ea5e9" }; // 전년 → 선택년
// (3개월 비교색·수입지출색은 각 그래프 컴포넌트로 옮겼다 — 설계 90 §2·§3)

// 과다지출 뱃지 스타일 (설계 docs/household/61 R2)
const OVERSPEND_BADGE: Record<string, { label: string; cls: string }> = {
  over: { label: "과다", cls: "bg-rose-100 text-rose-700" },
  warn: { label: "주의", cls: "bg-amber-100 text-amber-700" },
  new: { label: "신규", cls: "bg-sky-100 text-sky-700" },
};

// 전년 대비 증감 강조 기준 (설계 docs/household/61 R3-3)
const YOY_RATIO = 0.3; // ±30% 이상
const YOY_MIN_DIFF = 300_000; // 차액 30만원 이상

function won(n: number) {
  return `${n.toLocaleString("ko-KR")}원`;
}

export default function HouseholdStatsPage() {
  const supabase = useMemo(() => createClient(), []);
  const { mask, enabled: maskEnabled } = useMasking();

  // 보기: 요약(당월 관제판=예전 현황) / 월간 / 추이 / 연간. 기본=요약. (설계 61 R1 + 87 현황 통합 + 88 추이)
  const [view, setView] = useState<"summary" | "month" | "trend" | "year">("summary");
  const [month, setMonth] = useState(() => thisMonthKey());
  const [year, setYear] = useState(() => thisMonthKey().slice(0, 4));
  const [txns, setTxns] = useState<HhTransaction[]>([]);
  const [categories, setCategories] = useState<HhCategory[]>([]);
  const [installments, setInstallments] = useState<HhInstallment[]>([]);
  const [methods, setMethods] = useState<HhPaymentMethod[]>([]); // 카드 묶음 합계용 (설계 86)
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const fetchData = useCallback(async () => {
    setError(false);
    // 요약 보기는 자체 컴포넌트(HouseholdSummary)가 데이터를 직접 불러오므로 통계 쿼리를 건너뛴다.
    if (view === "summary") {
      setLoading(false);
      return;
    }
    setLoading(true);
    await supabase.auth.getSession();

    // 조회 범위: 월간 = 선택월 포함 직전 7개월(과다지출 6개월 평균용), 연간 = 선택년 + 전년. (설계 61 R4)
    // 추이 = 최근 12완결월 + 당월(설계 88) — 6개월 토글까지 커버해 토글 전환 시 재조회 없음.
    const from =
      view === "month"
        ? `${shiftMonth(month, -OVERSPEND_RULES.window)}-01`
        : view === "trend"
          ? `${shiftMonth(thisMonthKey(), -12)}-01`
          : `${Number(year) - 1}-01-01`;
    const end = view === "month" ? monthRange(month).end : view === "trend" ? monthRange(thisMonthKey()).end : `${Number(year) + 1}-01-01`;

    const [txAll, catRes, insRes, pmRes] = await Promise.all([
      fetchTxnsPaged(supabase, from, end),
      supabase.from("hh_category").select("*"),
      supabase.from("hh_installment").select("*"),
      supabase.from("hh_payment_method").select("*"),
    ]);

    // insRes(할부)·pmRes(결제수단)가 실패하면 할부 청구분이 빠지고 카드 분류가 무너져
    // "이 달 카드 지출이 없습니다" 같은 거짓 결론이 나온다. 전부 가드에 넣는다.
    const failed = [catRes, insRes, pmRes].find((r) => r.error);
    if (txAll === null || failed) {
      console.error("통계 조회 실패:", failed?.error);
      toast.error("통계 데이터를 불러오지 못했습니다.");
      setError(true);
      setLoading(false);
      return;
    }

    setTxns(txAll);
    setCategories((catRes.data ?? []) as HhCategory[]);
    setInstallments((insRes.data ?? []) as HhInstallment[]);
    setMethods((pmRes.data ?? []) as HhPaymentMethod[]);
    setLoading(false);
  }, [supabase, view, month, year]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchData();
  }, [fetchData]);

  const nameOf = useMemo(() => new Map(categories.map((c) => [c.id, c.name])), [categories]);

  // 마스킹: 표시 금액도 차트와 같은 규칙으로 가상금액 치환. (설계 docs/household/39)
  const maskedWon = useCallback(
    (n: number, cat: MaskCategory = "expense_amount") => {
      if (!maskEnabled) return won(n);
      const digits = mask(cat, String(Math.round(n))).replace(/[^\d]/g, "");
      return won(digits ? Number(digits) : 0);
    },
    [maskEnabled, mask]
  );
  const maskNum = useCallback(
    (n: number, cat: MaskCategory = "expense_amount") => {
      if (!maskEnabled) return n;
      const digits = mask(cat, String(Math.round(n))).replace(/[^\d]/g, "");
      return digits ? Number(digits) : 0;
    },
    [maskEnabled, mask]
  );

  // ── 월간: 카드사·명의별 지출 합계 (설계 86, 결제수단 병합 없이 화면에서만 묶음) ──
  // 선택월의 expense 거래를 묶음 키로 합산. 카드대금·대출 납부(payment)는 제외(소비지출만).
  const cardGroupStats = useMemo(() => {
    if (view !== "month") return [];
    const gk = groupKeyByMethodId(methods);
    const sums = new Map<string, { amount: number; count: number }>();
    for (const t of txns) {
      if (t.type !== "expense" || ymOf(t.txn_date) !== month || !t.payment_method_id) continue;
      const key = gk.get(t.payment_method_id);
      if (!key) continue;
      const cur = sums.get(key) ?? { amount: 0, count: 0 };
      cur.amount += t.amount;
      cur.count += 1;
      sums.set(key, cur);
    }
    return [...sums.entries()].map(([key, v]) => ({ key, ...v })).sort((a, b) => b.amount - a.amount);
  }, [view, txns, methods, month]);
  const cardGroupTotal = useMemo(() => cardGroupStats.reduce((s, g) => s + g.amount, 0), [cardGroupStats]);

  // (최근 3개월 카테고리별 지출은 요약 탭으로 이동 — 설계 90 §2. Category3MonthChart 컴포넌트.)

  // ── 월간: 과다지출 점검 (설계 61 R2) ──
  const overspend = useMemo(
    () => (view === "month" ? overspendReport(month, txns, installments) : []),
    [view, month, txns, installments]
  );

  // ── 연간: 월별 수입·지출·대출은 MonthlyFlowChart 공용 컴포넌트가 그린다 (설계 90 §3) ──
  // 여기서는 전년 대비 비교에 쓸 월 목록만 만든다.
  const yearMonths = useMemo(() => {
    const last = year === thisMonthKey().slice(0, 4) ? Number(thisMonthKey().slice(5, 7)) : 12;
    return Array.from({ length: last }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
  }, [year]);

  // ── 연간: 카테고리별 전년 대비 (설계 61 R3-2·3) — 진행 중 연도는 전년 "같은 기간"과 비교 ──
  const prevYearMonths = useMemo(() => yearMonths.map((ym) => `${Number(year) - 1}${ym.slice(4)}`), [yearMonths, year]);

  const yoy = useMemo(() => {
    if (view !== "year") return { chart: [], list: [] as { name: string; cur: number; prev: number; diff: number }[] };
    const cur = categorySpendingRange(yearMonths, txns, installments);
    const prev = categorySpendingRange(prevYearMonths, txns, installments);
    const ids = new Set([...cur.keys(), ...prev.keys()]);
    const rows = [...ids].map((id) => ({
      name: nameOf.get(id) ?? "미분류",
      cur: cur.get(id) ?? 0,
      prev: prev.get(id) ?? 0,
      diff: (cur.get(id) ?? 0) - (prev.get(id) ?? 0),
    }));
    const chart = rows
      .filter((r) => r.cur + r.prev > 0)
      .sort((a, b) => b.cur - a.cur)
      .slice(0, 12)
      .map((r) => ({ name: r.name, [`${Number(year) - 1}년`]: maskNum(r.prev), [`${year}년`]: maskNum(r.cur) }));
    const list = rows
      .filter((r) => Math.abs(r.diff) >= YOY_MIN_DIFF && (r.prev === 0 || Math.abs(r.diff) / r.prev >= YOY_RATIO))
      .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))
      .slice(0, 10);
    return { chart, list };
  }, [view, yearMonths, prevYearMonths, txns, installments, nameOf, year, maskNum]);

  const VIEW_LABEL = { summary: "요약", month: "월간", trend: "추이", year: "연간" } as const;
  const viewToggle = (
    <div className="inline-flex rounded-lg border border-border/70 bg-muted/40 p-0.5 text-sm">
      {(["summary", "month", "trend", "year"] as const).map((v) => (
        <button
          key={v}
          type="button"
          className={`rounded-md px-3 py-1 font-medium transition-colors ${view === v ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
          onClick={() => setView(v)}
        >
          {VIEW_LABEL[v]}
        </button>
      ))}
    </div>
  );

  return (
    <PageShell>
      <HhPageHeader
        title="통계"
        description="이번 달 요약과 소비 패턴을 한곳에서 봅니다."
        help={
          view === "summary" ? (
            <>
              <b>요약</b>은 이번 달 돈의 흐름을 한눈에 봅니다 — <b>소비·출금·잔액·예정</b> 네 갈래와 알림.
              카드로 쓴 돈은 소비지출에 한 번, 카드대금이 빠질 때 출금에 한 번 — 서로 다른 단계라 중복이 아닙니다.
              월별·연간 소비 분석은 <b>월간</b>·<b>연간</b> 탭에 있습니다.
            </>
          ) : view === "trend" ? (
            <>
              <b>추이</b>는 카테고리별로 최근 3·6개월을 그 직전 기간과 비교해 <b>어디에 더 쓰고 덜 썼는지</b>,
              그리고 급증·상승세·재량지출 신호로 <b>아낄 수 있는 부분</b>을 보여줍니다. 진행 중인 이번 달은
              왜곡을 막기 위해 비교에서 빼고 참고점으로만 표시합니다.
            </>
          ) : (
            <>
              <b>월간</b>은 과다지출 점검·당월 달력·카드사별 지출, <b>연간</b>은 월별 흐름·전년 대비입니다.
              카드대금 납부·대출 상환·통장이동은 소비가 아니라 통계에 포함되지 않습니다(나갈 돈은 <b>현금흐름</b>에서).
            </>
          )
        }
        actions={viewToggle}
      />

      {view === "month" ? (
        <HhMonthNav month={month} onChange={setMonth} />
      ) : view === "year" ? (
        <div className="flex items-center justify-center gap-2">
          <Button variant="outline" size="sm" className="size-8 p-0" onClick={() => setYear(String(Number(year) - 1))} aria-label="이전 연도">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="min-w-[80px] text-center text-sm font-semibold">{year}년</span>
          <Button variant="outline" size="sm" className="size-8 p-0" onClick={() => setYear(String(Number(year) + 1))} aria-label="다음 연도">
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      ) : null}

      {view === "summary" ? (
        <div className="space-y-6">
          {/* '데이터 건강도' 카드는 요약에서 내렸다 — 팀장 지시 2026-08-26("이 자료는 필요없어", 설계 189).
              판정 로직(`lib/household/data-health.ts`)과 카드 컴포넌트는 지우지 않고 남겨 뒀다. */}
          <HouseholdSummary />
        </div>
      ) : loading ? (
        <LoadingState label="통계를 계산하는 중..." />
      ) : error ? (
        <ErrorState onRetry={() => void fetchData()} />
      ) : view === "trend" ? (
        <StatsTrend txns={txns} installments={installments} categories={categories} />
      ) : view === "month" ? (
        <div className="space-y-6">
          {/* ① 이번 달 과다지출 점검 (설계 61 R2) */}
          <section className="space-y-3">
            <SectionIntro
              title="이번 달 지출 점검"
              description={`카테고리별 당월 지출을 직전 ${OVERSPEND_RULES.window}개월 평균과 비교해 평소 범위를 벗어난 항목을 보여줍니다.`}
            />
            {overspend.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border/70 bg-background/40 p-6 text-center">
                <p className="text-sm text-muted-foreground">평소 범위를 벗어난 항목이 없습니다. 👍</p>
              </div>
            ) : (
              <div className="overflow-hidden rounded-2xl border border-border/70 bg-card/85 shadow-sm">
                <ul className="divide-y divide-border/50">
                  {overspend.map((o) => {
                    const badge = OVERSPEND_BADGE[o.level];
                    const pct = o.average > 0 ? Math.round((o.diff / o.average) * 100) : null;
                    return (
                      <li key={o.categoryId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
                        <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${badge.cls}`}>{badge.label}</span>
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">{nameOf.get(o.categoryId) ?? "미분류"}</span>
                        <span className="text-xs text-muted-foreground">
                          당월 <b className="tabular-nums text-foreground">{maskedWon(o.current)}</b>
                          {o.level !== "new" ? (
                            <>
                              {" · "}평균 <span className="tabular-nums">{maskedWon(o.average)}</span>
                            </>
                          ) : (
                            " · 평소 지출 없던 항목"
                          )}
                        </span>
                        <span className={`shrink-0 tabular-nums text-sm font-semibold ${o.level === "over" ? "text-rose-600" : o.level === "warn" ? "text-amber-600" : "text-sky-600"}`}>
                          +{maskedWon(o.diff)}
                          {pct != null ? ` (+${pct}%)` : ""}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </section>

          {/* ② 당월 실거래 입금/지출 달력 */}
          <section className="space-y-3">
            <SectionIntro title="당월 입금·지출 달력" description="이미 등록된 거래를 날짜별로 봅니다. (예정이 아니라 실제 거래 기준 — 날짜 없는 할부 청구분은 제외)" />
            <DailyTxnCalendar month={month} txns={txns} />
          </section>

          {/* ③ 카드사·명의별 지출 (설계 86) */}
          <section className="space-y-3">
            <SectionIntro title="카드사·명의별 지출" description={`${Number(month.slice(5, 7))}월 카드 지출을 카드사·명의로 묶어 봅니다. 같은 카드가 여러 별칭으로 나뉘어 있어도 한 줄로 합칩니다(체크카드·현금 제외).`} />
            {cardGroupStats.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border/70 bg-background/40 p-10 text-center">
                <p className="text-sm text-muted-foreground">이 달 카드 지출이 없습니다.</p>
              </div>
            ) : (
              <div className="overflow-hidden rounded-2xl border border-border/70 bg-card/85 shadow-sm">
                {/* 헤더 없는 '막대그래프 + 금액' 2열. 내용별 폭 규칙(설계 122)에 그대로 들어맞는다 —
                    막대는 가변, 금액만 척도 고정. (예전엔 76/24 를 '균등 규칙 예외'로 적어 뒀었다) */}
                <table className="table-fixed text-sm" style={{ width: tableMinWidth([undefined, HH_COL.standard]) }}>
                  <colgroup>
                    {/* 남는 폭은 두 열에 똑같이 나뉜다(colStyles) — 막대는 가변, 금액만 척도 고정. */}
                    {colStyles([undefined, HH_COL.standard]).map((st, i) => <col key={i} style={st} />)}
                  </colgroup>
                  <tbody>
                    {cardGroupStats.map((g) => {
                      const pct = cardGroupTotal > 0 ? (g.amount / cardGroupTotal) * 100 : 0;
                      return (
                        <tr key={g.key} className="border-b border-border/40 last:border-0">
                          <td className="px-4 py-2.5">
                            <div className="flex items-center justify-between gap-3">
                              <span className="font-medium text-foreground">{mask("owner_name", g.key)}</span>
                              <span className="shrink-0 text-xs text-muted-foreground">{g.count}건</span>
                            </div>
                            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                              <div className="h-full rounded-full bg-muted-foreground/50" style={{ width: `${pct}%` }} />
                            </div>
                          </td>
                          <td className="whitespace-nowrap px-4 py-2.5 text-right align-top font-semibold tabular-nums text-foreground">{maskedWon(g.amount)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-border/70 bg-muted/50 font-semibold">
                      <td className="px-4 py-3 text-foreground">카드 합계</td>
                      <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-foreground">{maskedWon(cardGroupTotal)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </section>

          {/* ④ 최근 3개월 항목별 지출은 요약 탭으로 이동했다 (설계 90 §2). */}

        </div>
      ) : (
        <div className="space-y-6">
          {/* ① 월별 수입·지출·대출 — 요약 탭과 같은 컴포넌트(설계 90 §3). 연도만 다르게 넘긴다. */}
          <MonthlyFlowChart year={year} txns={txns} installments={installments} categories={categories} />

          {/* ② 카테고리별 전년 대비 (설계 61 R3-2) */}
          <section className="space-y-3">
            <SectionIntro
              title={`항목별 지출 — ${Number(year) - 1}년 vs ${year}년`}
              description={`연간 카테고리별 지출 상위 12개를 전년과 비교합니다.${year === thisMonthKey().slice(0, 4) ? " (진행 중인 연도라 전년도 같은 기간과 비교)" : ""}`}
            />
            {yoy.chart.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border/70 bg-background/40 p-10 text-center">
                <p className="text-sm text-muted-foreground">비교할 지출이 없습니다.</p>
              </div>
            ) : (
              <div className="rounded-2xl border border-border/70 bg-card/85 p-4 shadow-sm">
                <div className="h-80">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={yoy.chart} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="name" fontSize={11} interval={0} angle={-30} textAnchor="end" height={60} />
                      <YAxis tickFormatter={(v) => formatAmountInMan(Number(v))} fontSize={11} width={48} />
                      <Tooltip formatter={(value) => won(Number(value))} />
                      <Legend />
                      <Bar dataKey={`${Number(year) - 1}년`} fill={YEAR_COMPARE_COLORS.prev} barSize={14} />
                      <Bar dataKey={`${year}년`} fill={YEAR_COMPARE_COLORS.cur} barSize={14} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}
          </section>

          {/* ③ 전년 대비 증감 목록 (설계 61 R3-3) */}
          <section className="space-y-3">
            <SectionIntro title="전년 대비 크게 달라진 항목" description={`증감률 ±${YOY_RATIO * 100}% 이상이고 차액 ${won(YOY_MIN_DIFF)} 이상인 항목입니다.`} />
            {yoy.list.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border/70 bg-background/40 p-6 text-center">
                <p className="text-sm text-muted-foreground">크게 달라진 항목이 없습니다.</p>
              </div>
            ) : (
              <div className="overflow-hidden rounded-2xl border border-border/70 bg-card/85 shadow-sm">
                <ul className="divide-y divide-border/50">
                  {yoy.list.map((r) => {
                    const up = r.diff > 0;
                    const pct = r.prev > 0 ? Math.round((r.diff / r.prev) * 100) : null;
                    return (
                      <li key={r.name} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
                        <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${up ? "bg-rose-100 text-rose-700" : "bg-emerald-100 text-emerald-700"}`}>
                          {up ? "증가" : "감소"}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">{r.name}</span>
                        <span className="text-xs text-muted-foreground">
                          {Number(year) - 1}년 <span className="tabular-nums">{maskedWon(r.prev)}</span> → {year}년{" "}
                          <b className="tabular-nums text-foreground">{maskedWon(r.cur)}</b>
                        </span>
                        <span className={`shrink-0 tabular-nums text-sm font-semibold ${up ? "text-rose-600" : "text-emerald-600"}`}>
                          {up ? "+" : "−"}
                          {maskedWon(Math.abs(r.diff))}
                          {pct != null ? ` (${up ? "+" : ""}${pct}%)` : " (신규)"}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </section>

          <p className="text-xs text-muted-foreground">
            ※ 지출 = 소비성 지출(일시불 + 할부 청구분). 카드대금 납부·대출 상환·통장이동은 포함하지 않습니다.
          </p>
        </div>
      )}
    </PageShell>
  );
}
