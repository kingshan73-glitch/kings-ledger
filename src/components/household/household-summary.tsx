"use client";

import { AlertTriangle, ArrowUpRight, CreditCard, Landmark, PiggyBank, TrendingDown, TrendingUp, Wallet } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import {
  ErrorState,
  LoadingState,
  SectionIntro,
  StatCard,
} from "@/components/page-shell";
import { Button } from "@/components/ui/button";
import { useMasking } from "@/components/masking-provider";
import type { MaskCategory } from "@/lib/masking";
import { createClient } from "@/lib/supabase/client";
import { formatAmountInMan } from "@/lib/utils";
import {
  budgetStatus,
  loanCategoryId,
  loanIncomeCategoryId,
  monthFlowTotals,
  monthlyCashflow,
  monthOverMonthSpike,
  type ActualOutflow,
} from "@/lib/household/calc";
import { cashflowSnapshot } from "@/lib/household/cashflow-snapshot";
import { cardBillCategoryId } from "@/lib/household/category-names";
import { fetchTxnsPaged } from "@/lib/household/fetch-txns";
import { shiftMonth, thisMonthKey } from "@/lib/household/month";
import { Category3MonthChart } from "@/components/household/category-3month-chart";
import { MonthlyFlowChart } from "@/components/household/monthly-flow-chart";
import type {
  HhAccountBalance,
  HhBudget,
  HhCashflowOverride,
  HhCategory,
  HhInstallment,
  HhLoan,
  HhPaymentMethod,
  HhScheduledPayment,
  HhTransaction,
} from "@/lib/household/types";

function won(n: number) {
  return `${n.toLocaleString("ko-KR")}원`;
}

/**
 * 가계부 요약(당월 관제판). 예전 '현황' 화면 내용을 그대로 담아 통계의 '요약' 탭에서 재사용한다.
 * (설계 87 — 현황을 통계 요약 탭으로 통합, 팀장 결정 2026-07-18)
 * 돈을 4가지로 나눠 보여준다 — 수입 / 소비지출 / 출금(카드·대출 납부) / 예정.
 * 카드대금·대출 상환은 **소비지출에 넣지 않고** 출금·예정으로만 잡는다(이중계산 방지).
 * PageShell·헤더는 감싸는 화면(통계)이 제공하므로 여기서는 본문만 렌더한다.
 */
export function HouseholdSummary() {
  const supabase = useMemo(() => createClient(), []);
  const { mask, enabled: maskEnabled } = useMasking();

  // 마스킹 ON이면 카드 숫자를 가상값으로. 단 카드끼리 산식(예상잔액=잔액−빠질돈)이 깨지지 않도록
  // 기초값만 마스킹하고 파생값은 마스킹된 값에서 다시 계산한다. (설계 docs/household/39)
  const maskNum = useCallback(
    (n: number, cat: MaskCategory): number => {
      if (!maskEnabled) return n;
      const neg = n < 0;
      const digits = mask(cat, String(Math.abs(Math.round(n)))).replace(/[^\d]/g, "");
      const v = digits ? Number(digits) : 0;
      return neg ? -v : v;
    },
    [maskEnabled, mask]
  );

  const [txns, setTxns] = useState<HhTransaction[]>([]);
  const [categories, setCategories] = useState<HhCategory[]>([]);
  const [scheduled, setScheduled] = useState<HhScheduledPayment[]>([]);
  const [loans, setLoans] = useState<HhLoan[]>([]);
  const [installments, setInstallments] = useState<HhInstallment[]>([]);
  const [budgets, setBudgets] = useState<HhBudget[]>([]);
  const [methods, setMethods] = useState<HhPaymentMethod[]>([]);
  // 당월 오버라이드(날짜복귀·출금금액 직접입력·직접 제외) — 현금흐름과 같은 숫자를 위해 필수(설계 79).
  const [overrides, setOverrides] = useState<HhCashflowOverride[]>([]);
  const [nextOverrides, setNextOverrides] = useState<HhCashflowOverride[]>([]); // 익월 출금 입력값(설계 81)
  const [totalCash, setTotalCash] = useState(0);
  /** 등록 계좌 id 전부 — 내부 이체를 매칭 풀에서 빼는 데 쓴다. 현금흐름 화면과 같은 기준(설계 131). */
  const [accountIds, setAccountIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  // 현금흐름 예측 요약(설계 65 2차) — 여유선·기간은 현금흐름 화면과 같은 localStorage 공유.
  const [bufferLine, setBufferLine] = useState(1_000_000);
  const [horizon, setHorizon] = useState(3);

  const month = thisMonthKey();

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(false);
    await supabase.auth.getSession();

    // 조회 시작일 = min(올해 1월 1일, 당월−2개월). (설계 90 §4)
    // - 연초부터: 월별 수입·지출·대출 그래프가 1월부터 그려져야 한다.
    // - 당월−2개월: 전월 대비 급증·현금흐름 예측의 최근 3개월 실적 매칭에 필요하다.
    //   1~2월에는 연초부터가 3개월이 안 되므로 둘 중 이른 날짜를 쓴다.
    const recent3 = `${shiftMonth(month, -2)}-01`;
    const yearStart = `${month.slice(0, 4)}-01-01`;
    const from = recent3 < yearStart ? recent3 : yearStart;
    // 종료일은 넉넉히 내년 1월 1일 — 미래 날짜로 등록된 거래도 빠뜨리지 않는다.
    const end = `${Number(month.slice(0, 4)) + 1}-01-01`;

    const [txAll, catRes, spRes, loanRes, insRes, balRes, accRes, budRes, pmRes, ovRes] = await Promise.all([
      // ★fetchTxnsPaged 필수 — 연초부터면 1,000행을 넘어 그냥 select 하면 조용히 잘린다(설계 90 §4).
      fetchTxnsPaged(supabase, from, end),
      supabase.from("hh_category").select("*"),
      supabase.from("hh_scheduled_payment").select("*"),
      supabase.from("hh_loan").select("*"),
      supabase.from("hh_installment").select("*"),
      supabase.from("hh_account_balance").select("*"),
      supabase.from("hh_account").select("id, kind"),
      supabase.from("hh_budget").select("*"),
      supabase.from("hh_payment_method").select("*"),
      // 익월분까지 함께 — 현금흐름 화면과 예측 익월 숫자를 맞추기 위해(설계 79·81).
      supabase.from("hh_cashflow_override").select("*").in("year_month", [month, shiftMonth(month, 1)]),
    ]);

    // ★조회 10개 중 하나라도 실패하면 화면을 그리지 않는다.
    //   예전엔 txAll·catRes 만 봐서, 잔액(balRes)이 실패하면 cash=0 으로 강등된 채
    //   "계좌 잔액 0원"과 그 0원에서 출발한 확신에 찬 예측·가짜 현금부족 경고가 떴다.
    //   금액 화면에서 0원은 '모름'의 대체재가 될 수 없다.
    const failed = [catRes, spRes, loanRes, insRes, balRes, accRes, budRes, pmRes, ovRes].find((r) => r.error);
    if (txAll === null || failed) {
      console.error("요약 조회 실패:", failed?.error);
      toast.error("요약 데이터를 불러오지 못했습니다.");
      setError(true);
      setLoading(false);
      return;
    }

    const stockIds = new Set(((accRes.data ?? []) as { id: string; kind: string }[]).filter((a) => a.kind === "stock").map((a) => a.id));
    const cash = ((balRes.data ?? []) as HhAccountBalance[]).filter((b) => !stockIds.has(b.account_id)).reduce((s, b) => s + b.current_balance, 0);

    setTxns(txAll);
    setCategories((catRes.data ?? []) as HhCategory[]);
    setScheduled((spRes.data ?? []) as HhScheduledPayment[]);
    setLoans((loanRes.data ?? []) as HhLoan[]);
    setInstallments((insRes.data ?? []) as HhInstallment[]);
    setBudgets((budRes.data ?? []) as HhBudget[]);
    setMethods((pmRes.data ?? []) as HhPaymentMethod[]);
    const allOv = (ovRes.data ?? []) as HhCashflowOverride[];
    const nextYm = shiftMonth(month, 1);
    setOverrides(allOv.filter((o) => o.year_month === month));
    setNextOverrides(allOv.filter((o) => o.year_month === nextYm));
    setTotalCash(cash);
    setAccountIds(((accRes.data ?? []) as { id: string }[]).map((a) => a.id));
    setLoading(false);
  }, [supabase, month]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchData();
  }, [fetchData]);

  // 현금흐름 화면과 같은 여유선·예측기간 복원(localStorage). 마운트 1회.
  useEffect(() => {
    // ★키가 없으면 getItem 은 null 인데 Number(null) === 0 이라 그대로 통과해
    //   기본값(100만원)을 0으로 덮어썼다 — 여유선 0원이면 월말현금이 음수가 될 때까지
    //   현금부족 경고가 안 뜬다(경고가 가장 필요한 신규 사용자에게 꺼져 있었다).
    const bRaw = localStorage.getItem("hh_cash_buffer_line");
    const b = bRaw === null ? NaN : Number(bRaw);
    const h = Number(localStorage.getItem("hh_cash_forecast_horizon"));
    /* eslint-disable react-hooks/set-state-in-effect */
    if (Number.isFinite(b) && b >= 0) setBufferLine(b);
    if (h === 3 || h === 6 || h === 12) setHorizon(h);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  // ①② 이번 달 수입·소비지출 — **바로 위 월별 흐름 그래프와 같은 함수**(`monthFlowTotals`)로 낸다.
  //
  // ★예전엔 여기서 따로 계산했다가 두 번 갈렸다:
  //   · 수입: 카드 3,449만 vs 그래프 579만 (대출 실행금 포함 여부) — 2026-08-26 팀장 지적
  //   · 지출: 카드 1,197만 vs 그래프 1,338만 (할부를 매달 나눠 세느냐, 결제월에 총액이냐)
  //           — 같은 날 교차검토가 잡았고 팀장이 "결제월 총액으로 통일" 로 판정했다.
  //   같은 뜻의 계산을 두 곳에 두면 **조용히 어긋난다.** 함수를 공유해 구조적으로 못 갈리게 한다.
  //
  // ★기준: 수입 = 번 돈만(대출 실행금 제외) · 지출 = 결제월 기준(할부는 결제한 달에 총액).
  //   카드대금·대출 납부·통장이동은 어느 쪽에도 안 들어간다(이중계산 방지).
  //   ★현금흐름 화면은 반대로 대출 실행금을 **포함**하는 게 맞다 — 거긴 '통장에 실제로 들어온 현금'을
  //     보는 자리라 빌린 돈도 쓸 수 있는 돈이기 때문이다. 두 화면의 기준이 다른 건 의도된 것이다.
  const loanIncomeCatId = useMemo(() => loanIncomeCategoryId(categories), [categories]);
  const loanCatId = useMemo(() => loanCategoryId(categories), [categories]);
  const flow = useMemo(
    () => monthFlowTotals(month, txns, installments, loanCatId, loanIncomeCatId),
    [month, txns, installments, loanCatId, loanIncomeCatId]
  );
  const income = flow.income;
  const spending = flow.expense;

  // 이번 달 현금흐름(고정비·대출·할부) + 신용카드 사용액
  const cf = useMemo(() => monthlyCashflow(month, { scheduled, loans, installments }), [month, scheduled, loans, installments]);
  const cardBill = useMemo(() => {
    const creditIds = new Set(methods.filter((m) => m.kind === "credit").map((m) => m.id));
    return txns
      .filter((t) => t.type === "expense" && t.txn_date.slice(0, 7) === month && t.payment_method_id && creditIds.has(t.payment_method_id))
      .reduce((s, t) => s + t.amount, 0);
  }, [txns, methods, month]);

  // ③ 카드·대출 납부(출금) = 카드대금 + 대출 상환 + 고정비 출금. (할부는 소비라 제외 — 이중계산 방지)
  //
  // ★카드대금은 **한 번만** 센다 (교차점검 2026-08-27, 설계 190 §7). 예전엔 `cardBill`(당월 카드 사용액)에
  //   정기지출의 `카드대금-*` 행(설계 108 이후 카드대금이 정기지출로 들어왔다)까지 더해져 **같은 돈을 두 번**
  //   셌다 — 8월 실측 16,179,672 중 약 240만원이 중복(카드 사용액 2,397,438 vs 카드대금 정기지출 5,903,105).
  //   같은 돈의 두 시점(쓴 달 / 통장에서 빠지는 달)이라 둘 다 더하면 안 된다.
  //   → **카드대금 정기지출이 있으면 그것을 쓰고**(청구 확정액이라 더 정확), 없는 카드사 것만 사용액으로 보충한다.
  //   판별은 정기지출의 카테고리(`카드대금`)로 한다 — 이름으로 고르면 `KB카드출금` 같은 변형을 놓친다.
  const cardBillCatId = useMemo(() => cardBillCategoryId(categories), [categories]);
  const schedById = useMemo(() => new Map(scheduled.map((s) => [s.id, s])), [scheduled]);
  const payout = useMemo(() => {
    const loanOut = cf.items.filter((i) => i.source === "loan").reduce((s, i) => s + i.amount, 0);
    const fixedItems = cf.items.filter((i) => i.source === "scheduled" && i.direction === "out");
    const isCardBillItem = (i: (typeof fixedItems)[number]) => {
      const sp = schedById.get(i.sourceId);
      return !!sp && !!cardBillCatId && sp.category_id === cardBillCatId;
    };
    const cardBillSched = fixedItems.filter(isCardBillItem).reduce((s, i) => s + i.amount, 0);
    const fixedOut = fixedItems.filter((i) => !isCardBillItem(i)).reduce((s, i) => s + i.amount, 0);
    // 정기지출에 카드대금 행이 하나라도 있으면 그쪽을 신뢰한다. 없으면(설계 108 이전 형태) 예전처럼 사용액.
    const card = cardBillSched > 0 ? cardBillSched : cardBill;
    return card + loanOut + fixedOut;
  }, [cf, cardBill, schedById, cardBillCatId]);

  // 알림 — 예산 초과 / 전월 대비 급증
  const bStatus = useMemo(() => budgetStatus(month, txns, installments, categories, budgets), [month, txns, installments, categories, budgets]);
  const spikes = useMemo(() => monthOverMonthSpike(month, shiftMonth(month, -1), txns, installments, categories), [month, txns, installments, categories]);

  // ★공유 계산(설계 79) — 출금 예정·이번 달 잔액·여러 달 예측을 현금흐름 화면과 같은 함수로.
  // 오버라이드(날짜복귀·출금금액 직접입력·직접 제외)까지 반영되어 두 화면 숫자가 항상 같다.
  const snap = useMemo(() => {
    const win3Start = `${shiftMonth(month, -2)}-01`;
    const recentOutflows: ActualOutflow[] = txns
      .filter((t) => (t.type === "expense" || t.type === "payment" || t.type === "transfer") && t.txn_date >= win3Start)
      // ★계좌 컬럼까지 넘긴다 — 없으면 내부 이체를 못 걸러 현금흐름 화면과 숫자가 갈린다(설계 131·79).
      .map((t) => ({
        amount: t.amount,
        counterparty: t.counterparty,
        txn_date: t.txn_date,
        type: t.type,
        // account_id 는 payment 계좌 게이트 폴백(설계 166)용 — 빼면 홈·현금흐름 매칭이 갈릴 수 있다(설계 79).
        account_id: t.account_id,
        from_account_id: t.from_account_id,
        to_account_id: t.to_account_id,
        payment_method_id: t.payment_method_id,
      }));
    return cashflowSnapshot(month, { scheduled, loans, installments, txns, methods, overrides, nextOverrides, recentOutflows, accountIds, totalCash, horizon });
  }, [month, txns, scheduled, loans, installments, methods, overrides, nextOverrides, accountIds, totalCash, horizon]);

  // 현금흐름 예측 요약(설계 65 2차) — 정기수입이 없으면 예측 무의미라 표시 안 함.
  const forecastRisk = useMemo(() => {
    if (!snap.hasScheduledIncome) return null;
    const idx = snap.projection.findIndex((p) => p.closingCash < bufferLine);
    return { projection: snap.projection, idx, first: idx >= 0 ? snap.projection[idx] : null };
  }, [snap, bufferLine]);

  // 카드 표시값(마스킹 ON이면 가상값). 잔액은 데모에서 건강하게 보이도록 수입형 편향, 출금성은 지출형(축소).
  const dIncome = maskNum(income, "income_amount");
  const dSpending = maskNum(spending, "expense_amount");
  const dPayout = maskNum(payout, "expense_amount");
  const dCash = maskNum(totalCash, "income_amount");
  const dPendingIn = maskNum(snap.pendingIn, "income_amount");
  const dPendingOut = maskNum(snap.pendingOutAll, "expense_amount");
  // ⑥ 이번 달 잔액 = (마스킹된) 계좌 잔액 + 입금 예정 − 출금 예정 → 카드 간 산식 일관 유지(현금흐름과 동일 산식, 설계 79)
  const dMonthEnd = dCash + dPendingIn - dPendingOut;

  // 색 규율(설계 80): 일반 지출·출금 카드는 중립(default). 색은 수입(파랑)과 진짜 경고(빨강)에만.
  const cards: { label: string; value: number; icon: typeof Wallet; tone: "positive" | "danger" | "warning" | "info" | "default"; href: string }[] = [
    { label: "이번 달 수입", value: dIncome, icon: TrendingUp, tone: "positive", href: "/dashboard/household/income" },
    { label: "소비지출", value: dSpending, icon: TrendingDown, tone: "default", href: "/dashboard/household/expenses" },
    { label: "카드·대출 납부", value: dPayout, icon: CreditCard, tone: "default", href: "/dashboard/household/cash" },
    { label: "계좌 잔액", value: dCash, icon: Wallet, tone: "default", href: "/dashboard/household/cash" },
    { label: "출금 예정", value: dPendingOut, icon: Landmark, tone: "default", href: "/dashboard/household/cash" },
    { label: "이번 달 잔액", value: dMonthEnd, icon: PiggyBank, tone: dMonthEnd < 0 ? "danger" : "positive", href: "/dashboard/household/cash" },
  ];

  if (loading) return <LoadingState label="요약을 계산하는 중..." />;
  if (error) return <ErrorState onRetry={() => void fetchData()} />;

  return (
    <div className="space-y-4">
      {/* ★월별 수입·지출·대출을 요약의 **맨 위**로 (팀장 지시 2026-08-26, 설계 189).
          한 해 흐름을 먼저 보고 그 다음에 이번 달 숫자를 보는 순서다. */}
      <MonthlyFlowChart year={month.slice(0, 4)} txns={txns} installments={installments} categories={categories} />

      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 md:gap-4">
        {cards.map((c) => (
          <Link key={c.label} href={c.href} className="block rounded-2xl transition-transform hover:-translate-y-0.5">
            <StatCard
              label={c.label}
              value={won(c.value)}
              mobileValue={formatAmountInMan(c.value)}
              icon={c.icon}
              tone={c.tone}
            />
          </Link>
        ))}
      </div>

      {bStatus.overCount > 0 || spikes.length > 0 || forecastRisk?.first ? (
        <section className="space-y-3">
          <SectionIntro title="이번 달 알림" description="예산을 넘었거나 지난달보다 많이 쓴 항목, 앞으로의 현금 부족 신호입니다." />
          <div className="grid gap-4 md:grid-cols-2">
            {/* 화면에서 배경 틴트를 갖는 유일한 카드 — 진짜 경고(설계 80 규칙 1). */}
            {forecastRisk?.first ? (
              <Link
                href="/dashboard/household/cash"
                className={`block rounded-2xl border border-l-4 p-4 shadow-sm transition-transform hover:-translate-y-0.5 ${forecastRisk.first.closingCash < 0 ? "border-rose-200/70 border-l-rose-500 bg-rose-50/60 dark:border-rose-900/40 dark:border-l-rose-500 dark:bg-rose-950/20" : "border-amber-200/70 border-l-amber-500 bg-amber-50/60 dark:border-amber-900/40 dark:border-l-amber-500 dark:bg-amber-950/20"}`}
              >
                <h3 className={`mb-1 flex items-center gap-1.5 text-sm font-semibold ${forecastRisk.first.closingCash < 0 ? "text-rose-700 dark:text-rose-300" : "text-amber-700 dark:text-amber-300"}`}>
                  <TrendingDown className="size-4" />현금 부족 예상
                </h3>
                <p className="text-sm text-foreground">
                  <b>{forecastRisk.idx === 0 ? "이번 달" : `${forecastRisk.idx}개월 뒤`}({forecastRisk.first.ym})</b> 월말 예상현금이{" "}
                  <span className={`font-semibold tabular-nums ${!maskEnabled && forecastRisk.first.closingCash < 0 ? "text-rose-600 dark:text-rose-400" : "text-amber-600 dark:text-amber-400"}`}>{mask("expense_amount", won(maskEnabled ? Math.abs(forecastRisk.first.closingCash) : forecastRisk.first.closingCash))}</span>
                  {" "}— 여유선({mask("expense_amount", won(bufferLine))}) 밑입니다.
                </p>
                <p className="mt-1 text-xs text-muted-foreground">현금흐름에서 자세히 보기 →</p>
              </Link>
            ) : null}
            {bStatus.overCount > 0 ? (
              <div className="rounded-2xl border border-border/70 bg-card p-4 shadow-sm">
                <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-rose-600 dark:text-rose-400"><AlertTriangle className="size-4" />예산 초과 항목</h3>
                <ul className="space-y-1.5">
                  {bStatus.lines.filter((l) => l.over > 0).map((l) => (
                    <li key={l.categoryId} className="flex items-center justify-between gap-2 text-sm">
                      <span className="truncate text-muted-foreground">{l.name}</span>
                      <span className="shrink-0 font-semibold tabular-nums text-rose-600 dark:text-rose-400">{mask("expense_amount", won(l.spent))} <span className="text-xs font-normal text-muted-foreground">/ {mask("expense_amount", won(l.budget))}</span></span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {spikes.length > 0 ? (
              <div className="rounded-2xl border border-border/70 bg-card p-4 shadow-sm">
                <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-foreground"><ArrowUpRight className="size-4 text-amber-600 dark:text-amber-400" />전월 대비 급증</h3>
                <ul className="space-y-1.5">
                  {spikes.map((s) => (
                    <li key={s.categoryId} className="flex items-center justify-between gap-2 text-sm">
                      <span className="truncate text-muted-foreground">{s.name}</span>
                      <span className="shrink-0 font-semibold tabular-nums text-amber-600 dark:text-amber-400">+{mask("expense_amount", won(s.delta))} <span className="text-xs font-normal text-muted-foreground">({mask("expense_amount", won(s.prevMonth))}→{mask("expense_amount", won(s.thisMonth))})</span></span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* 최근 3개월 항목별 지출 — 알림 아래, 바로가기 위 (설계 90 §2).
          월별 수입·지출·대출은 맨 위로 올라갔다(설계 189).
          알림 섹션은 경고가 없으면 통째로 사라지는 조건부 렌더라, 그때는 StatCard 그리드 바로 아래에 붙는다. */}
      <Category3MonthChart month={month} txns={txns} installments={installments} categories={categories} />

      <section className="space-y-3">
        <SectionIntro title="바로가기" description="자주 쓰는 화면으로 이동합니다." />
        <div className="flex flex-wrap gap-2">
          <Button asChild><Link href="/dashboard/household/expenses/new">지출 등록</Link></Button>
          <Button variant="outline" asChild><Link href="/dashboard/household/income/new">수입 등록</Link></Button>
          <Button variant="outline" asChild><Link href="/dashboard/household/cash">현금흐름</Link></Button>
          <Button variant="outline" asChild><Link href="/dashboard/household/inbox">수집함</Link></Button>
          <Button variant="outline" asChild><Link href="/dashboard/household/settings">설정</Link></Button>
        </div>
      </section>
    </div>
  );
}
