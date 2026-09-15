"use client";

// 시스템개선 (설계 157) — 설정 하위에 묻혀 있던 '개선사항'을 대메뉴로 올리고,
// 재무 흐름을 진단하는 '재무관리' 탭을 더했다.
// ★재무관리는 손으로 적은 조언이 아니라 **그 달 데이터에서 매번 다시 뽑는다**(finance-health.ts).
import { AlertTriangle, ClipboardCheck, Landmark, TrendingDown, Wallet } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ImprovementBoard } from "@/components/household/improvement-board";
import { HhPageHeader } from "@/components/household/hh-page-header";
import { HH_COL, HH_CELL, HH_TABLE, tableMinWidth, colStyles } from "@/components/household/hh-board";
import { ErrorState, LoadingState, PageShell, StatCard, StatsGrid } from "@/components/page-shell";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger, HH_TAB_SOLID } from "@/components/ui/tabs";
import { createClient } from "@/lib/supabase/client";
import { LOAN_INCOME_CATEGORY_NAME } from "@/lib/household/calc";
import { financeHealth, HIGH_RATE, type FinanceHealth } from "@/lib/household/finance-health";
import { shiftMonth, thisMonthKey } from "@/lib/household/month";
import type { HhAccount, HhCategory, HhLoan, HhPaymentMethod, HhScheduledPayment, HhTransaction } from "@/lib/household/types";

const won = (n: number) => Math.round(n).toLocaleString("ko-KR") + "원";
const man = (n: number) => Math.round(n / 10000).toLocaleString("ko-KR") + "만원";

/** 최근 몇 개월 실적으로 평균을 낼지. 한 달만 보면 상여·명절 같은 특이달에 휘둘린다. */
const LOOKBACK_MONTHS = 3;

type TxnRow = Pick<HhTransaction, "txn_date" | "type" | "amount" | "category_id" | "payment_method_id" | "from_account_id" | "to_account_id">;

/**
 * 거래를 **페이지로 나눠 전부** 가져온다.
 * ★Supabase 는 한 요청에 1,000행만 준다 — 넘으면 오류가 아니라 **조용히 잘린다**.
 *   잘린 채 합계를 내면 화면이 아무 말 없이 틀린 금액을 보여준다(현금흐름 화면도 같은 이유로 페이징한다).
 */
async function fetchAllTxns(
  supabase: ReturnType<typeof createClient>,
  from: string,
  to: string
): Promise<{ data: TxnRow[] | null; error: unknown }> {
  const CHUNK = 1000;
  const MAX = 50000;
  const out: TxnRow[] = [];
  for (let start = 0; start < MAX; start += CHUNK) {
    const { data, error } = await supabase
      .from("hh_transaction")
      .select("txn_date, type, amount, category_id, payment_method_id, from_account_id, to_account_id")
      .gte("txn_date", from)
      .lt("txn_date", to)
      .order("txn_date", { ascending: true })
      .order("id", { ascending: true }) // 페이지 경계 안정용 2차 키
      .range(start, start + CHUNK - 1);
    if (error) return { data: null, error };
    const rows = (data ?? []) as TxnRow[];
    out.push(...rows);
    if (rows.length < CHUNK) break;
  }
  return { data: out, error: null };
}

export default function HouseholdSystemPage() {
  const supabase = useMemo(() => createClient(), []);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [health, setHealth] = useState<FinanceHealth | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(false);
    const month = thisMonthKey();
    const from = `${shiftMonth(month, -LOOKBACK_MONTHS)}-01`;
    const to = `${month}-01`; // 당월은 아직 안 끝나 평균을 왜곡한다 → 직전 달까지만 본다

    const [loanRes, schedRes, accRes, balRes, catRes, methodRes, txnRes] = await Promise.all([
      supabase.from("hh_loan").select("*"),
      supabase.from("hh_scheduled_payment").select("*"),
      supabase.from("hh_account").select("*"),
      supabase.from("hh_account_balance").select("account_id, current_balance"),
      supabase.from("hh_category").select("*"),
      supabase.from("hh_payment_method").select("*"),
      // ★페이징 — Supabase 는 한 번에 1,000행만 준다. 3개월치가 그걸 넘으면 **조용히 잘린 채**
      //   화면이 틀린 금액을 보여준다(2026-08-09 실측 803건 — 여유가 200건도 안 됐다).
      fetchAllTxns(supabase, from, to),
    ]);
    if (loanRes.error || schedRes.error || accRes.error || balRes.error || catRes.error || methodRes.error || txnRes.error) {
      setError(true);
      setLoading(false);
      return;
    }

    const loans = (loanRes.data ?? []) as HhLoan[];
    const scheduled = (schedRes.data ?? []) as HhScheduledPayment[];
    const accounts = (accRes.data ?? []) as HhAccount[];
    const categories = (catRes.data ?? []) as HhCategory[];
    const methods = (methodRes.data ?? []) as HhPaymentMethod[];
    const txns = (txnRes.data ?? []) as TxnRow[];

    const monthlyIncome = scheduled
      .filter((s) => s.is_active && s.direction === "in")
      .reduce((sum, s) => sum + Number(s.amount ?? 0), 0);

    // 현금성 = 증권 제외. 출금 감당 여부를 볼 때 증권 잔액은 당장 꺼내 쓸 돈이 아니다(설계 115).
    const stockIds = new Set(accounts.filter((a) => a.kind === "stock").map((a) => a.id));
    const cash = (balRes.data ?? [])
      .filter((b) => !stockIds.has((b as { account_id: string }).account_id))
      .reduce((sum, b) => sum + Number((b as { current_balance: number }).current_balance ?? 0), 0);

    const catName = (id: string | null) => categories.find((c) => c.id === id)?.name ?? "(미분류)";
    // ★현금유출 판정 — 개별 카드승인(expense)과 월 카드대금(payment)을 둘 다 더하면 이중계상이다(설계 70·108).
    //   payment 는 전액, expense 는 **신용·할부 카드가 아닌 것**(계좌에서 바로 빠진 것)만 센다.
    const cardIds = new Set(methods.filter((m) => m.kind === "credit" || m.kind === "installment").map((m) => m.id));
    // ★외부 송금(도착 계좌가 우리 것이 아닌 이체)은 **실제로 나간 돈**이라 유출로 센다.
    //   내부 이체(등록 계좌 → 등록 계좌)만 뺀다 — 지갑 충전·통장 자리바꿈은 나간 돈이 아니다(설계 128·131).
    const accIds = new Set(accounts.map((a) => a.id));
    const isInternalTransfer = (t: TxnRow) =>
      t.type === "transfer" && Boolean(t.from_account_id && t.to_account_id && accIds.has(t.from_account_id) && accIds.has(t.to_account_id));
    const isCashOut = (t: TxnRow) =>
      t.type === "payment" ||
      (t.type === "expense" && !(t.payment_method_id && cardIds.has(t.payment_method_id))) ||
      (t.type === "transfer" && !isInternalTransfer(t));

    // ★대출 실행금은 '번 돈'이 아니다 — 빌린 돈이다(배포 전 교차리뷰 지적).
    //   섞어 넣으면 카드론으로 적자를 메운 달이 **흑자로 보인다**. 실측: 8/2 카드론 1,500만이
    //   `대출` 카테고리 income 으로 들어와 있다. 그 달이 순증감 창에 들어오면 그대로 뒤집힌다.
    const loanCatIds = new Set(categories.filter((c) => c.kind === "income" && c.name === LOAN_INCOME_CATEGORY_NAME).map((c) => c.id));

    const spendMap = new Map<string, number>();
    const netByMonth = new Map<string, number>();
    for (const t of txns) {
      const ym = String(t.txn_date).slice(0, 7);
      const amt = Number(t.amount ?? 0);
      if (t.type === "expense") spendMap.set(catName(t.category_id), (spendMap.get(catName(t.category_id)) ?? 0) + amt);
      if (t.type === "income") {
        if (t.category_id && loanCatIds.has(t.category_id)) continue; // 빌린 돈은 순증감에서 뺀다
        netByMonth.set(ym, (netByMonth.get(ym) ?? 0) + amt);
      } else if (isCashOut(t)) netByMonth.set(ym, (netByMonth.get(ym) ?? 0) - amt);
    }

    setHealth(
      financeHealth({
        loans,
        monthlyIncome,
        cash,
        spendByCategory: [...spendMap].map(([category, total]) => ({ category, total })),
        spendMonths: LOOKBACK_MONTHS,
        monthlyNets: [...netByMonth.values()],
      })
    );
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchData();
  }, [fetchData]);

  // 잔액은 억 단위(133,099,340원 = 83px)라 standard(안쪽 82)에서 1px 모자라 꺾였다 → wide.
  // 표 합계 88+272+136+136+136 = 768 로 페이지 최대폭 1200 에 여유가 있다. (설계 122·125)
  const LOAN_COLS = [HH_COL.short, HH_COL.x4wide, HH_COL.wide, HH_COL.wide, HH_COL.wide];

  return (
    <PageShell>
      <HhPageHeader
        title="시스템개선"
        description="가계부에서 발견한 개선사항과, 재무 흐름에서 먼저 손대면 좋을 일을 모아 봅니다."
      />

      <Tabs defaultValue="improvement">
        <div className="overflow-x-auto overflow-y-hidden">
          <TabsList>
            <TabsTrigger value="improvement" className={HH_TAB_SOLID}>
              <ClipboardCheck className="h-4 w-4" /> 개선사항
            </TabsTrigger>
            <TabsTrigger value="finance" className={HH_TAB_SOLID}>
              <Landmark className="h-4 w-4" /> 재무관리
            </TabsTrigger>
          </TabsList>
        </div>

        {/* ───── 개선사항 (설계 156에서 이관) ───── */}
        <TabsContent value="improvement" className="pt-4">
          <ImprovementBoard />
        </TabsContent>

        {/* ───── 재무관리 (설계 157) ───── */}
        <TabsContent value="finance" className="space-y-4 pt-4">
          {loading ? (
            <LoadingState />
          ) : error || !health ? (
            <ErrorState onRetry={() => void fetchData()} />
          ) : (
            <>
              <StatsGrid columns={4}>
                <StatCard label="월 정기수입" value={won(health.monthlyIncome)} mobileValue={man(health.monthlyIncome)} icon={Wallet} sensitive="income_amount" />
                <StatCard label="현금성 자산" value={won(health.cash)} mobileValue={man(health.cash)} icon={Wallet} sensitive="income_amount" />
                <StatCard label="대출 잔액" value={won(health.loanBalance)} mobileValue={man(health.loanBalance)} icon={Landmark} tone="warning" sensitive="expense_amount" />
                <StatCard
                  label="연 이자 (현재 잔액 기준)"
                  value={`${won(health.yearlyInterest)} (월 ${won(health.monthlyInterest)})`}
                  mobileValue={man(health.yearlyInterest)}
                  icon={TrendingDown}
                  tone="danger"
                  sensitive="expense_amount"
                />
              </StatsGrid>

              <div className="space-y-1 rounded-2xl border border-border/70 bg-card/85 px-4 py-3 text-sm shadow-sm">
                {health.interestRatio != null && (
                  <p>
                    월 정기수입의 <strong className={health.interestRatio >= 0.2 ? "text-red-600 dark:text-red-400" : ""}>{(health.interestRatio * 100).toFixed(1)}%</strong>
                    {" "}가 이자로 나갑니다. 원금이 줄지 않으면 이 금액은 매달 그대로 나갑니다.
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  이자는 <strong>지금 잔액이 1년간 그대로일 때</strong>로 계산합니다 — 원금을 갚아 나가면 실제로는 이보다 적습니다.
                  {health.rateMissingCount > 0 && (
                    <>
                      {" "}★금리를 안 적은 대출이 <strong className="text-amber-600">{health.rateMissingCount}건</strong> 있어 위 이자는 <strong>그만큼 적게 잡힌 값</strong>입니다.
                    </>
                  )}
                </p>
              </div>

              {/* 먼저 하면 좋을 일 — 아낄 수 있는 연 금액이 큰 순서 */}
              <section className="space-y-2">
                <h2 className="text-sm font-semibold text-muted-foreground">먼저 하면 좋을 일 (아끼는 금액이 큰 순서)</h2>
                {/* ★같은 대출이 여러 항목에 겹쳐 나온다(고금리·카드론·대환). 서로 더할 수 없는 대안이다. */}
                <p className="text-xs text-muted-foreground">
                  같은 대출이 여러 줄에 겹쳐 나옵니다 — 서로 <strong>더할 수 없는 대안</strong>이니 금액을 합산하지 마세요.
                  ‘확인 필요’는 데이터만으로 단정할 수 없는 항목입니다.
                </p>
                {health.actions.length === 0 ? (
                  <p className="rounded-2xl border border-border/70 bg-card/85 px-4 py-3 text-sm text-muted-foreground">
                    지금 데이터로는 특별히 앞세울 항목이 없습니다.
                  </p>
                ) : (
                  <ol className="space-y-2">
                    {health.actions.map((a, i) => (
                      <li key={a.kind} className="rounded-2xl border border-border/70 bg-card/85 px-4 py-3 shadow-sm">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="secondary">{i + 1}</Badge>
                          <span className="font-medium">{a.title}</span>
                          {a.yearlySaving > 0 && (
                            <Badge className="ml-auto">연 {won(a.yearlySaving)} 절약</Badge>
                          )}
                          {a.needsCheck && (
                            <Badge variant="outline" className="gap-1">
                              <AlertTriangle className="h-3 w-3" /> 확인 필요
                            </Badge>
                          )}
                        </div>
                        <p className={`mt-1 text-sm text-muted-foreground ${HH_CELL.wrapText}`}>{a.detail}</p>
                      </li>
                    ))}
                  </ol>
                )}
              </section>

              {/* 근거 — 금리 높은 순 대출 */}
              <section className="space-y-2">
                <h2 className="text-sm font-semibold text-muted-foreground">
                  대출 {health.loans.length}건 — 금리 높은 순 (연 {HIGH_RATE}% 이상은 빨강)
                </h2>
                <div className={HH_TABLE.shell}>
                  <div className="max-w-full overflow-x-auto">
                    <table className={HH_TABLE.table} style={{ minWidth: tableMinWidth(LOAN_COLS) }}>
                      <colgroup>{colStyles(LOAN_COLS).map((st, i) => <col key={i} style={st} />)}</colgroup>
                      <thead>
                        <tr className={HH_TABLE.headRow}>
                          <th className={HH_TABLE.th}>금리</th>
                          <th className={HH_TABLE.th}>대출</th>
                          <th className={`${HH_TABLE.th} text-right`}>잔액</th>
                          <th className={`${HH_TABLE.th} text-right`}>연 이자</th>
                          <th className={`${HH_TABLE.th} text-right`}>월 이자</th>
                        </tr>
                      </thead>
                      <tbody>
                        {health.loans.map((l) => {
                          const high = (l.rate ?? 0) >= HIGH_RATE;
                          return (
                            <tr key={l.id} className={HH_TABLE.row}>
                              <td className={`${HH_TABLE.td} ${high ? "font-semibold text-red-600 dark:text-red-400" : ""}`}>
                                {l.rateMissing ? <span className="text-xs text-amber-600">미입력</span> : `${l.rate}%`}
                              </td>
                              <td className={`${HH_TABLE.td} ${HH_CELL.wrapText}`}>{l.name}</td>
                              <td className={`${HH_TABLE.td} text-right tabular-nums`}>{won(l.balance)}</td>
                              <td className={`${HH_TABLE.td} text-right tabular-nums ${high ? "text-red-600 dark:text-red-400" : ""}`}>{won(l.yearlyInterest)}</td>
                              <td className={`${HH_TABLE.td} text-right tabular-nums text-muted-foreground`}>{won(l.yearlyInterest / 12)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  금리가 비어 있는 대출은 연 이자를 0으로 계산합니다 — 채워 넣으면 위 순위가 정확해집니다.
                  최근 {LOOKBACK_MONTHS}개월(직전 달까지) 실적으로 계산했습니다.
                </p>
              </section>
            </>
          )}
        </TabsContent>
      </Tabs>
    </PageShell>
  );
}
